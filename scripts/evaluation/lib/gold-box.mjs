/**
 * Normalizes a pre-labeled token's bounding box.
 *
 * The pre-labeler is asked for `box_2d` as [ymin, xmin, ymax, xmax] in
 * 0-1000 page coordinates. Free-form decoding drifted the key — batch 3
 * carried 29 `box_2` and one `box` — and even schema-enforced decoding can
 * return the right key with the wrong arity ([763, 122] instead of four
 * numbers), because a JSON schema constrains item type, not list length,
 * unless it is told to.
 *
 * Reading a recognised alias is recovery, not invention: the four
 * coordinates are present and unambiguous, only the key drifted. Anything
 * else returns null, and callers must SAY SO rather than substitute a
 * placeholder. A silent [0,0,0,0] renders as an invisible zero-size
 * highlight, and a silent whole-page box renders as a highlight that points
 * at everything — both of which look to a reviewer like a box that simply
 * is not there, on a page where they have no way to tell the difference
 * between "unlocated" and "located here".
 */

const ALIASES = ['box_2d', 'box_2', 'box'];

/** @returns {{box: number[], key: string} | null} */
export function normalizeTokenBox(token) {
  for (const key of ALIASES) {
    const value = token?.[key];
    if (!Array.isArray(value) || value.length !== 4) continue;
    if (!value.every((coordinate) => Number.isFinite(coordinate))) continue;
    const [y0, x0, y1, x1] = value;
    // Ordered and on-page. An inverted or out-of-range box is a misread, not
    // a location, and must not be presented as one.
    if (y1 <= y0 || x1 <= x0) continue;
    if (Math.min(y0, x0) < 0 || Math.max(y1, x1) > 1000) continue;
    return { box: value, key };
  }
  return null;
}

/** Counts tokens by box provenance, for reporting what a batch actually had. */
export function summarizeBoxes(tokens) {
  const summary = { ok: 0, recoveredAlias: 0, unusable: 0 };
  for (const token of tokens) {
    const normalized = normalizeTokenBox(token);
    if (!normalized) summary.unusable += 1;
    else if (normalized.key !== 'box_2d') summary.recoveredAlias += 1;
    else summary.ok += 1;
  }
  return summary;
}
