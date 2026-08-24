#!/usr/bin/env node

/**
 * Benchmark-only A2 controller.
 *
 * Four Node producer processes run the real render + native stages. Their
 * rendered PNGs are queued, by path, to one Python-owned TensorRT engine over
 * JSONL stdout/stdin. The parent runs the real assembly stage and publishes a
 * deterministic terminal bundle. This file is not imported by the service and
 * cannot select the production OCR adapter.
 *
 * Controller -> Python:
 *   {kind:"ocr", id, pageNumber, pngPath, geometry, producedAtNs}
 *   {kind:"done", resultPath}
 *   {kind:"fatal", error}
 * Python -> controller:
 *   {kind:"ocr-result", id, lines, inferenceMs, queueWaitMs}
 *
 * Producer mode is internal (`--producer`) and uses Node IPC, not JSONL.
 */

import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import {
  assemblyStage,
  openDocumentContext,
  renderStage,
  RENDER_SCALE
} from '../../service/lib/stages.mjs';

export const MAX_OUTSTANDING_PAGES = 8;
export const MAX_OUTSTANDING_BYTES = 128 * 1024 * 1024;
export const PRODUCER_COUNT = 4;

const CONTROLLER_PATH = fileURLToPath(import.meta.url);

function nowNs() {
  return Number(process.hrtime.bigint());
}

