import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const root = resolve(import.meta.dirname);
const contentSecurityPolicy = readFileSync(resolve(root, '_headers'), 'utf8')
  .split('\n')
  .find((line) => line.startsWith('  Content-Security-Policy:'))
  ?.split(': ', 2)[1];

if (!contentSecurityPolicy) {
  throw new Error('site/_headers must define Content-Security-Policy');
}

export default defineConfig({
  root,
  publicDir: false,
  build: {
    outDir: resolve(root, '..', '.site-dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: resolve(root, 'index.html'),
        blog: resolve(root, 'blog/index.html'),
        article: resolve(root, 'blog/preserving-conflicts/index.html')
      }
    }
  },
  optimizeDeps: {
    exclude: ['@paddleocr/paddleocr-js'],
    include: ['clipper-lib', 'js-yaml', '@techstark/opencv-js']
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    headers: {
      'Content-Security-Policy': contentSecurityPolicy,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin'
    }
  }
});
