/**
 * M2 instruments for the Modal qualification run (design doc
 * 2026-08-23-modal-scaling-and-deployment.md §14.1, §12): pure functions to
 * (a) build the fixed 23-document correctness manifest plus the
 * deterministic 100-call scaling manifest, and (b) reconcile a run's
 * captured results and container logs against a manifest into the §12
 * trial-aggregation table.
 *
 * Everything here is content-free: hashes, counts, ids, and durations only.
 * Corpus documents and their text NEVER enter the manifest or this module.
 *
 * Readiness caveat (§12, PR #89 closure): after a rejected first call the
 * next result reports service_ready_ms=0 — cold readiness is therefore read
 * from `service_started` LOG events, never from results.
 */

export const SCALING_CALL_COUNT = 100;
export const MANIFEST_SCHEMA = 'pagespatial-modal-qualification-v1';

const REQUEST_ID_SAFE = (objectId) => objectId.replace(/[^A-Za-z0-9]+/gu, '_');

/**
 * Build the qualification manifest. Inputs:
 *  - corpus: parsed evaluation/corpus.v1.json (class labels per page);
 *  - subsetIndex: parsed .evaluation/m1-subset-pdfs/index.json (the fixed
 *    published document order and per-subset page counts);
 *  - subsetHashes: Map/object objectId -> {sha256, bytes} measured from the
 *    LOCAL subset PDFs (which stay outside git).
 */
export function buildQualificationManifest({ corpus, subsetIndex, subsetHashes }) {
  const byObjectId = new Map(corpus.documents.map((document) => [document.objectId, document]));
  const hashOf = (objectId) => {
    const entry = subsetHashes instanceof Map ? subsetHashes.get(objectId) : subsetHashes[objectId];
    if (!entry?.sha256 || !Number.isSafeInteger(entry.bytes)) {
      throw new Error(`Missing subset sha256/bytes for ${objectId}`);
    }
    return entry;
  };

  const correctness = subsetIndex.documents.map((subset, index) => {
    const source = byObjectId.get(subset.objectId);
    if (!source) throw new Error(`Subset document not in corpus: ${subset.objectId}`);
    if (source.split !== 'development') throw new Error(`Non-development document in subset: ${subset.objectId}`);
    const { sha256, bytes } = hashOf(subset.objectId);
    const labels = [...new Set(source.pages.flatMap((page) => page.labels))].sort();
    return {
      request_id: `m3-corr-${String(index + 1).padStart(2, '0')}-${REQUEST_ID_SAFE(subset.objectId)}`,
      object_id: subset.objectId,
      sha256,
      bytes,
      pages: subset.pageCount,
      class_labels: labels,
      // §14.1 "expected parser disposition, if known": every development
      // document has parsed to terminal completion on the reference host.
      expected_disposition: 'completed',
      // All corpus documents come from the public evaluation dataset
      // (corpus.v1.json `dataset`): approved, non-sensitive, public.
      permission: 'approved-public-evaluation',
    };
  });
  if (correctness.length !== 23) {
    throw new Error(`Correctness manifest must have exactly 23 documents, got ${correctness.length}`);
  }

  // Deterministic 100-call scaling manifest: repeat the 23 documents in the
  // fixed published order above; every call gets a DISTINCT request id and
  // keeps its source document hash (§14.1).
  const scaling = Array.from({ length: SCALING_CALL_COUNT }, (unused, callIndex) => {
    const source = correctness[callIndex % correctness.length];
    return {
      request_id: `m3-scale-${String(callIndex + 1).padStart(3, '0')}-${REQUEST_ID_SAFE(source.object_id)}`,
      object_id: source.object_id,
      sha256: source.sha256,
      bytes: source.bytes,
      pages: source.pages,
    };
  });

  return {
    schemaVersion: MANIFEST_SCHEMA,
    source: {
      corpus: 'evaluation/corpus.v1.json',
      subset_builder: 'scripts/evaluation/build-corpus-subset-pdfs.mjs',
      note: 'Subset PDFs live outside git; this manifest carries hashes and counts only.',
    },
    correctness,
    scaling,
    distributions: manifestDistributions(correctness),
  };
}

