import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createBrowserParser, openPdfJsSession } from 'pagespatial/browser';

const status = document.querySelector('#status');
const backend = new URL(location.href).searchParams.get('backend') ?? 'wasm';
let session;
let browser;
try {
  const response = await fetch('/fixture.pdf');
  if (!response.ok) throw new Error(`Fixture request failed: ${response.status}`);
  session = await openPdfJsSession(await response.arrayBuffer(), { workerSrc: pdfWorkerUrl, maxPages: 1 });
  browser = createBrowserParser({
    ocr: {
      detectionModelUrl: '/ocr/models/PP-OCRv6_tiny_det_onnx_infer.tar',
      recognitionModelUrl: '/ocr/models/PP-OCRv6_tiny_rec_onnx_infer.tar',
      wasmPaths: '/ocr/ort/',
      backend,
      localOnly: true
    }
  });
  const evidence = await browser.parser.parse(session.source, { runId: `packed-${backend}` });
  const ocr = evidence.pages.flatMap((page) => page.ocrObservations.map((item) => item.text)).join(' ');
  const native = evidence.pages.flatMap((page) => page.nativeObservations.map((item) => item.text)).join(' ');
  const result = {
    backend: browser.ocr.getBackend(),
    pages: evidence.pages.length,
    hasRasterYear: /FY\s*2021/i.test(ocr),
    hasRasterValue: /(?:^|\D)527(?:\D|$)/.test(ocr),
    hasNativeHeading: /Native heading: PageSpatial smoke fixture/i.test(native),
    crossOriginIsolated
  };
  status.textContent = JSON.stringify(result);
  status.dataset.result = JSON.stringify(result);
  status.dataset.done = 'true';
} catch (error) {
  status.textContent = error?.stack ?? String(error);
  status.dataset.error = 'true';
} finally {
  await browser?.dispose();
  await session?.dispose();
}
