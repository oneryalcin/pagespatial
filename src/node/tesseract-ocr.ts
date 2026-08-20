import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { OcrAdapter } from '../adapters.js';
import type { Box, RenderedPage } from '../types.js';

const execFileAsync = promisify(execFile);

/**
 * Tesseract as the cross-family second-opinion engine (issue #17).
 *
 * Why Tesseract: principles §5 — two witnesses that share failure modes
 * corroborate nothing. Tesseract's LSTM lineage, training data, and
 * preprocessing differ mechanically from PP-OCR's, so agreement between
 * them is evidence. Measured on the 27 dev-v11 coverage-starved pages:
 * 24 clear the starvation threshold; agreement precision 71/72 on gold
 * (the 1 miss was a degraded glyph both engines misread the same way —
 * tracked in docs/evaluation-debts.md pending more starved-page gold).
 *
 * Runs the system `tesseract` binary on PNG bytes of the rendered page.
 * Word boxes come from TSV output and are returned in the rendered page's
 * pixel space.
 */

export interface TesseractAdapterOptions {
  /** Languages, e.g. 'eng' or 'eng+jpn'. Default 'eng'. */
  languages?: string;
  /** Page segmentation mode. Default 3 (fully automatic). */
  psm?: number;
  /** Path to the tesseract binary. Default 'tesseract' on PATH. */
  binary?: string;
  /**
   * Converts the rendered page to PNG bytes. The default handles rasters
   * that are already PNG buffers ({ data: Uint8Array } with PNG magic);
   * canvas-based rasters need a caller-supplied encoder.
   */
  toPng?: (page: RenderedPage<unknown>) => Promise<Uint8Array>;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

async function defaultToPng(page: RenderedPage<unknown>): Promise<Uint8Array> {
  const data = (page as { data?: unknown }).data;
  if (data instanceof Uint8Array && PNG_MAGIC.every((byte, index) => data[index] === byte)) return data;
  throw new Error('Tesseract adapter needs PNG bytes; supply toPng for non-PNG rasters.');
}

export function createTesseractAdapter(options: TesseractAdapterOptions = {}): OcrAdapter<unknown> {
  const languages = options.languages ?? 'eng';
  const psm = options.psm ?? 3;
  const binary = options.binary ?? 'tesseract';
  const toPng = options.toPng ?? defaultToPng;
  return {
    name: 'tesseract',
    version: `${languages}/psm${psm}`,
    configuration: { languages, psm },
    async recognize(page, recognizeOptions) {
      const png = await toPng(page);
      const dir = await mkdtemp(join(tmpdir(), 'tess-'));
      try {
        const input = join(dir, 'page.png');
        await writeFile(input, png);
        await execFileAsync(binary, [input, join(dir, 'out'), '-l', languages, '--psm', String(psm), 'tsv'], {
          signal: recognizeOptions?.signal ?? undefined,
          maxBuffer: 64 * 1024 * 1024
        });
        const tsv = await readFile(join(dir, 'out.tsv'), 'utf8');
        const lines = tsv.split('\n').slice(1);
        const observations = [];
        for (const line of lines) {
          const cells = line.split('\t');
          if (cells.length < 12) continue;
          const [level, , , , , , left, top, width, height, conf, text] = cells;
          if (level !== '5' || !text || !text.trim()) continue;
          const confidence = Number(conf);
          const box: Box = [Number(left), Number(top), Number(left) + Number(width), Number(top) + Number(height)];
          if (!box.every(Number.isFinite) || box[2] <= box[0] || box[3] <= box[1]) continue;
          // Tesseract's conf -1 means "not reported": a reading whose
          // reliability cannot be assessed is not usable as a witness —
          // dropped, never given a fabricated number.
          if (!Number.isFinite(confidence) || confidence < 0) continue;
          observations.push({
            pageNumber: page.pageNumber,
            text: text.trim(),
            box,
            confidence: confidence / 100
          });
        }
        return { pageNumber: page.pageNumber, observations };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  };
}
