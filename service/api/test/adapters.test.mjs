import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FunctionTimeoutError, RemoteError } from 'modal';
import { createModalCalls } from '../src/modal-calls.mjs';
import { createR2ResultStore, r2ClientFromConfig } from '../src/r2-results.mjs';

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
          { Key: 'results/j/a/b.json', LastModified: new Date('2026-08-20') },
          { Key: 'results/j/a/a.json', LastModified: new Date('2026-08-20') },
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
    ['results/j/a/a.json', 'results/j/a/b.json'],
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
