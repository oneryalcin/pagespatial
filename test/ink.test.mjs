import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createParser,
  duplicatesFirstPass,
  findUnreadInkRegions,
  mapRecoveredBox,
  pageSpatialSchema
} from '../dist/index.js';

// Build an RGBA raster: white page with painted rectangles.
function raster(width, height, patches) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const { box, value, every } of patches) {
    for (let y = box[1]; y < box[3]; y += 1) {
      for (let x = box[0]; x < box[2]; x += 1) {
        if (every && ((x + y) % every)) continue; // sparse strokes, chart-like
        const offset = (y * width + x) * 4;
        data[offset] = data[offset + 1] = data[offset + 2] = value;
      }
    }
  }
  return { width, height, data };
}

// 400x400 px at 1.6 ppp (= 250x250 pt page). Region min area 1600pt² = 4096px².
test('ink analysis separates structured strokes, pictorial midtones, and read text', () => {
  const image = raster(400, 400, [
    { box: [20, 20, 200, 50], value: 0 },              // dense text row (covered by a read box)
    { box: [20, 120, 180, 260], value: 0, every: 3 },  // sparse dark strokes = chart-like, unread
    { box: [220, 120, 380, 260], value: 128 }          // solid midtone block = photo-like, unread
  ]);
  const regions = findUnreadInkRegions(image, [[20, 20, 200, 50]], 1.6);
  const kinds = regions.map((region) => region.kind).sort();
  assert.deepEqual(kinds, ['pictorial', 'structured'], JSON.stringify(regions));
  const structured = regions.find((region) => region.kind === 'structured');
  assert.ok(structured.box[0] < 200 && structured.midToneFraction < 0.3);
  const pictorial = regions.find((region) => region.kind === 'pictorial');
  assert.ok(pictorial.box[0] >= 200 && pictorial.midToneFraction >= 0.3);
});

test('ink analysis ignores read areas and sub-minimum specks', () => {
  const image = raster(400, 400, [
    { box: [20, 20, 200, 50], value: 0 },   // read
    { box: [300, 300, 330, 330], value: 0 } // 30x30px speck < 4096px² minimum
  ]);
  assert.deepEqual(findUnreadInkRegions(image, [[20, 20, 200, 50]], 1.6), []);
});

test('recovered boxes map back to first-render pixels; duplicates need same place AND same reading', () => {
  assert.deepEqual(mapRecoveredBox([40, 80, 140, 120], [100, 200], 4), [110, 220, 135, 230]);
  const read = [{ box: [0, 0, 25, 25], text: '1,234' }];
  assert.equal(duplicatesFirstPass([10, 10, 30, 30], '1,234', read), true);
  // Same place, different reading: recovery correcting a garbage first pass
  // is new evidence, not a duplicate.
  assert.equal(duplicatesFirstPass([10, 10, 30, 30], '5,678', read), false);
  assert.equal(duplicatesFirstPass([10, 10, 30, 30], '1,234', [{ box: [0, 0, 12, 12], text: '1,234' }]), false);
});

const identity = { documentId: 'ink-doc', revisionId: 'r', sha256: 'e'.repeat(64), pageCount: 1 };

function parserWith(recovery) {
  return createParser({
    native: {
      name: 'fixture-native', version: '1',
      async extractPage() {
        return {
          pageNumber: 1,
          geometry: { pointWidth: 250, pointHeight: 250 },
          observations: [{ pageNumber: 1, text: 'Heading 2024', pointBox: [10, 220, 120, 240] }]
        };
      }
    },
    renderer: {
      name: 'fixture-renderer', version: '1',
      async render() {
        return {
          pageNumber: 1,
          geometry: { width: 400, height: 400, pointWidth: 250, pointHeight: 250, viewportTransform: [1.6, 0, 0, -1.6, 0, 400] },
          data: new Uint8Array([1])
        };
      }
    },
    ocr: {
      name: 'fixture-ocr', version: '1',
      async recognize() {
        return {
          pageNumber: 1,
          observations: [{ pageNumber: 1, text: 'Heading 2024', box: [16, 256, 192, 288], confidence: 0.95 }]
        };
      }
    },
    regionRecovery: recovery
  }).parse({ identity, data: new Uint8Array([1]) }, { runId: 'ink-run' });
}

const structuredRegion = () => ({
  box: [40, 40, 240, 200], kind: 'structured', inkDensity: 0.12, midToneFraction: 0.05, recoveredObservationCount: 0
});
const pictorialRegion = () => ({
  box: [250, 40, 390, 200], kind: 'pictorial', inkDensity: 0.66, midToneFraction: 0.44, recoveredObservationCount: 0
});

