import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ApiError } from './api-errors.mjs';

const denied = () => new ApiError(403, 'forbidden', 'Access denied.');

export function createAccessAuthenticator({ db, issuer, audience, jwks }) {
  if (!db?.query) throw new TypeError('Access authentication requires a database');
  if (typeof issuer !== 'string' || !issuer.startsWith('https://') || issuer.endsWith('/')) {
    throw new TypeError('Access issuer must be an https origin without a trailing slash');
  }
  if (typeof audience !== 'string' || !audience) {
    throw new TypeError('Access audience is required');
  }
  const keySet = jwks ?? createRemoteJWKSet(
    new URL(`${issuer}/cdn-cgi/access/certs`),
    { timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 },
  );

  return async function authenticateAccess(jwt) {
    if (typeof jwt !== 'string' || !jwt) throw denied();
    let payload;
    try {
      ({ payload } = await jwtVerify(jwt, keySet, {
        issuer, audience, algorithms: ['RS256'],
      }));
    } catch {
      throw denied();
    }
    if (payload.type !== 'app' || typeof payload.email !== 'string') throw denied();
    const email = payload.email.trim().toLowerCase();
    if (!email) throw denied();
    const { rows } = await db.query(
      `UPDATE users SET status = 'active'
        WHERE email = $1 AND status IN ('invited','active')
        RETURNING id`,
      [email],
    );
    if (!rows[0]) throw denied();
    return { userId: rows[0].id, email };
  };
}
