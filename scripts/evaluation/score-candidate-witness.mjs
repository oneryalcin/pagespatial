/**
 * Score a candidate witness's observations (JSON dumped by
 * hpi_bench_modal.py / hpi_ceremony_modal.py) against the browser reference
 * and gold — the same consume-once library mechanics as
 * witness-equivalence.mjs, so candidate numbers are comparable with the
 * committed server-witness figures.
 *
 * v2 (adoption ceremony) adds, beyond v1's text-only agreement + gold
 * recall:
 *  - box IoU on exact-normalized-text matches (candidate polygons →
 *    rendered-pixel AABBs → record geometry space via the manifest dims;
 *    same best-match method as witness-equivalence.mjs — NOT consume-once,
 *    diagnostic only; the paired confidence deltas inherit this same
 *    best-match pairing and carry the same caveat);
 *  - McNemar exact test + Clopper-Pearson CI on the gold discordants
 *    (implementations copied from witness-equivalence.mjs, validated there
 *    against known values);
 *  - calibration: candidate score vs browser confidence distributions
 *    (quantiles, mass below the pipeline's lowOcrConfidence floor 0.5, and
 *    paired deltas on matched-text observations).
 *
 * Usage:
 *   node scripts/evaluation/score-candidate-witness.mjs \
 *     --results .evaluation/hpi-bench/results-<config>.json \
 *     --manifest .evaluation/hpi-bench/manifest.json \
 *     --run-root .evaluation/runs/<run-id> \
 *     --gold-root .evaluation/gold \
 *     [--server-observations .evaluation/.../server-witness-observations.json]
 * With --server-observations (dump-witness-confidences.mjs output), adds the
 * three-witness view: per-token gold classification across browser/server/
 * candidate, candidate-vs-server McNemar, and server calibration quantiles.
 * Output (stdout JSON) is text-free: counts, rates, timings only.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { criticalTokens } from '../../dist/text.js';
import { buildCorroborationPool, poolCorroborates } from '../../dist/corroborate.js';

// The floor every confidence-driven decision in the pipeline uses
// (src/diagnostics.ts lowConfidenceThreshold; starvation denominators,
// low-confidence lists, cross-engine engagement).
const LOW_OCR_CONFIDENCE = 0.5;

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  throw new Error(`Missing required argument ${name}`);
}

function optionalArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

const results = JSON.parse(readFileSync(arg('--results'), 'utf8'));
const manifest = JSON.parse(readFileSync(arg('--manifest'), 'utf8'));
const runRoot = arg('--run-root');
const goldRoot = arg('--gold-root');
const serverObservationsPath = optionalArg('--server-observations');
const serverByPage = serverObservationsPath
  ? new Map(JSON.parse(readFileSync(serverObservationsPath, 'utf8')).perPage.map((entry) => [entry.page, entry.observations]))
  : null;

const manifestByPage = new Map(manifest.map((entry) => [entry.page, entry]));

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
  }
}

const recordIndex = new Map();
for (const doc of readdirSync(join(runRoot, 'documents'))) {
  let files;
  try { files = readdirSync(join(runRoot, 'documents', doc, 'pages')); } catch { continue; }
  for (const file of files) {
    const record = JSON.parse(readFileSync(join(runRoot, 'documents', doc, 'pages', file), 'utf8'));
    if (!record.pageSpatial) continue;
    recordIndex.set(`${record.objectId}#${record.pageNumber}`, record);
  }
}

function tokenOverlap(fromTexts, intoTexts) {
  const tokens = fromTexts.flatMap((text) => criticalTokens(text));
  if (!tokens.length) return { tokens: 0, matched: 0 };
  const pool = buildCorroborationPool(intoTexts);
  let matched = 0;
  for (const token of tokens) if (poolCorroborates(token, pool)) matched += 1;
  return { tokens: tokens.length, matched };
}

const normalize = (text) => text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();

function iou(a, b) {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]);
  const y1 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

// McNemar exact two-sided + Clopper-Pearson 95%, copied verbatim from
// witness-equivalence.mjs (validated there: 1v9 → 0.0215, 10v20 → 0.0987).
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

const quantiles = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const q = (f) => Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))].toFixed(4));
  return { p05: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95) };
};

const sum = (values) => values.reduce((a, b) => a + b, 0);
const perPage = [];
const allCandidateScores = [];
const allBrowserConfidences = [];
const allServerConfidences = [];
const allPairedDeltas = [];
for (const entry of results.perPage) {
  const record = recordIndex.get(entry.page);
  const meta = manifestByPage.get(entry.page);
  if (!record || !meta) throw new Error(`No run record or manifest entry for ${entry.page}`);
  const page = record.pageSpatial;
  const goldEntry = gold.get(entry.page);
  if (goldEntry && goldEntry.sha256 !== page.documentSha256) {
    throw new Error(`SHA-256 mismatch for ${entry.page}`);
  }
  // First-pass vs first-pass, same rule as the equivalence run.
  const firstPass = page.ocrObservations.filter((observation) => !observation.recoveryMethod);
  const browserTexts = firstPass.map((observation) => observation.text);
  const candidateTexts = entry.lines.map((line) => line.text);

  const browserIntoCandidate = tokenOverlap(browserTexts, candidateTexts);
  const candidateIntoBrowser = tokenOverlap(candidateTexts, browserTexts);

  // Box IoU on exact-normalized-text matches (best match per browser
  // observation; NOT consume-once — diagnostic only, same caveat as the
  // equivalence run). Candidate boxes arrive in render-pixel space; map to
  // record geometry via the manifest dims (rotation handled at render —
  // pages are upright, so this is a sub-percent rounding scale).
  const scaleX = meta.geometry.width / meta.pngWidth;
  const scaleY = meta.geometry.height / meta.pngHeight;
  const candidateByText = new Map();
  for (const line of entry.lines) {
    if (!line.box) continue;
    const norm = normalize(line.text);
    if (!norm) continue;
    const mapped = [line.box[0] * scaleX, line.box[1] * scaleY, line.box[2] * scaleX, line.box[3] * scaleY];
    (candidateByText.get(norm) ?? candidateByText.set(norm, []).get(norm)).push({ box: mapped, score: line.score });
  }
  const ious = [];
  const pairedConfidenceDeltas = [];
  for (const observation of firstPass) {
    const candidates = candidateByText.get(normalize(observation.text));
    if (!candidates?.length) continue;
    let best = null;
    for (const candidate of candidates) {
      const value = iou(observation.box, candidate.box);
      if (!best || value > best.value) best = { value, candidate };
    }
    if (best && best.value > 0) {
      ious.push(best.value);
      if (typeof best.candidate.score === 'number' && typeof observation.confidence === 'number') {
        pairedConfidenceDeltas.push(best.candidate.score - observation.confidence);
      }
    }
  }

  let goldRecall = null;
  const serverObservations = serverByPage?.get(entry.page) ?? null;
  if (serverByPage && !serverObservations) throw new Error(`--server-observations has no entry for ${entry.page}`);
  if (goldEntry?.tokens.length) {
    const browserPool = buildCorroborationPool(browserTexts);
    const candidatePool = buildCorroborationPool(candidateTexts);
    const serverPool = serverObservations
      ? buildCorroborationPool(serverObservations.map((observation) => observation.text))
      : null;
    let bothHit = 0, candidateOnly = 0, browserOnly = 0, bothMiss = 0;
    let serverHits = 0, candidateOnlyVsServer = 0, serverOnlyVsCandidate = 0;
    for (const token of goldEntry.tokens) {
      const inBrowser = poolCorroborates(token, browserPool);
      const inCandidate = poolCorroborates(token, candidatePool);
      if (inBrowser && inCandidate) bothHit += 1;
      else if (inCandidate) candidateOnly += 1;
      else if (inBrowser) browserOnly += 1;
      else bothMiss += 1;
      if (serverPool) {
        const inServer = poolCorroborates(token, serverPool);
        if (inServer) serverHits += 1;
        if (inCandidate && !inServer) candidateOnlyVsServer += 1;
        if (inServer && !inCandidate) serverOnlyVsCandidate += 1;
      }
    }
    goldRecall = {
      goldTokens: goldEntry.tokens.length,
      browser: bothHit + browserOnly,
      candidate: bothHit + candidateOnly,
      bothHit, candidateOnly, browserOnly, bothMiss,
      ...(serverPool ? { server: serverHits, candidateOnlyVsServer, serverOnlyVsCandidate } : {})
    };
  }
  if (serverObservations) {
    for (const observation of serverObservations) {
      if (typeof observation.confidence === 'number') allServerConfidences.push(observation.confidence);
    }
  }
  perPage.push({
    page: entry.page,
    ms: entry.ms,
    browserObservations: firstPass.length,
    candidateLines: entry.lines.length,
    browserTokensMatchedByCandidate: browserIntoCandidate,
    candidateTokensMatchedByBrowser: candidateIntoBrowser,
    exactTextMatches: ious.length,
    medianIou: ious.length ? Number(ious.sort((a, b) => a - b)[Math.floor(ious.length / 2)].toFixed(3)) : null,
    meanPairedConfidenceDelta: pairedConfidenceDeltas.length
      ? Number((pairedConfidenceDeltas.reduce((a, b) => a + b, 0) / pairedConfidenceDeltas.length).toFixed(4))
      : null,
    goldRecall
  });
  for (const line of entry.lines) if (typeof line.score === 'number') allCandidateScores.push(line.score);
  for (const observation of firstPass) if (typeof observation.confidence === 'number') allBrowserConfidences.push(observation.confidence);
  allPairedDeltas.push(...pairedConfidenceDeltas);
}

const goldPages = perPage.filter((p) => p.goldRecall);
const bIntoC = perPage.map((p) => p.browserTokensMatchedByCandidate);
const cIntoB = perPage.map((p) => p.candidateTokensMatchedByBrowser);
const timings = perPage.map((p) => p.ms).sort((a, b) => a - b);
console.log(JSON.stringify({
  method: 'candidate-witness-score-v2',
  config: results.config,
  versions: results.versions,
  resources: results.resources,
  deviceTruth: results.deviceTruth ?? null,
  pages: perPage.length,
  timings: {
    initS: results.initS,
    firstPageMs: results.firstPageMs,
    warmMsP50: Math.round(timings[Math.floor(timings.length / 2)]),
    warmMsP95: Math.round(timings[Math.floor(timings.length * 0.95)]),
    warmMsMean: Math.round(sum(timings) / timings.length)
  },
  criticalTokenAgreement: {
    browserTokensMatchedByCandidate: `${sum(bIntoC.map((x) => x.matched))}/${sum(bIntoC.map((x) => x.tokens))}`,
    candidateTokensMatchedByBrowser: `${sum(cIntoB.map((x) => x.matched))}/${sum(cIntoB.map((x) => x.tokens))}`
  },
  boxAgreement: {
    note: 'best-match on exact-normalized-text, not consume-once — diagnostic only, same caveat as witness-equivalence',
    exactTextMatches: sum(perPage.map((p) => p.exactTextMatches)),
    medianOfPageMedianIou: (() => {
      const values = perPage.map((p) => p.medianIou).filter((v) => v !== null).sort((a, b) => a - b);
      return values.length ? values[Math.floor(values.length / 2)] : null;
    })(),
    pagesWithMedianIouBelow08: perPage.filter((p) => p.medianIou !== null && p.medianIou < 0.8).map((p) => p.page)
  },
  calibration: {
    note: `mass below ${LOW_OCR_CONFIDENCE} is the operational number: it feeds starvation denominators, low-confidence lists, and cross-engine engagement (src/diagnostics.ts)`,
    candidateScores: {
      count: allCandidateScores.length,
      quantiles: quantiles(allCandidateScores),
      massBelowFloor: Number((allCandidateScores.filter((s) => s < LOW_OCR_CONFIDENCE).length / (allCandidateScores.length || 1)).toFixed(4))
    },
    browserConfidences: {
      count: allBrowserConfidences.length,
      quantiles: quantiles(allBrowserConfidences),
      massBelowFloor: Number((allBrowserConfidences.filter((s) => s < LOW_OCR_CONFIDENCE).length / (allBrowserConfidences.length || 1)).toFixed(4))
    },
    pairedDeltasOnMatches: {
      note: 'pairs inherit the box-IoU loop’s best-match (non-consume-once) pairing — same diagnostic-only caveat',
      count: allPairedDeltas.length,
      quantiles: quantiles(allPairedDeltas),
      mean: allPairedDeltas.length ? Number((sum(allPairedDeltas) / allPairedDeltas.length).toFixed(4)) : null
    },
    ...(allServerConfidences.length ? {
      serverWitnessConfidences: {
        count: allServerConfidences.length,
        quantiles: quantiles(allServerConfidences),
        massBelowFloor: Number((allServerConfidences.filter((s) => s < LOW_OCR_CONFIDENCE).length / allServerConfidences.length).toFixed(4))
      }
    } : {})
  },
  goldRecall: {
    pages: goldPages.length,
    goldTokens: sum(goldPages.map((p) => p.goldRecall.goldTokens)),
    browser: sum(goldPages.map((p) => p.goldRecall.browser)),
    candidate: sum(goldPages.map((p) => p.goldRecall.candidate)),
    candidateOnly: sum(goldPages.map((p) => p.goldRecall.candidateOnly)),
    browserOnly: sum(goldPages.map((p) => p.goldRecall.browserOnly)),
    bothMiss: sum(goldPages.map((p) => p.goldRecall.bothMiss))
  },
  goldDiscordance: (() => {
    const candidateOnly = sum(goldPages.map((p) => p.goldRecall.candidateOnly));
    const browserOnly = sum(goldPages.map((p) => p.goldRecall.browserOnly));
    const discordant = candidateOnly + browserOnly;
    const goldTokens = sum(goldPages.map((p) => p.goldRecall.goldTokens));
    const p = mcNemarExactTwoSided(candidateOnly, browserOnly);
    const [lo, hi] = clopperPearson95(candidateOnly, discordant);
    const diffLow = Math.round(discordant * (2 * lo - 1));
    const diffHigh = Math.round(discordant * (2 * hi - 1));
    return {
      candidateOnly,
      browserOnly,
      mcNemarExactTwoSidedP: Number(p.toFixed(4)),
      candidateShareOfDiscordantsCI95: [Number(lo.toFixed(3)), Number(hi.toFixed(3))],
      trueDifferenceTokensCI95: [diffLow, diffHigh],
      note: `Conditional on ${discordant} discordant tokens of ${goldTokens}: the data are consistent with a true candidate-minus-browser difference between ${diffLow} and ${diffHigh} tokens at 95%.`
    };
  })(),
  ...(serverByPage ? {
    goldDiscordanceVsServerWitness: (() => {
      const withServer = goldPages.filter((p) => p.goldRecall.server !== undefined);
      const candidateOnly = sum(withServer.map((p) => p.goldRecall.candidateOnlyVsServer));
      const serverOnly = sum(withServer.map((p) => p.goldRecall.serverOnlyVsCandidate));
      const discordant = candidateOnly + serverOnly;
      const goldTokens = sum(withServer.map((p) => p.goldRecall.goldTokens));
      const serverHits = sum(withServer.map((p) => p.goldRecall.server));
      const p = mcNemarExactTwoSided(candidateOnly, serverOnly);
      const [lo, hi] = clopperPearson95(candidateOnly, discordant);
      const diffLow = Math.round(discordant * (2 * lo - 1));
      const diffHigh = Math.round(discordant * (2 * hi - 1));
      return {
        serverGoldHits: serverHits,
        candidateOnly,
        serverOnly,
        mcNemarExactTwoSidedP: Number(p.toFixed(4)),
        trueDifferenceTokensCI95: [diffLow, diffHigh],
        note: `Conditional on ${discordant} discordant tokens of ${goldTokens}: the data are consistent with a true candidate-minus-server difference between ${diffLow} and ${diffHigh} tokens at 95%.`
      };
    })()
  } : {}),
  perPage
}, null, 1));
