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
import { normalizeTokenBox, summarizeBoxes } from './lib/gold-box.mjs';

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
    // A proposal that tokenizes to nothing can never become gold — the
    // evaluator scores criticalTokens(text), so '$' or 'twelve month'
    // contributes zero either way. Asking a human to confirm one buys
    // nothing and costs a click: batch 3 spent 52 of them, 45 on bare
    // dollar signs from a single dense table.
    noise: criticalTokens(token.text ?? '').length === 0,
    located: normalizeTokenBox(token)?.box ?? null,
    auto: corroborated(pageKey, token.text, normalizeTokenBox(token)?.box)
  }));
  const boxes = tokens.map((token, tokenIndex) => {
    if (!token.located) return '';
    const [y0, x0, y1, x1] = token.located;
    return `<div class="box${token.auto ? ' auto' : ''}" id="box-${pageIndex}-${tokenIndex}" style="top:${y0 / 10}%;left:${x0 / 10}%;height:${(y1 - y0) / 10}%;width:${(x1 - x0) / 10}%"><span>${tokenIndex}</span></div>`;
  }).join('');
  const row = (token, tokenIndex) => `
    <tr data-page="${pageIndex}" data-token="${tokenIndex}" onmouseover="hl(${pageIndex},${tokenIndex},1)" onmouseout="hl(${pageIndex},${tokenIndex},0)">
      <td>${tokenIndex}${token.located ? '' : '<span class="nobox" title="The pre-labeler returned no usable box for this token — find it on the page yourself before judging it.">⌀</span>'}</td>
      <td class="text" contenteditable="true">${escapeHtml(token.text)}</td>
      <td><label><input type="radio" name="t-${pageIndex}-${tokenIndex}" value="${token.auto ? 'auto' : 'correct'}"${token.auto ? ' checked' : ''}>${token.auto ? 'auto' : 'ok'}</label>
          <label><input type="radio" name="t-${pageIndex}-${tokenIndex}" value="wrong">wrong</label>
          <label><input type="radio" name="t-${pageIndex}-${tokenIndex}" value="edited">edited</label>
          <label class="bulk"><input type="radio" name="t-${pageIndex}-${tokenIndex}" value="bulk">bulk</label></td>
    </tr>`;
  // Index alignment is load-bearing: the evaluator joins verdicts to
  // proposals by index, so a dropped row still exports a verdict. It carries
  // a checked hidden radio reading 'noise' — present in the record, absent
  // from the reviewer's work.
  const noiseInput = (token, tokenIndex) =>
    `<input type="radio" name="t-${pageIndex}-${tokenIndex}" value="noise" checked hidden>`;
  const reviewRows = tokens.map((token, tokenIndex) =>
    token.noise ? noiseInput(token, tokenIndex) : (token.auto ? '' : row(token, tokenIndex))).join('');
  const autoRows = tokens.map((token, tokenIndex) => (token.auto && !token.noise) ? row(token, tokenIndex) : '').join('');
  const autoCount = tokens.filter((token) => token.auto && !token.noise).length;
  const noiseCount = tokens.filter((token) => token.noise).length;
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
      <div class="imgwrap" id="imgwrap-${pageIndex}"><img src="data:image/png;base64,${imageBase64}">${boxes}</div>
      <div class="panel">
        <h3>Critical tokens: ${tokens.length - autoCount - noiseCount} need review, ${autoCount} auto-accepted${noiseCount ? `, ${noiseCount} dropped as non-scoring` : ''} — add missed ones below</h3>
        <table>${tokenRows}</table>
        <p class="bulkbar"><button type="button" onclick="acceptRemaining(${pageIndex})">Accept all remaining on this page</button>
          <span id="bulkcount-${pageIndex}"></span></p>
        <textarea id="missed-${pageIndex}" placeholder="Missed tokens, one per line, verbatim"></textarea>
        <p class="nomiss">
          <button type="button" onclick="toggleBoxes(${pageIndex})" id="hideboxes-${pageIndex}">Hide boxes to search</button>
          <label><input type="checkbox" id="nomiss-${pageIndex}" disabled>
          I searched the UNBOXED parts of this page for figures neither engine read and found <strong>none</strong></label>
          <small>The boxes are machine-drawn and anchor your eyes to what the machine already found — the misses that matter are exactly where there is no box. The checkbox unlocks after you have viewed the page with boxes hidden at least once. Recorded as a verified negative — a page nobody checked exports nothing here. Leave unchecked if you added missed tokens or did not search.</small></p>
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
/* The bulk radio is never clicked directly — it is the record that a row was
   page-accepted rather than read, so it must be settable only by the button. */
label.bulk{display:none}
tr.bulked{background:#fff6df}
tr.bulked td:first-child::after{content:' bulk';color:#a86400;font-size:11px}
.nobox{color:#c00;font-weight:700;margin-left:.25rem;cursor:help}
.bulkbar{margin:.4rem 0 0;font-size:12px;color:#666}
.nomiss{margin:.5rem 0;padding:.4rem;background:#f0f7f0;border:1px solid #cde3cd;border-radius:6px}
.nomiss button{font-size:12px;padding:.25rem .5rem;margin-right:.5rem}
.nomiss input:disabled+*{color:#999}
.imgwrap.noboxes .box{display:none}
.nomiss small{display:block;color:#666;margin-top:.2rem}
.bulkbar button{font-size:12px;padding:.25rem .5rem}
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
// The no-miss checkbox stays locked until the reviewer has looked at the
// page WITHOUT the machine-drawn boxes at least once: the boxes anchor
// attention to what the machine found, and the misses a verified negative
// vouches for are exactly the unboxed ink.
function toggleBoxes(pageIndex){
  const wrap = document.getElementById('imgwrap-' + pageIndex);
  wrap.classList.toggle('noboxes');
  const button = document.getElementById('hideboxes-' + pageIndex);
  button.textContent = wrap.classList.contains('noboxes') ? 'Show boxes' : 'Hide boxes to search';
  const nomiss = document.getElementById('nomiss-' + pageIndex);
  if (nomiss) nomiss.disabled = false;
}
// Page-level accept for the common case where every proposal is right. It
// records "bulk", NOT "correct": the evaluator scores that as its own tier,
// so a token a person actually read is never mixed with one accepted in a
// batch of forty. Rows already marked by hand are left exactly as they are.
function acceptRemaining(pageIndex){
  const rows = document.querySelectorAll('tr[data-page="' + pageIndex + '"]');
  let accepted = 0;
  rows.forEach(row => {
    const tokenIndex = row.getAttribute('data-token');
    const name = 't-' + pageIndex + '-' + tokenIndex;
    if (document.querySelector('input[name="' + name + '"]:checked')) return;
    const bulk = document.querySelector('input[name="' + name + '"][value="bulk"]');
    if (!bulk) return;
    bulk.checked = true;
    row.classList.add('bulked');
    accepted += 1;
  });
  document.getElementById('bulkcount-' + pageIndex).textContent =
    accepted ? accepted + ' rows accepted in bulk — recorded as a separate tier, not as read-and-verified.' : 'nothing left to accept.';
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
    // Tri-state by construction: true = the reviewer searched and found no
    // missed figures (a RECORDED negative); null = no claim either way. A
    // checked box alongside entered missed tokens is a contradiction the
    // evaluator rejects — silence is never promoted to a negative.
    noMissFound: document.getElementById('nomiss-' + pageIndex)?.checked ? true : null,
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
  const blob = new Blob([JSON.stringify({goldVerdictsSchemaVersion: 'gold-verdicts-v2', verifiedAt: new Date().toISOString(), pages}, null, 1)], {type: 'application/json'});
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
