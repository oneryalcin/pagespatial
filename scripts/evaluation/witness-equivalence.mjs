/**
 * Witness equivalence: server-native PP-OCR (pdftoppm render + onnxruntime
 * WASM under Node, src/node/ppocr-ocr.ts) vs the browser witness (pdf.js
 * render + WebGPU) recorded in an existing run (issue #2 now-half).
 *
 * This measures the FULL pipeline swap — renderer AND execution provider —
 * because that is what #22's service would actually run. Pages render at
 * the run's own dpi (rotation-aware; pdftoppm's -scale-to-x/y flags apply
 * pre-rotation and transpose 90° pages) and node boxes are mapped into the
 * record's geometry space, so boxes compare directly.
 *
 * Per page, against the run record's ocrObservations:
 *  - critical-token multiset overlap, both directions (library tokenizer,
 *    consume-once — never a re-implementation);
 *  - box IoU for exact-normalized-text matches;
 *  - confidence delta on those matches.
 * Plus gold recall (human-verified tokens, pool corroboration) under each
 * witness, on pages with gold.
 *
 * Usage:
 *   node scripts/evaluation/witness-equivalence.mjs \
 *     --run-root .evaluation/runs/<run-id> \
 *     --corpus-root .evaluation/corpus \
 *     --gold-root .evaluation/gold \
 *     --assets-dir .evaluation/ocr-assets \
 *     --output .evaluation/witness-equivalence.json \
 *     [--threads 4] [--limit N]
 *
 * Output JSON is text-free (counts, rates, timings only).
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PNG } from 'pngjs';
import { criticalTokens } from '../../dist/text.js';
import { buildCorroborationPool, poolCorroborates } from '../../dist/corroborate.js';
import { createPpOcrV6NodeAdapter } from '../../dist/node/ppocr-ocr.js';

const execFileAsync = promisify(execFile);

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument ${name}`);
}

const runRoot = arg('--run-root');
const corpusRoot = arg('--corpus-root');
const goldRoot = arg('--gold-root');
const assetsDir = arg('--assets-dir');
const outputPath = arg('--output');
const threads = Number(arg('--threads', '4'));
const limit = Number(arg('--limit', '0'));

// Gold pages define the sample: every human-labelled page with a run record.
const gold = new Map();
for (const source of readdirSync(goldRoot)) {
  let verdicts;
  try { verdicts = JSON.parse(readFileSync(join(goldRoot, source, 'gold-verdicts.json'), 'utf8')); } catch { continue; }
  for (const page of verdicts.pages) {
    const tokens = page.tokens
      .filter((token) => token.verdict === 'correct' || token.verdict === 'edited')
      .map((token) => token.text)
      .filter(Boolean);
    const key = `${page.objectId}#${page.pageNumber}`;
    if (!gold.has(key)) gold.set(key, { tokens, sha256: page.sha256 });
    else if (gold.get(key).sha256 !== page.sha256) {
      throw new Error(`Gold sources disagree on sha256 for ${key}.`);
    }
  }
}

const records = [];
for (const doc of readdirSync(join(runRoot, 'documents'))) {
  let pages;
  try { pages = readdirSync(join(runRoot, 'documents', doc, 'pages')); } catch { continue; }
  for (const file of pages) {
    const record = JSON.parse(readFileSync(join(runRoot, 'documents', doc, 'pages', file), 'utf8'));
    if (!record.pageSpatial) continue;
    const key = `${record.objectId}#${record.pageNumber}`;
    if (!gold.has(key)) continue;
    // Hash-bound join, same rule as the committed evaluator: gold must
    // describe the same document bytes the run parsed.
    if (gold.get(key).sha256 !== record.pageSpatial.documentSha256) {
      throw new Error(`SHA-256 mismatch for ${key}: gold=${gold.get(key).sha256} run=${record.pageSpatial.documentSha256}`);
    }
    records.push(record);
  }
}
records.sort((a, b) => `${a.objectId}#${a.pageNumber}`.localeCompare(`${b.objectId}#${b.pageNumber}`));
const sample = limit > 0 ? records.slice(0, limit) : records;
console.log(`Sample: ${sample.length} gold pages with run records.`);

const normalize = (text) => text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();

function tokenOverlap(fromTexts, intoTexts) {
  // How many of `fromTexts`' critical tokens the other witness corroborates
  // (consume-once, tail-compatible — the library's own pool rules).
  const tokens = fromTexts.flatMap((text) => criticalTokens(text));
  if (!tokens.length) return { tokens: 0, matched: 0 };
  const pool = buildCorroborationPool(intoTexts);
  let matched = 0;
  for (const token of tokens) if (poolCorroborates(token, pool)) matched += 1;
  return { tokens: tokens.length, matched };
}

function iou(a, b) {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]);
  const y1 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

const adapter = createPpOcrV6NodeAdapter({ assetsDir, variant: 'small', numThreads: threads });
await adapter.warmup();

const perPage = [];
const timingsMs = [];
let renderMsTotal = 0;
const rssStart = process.memoryUsage().rss;
let rssPeak = rssStart;
const tmp = mkdtempSync(join(tmpdir(), 'witness-eq-'));

for (const record of sample) {
  const page = record.pageSpatial;
  const key = `${record.objectId}#${record.pageNumber}`;
  const pdfPath = join(corpusRoot, record.path);
  const { width, height, pointWidth, pointHeight, rotation } = page.geometry;
  // pdftoppm applies -scale-to-x/-scale-to-y in the PRE-rotation frame, so
  // forcing the rotated geometry's dimensions transposes 90°/270° pages
  // (the first attempt did exactly that and zeroed Blackstone p12-17's
  // recall — same lesson as the crop-math bug). Render by dpi instead:
  // rotation-aware scale from the record's own geometry, then map boxes
  // into geometry space below.
  const scale = (rotation % 180 !== 0) ? width / pointHeight : width / pointWidth;
  const prefix = join(tmp, 'page');
  const t0 = Date.now();
  await execFileAsync('pdftoppm', [
    '-f', String(record.pageNumber), '-l', String(record.pageNumber),
    '-r', String(scale * 72),
    '-png', pdfPath, prefix
  ]);
  const pngFile = readdirSync(tmp).find((name) => name.startsWith('page'));
  if (!pngFile) throw new Error(`pdftoppm produced no image for ${key}`);
  const png = PNG.sync.read(readFileSync(join(tmp, pngFile)));
  rmSync(join(tmp, pngFile));
  const scaleX = width / png.width;
  const scaleY = height / png.height;
  if (Math.abs(scaleX - 1) > 0.05 || Math.abs(scaleY - 1) > 0.05) {
    throw new Error(`${key}: render dims ${png.width}x${png.height} disagree with geometry ${width}x${height} beyond rounding.`);
  }
  const renderMs = Date.now() - t0;
  renderMsTotal += renderMs;

  const t1 = Date.now();
  const result = await adapter.recognize({
    pageNumber: record.pageNumber,
    geometry: page.geometry,
    data: { data: png.data, width: png.width, height: png.height }
  });
  const ocrMs = Date.now() - t1;
  timingsMs.push(ocrMs);
  rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  // Map node boxes from render pixels into the record's geometry space
  // (sub-percent rounding correction; orientation already matches).
  for (const observation of result.observations) {
    observation.box = [observation.box[0] * scaleX, observation.box[1] * scaleY, observation.box[2] * scaleX, observation.box[3] * scaleY];
  }

  // First-pass vs first-pass: the browser run includes zoom-retry recovery
  // observations (regionRecovery: true, marked recoveryMethod) — a pipeline
  // layer above the witness, absent from this single-pass server run.
  const firstPass = page.ocrObservations.filter((observation) => !observation.recoveryMethod);
  const browserTexts = firstPass.map((observation) => observation.text);
  const nodeTexts = result.observations.map((observation) => observation.text);

  const browserIntoNode = tokenOverlap(browserTexts, nodeTexts);
  const nodeIntoBrowser = tokenOverlap(nodeTexts, browserTexts);

  // Box + confidence agreement on exact-normalized-text unique matches.
  const nodeByText = new Map();
  for (const observation of result.observations) {
    const norm = normalize(observation.text);
    if (!norm) continue;
    (nodeByText.get(norm) ?? nodeByText.set(norm, []).get(norm)).push(observation);
  }
  const ious = [];
  const confidenceDeltas = [];
  for (const observation of firstPass) {
    const candidates = nodeByText.get(normalize(observation.text));
    if (!candidates?.length) continue;
    let best = null;
    for (const candidate of candidates) {
      const value = iou(observation.box, candidate.box);
      if (!best || value > best.value) best = { value, candidate };
    }
    if (best && best.value > 0) {
      ious.push(best.value);
      confidenceDeltas.push(best.candidate.confidence - observation.confidence);
    }
  }

  const goldEntry = gold.get(key);
  let goldRecall = null;
  if (goldEntry?.tokens.length) {
    // Token-level paired classification: each gold token is checked against
    // both witnesses' pools in the same order (consume-once per pool), so
    // the discordant cells are exactly the tokens where the witnesses
    // genuinely differ — the input McNemar needs.
    const browserPool = buildCorroborationPool(browserTexts);
    const nodePool = buildCorroborationPool(nodeTexts);
    let bothHit = 0;
    let nodeOnly = 0;
    let browserOnly = 0;
    let bothMiss = 0;
    for (const token of goldEntry.tokens) {
      const inBrowser = poolCorroborates(token, browserPool);
      const inNode = poolCorroborates(token, nodePool);
      if (inBrowser && inNode) bothHit += 1;
      else if (inNode) nodeOnly += 1;
      else if (inBrowser) browserOnly += 1;
      else bothMiss += 1;
    }
    goldRecall = {
      goldTokens: goldEntry.tokens.length,
      browser: bothHit + browserOnly,
      node: bothHit + nodeOnly,
      bothHit,
      nodeOnly,
      browserOnly,
      bothMiss
    };
  }

  perPage.push({
    page: key,
    browserObservations: firstPass.length,
    nodeObservations: result.observations.length,
    browserTokensMatchedByNode: browserIntoNode,
    nodeTokensMatchedByBrowser: nodeIntoBrowser,
    exactTextMatches: ious.length,
    medianIou: ious.length ? Number(ious.sort((a, b) => a - b)[Math.floor(ious.length / 2)].toFixed(3)) : null,
    meanConfidenceDelta: confidenceDeltas.length ? Number((confidenceDeltas.reduce((a, b) => a + b, 0) / confidenceDeltas.length).toFixed(4)) : null,
    renderMs,
    ocrMs,
    goldRecall
  });
  console.log(`[${perPage.length}/${sample.length}] ${key}: browser ${firstPass.length} obs, node ${result.observations.length}; tokens b→n ${browserIntoNode.matched}/${browserIntoNode.tokens}, n→b ${nodeIntoBrowser.matched}/${nodeIntoBrowser.tokens}; ocr ${ocrMs}ms`);
}

rmSync(tmp, { recursive: true, force: true });
await adapter.dispose();

const sum = (values) => values.reduce((a, b) => a + b, 0);

/**
 * McNemar exact test, two-sided: under H0 (witnesses equally likely to be
 * the sole reader of a token), the discordant count in either cell is
 * Binomial(b+c, 0.5). p = min(1, 2 * P(X <= min(b, c))).
 */
