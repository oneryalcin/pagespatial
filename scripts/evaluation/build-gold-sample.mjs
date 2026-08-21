/**
 * Builds the next stratified gold batch: the sample file that
 * prelabel-gold-pilot.mjs consumes.
 *
 * Selection is by DEBT LEVERAGE, not by convenience. docs/evaluation-debts.md
 * names which pages retire which claim, and the tiers below mirror it:
 *
 *   starved   rows 1 / 1b — pages that fired `uncorroborated-ocr` (coverage
 *                           starvation). The cross-family corroboration and
 *                           containment-path precision claims rest on 4 pages.
 *   conflict  rows 2 / 4 / 8 — pages carrying critical token conflicts. Gold
 *                           review adjudicates them in the same pass, so a
 *                           conflict page pays twice.
 *   pictorial row 6      — pages holding a pictorial unread-ink region, the
 *                           midtone-threshold question.
 *
 * Diversity caps exist because the pilot learned this the hard way: 14 of its
 * 30 pages were one family (Monotaro EN/JA), so the page count overstated the
 * class coverage. A page cannot be picked twice across batches — every prior
 * batch's sample file is subtracted first.
 *
 * Privacy: renders page PNGs from the private corpus into the output dir.
 * Those images are an input to a remote API downstream; the output dir must
 * stay under the gitignored `.evaluation/` tree.
 *
 * Usage:
 *   node scripts/evaluation/build-gold-sample.mjs \
 *     --manifest evaluation/corpus.v1.json \
 *     --run-root .evaluation/runs/<run-id> \
 *     --corpus-root .evaluation/corpus \
 *     --gold-root .evaluation/gold \
 *     --output .evaluation/gold/<batch-id> \
 *     [--size 15] [--profile debt|clean] [--seed <string>] [--dry-run]
 *
 * --profile clean selects the opposite population for issue #29: pages the
 * pipeline raised no escalation on. Those are the least-labelled class in the
 * corpus precisely because the debt profile avoids them. Escalation precision
 * is measurable from flagged pages; escalation RECALL is only measurable from
 * pages nobody flagged.
 *
 * The clean profile is EXTRACTOR-BLIND (principles §8 independence check):
 * membership is decided by the `requiresEscalation` flag alone — that
 * conditioning is definitional, because escalation recall is a property of
 * pages the system called clean — and selection within the population is
 * seeded-random. Nothing else about the page (observation counts, token
 * counts, coverage, text) may influence eligibility or order, or the sample
 * excludes by construction the total failures it exists to surface. --seed is
 * REQUIRED with --profile clean so reruns are deterministic and the order is
 * provably not hand-picked.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criticalTokens } from '../../dist/text.js';

const RENDER_DPI = 150; // matches run-flash-enrichment.mjs — the resolution the ~$0.01/page precision was measured at.

// Quota shape for a 15-page batch, scaled proportionally by --size. Starved
// pages lead because two claims (rows 1, 1b) rest on the thinnest evidence.
const TIER_SHARE = { starved: 6 / 15, conflict: 5 / 15, pictorial: 3 / 15 };

// --profile clean inverts the selection for issue #29. The default profile
// targets pages the pipeline already flagged, which is why clean pages are the
// least-labelled class in the corpus and why row 9's "2 of 7 clean pages
// silently missed verified tokens" is a flare rather than a rate. Measuring
// escalation RECALL needs a denominator built on purpose: pages the pipeline
// declared fine, sampled without regard to whether they look interesting.
const TIER_SHARE_CLEAN = { clean: 1 };
const MAX_PER_DOCUMENT = 2;
const MAX_PER_FAMILY = 3;
const MAX_PER_DOCUMENT_FILL = 3; // relaxed cap for the residual fill pass

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument ${name}`);
}
const flag = (name) => process.argv.includes(name);

const manifestPath = arg('--manifest', 'evaluation/corpus.v1.json');
const runRoot = arg('--run-root');
const corpusRoot = arg('--corpus-root', '.evaluation/corpus');
const goldRoot = arg('--gold-root', '.evaluation/gold');
const outputDir = arg('--output');
const size = Number(arg('--size', '15'));
const profile = arg('--profile', 'debt');
if (!['debt', 'clean'].includes(profile)) throw new Error("--profile must be 'debt' or 'clean'.");
const seed = arg('--seed', profile === 'clean' ? undefined : 'unused');
const dryRun = flag('--dry-run');
if (!Number.isInteger(size) || size <= 0) throw new Error('--size must be a positive integer.');

const slug = (objectId) => objectId.replace(/[^a-zA-Z0-9._-]+/g, '_');
const pageKey = (objectId, pageNumber) => `${objectId}#${pageNumber}`;

/**
 * Pages already labeled in any prior batch — never sample a page twice.
 * Returns a Map keyed by pageKey, valued with which batch labeled the page:
 * the clean profile needs the provenance, because prior batches were selected
 * BY extractor output, so subtracting them conditions the residual pool on
 * the system under test (see the population-partition note below).
 */
