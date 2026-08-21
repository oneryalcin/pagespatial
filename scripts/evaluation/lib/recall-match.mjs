/**
 * Token matching for the gold recall test.
 *
 * Recall asks whether an engine READ this figure, which is not the same
 * question as whether two readings of it agree. A native text layer routinely
 * emits a currency symbol as its own observation, so gold's "$684,663" and
 * native's "684,663" describe identical ink yet fail criticalTokensCompatible.
 * Across the first five gold batches, 135 of 145 tokens scored missed-by-both
 * were read perfectly by an engine that had simply drawn its observation
 * boundary after the symbol.
 *
 * The tolerance is deliberately asymmetric. A DETACHED symbol is a
 * segmentation artifact and is forgiven; a CONTRADICTORY one is a reading
 * error and is not. "$100" against "100" matches, because one side merely
 * failed to attach the symbol. "$100" against "€100" does not, because an
 * engine that reads the wrong currency has misread the value, and crediting
 * it would hide exactly the class of error the index cannot tolerate.
 *
 * Percent and sign are never relaxed: 28.9% is not 28.9, and -150,672 is not
 * 150,672.
 *
 * This applies to recall only. poolCorroborates keeps the strict rule for
 * corroboration, conflicts and the cross-family re-score, where the symbol's
 * presence is a real difference between two readings.
 */
import { criticalTokensCompatible } from '../../../dist/text.js';

const CURRENCY = /\p{Sc}/gu;

export const stripCurrency = (token) => String(token ?? '').replace(CURRENCY, '');

/**
 * True when two tokens' currency symbols do not contradict each other:
 * either at least one side carries none, or both carry the same ones.
 */
export function currencyCompatible(left, right) {
  const leftSymbols = String(left ?? '').match(CURRENCY) ?? [];
  const rightSymbols = String(right ?? '').match(CURRENCY) ?? [];
  if (!leftSymbols.length || !rightSymbols.length) return true;
  return leftSymbols.join('') === rightSymbols.join('');
}

/**
 * Consume one pool entry matching the token, exact before compatible.
 * With `tolerant`, a detached currency symbol is forgiven — but never a
 * conflicting one. Mutates the pool on success (consume-once).
 */
export function consumeMatch(pool, token, { tolerant = false } = {}) {
  if (!tolerant) {
    let index = pool.indexOf(token);
    if (index < 0) index = pool.findIndex((candidate) => criticalTokensCompatible(candidate, token));
    if (index < 0) return false;
    pool.splice(index, 1);
    return true;
  }
  const target = stripCurrency(token);
  if (!target) return false;
  const eligible = (candidate) => currencyCompatible(candidate, token);
  // Exact first even here: two candidates can strip to the same string, and
  // consuming the bare one would leave a symbol-bearing entry stranded for a
  // later token that needs it.
  let index = pool.indexOf(token);
  if (index < 0) index = pool.findIndex((candidate) => eligible(candidate) && stripCurrency(candidate) === target);
  if (index < 0) {
    index = pool.findIndex((candidate) => eligible(candidate)
      && criticalTokensCompatible(stripCurrency(candidate), target));
  }
  if (index < 0) return false;
  pool.splice(index, 1);
  return true;
}
