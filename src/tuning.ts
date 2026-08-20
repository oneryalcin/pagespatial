/**
 * Central registry for heuristic constants.
 *
 * Spatial constants are expressed in PDF points and multiplied by the page's
 * rendered pixels-per-point at use time, so heuristics behave identically at
 * any render scale. The dev-v6 baseline was recorded at render scale 1.6;
 * every point value below equals the original pixel constant divided by 1.6,
 * so behavior at the default scale is unchanged.
 *
 * None of these values are validated against independent gold labels yet
 * (handoff P0). Do not retune them without gold evidence; record the change
 * rationale here when gold exists.
 */

/** Render scale the heuristics were originally tuned at (dev-v6 baseline). */
export const REFERENCE_RENDER_SCALE = 1.6;

/*
 * Coupled pair, reason about together when gold arrives:
 * the browser OCR adapter admits observations down to its recognition
 * threshold (0.25 in src/browser/ppocr.ts), while diagnostics escalate any
 * observation below lowOcrConfidence (0.5 in src/diagnostics.ts). Every
 * observation in the 0.25–0.5 band is therefore a guaranteed page escalation
 * by construction. The adapter records its resolved admission policy in
 * provenance (ocrAdapterConfiguration) so the band's effect is measurable.
 */

/**
 * Coverage-starvation escalation (the false-confidence hole): a page whose
 * OCR produces plenty of confident text while almost none of it engages the
 * native layer (neither matches nor conflicts) is a single-witness page —
 * there is nothing to corroborate or contradict it, so confidently-wrong OCR
 * would otherwise pass silently. Structural rule, not a quality judgment:
 * "confident" reuses the lowOcrConfidence boundary. The coverage cutoff is
 * definitional, not fitted: a page is flagged when the MAJORITY of its
 * confident OCR is single-witness. The dev-corpus distribution is bimodal
 * (a starved cluster at 0-40% engaged coverage — scans, CJK chart pages,
 * scanned slide decks — and a corroborated cluster at 80-100%, with a
 * sparse valley between), so any cutoff inside the valley selects the same
 * cluster; strict majority (engaged coverage < 0.5) is the least
 * arbitrary member. The known false-confidence page sits at 29% coverage;
 * image-only scans at 0%.
 */
export const UNCORROBORATED_OCR_MINIMUM_COUNT = 8;
export const UNCORROBORATED_OCR_MAXIMUM_COVERAGE = 0.5;

/*
 * Unread-ink region recovery (issue #10). Constants below were set from
 * measured experiments on the gold corpus, not tuned against it blind:
 * - photographs are continuous-tone (midtone fraction 0.43 measured) while
 *   printed charts/tables/text are bimodal (0.04-0.13); 0.30 splits them
 *   with a 3x margin and a physical rationale.
 * - zoom-retry recovered 145/145 gold tokens on the worst chart page at 4x
 *   magnification of a 1.6-scale render; the zoom factor is clamped at run
 *   time so the re-render stays inside the canvas safety limits.
 */
/** Analysis grid cell size (PDF points). */
export const INK_GRID_CELL_PT = 6;
/** Luminance (0..1) at or below which a pixel counts as ink. */
export const INK_LUMINANCE_MAX = 0.85;
/** Minimum ink fraction for a grid cell to count as inked. */
export const INK_CELL_MIN_FRACTION = 0.08;
/** Dilation applied to read (observation) boxes before subtraction, in points. */
export const INK_READ_DILATE_PT = 2;
/** Minimum unread-ink region area, in square points (~45x35pt). */
export const INK_REGION_MIN_AREA_PT2 = 1600;
/** Midtone fraction at or above which a region is pictorial, not structured. */
export const INK_PICTORIAL_MIDTONE_MIN = 0.3;
/** Target magnification of the recovery re-render relative to the first render. */
export const RECOVERY_ZOOM_FACTOR = 4;
/** Recovered observations overlapped this much by first-pass boxes are dropped. */
export const RECOVERY_DUPLICATE_OVERLAP = 0.5;

/** Vertical spatial-index bucket for native/OCR candidate lookup (was 64px @1.6). */
export const ASSOCIATION_BUCKET_PT = 40;

/**
 * Association score blends text and geometry. Text dominates because OCR boxes
 * are loose polygons while text agreement is the actual evidence of identity.
 * Untuned against gold; the split is a dev-corpus judgment call.
 */
export const ASSOCIATION_TEXT_WEIGHT = 0.78;
export const ASSOCIATION_GEOMETRY_WEIGHT = 0.22;

/** Minimum similarity/overlap for accepting a native/OCR match. */
export const ASSOCIATION_MIN_TEXT_SIMILARITY = 0.72;
export const ASSOCIATION_MIN_GEOMETRY_OVERLAP = 0.12;

/**
 * Looser gates for the conflict check: a weakly similar but colocated pair is
 * still evidence of the same visible region, and disagreement there must
 * surface as a conflict instead of silently failing to match.
 */
export const CONFLICT_MIN_TEXT_SIMILARITY = 0.5;
export const CONFLICT_MIN_GEOMETRY_OVERLAP = 0.45;

/** Floor for same-line vertical tolerance in reading order (was 8px @1.6). */
export const LINE_TOLERANCE_MIN_PT = 5;

/** Same-line tolerance as a fraction of the smaller item height. */
export const LINE_TOLERANCE_HEIGHT_RATIO = 0.65;

/** Line/row grouping window as a fraction of the taller member's height. */
export const GROUP_HEIGHT_RATIO = 0.55;

/** Minimum height attributed to an OCR row when grouping (was 8px @1.6). */
export const SPATIAL_ROW_MIN_HEIGHT_PT = 5;

/** Year tokens on one visual axis row cluster within this tolerance (was 24px @1.6). */
export const RELATION_ROW_TOLERANCE_PT = 15;

/** Fallback column gap when fewer than two year gaps exist (was 80px @1.6). */
export const RELATION_FALLBACK_GAP_PT = 50;

/** Values are searched at most max(this, 4 column gaps) above the year row (was 160px @1.6). */
export const RELATION_VALUE_WINDOW_MIN_PT = 100;

/** Values must sit above the year row by at least this margin (was 2px @1.6). */
export const RELATION_VALUE_ABOVE_MARGIN_PT = 1.25;

/** A value belongs to the year column within this fraction of the column gap. */
export const RELATION_ASSIGN_RADIUS_RATIO = 0.48;

/** Derived-relation confidence: base + margin bonus, hard-capped as a derived hypothesis. */
export const RELATION_CONFIDENCE_BASE = 0.55;
export const RELATION_CONFIDENCE_MARGIN_BONUS = 0.3;
export const RELATION_CONFIDENCE_CAP = 0.85;
