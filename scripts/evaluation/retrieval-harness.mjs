/**
 * Retrieval harness (issue #36, pre-registered): does trust metadata change
 * downstream retrieval outcomes?
 *
 * Two ingestion paths over the SAME corpus, retriever, and chunking:
 *   A (naive)       — every observation from both witnesses, in reading
 *                     order, duplicates and disputed readings included.
 *   B (trust-aware) — the record's own semantics gate what enters the index:
 *                     * conflicts: adjudicated → winning side only (plus
 *                       inkText); unadjudicated/unsure/both-wrong → BOTH
 *                       sides excluded (reject-don't-repair), inkText
 *                       indexed when the adjudicator supplied one;
 *                     * corroborated OCR duplicates of native text are
 *                       dropped (the naive path double-counts them);
 *                     * uncorroborated OCR below the low-confidence floor
 *                       (0.5) is dropped;
 *                     * enrichment proposals (escalated-tier recovery) are
 *                       appended.
 *
 * Queries are built deterministically from gold-verified tokens: the answer
 * is a human-verified token; the query is context words drawn from
 * BOTH-WITNESS-AGREED text near the token's box. Agreed text is indexed
 * identically by both paths, so query construction cannot favour either
 * path; the paths differ only on disputed/uncorroborated content, which
 * never enters a query.
 *
 * Scoring is deterministic (no LLM judge): BM25 over word-window chunks,
 * hit@k = a chunk from the gold page containing the answer token appears in
 * the top k. Chunk width is swept (25/50/100/200 words) per the
 * pre-registration — granularity is an output, not an input.
 *
 * Per-query results (which contain corpus text) are written under
 * .evaluation/retrieval/ and never committed; stdout carries aggregates
 * only.
 *
 * Usage:
 *   node scripts/evaluation/retrieval-harness.mjs \
 *     [--run-root .evaluation/runs/dev-v12-cross-family-2026-08-20] \
 *     [--gold-root .evaluation/gold] [--out .evaluation/retrieval]
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripCurrency } from './lib/recall-match.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const runRoot = arg('--run-root', '.evaluation/runs/dev-v12-cross-family-2026-08-20');
const goldRoot = arg('--gold-root', '.evaluation/gold');
const outDir = arg('--out', '.evaluation/retrieval');
const GOLD_BATCHES = ['pilot-v1', 'batch2-v1', 'batch3-v1', 'batch4-v1', 'batch5-clean-v1'];
const CHUNK_WIDTHS = [25, 50, 100, 200];
const PRIMARY_WIDTH = 50;
const KS = [1, 3, 5, 10];
const LOW_CONFIDENCE_FLOOR = 0.5;
const MAX_QUERIES_PER_PAGE = 3;
const CONTEXT_WORDS = 10;
const MIN_CONTEXT_WORDS = 4;

const normalize = (text) => stripCurrency(String(text ?? '')).toLowerCase().replace(/\s+/gu, ' ').trim();
const tokenize = (text) => normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
// Answers and chunks are compared comma-free so 684,663 matches 684663-style
// splits either side of the tokenizer.
const answerForm = (text) => normalize(text).replace(/,/gu, '');

// ---------------------------------------------------------------------------
// Load run pages
// ---------------------------------------------------------------------------
const pages = new Map(); // key sha#page -> pageSpatial
for (const doc of readdirSync(join(runRoot, 'documents'))) {
  let files;
  try { files = readdirSync(join(runRoot, 'documents', doc, 'pages')); } catch { continue; }
  for (const file of files) {
    const page = JSON.parse(readFileSync(join(runRoot, 'documents', doc, 'pages', file), 'utf8')).pageSpatial;
    pages.set(`${page.documentSha256}#${page.pageNumber}`, page);
  }
}

const enrichments = new Map(); // pageKey -> record
try {
  for (const file of readdirSync(join(runRoot, 'enrichment')).filter((name) => name.startsWith('ps_') && name.endsWith('.json'))) {
    const record = JSON.parse(readFileSync(join(runRoot, 'enrichment', file), 'utf8'));
    enrichments.set(`${record.documentSha256}#${record.pageNumber}`, record);
  }
} catch { /* runs without an escalated tier are legitimate */ }

