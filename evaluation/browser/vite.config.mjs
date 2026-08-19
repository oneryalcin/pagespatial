import { createReadStream, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { defineConfig } from 'vite';

const routeMapPath = process.env.PAGESPATIAL_CORPUS_ROUTE_MAP;
const assetRoot = process.env.PAGESPATIAL_CORPUS_OCR_ASSETS;
const port = Number(process.env.PAGESPATIAL_CORPUS_PORT);
if (!routeMapPath || !assetRoot || !Number.isSafeInteger(port)) throw new Error('Route map, OCR assets, and a port are required.');
const routeMap = JSON.parse(readFileSync(routeMapPath, 'utf8'));
const resolvedAssets = realpathSync(resolve(assetRoot));
const allowedFsRoots = [
  realpathSync(resolve(import.meta.dirname)),
  realpathSync(resolve(import.meta.dirname, '../../dist')),
  realpathSync(resolve(import.meta.dirname, '../../node_modules'))
];

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function containedFile(root, candidate) {
  const resolved = resolve(candidate);
  const lexical = relative(root, resolved);
  if (!lexical || lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    throw new Error('Requested file escapes its allowed root.');
  }
  const state = lstatSync(resolved);
  if (state.isSymbolicLink() || !state.isFile()) throw new Error('Requested file is not a regular non-symlink file.');
  const real = realpathSync(resolved);
  const physical = relative(root, real);
  if (physical === '..' || physical.startsWith(`..${sep}`) || isAbsolute(physical)) {
    throw new Error('Requested file resolves outside its allowed root.');
  }
  return real;
}

function sendFile(path, response) {
  response.statusCode = 200;
  response.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.mjs') ? 'text/javascript' : path.endsWith('.pdf') ? 'application/pdf' : 'application/x-tar');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  createReadStream(path).pipe(response);
}

function serve(path, response) {
  try {
    return sendFile(path, response);
  } catch {
    response.statusCode = 404;
    return response.end();
  }
}

export default defineConfig({
  root: resolve(import.meta.dirname),
  publicDir: false,
  optimizeDeps: {
    exclude: ['@paddleocr/paddleocr-js'],
    include: ['clipper-lib', 'js-yaml', '@techstark/opencv-js']
  },
  plugins: [{
    name: 'private-corpus-routes',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        let pathname;
        try {
          pathname = new URL(request.url, 'http://localhost').pathname;
        } catch {
          response.statusCode = 400;
          return response.end();
        }
        if (pathname.startsWith('/@fs/')) {
          try {
            const requested = realpathSync(resolve(decodeURIComponent(pathname.slice('/@fs'.length))));
            if (!allowedFsRoots.some((allowed) => isWithin(allowed, requested))) throw new Error('Disallowed Vite filesystem route.');
            return next();
          } catch {
            response.statusCode = 404;
            return response.end();
          }
        }
        if (pathname.startsWith('/pdf/')) {
          let token;
          try {
            token = decodeURIComponent(pathname.slice('/pdf/'.length));
          } catch {
            response.statusCode = 400;
            return response.end();
          }
          const path = routeMap[token];
          if (!path || typeof path !== 'string') {
            response.statusCode = 404;
            return response.end();
          }
          try {
            const state = lstatSync(path);
            if (state.isSymbolicLink() || !state.isFile()) throw new Error('Invalid corpus route.');
            return serve(realpathSync(path), response);
          } catch {
            response.statusCode = 404;
            return response.end();
          }
        }
        if (!pathname.startsWith('/ocr/')) return next();
        try {
          return serve(containedFile(resolvedAssets, resolve(resolvedAssets, pathname.slice('/ocr/'.length))), response);
        } catch {
          response.statusCode = 404;
          return response.end();
        }
      });
    }
  }],
  server: {
    host: '127.0.0.1',
    cors: false,
    port,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin'
    },
    fs: {
      strict: true,
      allow: [
        resolve(import.meta.dirname),
        resolve(import.meta.dirname, '../../dist'),
        resolve(import.meta.dirname, '../../node_modules')
      ],
      deny: ['**/.evaluation/**', '**/evaluation/corpus/**', '**/evaluation/corpus.v1.json']
    }
  }
});
