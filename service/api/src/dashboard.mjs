import { readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { ApiError } from './api-errors.mjs';
import { requestMoreCredits } from './credits.mjs';
import {
  InactiveApiKeyOwnerError, InvalidApiKeyNameError,
  issueApiKey, listApiKeys, revokeApiKey,
} from './api-keys.mjs';
import { loadJobsPage, loadUsagePage, parseJobsQuery } from './dashboard-data.mjs';
import {
  createdKeyPage, errorPage, guidePage, jobDetailPage, jobsPage,
  keysPage, newJobPage, revokeKeyPage, usagePage,
} from './dashboard-views.mjs';
import {
  createOrReplayJob, finalizeJob, jobView, ownedJob, resultGrant,
} from './jobs.mjs';
import { exactObject, jsonBody } from './request-json.mjs';
import { logFailure } from './safe-log.mjs';

const MAX_FORM_BYTES = 4 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CSP = "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const DASHBOARD_CSS = readFileSync(new URL('./dashboard.css', import.meta.url));
const DASHBOARD_ASSETS = new Map([
  ['/assets/pagespatial-logo.png', ['image/png', readFileSync(new URL('./assets/pagespatial-logo.png', import.meta.url))]],
  ['/assets/fonts/instrument-sans-400.ttf', ['font/ttf', readFileSync(new URL('./assets/fonts/instrument-sans-400.ttf', import.meta.url))]],
  ['/assets/fonts/instrument-sans-500.ttf', ['font/ttf', readFileSync(new URL('./assets/fonts/instrument-sans-500.ttf', import.meta.url))]],
  ['/assets/fonts/instrument-sans-600.ttf', ['font/ttf', readFileSync(new URL('./assets/fonts/instrument-sans-600.ttf', import.meta.url))]],
  ['/assets/fonts/newsreader-600.ttf', ['font/ttf', readFileSync(new URL('./assets/fonts/newsreader-600.ttf', import.meta.url))]],
  ['/assets/fonts/ibm-plex-mono-400.ttf', ['font/ttf', readFileSync(new URL('./assets/fonts/ibm-plex-mono-400.ttf', import.meta.url))]],
  ['/assets/fonts/ibm-plex-mono-500.ttf', ['font/ttf', readFileSync(new URL('./assets/fonts/ibm-plex-mono-500.ttf', import.meta.url))]],
  ['/assets/dashboard-upload.js', ['text/javascript; charset=utf-8', readFileSync(new URL('./dashboard-upload.js', import.meta.url))]],
]);

function send(res, status, contentType, bytes, requestId, headers = {}) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': bytes.byteLength,
    'cache-control': 'no-store',
    'content-security-policy': CSP,
    'x-request-id': requestId,
    ...headers,
  });
  res.end(bytes);
}

function sendHtml(res, status, content, requestId, headers = {}) {
  send(res, status, 'text/html; charset=utf-8', Buffer.from(content), requestId, headers);
}

function sendJson(res, status, body, requestId, headers = {}) {
  send(
    res, status, 'application/json; charset=utf-8',
    Buffer.from(JSON.stringify(body)), requestId, headers,
  );
}

