import { dispatchJob } from './dispatcher.mjs';

export async function listQueuedJobs(db, { limit = 8 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) {
    throw new TypeError('queued dispatch limit must be an integer from 1 to 8');
  }
  const { rows } = await db.query(
    `SELECT j.id
       FROM jobs j
      WHERE j.state = 'queued' AND j.accepted_attempt_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM job_attempts a WHERE a.job_id = j.id)
      ORDER BY j.queued_at, j.id
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => row.id);
}

export async function dispatchQueuedOnce({ db, modalCalls, inputBucket, limit = 8 }) {
  const jobIds = await listQueuedJobs(db, { limit });
  const outcomes = [];
  for (const jobId of jobIds) {
    try {
      outcomes.push({ jobId, outcome: await dispatchJob({
        db, modalCalls, inputBucket, jobId,
      }) });
    } catch (error) {
      outcomes.push({
        jobId,
        outcome: {
          kind: 'retryable_error',
          error: `${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`,
        },
      });
    }
  }
  return outcomes;
}