/** Text-free distribution counts (§14.1). */
export function manifestDistributions(correctness) {
  const labelPages = {};
  for (const document of correctness) {
    for (const label of document.class_labels) {
      labelPages[label] = (labelPages[label] ?? 0) + 1;
    }
  }
  const bytesList = correctness.map((document) => document.bytes).sort((a, b) => a - b);
  const pagesList = correctness.map((document) => document.pages).sort((a, b) => a - b);
  const docsWith = (label) => correctness.filter((document) => document.class_labels.includes(label)).length;
  return {
    documents: correctness.length,
    total_pages: pagesList.reduce((sum, value) => sum + value, 0),
    bytes: { min: bytesList[0], p50: percentile(bytesList, 50), max: bytesList.at(-1) },
    pages: { min: pagesList[0], p50: percentile(pagesList, 50), max: pagesList.at(-1) },
    // §14.1 explicit content/rotation/malformed counts (zero stated as zero).
    content: {
      native_text_documents: docsWith('native-text'),
      image_only_documents: docsWith('image-only'),
      mixed_raster_native_documents: docsWith('mixed-raster-native'),
    },
    rotation_landscape_documents: docsWith('landscape'),
    // The corpus label vocabulary has no malformed marker and no corpus
    // document is known-malformed: explicitly zero, not omitted.
    known_malformed_documents: docsWith('malformed'),
    documents_with_label: labelPages,
  };
}

export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const rank = (p / 100) * (sortedValues.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const weight = rank - low;
  return sortedValues[low] * (1 - weight) + sortedValues[high] * weight;
}

const summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.at(-1) ?? null,
  };
};

/**
 * Normalize one captured entry. Accepts either a raw adapter result object
 * or a wrapper {request_id, kind: 'result'|'exception', result?, error?,
 * spawned_at_ms?, result_at_ms?} written by the capture harness. The two
 * optional wall clocks (epoch ms at spawn() and at result/exception
 * receipt) are what make §12's completion percentiles and aggregate
 * pages/s derivable — the M3 harness must record them.
 */
function normalizeCapture(entry) {
  const clocks = {
    spawned_at_ms: Number.isFinite(entry?.spawned_at_ms) ? entry.spawned_at_ms : null,
    result_at_ms: Number.isFinite(entry?.result_at_ms) ? entry.result_at_ms : null,
  };
  if (entry && entry.kind === 'exception') {
    return { request_id: entry.request_id ?? null, kind: 'exception', error: String(entry.error ?? ''), ...clocks };
  }
  const result = entry?.kind === 'result' ? entry.result : entry;
  if (!result || typeof result.request_id !== 'string' || typeof result.status !== 'string') {
    throw new Error(`Unrecognized capture entry: ${JSON.stringify(entry)?.slice(0, 120)}`);
  }
  return { request_id: result.request_id, kind: 'result', result, ...clocks };
}

/** Best event wall clock: the adapter's own ts, else the log-line prefix. */
const eventTs = (event) => Number.isFinite(event.ts) ? event.ts
  : Number.isFinite(event.log_ts) ? event.log_ts : null;

/**
 * Reconcile captured results + container log events against the manifest
 * entries expected for this run (§12: metrics must reconcile to a manifest
 * of submitted request IDs — dashboard counts are not acceptance evidence).
 *
 *  - expected: the manifest entries submitted in this run/arm;
 *  - captures: one entry per awaited FunctionCall (result or exception);
 *  - logEvents: parsed structured log lines, each tagged with `container`
 *    (the reconciler derives cold starts, readiness, reuse, retries, and
 *    cleanup outcomes from LOGS, not results).
 */
