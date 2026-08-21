import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 1x1 PNG — enough for the generators' IHDR sniff and base64 embedding.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

// Sentinels that must NEVER appear in a double-label page: they exist only
// in annotator 1's verdict file. If either leaks into the generated output,
// the second sitting is contaminated and the agreement number is theatre.
const SENTINEL_EDIT = 'SENTINEL-A1-EDITED-7391';
const SENTINEL_MISSED = 'SENTINEL-A1-MISSED-4817';

function goldFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gold-batch6-'));
  const batchDir = join(dir, 'gold', 'fixture-batch');
  mkdirSync(join(batchDir, 'images'), { recursive: true });
  const imagePath = join(batchDir, 'images', 'page.png');
  writeFileSync(imagePath, PNG);
  const page = (pageNumber, tokens) => ({
    goldProposalSchemaVersion: 'gold-proposal-v1',
    objectId: 'fixture-doc', sha256: 'f'.repeat(64), pageNumber,
    labels: ['native-text'], escalatedInRun: pageNumber === 1,
    image: imagePath, mediaResolution: 'MEDIA_RESOLUTION_HIGH',
    proposal: { criticalTokens: tokens, chartRelations: [], hasTable: false, notes: '' },
    conflictAdjudications: [],
    provenance: { model: 'fixture', createdAt: '2026-08-21T00:00:00.000Z', runRoot: join(dir, 'no-such-run') }
  });
  writeFileSync(join(batchDir, 'proposals.json'), JSON.stringify([
    page(1, [
      { text: '1,234', box_2d: [100, 100, 120, 200] },
      { text: '5,678', box_2d: [200, 100, 220, 200] },
      { text: '9,012', box_2d: [300, 100, 320, 200] }
    ]),
    page(2, [
      { text: '42', box_2d: [100, 100, 120, 200] },
      { text: '77', box_2d: [200, 100, 220, 200] }
    ])
  ], null, 1));
  // Annotator 1's verdicts: an edit with a sentinel text, a wrong, autos.
  writeFileSync(join(batchDir, 'gold-verdicts.json'), JSON.stringify({
    goldVerdictsSchemaVersion: 'gold-verdicts-v1', verifiedAt: '2026-08-21T00:00:00.000Z',
    pages: [
      { objectId: 'fixture-doc', sha256: 'f'.repeat(64), pageNumber: 1,
        tokens: [
          { index: 0, verdict: 'correct', text: '1,234' },
          { index: 1, verdict: 'edited', text: SENTINEL_EDIT },
          { index: 2, verdict: 'auto', text: '9,012' }
        ],
        missedTokens: [SENTINEL_MISSED], charts: [], missedCharts: [], conflicts: [] },
      { objectId: 'fixture-doc', sha256: 'f'.repeat(64), pageNumber: 2,
        tokens: [
          { index: 0, verdict: 'auto', text: '42' },
          { index: 1, verdict: 'wrong', text: '77' }
        ],
        missedTokens: [], charts: [], missedCharts: [], conflicts: [] }
    ]
  }, null, 1));
  // The original sitting's review page, used only to detect whether
  // corroboration was on. Contains an auto radio, so it was.
  writeFileSync(join(batchDir, 'review.html'), '<input type="radio" value="auto">');
  return { dir, goldRoot: join(dir, 'gold') };
}

test('double-label pages never contain annotator-1 verdicts', () => {
  const fixture = goldFixture();
  try {
    const outputDir = join(fixture.dir, 'doublelabel');
    execFileSync(process.execPath, [
      join(root, 'scripts/evaluation/build-gold-doublelabel.mjs'),
      '--gold-root', fixture.goldRoot,
      '--batches', 'fixture-batch',
      '--output-dir', outputDir,
      '--per-batch', '2', '--seed', '1'
    ], { encoding: 'utf8' });
    const selection = JSON.parse(readFileSync(join(outputDir, 'selection.json'), 'utf8'));
    assert.equal(selection.pagesSelected, 2);
    for (const group of selection.groups) {
      for (const file of [group.review, group.proposals]) {
        const content = readFileSync(join(outputDir, file), 'utf8');
        assert.ok(!content.includes(SENTINEL_EDIT), `${file} leaks annotator-1 edited text`);
        assert.ok(!content.includes(SENTINEL_MISSED), `${file} leaks annotator-1 missed tokens`);
        // The review page legitimately CONTAINS the literal string
        // 'goldVerdictsSchemaVersion' — its export button writes that schema.
        // Only the proposals subset must be verdict-schema-free.
        if (file === group.proposals) {
          assert.ok(!content.includes('goldVerdictsSchemaVersion'), `${file} embeds a verdicts file`);
        }
        // 'wrong' as a RADIO VALUE is part of the blank review UI; what must
        // not leak is which row annotator 1 marked wrong — i.e. any checked
        // non-default state. The only pre-checked radios a review page may
        // carry are machine-derived: auto (corroboration) and noise.
        for (const match of content.matchAll(/value="(\w+)"[^>]*\schecked|checked[^>]*\svalue="(\w+)"/gu)) {
          const value = match[1] ?? match[2];
          assert.ok(['auto', 'noise'].includes(value), `${file} pre-checks a human verdict: ${value}`);
        }
      }
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('silver spot-check samples only silver rows, deterministically per seed', () => {
  const fixture = goldFixture();
  try {
    const goldDirArg = join(fixture.goldRoot, 'fixture-batch');
    const run = (outputName, seed) => {
      const output = join(fixture.dir, outputName);
      execFileSync(process.execPath, [
        join(root, 'scripts/evaluation/build-gold-spotcheck.mjs'),
        '--gold-dir', goldDirArg,
        '--tier', 'silver',
        '--size', '10', '--seed', String(seed),
        '--output', output
      ], { encoding: 'utf8' });
      return readFileSync(output, 'utf8');
    };
    const first = run('silver-a.html', 3);
    const second = run('silver-b.html', 3);
    assert.equal(first, second, 'same seed must regenerate the identical page');
    const sample = JSON.parse(/const SAMPLE = (\[.*?\]);\n/su.exec(first)[1]);
    assert.equal(sample.length, 2, 'fixture has exactly two silver rows');
    for (const row of sample) {
      assert.equal(row.verdict, 'auto', 'silver sample must contain only auto rows');
      assert.equal(row.tier, 'silver');
      assert.equal(row.batch, 'fixture-batch');
    }
    // Human-tier rows must NOT bleed in: the wrong row and the edited row
    // are human judgements, and the sentinel only exists in verdicts.
    assert.ok(!first.includes(SENTINEL_EDIT));
    const differentSeed = run('silver-c.html', 4);
    assert.notEqual(first, differentSeed, 'a different seed must draw a different presentation order');
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
