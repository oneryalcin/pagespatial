# Experimental browser adapter trial — 2026-08-19

## Decision under test

Use one shared PDF.js session for page-native extraction and rendering. Run PP-OCRv6 Tiny on every rendered page. Keep one OCR engine, verify its actual providers, serialize inference, and fall back once from WebGPU to sticky WASM.

## Input

- Local file: `1-pager_Example.pdf`
- SHA-256: `26831734209e43c6c3d5193aad650d7bd61cc6c2636a16f523c3484b85aafc49`
- Size: 161,763 bytes
- Pages: 3
- The original input PDF is not redistributable and is not retained. A separate packed-package smoke generates a one-page fixture with native text plus raster-only `FY2021 527` at runtime.

## Configuration

- PDF.js: 5.5.207
- `@paddleocr/paddleocr-js`: 0.4.2
- ONNX Runtime Web assets: 1.24.3
- PP-OCRv6 Tiny detector and recognizer archives from the pinned manifest
- Render scale: 1.6
- Parser page concurrency: 2
- OCR prediction concurrency: 1
- Browser: headless Google Chrome on Apple Silicon
- Cross-origin isolated: yes
- Routing: WebGPU first, WASM fallback available
- Network policy: abort every request whose hostname is not `127.0.0.1`

## Result

- Actual OCR backend: WebGPU for detector and recognizer
- Elapsed parse time: 2,639 ms
- Pages parsed: 3
- OCR observations: 146
- Native PDF.js observations: 307
- Chart OCR recovered `FY2021`: yes
- Chart OCR recovered `527`: yes
- Native extraction recovered `TRANSACTION BACKGROUND`: yes
- External requests: 0
- Pages requiring escalation: page 3 only
- Page 3 reason: one critical-token conflict between native and OCR evidence

The result reproduces the Evidence Search OCR observation count and chart recovery through the new package adapters. The timing is a local feasibility measurement, not a production latency claim.

## Failure trials retained

1. Vite dependency optimization omitted Paddle's generated worker asset. Fix for the smoke harness: exclude `@paddleocr/paddleocr-js` and prebundle its CommonJS dependencies.
2. ORT's dynamic module request included `?import`; Vite refused to transform an asset from `publicDir`. The smoke harness served `/ort/*` as raw same-origin files. Production applications should serve OCR assets through a normal static server, as Evidence Search does.
3. Early runs used a stale Vite process and exercised old smoke source. The server PID was resolved, stopped, and the current source was verified before the accepted run.

These are integration-tooling failures, not parser accuracy failures. They show why PageSpatial injects asset URLs and does not modify a consumer's build pipeline.

## Retained package smoke

`test/browser-smoke/` packs and extracts the npm tarball, generates a mixed native/raster PDF, serves verified same-origin assets, blocks every non-loopback request, and asserts the actual OCR provider. WASM is the portable lane. WebGPU is a separate release lane for capable hardware.

Both retained lanes passed on 2026-08-19:

- WASM: one page parsed; raster-only `FY2021` and `527` recovered; native heading recovered; cross-origin isolation active; zero external requests.
- WebGPU: the same evidence assertions passed and both OCR sessions reported WebGPU; zero external requests.

## What this does not prove

- General OCR accuracy
- Rotated or cropped real documents
- Scans, handwriting, multilingual documents, or dense tables
- WASM latency on this document
- Server GPU equivalence
- Production readiness

Promotion still requires the sealed corpus and the gates in `docs/evaluation-rubric.md`.
