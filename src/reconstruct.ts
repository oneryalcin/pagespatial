/**
 * Deterministic SVG reconstruction of a page from its PageSpatial record.
 *
 * The acid test of the format: anything visible on the PDF but absent from
 * this SVG is, by construction, something the record failed to capture.
 * Byte-honest — every mark derives from a field on the record; nothing is
 * inferred, beautified, or invented. Same record in, identical bytes out.
 *
 * Coordinate space: rendered pixels (geometry.width × geometry.height),
 * because that is the space every box on the record lives in — observation
 * boxes, unread-ink regions, confirmations, and second-opinion readings
 * alike. Rendered space is post-rotation, so no rotation handling is needed
 * or performed here; `pointBox` values are provenance, not drawing input.
 *
 * Fidelity ceiling (deliberate): text + layout skeleton, not look. Fonts,
 * colors, images, and vector graphics are not stored on the record and so
 * cannot appear. Spatial position — which carries meaning of its own — is
 * preserved exactly.
 */
import type { Box, PageSpatial } from './types.js';

export interface ReconstructOptions {
  /**
   * Draw secondOpinion readings (default false). They are unauthenticated
   * content per the honest-scope note on SecondOpinionPass, so they stay
   * out of the reconstruction unless explicitly requested.
   */
  includeSecondOpinion?: boolean;
}

const FONT_STACK = 'system-ui, -apple-system, sans-serif';
// Palette chosen once, embedded as literals so output is self-contained and
// deterministic. Ink for native (two-witness-anchored) text; muted blue for
// OCR-only text; alarm red for conflicts; grey hatching for unread ink.
const INK = '#1c2733';
const OCR_ONLY = '#3d6fa3';
const CONFLICT = '#b5432c';
const REGION = '#8a8577';
const SECOND_OPINION = '#7a5da3';

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // XML 1.0 forbids most C0 controls even as entities. Render them as a
    // VISIBLE marker instead of crashing or silently dropping: the record's
    // weirdness stays on the page, which is the honest outcome.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);

const round = (value: number): string => Number(value.toFixed(2)).toString();

/**
 * One text element per observation: baseline sits near the box bottom, font
 * size derived from box height. `textLength` is applied only to compress
 * text that would overflow its box — never to stretch short text — so the
 * reconstruction stays legible while long lines keep their recorded extent.
 */
function textElement(box: Box, text: string, fill: string, extra = ''): string {
  const [x0, y0, x1, y1] = box;
  const height = Math.max(1, y1 - y0);
  const width = Math.max(1, x1 - x0);
  const fontSize = Math.max(4, height * 0.72);
  const baseline = y1 - height * 0.18;
  const estimatedWidth = text.length * fontSize * 0.55;
  const fit = estimatedWidth > width
    ? ` textLength="${round(width)}" lengthAdjust="spacingAndGlyphs"`
    : '';
  return `<text x="${round(x0)}" y="${round(baseline)}" font-size="${round(fontSize)}" fill="${fill}"${fit}${extra}>${escapeXml(text)}</text>`;
}

function rect(box: Box, attrs: string): string {
  const [x0, y0, x1, y1] = box;
  return `<rect x="${round(x0)}" y="${round(y0)}" width="${round(Math.max(0, x1 - x0))}" height="${round(Math.max(0, y1 - y0))}" ${attrs}/>`;
}

