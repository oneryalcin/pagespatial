import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { assertFailureCode } from './failure-codes.mjs';

const MAX_RESULT_BYTES = 128 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const EXECUTION_ID = /^[0-9a-f]{32}$/;
const RESULT_SCHEMA = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../schemas/pagespatial.schema.json', import.meta.url)),
  'utf8',
));
const validatePageSpatial = new Ajv2020({ allErrors: true })
  .compile(RESULT_SCHEMA.properties.pages.items);

export class InvalidResultError extends TypeError {}

const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidResultError(`${label} must be an object`);
  }
  return value;
};

const exactKeys = (value, expected, label) => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) {
    throw new InvalidResultError(`${label} fields must equal ${wanted.join(', ')}`);
  }
};

/**
 * @typedef {{
 *   jobId: string,
 *   attemptId: string,
 *   inputKey: string,
 *   inputDigest: string,
 *   resultsBucket: string
 * }} ResultIdentity
 */

/**
 * Validate the small value returned through Modal. This is a pointer, not
 * proof of success; the referenced R2 bytes are independently validated by
 * validateStoredResult before any database transition.
 */
export function validateModalPointer(value, expected) {
  const pointer = object(value, 'Modal pointer');
  exactKeys(pointer, [
    'job_id', 'attempt_id', 'execution_id', 'document_sha256',
    'result_uri', 'result_key', 'result_digest', 'result_bytes',
    'page_count', 'status', 'timing',
  ], 'Modal pointer');
  if (pointer.status !== 'completed') throw new InvalidResultError('Modal pointer status must be completed');
  if (pointer.job_id !== expected.jobId || pointer.attempt_id !== expected.attemptId) {
    throw new InvalidResultError('Modal pointer identity does not match the attempt');
  }
  if (pointer.document_sha256 !== expected.inputDigest) {
    throw new InvalidResultError('Modal pointer input digest does not match the job');
  }
  if (!EXECUTION_ID.test(pointer.execution_id)) {
    throw new InvalidResultError('Modal pointer execution_id must be 32 lowercase hex characters');
  }
  const key = `results/${expected.jobId}/${expected.attemptId}/${pointer.execution_id}.json`;
  if (pointer.result_key !== key) throw new InvalidResultError('Modal pointer result_key is outside its attempt prefix');
  if (pointer.result_uri !== `r2://${expected.resultsBucket}/${key}`) {
    throw new InvalidResultError('Modal pointer result_uri does not match the results bucket and key');
  }
  if (!SHA256.test(pointer.result_digest)) throw new InvalidResultError('Modal pointer result_digest is invalid');
  if (!Number.isSafeInteger(pointer.result_bytes) || pointer.result_bytes < 1
      || pointer.result_bytes > MAX_RESULT_BYTES) {
    throw new InvalidResultError('Modal pointer result_bytes is outside the publication bound');
  }
  if (!Number.isSafeInteger(pointer.page_count) || pointer.page_count < 1) {
    throw new InvalidResultError('Modal pointer page_count must be positive');
  }
  object(pointer.timing, 'Modal pointer timing');
  return pointer;
}

/** Validate a returned terminal failure. No result object should exist. */
export function validateModalFailure(value, expected) {
  const failure = object(value, 'Modal failure');
  exactKeys(failure, [
    'job_id', 'attempt_id', 'document_sha256', 'status',
    'failure_code', 'failure_detail', 'timing',
  ], 'Modal failure');
  if (failure.status !== 'failed') throw new InvalidResultError('Modal failure status must be failed');
  if (failure.job_id !== expected.jobId || failure.attempt_id !== expected.attemptId
      || failure.document_sha256 !== expected.inputDigest) {
    throw new InvalidResultError('Modal failure identity does not match the attempt');
  }
  try {
    assertFailureCode(failure.failure_code);
  } catch (error) {
    throw new InvalidResultError(error.message);
  }
  if (typeof failure.failure_detail !== 'string' || failure.failure_detail.length > 500) {
    throw new InvalidResultError('Modal failure detail must be a bounded string');
  }
  object(failure.timing, 'Modal failure timing');
  return failure;
}

