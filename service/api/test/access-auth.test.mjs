import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT,
} from 'jose';
import { createAccessAuthenticator } from '../src/access-auth.mjs';
import { migrate } from '../src/migrate.mjs';

const ISSUER = 'https://pagespatial.cloudflareaccess.com';
const AUDIENCE = 'app-audience';
let db;
let keys;

before(async () => {
  db = await PGlite.create();
  keys = await Promise.all(['key-one', 'key-two'].map(async (kid) => {
    const pair = await generateKeyPair('RS256');
    return { kid, ...pair, jwk: { ...await exportJWK(pair.publicKey), kid, alg: 'RS256' } };
  }));
});

beforeEach(async () => {
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
});

async function token({
  key = keys[0], email = ' User@Example.COM ', issuer = ISSUER,
  audience = AUDIENCE, expiration = '5m', ...claims
} = {}) {
  return new SignJWT({ email, type: 'app', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(key.privateKey);
}

test('Access verifies both rotation keys and activates one canonical invited user', async () => {
  const user = (await db.query(
    "INSERT INTO users (email, status) VALUES ('user@example.com','invited') RETURNING id",
  )).rows[0];
  await db.exec(`
    CREATE TABLE user_update_audit (user_id uuid NOT NULL);
    CREATE FUNCTION audit_user_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO user_update_audit (user_id) VALUES (NEW.id);
      RETURN NEW;
    END $$;
    CREATE TRIGGER users_updated AFTER UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION audit_user_update();
  `);
  const authenticate = createAccessAuthenticator({
    db,
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: createLocalJWKSet({ keys: keys.map((key) => key.jwk) }),
  });

  assert.deepEqual(await authenticate(await token()), { userId: user.id, email: 'user@example.com' });
  assert.deepEqual(
    await authenticate(await token({ key: keys[1] })),
    { userId: user.id, email: 'user@example.com' },
  );
  assert.deepEqual(
    await authenticate(await token({ expiration: Math.floor(Date.now() / 1000) - 15 })),
    { userId: user.id, email: 'user@example.com' },
  );
  assert.equal((await db.query('SELECT status FROM users WHERE id = $1', [user.id])).rows[0].status, 'active');
  assert.equal((await db.query(
    'SELECT count(*)::int AS count FROM user_update_audit WHERE user_id = $1', [user.id],
  )).rows[0].count, 1);
});

test('Access rejects invalid claims, unknown users, and suspended users with one safe error', async () => {
  await db.query(
    `INSERT INTO users (email, status) VALUES
      ('user@example.com','active'),
      ('suspended@example.com','suspended')`,
  );
  const authenticate = createAccessAuthenticator({
    db,
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: createLocalJWKSet({ keys: keys.map((key) => key.jwk) }),
  });
  const rejected = [
    await token({ audience: 'wrong-audience' }),
    await token({ issuer: 'https://wrong.cloudflareaccess.com' }),
    await token({ expiration: Math.floor(Date.now() / 1000) - 60 }),
    await token({ type: 'service' }),
    await token({ email: 'unknown@example.com' }),
    await token({ email: 'suspended@example.com' }),
  ];
  for (const jwt of rejected) {
    await assert.rejects(
      authenticate(jwt),
      (error) => error.status === 403 && error.code === 'forbidden'
        && error.message === 'Access denied.',
    );
  }
});

test('Access self-signup provisions a verified identity once when enabled', async () => {
  const authenticate = createAccessAuthenticator({
    db,
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: createLocalJWKSet({ keys: keys.map((key) => key.jwk) }),
    allowSelfSignup: true,
    trialPages: 100,
  });
  const jwt = await token({ email: ' Alpha@Example.COM ' });
  const first = await authenticate(jwt);
  const replay = await authenticate(jwt);
  assert.deepEqual(replay, first);
  assert.equal(first.email, 'alpha@example.com');
  assert.equal(Number((await db.query(
    'SELECT count(*) FROM credit_grants WHERE user_id = $1', [first.userId],
  )).rows[0].count), 1);
  assert.equal(Number((await db.query(
    'SELECT pages FROM credit_grants WHERE user_id = $1', [first.userId],
  )).rows[0].pages), 100);
});

test('Access reports JWKS provider failures as unavailable, not forbidden', async () => {
  for (const cause of [
    new errors.JWKSTimeout(),
    new errors.JOSEError('Expected 200 OK from JWKS'),
    new errors.JWKSMultipleMatchingKeys(),
    new TypeError('fetch failed'),
  ]) {
    const authenticate = createAccessAuthenticator({
      db,
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks: async () => { throw cause; },
    });
    await assert.rejects(
      authenticate(await token()),
      (error) => error.status === 503 && error.code === 'service_unavailable'
        && error.message === 'Service is temporarily unavailable.'
        && error.cause === cause,
    );
  }
});

test('Access treats an unknown signing key as invalid credentials', async () => {
  const authenticate = createAccessAuthenticator({
    db,
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: async () => { throw new errors.JWKSNoMatchingKey(); },
  });
  await assert.rejects(
    authenticate(await token()),
    (error) => error.status === 403 && error.code === 'forbidden'
      && error.cause instanceof errors.JWKSNoMatchingKey,
  );
});
