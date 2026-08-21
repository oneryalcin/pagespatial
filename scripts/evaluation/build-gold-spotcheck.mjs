/**
 * Builds a spot-check page: a small random sample of already-verified gold
 * tokens, re-presented for a careful second reading.
 *
 * Why this exists. A verdict file cannot distinguish a token someone read
 * from one they clicked past — both export as "correct". That matters most
 * when a batch comes back with no disagreements at all: either the
 * pre-labeler is better than its measured precision, or part of the pass was
 * a rubber stamp, and the export looks identical either way. Re-reading a
 * random slice separates the two for a few minutes of work.
 *
 * Sampling is over tokens that actually score — proposals that tokenize to
 * nothing are excluded, since confirming them proves nothing — and is seeded,
 * so the same batch and seed always yield the same slice.
 *
 * Each row is shown as a magnified crop centred on the token's own box, which
 * is the point: this pass is meant to be read, not skimmed.
 *
 * Adjudications (--adjudications N) are audited BLIND: the page shows the two
 * witness readings, unlabelled as to engine, and never the machine's verdict.
 * An auditor shown the answer they are checking will anchor to it, which is
 * the failure the audit exists to detect. The recorded verdict is rejoined
 * from proposals when the export is folded in.
 *
 * Usage:
 *   node scripts/evaluation/build-gold-spotcheck.mjs \
 *     --gold-dir .evaluation/gold/<batch-id>[,<batch-id>...] \
 *     --output <path>/spotcheck.html \
 *     [--size 30] [--adjudications 0] [--seed 1]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { criticalTokens } from '../../dist/text.js';
import { normalizeTokenBox } from './lib/gold-box.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument ${name}`);
}

const goldDir = arg('--gold-dir');
const outputPath = arg('--output');
const size = Number(arg('--size', '30'));
const adjudicationSize = Number(arg('--adjudications', '0'));
const runRoot = arg('--run-root', '');
const seed = Number(arg('--seed', '1'));

// Comma-separated dirs: a ledger claim spans every batch that fed it, so an
// audit of that claim has to sample the same span. Row 4's 272 adjudications
// live across two batches; sampling one of them would audit half a number.
const goldDirs = goldDir.split(',').map((entry) => entry.trim()).filter(Boolean);
const proposalByPage = new Map();
const verdicts = { pages: [] };
for (const dir of goldDirs) {
  for (const page of JSON.parse(readFileSync(join(dir, 'proposals.json'), 'utf8'))) {
    proposalByPage.set(`${page.objectId}#${page.pageNumber}`, page);
  }
  verdicts.pages.push(...JSON.parse(readFileSync(join(dir, 'gold-verdicts.json'), 'utf8')).pages);
}

// Only human-tier rows are worth re-reading: silver was never a human's
// judgement, and bulk already declares itself unread.
const HUMAN_VERDICTS = ['correct', 'edited'];
const population = [];
for (const page of verdicts.pages) {
  const proposal = proposalByPage.get(`${page.objectId}#${page.pageNumber}`);
  if (!proposal) throw new Error(`No proposal for ${page.objectId} p${page.pageNumber}`);
  const proposalTokens = proposal.proposal.criticalTokens ?? [];
  for (const token of page.tokens) {
    if (!HUMAN_VERDICTS.includes(token.verdict)) continue;
    const text = (token.verdict === 'edited' && token.text) ? token.text : proposalTokens[token.index]?.text;
    if (!text || criticalTokens(text).length === 0) continue;
    population.push({
      objectId: page.objectId,
      pageNumber: page.pageNumber,
      index: token.index,
      verdict: token.verdict,
      text,
      box: normalizeTokenBox(proposalTokens[token.index] ?? {})?.box ?? null,
      image: proposal.image
    });
  }
}

/**
 * The disputed region spanning BOTH witnesses, in 0-1000 page space.
 *
 * The proposal's own box is the OCR observation's extent. On a symbol-only
 * conflict that frames precisely what OCR read — "$ 442,952" — so the
 * reading whose extent drew the box is the one that appears to match it, and
 * a blind auditor is answering a question the highlight already decided.
 * Spanning both witnesses marks the disputed region instead of one side's
 * answer. Needs --run-root; without it the OCR box is used and the bias is
 * declared in the report rather than hidden.
 */
