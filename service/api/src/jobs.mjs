import { ApiError } from './api-errors.mjs';
import { PROCESSING_DEADLINE_MS } from './job-constants.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/u;
const ACTIVE = "('uploading','queued','dispatched')";
const ADMISSION_LOCK_ID = 731945823;
const MAX_ACTIVE_GLOBAL = 100;
const MAX_ACTIVE_USER = 5;
const MAX_INPUT_BYTES = 90 * 1024 * 1024;

const terminalStatuses = Object.freeze({
  upload_expired: 410,
  input_too_large: 413,
  invalid_upload: 422,
});

const terminalMessages = Object.freeze({
  upload_expired: 'Upload was not finalized before its deadline.',
  invalid_upload: 'Uploaded object is not a valid PDF upload.',
  input_digest_mismatch: 'Uploaded PDF did not match the declared SHA-256.',
  input_too_large: 'PDF exceeds the 90 MiB limit.',
  invalid_pdf: 'Input is not a supported PDF.',
  page_limit_exceeded: 'PDF exceeds the 200-page limit.',
  processing_deadline_exceeded: 'Document did not finish before its processing deadline.',
  dispatch_failed: 'Document could not be started.',
  processing_failed: 'Document processing failed.',
});

const date = (value) => value == null ? null : new Date(value).toISOString();

export function jobView(row) {
  const code = row.state === 'failed' && terminalMessages[row.failure_code]
    ? row.failure_code : row.state === 'failed' ? 'processing_failed' : null;
  return {
    id: row.id,
    state: row.state,
    processing_profile: 'parse-v1',
    input_sha256: row.input_digest,
    input_bytes: row.input_bytes == null ? null : Number(row.input_bytes),
    pages: row.pages_actual == null ? null : Number(row.pages_actual),
    estimated_cost_micros: row.estimated_cost_micros == null
      ? null : Number(row.estimated_cost_micros),
    created_at: date(row.created_at),
    queued_at: date(row.queued_at),
    completed_at: date(row.completed_at),
    processing_deadline_at: row.queued_at
      ? new Date(new Date(row.queued_at).getTime() + PROCESSING_DEADLINE_MS).toISOString()
      : null,
    retention_expires_at: date(row.retention_expires_at),
    error: code ? { code, message: terminalMessages[code] } : null,
  };
}

async function rollbackOrDestroy(client, original) {
  try {
    await client.query('ROLLBACK');
    client.release();
  } catch {
    client.release(true);
  }
  throw original;
}

export async function createOrReplayJob({
  pool, userId, idempotencyKey, inputSha256, inputBucket,
  unitPriceMicros = 1000,
}) {
  if (!IDEMPOTENCY_KEY.test(idempotencyKey ?? '')) {
    throw new ApiError(400, 'invalid_request', 'Idempotency-Key must contain 1 to 128 visible ASCII characters.');
  }
  if (!SHA256.test(inputSha256 ?? '')) {
    throw new ApiError(400, 'invalid_request', 'input_sha256 must contain 64 lowercase hexadecimal characters.');
  }
  if (typeof inputBucket !== 'string' || !inputBucket) throw new TypeError('inputBucket is required');
  if (!Number.isSafeInteger(unitPriceMicros) || unitPriceMicros < 0) {
    throw new TypeError('unitPriceMicros must be a non-negative integer');
  }

  const client = await pool.connect();
  let released = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query('SELECT pg_advisory_xact_lock($1)', [ADMISSION_LOCK_ID]);
    const existing = (await client.query(
      'SELECT * FROM jobs WHERE user_id = $1 AND idempotency_key = $2',
      [userId, idempotencyKey],
    )).rows[0];
    if (existing) {
      if (existing.input_digest !== inputSha256) {
        throw new ApiError(422, 'idempotency_mismatch', 'Idempotency-Key was already used with another input.');
      }
      await client.query('COMMIT');
      client.release();
      released = true;
      return { created: false, row: existing };
    }
    const counts = (await client.query(
      `SELECT (SELECT count(*)::integer FROM jobs WHERE state IN ${ACTIVE}) AS global,
              (SELECT count(*)::integer FROM jobs
                WHERE user_id = $1 AND state IN ${ACTIVE}) AS owned`,
      [userId],
    )).rows[0];
    if (counts.global >= MAX_ACTIVE_GLOBAL || counts.owned >= MAX_ACTIVE_USER) {
      throw new ApiError(429, 'admission_limit', 'Too many active jobs.', {
        headers: { 'retry-after': '60' },
      });
    }
    const row = (await client.query(
      `WITH identity AS (SELECT gen_random_uuid() AS id)
       INSERT INTO jobs (
         id, user_id, idempotency_key, state, input_uri, input_digest,
         unit_price_micros, upload_expires_at
       )
       SELECT id, $1, $2, 'uploading',
              'r2://' || $3 || '/inputs/' || id::text || '.pdf',
              $4, $5, now() + interval '1 hour'
         FROM identity
       RETURNING *`,
      [userId, idempotencyKey, inputBucket, inputSha256, unitPriceMicros],
    )).rows[0];
    if (!row) throw new TypeError('job owner does not exist');
    await client.query('COMMIT');
    client.release();
    released = true;
    return { created: true, row };
  } catch (error) {
    if (!released) await rollbackOrDestroy(client, error);
    throw error;
  }
}

