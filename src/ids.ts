import type { Box } from './types.js';

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

function stableBox(box: Box): string {
  return box.map((value) => Math.round(value * 100) / 100).join(',');
}

export function createPageId(documentSha256: string, pageNumber: number): string {
  return `ps:${documentSha256.slice(0, 12)}:p${pageNumber}`;
}

export function createObservationId(input: {
  documentSha256: string;
  pageNumber: number;
  source: 'native' | 'ocr';
  text: string;
  box: Box;
  occurrence: number;
}): string {
  const fingerprint = fnv1a([
    input.documentSha256,
    input.pageNumber,
    input.source,
    input.text.normalize('NFKC'),
    stableBox(input.box),
    input.occurrence
  ].join('|'));
  return `${createPageId(input.documentSha256, input.pageNumber)}:${input.source[0]}:${fingerprint}`;
}

export function createDerivedId(pageId: string, kind: string, sourceIds: readonly string[]): string {
  return `${pageId}:d:${fnv1a(`${kind}|${[...sourceIds].sort().join('|')}`)}`;
}