const conflictBoxes = new Map();
if (runRoot) {
  const documentsRoot = join(runRoot, 'documents');
  for (const doc of readdirSync(documentsRoot)) {
    let pages;
    try { pages = readdirSync(join(documentsRoot, doc, 'pages')); } catch { continue; }
    for (const file of pages) {
      const record = JSON.parse(readFileSync(join(documentsRoot, doc, 'pages', file), 'utf8'));
      const spatial = record.pageSpatial;
      if (!spatial) continue;
      const { width, height } = spatial.geometry;
      const boxById = new Map();
      for (const observation of [...spatial.nativeObservations, ...spatial.ocrObservations]) {
        boxById.set(observation.id, observation.box);
      }
      const normalize = (boxes) => {
        const parts = boxes.filter(Boolean);
        if (!parts.length) return null;
        const x0 = Math.min(...parts.map((b) => b[0]));
        const y0 = Math.min(...parts.map((b) => b[1]));
        const x1 = Math.max(...parts.map((b) => b[2]));
        const y1 = Math.max(...parts.map((b) => b[3]));
        return [y0 / height * 1000, x0 / width * 1000, y1 / height * 1000, x1 / width * 1000];
      };
      for (const conflict of spatial.conflicts ?? []) {
        // Each witness keeps its OWN extent. Merging them into one highlight
        // makes whichever reading spans more of the page look correct — the
        // mirror of framing the region with the OCR box alone. Drawn side by
        // side, a reading that merged two columns is visible as one.
        const ocr = normalize([boxById.get(conflict.ocrId)]);
        const native = normalize((conflict.nativeIds ?? []).map((id) => boxById.get(id)));
        if (!ocr && !native) continue;
        conflictBoxes.set(`${record.objectId}#${record.pageNumber}#${conflict.id}`, {
          ocr, native, union: normalize([boxById.get(conflict.ocrId), ...(conflict.nativeIds ?? []).map((id) => boxById.get(id))])
        });
      }
    }
  }
}
const neutralBox = (objectId, pageNumber, conflictId) =>
  conflictBoxes.get(`${objectId}#${pageNumber}#${conflictId}`) ?? null;

// Adjudications are audited BLIND: the page never shows the machine's verdict
// or its transcription, only the two witness readings and the ink. Row 4
// stands at 272 consecutive confirmations, and an auditor shown the answer
// they are checking will anchor to it — which is the very failure the audit
// exists to detect. The recorded verdict is deliberately absent from the
// generated page and is rejoined from proposals at fold-in time.
const adjudicationPopulation = [];
for (const page of verdicts.pages) {
  const proposal = proposalByPage.get(`${page.objectId}#${page.pageNumber}`);
  const adjudications = proposal?.conflictAdjudications ?? [];
  for (const [conflictIndex, conflict] of (page.conflicts ?? []).entries()) {
    if (!conflict.verdict || conflict.verdict === 'unreviewed') continue;
    const source = adjudications[conflictIndex];
    if (!source) continue;
    // Two very different jobs hide under one count. When both readings carry
    // the same digits the disagreement is a currency symbol landing on one
    // side or the other, and either verdict preserves the number; when the
    // digits differ, a wrong verdict puts a wrong figure in the index. Across
    // batches 3-4 the split is 172 / 100, so an unstratified sample would
    // spend two thirds of a human's attention on the easy class and report
    // the result as one accuracy figure. Recorded per row, never displayed —
    // it is derivable from the two readings the auditor already sees.
    const digitsOf = (text) => (String(text ?? '').match(/\d/gu) ?? []).join('');
    adjudicationPopulation.push({
      objectId: page.objectId,
      pageNumber: page.pageNumber,
      conflictIndex,
      conflictId: conflict.id,
      nativeText: source.nativeText,
      ocrText: source.ocrText,
      digitsDiffer: digitsOf(source.nativeText) !== digitsOf(source.ocrText),
      // The proposal's own box is the OCR observation's extent, which on a
      // symbol-only conflict frames exactly what OCR read ("$ 442,952") and
      // makes that reading correct by construction. neutralBox spans both
      // witnesses instead, so the highlight marks the disputed region rather
      // than one side's answer.
      box: neutralBox(page.objectId, page.pageNumber, conflict.id)?.union ?? source.normalizedBox ?? null,
      witnessBoxes: neutralBox(page.objectId, page.pageNumber, conflict.id) ?? null,
      image: proposal.image
    });
  }
}

if (!population.length) throw new Error('No scoring human-tier tokens to spot-check.');

