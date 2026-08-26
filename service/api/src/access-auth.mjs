import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import { ApiError } from './api-errors.mjs';

const denied = () => new ApiError(403, 'forbidden', 'Access denied.');
const unavailable = (cause) => new ApiError(
  503, 'service_unavailable', 'Service is temporarily unavailable.', { cause },
);

const credentialErrors = [
  joseErrors.JOSEAlgNotAllowed,
  joseErrors.JOSENotSupported,
  joseErrors.JWKSMultipleMatchingKeys,
  joseErrors.JWKSNoMatchingKey,
  joseErrors.JWSInvalid,
  joseErrors.JWSSignatureVerificationFailed,
  joseErrors.JWTClaimValidationFailed,
  joseErrors.JWTExpired,
  joseErrors.JWTInvalid,
];

const isCredentialError = (error) => credentialErrors.some((Type) => error instanceof Type);

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
        issuer, audience, algorithms: ['RS256'], clockTolerance: 30,
      }));
    } catch (error) {
      if (!isCredentialError(error)) throw unavailable(error);
      throw denied();
    }
    if (payload.type !== 'app' || typeof payload.email !== 'string') throw denied();
    const email = payload.email.trim().toLowerCase();
    if (!email) throw denied();
    const { rows } = await db.query(
      `SELECT id, status FROM users
        WHERE email = $1 AND status IN ('invited','active')`,
      [email],
    );
    if (!rows[0]) throw denied();
    if (rows[0].status === 'active') return { userId: rows[0].id, email };

    const activated = await db.query(
      `UPDATE users SET status = 'active'
        WHERE id = $1 AND status = 'invited'
        RETURNING id`,
      [rows[0].id],
    );
    if (activated.rows[0]) return { userId: activated.rows[0].id, email };

    const concurrent = await db.query(
      "SELECT id FROM users WHERE id = $1 AND status = 'active'",
      [rows[0].id],
    );
    if (!concurrent.rows[0]) throw denied();
    return { userId: concurrent.rows[0].id, email };
  };
}
