import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { getDevelopmentDocuments, loadCorpusManifest, validateCorpusManifest } from '../scripts/evaluation/lib/manifest.mjs';
import {
  materializeDevelopmentCorpus,
  parseMaterializerArguments,
  resolveMaterializedPath,
  sha256File
} from '../scripts/evaluation/materialize.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

async function fixtureManifest() {
  const { manifest } = await loadCorpusManifest();
  const copy = structuredClone(manifest);
  const contents = new Map();
  for (const document of copy.documents) {
    const content = Buffer.from(`%PDF-fixture\n${document.objectId}\n`);
    contents.set(document.objectId, content);
    document.sha256 = digest(content);
  }
  validateCorpusManifest(copy);
  return { manifest: copy, contents };
}

async function withTemporaryRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'pagespatial-materializer-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('dry-run lists exactly 23 development paths without authentication or filesystem writes', async () => {
  const { manifest } = await loadCorpusManifest();
  await withTemporaryRoot(async (root) => {
    let commandCalls = 0;
    const result = await materializeDevelopmentCorpus({
      manifest,
      dataRoot: join(root, 'absent'),
      dryRun: true,
      commandRunner: async () => { commandCalls += 1; return { code: 0 }; }
    });
    const developmentPaths = getDevelopmentDocuments(manifest).map(({ path }) => path);
    const holdoutPaths = new Set(manifest.documents.filter(({ split }) => split === 'holdout').map(({ path }) => path));
    assert.deepEqual(result, { dryRun: true, paths: developmentPaths });
    assert.equal(result.paths.length, 23);
    assert.equal(result.paths.some((path) => holdoutPaths.has(path)), false);
    assert.equal(commandCalls, 0);
    await assert.rejects(readdir(join(root, 'absent')), { code: 'ENOENT' });
  });
});

test('missing authentication fails before a download or final PDF is created', async () => {
  const { manifest } = await fixtureManifest();
  await withTemporaryRoot(async (root) => {
    const calls = [];
    await assert.rejects(materializeDevelopmentCorpus({
      manifest,
      dataRoot: root,
      commandRunner: async (command, args) => {
        calls.push([command, args]);
        return { code: 1, stderr: 'sensitive output must not enter the error' };
      }
    }), /^Error: Hugging Face authentication check failed\.$/u);
    assert.deepEqual(calls, [['hf', ['auth', 'whoami']]]);
    assert.deepEqual(await readdir(root), ['corpus']);
  });
});

test('hash mismatch removes the temporary download and never promotes a final PDF', async () => {
  const { manifest } = await fixtureManifest();
  const first = getDevelopmentDocuments(manifest)[0];
  await withTemporaryRoot(async (root) => {
    const commandRunner = async (_command, args) => {
      if (args[0] === 'auth') return { code: 0 };
      const remotePath = args[2];
      const localRoot = args[args.indexOf('--local-dir') + 1];
      const target = join(localRoot, ...remotePath.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, '%PDF-wrong bytes');
      return { code: 0 };
    };
    await assert.rejects(
      materializeDevelopmentCorpus({ manifest, dataRoot: root, commandRunner }),
      /Downloaded PDF has SHA-256/u
    );
    const finalPath = resolveMaterializedPath(root, first);
    await assert.rejects(readFile(finalPath), { code: 'ENOENT' });
    const siblingNames = await readdir(dirname(finalPath));
    assert.equal(siblingNames.some((name) => name.includes('.download-')), false);
  });
});

