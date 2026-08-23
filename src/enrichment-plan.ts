/**
 * Per-page enrichment request plan (design 2026-08-23, decision 1).
 *
 * Routing to the escalated tier is NOT a three-way split: a page carrying
 * several blocking reason kinds gets several rungs, adjudication
 * additionally requires the page to carry conflicts, and residue crops
 * additionally require crop-eligible unread-ink regions. This module is
 * the single owner of that routing — the evaluation runner
 * (scripts/evaluation/run-flash-enrichment.mjs) and the service both
 * build their requests from the plan returned here, so the measured cost
 * ladder and production behaviour cannot drift apart.
 *
 * Escalation ladder (issues #17/#20), measured decision:
 * - conflict/omission reasons -> page-batched adjudication (~$0.0023)
 * - starved reasons           -> full-page transcription at HIGH (~$0.0085)
 * - residue-only reasons      -> transcription of unread-ink region crops
 * A page carrying both reason kinds gets both calls; telemetry sums.
 */
import { blockingReasons } from './enrichment.js';
import { renderedPixelsPerPoint } from './geometry.js';
import { regionEligibleForResidue } from './ink.js';
import { RECOVERY_REGION_MARGIN_PT } from './tuning.js';
import type { Box, PageSpatial, UnreadInkRegion } from './types.js';

/** One conflict, shaped for the adjudication prompt (normalizedBox is
 * ymin/xmin/ymax/xmax in 0..1000 of the page, Gemini's convention). */
export interface AdjudicationConflictInput {
  conflictId: string;
  nativeText: string;
  ocrText: string;
  normalizedBox: [number, number, number, number];
}

/** One residue region to transcribe, with its render-ready crop window. */
export interface ResidueCropPlan {
  /** The region's bounds in rendered pixels, straight off the record. */
  regionBox: Box;
  /**
   * pdftoppm crop window (-x/-y/-W/-H) in pixels at the plan's renderDpi,
   * margin applied and clamped at the page origin. Kept in the plan so
   * every caller renders the exact crop the ladder was measured with.
   */
  crop: { x: number; y: number; w: number; h: number };
}

/** Which rungs to run for one page, with their request inputs. */
export interface EnrichmentRequestPlan {
  /**
   * The dpi the crop windows were computed at. A caller MUST render crops
   * at this dpi — rendering at any other silently shifts every window.
   * Echoed on every plan (even without crops) so the contract is
   * self-describing for the service (M3).
   */
  renderDpi: number;
  /** Present iff a conflict/omission reason fired AND the page carries conflicts. */
  adjudication?: { conflicts: AdjudicationConflictInput[] };
  /** Present iff the page is coverage-starved (unknown missing content anywhere). */
  fullTranscription?: Record<string, never>;
  /**
   * Present iff residue is the only transcription reason AND at least one
   * region is crop-eligible. Full transcription subsumes crops: a starved
   * page's whole raster already covers its residue regions.
   */
  residueCrops?: { crops: ResidueCropPlan[] };
  /**
   * The unread-ink alarm fired but no region was crop-eligible: the
   * residue goes unanswered and the caller must say so (runner telemetry
   * counts these as residuePagesWithoutCropRequests).
   */
  residueUnanswered?: true;
}

/**
 * Crop-eligible residue regions: structured unread-ink regions where the
 * alarm actually fired — nothing recovered, nothing confirmed — and whose
 * narrow side can hold legible text. Boxes are in the browser-rendered
 * pixel space of page.geometry.
 */
export function residueRegions(page: PageSpatial): UnreadInkRegion[] {
  const ppp = renderedPixelsPerPoint(page.geometry);
  return (page.unreadInkRegions ?? []).filter((region) =>
    region.kind === 'structured'
    && region.recoveredObservationCount === 0
    && region.confirmations.length === 0
    && regionEligibleForResidue(region, ppp));
}

/** Conflicts shaped for the adjudication prompt. Fails closed on a
 * conflict whose ocrId matches no retained observation — adjudicating a
 * conflict without its box would misplace the model's attention. */
export function adjudicationConflictInputs(page: PageSpatial): AdjudicationConflictInput[] {
  const { width, height } = page.geometry;
  const obsBox = new Map(page.ocrObservations.map((observation) => [observation.id, observation.box]));
  return page.conflicts.map((conflict) => {
    const box = obsBox.get(conflict.ocrId);
    if (!box) throw new Error(`Conflict ${conflict.id} references unknown OCR observation ${conflict.ocrId}.`);
    return {
      conflictId: conflict.id,
      nativeText: conflict.nativeText,
      ocrText: conflict.ocrText,
      normalizedBox: [
        Math.round((box[1] / height) * 1000), Math.round((box[0] / width) * 1000),
        Math.round((box[3] / height) * 1000), Math.round((box[2] / width) * 1000)
      ]
    };
  });
}

/** pdftoppm crop window for one rendered-px box at renderDpi, with the
 * enrichment margin so boundary glyphs stay whole. Rendered-px boxes
 * convert to dpi pixels through points. */
function cropWindow(page: PageSpatial, box: Box, renderDpi: number): ResidueCropPlan['crop'] {
  const ppp = renderedPixelsPerPoint(page.geometry);
  const toDpiPx = (px: number) => Math.round(((px / ppp) * renderDpi) / 72);
  const margin = toDpiPx(RECOVERY_REGION_MARGIN_PT * ppp);
  return {
    x: Math.max(0, toDpiPx(box[0]) - margin),
    y: Math.max(0, toDpiPx(box[1]) - margin),
    w: toDpiPx(box[2]) - toDpiPx(box[0]) + 2 * margin,
    h: toDpiPx(box[3]) - toDpiPx(box[1]) + 2 * margin
  };
}

/**
 * Build the request plan for one page record.
 *
 * Accepts the stored record wrapper so failure routing is decided here: a
 * failed page (`ok: false`, or no pageSpatial at all) has no digest and no
 * blocking reasons and is NEVER routed to any rung — enrichment must not
 * substitute model output for missing evidence (design decision 7, §2).
 */
export function buildEnrichmentRequestPlan(
  record: { ok?: boolean; pageSpatial?: PageSpatial | null },
  options: { renderDpi: number }
): EnrichmentRequestPlan {
  const page = record.ok === false ? undefined : record.pageSpatial;
  if (!page) return { renderDpi: options.renderDpi };
  const plan: EnrichmentRequestPlan = { renderDpi: options.renderDpi };
  const reasons = new Set(blockingReasons(page));
  const needsFullTranscription = reasons.has('uncorroborated-ocr');
  if (needsFullTranscription) {
    plan.fullTranscription = {};
  } else if (reasons.has('unread-ink-region')) {
    const regions = residueRegions(page);
    if (regions.length) {
      plan.residueCrops = {
        crops: regions.map((region) => ({ regionBox: region.box, crop: cropWindow(page, region.box, options.renderDpi) }))
      };
    } else {
      plan.residueUnanswered = true;
    }
  }
  if ((reasons.has('critical-token-conflict') || reasons.has('critical-token-omission')) && page.conflicts.length) {
    plan.adjudication = { conflicts: adjudicationConflictInputs(page) };
  }
  return plan;
}
