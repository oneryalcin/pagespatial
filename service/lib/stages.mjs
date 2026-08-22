/**
 * Per-page pipeline stages, each individually timed. The service exists to
 * measure these numbers (issue #22): render / native / ocr / assembly /
 * second-opinion wall ms per page.
 *
 * Rendering uses pdftoppm (the established server raster path — crops and
 * gold samples already render through it) at the FRACTIONAL dpi 72 * scale,
 * while page GEOMETRY comes from pdf.js's viewport with the same convention
 * as the browser renderer (pointBounds from page.view, viewportTransform
 * from the viewport). Fractional dpi makes pdftoppm's raster dimensions
 * match pdf.js's Math.ceil geometry exactly (verified: 612x792pt at 1.6 ->
 * 980x1268 both ways); the actual PNG dimensions are still reported so the
 * #2 witness-equivalence run can verify the convention on every page.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { openNodePdfSession } from '../../dist/node/pdf-session.js';
import { createPdfInspectorNativeAdapter } from '../../dist/node/pdf-inspector.js';
import { assemblePageSpatial } from '../../dist/page-parser.js';
import { pageSpatialSchema } from '../../dist/schema.js';

export const RENDER_SCALE = 1.6;

const timed = async (fn) => {
  const start = performance.now();
  const value = await fn();
  return { value, ms: Math.round((performance.now() - start) * 10) / 10 };
};

/**
 * One open document: pdf.js session + cached whole-document pdf-inspector
 * extraction. Workers keep a tiny cache of these so a 300-page document
 * opens once per worker, not 300 times.
 */
export async function openDocumentContext(pdfPath, identity = {}) {
  const bytes = readFileSync(pdfPath);
  const session = await openNodePdfSession(bytes, identity);
  const native = createPdfInspectorNativeAdapter();
  // Every stage that shells out (pdftoppm render, Tesseract second opinion)
  // reads THIS context-private copy of the bytes the identity was computed
  // from — never the live path. A file swapped on disk after open therefore
  // cannot mix a second document into the record: the raster input equals
  // the pinned sha256 by construction.
  const privateDir = mkdtempSync(join(tmpdir(), 'psvc-doc-'));
  const privatePdfPath = join(privateDir, 'doc.pdf');
  writeFileSync(privatePdfPath, bytes);
  return {
    pdfPath: privatePdfPath,
    submittedPath: pdfPath,
    session,
    native,
    identity: session.source.identity,
    pageCount: session.source.identity.pageCount,
    dispose: async () => {
      rmSync(privateDir, { recursive: true, force: true });
      return session.dispose();
    }
  };
}

