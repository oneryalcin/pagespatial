import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { createBrowserSmokeFixture } from './fixture.mjs';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const backend = process.argv[2] ?? 'wasm';
if (!['wasm', 'webgpu'].includes(backend)) throw new Error('Backend must be wasm or webgpu.');
const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const smokeTimeout = Number(process.env.PAGESPATIAL_SMOKE_TIMEOUT_MS ?? 60_000);
if (!Number.isSafeInteger(smokeTimeout) || smokeTimeout < 1) throw new Error('PAGESPATIAL_SMOKE_TIMEOUT_MS must be a positive integer.');
const temporary = await mkdtemp(join(tmpdir(), 'pagespatial-packed-smoke-'));
const port = await new Promise((resolvePort, reject) => {
  const listener = createServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {
    const address = listener.address();
    listener.close((error) => error ? reject(error) : resolvePort(address.port));
  });
});
let server;
let browser;
try {
  const pack = JSON.parse((await exec('npm', [
    'pack', '--json', '--pack-destination', temporary, '--cache', join(temporary, 'npm-cache')
  ], { cwd: root })).stdout);
  await exec('tar', ['-xzf', join(temporary, pack[0].filename), '-C', temporary]);
  const packedRoot = join(temporary, 'package');
  const fixture = join(temporary, 'fixture.pdf');
  browser = await chromium.launch({ headless: true, executablePath: chrome });
  const fixturePage = await browser.newPage({ viewport: { width: 520, height: 180 } });
  await fixturePage.setContent('<style>body{margin:0;background:white;font:52px Arial;color:black}div{padding:45px 55px;white-space:nowrap}</style><div>FY2021&nbsp;&nbsp;&nbsp;527</div>');
  const rasterLabel = await fixturePage.locator('div').screenshot({ type: 'png' });
  await fixturePage.close();
  await writeFile(fixture, await createBrowserSmokeFixture(rasterLabel));
  const assets = process.env.PAGESPATIAL_SMOKE_ASSETS ?? join(temporary, 'ocr-assets');
  if (!process.env.PAGESPATIAL_SMOKE_ASSETS) {
    await mkdir(assets, { recursive: true });
    await exec(process.execPath, [join(root, 'scripts/prepare-ppocr-assets.mjs'), '--output', assets], { cwd: root });
  }
  server = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--config', join(root, 'test/browser-smoke/vite.config.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      PAGESPATIAL_PACKED_ROOT: packedRoot,
      PAGESPATIAL_SMOKE_ASSETS: assets,
      PAGESPATIAL_SMOKE_FIXTURE: fixture,
      PAGESPATIAL_SMOKE_PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 20_000;
  while (!/Local:/u.test(output)) {
    if (server.exitCode !== null) throw new Error(`Vite exited early:\n${output}`);
    if (Date.now() > deadline) throw new Error(`Vite did not start:\n${output}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  const page = await browser.newPage();
  const external = [];
  const browserLog = [];
  page.on('console', (message) => browserLog.push(`console:${message.type()}:${message.text()}`));
  page.on('pageerror', (error) => browserLog.push(`pageerror:${error.name}:${error.message}:${error.stack}`));
  page.on('requestfailed', (request) => browserLog.push(`requestfailed:${request.url()}:${request.failure()?.errorText}`));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') {
      external.push(url.href);
      await route.abort();
    } else await route.continue();
  });
  await page.goto(`http://127.0.0.1:${port}/?backend=${backend}`);
  try {
    await page.waitForFunction(() => document.querySelector('#status')?.dataset.done === 'true' || document.querySelector('#status')?.dataset.error === 'true', null, { timeout: smokeTimeout });
  } catch (error) {
    const visible = await page.locator('#status').textContent().catch(() => '<unavailable>');
    throw new Error(`${error.message}\nstatus=${visible}\nbrowser=${browserLog.join('\n')}\nserver=${output}`);
  }
  const state = await page.locator('#status').evaluate((node) => ({ result: node.dataset.result, error: node.dataset.error, text: node.textContent }));
  if (state.error) throw new Error(state.text);
  const result = JSON.parse(state.result);
  if (result.backend !== backend || !result.hasRasterYear || !result.hasRasterValue || !result.hasNativeHeading || !result.crossOriginIsolated || external.length) {
    throw new Error(`Smoke assertion failed: ${JSON.stringify({ result, external })}`);
  }
  console.log(JSON.stringify({ packed: pack[0].filename, result, externalRequests: external.length, browserLog }, null, 2));
} finally {
  await browser?.close().catch(() => undefined);
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolveExit) => {
      const timer = setTimeout(resolveExit, 2_000);
      server.once('exit', () => { clearTimeout(timer); resolveExit(); });
    });
  }
  await rm(temporary, { recursive: true, force: true });
}