function stratum(page) {
  const reasons = page.diagnostics.escalationReasons;
  const blocking = reasons.filter((reason) => reason.severity === 'blocking');
  if (!blocking.length) return 'clean';
  if (blocking.some((reason) => reason.type === 'critical-token-conflict' || reason.type === 'critical-token-omission')) return 'conflict';
  return 'escalated-other';
}

// ---------------------------------------------------------------------------
// Ingestion paths
// ---------------------------------------------------------------------------
const center = (box) => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
const readingOrder = (a, b) => {
  const [ax, ay] = center(a.box); const [bx, by] = center(b.box);
  const rowA = Math.round(ay / 12); const rowB = Math.round(by / 12);
  return rowA - rowB || ax - bx;
};

function naiveText(page) {
  return [...page.nativeObservations, ...page.ocrObservations]
    .sort(readingOrder)
    .map((observation) => observation.text);
}

function trustAwareText(page, enrichment) {
  const drop = new Set();
  const extras = [];
  const adjudications = new Map((enrichment?.adjudications ?? []).map((entry) => [entry.conflictId, entry]));
  for (const conflict of page.conflicts) {
    const adjudication = adjudications.get(conflict.id);
    const verdict = adjudication?.verdict;
    if (verdict === 'native') {
      drop.add(conflict.ocrId);
    } else if (verdict === 'ocr') {
      for (const id of conflict.nativeIds) drop.add(id);
    } else {
      // unadjudicated, unsure, or both-wrong: neither reading is trusted
      drop.add(conflict.ocrId);
      for (const id of conflict.nativeIds) drop.add(id);
    }
    if (adjudication?.inkText) extras.push({ text: adjudication.inkText, box: null });
  }
  const nativeBlob = normalize(page.nativeObservations.map((observation) => observation.text).join(' '));
  const kept = [];
  for (const observation of page.nativeObservations) {
    if (!drop.has(observation.id)) kept.push(observation);
  }
  for (const observation of page.ocrObservations) {
    if (drop.has(observation.id)) continue;
    const norm = normalize(observation.text);
    if (norm && nativeBlob.includes(norm)) continue; // corroborated duplicate
    if ((observation.confidence ?? 1) < LOW_CONFIDENCE_FLOOR) continue; // uncorroborated low-trust
    kept.push(observation);
  }
  const texts = kept.sort(readingOrder).map((observation) => observation.text);
  for (const proposal of enrichment?.proposals ?? []) texts.push(proposal.text);
  for (const extra of extras) texts.push(extra.text);
  return texts;
}

// ---------------------------------------------------------------------------
// Chunking + BM25
// ---------------------------------------------------------------------------
function buildChunks(corpusTexts, width) {
  const chunks = [];
  for (const [pageKey, texts] of corpusTexts) {
    const words = texts.flatMap((text) => String(text).split(/\s+/u).filter(Boolean));
    for (let start = 0; start < words.length; start += width) {
      const slice = words.slice(start, start + width);
      if (!slice.length) continue;
      chunks.push({ pageKey, text: slice.join(' ') });
    }
    if (!words.length) chunks.push({ pageKey, text: '' });
  }
  return chunks;
}