export async function ownedJob(db, { userId, jobId }) {
  const { rows } = await db.query(
    'SELECT * FROM jobs WHERE id = $1 AND user_id = $2', [jobId, userId],
  );
  if (!rows[0]) throw new ApiError(404, 'not_found', 'Job was not found.');
  return rows[0];
}

async function failUpload(db, { userId, jobId, code, detail }) {
  const { rows } = await db.query(
    `UPDATE jobs SET state = 'failed', failure_code = $3, error = $4,
                     completed_at = now()
      WHERE id = $1 AND user_id = $2 AND state = 'uploading'
      RETURNING *`,
    [jobId, userId, code, detail],
  );
  return rows[0] ?? ownedJob(db, { userId, jobId });
}

function finalized(row) {
  return { status: ['succeeded', 'failed'].includes(row.state) ? 200 : 202, row };
}

function throwTerminalUpload(row) {
  if (row.state !== 'failed') return;
  const code = terminalMessages[row.failure_code] ? row.failure_code : 'invalid_upload';
  throw new ApiError(terminalStatuses[code] ?? 422, code, terminalMessages[code]);
}

async function failUploadOrReturnCurrent(db, values) {
  const row = await failUpload(db, values);
  throwTerminalUpload(row);
  return finalized(row);
}

export async function finalizeJob({ db, inputStore, userId, jobId, now = new Date() }) {
  let row = await ownedJob(db, { userId, jobId });
  if (['succeeded', 'failed'].includes(row.state)) return { status: 200, row };
  if (['queued', 'dispatched'].includes(row.state)) return { status: 202, row };
  if (new Date(row.upload_expires_at) <= now) {
    return failUploadOrReturnCurrent(db, {
      userId, jobId, code: 'upload_expired', detail: 'upload window expired',
    });
  }
  const object = await inputStore.head({ jobId });
  if (!object) throw new ApiError(409, 'upload_incomplete', 'Uploaded PDF is not available yet.');
  if (!Number.isSafeInteger(object.bytes) || object.bytes < 1) {
    return failUploadOrReturnCurrent(db, {
      userId, jobId, code: 'invalid_upload', detail: 'input object is empty',
    });
  }
  if (object.bytes > MAX_INPUT_BYTES) {
    return failUploadOrReturnCurrent(db, {
      userId, jobId, code: 'input_too_large', detail: 'input object exceeds 90 MiB',
    });
  }
  if (object.contentType !== 'application/pdf') {
    return failUploadOrReturnCurrent(db, {
      userId, jobId, code: 'invalid_upload', detail: 'input content type is not application/pdf',
    });
  }
  const { rows } = await db.query(
    `WITH database_clock AS (SELECT clock_timestamp() AS value)
     UPDATE jobs SET state = 'queued', input_bytes = $3,
                     queued_at = database_clock.value
       FROM database_clock
      WHERE id = $1 AND user_id = $2 AND state = 'uploading'
        AND upload_expires_at > database_clock.value
      RETURNING *`,
    [jobId, userId, object.bytes],
  );
  row = rows[0] ?? await ownedJob(db, { userId, jobId });
  if (row.state === 'uploading') {
    return failUploadOrReturnCurrent(db, {
      userId, jobId, code: 'upload_expired', detail: 'upload window expired',
    });
  }
  return finalized(row);
}

export async function resultGrant({ db, resultStore, userId, jobId, now = new Date() }) {
  const row = await ownedJob(db, { userId, jobId });
  if (row.state === 'failed') throw new ApiError(409, 'job_failed', 'Job failed.');
  if (row.state !== 'succeeded') throw new ApiError(409, 'result_not_ready', 'Result is not ready.');
  if (!row.accepted_attempt_id || !row.result_uri || !row.result_digest) {
    throw new ApiError(503, 'service_unavailable', 'Result is temporarily unavailable.');
  }
  if (!row.retention_expires_at || new Date(row.retention_expires_at) <= now) {
    throw new ApiError(410, 'result_expired', 'Result has expired.');
  }
  const prefix = `r2://${resultStore.bucket}/`;
  if (typeof row.result_uri !== 'string' || !row.result_uri.startsWith(prefix)) {
    throw new ApiError(503, 'service_unavailable', 'Result is temporarily unavailable.');
  }
  return resultStore.createDownloadGrant({
    key: row.result_uri.slice(prefix.length), expiresAt: row.retention_expires_at, now,
  });
}

export const ADMISSION_LIMITS = Object.freeze({
  perUser: MAX_ACTIVE_USER, global: MAX_ACTIVE_GLOBAL,
});
