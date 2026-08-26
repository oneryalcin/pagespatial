import { TextDecoder } from 'node:util';
import { ApiError } from './api-errors.mjs';
import {
  InactiveApiKeyOwnerError, InvalidApiKeyNameError,
  issueApiKey, listApiKeys, revokeApiKey,
} from './api-keys.mjs';
import { logFailure } from './safe-log.mjs';

const MAX_FORM_BYTES = 4 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CSP = "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'";

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

function sendHtml(res, status, content, headers = {}) {
  const bytes = Buffer.from(`<!doctype html><html lang="en"><meta charset="utf-8"><title>PageSpatial keys</title><main>${content}</main>`);
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': bytes.byteLength,
    'cache-control': 'no-store',
    'content-security-policy': CSP,
    ...headers,
  });
  res.end(bytes);
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

const date = (value) => value == null ? 'never' : new Date(value).toISOString();

function keysPage(keys) {
  const rows = keys.map((key) => `<tr><td>${escapeHtml(key.name)}</td><td>${escapeHtml(key.prefix)}</td><td>${date(key.created_at)}</td><td>${date(key.last_used_at)}</td><td>${date(key.revoked_at)}</td><td><form method="post" action="/keys/${key.id}/revoke"><button type="submit">Revoke</button></form></td></tr>`).join('');
  return `<h1>API keys</h1><form method="post" action="/keys"><label>Name <input name="name" maxlength="64" required></label><button type="submit">Create key</button></form><table><thead><tr><th>Name</th><th>Prefix</th><th>Created</th><th>Last used</th><th>Revoked</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

const createdPage = (secret) => `<section><h1>API key created</h1><p>Copy it now. It will not be shown again.</p><code>${escapeHtml(secret)}</code><p><a href="/keys">Return to keys</a></p></section>`;

function dashboardOperation(method, path) {
  if (method === 'GET' && path === '/keys') return 'keys_list';
  if (method === 'POST' && path === '/keys') return 'keys_create';
  if (method === 'POST' && /^\/keys\/[^/]+\/revoke$/u.test(path)) return 'keys_revoke';
  return 'dashboard_unknown';
}

export function createDashboardHandler({ db, appOrigin, authenticateAccess, log = console }) {
  if (!db?.query) throw new TypeError('dashboard requires a database');
  if (typeof appOrigin !== 'string' || !appOrigin.startsWith('https://')) {
    throw new TypeError('dashboard requires an https appOrigin');
  }
  if (typeof authenticateAccess !== 'function') {
    throw new TypeError('dashboard requires Access authentication');
  }

  return async function dashboard(req, res, requestId) {
    let operation = 'dashboard_unknown';
    let rejectionLogged = false;
    try {
      const path = new URL(req.url, appOrigin).pathname;
      operation = dashboardOperation(req.method, path);
      const identity = await authenticateAccess(req.headers['cf-access-jwt-assertion']);
      if (req.method === 'GET' && path === '/keys') {
        return sendHtml(res, 200, keysPage(await listApiKeys(db, identity)));
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
          return sendHtml(res, 201, createdPage(issued.secret));
        }
        const match = /^\/keys\/([^/]+)\/revoke$/u.exec(path);
        if (match) {
          await formBody(req, []);
          if (!UUID.test(match[1])
              || !await revokeApiKey(db, { userId: identity.userId, keyId: match[1] })) {
            throw new ApiError(404, 'not_found', 'Not found.');
          }
          return sendHtml(res, 303, '<p>Redirecting.</p>', { location: '/keys' });
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
      return sendHtml(res, failure.status, `<h1>${escapeHtml(failure.message)}</h1>`);
    }
  };
}
