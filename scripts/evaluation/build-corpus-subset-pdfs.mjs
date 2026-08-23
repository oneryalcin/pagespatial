/**
 * Build per-document SUBSET PDFs containing exactly the development-split
 * corpus pages (162 pages, 23 documents in corpus v1) — the M1 Linux
 * throughput input. The full source documents total thousands of pages;
 * the service parses whole PDFs, so the corpus run travels as subsets.
 *
 * The subsets preserve each page's ink verbatim (qpdf --pages copies page
 * objects losslessly; pdf-lib fails to parse several corpus documents and
 * poppler's pdfunite refuses the encrypted ones, which qpdf --decrypt
 * handles); page NUMBERS are remapped to 1..N per
 * document and the container documents differ from the originals, so
 * subset runs are for throughput/footprint measurement — never for
 * record-level comparison against committed baselines.
 *
 * Output stays OUTSIDE git (corpus-derived): default --out
 * .evaluation/m1-subset-pdfs/.
 *
 * Usage:
 *   node scripts/evaluation/build-corpus-subset-pdfs.mjs \
 *     --data-root /abs/path/.evaluation [--out /abs/path/.evaluation/m1-subset-pdfs]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1];
}

const dataRoot = flag('--data-root');
if (!dataRoot) throw new Error('--data-root is required (the .evaluation directory).');
const outDir = flag('--out', join(dataRoot, 'm1-subset-pdfs'));
mkdirSync(outDir, { recursive: true });

const manifest = JSON.parse(readFileSync(join(root, 'evaluation', 'corpus.v1.json'), 'utf8'));
const documents = manifest.documents.filter((document) => document.split === 'development');

const index = [];
let totalPages = 0;
for (const document of documents) {
  const sourcePath = join(dataRoot, document.path);
  const pageNumbers = document.pages.map((page) => page.pageNumber);
  const safeId = document.objectId.replace(/[^A-Za-z0-9]+/gu, '_');
  const fileName = `${safeId}.pdf`;
  const outPath = join(outDir, fileName);
  // --warning-exit-0: qpdf exits 3 on recoverable source warnings (e.g. a
  // duplicated dictionary key); the copy still succeeds.
  execFileSync('qpdf', ['--warning-exit-0', '--decrypt', '--pages', sourcePath, pageNumbers.join(','), '--', sourcePath, outPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  const bytes = statSync(outPath).size;
  index.push({ objectId: document.objectId, file: fileName, sourcePages: pageNumbers, pageCount: pageNumbers.length });
  totalPages += pageNumbers.length;
  console.log(`${document.objectId}: ${pageNumbers.length} pages -> ${fileName} (${Math.round(bytes / 1024)} KB)`);
}
writeFileSync(join(outDir, 'index.json'), JSON.stringify({ createdAt: new Date().toISOString(), corpus: 'evaluation/corpus.v1.json', documents: index, totalPages }, null, 1));
console.log(`${documents.length} documents, ${totalPages} pages -> ${outDir}`);
