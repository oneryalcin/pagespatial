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

/**
 * A page the pipeline declares fine, with CONTROLLABLE extractor-visible
 * properties. The independence test's teeth come from varying every one of
 * these between paired run roots:
 *   numeric  — whether observations carry figures (criticalCount 0 vs high)
 *   obsCount — how many observations the engines produced
 *   ocrOnly  — extra prose-only OCR observations with no native partner,
 *              lowering nativeOcrAssociationCoverage (kept below the
 *              starvation thresholds so the page stays clean)
 */
function cleanPage(objectId, pageNumber, { numeric = false, obsCount = 3, ocrOnly = 0 } = {}) {
  const texts = Array.from({ length: obsCount }, (_, i) =>
    numeric ? `Revenue ${647 + i}` : `plain prose line ${'x'.repeat(i + 1)}`);
  const nativeObservations = texts.map((text, i) => ({ pageNumber, text, box: [20, 20 + i * 30, 200, 40 + i * 30] }));
  const ocrObservations = texts.map((text, i) => ({ pageNumber, text, box: [20, 20 + i * 30, 200, 40 + i * 30], confidence: 0.99 }));
  for (let j = 0; j < ocrOnly; j += 1) {
    // Prose-only (no digits): an unpartnered numeric OCR reading would raise
    // an omission conflict and escalate the page out of the population.
    ocrObservations.push({ pageNumber, text: `stray prose mark ${'y'.repeat(j + 1)}`, box: [320, 20 + j * 30, 480, 40 + j * 30], confidence: 0.9 });
  }
  const page = buildPageSpatial({
    document: { documentId: objectId, revisionId: `sha256:${SHA}`, sha256: SHA, pageCount: pageNumber },
    pageNumber,
    geometry: { width: 612, height: 792, pointWidth: 612, pointHeight: 792 },
    nativeObservations,
    ocrObservations,
    provenance: { parserName: 'fixture', parserVersion: '1', runId: 'fixture-run', createdAt: new Date().toISOString() }
  });
  assert.equal(page.diagnostics.requiresEscalation, false,
    `fixture ${objectId} p${pageNumber} must be clean or the test premise is broken`);
  return page;
}

/**
 * Documents with per-page property specs. Between paired run roots the specs
 * are PERMUTED across pages — observation counts, coverage, and figure
 * density all move — and the independence property demands the selection not
 * move with them. (The previous fixture varied only which docs carried
 * figures, so conditioning on obsCount/coverage/diagnostics passed it — the
 * review that caught this demonstrated reintroducing coverage-sorted fill
 * survived the old test.)
 */
