import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModalCalls } from '../src/modal-calls.mjs';
import {
  createInputObjectStore, ObjectStoreUnavailableError,
} from '../src/object-stores.mjs';
import {
  createR2ResultStore, ResultStoreUnavailableError,
} from '../src/r2-results.mjs';

const never = () => new Promise(() => {});

test('Modal spawn has a real deadline when lookup never settles', async () => {
  const calls = createModalCalls({
    client: {
      cls: { fromName: never },
      functionCalls: { fromId: never },
    },
    appName: 'test-app',
    spawnTimeoutMs: 10,
  });
  await assert.rejects(calls.spawn({}), /Modal spawn exceeded 10 ms/u);
});

test('R2 input inspection has a real deadline when the SDK ignores abort', async () => {
  const store = createInputObjectStore({
    client: { send: never },
    bucket: 'inputs',
    operationTimeoutMs: 10,
  });
  await assert.rejects(store.head({ jobId: 'job' }), (error) =>
    error instanceof ObjectStoreUnavailableError
      && /R2 input head exceeded 10 ms/u.test(error.cause?.message));
});

test('R2 result listing has a real deadline when the SDK ignores abort', async () => {
  const store = createR2ResultStore({
    client: { send: never },
    bucket: 'results',
    operationTimeoutMs: 10,
  });
  await assert.rejects(store.listAttemptResults({ jobId: 'job', attemptId: 'attempt' }),
    (error) => error instanceof ResultStoreUnavailableError
      && /R2 result list exceeded 10 ms/u.test(error.cause?.message));
});

test('R2 result reading cancels a body that stalls after GetObject returns', async () => {
  let destroyed = false;
  const body = {
    [Symbol.asyncIterator]() {
      return { next: never };
    },
    destroy() { destroyed = true; },
  };
  const store = createR2ResultStore({
    client: {
      async send() {
        return { Body: body, ContentLength: 3, LastModified: new Date() };
      },
    },
    bucket: 'results',
    operationTimeoutMs: 10,
  });
  const guard = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('test guard: body read did not stop')), 100);
  });
  await assert.rejects(
    Promise.race([store.readResult({ key: 'results/j/a/x.json' }), guard]),
    (error) => error instanceof ResultStoreUnavailableError
      && /R2 result read exceeded 10 ms/u.test(error.cause?.message),
  );
  assert.equal(destroyed, true);
});
