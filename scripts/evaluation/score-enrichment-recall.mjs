/**
 * Enrichment-aware gold recall (evaluation-debts rows 2/3): union recall of
 * verified gold tokens over the deterministic record alone vs record +
 * enrichment (proposals and adjudication inkText), on gold∩blocking pages.
 *
 * Committed because measured-then-trusted forbids quoting numbers only a
 * throwaway script can produce. Matching uses the library's own token
 * rules (consume-once, tail-compatible) — never a re-implementation.
 *
 * Usage:
 *   node scripts/evaluation/score-enrichment-recall.mjs \
 *     --run-root .evaluation/runs/<run-id> [--enrichment <dir>]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildCorroborationPool, poolCorroborates } from '../../dist/corroborate.js';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument ${name}`);
}

const runRoot = arg('--run-root');
const enrichmentDir = arg('--enrichment', join(runRoot, 'enrichment'));

const gold = new Map();
for (const source of ['pilot-v1', 'batch2-v1']) {
  const verdicts = JSON.parse(readFileSync(`.evaluation/gold/${source}/gold-verdicts.json`, 'utf8'));
  for (const page of verdicts.pages) {
    const tokens = page.tokens.filter((token) => token.verdict === 'correct').map((token) => token.text);
    if (tokens.length) gold.set(`${page.sha256}#${page.pageNumber}`, tokens);
  }
}

const enrichments = new Map();
let enrichmentFiles = [];
try { enrichmentFiles = readdirSync(enrichmentDir).filter((name) => name.startsWith('ps_')); } catch {
  console.warn(`No enrichment directory at ${enrichmentDir}; scoring base only.`);
}
for (const file of enrichmentFiles) {
  const record = JSON.parse(readFileSync(join(enrichmentDir, file), 'utf8'));
  enrichments.set(`${record.documentSha256}#${record.pageNumber}`, record);
}

function recall(goldTokens, texts) {
  const pool = buildCorroborationPool(texts);
  return goldTokens.filter((token) => poolCorroborates(token, pool)).length;
}

let pages = 0;
let total = 0;
let base = 0;
let withEnrichment = 0;
const shortfalls = [];
for (const doc of readdirSync(join(runRoot, 'documents'))) {
  let files;
  try { files = readdirSync(join(runRoot, 'documents', doc, 'pages')); } catch { continue; }
  for (const file of files) {
    const page = JSON.parse(readFileSync(join(runRoot, 'documents', doc, 'pages', file), 'utf8')).pageSpatial;
    const key = `${page.documentSha256}#${page.pageNumber}`;
    if (!gold.has(key)) continue;
    if (!page.diagnostics.escalationReasons.some((reason) => reason.severity === 'blocking')) continue;
    pages += 1;
    const goldTokens = gold.get(key);
    const deterministic = [
      ...page.nativeObservations.map((observation) => observation.text),
      ...page.ocrObservations.map((observation) => observation.text)
    ];
    const enrichment = enrichments.get(key);
    const enriched = [
      ...deterministic,
      ...(enrichment?.proposals ?? []).map((proposal) => proposal.text),
      ...(enrichment?.adjudications ?? []).flatMap((adjudication) => adjudication.inkText ? [adjudication.inkText] : [])
    ];
    const baseHit = recall(goldTokens, deterministic);
    const enrichedHit = recall(goldTokens, enriched);
    total += goldTokens.length;
    base += baseHit;
    withEnrichment += enrichedHit;
    if (enrichedHit < goldTokens.length) shortfalls.push(`${page.pageId} ${enrichedHit}/${goldTokens.length}`);
  }
}
console.log(JSON.stringify({
  scorerVersion: 'enrichment-recall-v1',
  runRoot,
  enrichmentDir,
  goldBlockingPages: pages,
  goldTokens: total,
  baseUnionRecall: `${base}/${total}`,
  withEnrichmentRecall: `${withEnrichment}/${total}`,
  shortfallPages: shortfalls
}, null, 1));
