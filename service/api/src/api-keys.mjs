import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from './api-errors.mjs';

const TOKEN = /^ps_live_([A-Za-z0-9_-]{43})$/u;
const PREFIX_LENGTH = 'ps_live_'.length + 8;
const AUTH_HEADERS = Object.freeze({ 'www-authenticate': 'Bearer' });

export class InvalidApiKeyNameError extends TypeError {}
export class InactiveApiKeyOwnerError extends Error {}

export function apiKeyDigest(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function generateApiKey() {
  const secret = `ps_live_${randomBytes(32).toString('base64url')}`;
  return { secret, prefix: secret.slice(0, PREFIX_LENGTH), hash: apiKeyDigest(secret) };
}

export async function issueApiKey(db, { userId, name }) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  const characters = [...trimmed].length;
  if (characters < 1 || characters > 64) {
    throw new InvalidApiKeyNameError('API key name must contain 1 to 64 characters');
  }
  const material = generateApiKey();
  const { rows } = await db.query(
    `INSERT INTO api_keys (user_id, prefix, hash, name)
     SELECT id, $2, $3, $4 FROM users
      WHERE id = $1 AND status = 'active'
     RETURNING id, prefix, name, created_at`,
    [userId, material.prefix, material.hash, trimmed],
  );
  if (!rows[0]) throw new InactiveApiKeyOwnerError('active user does not exist');
  return { key: rows[0], secret: material.secret };
}

export async function listApiKeys(db, { userId }) {
  const { rows } = await db.query(
    `SELECT id, prefix, name, created_at, last_used_at, revoked_at
       FROM api_keys
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC`,
    [userId],
  );
  return rows;
}

export async function revokeApiKey(db, { userId, keyId }) {
  const { rowCount } = await db.query(
    `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1 AND user_id = $2`,
    [keyId, userId],
  );
  return rowCount === 1;
}

function bearer(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([^ ]+)$/iu.exec(header);
  return match?.[1] ?? null;
}

export async function authenticateApiKey(db, authorization) {
  const secret = bearer(authorization);
  const token = secret && TOKEN.exec(secret);
  if (!token) {
    throw new ApiError(401, 'authentication_required', 'A valid API key is required.', {
      headers: AUTH_HEADERS,
    });
  }
  const prefix = secret.slice(0, PREFIX_LENGTH);
  const { rows } = await db.query(
    `SELECT k.id AS key_id, k.hash, u.id AS user_id
       FROM api_keys k JOIN users u ON u.id = k.user_id
      WHERE k.prefix = $1 AND k.revoked_at IS NULL AND u.status = 'active'`,
    [prefix],
  );
  const row = rows[0];
  const actual = Buffer.from(apiKeyDigest(secret), 'hex');
  const expected = row?.hash && /^[0-9a-f]{64}$/u.test(row.hash)
    ? Buffer.from(row.hash, 'hex') : Buffer.alloc(32);
  if (!row || !timingSafeEqual(actual, expected)) {
    throw new ApiError(401, 'authentication_required', 'A valid API key is required.', {
      headers: AUTH_HEADERS,
    });
  }
  await db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.key_id]);
  return { userId: row.user_id, keyId: row.key_id };
}
