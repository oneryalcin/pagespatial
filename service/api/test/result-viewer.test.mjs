import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { TextDecoder } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { resultViewerPage } from '../src/dashboard-views.mjs';

const require = createRequire(import.meta.url);
const markdownIt = readFileSync(join(
  dirname(require.resolve('markdown-it/package.json')),
  'dist/browser/markdown-it.umd.min.js',
), 'utf8');
const domPurify = readFileSync(require.resolve('dompurify/dist/purify.min.js'), 'utf8');
const viewerScript = readFileSync(new URL('../src/result-viewer.js', import.meta.url), 'utf8');
const jobId = '00000000-0000-4000-8000-000000000001';

const encode = (value) => Buffer.from(JSON.stringify(value));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const arrayBuffer = (bytes) => Uint8Array.from(bytes).buffer;

function installBrowserGlobals(dom) {
  Object.defineProperty(dom.window.crypto, 'subtle', { value: webcrypto.subtle });
  dom.window.TextDecoder = TextDecoder;
}

const compactPage = (pageNumber, markdown) => ({
  page_number: pageNumber,
  ok: true,
  page_compact: {
    schemaVersion: 'pagespatial-compact-v1',
    documentId: 'document',
    revisionId: 'revision',
    documentSha256: 'a'.repeat(64),
    pageId: `page-${pageNumber}`,
    pageNumber,
    projection: {
      markdown,
      format: 'pagespatial-markdown-v1',
      trust: 'untrusted-document-content',
      derived: true,
      markdownSource: 'pdf-inspector',
    },
    provenance: {
      parserName: 'pagespatial',
      parserVersion: '1.0.0',
      nativeAdapter: 'pdf-inspector',
      configuration: { secret: '<img src=x onerror=alert(1)>' },
    },
  },
});

test('viewer sanitizes untrusted Markdown and mounts exactly one page', async () => {
  const fixture = {
    schema_version: 'pagespatial-compact-v1',
    representation: 'compact',
    job_id: jobId,
    attempt_id: '00000000-0000-4000-8000-000000000002',
    input_sha256: 'a'.repeat(64),
    page_count: 3,
    pages: [
      compactPage(1, [
        '# Untrusted title',
        '<script>window.pwned = true</script>',
        '<img src="https://tracker.invalid/pixel" onerror="window.pwned=true">',
        '[unsafe](javascript:alert(1)) [plain](http://example.com) [relative](/keys) [safe](https://example.com)',
        '[encoded](jav&#x61;script:alert(1))',
        '<svg><a href="javascript:alert(1)">x</a></svg>',
        '<math><mtext>bad</mtext></math><form><input autofocus></form>',
        '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
        '<style>body{display:none}</style>',
      ].join('\n\n')),
      compactPage(2, 'SECOND PAGE ONLY'),
      {
        page_number: 3,
        ok: false,
        failure: { code: 'page_failed', message: 'Page could not be parsed.' },
      },
    ],
  };
  const bytes = encode(fixture);
  const html = resultViewerPage({
    identity: { email: 'viewer@example.test' },
    descriptor: { row: { id: jobId }, digest: digest(bytes), bytes: bytes.byteLength },
  });
  const requested = [];
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: `https://app.test/jobs/${jobId}/result-view`,
  });
  dom.window.fetch = async (url, options) => {
    requested.push({ url: String(url), options });
    return { ok: true, status: 200, async arrayBuffer() { return arrayBuffer(bytes); } };
  };
  installBrowserGlobals(dom);
  const ready = new Promise((resolve, reject) => {
    dom.window.addEventListener('pagespatial:result-ready', resolve, { once: true });
    dom.window.setTimeout(() => reject(new Error('viewer did not become ready')), 1000);
  });
  dom.window.eval(markdownIt);
  dom.window.eval(domPurify);
  dom.window.eval(viewerScript);
  await ready;

  const document = dom.window.document;
  assert.equal(document.querySelector('[data-result-viewer]').hidden, false);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].options.cache, 'no-store');
  assert.equal(requested[0].options.credentials, 'same-origin');
  assert.ok(requested[0].options.signal instanceof dom.window.AbortSignal);
  assert.equal(document.querySelectorAll('h1').length, 1);
  assert.equal(document.querySelectorAll(
    '.viewer-page script,.viewer-page style,.viewer-page img,.viewer-page svg,'
    + '.viewer-page math,.viewer-page form,.viewer-page input,.viewer-page iframe',
  ).length, 0);
  assert.equal(document.querySelectorAll('.viewer-page [onerror],.viewer-page [onclick],.viewer-page [style]').length, 0);
  assert.equal(document.querySelectorAll('.viewer-page a').length, 1);
  assert.equal(document.querySelector('.viewer-page a').href, 'https://example.com/');
  assert.equal(document.querySelector('.viewer-page a').rel, 'noopener noreferrer');
  assert.equal(document.querySelector('.viewer-page a').referrerPolicy, 'no-referrer');
  assert.match(document.querySelector('.viewer-page').textContent, /Untrusted title/u);
  assert.doesNotMatch(document.querySelector('.viewer-page').textContent, /SECOND PAGE ONLY/u);
  assert.doesNotMatch(document.querySelector('[data-viewer-provenance]').textContent, /secret|onerror/u);
  assert.equal(dom.window.pwned, undefined);

  document.querySelector('[data-page-next]').click();
  assert.match(document.querySelector('.viewer-page').textContent, /SECOND PAGE ONLY/u);
  assert.doesNotMatch(document.querySelector('.viewer-page').textContent, /Untrusted title/u);
  assert.equal(document.querySelector('[data-page-position]').textContent, 'Page 2 of 3');
  assert.equal(document.querySelector('[data-page-next]').disabled, false);
  document.querySelector('[data-page-next]').click();
  assert.match(document.querySelector('.viewer-page').textContent, /Page could not be parsed/u);
  assert.doesNotMatch(document.querySelector('.viewer-page').textContent, /SECOND PAGE ONLY/u);
  assert.equal(document.querySelector('[data-page-position]').textContent, 'Page 3 of 3');
  assert.equal(document.querySelector('[data-page-next]').disabled, true);
  dom.window.close();
});

