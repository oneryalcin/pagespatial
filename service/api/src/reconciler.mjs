import { acceptAttempt, failAttempt, markDispatchUnknown } from './accept.mjs';
import pg from 'pg';
import { getAttempt, getOrCreateReplacement, listOpenAttempts } from './attempts.mjs';
import { dispatchExistingAttempt } from './dispatcher.mjs';
import { validateModalPointer, validateStoredResult } from './result-contract.mjs';

const DEFAULT_UNKNOWN_WAIT_MS = 10 * 60 * 1000;
const RECONCILER_LOCK_ID = 731945822;

function identity(row, { inputBucket, resultsBucket }) {
  const prefix = `r2://${inputBucket}/`;
  if (!row.input_uri.startsWith(prefix)) throw new TypeError('attempt input_uri is outside the input bucket');
  return {
    jobId: row.job_id,
    attemptId: row.attempt_id,
    inputKey: row.input_uri.slice(prefix.length),
    inputDigest: row.input_digest,
    resultsBucket,
  };
}

async function acceptStored(db, row, result) {
  return acceptAttempt(db, {
    jobId: row.job_id,
    attemptId: row.attempt_id,
    status: result.status,
    resultUri: result.resultUri,
    resultDigest: result.resultDigest,
    resultCreatedAt: result.resultCreatedAt,
    pages: result.pages,
  });
}

async function readAndValidate(resultStore, candidate, expected, pointer = null) {
  const stored = await resultStore.readResult({ key: candidate.key });
  const result = validateStoredResult({ ...stored, pointer, expected });
  if (result.resultKey !== candidate.key) {
    throw new TypeError('listed R2 key does not match the stored envelope execution id');
  }
  return result;
}

async function recoverFromR2(resultStore, expected) {
  const candidates = await resultStore.listAttemptResults({
    jobId: expected.jobId, attemptId: expected.attemptId,
  });
  const rejected = [];
  for (const candidate of candidates) {
    try {
      return { result: await readAndValidate(resultStore, candidate, expected), rejected };
    } catch (error) {
      rejected.push(`${candidate.key}: ${error.message}`);
    }
  }
  return { result: null, rejected };
}

/**
 * Reconcile exactly one attempt. All outside systems are narrow dependencies;
 * PostgreSQL remains the only authority for state transitions.
 */
export async function reconcileAttempt({
  db, modalCalls, resultStore, inputBucket, attemptId,
  now = new Date(), unknownWaitMs = DEFAULT_UNKNOWN_WAIT_MS,
}) {
  const row = await getAttempt(db, attemptId);
  if (!row) return { kind: 'missing' };
  if (!['dispatching', 'dispatch_unknown', 'dispatched'].includes(row.attempt_state)) {
    return { kind: 'terminal', state: row.attempt_state };
  }
  const expected = identity(row, { inputBucket, resultsBucket: resultStore.bucket });

  if (row.attempt_state === 'dispatched') {
    const outcome = await modalCalls.inspect(row.modal_call_id);
    if (outcome.kind === 'pending') return outcome;
    if (outcome.kind === 'completed') {
      try {
        const pointer = validateModalPointer(outcome.output, expected);
        const result = await readAndValidate(
          resultStore,
          { key: pointer.result_key, lastModified: null },
          expected,
          pointer,
        );
        const accepted = await acceptStored(db, row, result);
        return { kind: 'completed', ...accepted };
      } catch (error) {
        // A returned object is not success. A retry execution may still have
        // published a valid sibling, so check the prefix before failing.
        const recovered = await recoverFromR2(resultStore, expected);
        if (recovered.result) {
          const accepted = await acceptStored(db, row, recovered.result);
          return { kind: 'recovered', ...accepted };
        }
        const detail = `invalid completed Modal result: ${error.message}`;
        const failed = await failAttempt(db, {
          jobId: row.job_id, attemptId: row.attempt_id, error: detail,
        });
        return { kind: 'failed', ...failed, error: detail, rejected: recovered.rejected };
      }
    }

    // Modal cannot distinguish every expired output from function failure in
    // the pinned JS SDK. Storage is checked before ANY permanent transition.
    const recovered = await recoverFromR2(resultStore, expected);
    if (recovered.result) {
      const accepted = await acceptStored(db, row, recovered.result);
      return { kind: 'recovered', ...accepted };
    }
    if (outcome.kind === 'unavailable') {
      return { kind: 'unavailable', error: outcome.error, rejected: recovered.rejected };
    }
    const failed = await failAttempt(db, {
      jobId: row.job_id, attemptId: row.attempt_id, error: outcome.error,
    });
    return { kind: 'failed', ...failed, rejected: recovered.rejected };
  }

  // A dispatching/unknown call may already have produced bytes even though
  // its call id never landed. Check those bytes before creating replacement
  // work, then keep the old attempt open so a later result can be recorded.
  const recovered = await recoverFromR2(resultStore, expected);
  if (recovered.result) {
    const accepted = await acceptStored(db, row, recovered.result);
    return { kind: 'recovered', ...accepted };
  }
  const ageMs = now.getTime() - new Date(row.attempt_created_at).getTime();
  if (ageMs < unknownWaitMs) return { kind: 'waiting_unknown', rejected: recovered.rejected };
  if (row.attempt_state === 'dispatching') {
    await markDispatchUnknown(db, { jobId: row.job_id, attemptId: row.attempt_id });
  }
  const replacement = await getOrCreateReplacement(db, {
    jobId: row.job_id, attemptId: row.attempt_id,
  });
  if (!replacement) return { kind: 'replacement_not_created' };
  if (!replacement.created) {
    return { kind: 'replacement_exists', attemptId: replacement.attempt.id };
  }
  const dispatched = await dispatchExistingAttempt({
    db, modalCalls, inputBucket, attemptId: replacement.attempt.id,
  });
  return { kind: 'replacement_dispatched', attemptId: replacement.attempt.id, dispatched };
}

/** One bounded pass; the process scheduler decides when to call it again. */
export async function reconcileOnce(options) {
  if (options.db instanceof pg.Pool) {
    throw new TypeError('reconcileOnce requires one checked-out pg.Client, not pg.Pool');
  }
  const { rows } = await options.db.query(
    'SELECT pg_try_advisory_lock($1) AS acquired', [RECONCILER_LOCK_ID],
  );
  if (!rows[0].acquired) return { acquired: false, outcomes: [] };
  try {
    const ids = await listOpenAttempts(options.db, { limit: options.limit ?? 32 });
    const outcomes = [];
    for (const attemptId of ids) {
      outcomes.push({ attemptId, outcome: await reconcileAttempt({ ...options, attemptId }) });
    }
    return { acquired: true, outcomes };
  } finally {
    const released = await options.db.query(
      'SELECT pg_advisory_unlock($1) AS released', [RECONCILER_LOCK_ID],
    );
    if (!released.rows[0].released) {
      throw new Error('reconciler advisory lock was not held by this database session');
    }
  }
}

export const DISPATCH_UNKNOWN_WAIT_MS = DEFAULT_UNKNOWN_WAIT_MS;
