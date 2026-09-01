import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, '.site-dist');
const pdfjs = resolve(root, 'node_modules/pdfjs-dist');

await mkdir(output, { recursive: true });
await Promise.all([
  cp(resolve(root, 'site/_headers'), resolve(output, '_headers')),
  cp(resolve(root, 'site/_redirects'), resolve(output, '_redirects')),
  cp(resolve(pdfjs, 'cmaps'), resolve(output, 'pdfjs-assets/cmaps'), { recursive: true }),
  cp(resolve(pdfjs, 'standard_fonts'), resolve(output, 'pdfjs-assets/standard_fonts'), { recursive: true })
]);

await execFileAsync(process.execPath, [
  resolve(root, 'scripts/prepare-ppocr-assets.mjs'),
  '--output',
  resolve(output, 'ocr-assets')
], { cwd: root });

console.log(`Prepared static runtime assets under ${output}.`);
