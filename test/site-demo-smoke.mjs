import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const url = process.env.PAGESPATIAL_SITE_URL ?? 'http://127.0.0.1:4173/';
const fixture = resolve(process.env.PAGESPATIAL_SITE_FIXTURE ?? '.evaluation/m1-subset-pdfs/world_bank_P170734_document_34222345.pdf');
const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true, executablePath: chrome });
try {
  const page = await browser.newPage();
  const unexpected = [];
  const browserLog = [];
  const allowedOrigin = new URL(url).origin;
  page.on('console', (message) => browserLog.push(`console:${message.type()}:${message.text()}`));
  page.on('pageerror', (error) => browserLog.push(`pageerror:${error.name}:${error.message}`));
  page.on('request', (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.origin !== allowedOrigin && requestUrl.protocol !== 'blob:') unexpected.push(request.url());
  });
  await page.goto(url);
  if (!await page.evaluate(() => crossOriginIsolated)) throw new Error('The public demo is not cross-origin isolated.');
  await page.locator('#demo-file').setInputFiles(fixture);
  await page.locator('#demo-submit').click();
  await page.locator('#demo-results').waitFor({ state: 'visible', timeout: 180_000 });
  const state = await page.evaluate(() => ({
    status: document.querySelector('#demo-status')?.textContent,
    pages: document.querySelectorAll('#demo-pages button').length,
    markdown: document.querySelector('#demo-markdown')?.textContent,
    json: document.querySelector('#demo-json')?.textContent,
    reconstruction: document.querySelector('#demo-reconstruction')?.getAttribute('src'),
    error: document.querySelector('#demo-error:not([hidden])')?.textContent
  }));
  if (state.error || state.pages !== 3 || !state.markdown?.includes('<!-- Page 1 -->') || !state.json?.includes('"schemaVersion": "0.6.0"') || !state.reconstruction?.startsWith('blob:') || unexpected.length) {
    throw new Error(`Site demo smoke failed: ${JSON.stringify({ state, unexpected, browserLog })}`);
  }
  console.log(JSON.stringify({ state: { ...state, markdown: '<present>', json: '<present>' }, unexpectedRequests: unexpected.length, browserLog }, null, 2));
} finally {
  await browser.close();
}