function errorText(error) {
  return `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;
}

export function validateOcrLines(lines, pageNumber) {
  if (!Array.isArray(lines)) throw new Error(`page ${pageNumber}: OCR lines must be an array`);
  return lines
    .filter((line) => typeof line?.text === 'string' && line.text.trim())
    .map((line, index) => {
      if (!Number.isFinite(line.score) || line.score < 0 || line.score > 1) {
        throw new Error(`page ${pageNumber}: OCR line ${index} has invalid confidence ${line.score}`);
      }
      if (!Array.isArray(line.poly) || line.poly.length < 3 ||
          line.poly.some((point) => !Array.isArray(point) || point.length !== 2 ||
            !point.every(Number.isFinite))) {
        throw new Error(`page ${pageNumber}: OCR line ${index} has an invalid polygon`);
      }
      const polygon = line.poly.map(([x, y]) => [x, y]);
      const xs = polygon.map(([x]) => x);
      const ys = polygon.map(([, y]) => y);
      return {
        id: `ppocr-a2:${pageNumber}:${index}`,
        pageNumber,
        text: line.text,
        box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        polygon,
        confidence: line.score,
        model: 'PP-OCRv6_small'
      };
    });
}

export function orderedTerminalPages(results, expectedPages) {
  if (!(results instanceof Map)) throw new Error('results must be a Map');
  if (results.size !== expectedPages) {
    throw new Error(`terminal reconciliation failed: ${results.size}/${expectedPages} pages`);
  }
  const ordered = [];
  for (let pageNumber = 1; pageNumber <= expectedPages; pageNumber += 1) {
    const result = results.get(pageNumber);
    if (!result) throw new Error(`terminal reconciliation failed: page ${pageNumber} missing`);
    if (result.ok !== true || result.pageNumber !== pageNumber || !result.pageSpatial) {
      throw new Error(`terminal reconciliation failed: page ${pageNumber} is not successful`);
    }
    ordered.push(result);
  }
  return ordered;
}

export class OutstandingBudget {
  constructor(maxPages = MAX_OUTSTANDING_PAGES, maxBytes = MAX_OUTSTANDING_BYTES) {
    this.maxPages = maxPages;
    this.maxBytes = maxBytes;
    this.pages = 0;
    this.bytes = 0;
    this.peakPages = 0;
    this.peakBytes = 0;
  }

  canReserve(bytes) {
    return Number.isSafeInteger(bytes) && bytes >= 0 &&
      this.pages + 1 <= this.maxPages && this.bytes + bytes <= this.maxBytes;
  }

  reserve(bytes) {
    if (!this.canReserve(bytes)) {
      throw new Error(`A2 queue bound exceeded: pages=${this.pages + 1}/${this.maxPages}, bytes=${this.bytes + bytes}/${this.maxBytes}`);
    }
    this.pages += 1;
    this.bytes += bytes;
    this.peakPages = Math.max(this.peakPages, this.pages);
    this.peakBytes = Math.max(this.peakBytes, this.bytes);
  }

  release(bytes) {
    this.pages -= 1;
    this.bytes -= bytes;
    if (this.pages < 0 || this.bytes < 0) throw new Error('A2 queue accounting underflow');
  }
}

function protocolWrite(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function runProducer() {
  let context;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await context?.dispose().catch(() => undefined);
    process.exit(0);
  };
  process.on('disconnect', () => { void stop(); });
  process.on('message', async (message) => {
    if (message?.kind === 'stop') {
      await stop();
      return;
    }
    if (message?.kind !== 'produce') return;
    try {
      context ??= await openDocumentContext(message.pdfPath, message.identity);
      if (context.identity.sha256 !== message.identity.sha256) {
        throw new Error(`producer source identity mismatch for page ${message.pageNumber}`);
      }
      const rendered = await renderStage(context, message.pageNumber, message.renderScale);
      const bytes = Buffer.from(rendered.value.raster.data);
      const pngPath = join(message.scratchDir, `page-${String(message.pageNumber).padStart(4, '0')}-${randomUUID()}.png`);
      writeFileSync(pngPath, bytes);
      process.send({
        kind: 'produced',
        pageNumber: message.pageNumber,
        pngPath,
        pngBytes: bytes.length,
        renderedPage: rendered.value.renderedPage,
        stageTimingsMs: { render: rendered.ms },
        producedAtNs: nowNs()
      });
    } catch (error) {
      process.send({ kind: 'producer-error', pageNumber: message.pageNumber, error: errorText(error) });
    }
  });
  process.send({ kind: 'producer-ready' });
}

export async function runController(options) {
  const pdfPath = resolve(options.pdfPath);
  const nativeEvidencePath = resolve(options.nativeEvidencePath);
  const resultPath = resolve(options.resultPath);
  const scratchDir = resolve(options.scratchDir);
  const expectedPages = Number(options.expectedPages ?? 50);
  const producerCount = Number(options.producerCount ?? PRODUCER_COUNT);
  const maxOutstandingPages = Number(options.maxOutstandingPages ?? MAX_OUTSTANDING_PAGES);
  const maxOutstandingBytes = Number(options.maxOutstandingBytes ?? MAX_OUTSTANDING_BYTES);
  const runId = options.runId ?? `gpu-a2-${randomUUID()}`;
  if (!Number.isInteger(expectedPages) || expectedPages < 1) throw new Error('expectedPages must be positive');
  if (!Number.isInteger(producerCount) || producerCount < 1) throw new Error('producerCount must be positive');
  mkdirSync(scratchDir, { recursive: true });

  const startedNs = nowNs();
  const context = await openDocumentContext(pdfPath);
  if (context.pageCount !== expectedPages) {
    await context.dispose();
    throw new Error(`expected ${expectedPages} pages, source has ${context.pageCount}`);
  }
  const nativeEvidence = JSON.parse(readFileSync(nativeEvidencePath, 'utf8'));
  if (nativeEvidence.schemaVersion !== 'pagespatial-gpu-a2-native-evidence-v1' ||
      nativeEvidence.document?.sha256 !== context.identity.sha256 ||
      nativeEvidence.adapter !== `${context.native.name}@${context.native.version}` ||
      nativeEvidence.pageCount !== expectedPages ||
      !Array.isArray(nativeEvidence.pages) || nativeEvidence.pages.length !== expectedPages) {
    await context.dispose();
    throw new Error('precomputed native evidence does not match the source document');
  }
  const nativeByPage = new Map(nativeEvidence.pages.map((entry) => [entry.pageNumber, entry]));
  for (let pageNumber = 1; pageNumber <= expectedPages; pageNumber += 1) {
    const entry = nativeByPage.get(pageNumber);
    if (!entry || entry.nativePage?.pageNumber !== pageNumber || !Number.isFinite(entry.extractionMs)) {
      await context.dispose();
      throw new Error(`precomputed native evidence is invalid for page ${pageNumber}`);
    }
  }

  const adapter = {
    name: 'ppocrv6-small-a2',
    version: '3.7.0',
    canonical: true,
    descriptor: 'ppocrv6-small-a2@3.7.0#det=onnxruntime;rec=tensorrt;precision=fp32;owner=shared',
    backend: {
      adapter: 'ppocrv6-small-a2',
      version: '3.7.0',
      variant: 'small',
      executionProvider: 'onnxruntime+tensorrt',
      precision: 'fp32',
      owner: 'shared',
      deploymentProfile: 'en-gpu'
    }
  };

  const budget = new OutstandingBudget(maxOutstandingPages, maxOutstandingBytes);
  const pending = new Map();
  const pendingPages = new Set();
  const results = new Map();
  const producerState = new Map();
  const assemblyTasks = new Set();
  let nextPage = 1;
  let fatal;
  let ownerEnded = false;
  let finished = false;

  const producers = Array.from({ length: producerCount }, () => {
    const child = fork(CONTROLLER_PATH, ['--producer'], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      serialization: 'advanced'
    });
    producerState.set(child.pid, { child, ready: false, busy: false, expectedExit: false });
    return child;
  });

  const cleanup = async () => {
    for (const state of producerState.values()) {
      state.expectedExit = true;
      try { state.child.send({ kind: 'stop' }); } catch { /* already gone */ }
    }
    await Promise.all(producers.map((child) => new Promise((resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5_000);
      child.once('exit', () => { clearTimeout(timer); resolveExit(); });
    })));
    await context.dispose().catch(() => undefined);
    for (const entry of pending.values()) {
      try { unlinkSync(entry.pngPath); } catch { /* method scratch owns fallback */ }
    }
  };

  const maybeAssign = () => {
    if (fatal || finished) return;
    for (const state of producerState.values()) {
      if (!state.ready || state.busy || nextPage > expectedPages) continue;
      // Each busy producer can add one page. Refuse to create an unbounded
      // hidden producer backlog behind the explicit owner queue.
      if (budget.pages + [...producerState.values()].filter((item) => item.busy).length >= maxOutstandingPages) break;
      state.busy = true;
      const pageNumber = nextPage++;
      state.child.send({
        kind: 'produce',
        pdfPath,
        identity: context.identity,
        pageNumber,
        renderScale: RENDER_SCALE,
        scratchDir
      });
    }
  };

  const finishIfComplete = async () => {
    if (finished || fatal || results.size !== expectedPages || pending.size || assemblyTasks.size) return;
    finished = true;
    const pages = orderedTerminalPages(results, expectedPages);
    const endedNs = nowNs();
    const payload = {
      schemaVersion: 'pagespatial-gpu-a2-result-v1',
      status: 'completed',
      runId,
      document: context.identity,
      pageCount: expectedPages,
      pages,
      timing: {
        wallMs: (endedNs - startedNs) / 1e6,
        pagesPerS: expectedPages / ((endedNs - startedNs) / 1e9),
        scope: 'render+queue+tensorrt-ocr+assembly',
        nativePrecompute: {
          includedInWall: false,
          totalWallMs: nativeEvidence.timing?.totalWallMs,
          summedPageMs: nativeEvidence.timing?.summedPageMs,
          host: nativeEvidence.host
        }
      },
      queue: {
        maxPages: budget.maxPages,
        maxBytes: budget.maxBytes,
        peakPages: budget.peakPages,
        peakBytes: budget.peakBytes
      },
      provenance: {
        deploymentProfile: 'en-gpu',
        adapter: adapter.descriptor,
        producerCount,
        renderScale: RENDER_SCALE,
        nativeEvidenceMode: 'precomputed-cpu',
        nativeAdapter: nativeEvidence.adapter
      }
    };
    writeFileSync(resultPath, `${JSON.stringify(payload)}\n`);
    protocolWrite({ kind: 'done', resultPath });
  };

  const fail = (error) => {
    if (fatal || finished) return;
    fatal = error instanceof Error ? error : new Error(String(error));
  };

  for (const child of producers) {
    const state = producerState.get(child.pid);
    child.on('message', (message) => {
      if (fatal || finished) return;
      if (message?.kind === 'producer-ready') {
        state.ready = true;
        maybeAssign();
        return;
      }
      if (message?.kind === 'producer-error') {
        fail(new Error(`producer failed page ${message.pageNumber}: ${message.error}`));
        return;
      }
      if (message?.kind !== 'produced') return;
      state.busy = false;
      try {
        if (pendingPages.has(message.pageNumber) || results.has(message.pageNumber)) {
          throw new Error(`duplicate produced page ${message.pageNumber}`);
        }
        budget.reserve(message.pngBytes);
        const nativeEntry = nativeByPage.get(message.pageNumber);
        const id = `${runId}:${message.pageNumber}:${randomUUID()}`;
        pending.set(id, {
          ...message,
          id,
          nativePage: nativeEntry.nativePage,
          nativePrecomputeMs: nativeEntry.extractionMs
        });
        pendingPages.add(message.pageNumber);
        protocolWrite({
          kind: 'ocr',
          id,
          pageNumber: message.pageNumber,
          pngPath: message.pngPath,
          geometry: message.renderedPage.geometry,
          producedAtNs: message.producedAtNs
        });
        maybeAssign();
      } catch (error) {
        fail(error);
      }
    });
    child.on('exit', (code, signal) => {
      if (!state.expectedExit && !finished) {
        fail(new Error(`producer ${child.pid} exited unexpectedly (code=${code}, signal=${signal})`));
      }
    });
  }

  const input = createInterface({ input: process.stdin });
  input.on('line', (line) => {
    if (fatal || finished || !line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch (error) { fail(new Error(`invalid owner JSON: ${error.message}`)); return; }
    if (message.kind === 'fatal') { fail(new Error(`GPU owner failed: ${message.error}`)); return; }
    if (message.kind !== 'ocr-result') { fail(new Error(`unknown owner message kind: ${message.kind}`)); return; }
    const entry = pending.get(message.id);
    if (!entry) { fail(new Error(`missing or duplicate OCR response id ${message.id}`)); return; }
    pending.delete(message.id);
    pendingPages.delete(entry.pageNumber);
    budget.release(entry.pngBytes);
    try { unlinkSync(entry.pngPath); } catch { /* method scratch owns fallback */ }
    const task = (async () => {
      const observations = validateOcrLines(message.lines, entry.pageNumber);
      const ocrPage = { pageNumber: entry.pageNumber, observations, backend: 'onnxruntime+tensorrt' };
      const assembled = await assemblyStage(
        context,
        entry.pageNumber,
        adapter,
        entry.nativePage,
        entry.renderedPage,
        ocrPage,
        {
          runId,
          ocrAdapterId: adapter.descriptor,
          configuration: {
            renderScale: RENDER_SCALE,
            deploymentProfile: 'en-gpu',
            ocrBackend: adapter.backend
          }
        }
      );
      if (results.has(entry.pageNumber)) throw new Error(`duplicate terminal page ${entry.pageNumber}`);
      results.set(entry.pageNumber, {
        pageNumber: entry.pageNumber,
        ok: true,
        pageSpatial: assembled.value.pageSpatial,
        stageTimingsMs: {
          ...entry.stageTimingsMs,
          nativePrecomputeExcluded: entry.nativePrecomputeMs,
          ocr: message.inferenceMs,
          ocrQueueWait: message.queueWaitMs,
          assembly: assembled.ms,
          ...(assembled.value.secondOpinionMs === undefined ? {} : { secondOpinion: assembled.value.secondOpinionMs })
        }
      });
    })();
    assemblyTasks.add(task);
    task.catch(fail).finally(() => {
      assemblyTasks.delete(task);
      maybeAssign();
      void finishIfComplete();
    });
    maybeAssign();
  });
  input.on('close', () => { ownerEnded = true; if (!finished) fail(new Error('GPU owner input closed before terminal completion')); });

  try {
    const deadline = Date.now() + Number(options.timeoutMs ?? 1_000_000);
    while (!finished && !fatal && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      await finishIfComplete();
    }
    if (!finished && !fatal) fail(new Error('A2 controller deadline exceeded'));
    if (fatal) throw fatal;
    if (ownerEnded && !finished) throw new Error('GPU owner ended before result publication');
  } finally {
    input.close();
    await cleanup();
  }
  return JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(resultPath, 'utf8')));
}

async function cli() {
  if (process.argv.includes('--producer')) return runProducer();
  const value = (flag) => {
    const index = process.argv.indexOf(flag);
    if (index < 0 || !process.argv[index + 1]) throw new Error(`${flag} is required`);
    return process.argv[index + 1];
  };
  try {
    await runController({
      pdfPath: value('--pdf'),
      nativeEvidencePath: value('--native-evidence'),
      resultPath: value('--result'),
      scratchDir: value('--scratch'),
      runId: value('--run-id'),
      expectedPages: Number(value('--expected-pages'))
    });
  } catch (error) {
    protocolWrite({ kind: 'fatal', error: errorText(error) });
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await cli();
}