function buildIndex(chunks) {
  const documentFrequency = new Map();
  const chunkTerms = chunks.map((chunk) => {
    const counts = new Map();
    for (const term of tokenize(chunk.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const term of counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    return counts;
  });
  const lengths = chunkTerms.map((counts) => [...counts.values()].reduce((sum, value) => sum + value, 0));
  const averageLength = lengths.reduce((sum, value) => sum + value, 0) / Math.max(1, lengths.length);
  return { chunks, chunkTerms, documentFrequency, lengths, averageLength, total: chunks.length };
}

function bm25Rank(index, queryTerms, k1 = 1.2, b = 0.75) {
  const scores = [];
  for (let i = 0; i < index.chunks.length; i += 1) {
    let score = 0;
    for (const term of queryTerms) {
      const frequency = index.chunkTerms[i].get(term);
      if (!frequency) continue;
      const df = index.documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (index.total - df + 0.5) / (df + 0.5));
      score += idf * (frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * (index.lengths[i] / index.averageLength)));
    }
    if (score > 0) scores.push([score, i]);
  }
  scores.sort((a, b2) => b2[0] - a[0]);
  return scores.map(([, i]) => i);
}

// ---------------------------------------------------------------------------
// Query construction from gold
// ---------------------------------------------------------------------------
const gold = []; // {pageKey, answer, box (normalized 0-1000 or null), stratum}
for (const batch of GOLD_BATCHES) {
  const verdicts = JSON.parse(readFileSync(join(goldRoot, batch, 'gold-verdicts.json'), 'utf8'));
  const proposals = JSON.parse(readFileSync(join(goldRoot, batch, 'proposals.json'), 'utf8'));
  for (const page of verdicts.pages) {
    const pageKey = `${page.sha256}#${page.pageNumber}`;
    if (!pages.has(pageKey)) continue;
    const proposal = proposals.find((entry) => entry.sha256 === page.sha256 && entry.pageNumber === page.pageNumber);
    const tokens = proposal?.proposal?.criticalTokens ?? [];
    for (const token of page.tokens) {
      if (token.verdict !== 'correct') continue;
      const box = tokens[token.index]?.box_2d ?? null;
      gold.push({ pageKey, answer: token.text, box, stratum: stratum(pages.get(pageKey)), batch });
    }
  }
}

function agreedWords(page) {
  const nativeWords = new Set(tokenize(page.nativeObservations.map((observation) => observation.text).join(' ')));
  const agreed = new Set();
  for (const word of tokenize(page.ocrObservations.map((observation) => observation.text).join(' '))) {
    if (nativeWords.has(word)) agreed.add(word);
  }
  return agreed;
}

function buildQuery(entry) {
  const page = pages.get(entry.pageKey);
  if (!entry.box) return null;
  const geometry = page.geometry;
  const target = [
    ((entry.box[1] + entry.box[3]) / 2 / 1000) * geometry.width,
    ((entry.box[0] + entry.box[2]) / 2 / 1000) * geometry.height
  ];
  const agreed = agreedWords(page);
  const answerWords = new Set(tokenize(entry.answer).map((word) => answerForm(word)));
  const candidates = page.nativeObservations
    .map((observation) => {
      const [x, y] = center(observation.box);
      return { observation, distance: Math.hypot(x - target[0], y - target[1]) };
    })
    .sort((a, b) => a.distance - b.distance);
  const context = [];
  const seen = new Set();
  for (const { observation } of candidates) {
    for (const word of tokenize(observation.text)) {
      if (context.length >= CONTEXT_WORDS) break;
      if (!agreed.has(word)) continue; // both-witness-agreed text only
      if (answerWords.has(answerForm(word))) continue; // never leak the answer
      if (word.length < 2) continue;
      if (seen.has(word)) continue;
      seen.add(word);
      context.push(word);
    }
    if (context.length >= CONTEXT_WORDS) break;
  }
  if (context.length < MIN_CONTEXT_WORDS) return null;
  return context.join(' ');
}

