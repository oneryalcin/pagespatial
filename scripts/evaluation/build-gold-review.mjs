/**
 * Builds a self-contained review.html from prelabel-gold-pilot.mjs output.
 *
 * The human verifier marks every proposed label correct / wrong / edited and
 * every conflict adjudication confirmed / overruled, then clicks "Export
 * verdicts" to download a gold-verdicts JSON. That exported file — not the
 * machine proposal — is the gold input for the evaluator.
 *
 * With --run-root, tokens corroborated by the page's NATIVE text layer —
 * compatible token AND overlapping position, each native occurrence consumed
 * at most once — are tier-marked "auto" (SILVER tier, collapsed by default).
 * Silver labels are not independent of the native engine and the evaluator
 * reports them separately from human-verified gold. OCR agreement
 * deliberately does not corroborate — it shares the pre-labeler's vision
 * failure modes. Every non-corroborated row must be explicitly marked by the
 * human; the evaluator rejects unreviewed rows, so a do-nothing export
 * cannot silently agree with the machine.
 *
 * Usage:
 *   node scripts/evaluation/build-gold-review.mjs \
 *     --proposals .evaluation/gold/<pilot-id>/proposals.json \
 *     [--run-root .evaluation/runs/<run-id>] \
 *     --output .evaluation/gold/<pilot-id>/review.html
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { criticalTokens, criticalTokensCompatible } from '../../dist/text.js';

function arg(name, optional) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (optional) return undefined;
  throw new Error(`Missing required argument ${name}`);
}

const proposalsPath = arg('--proposals');
const outputPath = arg('--output');
const runRoot = arg('--run-root', true);
const proposals = JSON.parse(readFileSync(proposalsPath, 'utf8'));

const nativePools = new Map();
if (runRoot) {
  const documentsRoot = join(runRoot, 'documents');
  for (const doc of readdirSync(documentsRoot)) {
    let pages;
    try { pages = readdirSync(join(documentsRoot, doc, 'pages')); } catch { continue; }
    for (const file of pages) {
      const record = JSON.parse(readFileSync(join(documentsRoot, doc, 'pages', file), 'utf8'));
      if (!record.pageSpatial) continue;
      const { width, height } = record.pageSpatial.geometry;
      // Pool entries carry the observation box normalized to the review UI's
      // 0-1000 [ymin,xmin,ymax,xmax] space so corroboration is position-aware.
      const entries = record.pageSpatial.nativeObservations.flatMap((observation) => {
        const [x0, y0, x1, y1] = observation.box;
        const box = [y0 / height * 1000, x0 / width * 1000, y1 / height * 1000, x1 / width * 1000];
        return criticalTokens(observation.text).map((token) => ({ token, box }));
      });
      nativePools.set(`${record.objectId}#${record.pageNumber}`, entries);
    }
  }
}

function boxesOverlap(a, b) {
  if (!a || !b) return false;
  return Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1]);
}

// Position-aware, occurrence-consuming: each native occurrence corroborates
// at most one proposal, and only where the boxes overlap — a duplicate or
// mislocated proposal cannot borrow support from elsewhere on the page.
function corroborated(pageKey, text, proposalBox) {
  const pool = nativePools.get(pageKey);
  if (!pool) return false;
  const needle = criticalTokens(text);
  if (!needle.length) return false;
  const taken = [];
  for (const token of needle) {
    const index = pool.findIndex((entry) =>
      criticalTokensCompatible(entry.token, token) && boxesOverlap(entry.box, proposalBox));
    if (index < 0) {
      pool.push(...taken);
      return false;
    }
    taken.push(pool.splice(index, 1)[0]);
  }
  return true;
}

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const pagesHtml = proposals.map((page, pageIndex) => {
  const pageKey = `${page.objectId}#${page.pageNumber}`;
  const imageBase64 = readFileSync(page.image).toString('base64');
  const tokens = (page.proposal.criticalTokens ?? []).map((token) => ({
    ...token,
    auto: corroborated(pageKey, token.text, token.box_2d)
  }));
  const boxes = tokens.map((token, tokenIndex) => {
    const [y0, x0, y1, x1] = token.box_2d ?? [0, 0, 0, 0];
    return `<div class="box${token.auto ? ' auto' : ''}" id="box-${pageIndex}-${tokenIndex}" style="top:${y0 / 10}%;left:${x0 / 10}%;height:${(y1 - y0) / 10}%;width:${(x1 - x0) / 10}%"><span>${tokenIndex}</span></div>`;
  }).join('');
  const row = (token, tokenIndex) => `
    <tr data-page="${pageIndex}" data-token="${tokenIndex}" onmouseover="hl(${pageIndex},${tokenIndex},1)" onmouseout="hl(${pageIndex},${tokenIndex},0)">
      <td>${tokenIndex}</td>
      <td class="text" contenteditable="true">${escapeHtml(token.text)}</td>
      <td><label><input type="radio" name="t-${pageIndex}-${tokenIndex}" value="${token.auto ? 'auto' : 'correct'}"${token.auto ? ' checked' : ''}>${token.auto ? 'auto' : 'ok'}</label>
          <label><input type="radio" name="t-${pageIndex}-${tokenIndex}" value="wrong">wrong</label>
          <label><input type="radio" name="t-${pageIndex}-${tokenIndex}" value="edited">edited</label></td>
    </tr>`;
  const reviewRows = tokens.map((token, tokenIndex) => token.auto ? '' : row(token, tokenIndex)).join('');
  const autoRows = tokens.map((token, tokenIndex) => token.auto ? row(token, tokenIndex) : '').join('');
  const autoCount = tokens.filter((token) => token.auto).length;
  const tokenRows = `${reviewRows}` + (autoCount ? `
    <tr><td colspan="3"><details><summary>${autoCount} corroborated by the native text layer — auto-accepted (open to override)</summary>
      <table>${autoRows}</table></details></td></tr>` : '');
  const chartRows = (page.proposal.chartRelations ?? []).map((relation, relationIndex) => `
    <tr><td>${relationIndex}</td><td>${escapeHtml(relation.series)}</td><td>${escapeHtml(relation.category)}</td>
        <td class="text" id="cv-${pageIndex}-${relationIndex}" contenteditable="true">${escapeHtml(relation.value)}</td><td>${escapeHtml(relation.unit)}</td>
        <td><label><input type="radio" name="c-${pageIndex}-${relationIndex}" value="correct">ok</label>
            <label><input type="radio" name="c-${pageIndex}-${relationIndex}" value="edited">edited</label>
            <label><input type="radio" name="c-${pageIndex}-${relationIndex}" value="wrong">wrong</label></td></tr>`).join('');
  const conflictRows = (page.conflictAdjudications ?? []).map((conflict, conflictIndex) => `
    <tr><td>${conflictIndex}</td>
        <td>native: <code>${escapeHtml(conflict.nativeText)}</code><br>ocr: <code>${escapeHtml(conflict.ocrText)}</code></td>
        <td>${escapeHtml(conflict.proposal?.verdict)} — <code>${escapeHtml(conflict.proposal?.inkText)}</code><br><small>${escapeHtml(conflict.proposal?.reason)}</small></td>
        <td><select name="v-${pageIndex}-${conflictIndex}">
          <option value="unreviewed" selected>— review —</option>
          <option value="confirm">confirm proposal</option>
          <option value="native">native right</option>
          <option value="ocr">ocr right</option>
          <option value="both-wrong">both wrong</option>
          <option value="different-regions">different regions</option>
          <option value="unsure">unsure</option>
        </select></td></tr>`).join('');
  return `
  <section class="page" id="page-${pageIndex}">
    <h2>${pageIndex + 1}. ${escapeHtml(page.objectId)} — page ${page.pageNumber}
      <small>${escapeHtml((page.labels ?? []).join(', '))}</small></h2>
    <p class="notes">${escapeHtml(page.proposal.notes)}</p>
    <div class="layout">
      <div class="imgwrap"><img src="data:image/png;base64,${imageBase64}">${boxes}</div>
      <div class="panel">
        <h3>Critical tokens: ${tokens.length - autoCount} need review, ${autoCount} auto-accepted — add missed ones below</h3>
        <table>${tokenRows}</table>
        <textarea id="missed-${pageIndex}" placeholder="Missed tokens, one per line, verbatim"></textarea>
        ${chartRows ? `<h3>Chart relations</h3><table><tr><th></th><th>series</th><th>category</th><th>value</th><th>unit</th><th></th></tr>${chartRows}</table>` : ''}
        <textarea id="missed-charts-${pageIndex}" placeholder="Missed chart tuples, one per line: category | value | unit"></textarea>
        ${conflictRows ? `<h3>Conflict adjudications</h3><table><tr><th></th><th>readings</th><th>machine proposal</th><th>your verdict</th></tr>${conflictRows}</table>` : ''}
      </div>
    </div>
  </section>`;
}).join('\n');

const html = `<!doctype html><meta charset="utf-8"><title>Gold pilot review</title>
<style>
body{font:14px/1.5 -apple-system,sans-serif;margin:0;padding:1rem;background:#fafafa;color:#111}
.page{background:#fff;border:1px solid #ddd;border-radius:8px;margin-bottom:2rem;padding:1rem}
.layout{display:flex;gap:1rem;align-items:flex-start}
.imgwrap{position:relative;flex:0 0 55%}
.imgwrap img{width:100%;display:block;border:1px solid #ccc}
.box{position:absolute;border:1.5px solid rgba(220,40,40,.75);pointer-events:none}
.box.auto{border-color:rgba(30,160,60,.55);border-style:dashed}
.box span{position:absolute;top:-1.1em;left:0;font-size:10px;color:#c22;background:#fff8}
.box.hot{border-color:#06c;border-width:3px;background:rgba(0,102,204,.12)}
.panel{flex:1;max-height:90vh;overflow:auto}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:2px 6px;text-align:left;vertical-align:top}
.text{font-family:ui-monospace,monospace;background:#f6f6f6}
textarea{width:100%;min-height:3em;margin-top:.5em}
#export{position:fixed;bottom:1rem;right:1rem;padding:.7em 1.2em;font-size:15px;background:#06c;color:#fff;border:0;border-radius:8px;cursor:pointer}
.notes{color:#555}
</style>
<h1>Gold pilot review — verify every row, then export</h1>
<p>Edit token text in place if slightly wrong (mark "edited"). Mark "wrong" for hallucinated tokens. Add missed tokens in the textarea. For conflicts, confirm or overrule the machine verdict.</p>
${pagesHtml}
<button id="export" onclick="exportVerdicts()">Export verdicts</button>
<script>
const PROPOSALS = ${JSON.stringify(proposals.map((page) => ({
  objectId: page.objectId, sha256: page.sha256, pageNumber: page.pageNumber,
  tokenCount: (page.proposal.criticalTokens ?? []).length,
  chartCount: (page.proposal.chartRelations ?? []).length,
  conflictIds: (page.conflictAdjudications ?? []).map((conflict) => conflict.id)
}))).replaceAll('<', '\\u003c')};
function hl(pageIndex, tokenIndex, on){
  const box = document.getElementById('box-' + pageIndex + '-' + tokenIndex);
  if (box) box.classList.toggle('hot', Boolean(on));
}
function exportVerdicts(){
  const pages = PROPOSALS.map((page, pageIndex) => ({
    objectId: page.objectId, sha256: page.sha256, pageNumber: page.pageNumber,
    tokens: Array.from({length: page.tokenCount}, (_, tokenIndex) => ({
      index: tokenIndex,
      verdict: document.querySelector('input[name="t-' + pageIndex + '-' + tokenIndex + '"]:checked')?.value,
      // textContent, not innerText: rows collapsed inside <details> render
      // nothing, and innerText of hidden content is empty.
      text: document.querySelector('tr[data-page="' + pageIndex + '"][data-token="' + tokenIndex + '"] .text')?.textContent.trim()
    })),
    missedTokens: document.getElementById('missed-' + pageIndex).value.split('\\n').map(s => s.trim()).filter(Boolean),
    charts: Array.from({length: page.chartCount}, (_, relationIndex) => ({
      index: relationIndex,
      verdict: document.querySelector('input[name="c-' + pageIndex + '-' + relationIndex + '"]:checked')?.value,
      value: document.getElementById('cv-' + pageIndex + '-' + relationIndex)?.textContent.trim()
    })),
    // The newline escape here must survive into the generated page: this
    // template literal is the page source, so an unescaped escape becomes a
    // real line break inside a JS string literal and kills the whole inline
    // script — hover highlighting and Export verdicts included.
    missedCharts: (document.getElementById('missed-charts-' + pageIndex)?.value ?? '').split('\\n')
      .map(line => line.trim()).filter(Boolean)
      .map(line => { const [category, value, unit] = line.split('|').map(part => part.trim()); return {category, value, unit: unit || null}; }),
    conflicts: page.conflictIds.map((id, conflictIndex) => ({
      id, verdict: document.querySelector('select[name="v-' + pageIndex + '-' + conflictIndex + '"]')?.value
    }))
  }));
  const blob = new Blob([JSON.stringify({goldVerdictsSchemaVersion: 'gold-verdicts-v1', verifiedAt: new Date().toISOString(), pages}, null, 1)], {type: 'application/json'});
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'gold-verdicts.json';
  link.click();
}
</script>`;

// Fail closed on a page whose script does not parse. A single bad character
// in the emitted JS takes down the whole inline script — and the failure is
// SILENT: the page still renders, the rows still list, but hover highlighting
// stops working and "Export verdicts" does nothing. A reviewer can lose an
// entire batch of judgements before noticing. Parse, never execute.
const inlineScript = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1];
if (!inlineScript) throw new Error('Generated page has no inline script — refusing to write.');
try {
  new Function(inlineScript);
} catch (error) {
  throw new Error(`Generated page script does not parse (${error.message}). Refusing to write a review UI whose export button is dead.`);
}

writeFileSync(outputPath, html);
console.log(`Wrote ${outputPath} (${(html.length / 1e6).toFixed(1)} MB, ${proposals.length} pages).`);