function alreadyLabeled(root) {
  const seen = new Map();
  if (!existsSync(root)) return seen;
  for (const entry of readdirSync(root)) {
    const samplePath = join(root, entry, 'pilot-sample.json');
    if (!existsSync(samplePath)) continue;
    for (const page of JSON.parse(readFileSync(samplePath, 'utf8'))) {
      const key = pageKey(page.objectId, page.pageNumber);
      if (!seen.has(key)) seen.set(key, { batch: entry, objectId: page.objectId, pageNumber: page.pageNumber });
    }
  }
  return seen;
}

function readPageRecord(objectId, pageNumber) {
  const path = join(runRoot, 'documents', slug(objectId), 'pages', `${String(pageNumber).padStart(6, '0')}.json`);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const labeled = alreadyLabeled(goldRoot);

const candidates = [];
// Pages the pipeline produced NO run record for are neither escalated nor
// clean — the most total failure mode there is, and a recall instrument must
// not lose them to a console line. Recorded in selection.json so a nonzero
// count cannot pass unnoticed.
const skippedMissingRecords = [];
for (const document of manifest.documents) {
  if (document.split !== 'development') continue; // the candidate holdout stays sealed
  for (const page of document.pages ?? []) {
    if (labeled.has(pageKey(document.objectId, page.pageNumber))) continue;
    const record = readPageRecord(document.objectId, page.pageNumber);
    if (!record?.pageSpatial) { skippedMissingRecords.push(pageKey(document.objectId, page.pageNumber)); continue; }
    const spatial = record.pageSpatial;
    const diagnostics = spatial.diagnostics ?? {};
    const reasons = diagnostics.escalationReasons ?? [];
    const starvation = reasons.find((reason) => reason.type === 'uncorroborated-ocr');
    const pictorialRegions = (spatial.unreadInkRegions ?? []).filter((region) => region.kind === 'pictorial');
    candidates.push({
      objectId: document.objectId,
      path: document.path,
      sha256: document.sha256,
      familyId: document.familyId ?? document.objectId,
      pageNumber: page.pageNumber,
      labels: page.labels ?? [],
      escalated: Boolean(diagnostics.requiresEscalation),
      starvedCount: starvation?.count ?? 0,
      ocrCount: diagnostics.ocrObservationCount ?? 0,
      // Distinct figures either engine read on this page — the ceiling on how
      // much a numeric gold pass can learn from it.
      criticalCount: new Set([...(spatial.nativeObservations ?? []), ...(spatial.ocrObservations ?? [])]
        .flatMap((observation) => criticalTokens(observation.text ?? ''))).size,
      // The row 1 / 1b population is a page READ ENTIRELY BY OCR — not a page
      // that still fires `uncorroborated-ocr`. Cross-family engagement counts
      // toward the starvation denominator (src/schema.ts), so the corroborator
      // clears the alarm on exactly the pages whose corroboration precision is
      // unmeasured. Selecting on the fired reason would skip all of them.
      nativeStarved: (diagnostics.nativeObservationCount === 0 || (diagnostics.nativeOcrAssociationCoverage ?? 1) < 0.2)
        && (diagnostics.ocrObservationCount ?? 0) >= (diagnostics.thresholds?.uncorroboratedOcrMinimumCount ?? 8),
      conflictCount: diagnostics.criticalConflictCount ?? 0,
      pictorialCount: pictorialRegions.length,
      coverage: diagnostics.nativeOcrAssociationCoverage ?? 1,
      blocking: reasons.some((reason) => reason.severity === 'blocking')
    });
  }
}

// Rank inside a tier by how much evidence the page actually contributes, then
// by id so the same corpus + run always yields the same batch.
const byId = (a, b) => a.objectId.localeCompare(b.objectId) || a.pageNumber - b.pageNumber;

// Deterministic seeded shuffle for the clean profile. FNV-1a folds the seed
// string into 32 bits; mulberry32 drives a Fisher–Yates over the id-sorted
// base order, so the same seed + corpus + run always yields the same batch
// and no property of the page influences its position.
function seededShuffle(items, seedString) {
  let h = 0x811c9dc5;
  for (const char of seedString) {
    h ^= char.codePointAt(0);
    h = Math.imul(h, 0x01000193);
  }
  let state = h >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shuffled = [...items].sort(byId);
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

const TIERS = [
  // Independence check (principles §8): membership reads ONLY the
  // `requiresEscalation` flag — definitional, since escalation recall is
  // measured over pages the system called clean — and order is seeded-random.
  // The previous eligibility test (`criticalCount > 0`) read the extractors
  // under measurement and excluded by construction the total failures row 9
  // exists to count; ranking by the same field favoured pages the engines
  // already handled well. That instrument was fit for finding instances and
  // unfit for a rate — see docs/evaluation-debts.md row 9. The cost of
  // blindness is accepted deliberately: some sampled pages will carry no
  // figures at all, and the review UI's page-level "no miss found" verdict
  // records them as verified negatives instead of wasted work.
  // match/rank are null: membership AND order both come from `cleanOrder`
  // below (one seeded permutation of the !escalated population), so there is
  // no second predicate here to drift out of sync with it.
  { name: 'clean', match: null, rank: null },
  { name: 'starved', match: (c) => c.nativeStarved, rank: (a, b) => b.ocrCount - a.ocrCount || byId(a, b) },
  { name: 'conflict', match: (c) => c.conflictCount > 0, rank: (a, b) => b.conflictCount - a.conflictCount || byId(a, b) },
  { name: 'pictorial', match: (c) => c.pictorialCount > 0, rank: (a, b) => b.pictorialCount - a.pictorialCount || byId(a, b) }
];

const picked = [];
const pickedKeys = new Set();
const perDocument = new Map();
const perFamily = new Map();
const count = (map, key) => map.get(key) ?? 0;

function take(candidate, tier, documentCap) {
  if (pickedKeys.has(pageKey(candidate.objectId, candidate.pageNumber))) return false;
  if (count(perDocument, candidate.objectId) >= documentCap) return false;
  if (count(perFamily, candidate.familyId) >= MAX_PER_FAMILY) return false;
  picked.push({ ...candidate, tier });
  pickedKeys.add(pageKey(candidate.objectId, candidate.pageNumber));
  perDocument.set(candidate.objectId, count(perDocument, candidate.objectId) + 1);
  perFamily.set(candidate.familyId, count(perFamily, candidate.familyId) + 1);
  return true;
}

const shares = profile === 'clean' ? TIER_SHARE_CLEAN : TIER_SHARE;
// The clean population's order is fixed once, up front, and reused by the
// fill pass — one seeded permutation, so relaxing a diversity cap cannot
// smuggle in a different (extractor-informed) ordering.
const cleanOrder = profile === 'clean'
  ? seededShuffle(candidates.filter((candidate) => !candidate.escalated), seed)
  : undefined;
for (const tier of TIERS) {
  if (!shares[tier.name]) continue;
  const quota = Math.round(size * shares[tier.name]);
  let taken = 0;
  const ordered = tier.rank ? candidates.filter(tier.match).sort(tier.rank) : cleanOrder;
  for (const candidate of ordered) {
    if (taken >= quota || picked.length >= size) break;
    if (take(candidate, tier.name, MAX_PER_DOCUMENT)) taken += 1;
  }
  if (taken < quota) {
    console.warn(`Tier ${tier.name}: only ${taken} of ${quota} available under the diversity caps.`);
  }
}

// Residual fill. Debt profile: pages with the widest native/OCR coverage gap —
// the next most likely place for unread ink. Clean profile: the SAME seeded
// order with relaxed document caps — never coverage, which reads the system
// under test — and confined to the population, or the denominator quietly
// stops meaning "pages the pipeline declared fine".
const fillOrder = profile === 'clean'
  ? cleanOrder
  : [...candidates].sort((a, b) => a.coverage - b.coverage || byId(a, b));
for (const candidate of fillOrder) {
  if (picked.length >= size) break;
  take(candidate, 'fill', MAX_PER_DOCUMENT_FILL);
}

if (!picked.length) throw new Error('No unlabeled development pages remain to sample.');
picked.sort(byId);

// The clean POPULATION is partitioned, not just sampled. Prior-batch
// subtraction is honest bookkeeping for "never label twice" but it is also
// INDIRECT CONDITIONING on the system under test: every prior batch was
// selected by extractor output (debt tiers, coverage-sorted fill, batch 5's
// criticalCount eligibility), so the residual unlabeled pool is "clean pages
// the extractor-conditioned samplers didn't want". A rate computed over the
// residual alone would over-represent pages the engines read little on. The
// mitigation is stratum-union: previously-labeled clean pages already carry
// gold, so their miss/no-miss outcomes are derivable from their own batches'
// aggregates, and the honest future denominator is the UNION of strata —
// residual (this sampler) plus each prior batch's clean pages — never the
// residual alone. This partition records both sides with provenance so that
// union can actually be computed.
let populationPartition;
if (profile === 'clean') {
  const previouslyLabeledClean = [];
  const previouslyLabeledEscalated = [];
  const previouslyLabeledUnknown = [];
  for (const { batch, objectId, pageNumber } of labeled.values()) {
    const record = readPageRecord(objectId, pageNumber);
    const entry = { page: pageKey(objectId, pageNumber), batch };
    if (!record?.pageSpatial) previouslyLabeledUnknown.push(entry);
    else if (record.pageSpatial.diagnostics?.requiresEscalation) previouslyLabeledEscalated.push(entry);
    else previouslyLabeledClean.push(entry);
  }
  populationPartition = {
    residualUnlabeledClean: candidates.filter((candidate) => !candidate.escalated)
      .map((candidate) => pageKey(candidate.objectId, candidate.pageNumber)).sort(),
    previouslyLabeledClean,
    previouslyLabeledEscalated: previouslyLabeledEscalated.length,
    previouslyLabeledUnknownRecord: previouslyLabeledUnknown,
    note: 'A clean-page miss RATE must be computed over the union of strata (residual + each prior batch\'s clean pages, from their own aggregates), never over the residual alone: the residual pool is conditioned on prior extractor-driven sampling.'
  };
}

const tally = picked.reduce((acc, page) => ({ ...acc, [page.tier]: (acc[page.tier] ?? 0) + 1 }), {});
console.log(`Candidates: ${candidates.length} unlabeled development pages (${labeled.size} already labeled${skippedMissingRecords.length ? `, ${skippedMissingRecords.length} missing run records` : ''}).`);
console.log(`Selected ${picked.length}: ${Object.entries(tally).map(([tier, n]) => `${tier} ${n}`).join(', ')}.`);
for (const page of picked) {
  // Clean profile: id and tier only. Printing per-page extractor stats here
  // would hand an operator a seed-shopping channel — re-roll seeds until the
  // dry run "looks right" — which is selection conditioned on extractor
  // output with extra steps.
  console.log(profile === 'clean'
    ? `  ${page.tier.padEnd(9)} ${page.objectId} p${page.pageNumber}`
    : `  ${page.tier.padEnd(9)} ${page.objectId} p${page.pageNumber}  starved=${page.starvedCount} conflicts=${page.conflictCount} pictorial=${page.pictorialCount} coverage=${page.coverage.toFixed(2)}`);
}
if (populationPartition) {
  console.log(`Clean population partition: residual ${populationPartition.residualUnlabeledClean.length} unlabeled, prior-labeled clean ${populationPartition.previouslyLabeledClean.length}, prior-labeled escalated ${populationPartition.previouslyLabeledEscalated}${populationPartition.previouslyLabeledUnknownRecord.length ? `, unknown-record ${populationPartition.previouslyLabeledUnknownRecord.length}` : ''}.`);
}
if (skippedMissingRecords.length) {
  console.warn(`WARNING: ${skippedMissingRecords.length} pages have no run record — outside BOTH populations; recorded in selection.json.`);
}
if (dryRun) process.exit(0);

const verifiedPdfSha = new Map();
function assertPdfMatchesManifest(pdfPath, expectedSha) {
  // Same fail-closed rule as run-flash-enrichment.mjs: the bytes rendered
  // (and later transmitted) must be the document the manifest pinned.
  let actual = verifiedPdfSha.get(pdfPath);
  if (!actual) {
    actual = createHash('sha256').update(readFileSync(pdfPath)).digest('hex');
    verifiedPdfSha.set(pdfPath, actual);
  }
  if (actual !== expectedSha) {
    throw new Error(`PDF bytes at ${pdfPath} (${actual.slice(0, 12)}…) do not match the manifest sha256.`);
  }
}

function renderPng(pdfPath, pageNumber, destination) {
  const dir = mkdtempSync(join(tmpdir(), 'gold-sample-'));
  try {
    execFileSync('pdftoppm', ['-f', String(pageNumber), '-l', String(pageNumber), '-r', String(RENDER_DPI), '-png', pdfPath, join(dir, 'p')]);
    const file = readdirSync(dir).find((name) => name.endsWith('.png'));
    if (!file) throw new Error(`pdftoppm produced no output for ${pdfPath} p${pageNumber}.`);
    writeFileSync(destination, readFileSync(join(dir, file)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const imagesDir = join(outputDir, 'images');
mkdirSync(imagesDir, { recursive: true });

const sample = picked.map((page) => {
  const pdfPath = join(corpusRoot, page.path);
  assertPdfMatchesManifest(pdfPath, page.sha256);
  const image = join(imagesDir, `${slug(page.objectId)}-p${page.pageNumber}.png`);
  renderPng(pdfPath, page.pageNumber, image);
  return {
    objectId: page.objectId,
    path: page.path,
    sha256: page.sha256,
    pageNumber: page.pageNumber,
    labels: page.labels,
    escalated: page.escalated,
    image
  };
});

writeFileSync(join(outputDir, 'pilot-sample.json'), `${JSON.stringify(sample, null, 2)}\n`);
writeFileSync(join(outputDir, "selection.json"), `${JSON.stringify({
  runRoot,
  size,
  profile,
  ...(profile === 'clean' ? {
    seed,
    population: 'non-escalated development pages (requiresEscalation false), seeded-random, extractor-blind',
    populationPartition
  } : {}),
  skippedMissingRunRecords: { count: skippedMissingRecords.length, pages: skippedMissingRecords },
  tally,
  pages: picked
}, null, 2)}\n`);
console.log(`Wrote ${join(outputDir, 'pilot-sample.json')} and ${sample.length} page images.`);