// Deterministic sample: a seeded LCG shuffle. Math.random would make the
// slice unreproducible, and a disputed spot-check nobody can regenerate is
// worth very little.
let state = (seed * 1103515245 + 12345) >>> 0;
const nextRandom = () => {
  state = (state * 1103515245 + 12345) >>> 0;
  return state / 0x100000000;
};
function shuffle(items) {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(nextRandom() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
const sample = shuffle(population).slice(0, Math.min(size, population.length));
// Stratified half and half, so the class that can put a wrong number in the
// index is not drowned out by the class that cannot.
function stratifiedAdjudications(count) {
  if (!count) return [];
  const real = shuffle(adjudicationPopulation.filter((item) => item.digitsDiffer));
  const benign = shuffle(adjudicationPopulation.filter((item) => !item.digitsDiffer));
  const wantReal = Math.min(real.length, Math.ceil(count / 2));
  const wantBenign = Math.min(benign.length, count - wantReal);
  // Whichever side runs out, the other backfills rather than shrinking the sample.
  const picked = [...real.slice(0, wantReal), ...benign.slice(0, wantBenign)];
  const shortfall = count - picked.length;
  if (shortfall > 0) picked.push(...real.slice(wantReal, wantReal + shortfall), ...benign.slice(wantBenign, wantBenign + shortfall));
  return shuffle(picked.slice(0, count));
}
const adjudicationSample = stratifiedAdjudications(adjudicationSize);

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

const imageCache = new Map();
const image = (path) => {
  if (!imageCache.has(path)) {
    const buffer = readFileSync(path);
    // PNG IHDR: 8-byte signature, 4-byte length, 'IHDR', then width/height
    // big-endian. Cheaper and more honest than guessing an aspect ratio.
    if (buffer.readUInt32BE(12) !== 0x49484452) throw new Error(`${path} is not a PNG.`);
    imageCache.set(path, {
      data: buffer.toString('base64'),
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    });
  }
  return imageCache.get(path);
};

// Magnification: show a window this fraction of the page width around the
// token, so a misread digit is visible rather than merely present.
const WINDOW_FRACTION = 0.22;
const VIEW_WIDTH = 460;
const VIEW_HEIGHT = 120;

/**
 * The magnified crop, framed on `item.box`, with the region outlined.
 * `extraMarks` draws additional boxes in the same coordinate space — used to
 * show each witness's own extent rather than a single merged highlight.
 */
function cropCell(item, caption, extraMarks = []) {
  const page = image(item.image);
  // No usable box: show the whole page, fitted, and say plainly that it is
  // unlocated. Centring on a guess would be worse than useless — it would
  // point confidently at the wrong ink.
  if (!item.box) {
    return `<div class="view unlocated">
        <img src="data:image/png;base64,${page.data}" style="width:${VIEW_WIDTH}px;left:0;top:0">
        <div class="warn">no box from the pre-labeler — find this on the page yourself</div>
      </div>
      <div class="src">${caption}</div>`;
  }
  const [y0, x0, y1, x1] = item.box;
  // Magnify as far as WINDOW_FRACTION allows, but never past the point where
  // the region stops fitting in the window. A fixed zoom silently crops long
  // regions, and on a conflict the distinguishing text is usually at one end
  // of the line — the leading figure in "5 months of transportation…" is
  // exactly what a fixed 22% window cuts off, leaving an auditor to judge a
  // disagreement they cannot see.
  const aspect = page.height / page.width;
  const boxFractionWidth = Math.max((x1 - x0) / 1000, 1e-4);
  const boxFractionHeight = Math.max((y1 - y0) / 1000, 1e-4);
  const scaledWidth = Math.min(
    VIEW_WIDTH / WINDOW_FRACTION,
    (VIEW_WIDTH * 0.92) / boxFractionWidth,
    (VIEW_HEIGHT * 0.92) / (boxFractionHeight * aspect)
  );
  const scaledHeight = scaledWidth * aspect;
  const left = (x0 / 1000) * scaledWidth;
  const top = (y0 / 1000) * scaledHeight;
  const width = Math.max(((x1 - x0) / 1000) * scaledWidth, 3);
  const height = Math.max(((y1 - y0) / 1000) * scaledHeight, 3);
  const offsetLeft = VIEW_WIDTH / 2 - (left + width / 2);
  const offsetTop = VIEW_HEIGHT / 2 - (top + height / 2);
  const place = (box, className) => {
    const [by0, bx0, by1, bx1] = box;
    const l = (bx0 / 1000) * scaledWidth + offsetLeft;
    const t = (by0 / 1000) * scaledHeight + offsetTop;
    const w = Math.max(((bx1 - bx0) / 1000) * scaledWidth, 3);
    const h = Math.max(((by1 - by0) / 1000) * scaledHeight, 3);
    return `<div class="${className}" style="left:${l.toFixed(1)}px;top:${t.toFixed(1)}px;width:${w.toFixed(1)}px;height:${h.toFixed(1)}px"></div>`;
  };
  const marks = extraMarks.length
    ? extraMarks.filter((entry) => entry.box).map((entry) => place(entry.box, entry.className)).join('')
    : `<div class="mark" style="left:${(left + offsetLeft).toFixed(1)}px;top:${(top + offsetTop).toFixed(1)}px;width:${width.toFixed(1)}px;height:${height.toFixed(1)}px"></div>`;
  return `<div class="view">
        <img src="data:image/png;base64,${page.data}" style="width:${scaledWidth.toFixed(1)}px;left:${offsetLeft.toFixed(1)}px;top:${offsetTop.toFixed(1)}px">
        ${marks}
      </div>
      <div class="src">${caption}</div>`;
}

const rows = sample.map((item, sampleIndex) => `
  <tr>
    <td class="n">${sampleIndex + 1}</td>
    <td class="crop">${cropCell(item, `${escapeHtml(item.objectId)} p${item.pageNumber} · token ${item.index}`)}</td>
    <td class="text">${escapeHtml(item.text)}</td>
    <td class="verdict">
      <label><input type="radio" name="s-${sampleIndex}" value="agree">matches</label>
      <label><input type="radio" name="s-${sampleIndex}" value="disagree">does NOT match</label>
      <input type="text" id="fix-${sampleIndex}" placeholder="what it actually says">
    </td>
  </tr>`).join('');

// Presentation order is randomised per row. Listing native first every time
// makes the position a tell — and since the OCR reading is the one that used
// to draw the highlight box, "B" was usually the answer. Order is part of the
// blind, not decoration.
for (const item of adjudicationSample) item.ocrFirst = nextRandom() < 0.5;

const adjudicationRows = adjudicationSample.map((item, index) => {
  const first = item.ocrFirst
    ? { label: 'ocr', text: item.ocrText }
    : { label: 'native', text: item.nativeText };
  const second = item.ocrFirst
    ? { label: 'native', text: item.nativeText }
    : { label: 'ocr', text: item.ocrText };
  const marks = [
    { box: item.witnessBoxes?.[first.label], className: 'mark markA' },
    { box: item.witnessBoxes?.[second.label], className: 'mark markB' }
  ];
  return `
  <tr>
    <td class="n">${index + 1}</td>
    <td class="crop">${cropCell(item, `${escapeHtml(item.objectId)} p${item.pageNumber} · conflict ${item.conflictIndex}`, marks)}</td>
    <td class="readings">
      <div><b class="keyA">A</b> <code>${escapeHtml(first.text)}</code></div>
      <div><b class="keyB">B</b> <code>${escapeHtml(second.text)}</code></div>
    </td>
    <td class="verdict">
      <label><input type="radio" name="a-${index}" value="${first.label}">A matches the ink</label>
      <label><input type="radio" name="a-${index}" value="${second.label}">B matches the ink</label>
      <label><input type="radio" name="a-${index}" value="different-regions">they cover different regions</label>
      <label><input type="radio" name="a-${index}" value="both-wrong">neither matches</label>
      <label><input type="radio" name="a-${index}" value="unsure">can't tell</label>
      <input type="text" id="ink-${index}" placeholder="what the ink says, verbatim">
    </td>
  </tr>`;
}).join('');

const adjudicationSection = adjudicationSample.length ? `
<h1>Adjudications — ${adjudicationSample.length} of ${adjudicationPopulation.length}</h1>
<p class="lead">Two extractors disagreed here. Read the ink and say which reading is
right — <b>A</b> and <b>B</b> are unlabelled as to engine <em>and shuffled per
row</em>, and the machine's verdict is not shown, so this is an independent
judgement rather than a review of one. Each reading's own extent is outlined in
its colour — <b class="keyA">A solid blue</b>, <b class="keyB">B dashed
orange</b> — so a reading that swallowed a neighbouring block shows as a box
that covers more than it should.</p>
<p class="lead"><b>Which option:</b> if one box sits inside the other on the same
line or cell — usually one reading keeping a currency symbol the other dropped —
that is the same content at two extents, so pick whichever transcribes the ink
in that region more faithfully. Reserve <b>they cover different regions</b> for
boxes reaching into separate lines, cells or columns: that is a segmentation
failure rather than a transcription one, and the two need separating. "Can't
tell" is a legitimate answer.</p>
<table>${adjudicationRows}</table>
` : '';

const html = `<!doctype html><meta charset="utf-8"><title>Gold spot-check</title>
<style>
body{font:14px/1.5 -apple-system,sans-serif;margin:0;padding:1rem;background:#fafafa;color:#111}
table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #ddd}
td{border-top:1px solid #eee;padding:.5rem;vertical-align:middle}
td.n{width:2rem;color:#888}
.view{position:relative;overflow:hidden;width:${VIEW_WIDTH}px;height:${VIEW_HEIGHT}px;border:1px solid #ccc;background:#fff}
.view img{position:absolute;max-width:none}
.mark{position:absolute;border:2px solid #06c;background:rgba(0,102,204,.10);pointer-events:none}
.markA{border-color:#06c;background:rgba(0,102,204,.10)}
.markB{border-color:#d17000;background:rgba(209,112,0,.10);border-style:dashed}
.keyA{color:#06c}
.keyB{color:#d17000}
.view.unlocated{border-color:#c00;height:200px}
.warn{position:absolute;left:0;right:0;bottom:0;background:rgba(204,0,0,.85);color:#fff;font-size:11px;padding:.2rem .4rem}
.src{font-size:11px;color:#888;margin-top:.2rem}
td.text{font:15px/1.4 ui-monospace,Menlo,monospace;white-space:pre;background:#f6f8fa;padding:.4rem .6rem}
td.verdict label{display:block;font-size:13px}
td.verdict input[type=text]{margin-top:.3rem;width:14rem;font:13px ui-monospace,Menlo,monospace}
td.readings{font:13px/1.7 ui-monospace,Menlo,monospace;background:#f6f8fa;padding:.4rem .6rem}
td.readings code{background:#fff;border:1px solid #ddd;padding:.05rem .3rem;border-radius:3px}
button{position:fixed;right:1rem;bottom:1rem;padding:.6rem 1rem;font-size:14px;background:#06c;color:#fff;border:0;border-radius:6px}
h1{font-size:18px}
p.lead{color:#555;max-width:60rem}
</style>
${sample.length ? `<h1>Gold spot-check — ${sample.length} of ${population.length} scoring human-tier tokens</h1>
<p class="lead">Read the crop, not the transcription. Mark <b>matches</b> only if the
printed ink says exactly what the middle column says. This slice is seeded
(<code>--seed ${seed}</code>), so it can be regenerated and disputed later.</p>
<table>${rows}</table>` : ''}
${adjudicationSection}
<button type="button" onclick="exportSpotcheck()">Export spot-check</button>
<script>
const SAMPLE = ${JSON.stringify(sample.map(({ image, ...rest }) => rest))};
// Carries no machine verdict by design — see the blind-audit note in the
// generator. The recorded verdict is rejoined from proposals at fold-in.
const ADJUDICATIONS = ${JSON.stringify(adjudicationSample.map(({ image, ...rest }) => rest))};
function exportSpotcheck(){
  const rows = SAMPLE.map((item, sampleIndex) => ({
    ...item,
    spotcheck: document.querySelector('input[name="s-' + sampleIndex + '"]:checked')?.value ?? 'unreviewed',
    actualText: document.getElementById('fix-' + sampleIndex).value.trim() || null
  }));
  const adjudications = ADJUDICATIONS.map((item, index) => ({
    ...item,
    independentVerdict: document.querySelector('input[name="a-' + index + '"]:checked')?.value ?? 'unreviewed',
    inkText: document.getElementById('ink-' + index).value.trim() || null
  }));
  const disagreements = rows.filter(r => r.spotcheck === 'disagree').length;
  const unreviewed = rows.filter(r => r.spotcheck === 'unreviewed').length;
  const payload = {goldSpotcheckSchemaVersion: 'gold-spotcheck-v2', seed: ${seed},
    population: ${population.length}, sampled: rows.length, disagreements, unreviewed,
    adjudicationPopulation: ${adjudicationPopulation.length}, adjudications,
    checkedAt: new Date().toISOString(), rows};
  const blob = new Blob([JSON.stringify(payload, null, 1)], {type: 'application/json'});
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'gold-spotcheck.json';
  link.click();
}
</script>`;

const inlineScript = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1];
try {
  new Function(inlineScript);
} catch (error) {
  throw new Error(`Generated spot-check script does not parse (${error.message}).`);
}

writeFileSync(outputPath, html);
console.log(`Wrote ${outputPath} — ${sample.length} of ${population.length} scoring human-tier tokens`
  + (adjudicationSample.length ? `, ${adjudicationSample.length} of ${adjudicationPopulation.length} adjudications (blind)` : '')
  + ` (seed ${seed}).`);
