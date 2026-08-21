import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPageSpatial } from '../dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLER = join(root, 'scripts/evaluation/build-gold-sample.mjs');
const EVALUATOR = join(root, 'scripts/evaluation/evaluate-gold-pilot.mjs');
const REVIEW = join(root, 'scripts/evaluation/build-gold-review.mjs');

// Smallest valid PNG (1x1 transparent) for review-UI fixtures.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64');

const SHA = 'a'.repeat(64);

function cleanPage(objectId, pageNumber, observationTexts) {
  const page = buildPageSpatial({
    document: { documentId: objectId, revisionId: `sha256:${SHA}`, sha256: SHA, pageCount: pageNumber },
    pageNumber,
    geometry: { width: 612, height: 792, pointWidth: 612, pointHeight: 792 },
    // Native and OCR agree exactly: no conflicts, full coverage, no
    // starvation — a page the pipeline declares fine.
    nativeObservations: observationTexts.map((text, i) => ({ pageNumber, text, box: [20, 20 + i * 30, 200, 40 + i * 30] })),
    ocrObservations: observationTexts.map((text, i) => ({ pageNumber, text, box: [20, 20 + i * 30, 200, 40 + i * 30], confidence: 0.99 })),
    provenance: { parserName: 'fixture', parserVersion: '1', runId: 'fixture-run', createdAt: new Date().toISOString() }
  });
  assert.equal(page.diagnostics.requiresEscalation, false,
    `fixture ${objectId} p${pageNumber} must be clean or the test premise is broken`);
  return page;
}

/**
 * Eight one-page documents in distinct families. `numericDocs` get a page
 * dense with figures (high criticalCount); the rest get prose only
 * (criticalCount 0 — the class the old eligibility test excluded by
 * construction).
 */
function fixture(numericDocs) {
  const dir = mkdtempSync(join(tmpdir(), 'clean-sampler-'));
  const runRoot = join(dir, 'run');
  const documents = [];
  for (let d = 0; d < 8; d += 1) {
    const objectId = `doc-${d}`;
    const texts = numericDocs.has(d)
      ? ['Revenue 647', 'Cost 123', 'Margin 88']
      : ['plain prose heading', 'no figures anywhere', 'closing remarks'];
    const page = cleanPage(objectId, 1, texts);
    const pagesDir = join(runRoot, 'documents', objectId, 'pages');
    mkdirSync(pagesDir, { recursive: true });
    writeFileSync(join(pagesDir, '000001.json'), JSON.stringify({ pageSpatial: page, objectId, pageNumber: 1 }));
    documents.push({ objectId, path: `docs/${objectId}.pdf`, sha256: SHA, familyId: `family-${d}`, split: 'development', pages: [{ pageNumber: 1 }] });
  }
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ documents }));
  return { dir, runRoot, manifestPath };
}

function selectClean(fx, seed, size) {
  const stdout = execFileSync(process.execPath, [
    SAMPLER,
    '--manifest', fx.manifestPath,
    '--run-root', fx.runRoot,
    '--gold-root', join(fx.dir, 'gold'),
    '--output', join(fx.dir, 'out'),
    '--profile', 'clean',
    '--seed', seed,
    '--size', String(size),
    '--dry-run'
  ], { encoding: 'utf8' });
  return stdout.split('\n')
    .map((line) => /^\s+(?:clean|fill)\s+(\S+) p(\d+)/.exec(line))
    .filter(Boolean)
    .map((match) => `${match[1]}#${match[2]}`)
    .sort();
}

