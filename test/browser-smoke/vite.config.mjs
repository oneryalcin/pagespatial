import { createReadStream, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const packedRoot = process.env.PAGESPATIAL_PACKED_ROOT;
const assetRoot = process.env.PAGESPATIAL_SMOKE_ASSETS;
const fixturePath = process.env.PAGESPATIAL_SMOKE_FIXTURE;
const port = Number(process.env.PAGESPATIAL_SMOKE_PORT);
if (!packedRoot || !assetRoot || !fixturePath || !Number.isSafeInteger(port)) throw new Error('Packed root, OCR assets, fixture, and port are required.');

function sendFile(path, response) {
  response.statusCode = 200;
  response.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.mjs') ? 'text/javascript' : path.endsWith('.pdf') ? 'application/pdf' : 'application/x-tar');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  createReadStream(path).pipe(response);
}

export default defineConfig({
  root: resolve(import.meta.dirname),
  publicDir: false,
  resolve: {
    alias: [
      { find: 'pagespatial/browser', replacement: resolve(packedRoot, 'dist/browser/index.js') },
      { find: /^zod$/u, replacement: fileURLToPath(import.meta.resolve('zod')) },
      { find: /^pdfjs-dist$/u, replacement: fileURLToPath(import.meta.resolve('pdfjs-dist')) },
      { find: '@paddleocr/paddleocr-js', replacement: fileURLToPath(import.meta.resolve('@paddleocr/paddleocr-js')) }
    ]
  },
  optimizeDeps: {
    exclude: ['@paddleocr/paddleocr-js'],
    include: ['clipper-lib', 'js-yaml', '@techstark/opencv-js']
  },
  plugins: [{
    name: 'local-smoke-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname === '/fixture.pdf') return sendFile(fixturePath, response);
        if (!pathname.startsWith('/ocr/')) return next();
        const candidate = resolve(assetRoot, pathname.slice('/ocr/'.length));
        if (!candidate.startsWith(`${resolve(assetRoot)}${sep}`) || !statSync(candidate).isFile()) {
          response.statusCode = 404;
          return response.end();
        }
        return sendFile(candidate, response);
      });
    }
  }],
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin'
    },
    fs: { allow: [resolve(import.meta.dirname, '../..'), packedRoot] }
  }
});