test('viewer sanitizes hostile Markdown payloads in relaxed envelopes', async () => {
  const hostile = [
    '<script>window.pwned = true</script>',
    '<img src="https://tracker.invalid/pixel" onerror="window.pwned=true">',
    '[unsafe](javascript:alert(1)) [relative](/keys) [safe](https://example.com)',
    '<svg><a href="javascript:alert(1)">x</a></svg>',
    '<style>body{display:none}</style>',
  ].join('\n\n');
  const fixture = {
    schema_version: 'pagespatial-compact-v1',
    representation: 'compact',
    job_id: jobId,
    attempt_id: '00000000-0000-4000-8000-000000000002',
    input_sha256: 'a'.repeat(64),
    page_count: 1,
    pages: [compactPage(1, hostile)],
    unexpected: '<script>alert(1)</script>',
  };
  const bytes = encode(fixture);
  const html = resultViewerPage({
    identity: { email: 'viewer@example.test' },
    descriptor: { row: { id: jobId }, digest: digest(bytes), bytes: bytes.byteLength },
  });
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: `https://app.test/jobs/${jobId}/result-view`,
  });
  dom.window.fetch = async () => ({
    ok: true, async arrayBuffer() { return arrayBuffer(bytes); },
  });
  installBrowserGlobals(dom);
  const ready = new Promise((resolve, reject) => {
    dom.window.addEventListener('pagespatial:result-ready', resolve, { once: true });
    dom.window.setTimeout(() => reject(new Error('viewer did not become ready')), 1000);
  });
  dom.window.eval(markdownIt);
  dom.window.eval(domPurify);
  dom.window.eval(viewerScript);
  await ready;

  const document = dom.window.document;
  assert.equal(dom.window.pwned, undefined);
  assert.equal(document.querySelectorAll(
    '.viewer-page script,.viewer-page style,.viewer-page img,.viewer-page svg',
  ).length, 0);
  assert.equal(document.querySelectorAll('.viewer-page [onerror],.viewer-page [style]').length, 0);
  assert.doesNotMatch(document.body.innerHTML, /<script>alert\(1\)<\/script>/u);
  assert.match(document.querySelector('.viewer-page').textContent, /\[unsafe\]/u);
  assert.doesNotMatch(document.querySelector('.viewer-page').textContent, /\[safe\]/u);
  dom.window.close();
});

test('viewer rejects an oversized display and does not fetch it', async () => {
  const html = resultViewerPage({
    identity: { email: 'viewer@example.test' },
    descriptor: { row: { id: jobId }, digest: 'a'.repeat(64), bytes: 16 * 1024 * 1024 + 1 },
  });
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: `https://app.test/jobs/${jobId}/result-view`,
  });
  let calls = 0;
  dom.window.fetch = async () => { calls += 1; throw new Error('must not fetch'); };
  const failed = new Promise((resolve) => {
    dom.window.addEventListener('pagespatial:result-error', resolve, { once: true });
  });
  dom.window.eval(markdownIt);
  dom.window.eval(domPurify);
  dom.window.eval(viewerScript);
  await failed;
  assert.equal(calls, 0);
  assert.match(dom.window.document.querySelector('[data-viewer-status]').textContent, /too large/u);
  dom.window.close();
});

test('viewer verifies the accepted compact digest before parsing', async () => {
  const bytes = encode({ not: 'the accepted object' });
  const html = resultViewerPage({
    identity: { email: 'viewer@example.test' },
    descriptor: { row: { id: jobId }, digest: 'a'.repeat(64), bytes: bytes.byteLength },
  });
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: `https://app.test/jobs/${jobId}/result-view`,
  });
  installBrowserGlobals(dom);
  dom.window.fetch = async () => ({
    ok: true, async arrayBuffer() { return arrayBuffer(bytes); },
  });
  const failed = new Promise((resolve, reject) => {
    dom.window.addEventListener('pagespatial:result-error', resolve, { once: true });
    dom.window.setTimeout(() => reject(new Error('viewer accepted a digest mismatch')), 1000);
  });
  dom.window.eval(markdownIt);
  dom.window.eval(domPurify);
  dom.window.eval(viewerScript);
  await failed;
  assert.equal(dom.window.document.querySelector('[data-viewer-content]').hidden, true);
  dom.window.close();
});