export function reconcileRun({ expected, captures, logEvents = [] }) {
  const expectedById = new Map(expected.map((entry) => [entry.request_id, entry]));
  const normalized = captures.map(normalizeCapture);

  const seenIds = new Map();
  for (const capture of normalized) {
    const list = seenIds.get(capture.request_id) ?? [];
    list.push(capture);
    seenIds.set(capture.request_id, list);
  }

  const missing = [...expectedById.keys()].filter((id) => !seenIds.has(id));
  const unexpected = [...seenIds.keys()].filter((id) => id !== null && !expectedById.has(id));
  const duplicates = [...seenIds.entries()].filter(([, list]) => list.length > 1)
    .map(([id, list]) => ({ request_id: id, terminal_outputs: list.length }));

  const results = normalized.filter((capture) => capture.kind === 'result').map((capture) => capture.result);
  const exceptions = normalized.filter((capture) => capture.kind === 'exception');
  const completed = results.filter((result) => result.status === 'completed');
  const failed = results.filter((result) => result.status === 'failed');
  const rejected = exceptions.filter((entry) => /InputRejected|rejected/u.test(entry.error));

  const pageMismatches = [];
  const shaMismatches = [];
  for (const result of completed) {
    const manifestEntry = expectedById.get(result.request_id);
    if (!manifestEntry) continue;
    if (result.page_count !== manifestEntry.pages) {
      pageMismatches.push({ request_id: result.request_id, expected: manifestEntry.pages, actual: result.page_count });
    }
    if (manifestEntry.sha256 && result.document_sha256 !== manifestEntry.sha256) {
      shaMismatches.push({ request_id: result.request_id });
    }
  }

  const failureClasses = {};
  for (const result of failed) {
    const kind = result.failure?.class ?? 'unknown';
    failureClasses[kind] = (failureClasses[kind] ?? 0) + 1;
  }

  const latency = {
    cold: {
      total_method_ms: summarize(results.filter((r) => r.timing?.container_cold).map((r) => r.timing.total_method_ms)),
      parse_ms: summarize(results.filter((r) => r.timing?.container_cold).map((r) => r.timing.parse_ms)),
    },
    warm: {
      total_method_ms: summarize(results.filter((r) => r.timing && !r.timing.container_cold).map((r) => r.timing.total_method_ms)),
      parse_ms: summarize(results.filter((r) => r.timing && !r.timing.container_cold).map((r) => r.timing.parse_ms)),
    },
  };

  // ---- log-derived measures (§12; readiness comes ONLY from logs) ----
  const started = logEvents.filter((event) => event.event === 'service_started');
  const submittedJobs = logEvents.filter((event) => event.event === 'job_submitted');
  const jobsByContainer = {};
  for (const event of submittedJobs) {
    const key = event.container ?? 'unknown';
    jobsByContainer[key] = (jobsByContainer[key] ?? 0) + 1;
  }
  const submitsByRequest = new Map();
  for (const event of submittedJobs) {
    if (typeof event.request_id !== 'string') continue;
    submitsByRequest.set(event.request_id, (submitsByRequest.get(event.request_id) ?? 0) + 1);
  }
  const retriedInputs = [...submitsByRequest.entries()].filter(([, count]) => count > 1)
    .map(([id, count]) => ({ request_id: id, attempts: count }));
  const cleanupFailures = logEvents.filter((event) => event.event === 'cleanup' && event.cleanup_ok === false);
  const retirements = {};
  for (const event of logEvents.filter((event) => event.event === 'retiring')) {
    retirements[event.reason ?? 'unknown'] = (retirements[event.reason ?? 'unknown'] ?? 0) + 1;
  }
  const injected = {};
  for (const event of logEvents.filter((event) => event.event === 'injected_failure')) {
    injected[event.mode ?? 'unknown'] = (injected[event.mode ?? 'unknown'] ?? 0) + 1;
  }

  // ---- wall-clock-derived measures (§12) ----
  const terminalPages = results.reduce((sum, result) =>
    sum + (result.pages_ok ?? 0) + (result.pages_failed ?? 0), 0);
  const timed = normalized.filter((capture) =>
    Number.isFinite(capture.spawned_at_ms) && Number.isFinite(capture.result_at_ms));
  const spawnClocks = normalized.map((capture) => capture.spawned_at_ms).filter(Number.isFinite);
  const resultClocks = normalized.map((capture) => capture.result_at_ms).filter(Number.isFinite);
  const runWindowMs = spawnClocks.length && resultClocks.length
    ? Math.max(...resultClocks) - Math.min(...spawnClocks) : null;
  const throughput = {
    timed_calls: timed.length,
    completion_wall_ms: summarize(timed.map((capture) => capture.result_at_ms - capture.spawned_at_ms)),
    run_window_ms: runWindowMs,
    aggregate_pages_per_s: runWindowMs > 0 ? terminalPages / (runWindowMs / 1000) : null,
    source: 'capture-wrapper spawned_at_ms/result_at_ms wall clocks (M3 harness records them)',
  };

  // Container activity over time from event timestamps (the adapter's own
  // `ts`, else the `modal container logs --timestamps` prefix).
  const activity = {};
  for (const event of logEvents) {
    const ts = eventTs(event);
    if (ts === null) continue;
    const key = event.container ?? 'unknown';
    const window = activity[key] ?? { first_ts: ts, last_ts: ts, events: 0 };
    window.first_ts = Math.min(window.first_ts, ts);
    window.last_ts = Math.max(window.last_ts, ts);
    window.events += 1;
    activity[key] = window;
  }
  const edges = Object.values(activity)
    .flatMap((window) => [[window.first_ts, 1], [window.last_ts, -1]])
    .sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let live = 0;
  let maxConcurrent = 0;
  for (const [, delta] of edges) {
    live += delta;
    maxConcurrent = Math.max(maxConcurrent, live);
  }

  return {
    documents: {
      expected: expected.length,
      captured: normalized.length,
      completed: completed.length,
      failed: failed.length,
      rejected: rejected.length,
      other_exceptions: exceptions.length - rejected.length,
      missing,           // criterion 1: silent losses — must be empty
      unexpected,
      duplicates,
    },
    pages: {
      expected: expected.reduce((sum, entry) => sum + (entry.pages ?? 0), 0),
      terminal_ok: results.reduce((sum, result) => sum + (result.pages_ok ?? 0), 0),
      terminal_failed: results.reduce((sum, result) => sum + (result.pages_failed ?? 0), 0),
      count_mismatches: pageMismatches,
      sha_mismatches: shaMismatches,
    },
    failure_classes: failureClasses,
    latency,
    containers: {
      cold_starts: started.length,
      readiness_ms: started.map((event) => event.service_ready_ms),
      readiness_source: 'service_started log events (results under-report after a rejected first call)',
      jobs_per_container: jobsByContainer,
      reused: Object.values(jobsByContainer).filter((count) => count > 1).length,
      activity,
      max_concurrent: maxConcurrent,
    },
    throughput,
    retries: { retried_inputs: retriedInputs },
    cleanup: { failures: cleanupFailures.length },
    retirements,
    injected_failures: injected,
    // §12 rows this reconciler cannot derive from results+logs alone —
    // the M3 harness must capture these alongside (never claim them
    // from dashboard glances):
    not_derivable: [
      'container crash / OOM counts — capture `modal container list/logs` + FunctionCall history per arm',
      'peak ephemeral-disk use — capture probe_scratch disk_used_bytes during the run',
      'queue wait p50/p95/max — platform does not expose per-input queue wait; derive spawn->first-event gap from capture clocks + log ts as a proxy',
      'billed CPU/memory/USD — capture `modal billing report` per README',
    ],
  };
}

