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
 * Usage:
 *   node scripts/evaluation/build-gold-spotcheck.mjs \
 *     --gold-dir .evaluation/gold/<batch-id> \
 *     --output .evaluation/gold/<batch-id>/spotcheck.html \
 *     [--size 30] [--seed 1]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { criticalTokens } from '../../dist/text.js';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument ${name}`);
}

const goldDir = arg('--gold-dir');
const outputPath = arg('--output');
const size = Number(arg('--size', '30'));
const seed = Number(arg('--seed', '1'));

const proposals = JSON.parse(readFileSync(join(goldDir, 'proposals.json'), 'utf8'));
const verdicts = JSON.parse(readFileSync(join(goldDir, 'gold-verdicts.json'), 'utf8'));
const proposalByPage = new Map(proposals.map((page) => [`${page.objectId}#${page.pageNumber}`, page]));

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
      box: proposalTokens[token.index]?.box_2d,
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
const shuffled = [...population];
for (let i = shuffled.length - 1; i > 0; i -= 1) {
  const j = Math.floor(nextRandom() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
const sample = shuffled.slice(0, Math.min(size, shuffled.length));

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

const rows = sample.map((item, sampleIndex) => {
  const [y0, x0, y1, x1] = item.box ?? [0, 0, 1000, 1000];
  const page = image(item.image);
  // Scale the page so VIEW_WIDTH covers WINDOW_FRACTION of it, then shift the
  // token's centre to the middle of the window. Positioning the image
  // absolutely (rather than as a background) means the highlight box lands in
  // the same coordinate space — exactly, not approximately.
  const scaledWidth = VIEW_WIDTH / WINDOW_FRACTION;
  const scaledHeight = scaledWidth * (page.height / page.width);
  const tokenLeft = (x0 / 1000) * scaledWidth;
  const tokenTop = (y0 / 1000) * scaledHeight;
  const tokenWidth = Math.max(((x1 - x0) / 1000) * scaledWidth, 3);
  const tokenHeight = Math.max(((y1 - y0) / 1000) * scaledHeight, 3);
  const offsetLeft = VIEW_WIDTH / 2 - (tokenLeft + tokenWidth / 2);
  const offsetTop = VIEW_HEIGHT / 2 - (tokenTop + tokenHeight / 2);
  return `
  <tr>
    <td class="n">${sampleIndex + 1}</td>
    <td class="crop">
      <div class="view">
        <img src="data:image/png;base64,${page.data}" style="width:${scaledWidth.toFixed(1)}px;left:${offsetLeft.toFixed(1)}px;top:${offsetTop.toFixed(1)}px">
        <div class="mark" style="left:${(tokenLeft + offsetLeft).toFixed(1)}px;top:${(tokenTop + offsetTop).toFixed(1)}px;width:${tokenWidth.toFixed(1)}px;height:${tokenHeight.toFixed(1)}px"></div>
      </div>
      <div class="src">${escapeHtml(item.objectId)} p${item.pageNumber} · token ${item.index}</div>
    </td>
    <td class="text">${escapeHtml(item.text)}</td>
    <td class="verdict">
      <label><input type="radio" name="s-${sampleIndex}" value="agree">matches</label>
      <label><input type="radio" name="s-${sampleIndex}" value="disagree">does NOT match</label>
      <input type="text" id="fix-${sampleIndex}" placeholder="what it actually says">
    </td>
  </tr>`;
}).join('');

const html = `<!doctype html><meta charset="utf-8"><title>Gold spot-check</title>
<style>
body{font:14px/1.5 -apple-system,sans-serif;margin:0;padding:1rem;background:#fafafa;color:#111}
table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #ddd}
td{border-top:1px solid #eee;padding:.5rem;vertical-align:middle}
td.n{width:2rem;color:#888}
.view{position:relative;overflow:hidden;width:${VIEW_WIDTH}px;height:${VIEW_HEIGHT}px;border:1px solid #ccc;background:#fff}
.view img{position:absolute;max-width:none}
.mark{position:absolute;border:2px solid #06c;background:rgba(0,102,204,.10);pointer-events:none}
.src{font-size:11px;color:#888;margin-top:.2rem}
td.text{font:15px/1.4 ui-monospace,Menlo,monospace;white-space:pre;background:#f6f8fa;padding:.4rem .6rem}
td.verdict label{display:block;font-size:13px}
td.verdict input[type=text]{margin-top:.3rem;width:14rem;font:13px ui-monospace,Menlo,monospace}
button{position:fixed;right:1rem;bottom:1rem;padding:.6rem 1rem;font-size:14px;background:#06c;color:#fff;border:0;border-radius:6px}
h1{font-size:18px}
p.lead{color:#555;max-width:60rem}
</style>
<h1>Gold spot-check — ${sample.length} of ${population.length} scoring human-tier tokens</h1>
<p class="lead">Read the crop, not the transcription. Mark <b>matches</b> only if the
printed ink says exactly what the middle column says. This slice is seeded
(<code>--seed ${seed}</code>), so it can be regenerated and disputed later.</p>
<table>${rows}</table>
<button type="button" onclick="exportSpotcheck()">Export spot-check</button>
<script>
const SAMPLE = ${JSON.stringify(sample.map(({ image, ...rest }) => rest))};
function exportSpotcheck(){
  const rows = SAMPLE.map((item, sampleIndex) => ({
    ...item,
    spotcheck: document.querySelector('input[name="s-' + sampleIndex + '"]:checked')?.value ?? 'unreviewed',
    actualText: document.getElementById('fix-' + sampleIndex).value.trim() || null
  }));
  const disagreements = rows.filter(r => r.spotcheck === 'disagree').length;
  const unreviewed = rows.filter(r => r.spotcheck === 'unreviewed').length;
  const payload = {goldSpotcheckSchemaVersion: 'gold-spotcheck-v1', seed: ${seed},
    population: ${population.length}, sampled: rows.length, disagreements, unreviewed, checkedAt: new Date().toISOString(), rows};
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
console.log(`Wrote ${outputPath} — ${sample.length} of ${population.length} scoring human-tier tokens (seed ${seed}).`);
