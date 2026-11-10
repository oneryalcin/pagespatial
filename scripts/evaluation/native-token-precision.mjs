/**
 * Number precision of an OCR arm against the PDF text layer.
 *
 * For every page with native text, the share of the arm's critical tokens
 * (digit-bearing tokens, src/text.ts) that the page's native text
 * corroborates, and the reverse. Arms that share a detector read the same
 * boxes, so a lower share means misread values, not missing lines. Text that
 * exists only as pixels counts against every arm equally.
 *
 * Usage:
 *   node scripts/evaluation/native-token-precision.mjs --run-root .evaluation/runs/<run-id> \
 *     [--skip-script cjk] <results-arm.json>...
 * Output: text-free counts per arm and per document.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { criticalTokens } from '../../dist/text.js';
import { buildCorroborationPool, poolCorroborates } from '../../dist/corroborate.js';

const args = process.argv.slice(2);
const runRoot = args[args.indexOf('--run-root') + 1];
const skipCjk = args.includes('--skip-script');
const files = args.filter((value, index) => value.endsWith('.json') && args[index - 1] !== '--run-root');
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

const native = new Map();
for (const doc of readdirSync(join(runRoot, 'documents'))) {
  let pages;
  try { pages = readdirSync(join(runRoot, 'documents', doc, 'pages')); } catch { continue; }
  for (const file of pages) {
    const record = JSON.parse(readFileSync(join(runRoot, 'documents', doc, 'pages', file), 'utf8'));
    const texts = (record.pageSpatial?.nativeObservations ?? []).map((observation) => observation.text);
    if (texts.length) native.set(`${record.objectId}#${record.pageNumber}`, texts);
  }
}

const overlap = (fromTexts, intoTexts) => {
  const pool = buildCorroborationPool(intoTexts);
  const tokens = fromTexts.flatMap((text) => criticalTokens(text));
  return [tokens.filter((token) => poolCorroborates(token, pool)).length, tokens.length];
};

const out = {};
for (const file of files) {
  const result = JSON.parse(readFileSync(file, 'utf8'));
  const total = { pages: 0, ocrTokens: 0, ocrInNative: 0, nativeTokens: 0, nativeInOcr: 0 };
  const perDocument = {};
  for (const page of result.perPage) {
    const nativeTexts = native.get(page.page);
    if (!nativeTexts) continue;
    if (skipCjk && nativeTexts.some((text) => CJK.test(text))) continue;
    const ocrTexts = page.lines.map((line) => line.text);
    const [ocrIn, ocrAll] = overlap(ocrTexts, nativeTexts);
    const [nativeIn, nativeAll] = overlap(nativeTexts, ocrTexts);
    const doc = page.page.split('#')[0];
    const row = perDocument[doc] ??= { ocrTokens: 0, ocrInNative: 0 };
    row.ocrTokens += ocrAll; row.ocrInNative += ocrIn;
    total.pages += 1; total.ocrTokens += ocrAll; total.ocrInNative += ocrIn;
    total.nativeTokens += nativeAll; total.nativeInOcr += nativeIn;
  }
  out[result.config.name] = {
    ...total,
    precision: +(total.ocrInNative / total.ocrTokens).toFixed(4),
    recall: +(total.nativeInOcr / total.nativeTokens).toFixed(4),
    perDocument
  };
}
console.log(JSON.stringify(out));
