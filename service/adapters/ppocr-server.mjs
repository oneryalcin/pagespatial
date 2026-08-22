/**
 * Canonical server OCR witness — the PR #55 PP-OCRv6 node adapter behind the
 * service's adapter interface.
 *
 * canonical: true is earned, not asserted: the witness-equivalence run
 * (docs/trials/2026-08-22-server-native-ocr-witness.md, PR #59 stats) bounds
 * node-worse at 0.5% of gold at 95%. The backend is PINNED — adapter id,
 * model variant, execution provider, thread count — and the whole descriptor
 * lands in every record's provenance (owner condition on the witness swap:
 * no 'auto' anywhere).
 *
 * The service pipeline hands each page as an encoded PNG (pdftoppm output);
 * the engine consumes RGBA pixels, so the PNG is decoded here. Decode cost
 * is charged to the ocr stage: it exists only to feed the witness.
 */
import { PNG } from 'pngjs';

import { createPpOcrV6NodeAdapter } from '../../dist/node/ppocr-ocr.js';

export function createPpOcrServerAdapter(config = {}) {
  const { assetsDir, variant = 'small', numThreads = 4 } = config;
  if (!assetsDir) {
    throw new Error("ppocr-server requires an explicit assetsDir (SERVICE_OCR_ASSETS_DIR) — model assets are configuration, not magic.");
  }
  const inner = createPpOcrV6NodeAdapter({ assetsDir, variant, numThreads });
  // The full pinned backend, machine-readable (provenance.configuration) and
  // as one string (provenance.ocrAdapter).
  const backend = {
    adapter: inner.name,
    version: inner.version,
    variant,
    executionProvider: 'wasm',
    numThreads
  };
  return {
    name: inner.name,
    version: inner.version,
    canonical: true,
    backend,
    descriptor: `${inner.name}@${inner.version}#ep=wasm;threads=${numThreads}`,
    warmup: () => inner.warmup(),
    dispose: () => inner.dispose(),
    async recognize(page) {
      const png = PNG.sync.read(Buffer.from(page.data));
      return inner.recognize({
        pageNumber: page.pageNumber,
        geometry: page.geometry,
        data: { data: png.data, width: png.width, height: png.height }
      });
    }
  };
}
