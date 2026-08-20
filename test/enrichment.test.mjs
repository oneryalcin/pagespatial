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

test('tail-compatible corroboration: unit-word segmentation is not novelty', async () => {
  const page = await escalatedPage();
  // Witness reads "Revenue 647" (no tail captured). A proposal carrying the
  // unit word covers MORE ink of the same value — same-ink §6 says that is
  // never a disagreement, so it corroborates rather than counting as novel.
  const derived = deriveCorroboration([
    { text: '647 million' },
    { text: '641 million' }
  ], page);
  assert.deepEqual(derived.map((proposal) => proposal.corroboration),
    ['corroborated-native', 'corroborated-ocr']);
});

test('every identity field independently invalidates a mismatched enrichment', async () => {
  const page = await escalatedPage();
  const enrichment = await buildEscalatedOcrEnrichment({
    page, provenance, telemetry, proposals: [{ text: '647' }]
  });
  for (const [field, value] of [
    ['documentId', 'other-doc'],
    ['documentSha256', 'b'.repeat(64)],
    ['revisionId', 'r2'],
    ['pageId', 'ps:aaaaaaaaaaaa:p9'],
    ['pageNumber', 9],
    ['basePageDigest', 'c'.repeat(64)]
  ]) {
    const mutated = structuredClone(enrichment);
    mutated[field] = value;
    const verdict = await validateEnrichmentAgainstPage(mutated, page);
    assert.equal(verdict.valid, false, field);
  }
});

test('smuggled nested keys are rejected and validation returns the sanitized record', async () => {
  const page = await escalatedPage();
  const enrichment = await buildEscalatedOcrEnrichment({
    page, provenance, telemetry, proposals: [{ text: '647' }]
  });
  // A geometry key smuggled onto a proposal would contradict text-only.
  const smuggled = structuredClone(enrichment);
  smuggled.proposals[0].evidenceBox = [1, 2, 3, 4];
  const verdict = await validateEnrichmentAgainstPage(smuggled, page);
  assert.equal(verdict.valid, false);
  // The happy path hands back the parsed record for downstream use.
  const clean = await validateEnrichmentAgainstPage(enrichment, page);
  assert.equal(clean.valid, true);
  assert.ok(clean.record);
  // A schema-invalid record reports issues instead of throwing.
  const broken = structuredClone(enrichment);
  broken.trust = 'totally-trusted';
  const brokenVerdict = await validateEnrichmentAgainstPage(broken, page);
  assert.equal(brokenVerdict.valid, false);
});

test('transcriber retries transient statuses and hard-fails terminal ones', async () => {
  const { transcribePageImage } = await import('../dist/node/flash-ocr.js');
  const ok = {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: '{"tokens":[{"text":"647"}]}' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
    })
  };
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, text: async () => 'slow down', headers: { get: () => '0.01' } };
    return ok;
  };
  const result = await transcribePageImage({ apiKey: 'k', png: new Uint8Array([1]), fetchImpl: flaky });
  assert.equal(calls, 2);
  assert.equal(result.proposals[0].text, '647');
  // Terminal status: no retry.
  let terminalCalls = 0;
  await assert.rejects(transcribePageImage({
    apiKey: 'k', png: new Uint8Array([1]),
    fetchImpl: async () => { terminalCalls += 1; return { ok: false, status: 400, text: async () => 'bad' }; }
  }), /400/u);
  assert.equal(terminalCalls, 1);
});

test('adjudications bind fail-closed to recorded conflicts', async () => {
  const page = await escalatedPage();
  const conflictId = page.conflicts[0].id;
  const enrichment = await buildEscalatedOcrEnrichment({
    page, provenance, telemetry, proposals: [],
    adjudications: [{ conflictId, verdict: 'native', inkText: 'Revenue 647' }]
  });
  assert.equal(enrichment.adjudications.length, 1);
  assert.equal((await validateEnrichmentAgainstPage(enrichment, page)).valid, true);
  // Verdict on a conflict that does not exist = fabricated evidence.
  await assert.rejects(buildEscalatedOcrEnrichment({
    page, provenance, telemetry, proposals: [],
    adjudications: [{ conflictId: 'conflict:nowhere', verdict: 'ocr' }]
  }), /unknown conflict/u);
  // Duplicate verdicts on one conflict rejected.
  await assert.rejects(buildEscalatedOcrEnrichment({
    page, provenance, telemetry, proposals: [],
    adjudications: [
      { conflictId, verdict: 'native' },
      { conflictId, verdict: 'ocr' }
    ]
  }), /Duplicate/u);
  // Forged post-hoc adjudication fails validation.
  const forged = structuredClone(enrichment);
  forged.adjudications.push({ conflictId: 'conflict:invented', verdict: 'ocr' });
  assert.equal((await validateEnrichmentAgainstPage(forged, page)).valid, false);
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
