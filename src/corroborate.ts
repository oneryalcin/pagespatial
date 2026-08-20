import { criticalTokens, normalizeEvidenceText, splitCriticalToken } from './text.js';

/**
 * Text-pool corroboration under same-ink rules (§6), shared by escalated
 * enrichment (model proposals vs witnesses) and cross-family second-opinion
 * engagement (OCR observations vs a second engine). One implementation so
 * the matching semantics cannot drift between consumers:
 *
 * - Critical tokens consume from the pool tail-compatibly: cores must be
 *   equal; a missing tail on either side is less ink, never disagreement;
 *   exact-tail occurrences are consumed first.
 * - Each pool occurrence corroborates at most one claim (consume-once).
 * - Token-free text falls back to normalized containment with a minimum of
 *   two normalized characters (a single character matches any prose page).
 */

interface PoolEntry {
  tail: string | null;
  count: number;
}

export interface CorroborationPool {
  tokens: Map<string, PoolEntry[]>;
  blob: string;
}

export function buildCorroborationPool(texts: readonly string[]): CorroborationPool {
  const tokens = new Map<string, PoolEntry[]>();
  for (const text of texts) {
    for (const token of criticalTokens(text)) {
      const { core, tail } = splitCriticalToken(token);
      const entries = tokens.get(core) ?? [];
      const entry = entries.find((candidate) => candidate.tail === tail);
      if (entry) entry.count += 1;
      else entries.push({ tail, count: 1 });
      tokens.set(core, entries);
    }
  }
  return { tokens, blob: normalizeEvidenceText(texts.join(' ')) };
}

function consumeToken(token: string, pool: Map<string, PoolEntry[]>): boolean {
  const { core, tail } = splitCriticalToken(token);
  const entries = pool.get(core);
  if (!entries) return false;
  const usable = entries.filter((entry) =>
    entry.count > 0 && (tail === null || entry.tail === null || entry.tail === tail));
  if (!usable.length) return false;
  const exact = usable.find((entry) => entry.tail === tail);
  (exact ?? usable[0]!).count -= 1;
  return true;
}

/**
 * True when the pool corroborates the text: all of its critical tokens
 * consume (all-or-nothing — a partial claim consumes nothing), or, for
 * token-free text, normalized containment of at least two characters.
 * MUTATES the pool on success (consume-once).
 */
export function poolCorroborates(text: string, pool: CorroborationPool): boolean {
  const tokens = criticalTokens(text);
  if (tokens.length) {
    const snapshot = new Map([...pool.tokens].map(([core, entries]) =>
      [core, entries.map((entry) => ({ ...entry }))] as const));
    for (const token of tokens) {
      if (!consumeToken(token, snapshot)) return false;
    }
    for (const [core, entries] of snapshot) pool.tokens.set(core, entries);
    return true;
  }
  const needle = normalizeEvidenceText(text);
  return needle.length >= 2 && pool.blob.includes(needle);
}