test('parser records regions, tags recovered observations, and keeps starvation honest', async () => {
  const recoverCalls = [];
  const document = await parserWith({
    name: 'fixture-recovery', version: '1',
    async analyze() { return [structuredRegion(), pictorialRegion()]; },
    async recoverPage(source, pageNumber, regions) {
      recoverCalls.push(...regions.map((region) => region.kind));
      return Array.from({ length: 9 }, (_, index) => ({
        pageNumber: 1,
        text: `${100 + index}`,
        box: [50 + index * 20, 60, 64 + index * 20, 76],
        confidence: 0.9,
        recoveryMethod: 'zoom-retry-v1'
      }));
    }
  });
  const page = document.pages[0];
  // Pictorial regions are recorded but never recovered.
  assert.deepEqual(recoverCalls, ['structured']);
  assert.equal(page.unreadInkRegions.length, 2);
  assert.equal(page.unreadInkRegions.find((r) => r.kind === 'structured').recoveredObservationCount, 9);
  const recovered = page.ocrObservations.filter((observation) => observation.recoveryMethod === 'zoom-retry-v1');
  assert.equal(recovered.length, 9);
  // 9 confident single-witness recoveries + 1 matched first-pass observation
  // would fire uncorroborated-ocr if recoveries counted; they must not.
  assert.equal(page.diagnostics.escalationReasons.some((reason) => reason.type === 'uncorroborated-ocr'), false);
  // Successful recovery leaves no unread-ink residue.
  assert.equal(page.diagnostics.escalationReasons.some((reason) => reason.type === 'unread-ink-region'), false);
});

test('forging recoveredObservationCount cannot clear the blocking residue escalation', async () => {
  const document = await parserWith({
    name: 'fixture-recovery', version: '1',
    async analyze() { return [structuredRegion()]; },
    async recoverPage() { return []; }
  });
  const honest = document.pages[0];
  assert.equal(pageSpatialSchema.safeParse(honest).success, true);
  // The forgery: bump the count, drop the escalation. Every field is
  // self-consistent except that no recoveryMethod observation backs it.
  const forged = structuredClone(honest);
  forged.unreadInkRegions[0].recoveredObservationCount = 1;
  forged.diagnostics.escalationReasons = forged.diagnostics.escalationReasons
    .filter((reason) => reason.type !== 'unread-ink-region');
  forged.diagnostics.requiresEscalation = forged.diagnostics.escalationReasons.length > 0;
  const result = pageSpatialSchema.safeParse(forged);
  assert.equal(result.success, false);
});

test('a recovery adapter failure degrades to residue instead of losing the document', async () => {
  const document = await parserWith({
    name: 'fixture-recovery', version: '1',
    async analyze() { return [structuredRegion()]; },
    async recoverPage() { throw new Error('Rendered page exceeds the canvas safety limit.'); }
  });
  const page = document.pages[0];
  assert.equal(page.unreadInkRegions.length, 1);
  const reason = page.diagnostics.escalationReasons.find((item) => item.type === 'unread-ink-region');
  assert.equal(reason.severity, 'blocking');
});

test('recovered tile fragments do not manufacture critical-token conflicts against native', async () => {
  const document = await parserWith({
    name: 'fixture-recovery', version: '1',
    async analyze() { return [structuredRegion()]; },
    async recoverPage() {
      // A fragment of the native "Heading 2024" line: overlapping geometry,
      // truncated critical token. As a first-pass observation this would be
      // a critical-token conflict; as a recovery it must not vote.
      return [{
        pageNumber: 1, text: 'Heading 202', box: [16, 256, 160, 288],
        confidence: 0.95, recoveryMethod: 'zoom-retry-v1'
      }];
    }
  });
  const page = document.pages[0];
  assert.equal(page.conflicts.length, 0);
  assert.equal(page.diagnostics.escalationReasons.some((reason) =>
    reason.type === 'critical-token-conflict' || reason.type === 'critical-token-omission'), false);
});

test('structured regions that recovery cannot read escalate as unread-ink residue', async () => {
  const document = await parserWith({
    name: 'fixture-recovery', version: '1',
    async analyze() { return [structuredRegion(), pictorialRegion()]; },
    async recoverPage() { return []; }
  });
  const page = document.pages[0];
  const reason = page.diagnostics.escalationReasons.find((item) => item.type === 'unread-ink-region');
  assert.equal(reason.severity, 'blocking');
  assert.equal(reason.count, 1);
  // Share is the fraction of STRUCTURED regions still unread; the pictorial
  // region is not recoverable by design and stays out of the denominator.
  assert.equal(reason.share, 1);
  assert.equal(page.diagnostics.requiresEscalation, true);
});