export function reconstructSvg(page: PageSpatial, options: ReconstructOptions = {}): string {
  const { width, height } = page.geometry;
  const parts: string[] = [];
  const legend: string[] = [];

  // OCR observations that duplicate a native reading (recorded source
  // matches) are corroboration, not additional page content: the native
  // drawing already places that ink. Only unmatched OCR text is drawn.
  const matchedOcrIds = new Set(page.sourceMatches.map((match) => match.ocrId));
  const conflictOcrIds = new Set(page.conflicts.map((conflict) => conflict.ocrId));
  const conflictNativeIds = new Set(page.conflicts.flatMap((conflict) => conflict.nativeIds));

  for (const observation of page.nativeObservations) {
    parts.push(textElement(observation.box, observation.text, INK));
  }
  if (page.nativeObservations.length) legend.push(`<tspan fill="${INK}">native text</tspan>`);

  let drewOcrOnly = false;
  for (const observation of page.ocrObservations) {
    const conflicted = conflictOcrIds.has(observation.id);
    if (matchedOcrIds.has(observation.id) && !conflicted) continue;
    // A conflicted reading is disputed, not merely single-witness — it gets
    // the conflict color so the legend never claims a state the page lacks.
    parts.push(textElement(observation.box, observation.text, conflicted ? CONFLICT : OCR_ONLY));
    if (!conflicted) drewOcrOnly = true;
  }
  if (drewOcrOnly) legend.push(`<tspan fill="${OCR_ONLY}">OCR-only text</tspan>`);

  // Conflicts: outline every participating observation so the disputed ink
  // is visibly disputed. Both readings are already drawn above (the native
  // one as ink, the conflicting OCR one via the conflict-id exemption).
  if (page.conflicts.length) {
    const boxes = new Map<string, Box>();
    for (const observation of page.nativeObservations) boxes.set(observation.id, observation.box);
    for (const observation of page.ocrObservations) boxes.set(observation.id, observation.box);
    for (const id of [...conflictNativeIds, ...conflictOcrIds]) {
      const box = boxes.get(id);
      if (box) parts.push(rect(box, `fill="none" stroke="${CONFLICT}" stroke-width="1.5" stroke-dasharray="4 3"`));
    }
    legend.push(`<tspan fill="${CONFLICT}">conflicted reading</tspan>`);
  }

  for (const region of page.unreadInkRegions ?? []) {
    // Fail visible on kinds this renderer does not know (the CLI performs
    // no schema validation, so hand-loaded records can carry anything):
    // an unknown kind is labeled as such, never silently drawn as unread ink.
    const known = region.kind === 'structured' || region.kind === 'pictorial';
    const label = !known
      ? `unknown region (${region.kind})`
      : region.kind === 'pictorial'
        ? 'pictorial region'
        : region.confirmations.length && !region.recoveredObservationCount
          ? 'unread ink (corroborated)'
          : 'unread ink';
    const hatch = region.kind === 'structured' ? ' fill="url(#unread-hatch)"' : '';
    const stroke = known ? 'stroke-width="1"' : 'stroke-width="2" stroke-dasharray="2 2"';
    parts.push(rect(region.box, `stroke="${REGION}" ${stroke}${hatch || ' fill="none"'}`));
    const [x0, y0] = region.box;
    parts.push(`<text x="${round(x0 + 3)}" y="${round(y0 + 11)}" font-size="9" fill="${REGION}">${escapeXml(label)}</text>`);
  }
  if ((page.unreadInkRegions ?? []).length) legend.push(`<tspan fill="${REGION}">unread-ink / pictorial region</tspan>`);

  if (options.includeSecondOpinion && page.secondOpinion) {
    for (const reading of page.secondOpinion.readings) {
      parts.push(textElement(reading.box, reading.text, SECOND_OPINION, ' opacity="0.75"'));
    }
    if (page.secondOpinion.readings.length) {
      legend.push(`<tspan fill="${SECOND_OPINION}">second-opinion reading (unauthenticated)</tspan>`);
    }
  }

  const legendBlock = legend.length
    ? `<text x="4" y="${round(height - 6)}" font-size="9" font-family="${FONT_STACK}">legend: ${legend.join(`<tspan fill="${INK}"> · </tspan>`)}</text>`
    : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(width)} ${round(height)}" font-family="${FONT_STACK}">`,
    '<defs><pattern id="unread-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
      `<line x1="0" y1="0" x2="0" y2="6" stroke="${REGION}" stroke-width="1" opacity="0.5"/></pattern></defs>`,
    `<rect width="${round(width)}" height="${round(height)}" fill="#ffffff"/>`,
    `<title>${escapeXml(page.pageId)} — reconstructed from PageSpatial ${page.schemaVersion}; text and layout only, no fonts/colors/images by design</title>`,
    ...parts,
    legendBlock,
    '</svg>'
  ].filter(Boolean).join('\n');
}
