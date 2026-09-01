export const DEMO_MAX_BYTES = 20 * 1024 * 1024;
export const DEMO_MAX_PAGES = 4;

export function validateDemoFile(file) {
  if (!file) throw new Error('Choose a PDF to begin.');
  if (file.size > DEMO_MAX_BYTES) throw new Error('This demo accepts PDFs up to 20 MiB.');
  const name = String(file.name ?? '').toLowerCase();
  const type = String(file.type ?? '').toLowerCase();
  if (type !== 'application/pdf' && !name.endsWith('.pdf')) throw new Error('Choose a PDF document.');
}

export function safeDownloadStem(name) {
  const stem = String(name ?? 'pagespatial-result').replace(/\.pdf$/iu, '');
  const safe = stem.normalize('NFKC').replace(/[^a-z0-9._-]+/giu, '-').replace(/^[.-]+|[.-]+$/gu, '');
  return safe.slice(0, 80) || 'pagespatial-result';
}

export function joinPageMarkdown(pages) {
  return pages
    .map((page) => `<!-- Page ${page.pageNumber} -->\n\n${page.projection.markdown.trim()}`)
    .join('\n\n---\n\n');
}
