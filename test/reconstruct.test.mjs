import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPageSpatial, reconstructSvg } from '../dist/index.js';

const SHA = 'a'.repeat(64);

function fixturePage({ geometry, nativeObservations, ocrObservations }) {
  return buildPageSpatial({
    document: { documentId: 'fixture', revisionId: `sha256:${SHA}`, sha256: SHA, pageCount: 1 },
    pageNumber: 1,
    geometry,
    nativeObservations,
    ocrObservations,
    provenance: { parserName: 'fixture', parserVersion: '1', runId: 'fixture', createdAt: '2026-08-22T00:00:00.000Z' }
  });
}

test('geometry round-trip: a box at known rendered coords lands at those SVG coords', () => {
  const page = fixturePage({
    geometry: { width: 1224, height: 1584, pointWidth: 612, pointHeight: 792 },
    nativeObservations: [{ pageNumber: 1, text: 'Revenue 647', box: [100, 200, 300, 240] }],
    ocrObservations: []
  });
  const svg = reconstructSvg(page);
  assert.match(svg, /viewBox="0 0 1224 1584"/u);
  // Baseline = y1 - 0.18*height = 240 - 7.2 = 232.8; x = box x0.
  assert.match(svg, /<text x="100" y="232.8" font-size="28.8"[^>]*>Revenue 647<\/text>/u);
});

test('rotated-render geometry: viewBox follows rendered width/height, never point dimensions', () => {
  // A 90°-rotated page renders landscape: rendered box space is 1584×1224
  // while the point space stays 612×792. Every box on the record lives in
  // rendered space, so the SVG must too — using point dimensions here was
  // the exact shape of the historical crop bug.
  const page = fixturePage({
    geometry: { width: 1584, height: 1224, pointWidth: 612, pointHeight: 792, rotation: 90 },
    nativeObservations: [{ pageNumber: 1, text: 'Landscape 42', box: [1400, 1100, 1560, 1130] }],
    ocrObservations: []
  });
  const svg = reconstructSvg(page);
  assert.match(svg, /viewBox="0 0 1584 1224"/u);
  assert.match(svg, /<text x="1400" y="1124.6"/u);
});

test('conflicted observations are drawn and visibly flagged; matched OCR duplicates are not double-drawn', () => {
  const page = fixturePage({
    geometry: { width: 1000, height: 1000, pointWidth: 500, pointHeight: 500 },
    nativeObservations: [
      { pageNumber: 1, text: 'Revenue 647', box: [50, 50, 250, 80] },
      { pageNumber: 1, text: 'Steady text', box: [50, 120, 250, 150] }
    ],
    ocrObservations: [
      { pageNumber: 1, text: 'Revenue 641', box: [50, 50, 250, 80], confidence: 0.99 },
      { pageNumber: 1, text: 'Steady text', box: [50, 120, 250, 150], confidence: 0.99 }
    ]
  });
  assert.ok(page.conflicts.length >= 1, 'fixture must produce a conflict');
  const svg = reconstructSvg(page);
  assert.match(svg, />Revenue 641</u, 'conflicting OCR reading must appear');
  assert.match(svg, /stroke-dasharray="4 3"/u, 'conflict outline present');
  assert.equal(svg.match(/>Steady text</gu).length, 1, 'corroborated duplicate drawn once');
  assert.match(svg, /conflicted reading/u, 'legend names the conflict state');
});

