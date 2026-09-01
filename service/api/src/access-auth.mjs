import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import { ApiError } from './api-errors.mjs';
import { assertTrialPages, provisionAccessUser } from './credits.mjs';

const denied = (cause) => new ApiError(
  403, 'forbidden', 'Access denied.', cause ? { cause } : undefined,
);
const unavailable = (cause) => new ApiError(
  503, 'service_unavailable', 'Service is temporarily unavailable.', { cause },
);

const credentialErrors = [
  joseErrors.JOSEAlgNotAllowed,
  joseErrors.JOSENotSupported,
  // Multiple matching keys are a provider-side ambiguity and intentionally
  // fall through to 503 instead of blaming the caller.
  // An unknown kid is also attacker-controlled. Keep it at 403, but preserve
  // the safe JOSE code in cause so a stale-key burst remains observable.
  joseErrors.JWKSNoMatchingKey,
  joseErrors.JWSInvalid,
  joseErrors.JWSSignatureVerificationFailed,
  joseErrors.JWTClaimValidationFailed,
  joseErrors.JWTExpired,
  joseErrors.JWTInvalid,
];

const isCredentialError = (error) => credentialErrors.some((Type) => error instanceof Type);

export function createAccessAuthenticator({
  db, issuer, audience, jwks, allowSelfSignup = false, trialPages = 100,
}) {
  if (!db?.query) throw new TypeError('Access authentication requires a database');
  if (typeof issuer !== 'string' || !issuer.startsWith('https://') || issuer.endsWith('/')) {
    throw new TypeError('Access issuer must be an https origin without a trailing slash');
  }
  if (typeof audience !== 'string' || !audience) {
    throw new TypeError('Access audience is required');
  }
  if (typeof allowSelfSignup !== 'boolean') throw new TypeError('allowSelfSignup must be boolean');
  assertTrialPages(trialPages);
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
      throw denied(error);
    }
    if (payload.type !== 'app' || typeof payload.email !== 'string') throw denied();
    const email = payload.email.trim().toLowerCase();
    if (!email) throw denied();
    const userId = await provisionAccessUser(db, {
      email, allowSelfSignup, trialPages,
    });
    if (!userId) throw denied();
    return { userId, email };
  };
}
