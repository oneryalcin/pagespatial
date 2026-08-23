/**
 * M2 manifest + reconciliation instruments (design doc §14.1, §12).
 * Production bugs these prevent: a scaling manifest whose order or ids
 * drift between arms (breaks cross-arm comparability), a reconciler that
 * misses silent input loss or duplicate terminal outputs (criterion 1/7
 * evidence), and aggregation that reads cold readiness from results —
 * which under-report after a rejected first call (PR #89 closure).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildQualificationManifest,
  parseLogText,
  reconcileRun,
  renderAggregationTable,
} from '../scripts/evaluation/lib/modal-qualification.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Synthetic 23-document fixture (no corpus content: ids/hashes/counts only).
// ---------------------------------------------------------------------------
const objectIds = Array.from({ length: 23 }, (unused, index) => `set:doc:${String(index + 1).padStart(2, '0')}`);
const corpus = {
  documents: objectIds.map((objectId, index) => ({
    objectId,
    split: 'development',
    pages: [{ pageNumber: 1, labels: index % 2 ? ['native-text'] : ['image-only', 'landscape'] }],
  })),
};
const subsetIndex = {
  documents: objectIds.map((objectId, index) => ({ objectId, file: `${index}.pdf`, pageCount: index + 2 })),
};
const subsetHashes = new Map(objectIds.map((objectId, index) => [
  objectId, { sha256: String(index).padStart(64, 'a'), bytes: 1000 + index },
]));

const manifest = buildQualificationManifest({ corpus, subsetIndex, subsetHashes });

test('correctness manifest: 23 fixed entries with the full §14.1 field set', () => {
  assert.equal(manifest.correctness.length, 23);
  for (const entry of manifest.correctness) {
    for (const key of ['request_id', 'object_id', 'sha256', 'bytes', 'pages',
      'class_labels', 'expected_disposition', 'permission']) {
      assert.ok(key in entry, `${entry.request_id} missing ${key}`);
    }
    assert.equal(entry.permission, 'approved-public-evaluation');
  }
  assert.equal(new Set(manifest.correctness.map((entry) => entry.request_id)).size, 23);
});

test('scaling manifest: 100 deterministic calls, distinct ids, fixed published order', () => {
  assert.equal(manifest.scaling.length, 100);
  assert.equal(new Set(manifest.scaling.map((entry) => entry.request_id)).size, 100);
  // Fixed order: call N maps to correctness document (N-1) % 23 and keeps
  // its source hash — call 24 wraps to document 1.
  for (const [index, call] of manifest.scaling.entries()) {
    const source = manifest.correctness[index % 23];
    assert.equal(call.object_id, source.object_id);
    assert.equal(call.sha256, source.sha256);
    assert.equal(call.pages, source.pages);
  }
  assert.equal(manifest.scaling[23].object_id, manifest.correctness[0].object_id);
  // Rebuild is byte-identical: the manifest is deterministic.
  const again = buildQualificationManifest({ corpus, subsetIndex, subsetHashes });
  assert.deepEqual(again, manifest);
});

test('manifest carries no document text — hashes, counts, and labels only', () => {
  const allowed = new Set(['request_id', 'object_id', 'sha256', 'bytes', 'pages',
    'class_labels', 'expected_disposition', 'permission']);
  for (const entry of [...manifest.correctness, ...manifest.scaling]) {
    for (const key of Object.keys(entry)) assert.ok(allowed.has(key), `unexpected field ${key}`);
  }
  assert.ok(manifest.distributions.total_pages > 0);
  assert.ok(manifest.distributions.documents_with_label['native-text'] > 0);
});

test('the committed qualification manifest exists and is structurally valid', () => {
  const path = join(root, 'evaluation', 'modal-qualification', 'manifest.v1.json');
  assert.ok(existsSync(path), 'evaluation/modal-qualification/manifest.v1.json is committed');
  const committed = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(committed.schemaVersion, 'pagespatial-modal-qualification-v1');
  assert.equal(committed.correctness.length, 23);
  assert.equal(committed.scaling.length, 100);
  assert.equal(committed.distributions.total_pages, 162);
  for (const entry of committed.correctness) assert.match(entry.sha256, /^[0-9a-f]{64}$/u);
  // The fixed order must be self-consistent (scaling wraps the 23).
  assert.equal(committed.scaling[23].object_id, committed.correctness[0].object_id);
});

// ---------------------------------------------------------------------------
// Reconciliation (§12).
// ---------------------------------------------------------------------------

const expected = manifest.correctness.slice(0, 5);
const resultFor = (entry, overrides = {}) => ({
  request_id: entry.request_id,
  document_sha256: entry.sha256,
  page_count: entry.pages,
  status: 'completed',
  pages: [],
  pages_ok: entry.pages,
  pages_failed: 0,
  failure: null,
  timing: { container_cold: false, queue_wait_ms: null, service_ready_ms: 0, parse_ms: 1000, total_method_ms: 1100 },
  ...overrides,
});

test('reconciler flags silent missing inputs, duplicates, and unexpected ids', () => {
  const captures = [
    resultFor(expected[0]),
    resultFor(expected[1]),
    resultFor(expected[1]), // duplicate terminal output
    { request_id: expected[2].request_id, kind: 'exception', error: 'InputRejected: sha mismatch' },
    resultFor({ ...expected[3], request_id: 'not-in-manifest' }),
    // expected[3] and expected[4] silently missing
  ];
  const aggregation = reconcileRun({ expected, captures });
  assert.deepEqual(aggregation.documents.missing,
    [expected[3].request_id, expected[4].request_id]);
  assert.deepEqual(aggregation.documents.unexpected, ['not-in-manifest']);
  assert.deepEqual(aggregation.documents.duplicates,
    [{ request_id: expected[1].request_id, terminal_outputs: 2 }]);
  assert.equal(aggregation.documents.rejected, 1);
  assert.equal(aggregation.documents.completed, 4);
});

test('reconciler detects page-count and sha mismatches against the manifest', () => {
  const captures = [
    resultFor(expected[0], { page_count: expected[0].pages + 1 }),
    resultFor(expected[1], { document_sha256: 'f'.repeat(64) }),
  ];
  const aggregation = reconcileRun({ expected: expected.slice(0, 2), captures });
  assert.equal(aggregation.pages.count_mismatches.length, 1);
  assert.equal(aggregation.pages.count_mismatches[0].request_id, expected[0].request_id);
  assert.deepEqual(aggregation.pages.sha_mismatches, [{ request_id: expected[1].request_id }]);
});

test('cold/warm latency split and failure classes are reported separately', () => {
  const captures = [
    resultFor(expected[0], { timing: { container_cold: true, queue_wait_ms: null, service_ready_ms: 80000, parse_ms: 2000, total_method_ms: 2200 } }),
    resultFor(expected[1], { timing: { container_cold: false, queue_wait_ms: null, service_ready_ms: 0, parse_ms: 1000, total_method_ms: 1100 } }),
    resultFor(expected[2], {
      status: 'failed', pages_ok: 0,
      failure: { class: 'ResultTooLarge', message: 'too big' },
      timing: { container_cold: false, queue_wait_ms: null, service_ready_ms: 0, parse_ms: 900, total_method_ms: 950 },
    }),
  ];
  const aggregation = reconcileRun({ expected: expected.slice(0, 3), captures });
  assert.equal(aggregation.latency.cold.total_method_ms.count, 1);
  assert.equal(aggregation.latency.cold.total_method_ms.max, 2200);
  assert.equal(aggregation.latency.warm.total_method_ms.count, 2);
  assert.deepEqual(aggregation.failure_classes, { ResultTooLarge: 1 });
});

test('readiness, reuse, retries, and cleanup outcomes come from LOGS, not results', () => {
  // The rejected-first-call scenario (PR #89 closure): the container went
  // cold-ready, the first call was rejected, so the SECOND call's result
  // reports service_ready_ms=0 and container_cold=true is long gone. Only
  // the service_started log event carries the 80172 ms readiness.
  const captures = [resultFor(expected[0])]; // service_ready_ms: 0 in the result
  const containerA = [
    '2026-08-23T10:00:00Z {"event":"service_started","node_pid":5,"container_cold":true,"service_ready_ms":80172}',
    `{"event":"job_submitted","request_id":"${expected[0].request_id}","http_status":202,"job_id":"j1"}`,
    `{"event":"job_submitted","request_id":"${expected[1].request_id}","http_status":202,"job_id":"j2"}`,
    `{"event":"cleanup","request_id":"${expected[0].request_id}","cleanup_ok":true,"removed":[]}`,
    `{"event":"cleanup","request_id":"${expected[1].request_id}","cleanup_ok":false,"error":"EACCES"}`,
    `{"event":"retiring","reason":"node_child_died","jobs_created":2}`,
    'plain non-JSON log line — ignored',
  ].join('\n');
  const containerB = [
    '{"event":"service_started","node_pid":5,"container_cold":true,"service_ready_ms":70500}',
    // The retry of expected[1] after the child death landed here:
    `{"event":"job_submitted","request_id":"${expected[1].request_id}","http_status":202,"job_id":"j1"}`,
  ].join('\n');
  const logEvents = [...parseLogText(containerA, 'ta-A'), ...parseLogText(containerB, 'ta-B')];
  const aggregation = reconcileRun({ expected: expected.slice(0, 1), captures, logEvents });
  assert.equal(aggregation.containers.cold_starts, 2);
  assert.deepEqual(aggregation.containers.readiness_ms, [80172, 70500]);
  assert.match(aggregation.containers.readiness_source, /log events/u);
  assert.deepEqual(aggregation.containers.jobs_per_container, { 'ta-A': 2, 'ta-B': 1 });
  assert.equal(aggregation.containers.reused, 1);
  assert.deepEqual(aggregation.retries.retried_inputs,
    [{ request_id: expected[1].request_id, attempts: 2 }]);
  assert.equal(aggregation.cleanup.failures, 1);
  assert.deepEqual(aggregation.retirements, { node_child_died: 1 });
  const table = renderAggregationTable(aggregation);
  assert.match(table, /cold readiness ms \(from logs\) \| 80172, 70500/u);
  assert.match(table, /silent missing inputs \| 0/u);
});
