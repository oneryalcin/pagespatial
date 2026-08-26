import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const MAX_RESULT_BYTES = 128 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const EXECUTION_ID = /^[0-9a-f]{32}$/;
const RESULT_SCHEMA = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../schemas/pagespatial.schema.json', import.meta.url)),
  'utf8',
));
const validatePageSpatial = new Ajv2020({ allErrors: true })
  .compile(RESULT_SCHEMA.properties.pages.items);

const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
};

const exactKeys = (value, expected, label) => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) {
    throw new TypeError(`${label} fields must equal ${wanted.join(', ')}`);
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
  if (pointer.status !== 'completed') throw new TypeError('Modal pointer status must be completed');
  if (pointer.job_id !== expected.jobId || pointer.attempt_id !== expected.attemptId) {
    throw new TypeError('Modal pointer identity does not match the attempt');
  }
  if (pointer.document_sha256 !== expected.inputDigest) {
    throw new TypeError('Modal pointer input digest does not match the job');
  }
  if (!EXECUTION_ID.test(pointer.execution_id)) {
    throw new TypeError('Modal pointer execution_id must be 32 lowercase hex characters');
  }
  const key = `results/${expected.jobId}/${expected.attemptId}/${pointer.execution_id}.json`;
  if (pointer.result_key !== key) throw new TypeError('Modal pointer result_key is outside its attempt prefix');
  if (pointer.result_uri !== `r2://${expected.resultsBucket}/${key}`) {
    throw new TypeError('Modal pointer result_uri does not match the results bucket and key');
  }
  if (!SHA256.test(pointer.result_digest)) throw new TypeError('Modal pointer result_digest is invalid');
  if (!Number.isSafeInteger(pointer.result_bytes) || pointer.result_bytes < 1
      || pointer.result_bytes > MAX_RESULT_BYTES) {
    throw new TypeError('Modal pointer result_bytes is outside the publication bound');
  }
  if (!Number.isSafeInteger(pointer.page_count) || pointer.page_count < 1) {
    throw new TypeError('Modal pointer page_count must be positive');
  }
  object(pointer.timing, 'Modal pointer timing');
  return pointer;
}

function validateParseResult(value, expected) {
  const result = object(value, 'parse_result');
  if (result.status !== 'completed' || result.failure != null) {
    throw new TypeError('parse_result must be terminal-successful');
  }
  if (result.request_id !== expected.attemptId
      || result.document_sha256 !== expected.inputDigest) {
    throw new TypeError('parse_result identity does not match the attempt');
  }
  if (!Number.isSafeInteger(result.page_count) || result.page_count < 1
      || !Array.isArray(result.pages) || result.pages.length !== result.page_count) {
    throw new TypeError('parse_result page_count does not match its pages');
  }
  const ok = result.pages.filter((page) => page?.ok === true).length;
  const failed = result.pages.filter((page) => page?.ok === false).length;
  if (ok + failed !== result.pages.length
      || result.pages_ok !== ok || result.pages_failed !== failed) {
    throw new TypeError('parse_result page counters are inconsistent');
  }
  for (let i = 0; i < result.pages.length; i += 1) {
    const page = object(result.pages[i], `parse_result.pages[${i}]`);
    if (page.pageNumber !== i + 1) throw new TypeError('parse_result pages are not ordered');
    if (page.ok) {
      if (page.pageSpatial?.documentSha256 !== expected.inputDigest
          || page.pageSpatial?.pageNumber !== page.pageNumber) {
        throw new TypeError(`parse_result page ${i + 1} identity does not match the job`);
      }
      if (!validatePageSpatial(page.pageSpatial)) {
        const detail = validatePageSpatial.errors?.[0];
        throw new TypeError(
          `parse_result page ${i + 1} is not schema-valid: `
          + `${detail?.instancePath ?? ''} ${detail?.message ?? 'unknown error'}`,
        );
      }
    }
  }
  return result;
}

/**
 * Validate bytes fetched from R2 and return only the values allowed to cross
 * into acceptance SQL. `lastModified` is R2's lifecycle clock.
 */
export function validateStoredResult({ bytes, lastModified, pointer = null, expected }) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1
      || bytes.byteLength > MAX_RESULT_BYTES) {
    throw new TypeError('stored result bytes are outside the publication bound');
  }
  const modified = lastModified instanceof Date ? lastModified : new Date(lastModified);
  if (Number.isNaN(modified.getTime())) throw new TypeError('stored result has no valid LastModified');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (pointer && (digest !== pointer.result_digest || bytes.byteLength !== pointer.result_bytes)) {
    throw new TypeError('stored result does not match its Modal pointer');
  }
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new TypeError('stored result is not valid JSON');
  }
  object(envelope, 'stored result envelope');
  exactKeys(envelope, [
    'schema_version', 'job_id', 'attempt_id', 'execution_id',
    'input_key', 'input_sha256', 'parse_result',
  ], 'stored result envelope');
  if (envelope.schema_version !== 1
      || envelope.job_id !== expected.jobId
      || envelope.attempt_id !== expected.attemptId
      || envelope.input_key !== expected.inputKey
      || envelope.input_sha256 !== expected.inputDigest) {
    throw new TypeError('stored result envelope identity does not match the job');
  }
  if (!EXECUTION_ID.test(envelope.execution_id)) {
    throw new TypeError('stored result execution_id is invalid');
  }
  if (pointer && envelope.execution_id !== pointer.execution_id) {
    throw new TypeError('stored result execution_id does not match its Modal pointer');
  }
  const parseResult = validateParseResult(envelope.parse_result, expected);
  if (pointer && parseResult.page_count !== pointer.page_count) {
    throw new TypeError('stored result page_count does not match its Modal pointer');
  }
  const key = `results/${expected.jobId}/${expected.attemptId}/${envelope.execution_id}.json`;
  return {
    resultKey: key,
    resultUri: `r2://${expected.resultsBucket}/${key}`,
    resultDigest: digest,
    resultCreatedAt: modified,
    pages: parseResult.page_count,
    status: 'completed',
  };
}

export const RESULT_LIMIT_BYTES = MAX_RESULT_BYTES;
