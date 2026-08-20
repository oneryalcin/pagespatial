import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEscalatedOcrEnrichment,
  createParser,
  deriveCorroboration,
  validateEnrichmentAgainstPage
} from '../dist/index.js';

// A real page record via the parser: native reads "Revenue 647", OCR reads
// "Revenue 641" → critical-token conflict → blocking escalation, so the
// page qualifies for the escalated tier.
const identity = { documentId: 'enrich-doc', revisionId: 'r1', sha256: 'a'.repeat(64), pageCount: 1 };

async function escalatedPage() {
  const document = await createParser({
    native: {
      name: 'fixture-native', version: '1',
      async extractPage() {
        return {
          pageNumber: 1,
          geometry: { pointWidth: 250, pointHeight: 250 },
          observations: [
            { pageNumber: 1, text: 'Revenue 647', pointBox: [10, 220, 120, 240] },
            { pageNumber: 1, text: 'Margin 12%', pointBox: [10, 190, 120, 210] }
          ]
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
          observations: [{ pageNumber: 1, text: 'Revenue 641', box: [16, 16, 192, 48], confidence: 0.99 }]
        };
      }
    }
  }).parse({ identity, data: new Uint8Array([1]) }, { runId: 'enrich-run' });
  return document.pages[0];
}

const provenance = { adapter: 'flash-escalated-ocr@1', model: 'gemini-3.7-flash', mediaResolution: 'MEDIA_RESOLUTION_ULTRA_HIGH', promptRevision: 'transcribe-critical-tokens-v1', thinkingBudget: 0 };
const telemetry = { promptTokens: 2200, outputTokens: 900, latencyMs: 4400 };

test('corroboration is derived per witness pool, occurrence-consuming', async () => {
  const page = await escalatedPage();
  const derived = deriveCorroboration([
    { text: '647' },        // native only
    { text: '641' },        // ocr only
    { text: '12%' },        // native only (Margin 12%)
    { text: '9,999' },      // nobody
    { text: '647' }         // native occurrence already consumed → novel
  ], page);
  assert.deepEqual(derived.map((proposal) => proposal.corroboration),
    ['corroborated-native', 'corroborated-ocr', 'corroborated-native', 'novel', 'novel']);
});

test('enrichment binds fail-closed to the exact page record', async () => {
  const page = await escalatedPage();
  const enrichment = await buildEscalatedOcrEnrichment({
    page, provenance, telemetry,
    proposals: [{ text: '647', modelBoxHint: [100, 100, 120, 200] }, { text: '9,999' }]
  });
  assert.equal(enrichment.trust, 'untrusted-document-content');
  assert.deepEqual(enrichment.trigger.blockingReasons, ['critical-token-conflict']);
  assert.equal((await validateEnrichmentAgainstPage(enrichment, page)).valid, true);

  // A reparse changes the record → stale enrichment must be rejected.
  const reparsed = structuredClone(page);
  reparsed.ocrObservations[0].confidence = 0.5;
  const stale = await validateEnrichmentAgainstPage(enrichment, reparsed);
  assert.equal(stale.valid, false);
  assert.ok(stale.issues.some((issue) => issue.includes('basePageDigest')));

  // Upgrading a novel proposal to "corroborated" is a forgery → rejected.
  const forged = structuredClone(enrichment);
  forged.proposals[1].corroboration = 'corroborated-both';
  const verdict = await validateEnrichmentAgainstPage(forged, page);
  assert.equal(verdict.valid, false);
});

test('enrichment refuses pages without blocking escalation', async () => {
  const page = await escalatedPage();
  const calm = structuredClone(page);
  calm.diagnostics.escalationReasons = calm.diagnostics.escalationReasons
    .map((reason) => ({ ...reason, severity: 'advisory' }));
  await assert.rejects(
    buildEscalatedOcrEnrichment({ page: calm, provenance, telemetry, proposals: [{ text: '647' }] }),
    /blocking/u
  );
});