/** Render the §12 trial-aggregation table as markdown. */
export function renderAggregationTable(aggregation) {
  const { documents, pages, latency, containers } = aggregation;
  const fmt = (summary) => summary.count === 0 ? 'n/a'
    : `p50 ${Math.round(summary.p50)} / p95 ${Math.round(summary.p95)} / max ${summary.max} (n=${summary.count})`;
  const lines = [
    '| measure | value |',
    '|---|---|',
    `| documents expected / captured | ${documents.expected} / ${documents.captured} |`,
    `| completed / failed / rejected / other exceptions | ${documents.completed} / ${documents.failed} / ${documents.rejected} / ${documents.other_exceptions} |`,
    `| silent missing inputs | ${documents.missing.length}${documents.missing.length ? ' — ' + documents.missing.join(', ') : ''} |`,
    `| duplicate terminal outputs | ${documents.duplicates.length} |`,
    `| pages expected / terminal ok / terminal failed | ${pages.expected} / ${pages.terminal_ok} / ${pages.terminal_failed} |`,
    `| page-count mismatches / sha mismatches | ${pages.count_mismatches.length} / ${pages.sha_mismatches.length} |`,
    `| cold method latency ms | ${fmt(latency.cold.total_method_ms)} |`,
    `| warm method latency ms | ${fmt(latency.warm.total_method_ms)} |`,
    `| cold starts (service_started logs) | ${containers.cold_starts} |`,
    `| cold readiness ms (from logs) | ${containers.readiness_ms.join(', ') || 'n/a'} |`,
    `| containers reused (>1 job) | ${containers.reused} |`,
    `| document completion wall ms | ${fmt(aggregation.throughput.completion_wall_ms)} |`,
    `| aggregate pages/s over run window | ${aggregation.throughput.aggregate_pages_per_s === null ? 'n/a (no capture clocks)' : aggregation.throughput.aggregate_pages_per_s.toFixed(3)} |`,
    `| max concurrent containers (log ts) | ${aggregation.containers.max_concurrent} |`,
    `| retried inputs | ${aggregation.retries.retried_inputs.length} |`,
    `| cleanup failures | ${aggregation.cleanup.failures} |`,
    `| retirements by reason | ${Object.entries(aggregation.retirements).map(([k, v]) => `${k}:${v}`).join(' ') || 'none'} |`,
    `| injected failures by mode | ${Object.entries(aggregation.injected_failures).map(([k, v]) => `${k}:${v}`).join(' ') || 'none'} |`,
    ...aggregation.not_derivable.map((row) => `| NOT DERIVABLE here | ${row} |`),
  ];
  return lines.join('\n');
}

/**
 * Extract structured adapter events from raw container log text. A leading
 * `modal container logs --timestamps` prefix (ISO date before the JSON) is
 * preserved as `log_ts` (epoch ms) — the fallback wall clock for events
 * from adapter revisions that predate the `ts` field.
 */
export function parseLogText(text, container = 'unknown') {
  const events = [];
  for (const line of text.split('\n')) {
    const start = line.indexOf('{');
    if (start < 0) continue;
    try {
      const parsed = JSON.parse(line.slice(start));
      if (!parsed || typeof parsed.event !== 'string') continue;
      const prefix = line.slice(0, start).trim().split(/\s+/u)[0] ?? '';
      const prefixMs = /^\d{4}-\d{2}-\d{2}T/u.test(prefix) ? Date.parse(prefix) : NaN;
      if (Number.isFinite(prefixMs)) parsed.log_ts = prefixMs;
      events.push({ ...parsed, container });
    } catch {
      // non-JSON log line — ignore
    }
  }
  return events;
}
