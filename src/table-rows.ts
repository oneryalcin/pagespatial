import type { NativeLine } from './types.js';

// Digit runs of two or more digits, internal separators kept verbatim ("2,311,993",
// "0,11", "75.0"). Both sides are the same PDF text layer, so no normalization.
const NUMBER = /\d[\d,.]*\d/g;
const SEPARATOR_ROW = /^[\s|:-]+$/;

function numbers(text: string): string[] {
  return text.match(NUMBER) ?? [];
}

/**
 * Markdown table rows that bind numbers printed on different lines: the row
 * holds two or more numbers found in the native text, yet no single native
 * line carries all of them. A row that passes may still have wrong columns;
 * a row that fails has certainly merged or shifted printed rows (e.g. two
 * fund rows collapsed into `|LLR 5|2018|$75.0 $205.0|20.3 19.2%|`), which
 * reads as a value belonging to the wrong label.
 */
export function misboundTableRows(markdown: string, lines: readonly NativeLine[]): string[] {
  const lineNumbers = lines.map((line) => new Set(numbers(line.text)));
  const printed = new Set(lineNumbers.flatMap((set) => [...set]));
  return markdown.split('\n')
    .map((row) => row.trim())
    .filter((row) => row.startsWith('|') && !SEPARATOR_ROW.test(row))
    .filter((row) => {
      const located = [...new Set(numbers(row))].filter((value) => printed.has(value));
      return located.length >= 2 && !lineNumbers.some((set) => located.every((value) => set.has(value)));
    });
}