function mcNemarExactTwoSided(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  const logChoose = (m, i) => {
    let s = 0;
    for (let j = 0; j < i; j += 1) s += Math.log(m - j) - Math.log(j + 1);
    return s;
  };
  let tail = 0;
  for (let i = 0; i <= k; i += 1) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

/** Clopper-Pearson 95% two-sided interval for successes/trials, by bisection. */
function clopperPearson95(successes, trials) {
  if (trials === 0) return [0, 1];
  const cdf = (k, n, p) => {
    let s = 0;
    let c = 1;
    for (let i = 0; i <= k; i += 1) {
      s += c * Math.pow(p, i) * Math.pow(1 - p, n - i);
      c = (c * (n - i)) / (i + 1);
    }
    return s;
  };
  const solve = (predicate) => {
    let lo = 0;
    let hi = 1;
    for (let it = 0; it < 60; it += 1) {
      const mid = (lo + hi) / 2;
      if (predicate(mid)) lo = mid; else hi = mid;
    }
    return lo;
  };
  const lower = successes === 0 ? 0 : solve((p) => cdf(successes - 1, trials, p) > 0.975);
  const upper = successes === trials ? 1 : solve((p) => cdf(successes, trials, p) > 0.025);
  return [lower, upper];
}
const bIntoN = perPage.map((p) => p.browserTokensMatchedByNode);
const nIntoB = perPage.map((p) => p.nodeTokensMatchedByBrowser);
const goldPages = perPage.filter((p) => p.goldRecall);
const sorted = [...timingsMs].sort((a, b) => a - b);
const aggregate = {
  method: 'witness-equivalence-v2',
  runRoot: runRoot.split('/').filter(Boolean).pop(),
  sampleFilter: 'all gold-labelled pages with a run record',
  serverWitness: { adapter: adapter.name, render: 'pdftoppm at the run dpi (rotation-aware), boxes mapped to record geometry', threads },
  browserWitness: 'run-record ocrObservations (pdf.js render + WebGPU PP-OCRv6 small)',
  pages: perPage.length,
  observations: {
    browser: sum(perPage.map((p) => p.browserObservations)),
    node: sum(perPage.map((p) => p.nodeObservations))
  },
  criticalTokenAgreement: {
    browserTokensMatchedByNode: `${sum(bIntoN.map((x) => x.matched))}/${sum(bIntoN.map((x) => x.tokens))}`,
    nodeTokensMatchedByBrowser: `${sum(nIntoB.map((x) => x.matched))}/${sum(nIntoB.map((x) => x.tokens))}`
  },
  boxAgreement: {
    exactTextMatches: sum(perPage.map((p) => p.exactTextMatches)),
    medianOfPageMedianIou: (() => {
      const values = perPage.map((p) => p.medianIou).filter((v) => v !== null).sort((a, b) => a - b);
      return values.length ? values[Math.floor(values.length / 2)] : null;
    })()
  },
  goldRecall: {
    pages: goldPages.length,
    goldTokens: sum(goldPages.map((p) => p.goldRecall.goldTokens)),
    browser: sum(goldPages.map((p) => p.goldRecall.browser)),
    node: sum(goldPages.map((p) => p.goldRecall.node))
  },
  goldDiscordance: (() => {
    const bothHit = sum(goldPages.map((p) => p.goldRecall.bothHit));
    const nodeOnly = sum(goldPages.map((p) => p.goldRecall.nodeOnly));
    const browserOnly = sum(goldPages.map((p) => p.goldRecall.browserOnly));
    const bothMiss = sum(goldPages.map((p) => p.goldRecall.bothMiss));
    const discordant = nodeOnly + browserOnly;
    const goldTokens = bothHit + nodeOnly + browserOnly + bothMiss;
    const p = mcNemarExactTwoSided(nodeOnly, browserOnly);
    const [lo, hi] = clopperPearson95(nodeOnly, discordant);
    // Conditional on the observed discordant count: the true node-minus-
    // browser difference consistent with the data at 95%, in tokens.
    const diffLow = Math.round(discordant * (2 * lo - 1));
    const diffHigh = Math.round(discordant * (2 * hi - 1));
    return {
      bothHit,
      nodeOnly,
      browserOnly,
      bothMiss,
      mcNemarExactTwoSidedP: Number(p.toFixed(4)),
      nodeShareOfDiscordantsCI95: [Number(lo.toFixed(3)), Number(hi.toFixed(3))],
      trueDifferenceTokensCI95: [diffLow, diffHigh],
      note: `Conditional on ${discordant} discordant tokens of ${goldTokens}: the data are consistent with a true node-minus-browser difference between ${diffLow} and ${diffHigh} tokens at 95%.`
    };
  })(),
  timings: {
    ocrMsP50: sorted[Math.floor(sorted.length / 2)] ?? null,
    ocrMsP95: sorted[Math.floor(sorted.length * 0.95)] ?? null,
    renderMsMean: perPage.length ? Math.round(renderMsTotal / perPage.length) : null,
    rssPeakMb: Math.round(rssPeak / 1024 / 1024),
    rssStartMb: Math.round(rssStart / 1024 / 1024)
  },
  perPage
};
writeFileSync(outputPath, JSON.stringify(aggregate, null, 1));
console.log(JSON.stringify({ ...aggregate, perPage: `(${perPage.length} pages in file)` }, null, 1));