test('unread-ink and pictorial regions render as labeled placeholders', () => {
  const base = fixturePage({
    geometry: { width: 1000, height: 1000, pointWidth: 500, pointHeight: 500 },
    nativeObservations: [{ pageNumber: 1, text: 'Anchor', box: [10, 10, 80, 30] }],
    ocrObservations: []
  });
  const page = {
    ...base,
    unreadInkRegions: [
      { box: [100, 100, 400, 300], kind: 'structured', inkDensity: 0.5, midToneFraction: 0.1, recoveredObservationCount: 0, confirmations: [] },
      { box: [500, 500, 900, 800], kind: 'pictorial', inkDensity: 0.7, midToneFraction: 0.6, recoveredObservationCount: 0, confirmations: [] }
    ]
  };
  const svg = reconstructSvg(page);
  assert.match(svg, /unread ink</u);
  assert.match(svg, /pictorial region</u);
  assert.match(svg, /url\(#unread-hatch\)/u);
});

test('secondOpinion readings stay out by default and appear only on request', () => {
  const base = fixturePage({
    geometry: { width: 1000, height: 1000, pointWidth: 500, pointHeight: 500 },
    nativeObservations: [{ pageNumber: 1, text: 'Anchor', box: [10, 10, 80, 30] }],
    ocrObservations: []
  });
  const page = {
    ...base,
    secondOpinion: { adapter: 'tesseract@5', readings: [{ box: [200, 200, 400, 230], text: 'ghost 999', confidence: 0.4 }] }
  };
  assert.doesNotMatch(reconstructSvg(page), /ghost 999/u, 'unauthenticated readings excluded by default');
  const withOpinion = reconstructSvg(page, { includeSecondOpinion: true });
  assert.match(withOpinion, /ghost 999/u);
  assert.match(withOpinion, /unauthenticated/u, 'legend states the honest scope');
});

test('XML-illegal control characters render as visible markers, not invalid XML', () => {
  const page = fixturePage({
    geometry: { width: 1000, height: 1000, pointWidth: 500, pointHeight: 500 },
    nativeObservations: [{ pageNumber: 1, text: 'bad\u0008char \u0000 end', box: [10, 10, 300, 40] }],
    ocrObservations: []
  });
  const svg = reconstructSvg(page);
  assert.match(svg, /bad\\x08char \\x00 end/u, 'controls become visible markers');
  assert.doesNotMatch(svg, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u, 'no raw control bytes in output');
});

test('legend claims OCR-only text only when a non-conflicted OCR reading was drawn', () => {
  const page = fixturePage({
    geometry: { width: 1000, height: 1000, pointWidth: 500, pointHeight: 500 },
    nativeObservations: [{ pageNumber: 1, text: 'Revenue 647', box: [50, 50, 250, 80] }],
    ocrObservations: [{ pageNumber: 1, text: 'Revenue 641', box: [50, 50, 250, 80], confidence: 0.99 }]
  });
  assert.ok(page.conflicts.length >= 1, 'fixture must produce a conflict');
  const svg = reconstructSvg(page);
  assert.doesNotMatch(svg, /OCR-only text/u, 'only blue on the page is conflicted → no OCR-only legend');
  assert.match(svg, /conflicted reading/u);
  assert.match(svg, new RegExp(`fill="#b5432c"[^>]*>Revenue 641`, 'u'), 'conflicted reading drawn in conflict color');
});

test('unknown region kinds fail visible with their kind named', () => {
  const base = fixturePage({
    geometry: { width: 1000, height: 1000, pointWidth: 500, pointHeight: 500 },
    nativeObservations: [{ pageNumber: 1, text: 'Anchor', box: [10, 10, 80, 30] }],
    ocrObservations: []
  });
  const page = {
    ...base,
    unreadInkRegions: [
      { box: [100, 100, 400, 300], kind: 'table-v2', inkDensity: 0.5, midToneFraction: 0.1, recoveredObservationCount: 0, confirmations: [] }
    ]
  };
  const svg = reconstructSvg(page);
  assert.match(svg, /unknown region \(table-v2\)/u);
  assert.doesNotMatch(svg, />unread ink</u, 'never mislabeled as unread ink');
  assert.doesNotMatch(svg, /url\(#unread-hatch\)/u, 'unknown kinds do not borrow the structured hatch');
});

test('deterministic: same record produces identical bytes; text is XML-escaped', () => {
  const page = fixturePage({
    geometry: { width: 1000, height: 1000, pointWidth: 500, pointHeight: 500 },
    nativeObservations: [{ pageNumber: 1, text: 'A & B <5> "q"', box: [10, 10, 300, 40] }],
    ocrObservations: []
  });
  const first = reconstructSvg(page);
  assert.equal(first, reconstructSvg(page));
  assert.match(first, /A &amp; B &lt;5&gt; &quot;q&quot;/u);
  assert.doesNotMatch(first, /<5>/u);
});