test('clean-profile selection is extractor-blind: permuting extractor output changes nothing', () => {
  // Same eight documents; the only difference between the two run roots is
  // WHICH pages carry figures. Under the independence check that must not
  // move the selection by a single page.
  const a = fixture(new Set([0, 1, 2, 3]));
  const b = fixture(new Set([4, 5, 6, 7]));
  try {
    const pickedA = selectClean(a, 'seed-x', 4);
    const pickedB = selectClean(b, 'seed-x', 4);
    assert.equal(pickedA.length, 4);
    assert.deepEqual(pickedA, pickedB,
      'selection depended on extractor output — the circular-sampler defect is back');
    // Determinism: the same seed reproduces the batch exactly.
    assert.deepEqual(selectClean(a, 'seed-x', 4), pickedA);
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test('clean profile refuses to run without a seed', () => {
  const fx = fixture(new Set([0]));
  try {
    assert.throws(() => execFileSync(process.execPath, [
      SAMPLER, '--manifest', fx.manifestPath, '--run-root', fx.runRoot,
      '--gold-root', join(fx.dir, 'gold'), '--output', join(fx.dir, 'out'),
      '--profile', 'clean', '--dry-run'
    ], { encoding: 'utf8', stdio: 'pipe' }), /--seed/u);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

function evaluatorFixture({ noMissFoundOnFirst, missedTokensOnFirst = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'nomiss-eval-'));
  const runRoot = join(dir, 'run');
  const goldDir = join(dir, 'gold');
  mkdirSync(goldDir, { recursive: true });
  const proposals = [];
  const verdictPages = [];
  for (const [index, objectId] of ['doc-a', 'doc-b'].entries()) {
    const page = cleanPage(objectId, 1, ['Revenue 647']);
    const pagesDir = join(runRoot, 'documents', objectId, 'pages');
    mkdirSync(pagesDir, { recursive: true });
    writeFileSync(join(pagesDir, '000001.json'), JSON.stringify({ pageSpatial: page, objectId, pageNumber: 1 }));
    proposals.push({ objectId, sha256: SHA, pageNumber: 1, proposal: { criticalTokens: [{ text: 'Revenue 647' }], notes: '' } });
    verdictPages.push({
      objectId, sha256: SHA, pageNumber: 1,
      tokens: [{ index: 0, verdict: 'correct', text: 'Revenue 647' }],
      missedTokens: index === 0 ? missedTokensOnFirst : [],
      charts: [], missedCharts: [], conflicts: [],
      ...(index === 0 && noMissFoundOnFirst ? { noMissFound: true } : {})
    });
  }
  writeFileSync(join(goldDir, 'proposals.json'), JSON.stringify(proposals));
  writeFileSync(join(goldDir, 'gold-verdicts.json'), JSON.stringify({
    goldVerdictsSchemaVersion: 'gold-verdicts-v2', verifiedAt: new Date().toISOString(), pages: verdictPages
  }));
  return { dir, runRoot, goldDir };
}

function runEvaluator(fx) {
  const output = join(fx.dir, 'metrics.json');
  execFileSync(process.execPath, [EVALUATOR, '--gold-dir', fx.goldDir, '--run-root', fx.runRoot, '--output', output],
    { encoding: 'utf8', stdio: 'pipe' });
  return JSON.parse(readFileSync(output, 'utf8'));
}

test('a recorded no-miss verdict becomes a verified negative; silence stays unverified', () => {
  const fx = evaluatorFixture({ noMissFoundOnFirst: true });
  try {
    const metrics = runEvaluator(fx);
    assert.equal(metrics.escalation.cleanPages, 2);
    assert.equal(metrics.escalation.cleanVerifiedNoMiss, 1, 'the recorded verdict counts');
    assert.equal(metrics.escalation.cleanUnverified, 1, 'the silent page is NOT promoted to a negative');
    assert.equal(metrics.escalation.cleanWithHumanGoldMissedByBoth, 0);
    assert.equal(metrics.perPage.find((p) => p.objectId === 'doc-a').noMissFound, true);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('noMissFound alongside hand-entered missed tokens fails closed', () => {
  const fx = evaluatorFixture({ noMissFoundOnFirst: true, missedTokensOnFirst: ['999'] });
  try {
    assert.throws(() => runEvaluator(fx), /contradiction/u);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('a missed-by-both page with a no-miss verdict is superseded, never a negative', () => {
  // The reviewer adds a missed token on doc-b (no no-miss claim there) so the
  // computed miss lands on a page WITHOUT the verdict; doc-a keeps its claim
  // but its token is engine-read, so it stays a clean verified negative. Then
  // separately: a no-miss page whose CONFIRMED PROPOSAL is engine-missed.
  const fx = evaluatorFixture({ noMissFoundOnFirst: true });
  try {
    // Rewrite doc-a's proposal to a token the engines never read: confirmed
    // by the human, absent from both pools — a computed miss the reviewer's
    // search did not surface.
    const proposals = JSON.parse(readFileSync(join(fx.goldDir, 'proposals.json'), 'utf8'));
    proposals[0].proposal.criticalTokens = [{ text: '31,415' }];
    writeFileSync(join(fx.goldDir, 'proposals.json'), JSON.stringify(proposals));
    const verdicts = JSON.parse(readFileSync(join(fx.goldDir, 'gold-verdicts.json'), 'utf8'));
    verdicts.pages[0].tokens = [{ index: 0, verdict: 'correct', text: '31,415' }];
    writeFileSync(join(fx.goldDir, 'gold-verdicts.json'), JSON.stringify(verdicts));
    const metrics = runEvaluator(fx);
    assert.equal(metrics.escalation.cleanWithHumanGoldMissedByBoth, 1, 'the computed miss wins');
    assert.equal(metrics.escalation.cleanVerifiedNoMiss, 0, 'the superseded claim is not a negative');
    assert.equal(metrics.escalation.noMissVerdictsSupersededByComputedMiss, 1, 'and the disagreement stays visible');
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('the review UI carries the no-miss control and its script still parses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nomiss-review-'));
  try {
    const image = join(dir, 'page.png');
    writeFileSync(image, TINY_PNG);
    const proposalsPath = join(dir, 'proposals.json');
    writeFileSync(proposalsPath, JSON.stringify([{
      objectId: 'doc-a', sha256: SHA, pageNumber: 1, labels: [], image,
      proposal: { criticalTokens: [{ text: 'Revenue 647' }], notes: '' }
    }]));
    const outputPath = join(dir, 'review.html');
    // The generator refuses to write a page whose inline script does not
    // parse, so success here IS the parse assertion.
    execFileSync(process.execPath, [REVIEW, '--proposals', proposalsPath, '--output', outputPath],
      { encoding: 'utf8', stdio: 'pipe' });
    const html = readFileSync(outputPath, 'utf8');
    assert.match(html, /id="nomiss-0"/u, 'per-page no-miss checkbox rendered');
    assert.match(html, /noMissFound/u, 'export includes the verdict field');
    assert.match(html, /gold-verdicts-v2/u, 'schema version bumped with the new field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
