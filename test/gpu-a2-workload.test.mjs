import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  qpdfBuildArgs, sha256File, validateManifest, verifyIdentity
} from '../scripts/evaluation/build-gpu-a2-workload.mjs';

const committed = JSON.parse(readFileSync(new URL('../evaluation/gpu-spike/a2-50page-v1.json', import.meta.url), 'utf8'));

test('committed A2 workload freezes one English 50-page non-holdout slice', () => {
  assert.doesNotThrow(() => validateManifest(committed));
  assert.deepEqual(committed.selection.sourcePages, { first: 1, last: 50, count: 50 });
  assert.equal(committed.selection.holdoutAccessed, false);
  assert.equal(committed.output.pageCount, 50);
});

test('qpdf recipe copies pages losslessly with a deterministic document ID', () => {
  assert.deepEqual(qpdfBuildArgs('/source.pdf', '/output.pdf'), [
    '--warning-exit-0', '--decrypt', '--deterministic-id',
    '--object-streams=preserve', '--stream-data=preserve',
    '--pages', '/source.pdf', '1-50', '--', '/source.pdf', '/output.pdf'
  ]);
});

test('identity verification checks hash, byte count, and page count', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pagespatial-a2-test-'));
  const path = join(directory, 'fixture.pdf');
  try {
    writeFileSync(path, 'fixture');
    const expected = { sha256: sha256File(path), bytes: 7, pageCount: 50 };
    assert.deepEqual(verifyIdentity('fixture', path, expected, () => 50), expected);
    assert.throws(
      () => verifyIdentity('fixture', path, { ...expected, bytes: 8 }, () => 50),
      /fixture bytes 7 != frozen 8/u
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('manifest validation rejects any holdout path or selection claim', () => {
  assert.throws(
    () => validateManifest({ ...committed, source: { ...committed.source, path: '.evaluation/holdout/a.pdf' } }),
    /must not reference holdout/u
  );
  assert.throws(
    () => validateManifest({ ...committed, selection: { ...committed.selection, holdoutAccessed: true } }),
    /must not access holdout/u
  );
});