function validatePublicPages(envelope, expected) {
  if (!Number.isSafeInteger(envelope.page_count)
      || envelope.page_count < 1 || envelope.page_count > 200
      || !Array.isArray(envelope.pages)
      || envelope.pages.length !== envelope.page_count) {
    throw new InvalidResultError('stored result page_count does not match its pages');
  }
  for (let i = 0; i < envelope.pages.length; i += 1) {
    const page = object(envelope.pages[i], `stored result pages[${i}]`);
    if (page.page_number !== i + 1) {
      throw new InvalidResultError('stored result pages are not contiguous');
    }
    if (page.ok === true) {
      exactKeys(page, ['page_number', 'ok', 'page_spatial'], `stored result page ${i + 1}`);
      if (page.page_spatial?.documentSha256 !== expected.inputDigest
          || page.page_spatial?.pageNumber !== page.page_number) {
        throw new InvalidResultError(`stored result page ${i + 1} identity does not match the job`);
      }
      if (!validatePageSpatial(page.page_spatial)) {
        const detail = validatePageSpatial.errors?.[0];
        throw new InvalidResultError(
          `stored result page ${i + 1} is not schema-valid: `
          + `${detail?.instancePath ?? ''} ${detail?.message ?? 'unknown error'}`,
        );
      }
    } else if (page.ok === false) {
      exactKeys(page, ['page_number', 'ok', 'failure'], `stored result page ${i + 1}`);
      const failure = object(page.failure, `stored result page ${i + 1} failure`);
      exactKeys(failure, ['code', 'message'], `stored result page ${i + 1} failure`);
      if (failure.code !== 'page_failed' || failure.message !== 'Page could not be parsed.') {
        throw new InvalidResultError(`stored result page ${i + 1} failure is not public-safe`);
      }
    } else {
      throw new InvalidResultError(`stored result page ${i + 1} has no boolean outcome`);
    }
  }
}

/**
 * Validate bytes fetched from R2 and return only the values allowed to cross
 * into acceptance SQL. `lastModified` is R2's lifecycle clock.
 */
export function validateStoredResult({ bytes, lastModified, pointer = null, expected }) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1
      || bytes.byteLength > MAX_RESULT_BYTES) {
    throw new InvalidResultError('stored result bytes are outside the publication bound');
  }
  const modified = lastModified instanceof Date ? lastModified : new Date(lastModified);
  if (Number.isNaN(modified.getTime())) throw new InvalidResultError('stored result has no valid LastModified');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (pointer && (digest !== pointer.result_digest || bytes.byteLength !== pointer.result_bytes)) {
    throw new InvalidResultError('stored result does not match its Modal pointer');
  }
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new InvalidResultError('stored result is not valid JSON');
  }
  object(envelope, 'stored result envelope');
  exactKeys(envelope, [
    'schema_version', 'job_id', 'attempt_id', 'execution_id',
    'input_sha256', 'page_count', 'pages',
  ], 'stored result envelope');
  if (envelope.schema_version !== 1
      || envelope.job_id !== expected.jobId
      || envelope.attempt_id !== expected.attemptId
      || envelope.input_sha256 !== expected.inputDigest) {
    throw new InvalidResultError('stored result envelope identity does not match the job');
  }
  if (!EXECUTION_ID.test(envelope.execution_id)) {
    throw new InvalidResultError('stored result execution_id is invalid');
  }
  if (pointer && envelope.execution_id !== pointer.execution_id) {
    throw new InvalidResultError('stored result execution_id does not match its Modal pointer');
  }
  validatePublicPages(envelope, expected);
  if (pointer && envelope.page_count !== pointer.page_count) {
    throw new InvalidResultError('stored result page_count does not match its Modal pointer');
  }
  const key = `results/${expected.jobId}/${expected.attemptId}/${envelope.execution_id}.json`;
  return {
    resultKey: key,
    resultUri: `r2://${expected.resultsBucket}/${key}`,
    resultDigest: digest,
    resultCreatedAt: modified,
    pages: envelope.page_count,
    status: 'completed',
  };
}

export const RESULT_LIMIT_BYTES = MAX_RESULT_BYTES;