function fixture(specsByDoc, { pagesPerDoc = 1, familyOf = (d) => `family-${d}` } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'clean-sampler-'));
  const runRoot = join(dir, 'run');
  const documents = [];
  for (let d = 0; d < specsByDoc.length; d += 1) {
    const objectId = `doc-${d}`;
    const pagesDir = join(runRoot, 'documents', objectId, 'pages');
    mkdirSync(pagesDir, { recursive: true });
    const pages = [];
    for (let p = 1; p <= pagesPerDoc; p += 1) {
      const spec = Array.isArray(specsByDoc[d]) ? specsByDoc[d][p - 1] : specsByDoc[d];
      const page = cleanPage(objectId, p, spec);
      writeFileSync(join(pagesDir, `${String(p).padStart(6, '0')}.json`), JSON.stringify({ pageSpatial: page, objectId, pageNumber: p }));
      pages.push({ pageNumber: p });
    }
    documents.push({ objectId, path: `docs/${objectId}.pdf`, sha256: SHA, familyId: familyOf(d), split: 'development', pages });
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

// Two property profiles far apart on every extractor-visible axis.
const RICH = { numeric: true, obsCount: 7, ocrOnly: 0 };  // dense figures, full coverage
const POOR = { numeric: false, obsCount: 2, ocrOnly: 3 }; // prose, sparse, low coverage

test('clean-profile selection is extractor-blind: permuting extractor output changes nothing', () => {
  // Same eight documents; between the two run roots figure density,
  // observation counts, AND coverage all swap docs. Under the independence
  // check that must not move the selection by a single page.
  const a = fixture([RICH, RICH, RICH, RICH, POOR, POOR, POOR, POOR]);
  const b = fixture([POOR, POOR, POOR, POOR, RICH, RICH, RICH, RICH]);
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

test('the FILL pass is extractor-blind too: caps engage it and permuted diagnostics change nothing', () => {
  // Two documents (two families) of four clean pages each, so the tier pass
  // caps out at MAX_PER_DOCUMENT=2 per doc (4 picks) and the remaining 2 of
  // size 6 must come through the relaxed-cap fill pass. Page properties are
  // permuted between the roots; a fill ordered by anything extractor-derived
  // (the pre-review coverage sort, observation counts, criticalCount) picks
  // different pages in A and B and fails here.
  const a = fixture([[RICH, POOR, RICH, POOR], [POOR, RICH, POOR, RICH]], { pagesPerDoc: 4 });
  const b = fixture([[POOR, RICH, POOR, RICH], [RICH, POOR, RICH, POOR]], { pagesPerDoc: 4 });
  try {
    const pickedA = selectClean(a, 'seed-y', 6);
    const pickedB = selectClean(b, 'seed-y', 6);
    assert.equal(pickedA.length, 6, 'six pages selected: four via the tier pass, two via fill');
    assert.deepEqual(pickedA, pickedB,
      'fill-pass selection depended on extractor output — the coverage-sorted fill is back');
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test('clean-profile dry run prints no extractor stats (seed-shopping channel)', () => {
  const fx = fixture([RICH, POOR]);
  try {
    const stdout = execFileSync(process.execPath, [
      SAMPLER, '--manifest', fx.manifestPath, '--run-root', fx.runRoot,
      '--gold-root', join(fx.dir, 'gold'), '--output', join(fx.dir, 'out'),
      '--profile', 'clean', '--seed', 's', '--size', '2', '--dry-run'
    ], { encoding: 'utf8' });
    assert.doesNotMatch(stdout, /coverage=|conflicts=|starved=|pictorial=/u,
      'per-page extractor stats in the clean dry run let an operator re-roll seeds against them');
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('clean profile refuses to run without a seed', () => {
  const fx = fixture([RICH]);
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

function evaluatorFixture({ noMissFoundOnFirst, missedTokensOnFirst = [], missedChartsOnFirst = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'nomiss-eval-'));
  const runRoot = join(dir, 'run');
  const goldDir = join(dir, 'gold');
  mkdirSync(goldDir, { recursive: true });
  const proposals = [];
  const verdictPages = [];
  for (const [index, objectId] of ['doc-a', 'doc-b'].entries()) {
    const page = cleanPage(objectId, 1, { numeric: true, obsCount: 1 });
    const pagesDir = join(runRoot, 'documents', objectId, 'pages');
    mkdirSync(pagesDir, { recursive: true });
    writeFileSync(join(pagesDir, '000001.json'), JSON.stringify({ pageSpatial: page, objectId, pageNumber: 1 }));
    proposals.push({ objectId, sha256: SHA, pageNumber: 1, proposal: { criticalTokens: [{ text: 'Revenue 647' }], notes: '' } });
    verdictPages.push({
      objectId, sha256: SHA, pageNumber: 1,
      tokens: [{ index: 0, verdict: 'correct', text: 'Revenue 647' }],
      missedTokens: index === 0 ? missedTokensOnFirst : [],
      charts: [], missedCharts: index === 0 ? missedChartsOnFirst : [], conflicts: [],
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

test('noMissFound alongside hand-entered missed CHARTS fails closed too', () => {
  const fx = evaluatorFixture({
    noMissFoundOnFirst: true,
    missedChartsOnFirst: [{ category: '2024', value: '999', unit: null }]
  });
  try {
    assert.throws(() => runEvaluator(fx), /contradiction/u,
      'a missed chart value is a hand-entered miss; it must not coexist with a no-miss claim');
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('a missed chart value neither engine read counts as a computed miss', () => {
  // Before the review fix, missedCharts fed only relation accounting: a
  // clean page whose reviewer hand-entered a chart figure both engines
  // missed still counted as verified-no-miss material.
  const fx = evaluatorFixture({ missedChartsOnFirst: [{ category: '2024', value: '31,415', unit: null }] });
  try {
    const metrics = runEvaluator(fx);
    assert.equal(metrics.escalation.cleanWithHumanGoldMissedByBoth, 1,
      'the chart value 31,415 is absent from both pools — that is a miss');
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
    assert.match(html, /id="nomiss-0" disabled/u,
      'the no-miss checkbox starts locked — machine boxes anchor the eyes, so the claim requires a boxes-hidden look first');
    assert.match(html, /id="hideboxes-0"/u, 'the hide-boxes toggle that unlocks it is rendered');
    assert.match(html, /function toggleBoxes/u, 'and wired');
    assert.match(html, /noMissFound/u, 'export includes the verdict field');
    assert.match(html, /gold-verdicts-v2/u, 'schema version bumped with the new field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
