import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPublicResultArtifacts } from '../service/lib/public-result.mjs';
import { createValidDocument } from './fixture.mjs';

const identity = {
  jobId: '00000000-0000-4000-8000-000000000001',
  attemptId: '00000000-0000-4000-8000-000000000002',
  inputSha256: 'f'.repeat(64),
};

test('Node emits closed evidence and deterministic compact bytes', async () => {
  const page = (await createValidDocument()).pages[0];
  const pages = [{ pageNumber: 1, ok: true, pageSpatial: page }];
  const one = buildPublicResultArtifacts({
    ...identity, executionId: '1'.repeat(32), pages,
  });
  const changedVolatileProvenance = structuredClone(pages);
  changedVolatileProvenance[0].pageSpatial.provenance.runId = 'another-run';
  changedVolatileProvenance[0].pageSpatial.provenance.createdAt = '2099-01-01T00:00:00.000Z';
  const two = buildPublicResultArtifacts({
    ...identity, executionId: '2'.repeat(32), pages: changedVolatileProvenance,
  });

  assert.notDeepEqual(one.evidenceBytes, two.evidenceBytes);
  assert.deepEqual(one.compactBytes, two.compactBytes);

  const evidence = JSON.parse(one.evidenceBytes);
  assert.deepEqual(Object.keys(evidence), [
    'schema_version', 'job_id', 'attempt_id', 'execution_id',
    'input_sha256', 'page_count', 'pages',
  ]);
  assert.equal(evidence.pages[0].page_spatial.schemaVersion, '0.6.0');

  const compact = JSON.parse(one.compactBytes);
  assert.deepEqual(Object.keys(compact), [
    'schema_version', 'representation', 'job_id', 'attempt_id',
    'input_sha256', 'page_count', 'pages',
  ]);
  assert.equal(Object.hasOwn(compact, 'execution_id'), false);
  assert.deepEqual(Object.keys(compact.pages[0]), ['page_number', 'ok', 'page_compact']);
  assert.equal(Object.hasOwn(compact.pages[0].page_compact, 'nativeObservations'), false);
});

test('Node emits the same safe failed-page shape in both representations', async () => {
  const artifacts = buildPublicResultArtifacts({
    ...identity,
    executionId: '3'.repeat(32),
    pages: [{ pageNumber: 1, ok: false, failure: { message: 'private failure' } }],
  });
  const evidence = JSON.parse(artifacts.evidenceBytes);
  const compact = JSON.parse(artifacts.compactBytes);
  const safe = { code: 'page_failed', message: 'Page could not be parsed.' };
  assert.deepEqual(evidence.pages[0].failure, safe);
  assert.deepEqual(compact.pages[0].failure, safe);
});
