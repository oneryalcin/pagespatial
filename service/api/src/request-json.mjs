import { invalidRequest } from './api-errors.mjs';

const MAX_JSON_BYTES = 4 * 1024;

export async function jsonBody(req) {
  if ((req.headers['content-type'] ?? '').split(';', 1)[0].trim() !== 'application/json') {
    throw invalidRequest('Content-Type must be application/json.');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.byteLength;
    if (total > MAX_JSON_BYTES) throw invalidRequest('JSON request body exceeds 4 KiB.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    throw invalidRequest('Request body is not valid JSON.');
  }
}

export function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRequest('Request body must be an object.');
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidRequest(`Request fields must equal: ${expected.join(', ')}.`);
  }
  return value;
}
