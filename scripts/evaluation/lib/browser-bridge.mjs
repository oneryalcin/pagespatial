import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function stopProcess(child, graceMs = 5_000) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    delay(graceMs)
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      delay(graceMs)
    ]);
  }
}

function sanitizeError(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message.replace(/[A-Za-z0-9_-]{24,}/gu, '[redacted]') : String(error)
  };
}

export async function startBrowserBridge(options) {
  const root = resolve(options.root);
  const port = await availablePort();
  const vite = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--config', resolve(root, 'evaluation/browser/vite.config.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      PAGESPATIAL_CORPUS_ROUTE_MAP: resolve(options.routeMapPath),
      PAGESPATIAL_CORPUS_OCR_ASSETS: resolve(options.ocrAssets),
      PAGESPATIAL_CORPUS_PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  vite.stdout.on('data', (chunk) => { serverOutput += chunk; });
  vite.stderr.on('data', (chunk) => { serverOutput += chunk; });
  let browser;
  let page;
  let unhealthy = false;
  let initialization;
  const externalRequests = [];
  const pageErrors = [];
  try {
    const serverDeadline = Date.now() + 20_000;
    while (!/Local:/u.test(serverOutput)) {
      if (vite.exitCode !== null) throw new Error(`Corpus Vite server exited early: ${serverOutput}`);
      if (Date.now() > serverDeadline) throw new Error(`Corpus Vite server did not start: ${serverOutput}`);
      await delay(50);
    }
    const executablePath = resolve(options.chromePath ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    browser = await chromium.launch({
      headless: true,
      executablePath
    });
    page = await browser.newPage();
    page.on('crash', () => { unhealthy = true; });
    page.on('close', () => { unhealthy = true; });
    page.on('pageerror', (error) => { pageErrors.push(error.message); });
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.push(url.href);
    });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) await route.abort();
      else await route.continue();
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    try {
      await page.waitForFunction(() => typeof globalThis.pagespatialCorpus?.initialize === 'function', undefined, { timeout: 20_000 });
    } catch (error) {
      throw new Error(`Corpus browser client did not initialize: ${pageErrors.join(' | ') || error.message}`);
    }

    const call = async (method, args = [], timeoutMs = options.pageTimeoutMs ?? 120_000) => {
      if (unhealthy || !page || page.isClosed()) throw new Error('Corpus browser bridge is unavailable.');
      let timer;
      try {
        return await Promise.race([
          page.evaluate(async ({ methodName, methodArgs }) => {
            const bridge = globalThis.pagespatialCorpus;
            if (!bridge || typeof bridge[methodName] !== 'function') throw new Error(`Unknown corpus bridge method ${methodName}.`);
            return bridge[methodName](...methodArgs);
          }, { methodName: method, methodArgs: args }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new DOMException(`${method} exceeded ${timeoutMs} ms.`, 'TimeoutError')), timeoutMs);
          })
        ]);
      } catch (error) {
        if (error?.name === 'TimeoutError' || /Target page, context or browser has been closed|crash/iu.test(String(error?.message))) {
          unhealthy = true;
          await Promise.race([page.close().catch(() => undefined), delay(5_000)]);
          await Promise.race([browser.close().catch(() => undefined), delay(5_000)]);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };

    initialization = await call('initialize', [{
      backend: options.backend ?? 'wasm',
      detectorLimit: options.detectorLimit ?? 960,
      recognitionThreshold: options.recognitionThreshold ?? 0.25,
      recognitionBatchSize: options.recognitionBatchSize ?? 6,
      maxCanvasSide: options.maxCanvasSide ?? 16_384,
      maxCanvasPixels: options.maxCanvasPixels ?? 40_000_000
    }], options.warmupTimeoutMs ?? 180_000);

    return {
      call,
      getExternalRequests: () => [...externalRequests],
      getRuntimeInfo: () => ({
        browser: 'Chromium',
        browserVersion: browser.version(),
        executablePath,
        userAgent: initialization.runtime?.userAgent ?? null,
        gpu: initialization.runtime?.gpu ?? null,
        warmupMs: initialization.warmupMs,
        backend: initialization.backend
      }),
      isHealthy: () => !unhealthy,
      async stop() {
        if (page && !page.isClosed()) await call('dispose', [], 10_000).catch(() => undefined);
        await Promise.race([browser?.close().catch(() => undefined), delay(5_000)]);
        await stopProcess(vite);
      }
    };
  } catch (error) {
    await Promise.race([browser?.close().catch(() => undefined), delay(5_000)]);
    await stopProcess(vite);
    const safe = sanitizeError(error);
    throw new Error(`${safe.name}: ${safe.message}`);
  }
}
