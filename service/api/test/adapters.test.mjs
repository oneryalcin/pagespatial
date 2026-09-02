import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FunctionTimeoutError, RemoteError } from 'modal';
import { dispatchExistingAttempt } from '../src/dispatcher.mjs';
import { createModalCalls } from '../src/modal-calls.mjs';
import { InvalidResultError, RESULT_LIMIT_BYTES } from '../src/result-contract.mjs';
import {
  createR2ResultStore, ResultStoreUnavailableError, r2ClientFromConfig,
} from '../src/r2-results.mjs';
import { createInputObjectStore, s3ClientFromConfig } from '../src/object-stores.mjs';
import { validateR2Isolation } from '../src/runtime.mjs';

test('Modal adapter hydrates the method once and returns a persisted call id', async () => {
  let classLookups = 0;
  const method = { spawn: async ([payload]) => ({ functionCallId: `fc-${payload.n}` }) };
  const client = {
    cls: {
      fromName: async () => {
        classLookups += 1;
        return { instance: async () => ({ method: () => method }) };
      },
    },
    functionCalls: {},
  };
  const calls = createModalCalls({ client, appName: 'app' });
  assert.deepEqual(await calls.spawn({ n: 1 }), { callId: 'fc-1' });
  assert.deepEqual(await calls.spawn({ n: 2 }), { callId: 'fc-2' });
  assert.equal(classLookups, 1);
});

test('Modal adapter retries a rejected method lookup instead of caching the failure', async () => {
  let lookups = 0;
  const method = { spawn: async () => ({ functionCallId: 'fc-recovered' }) };
  const client = {
    cls: {
      fromName: async () => {
        lookups += 1;
        if (lookups === 1) throw new Error('transient lookup failure');
        return { instance: async () => ({ method: () => method }) };
      },
    },
    functionCalls: {},
  };
  const calls = createModalCalls({ client, appName: 'app' });
  await assert.rejects(calls.spawn({}), /transient lookup failure/);
  assert.deepEqual(await calls.spawn({}), { callId: 'fc-recovered' });
  assert.equal(lookups, 2);
});

test('dispatcher does not relabel a call-id persistence failure as a spawn failure', async () => {
  let queries = 0;
  const db = {
    async query() {
      queries += 1;
      if (queries === 1) return { rows: [{
        attempt_id: 'a', job_id: 'j', state: 'dispatching',
        input_uri: 'r2://inputs/inputs/j.pdf', input_digest: 'a'.repeat(64),
        reserved_pages: 200,
      }] };
      throw new Error('database write failed');
    },
  };
  await assert.rejects(
    dispatchExistingAttempt({
      db, inputBucket: 'inputs', attemptId: 'a',
      modalCalls: { spawn: async () => ({ callId: 'fc-landed' }) },
    }),
    (error) => error.modalCallId === 'fc-landed'
      && /spawned but its call id was not persisted/.test(error.message),
  );
  assert.equal(queries, 2, 'must not hide the persistence error behind markDispatchUnknown');
});

test('Modal adapter exposes pending, failed, unavailable, and completed distinctly', async () => {
  const outcomes = new Map([
    ['pending', new FunctionTimeoutError('not ready')],
    ['failed', new RemoteError('python failed')],
    ['unavailable', new Error('network')],
    ['completed', { value: 1 }],
  ]);
  const client = {
    cls: { fromName: async () => { throw new Error('unused'); } },
    functionCalls: {
      fromId: async (id) => ({
        get: async () => {
          const value = outcomes.get(id);
          if (value instanceof Error) throw value;
          return value;
        },
      }),
    },
  };
  const calls = createModalCalls({ client, appName: 'app' });
  assert.deepEqual(await calls.inspect('pending'), { kind: 'pending' });
  assert.equal((await calls.inspect('failed')).kind, 'failed');
  assert.equal((await calls.inspect('unavailable')).kind, 'unavailable');
  assert.deepEqual(await calls.inspect('completed'), { kind: 'completed', output: { value: 1 } });
});

