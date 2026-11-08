import {
  ADAPTER_MARKDOWN_MAX_MISSING_WORD_SHARE,
  ADAPTER_MARKDOWN_MIN_WORDS,
  TABLE_CELL_MAX_WORDS
} from './tuning.js';
import type { NativeLine, NativeObservation } from './types.js';

// Digit runs of two or more digits, internal separators kept verbatim ("2,311,993",
// "0,11", "75.0"). Both sides are the same PDF text layer, so no normalization.
const NUMBER = /\d[\d,.]*\d/g;
const SEPARATOR_ROW = /^[\s|:-]+$/;
// A cell with a word in it is a label ("na dzień 1 stycznia 2025"): its numbers
// are dates and references, often wrapped onto another line than the values.
const LABEL = /\p{L}{2,}/u;
const COMPARABLE_WORD = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]{3,}/gu;

export type AdapterMarkdownDefect =
  | { type: 'misbound-row'; count: number }
  | { type: 'words-not-in-native'; share: number }
  | { type: 'prose-in-cell'; words: number };

function numbers(text: string): string[] {
  return text.match(NUMBER) ?? [];
}

function words(text: string): string[] {
  return (text.normalize('NFKC').match(COMPARABLE_WORD) ?? []).map((word) => word.toLowerCase());
}

function tableRows(markdown: string): string[] {
  return markdown.split('\n')
    .map((row) => row.trim())
    .filter((row) => row.startsWith('|') && !SEPARATOR_ROW.test(row));
}

/**
 * Markdown table rows that bind numbers printed on different lines: the row's
 * value cells hold two or more numbers found in the native text, yet no
 * single native line carries all of them. A row that passes may still have
 * wrong columns; a row that fails has merged or shifted printed rows (e.g. two
 * fund rows collapsed into `|LLR 5|2018|$75.0 $205.0|20.3 19.2%|`), which
 * reads as a value belonging to the wrong label.
 */
export function misboundTableRows(markdown: string, lines: readonly NativeLine[]): string[] {
  const lineNumbers = lines.map((line) => new Set(numbers(line.text)));
  const printed = new Set(lineNumbers.flatMap((set) => [...set]));
  return tableRows(markdown).filter((row) => {
    const values = row.split('|').filter((cell) => !LABEL.test(cell)).flatMap(numbers);
    const located = [...new Set(values)].filter((value) => printed.has(value));
    return located.length >= 2 && !lineNumbers.some((set) => located.every((value) => set.has(value)));
  });
}

/**
 * Reasons the adapter's markdown misrepresents the page, each measured against
 * the page's own native text. Any defect means the projection should show the
 * native lines instead.
 */
export function adapterMarkdownDefects(
  markdown: string,
  observations: readonly NativeObservation[],
  lines: readonly NativeLine[]
): AdapterMarkdownDefect[] {
  const defects: AdapterMarkdownDefect[] = [];

  const misbound = misboundTableRows(markdown, lines).length;
  if (misbound) defects.push({ type: 'misbound-row', count: misbound });

  const adapterWords = words(markdown);
  if (adapterWords.length >= ADAPTER_MARKDOWN_MIN_WORDS) {
    const native = new Set(observations.flatMap((observation) => words(observation.text)));
    const share = adapterWords.filter((word) => !native.has(word)).length / adapterWords.length;
    if (share > ADAPTER_MARKDOWN_MAX_MISSING_WORD_SHARE) defects.push({ type: 'words-not-in-native', share });
  }

  const longestCell = Math.max(0, ...tableRows(markdown)
    .flatMap((row) => row.split('|'))
    .map((cell) => cell.trim().split(/\s+/).filter(Boolean).length));
  if (longestCell > TABLE_CELL_MAX_WORDS) defects.push({ type: 'prose-in-cell', words: longestCell });

  return defects;
}