// Deterministic selection: per page, evenly spaced verified tokens, capped.
const byPage = new Map();
for (const entry of gold) {
  if (!byPage.has(entry.pageKey)) byPage.set(entry.pageKey, []);
  byPage.get(entry.pageKey).push(entry);
}
const queries = [];
for (const [, entries] of [...byPage.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const step = Math.max(1, Math.floor(entries.length / MAX_QUERIES_PER_PAGE));
  const picked = [];
  for (let i = 0; i < entries.length && picked.length < MAX_QUERIES_PER_PAGE; i += step) picked.push(entries[i]);
  for (const entry of picked) {
    const query = buildQuery(entry);
    if (query) queries.push({ ...entry, query });
  }
}

// ---------------------------------------------------------------------------
// Build corpora, run the sweep
// ---------------------------------------------------------------------------
const corpusA = new Map();
const corpusB = new Map();
for (const [pageKey, page] of pages) {
  corpusA.set(pageKey, naiveText(page));
  corpusB.set(pageKey, trustAwareText(page, enrichments.get(pageKey)));
}

function evaluate(index, query) {
  const answer = answerForm(query.answer);
  const chunkMatches = (i) => index.chunks[i].pageKey === query.pageKey
    && answerForm(index.chunks[i].text).includes(answer);
  const inIndex = index.chunks.some((chunk, i) => chunkMatches(i));
  const ranking = bm25Rank(index, tokenize(query.query));
  let rank = null;
  for (let position = 0; position < ranking.length; position += 1) {
    if (chunkMatches(ranking[position])) { rank = position + 1; break; }
  }
  return { rank, inIndex };
}

const sweep = {};
const perQuery = [];
for (const width of CHUNK_WIDTHS) {
  const indexA = buildIndex(buildChunks(corpusA, width));
  const indexB = buildIndex(buildChunks(corpusB, width));
  const results = queries.map((query) => ({
    stratum: query.stratum,
    pageKey: query.pageKey,
    answer: query.answer,
    a: evaluate(indexA, query),
    b: evaluate(indexB, query)
  }));
  sweep[width] = results;
  if (width === PRIMARY_WIDTH) {
    for (let i = 0; i < queries.length; i += 1) {
      perQuery.push({ ...queries[i], result: results[i] });
    }
  }
}

// ---------------------------------------------------------------------------
// Aggregate + report (counts only on stdout)
// ---------------------------------------------------------------------------
const hit = (result, k) => result.rank !== null && result.rank <= k;
function table(results) {
  const rows = {};
  for (const k of KS) {
    const aHits = results.filter((result) => hit(result.a, k)).length;
    const bHits = results.filter((result) => hit(result.b, k)).length;
    const wins = results.filter((result) => hit(result.b, k) && !hit(result.a, k)).length;
    const losses = results.filter((result) => hit(result.a, k) && !hit(result.b, k)).length;
    rows[`@${k}`] = { A: aHits, B: bHits, bWins: wins, bLosses: losses, flat: results.length - wins - losses };
  }
  return rows;
}

const primary = sweep[PRIMARY_WIDTH];
const strata = ['conflict', 'escalated-other', 'clean'];
const report = {
  harnessVersion: 'retrieval-harness-v1',
  runRoot,
  queries: primary.length,
  queriesByStratum: Object.fromEntries(strata.map((name) => [name, primary.filter((result) => result.stratum === name).length])),
  answerNotInIndex: {
    A: primary.filter((result) => !result.a.inIndex).length,
    B: primary.filter((result) => !result.b.inIndex).length
  },
  primaryWidth: PRIMARY_WIDTH,
  overall: table(primary),
  byStratum: Object.fromEntries(strata.map((name) => [name, table(primary.filter((result) => result.stratum === name))])),
  chunkSweepHitAt5: Object.fromEntries(CHUNK_WIDTHS.map((width) => [width, {
    A: sweep[width].filter((result) => hit(result.a, 5)).length,
    B: sweep[width].filter((result) => hit(result.b, 5)).length,
    of: sweep[width].length
  }]))
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'results-v1.json'), JSON.stringify({ report, perQuery }, null, 1));
console.log(JSON.stringify(report, null, 1));
console.log(`Per-query detail (private, contains corpus text): ${join(outDir, 'results-v1.json')}`);
