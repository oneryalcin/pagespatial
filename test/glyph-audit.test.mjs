import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPageSpatial, pageSpatialSchema } from '../dist/index.js';

// A page whose native text layer comes from one font. `nativeOf` maps each
// visible line to what the text layer claims; OCR reads what is visible.
function page(lines, nativeOf) {
  const identity = { documentId: 'glyph-doc', revisionId: 'glyph-rev', sha256: 'a'.repeat(64), pageCount: 1 };
  return buildPageSpatial({
    document: identity,
    pageNumber: 1,
    geometry: { width: 800, height: 40 * lines.length + 40 },
    nativeObservations: lines.map((text, i) => ({
      pageNumber: 1, text: nativeOf(text), box: [20, 20 + 40 * i, 700, 50 + 40 * i], font: 'F1'
    })),
    ocrObservations: lines.map((text, i) => ({
      pageNumber: 1, text, box: [20, 20 + 40 * i, 700, 50 + 40 * i], confidence: 0.99
    })),
    provenance: { parserName: 'fixture', parserVersion: '1', runId: 'glyph-run', createdAt: new Date().toISOString() }
  });
}

const PROSE = [
  'The committee reviewed the proposal before the meeting.',
  'Revenue recognition follows the delivery of goods.',
  'Operating expenses were monitored throughout the period.',
  'These statements should be read with the annual report.'
];
const swapEO = (text) => text.replace(/[eo]/g, (ch) => (ch === 'e' ? 'o' : 'e'));

test('a broken text-layer font is flagged and its corrupted text stays out of the markdown', () => {
  const record = page(PROSE, swapEO);
  const reason = record.diagnostics.escalationReasons.find((r) => r.type === 'native-glyph-mismatch');
  assert.ok(reason, 'expected a native-glyph-mismatch reason');
  assert.equal(record.projection.markdown.includes('Tho cemmittoo'), false);
});

test('a narrow systematic mismatch is flagged but the native text is kept', () => {
  // OCR reads Polish ą as q: the evidence cannot tell this from a broken map,
  // so the native text (here correct) must not be withheld.
  const lines = [
    'Należności z tytułu umów są ujmowane według zamortyzowanego kosztu',
    'Zobowiązania finansowe są wyceniane według wartości godziwej',
    'Spółka dokonuje odpisów aktualizujących wartość należności zgodnie'
  ];
  const record = page(lines.map((t) => t.replaceAll('ą', 'q')), (ocrText) => lines[lines.findIndex((t) => t.replaceAll('ą', 'q') === ocrText)]);
  assert.ok(record.diagnostics.escalationReasons.some((r) => r.type === 'native-glyph-mismatch'));
  assert.ok(record.projection.markdown.includes('Zobowiązania finansowe'));
});

test('a record cannot hide a native glyph mismatch by dropping the reason', () => {
  const record = page(PROSE, swapEO);
  const tampered = structuredClone(record);
  tampered.diagnostics.escalationReasons = tampered.diagnostics.escalationReasons.filter((r) => r.type !== 'native-glyph-mismatch');
  tampered.diagnostics.requiresEscalation = tampered.diagnostics.escalationReasons.length > 0;
  assert.equal(pageSpatialSchema.safeParse(record).success, true);
  assert.equal(pageSpatialSchema.safeParse(tampered).success, false);
});

test('OCR that cannot read the script (no Japanese model) never withholds correct native text', () => {
  // A model without Japanese emits no kana at all: it reads every kana as a
  // Han look-alike (こ as 己, た as 九), consistently, which without the guard
  // looks exactly like a broken text layer.
  const native = ['ここでたくさんのことをしたい', 'たのしいことがたくさんある', 'このたびはこころからかんしゃ'];
  const blind = (t) => Array.from(t, (ch) =>
    /\p{Script=Hiragana}/u.test(ch) ? String.fromCodePoint(0x4e00 + (ch.codePointAt(0) % 97)) : ch).join('');
  const record = page(native.map(blind), (ocrText) => native[native.findIndex((t) => blind(t) === ocrText)]);
  assert.equal(record.diagnostics.escalationReasons.some((r) => r.type === 'native-glyph-mismatch'), false);
});

test('a font whose every letter maps wrong (offset CMap) is flagged and withheld', () => {
  // The classic broken ToUnicode map: each glyph maps to a shifted code.
  const shift = (t) => t.replace(/[a-z]/g, (ch) => String.fromCharCode(((ch.charCodeAt(0) - 97 + 3) % 26) + 97));
  const record = page(PROSE, shift);
  assert.equal(record.projection.markdown.includes(shift('committee')), false);
});