test('downloads exact development paths at the pinned revision and atomically promotes them', async () => {
  const { manifest, contents } = await fixtureManifest();
  const documents = getDevelopmentDocuments(manifest);
  await withTemporaryRoot(async (root) => {
    const calls = [];
    const commandRunner = async (command, args) => {
      calls.push([command, args]);
      if (args[0] === 'auth') return { code: 0 };
      const object = documents.find(({ path }) => path === args[2]);
      assert.ok(object, `unexpected non-development path ${args[2]}`);
      const localRoot = args[args.indexOf('--local-dir') + 1];
      const target = join(localRoot, ...object.path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents.get(object.objectId));
      return { code: 0 };
    };
    const report = await materializeDevelopmentCorpus({
      manifest,
      dataRoot: root,
      commandRunner,
      now: () => new Date('2026-08-19T12:00:00.000Z')
    });
    assert.equal(calls.length, 24);
    assert.deepEqual(calls[0], ['hf', ['auth', 'whoami']]);
    for (const [index, document] of documents.entries()) {
      const args = calls[index + 1][1];
      assert.deepEqual(args.slice(0, 7), [
        'download', manifest.dataset.repoId, document.path,
        '--repo-type', 'dataset', '--revision', manifest.dataset.revision
      ]);
      assert.equal(args[7], '--local-dir');
      assert.equal(await sha256File(resolveMaterializedPath(root, document)), document.sha256);
    }
    assert.equal(report.documents.length, 23);
    assert.equal(report.documents.every(({ status }) => status === 'downloaded'), true);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'materialization.json'), 'utf8')), report);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, 'materialization.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(resolveMaterializedPath(root, documents[0]))).mode & 0o777, 0o600);
  });
});

test('materialization rejects a symlinked corpus parent without writing outside the data root', async () => {
  const { manifest } = await fixtureManifest();
  const first = getDevelopmentDocuments(manifest)[0];
  await withTemporaryRoot(async (root) => {
    const outside = join(root, 'outside');
    const dataRoot = join(root, 'private');
    await mkdir(outside);
    await mkdir(join(dataRoot, 'corpus'), { recursive: true });
    const firstComponent = first.path.split('/')[0];
    await symlink(outside, join(dataRoot, 'corpus', firstComponent));
    let calls = 0;
    await assert.rejects(materializeDevelopmentCorpus({
      manifest,
      dataRoot,
      commandRunner: async () => { calls += 1; return { code: 0 }; }
    }), /Symlinked evaluation paths are not allowed/u);
    assert.equal(calls, 0);
    assert.deepEqual(await readdir(outside), []);
  });
});

test('valid existing PDFs are reused; an invalid existing PDF fails closed before auth', async () => {
  const { manifest, contents } = await fixtureManifest();
  const documents = getDevelopmentDocuments(manifest);
  await withTemporaryRoot(async (root) => {
    for (const document of documents) {
      const target = resolveMaterializedPath(root, document);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents.get(document.objectId));
    }
    let calls = 0;
    const report = await materializeDevelopmentCorpus({
      manifest,
      dataRoot: root,
      commandRunner: async () => { calls += 1; return { code: 0 }; }
    });
    assert.equal(calls, 0);
    assert.equal(report.documents.every(({ status }) => status === 'reused'), true);
  });
  await withTemporaryRoot(async (root) => {
    const first = documents[0];
    const target = resolveMaterializedPath(root, first);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, 'corrupt');
    let calls = 0;
    await assert.rejects(materializeDevelopmentCorpus({
      manifest,
      dataRoot: root,
      commandRunner: async () => { calls += 1; return { code: 0 }; }
    }), /Existing PDF has SHA-256/u);
    assert.equal(calls, 0);
    assert.equal(await readFile(target, 'utf8'), 'corrupt');
  });
});

test('CLI exposes only data-root and dry-run controls', () => {
  assert.deepEqual(parseMaterializerArguments(['--data-root', './private-eval', '--dry-run']), {
    dataRoot: join(process.cwd(), 'private-eval'),
    dryRun: true
  });
  assert.throws(() => parseMaterializerArguments(['--split', 'holdout']), /Unknown materializer argument/u);
  assert.throws(() => parseMaterializerArguments(['--holdout']), /Unknown materializer argument/u);
});
