export const FAILURE_CODES = Object.freeze([
  'upload_expired',
  'invalid_upload',
  'input_digest_mismatch',
  'input_too_large',
  'invalid_pdf',
  'page_limit_exceeded',
  'processing_deadline_exceeded',
  'dispatch_failed',
  'processing_failed',
]);

const known = new Set(FAILURE_CODES);

export function failureCode(value, fallback = 'processing_failed') {
  if (known.has(value)) return value;
  if (!known.has(fallback)) throw new TypeError('fallback failure code is invalid');
  return fallback;
}

export function assertFailureCode(value) {
  if (!known.has(value)) throw new TypeError(`unknown failure code: ${value}`);
  return value;
}