test('R2 adapter lists deterministically and bounds the downloaded body', async () => {
  const sent = [];
  const client = {
    async send(command) {
      sent.push(command.constructor.name);
      if (command.constructor.name === 'ListObjectsV2Command') {
        return { Contents: [
          { Key: `results/j/a/${'b'.repeat(32)}.json`, LastModified: new Date('2026-08-20') },
          { Key: `results/j/a/${'a'.repeat(32)}.compact.json`, LastModified: new Date('2026-08-20') },
          { Key: `results/j/a/${'a'.repeat(32)}.json`, LastModified: new Date('2026-08-20') },
        ] };
      }
      return {
        ContentLength: 3,
        LastModified: new Date('2026-08-20'),
        Body: (async function* body() { yield Buffer.from('abc'); }()),
      };
    },
  };
  const store = createR2ResultStore({ client, bucket: 'results' });
  assert.deepEqual(
    (await store.listAttemptResults({ jobId: 'j', attemptId: 'a' })).map((x) => x.key),
    [`results/j/a/${'a'.repeat(32)}.json`, `results/j/a/${'b'.repeat(32)}.json`],
  );
  assert.equal(Buffer.from((await store.readResult({ key: 'x' })).bytes).toString(), 'abc');
  assert.deepEqual(sent, ['ListObjectsV2Command', 'GetObjectCommand']);
});

test('R2 configuration refuses plaintext endpoints', () => {
  assert.throws(
    () => r2ClientFromConfig({
      endpoint: 'http://example.test', accessKeyId: 'id', secretAccessKey: 'secret',
    }),
    /must use https/,
  );
});

test('R2 upload grants stay on the origin permitted by dashboard CSP', async () => {
  const endpoint = 'https://account.r2.cloudflarestorage.com';
  const store = createInputObjectStore({
    client: s3ClientFromConfig({
      endpoint, accessKeyId: 'input-key', secretAccessKey: 'input-secret',
    }),
    bucket: 'pagespatial-inputs',
    uploadOrigin: new URL(endpoint).origin,
  });
  const grant = await store.createUploadGrant({
    jobId: '00000000-0000-4000-8000-000000000001',
    now: new Date('2026-08-27T00:00:00Z'),
    expiresAt: new Date('2026-08-27T00:10:00Z'),
  });

  assert.equal(new URL(grant.url).origin, store.uploadOrigin);
  assert.equal(
    new URL(grant.url).pathname,
    '/pagespatial-inputs/inputs/00000000-0000-4000-8000-000000000001.pdf',
  );
});

test('API runtime refuses collapsed R2 bucket or credential boundaries', () => {
  const separated = {
    inputBucket: 'inputs', resultsBucket: 'results',
    inputAccessKeyId: 'input-key', resultsAccessKeyId: 'results-key',
  };
  assert.doesNotThrow(() => validateR2Isolation(separated));
  assert.throws(
    () => validateR2Isolation({ ...separated, resultsBucket: 'inputs' }),
    /buckets must be distinct/u,
  );
  assert.throws(
    () => validateR2Isolation({ ...separated, resultsAccessKeyId: 'input-key' }),
    /credentials must be distinct/u,
  );
});

test('R2 adapter types transport TypeErrors as unavailable, not invalid bytes', async () => {
  const store = createR2ResultStore({
    bucket: 'results',
    client: { send: async () => { throw new TypeError('fetch failed'); } },
  });
  await assert.rejects(
    store.listAttemptResults({ jobId: 'j', attemptId: 'a' }),
    ResultStoreUnavailableError,
  );
  await assert.rejects(
    store.readResult({ key: 'results/j/a/x.json' }),
    ResultStoreUnavailableError,
  );
});

test('R2 read deadlines preserve a permanently invalid result classification', async () => {
  const store = createR2ResultStore({
    bucket: 'results',
    client: {
      async send() {
        return {
          ContentLength: RESULT_LIMIT_BYTES + 1,
          Body: (async function* body() {})(),
        };
      },
    },
  });
  await assert.rejects(
    store.readResult({ key: 'results/j/a/x.json' }),
    InvalidResultError,
  );
});
