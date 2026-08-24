#!/usr/bin/env node

/** Precompute the deployment-neutral native PDF evidence for the A2 GPU run. */

import { resolve } from 'node:path';
import { arch, platform } from 'node:os';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';

import { nativeStage, openDocumentContext } from '../../service/lib/stages.mjs';

export async function precomputeNativeEvidence(pdfPath, outputPath) {
  const started = performance.now();
  const context = await openDocumentContext(resolve(pdfPath));
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= context.pageCount; pageNumber += 1) {
      const native = await nativeStage(context, pageNumber);
      pages.push({ pageNumber, extractionMs: native.ms, nativePage: native.value });
    }
    const artifact = {
      schemaVersion: 'pagespatial-gpu-a2-native-evidence-v1',
      document: context.identity,
      adapter: `${context.native.name}@${context.native.version}`,
      host: { platform: platform(), arch: arch(), node: process.version },
      pageCount: context.pageCount,
      pages,
      timing: {
        totalWallMs: Math.round((performance.now() - started) * 10) / 10,
        summedPageMs: Math.round(pages.reduce((sum, page) => sum + page.extractionMs, 0) * 10) / 10
      }
    };
    await writeFile(resolve(outputPath), `${JSON.stringify(artifact)}\n`);
    return artifact;
  } finally {
    await context.dispose();
  }
}

async function cli() {
  const value = (flag) => {
    const index = process.argv.indexOf(flag);
    if (index < 0 || !process.argv[index + 1]) throw new Error(`${flag} is required`);
    return process.argv[index + 1];
  };
  const artifact = await precomputeNativeEvidence(value('--pdf'), value('--output'));
  process.stdout.write(
    `native evidence: ${artifact.pageCount} pages in ${artifact.timing.totalWallMs}ms -> ${resolve(value('--output'))}\n`
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await cli();
}