async function formBody(req, expected) {
  if ((req.headers['content-type'] ?? '').split(';', 1)[0].trim()
      !== 'application/x-www-form-urlencoded') {
    throw new ApiError(400, 'invalid_request', 'Expected a form body.');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.byteLength;
    if (total > MAX_FORM_BYTES) throw new ApiError(400, 'invalid_request', 'Form body is too large.');
    chunks.push(chunk);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch {
    throw new ApiError(400, 'invalid_request', 'Form body is not valid UTF-8.');
  }
  let entries;
  try {
    entries = text === '' ? [] : text.split('&').map((part) => {
      const separator = part.indexOf('=');
      const key = separator < 0 ? part : part.slice(0, separator);
      const value = separator < 0 ? '' : part.slice(separator + 1);
      const decode = (item) => decodeURIComponent(item.replaceAll('+', ' '));
      return [decode(key), decode(value)];
    });
  } catch {
    throw new ApiError(400, 'invalid_request', 'Form body is not valid UTF-8.');
  }
  if (entries.length !== expected.length
      || entries.some(([key], index) => key !== expected[index])) {
    throw new ApiError(400, 'invalid_request', 'Unexpected form fields.');
  }
  return Object.fromEntries(entries);
}

function dashboardOperation(method, path) {
  if (method === 'GET' && path === '/dashboard.css') return 'dashboard_styles';
  if (method === 'GET' && DASHBOARD_ASSETS.has(path)) return 'dashboard_asset';
  if (method === 'GET' && (path === '/' || path === '/jobs')) return 'jobs_list';
  if (method === 'GET' && path === '/jobs/new') return 'job_browser_form';
  if (method === 'POST' && path === '/jobs') return 'job_browser_submit';
  if (method === 'POST' && /^\/jobs\/[^/]+\/finalize$/u.test(path)) return 'job_browser_finalize';
  if (method === 'GET' && /^\/jobs\/[^/]+\/result$/u.test(path)) return 'job_result';
  if (method === 'GET' && /^\/jobs\/[^/]+$/u.test(path)) return 'job_detail';
  if (method === 'GET' && path === '/usage') return 'usage_view';
  if (method === 'POST' && path === '/credits/request') return 'credits_request';
  if (method === 'GET' && path === '/guide') return 'api_guide';
  if (method === 'GET' && path === '/keys') return 'keys_list';
  if (method === 'POST' && path === '/keys') return 'keys_create';
  if (method === 'GET' && /^\/keys\/[^/]+\/revoke$/u.test(path)) return 'keys_revoke_confirm';
  if (method === 'POST' && /^\/keys\/[^/]+\/revoke$/u.test(path)) return 'keys_revoke';
  return 'dashboard_unknown';
}

function matchUuid(path, pattern) {
  const match = pattern.exec(path);
  if (!match || !UUID.test(match[1])) throw new ApiError(404, 'not_found', 'Not found.');
  return match[1];
}

export function createDashboardHandler({
  db, pool, inputStore, inputBucket = inputStore?.bucket, resultStore,
  unitPriceMicros = 1000, appOrigin, inputUploadOrigin,
  authenticateAccess, log = console, now = () => new Date(),
}) {
  if (!db?.query) throw new TypeError('dashboard requires a database');
  if (typeof appOrigin !== 'string' || !appOrigin.startsWith('https://')) {
    throw new TypeError('dashboard requires an https appOrigin');
  }
  if (typeof authenticateAccess !== 'function') {
    throw new TypeError('dashboard requires Access authentication');
  }
  if (!pool?.connect || !inputStore?.createUploadGrant || !inputStore?.head) {
    throw new TypeError('dashboard browser upload requires the existing job plane');
  }
  let parsedUploadOrigin;
  try {
    parsedUploadOrigin = new URL(inputUploadOrigin);
  } catch {
    throw new TypeError('dashboard requires an https inputUploadOrigin');
  }
  if (parsedUploadOrigin.protocol !== 'https:' || parsedUploadOrigin.origin !== inputUploadOrigin) {
    throw new TypeError('dashboard requires an https inputUploadOrigin');
  }
  const uploadCsp = `${CSP}; script-src 'self'; connect-src 'self' ${inputUploadOrigin}`;

  return async function dashboard(req, res, requestId) {
    let operation = 'dashboard_unknown';
    let rejectionLogged = false;
    let identity = null;
    try {
      const url = new URL(req.url, appOrigin);
      const path = url.pathname;
      operation = dashboardOperation(req.method, path);
      identity = await authenticateAccess(req.headers['cf-access-jwt-assertion']);

      if (req.method === 'GET' && path === '/dashboard.css') {
        return send(res, 200, 'text/css; charset=utf-8', DASHBOARD_CSS, requestId);
      }
      if (req.method === 'GET' && DASHBOARD_ASSETS.has(path)) {
        const [contentType, bytes] = DASHBOARD_ASSETS.get(path);
        return send(res, 200, contentType, bytes, requestId);
      }
      if (req.method === 'GET' && path === '/') {
        return sendHtml(res, 303, '', requestId, { location: '/jobs' });
      }
      if (req.method === 'GET' && path === '/jobs') {
        const current = now();
        let filters;
        try {
          filters = parseJobsQuery(url.searchParams);
        } catch {
          throw new ApiError(400, 'invalid_request', 'Invalid jobs filter.');
        }
        const result = await loadJobsPage(db, {
          userId: identity.userId, ...filters, now: current,
        });
        if (filters.page > result.pageCount) {
          throw new ApiError(404, 'not_found', 'Page was not found.');
        }
        return sendHtml(res, 200, jobsPage({ identity, filters, result, now: current }), requestId);
      }
      if (req.method === 'GET' && path === '/jobs/new') {
        return sendHtml(
          res, 200, newJobPage({ identity }), requestId,
          { 'content-security-policy': uploadCsp },
        );
      }
      if (req.method === 'GET' && path === '/usage') {
        const current = now();
        const usage = await loadUsagePage(db, { userId: identity.userId, now: current });
        return sendHtml(res, 200, usagePage({ identity, usage, now: current }), requestId);
      }
      if (req.method === 'GET' && path === '/guide') {
        return sendHtml(res, 200, guidePage({ identity }), requestId);
      }
      if (req.method === 'GET' && path === '/keys') {
        return sendHtml(res, 200, keysPage({
          identity, keys: await listApiKeys(db, identity),
        }), requestId);
      }
      if (req.method === 'GET' && /^\/jobs\/[^/]+\/result$/u.test(path)) {
        const jobId = matchUuid(path, /^\/jobs\/([^/]+)\/result$/u);
        const grant = await resultGrant({
          db, resultStore, userId: identity.userId, jobId, now: now(),
        });
        return sendHtml(res, 303, '', requestId, { location: grant.download_url });
      }
      if (req.method === 'GET' && /^\/jobs\/[^/]+$/u.test(path)) {
        const jobId = matchUuid(path, /^\/jobs\/([^/]+)$/u);
        const row = await ownedJob(db, { userId: identity.userId, jobId });
        return sendHtml(res, 200, jobDetailPage({
          identity, row, view: jobView(row), now: now(),
        }), requestId);
      }
      if (req.method === 'GET' && /^\/keys\/[^/]+\/revoke$/u.test(path)) {
        const keyId = matchUuid(path, /^\/keys\/([^/]+)\/revoke$/u);
        const key = (await listApiKeys(db, identity)).find((candidate) => candidate.id === keyId);
        if (!key || key.revoked_at != null) throw new ApiError(404, 'not_found', 'Not found.');
        return sendHtml(res, 200, revokeKeyPage({ identity, key }), requestId);
      }

      if (req.method === 'POST') {
        if (req.headers.origin !== appOrigin) {
          logFailure(log, 'dashboard_csrf_rejected', {
            requestId, method: req.method, operation,
            reason: req.headers.origin == null ? 'missing_origin' : 'foreign_origin',
          });
          rejectionLogged = true;
          throw new ApiError(403, 'forbidden', 'Access denied.');
        }
        if (path === '/jobs') {
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
          const upload = row.state === 'uploading' && new Date(row.upload_expires_at) > now()
            ? await inputStore.createUploadGrant({
              jobId: row.id, expiresAt: row.upload_expires_at,
            }) : null;
          return sendJson(
            res, result.created ? 201 : 200,
            { job: jobView(row), upload }, requestId,
            { 'content-security-policy': uploadCsp },
          );
        }
        if (/^\/jobs\/[^/]+\/finalize$/u.test(path)) {
          const jobId = matchUuid(path, /^\/jobs\/([^/]+)\/finalize$/u);
          exactObject(await jsonBody(req), []);
          const result = await finalizeJob({
            db, inputStore, userId: identity.userId, jobId, now: now(),
          });
          return sendJson(
            res, result.status, { job: jobView(result.row) }, requestId,
            { 'content-security-policy': uploadCsp },
          );
        }
        if (path === '/keys') {
          const body = await formBody(req, ['name']);
          let issued;
          try {
            issued = await issueApiKey(db, { userId: identity.userId, name: body.name });
          } catch (error) {
            if (error instanceof InvalidApiKeyNameError) {
              throw new ApiError(400, 'invalid_request', 'Key name must contain 1 to 64 characters.');
            }
            if (error instanceof InactiveApiKeyOwnerError) {
              throw new ApiError(403, 'forbidden', 'Access denied.', { cause: error });
            }
            throw error;
          }
          return sendHtml(res, 201, createdKeyPage({ identity, secret: issued.secret }), requestId);
        }
        if (path === '/credits/request') {
          await formBody(req, []);
          await requestMoreCredits(db, { userId: identity.userId });
          return sendHtml(res, 303, '', requestId, { location: '/usage' });
        }
        if (/^\/keys\/[^/]+\/revoke$/u.test(path)) {
          const keyId = matchUuid(path, /^\/keys\/([^/]+)\/revoke$/u);
          await formBody(req, []);
          if (!await revokeApiKey(db, { userId: identity.userId, keyId })) {
            throw new ApiError(404, 'not_found', 'Not found.');
          }
          return sendHtml(res, 303, '', requestId, { location: '/keys' });
        }
      }
      throw new ApiError(404, 'not_found', 'Not found.');
    } catch (error) {
      const failure = error instanceof ApiError
        ? error : new ApiError(503, 'service_unavailable', 'Service is temporarily unavailable.');
      if (failure.status === 403 && !rejectionLogged) {
        logFailure(log, 'dashboard_request_rejected', {
          requestId, method: req.method, operation, reason: failure.code, error,
        });
      }
      if (failure.status >= 500) {
        logFailure(log, 'dashboard_request_failed', {
          requestId, method: req.method, operation, error,
        });
      }
      if (operation === 'job_browser_submit' || operation === 'job_browser_finalize') {
        return sendJson(res, failure.status, {
          error: { code: failure.code, message: failure.message, request_id: requestId },
        }, requestId, { ...failure.headers, 'content-security-policy': uploadCsp });
      }
      const content = identity
        ? errorPage({ identity, statusCode: failure.status, message: failure.message, requestId })
        : `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Request failed · PageSpatial</title><link rel="stylesheet" href="/dashboard.css"><main class="page-shell"><section class="narrow-page error-page"><h1>${failure.status === 403 ? 'Access denied.' : 'Service is temporarily unavailable.'}</h1><p>Request ID: ${requestId}</p></section></main></html>`;
      return sendHtml(res, failure.status, content, requestId, failure.headers);
    }
  };
}
