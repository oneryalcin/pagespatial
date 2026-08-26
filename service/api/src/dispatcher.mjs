import { createAttempt } from './attempts.mjs';
import { failAttempt, markDispatched, markDispatchUnknown } from './accept.mjs';

function inputKey(inputUri, inputBucket) {
  const prefix = `r2://${inputBucket}/`;
  if (typeof inputUri !== 'string' || !inputUri.startsWith(prefix)) {
    throw new TypeError('job input_uri does not belong to the configured input bucket');
  }
  const key = inputUri.slice(prefix.length);
  if (!key || key.startsWith('/') || key.includes('..')) throw new TypeError('job input_uri is unsafe');
  return key;
}

export function modalPayload({ jobId, attemptId, inputUri, inputDigest, inputBucket }) {
  return {
    job_id: jobId,
    attempt_id: attemptId,
    expected_sha256: inputDigest,
    input_key: inputKey(inputUri, inputBucket),
    result_prefix: `results/${jobId}/${attemptId}`,
  };
}

/** Spawn an already-created attempt and persist the call id when available. */
export async function dispatchExistingAttempt({ db, modalCalls, inputBucket, attemptId }) {
  const { rows } = await db.query(
    `SELECT a.id AS attempt_id, a.job_id, a.state,
            j.input_uri, j.input_digest
       FROM job_attempts a JOIN jobs j ON j.id = a.job_id
      WHERE a.id = $1`,
    [attemptId],
  );
  const row = rows[0];
  if (!row || row.state !== 'dispatching') return { kind: 'not_dispatchable' };
  let payload;
  try {
    payload = modalPayload({
      jobId: row.job_id, attemptId: row.attempt_id,
      inputUri: row.input_uri, inputDigest: row.input_digest, inputBucket,
    });
  } catch (error) {
    const detail = `${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`;
    await failAttempt(db, { jobId: row.job_id, attemptId: row.attempt_id, error: detail });
    return { kind: 'invalid_dispatch_input', attemptId: row.attempt_id, error: detail };
  }
  let callId;
  try {
    ({ callId } = await modalCalls.spawn(payload));
  } catch (error) {
    // Once spawn is invoked, an error does not prove Modal rejected the call.
    // Preserve uncertainty; the reconciler checks R2 before replacing it.
    try {
      await markDispatchUnknown(db, { jobId: row.job_id, attemptId: row.attempt_id });
    } catch {
      // Preserve the spawn error. A row left in dispatching is also recovered
      // by the same bounded uncertainty path.
    }
    return {
      kind: 'dispatch_unknown', attemptId: row.attempt_id,
      error: `${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`,
    };
  }

  try {
    const recorded = await markDispatched(db, {
      jobId: row.job_id, attemptId: row.attempt_id, modalCallId: callId,
    });
    return recorded
      ? { kind: 'dispatched', attemptId: row.attempt_id, callId }
      : { kind: 'call_id_not_recorded', attemptId: row.attempt_id, callId };
  } catch (error) {
    // Spawn definitely succeeded. Do not misreport a database persistence
    // failure as a Modal failure or hide it behind a second database call.
    const persistenceError = new Error(
      `Modal call ${callId} spawned but its call id was not persisted`,
      { cause: error },
    );
    persistenceError.modalCallId = callId;
    throw persistenceError;
  }
}

/** Create and dispatch one attempt. Never reuse an attempt id. */
export async function dispatchJob({
  db, modalCalls, inputBucket, jobId, replacesAttemptId = null,
}) {
  const attempt = await createAttempt(db, { jobId, replacesAttemptId });
  if (!attempt) return { kind: 'attempt_not_created' };
  return dispatchExistingAttempt({ db, modalCalls, inputBucket, attemptId: attempt.id });
}