export async function renderStage(context, pageNumber, scale = RENDER_SCALE) {
  return timed(async () => {
    const page = await context.session.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const [viewX0, viewY0, viewX1, viewY1] = page.view;
    const geometry = {
      width: Math.ceil(viewport.width),
      height: Math.ceil(viewport.height),
      pointBounds: [viewX0, viewY0, viewX1, viewY1],
      pointWidth: viewX1 - viewX0,
      pointHeight: viewY1 - viewY0,
      rotation: viewport.rotation,
      viewportTransform: [...viewport.transform]
    };
    const dir = mkdtempSync(join(tmpdir(), 'psvc-render-'));
    try {
      execFileSync('pdftoppm', [
        '-f', String(pageNumber), '-l', String(pageNumber),
        '-r', String(72 * scale), '-png',
        context.pdfPath, join(dir, 'p')
      ]);
      const file = readdirSync(dir).find((name) => name.endsWith('.png'));
      if (!file) throw new Error(`pdftoppm produced no output for page ${pageNumber}.`);
      const png = readFileSync(join(dir, file));
      // PNG IHDR: width at bytes 16-19, height at 20-23, big-endian.
      const rasterWidth = png.readUInt32BE(16);
      const rasterHeight = png.readUInt32BE(20);
      return {
        renderedPage: { pageNumber, geometry },
        raster: { data: new Uint8Array(png), width: rasterWidth, height: rasterHeight, mimeType: 'image/png' }
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

export async function nativeStage(context, pageNumber) {
  return timed(() => context.native.extractPage(context.session.source, pageNumber));
}

export async function ocrStage(adapter, rendered, pageNumber) {
  return timed(() => adapter.recognize({
    pageNumber,
    geometry: rendered.renderedPage.geometry,
    data: rendered.raster.data,
    mimeType: rendered.raster.mimeType
  }));
}

/**
 * Assembly + conditional cross-family second opinion, mirroring the
 * evaluation harness flow (scripts/evaluation/run-baseline.mjs). Runs ONLY
 * for canonical OCR adapters — a stub witness must never reach this. The
 * gate is enforced HERE as well as at the worker call site (defense in
 * depth: refusal lives on both sides of the process boundary, so bypassing
 * one gate still cannot turn a stub witness into evidence).
 */
export async function assemblyStage(context, pageNumber, adapter, nativePage, renderedPage, ocrPage, options) {
  if (adapter?.canonical !== true) {
    throw new Error(`Assembly refused: OCR adapter '${adapter?.name ?? 'unknown'}' is not a canonical witness.`);
  }
  const assembled = await timed(async () => {
    const base = {
      document: context.identity,
      pageNumber,
      nativePage,
      renderedPage,
      ocrPage,
      runId: options.runId,
      nativeAdapter: `${context.native.name}@${context.native.version}`,
      renderer: 'pdftoppm+pdfjs-geometry',
      ocrAdapter: options.ocrAdapterId,
      createdAt: new Date().toISOString(),
      configuration: options.configuration
    };
    let pageSpatial = assemblePageSpatial(base);
    let secondOpinionMs;
    if (pageSpatial.diagnostics.escalationReasons.some(
      (reason) => reason.type === 'uncorroborated-ocr' && reason.severity === 'blocking'
    )) {
      const second = await timed(() => runTesseractSecondOpinion(context.pdfPath, pageNumber, renderedPage.geometry));
      secondOpinionMs = second.ms;
      if (second.value) pageSpatial = assemblePageSpatial({ ...base, secondOpinion: second.value });
    }
    pageSpatialSchema.parse(pageSpatial);
    return { pageSpatial, secondOpinionMs };
  });
  return assembled;
}

// Tesseract word boxes at 300dpi scaled into rendered pixels — the exact
// procedure the harness uses. Best-effort: a failure leaves starvation standing.
async function runTesseractSecondOpinion(pdfPath, pageNumber, geometry) {
  const { createTesseractAdapter } = await import('../../dist/node/tesseract-ocr.js');
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'psvc-so-'));
    execFileSync('pdftoppm', ['-f', String(pageNumber), '-l', String(pageNumber), '-r', '300', '-png', pdfPath, join(dir, 'p')]);
    const file = readdirSync(dir).find((name) => name.endsWith('.png'));
    if (!file) return undefined;
    const png = readFileSync(join(dir, file));
    const pngWidth = png.readUInt32BE(16);
    const scale = geometry.width / pngWidth;
    const adapter = createTesseractAdapter();
    const result = await adapter.recognize({
      pageNumber,
      geometry: { width: pngWidth, height: Math.round(pngWidth * geometry.height / geometry.width) },
      data: new Uint8Array(png)
    });
    const readings = result.observations
      .filter((observation) => observation.text.trim().length > 0)
      .map((observation) => ({
        box: observation.box.map((value) => Math.min(
          Math.max(0, Math.round(value * scale * 100) / 100),
          Math.max(geometry.width, geometry.height))),
        text: observation.text,
        ...(observation.confidence === undefined ? {} : { confidence: observation.confidence })
      }));
    if (!readings.length) return undefined;
    return { adapter: `${adapter.name}@${adapter.version}`, readings };
  } catch {
    return undefined;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
