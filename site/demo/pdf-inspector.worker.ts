/// <reference lib="webworker" />

import init, { processPdf } from '@firecrawl/pdf-inspector-wasm';

type InspectRequest = { id: string; bytes: ArrayBuffer; pageCount: number };
type InspectResponse = {
  id: string;
  pages?: Array<{ pageNumber: number; markdown: string }>;
  error?: string;
};

let initialization: Promise<unknown> | undefined;

self.addEventListener('message', async (event: MessageEvent<InspectRequest>) => {
  const { id, bytes, pageCount } = event.data;
  const response: InspectResponse = { id };
  try {
    initialization ??= init();
    await initialization;
    const data = new Uint8Array(bytes);
    response.pages = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const result = processPdf(data, {
        pages: [pageNumber],
        profile: 'fidelity',
        includePageMarkers: false,
        includeImages: true
      });
      response.pages.push({ pageNumber, markdown: result.markdown?.trim() ?? '' });
    }
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error);
  }
  self.postMessage(response);
});

export {};
