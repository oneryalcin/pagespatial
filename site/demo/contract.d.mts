export const DEMO_MAX_BYTES: number;
export const DEMO_MAX_PAGES: number;

export function validateDemoFile(file: { name?: string; type?: string; size: number } | null | undefined): void;
export function safeDownloadStem(name: string | null | undefined): string;
export function joinPageMarkdown(pages: ReadonlyArray<{
  pageNumber: number;
  projection: { markdown: string };
}>): string;
