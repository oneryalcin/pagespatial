import { randomUUID } from 'node:crypto';
import { ApiError, invalidRequest } from './api-errors.mjs';
import { authenticateApiKey } from './api-keys.mjs';
import { createDashboardHandler } from './dashboard.mjs';
import { logFailure } from './safe-log.mjs';
import {
  createOrReplayJob, finalizeJob, jobView, ownedJob, resultGrant,
} from './jobs.mjs';

const MAX_JSON_BYTES = 4 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function sendJson(res, status, body, requestId, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': bytes.byteLength,
    'x-request-id': requestId,
    ...headers,
  });
  res.end(bytes);
}

async function jsonBody(req) {
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

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRequest('Request body must be an object.');
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw invalidRequest(`Request fields must equal: ${expected.join(', ')}.`);
  }
  return value;
}

function jobId(parts) {
  const value = parts[2];
  if (!UUID.test(value ?? '')) throw new ApiError(404, 'not_found', 'Job was not found.');
  return value;
}

function apiOperation(method, pathname) {
  if (method === 'GET' && pathname === '/health') return 'health';
  if (method === 'POST' && pathname === '/v1/jobs') return 'job_submit';
  if (method === 'POST' && /^\/v1\/jobs\/[^/]+\/finalize$/u.test(pathname)) return 'job_finalize';
  if (method === 'GET' && /^\/v1\/jobs\/[^/]+\/result$/u.test(pathname)) return 'job_result';
  if (method === 'GET' && /^\/v1\/jobs\/[^/]+$/u.test(pathname)) return 'job_status';
  return 'route_unknown';
}

export function createApiHandler({
  db, pool, inputStore, resultStore, inputBucket = inputStore?.bucket,
  unitPriceMicros = 1000, apiHost, appHost, appOrigin, authenticateAccess,
  authenticate = (authorization) => authenticateApiKey(db, authorization),
  createRequestId = randomUUID, log = console, healthDependencies = {},
}) {
  if (typeof apiHost !== 'string' || !apiHost) throw new TypeError('apiHost is required');
  if (typeof appHost !== 'string' || !appHost || appHost === apiHost) {
    throw new TypeError('a distinct appHost is required');
  }
  const dashboard = createDashboardHandler({
    db, resultStore, appOrigin, authenticateAccess, log,
  });
  return async function apiHandler(req, res, suppliedRequestId) {
    const requestId = suppliedRequestId ?? createRequestId();
    let operation = 'route_unknown';
    try {
      const host = req.headers.host?.split(':', 1)[0];
      if (host === appHost) return dashboard(req, res, requestId);
      if (host !== apiHost) {
        throw new ApiError(421, 'invalid_request', 'Request was sent to the wrong host.');
      }
      const url = new URL(req.url, 'http://api.invalid');
      operation = apiOperation(req.method, url.pathname);
      if (req.method === 'GET' && url.pathname === '/health') {
        await db.query('SELECT 1');
        const degraded = Object.fromEntries(await Promise.all(
          Object.entries(healthDependencies).map(async ([name, probe]) => {
            try {
              await probe();
              return [name, false];
            } catch {
              return [name, true];
            }
          }),
        ));
        return sendJson(res, 200, { status: 'ready', degraded }, requestId);
      }
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'v1') throw new ApiError(404, 'not_found', 'Route was not found.');
      const identity = await authenticate(req.headers.authorization);

      if (req.method === 'POST' && url.pathname === '/v1/jobs') {
        const body = exactObject(await jsonBody(req), ['input_sha256']);
        const result = await createOrReplayJob({
          pool,
          userId: identity.userId,
          idempotencyKey: req.headers['idempotency-key'],
          inputSha256: body.input_sha256,
          inputBucket,
          unitPriceMicros,
        });
        const row = result.row;
        const upload = row.state === 'uploading' && new Date(row.upload_expires_at) > new Date()
          ? await inputStore.createUploadGrant({ jobId: row.id, expiresAt: row.upload_expires_at })
          : null;
        return sendJson(
          res, result.created ? 201 : 200,
          { job: jobView(row), upload }, requestId,
          { 'cache-control': 'no-store' },
        );
      }

      if (req.method === 'POST' && parts.length === 4
          && parts[1] === 'jobs' && parts[3] === 'finalize') {
        exactObject(await jsonBody(req), []);
        const result = await finalizeJob({
          db, inputStore, userId: identity.userId, jobId: jobId(parts),
        });
        return sendJson(res, result.status, { job: jobView(result.row) }, requestId);
      }

      if (req.method === 'GET' && parts.length === 3 && parts[1] === 'jobs') {
        const row = await ownedJob(db, { userId: identity.userId, jobId: jobId(parts) });
        return sendJson(res, 200, { job: jobView(row) }, requestId);
      }

      if (req.method === 'GET' && parts.length === 4
          && parts[1] === 'jobs' && parts[3] === 'result') {
        const grant = await resultGrant({
          db, resultStore, userId: identity.userId, jobId: jobId(parts),
        });
        return sendJson(res, 200, { result: grant }, requestId, { 'cache-control': 'no-store' });
      }

      throw new ApiError(404, 'not_found', 'Route was not found.');
    } catch (error) {
      const failure = error instanceof ApiError
        ? error : new ApiError(503, 'service_unavailable', 'Service is temporarily unavailable.');
      if (failure.status >= 500) {
        logFailure(log, 'api_request_failed', {
          requestId, method: req.method, operation, error,
        });
      } else if ([401, 403, 429].includes(failure.status)) {
        logFailure(log, 'api_request_rejected', {
          requestId, method: req.method, operation, reason: failure.code, error,
        });
      }
      return sendJson(res, failure.status, {
        error: { code: failure.code, message: failure.message, request_id: requestId },
      }, requestId, failure.headers);
    }
  };
}
