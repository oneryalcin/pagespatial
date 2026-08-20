import type { ParserAdapters } from './adapters.js';
import { resolveDiagnosticOptions, type DiagnosticOptions } from './diagnostics.js';
import type { AssociationOptions } from './merge.js';
import { pointBoxToRenderedBox, roundBox } from './geometry.js';
import { attributeConfirmations, countRecoveredObservations } from './ink.js';
import { assemblePageSpatial, validateNativePageGeometry } from './page-parser.js';
import { documentIdentitySchema, pageSpatialDocumentSchema } from './schema.js';
import type {
  DocumentIdentity,
  DocumentSource,
  ExtractionProvenance,
  OcrObservationInput,
  PageSpatial,
  PageSpatialDocument,
  RecoveryConfirmation,
  UnreadInkRegion
} from './types.js';

export { buildPageSpatial } from './page-parser.js';
export type { BuildPageSpatialInput } from './page-parser.js';

export interface ParseOptions {
  concurrency?: number;
  renderScale?: number;
  signal?: AbortSignal;
  onPage?: (page: PageSpatial) => void | Promise<void>;
  association?: AssociationOptions;
  diagnostics?: DiagnosticOptions;
  runId?: string;
}

function documentDiagnostics(pages: readonly PageSpatial[]): PageSpatialDocument['diagnostics'] {
  const ocrObservationCount = pages.reduce((sum, page) => sum + page.ocrObservations.length, 0);
  const recoveredObservationCount = pages.reduce(
    (sum, page) => sum + page.ocrObservations.filter((observation) => observation.recoveryMethod).length, 0);
  const sourceMatchCount = pages.reduce((sum, page) => sum + page.sourceMatches.length, 0);
  // Recoveries are single-witness by construction; counting them in the
  // association-coverage denominator would report a definitional regression
  // whenever recovery succeeds. Same exclusion as the starvation denominator
  // — and matches earned by recovered observations leave the numerator too,
  // so the ratio stays a fraction of the same population.
  const corroboratable = ocrObservationCount - recoveredObservationCount;
  const corroboratableMatchCount = pages.reduce((sum, page) => {
    const recovered = new Set(page.ocrObservations
      .filter((observation) => observation.recoveryMethod)
      .map((observation) => observation.id));
    return sum + page.sourceMatches.filter((match) => !recovered.has(match.ocrId)).length;
  }, 0);
  return {
    pageCount: pages.length,
    pagesParsed: pages.length,
    pagesRequiringEscalation: pages.filter((page) => page.diagnostics.requiresEscalation).map((page) => page.pageNumber),
    ocrObservationCount,
    recoveredObservationCount,
    nativeObservationCount: pages.reduce((sum, page) => sum + page.nativeObservations.length, 0),
    sourceMatchCount,
    nativeOcrAssociationCoverage: corroboratable ? corroboratableMatchCount / corroboratable : 0,
    criticalConflictCount: pages.reduce((sum, page) => sum + page.diagnostics.criticalConflictCount, 0),
    criticalOmissionCount: pages.reduce((sum, page) => sum + page.diagnostics.criticalOmissionCount, 0)
  };
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export function createParser<TSource = unknown, TRaster = unknown>(adapters: ParserAdapters<TSource, TRaster>): {
  parse(source: DocumentSource<TSource>, options?: ParseOptions): Promise<PageSpatialDocument>;
} {
  return {
    async parse(source, options = {}) {
      const document = documentIdentitySchema.parse(source.identity) as DocumentIdentity;
      const controller = new AbortController();
      const forwardAbort = (): void => controller.abort(options.signal?.reason);
      if (options.signal?.aborted) forwardAbort();
      else options.signal?.addEventListener('abort', forwardAbort, { once: true });
      try {
        abortIfNeeded(controller.signal);
        const pages = new Array<PageSpatial>(document.pageCount);
        const concurrency = Math.max(1, Math.min(document.pageCount, Math.floor(options.concurrency ?? 1)));
        const renderScale = options.renderScale ?? 1.6;
        if (!Number.isFinite(renderScale) || renderScale <= 0) throw new Error('renderScale must be a positive finite number.');
        const runId = options.runId ?? `run:${Date.now().toString(36)}`;
        let nextPage = 1;
        let firstError: unknown;

        const fail = (error: unknown): void => {
          if (firstError === undefined) firstError = error;
          if (!controller.signal.aborted) controller.abort(error);
        };

        const worker = async (): Promise<void> => {
          try {
            while (!controller.signal.aborted) {
              const pageNumber = nextPage;
              nextPage += 1;
              if (pageNumber > document.pageCount) return;
              const [nativeResult, renderedResult] = await Promise.allSettled([
                adapters.native.extractPage(source, pageNumber, { signal: controller.signal }),
                adapters.renderer.render(source, pageNumber, {
                  signal: controller.signal,
                  scale: renderScale
                })
              ]);
              if (nativeResult.status === 'rejected') {
                if (renderedResult.status === 'fulfilled') await renderedResult.value.release?.();
                throw nativeResult.reason;
              }
              if (renderedResult.status === 'rejected') throw renderedResult.reason;
              const nativePage = nativeResult.value;
              const rendered = renderedResult.value;
              try {
                // Preserve the adapter call boundary: invalid native/rendered
                // results must fail before OCR starts. assemblePageSpatial
                // repeats these guards for direct evaluation-harness callers.
                if (nativePage.pageNumber !== pageNumber) {
                  throw new Error(`Native adapter returned page ${nativePage.pageNumber} while parsing page ${pageNumber}.`);
                }
                for (const observation of nativePage.observations) {
                  if (observation.pageNumber !== pageNumber) {
                    throw new Error(`Native page ${pageNumber} contains an observation for page ${observation.pageNumber}.`);
                  }
                }
                if (rendered.pageNumber !== pageNumber) {
                  throw new Error(`Renderer returned page ${rendered.pageNumber} while parsing page ${pageNumber}.`);
                }
                const pageGeometry = validateNativePageGeometry(pageNumber, nativePage, rendered);
                const ocr = await adapters.ocr.recognize(rendered, { signal: controller.signal });
                abortIfNeeded(controller.signal);
                // Optional second pass (issue #10): find unread-ink regions
                // and recover structured ones through the recovery adapter.
                // Recovered observations arrive in first-render pixels with
                // recoveryMethod set; pictorial regions are recorded only.
                // `undefined` means analysis never ran (no adapter) — never
                // conflate that with "analysis found no unread ink".
                let unreadInkRegions: UnreadInkRegion[] | undefined;
                let ocrObservations: OcrObservationInput[] = ocr.observations;
                if (adapters.regionRecovery) {
                  const readEvidence = [
                    ...nativePage.observations.map((observation) => ({
                      box: observation.pointBox
                        ? pointBoxToRenderedBox(observation.pointBox, pageGeometry).box
                        : roundBox(observation.box!),
                      text: observation.text
                    })),
                    ...ocr.observations.map((observation) => ({ box: roundBox(observation.box), text: observation.text }))
                  ];
                  unreadInkRegions = await adapters.regionRecovery.analyze(
                    rendered, readEvidence.map((item) => item.box), { signal: controller.signal });
                  const structured = unreadInkRegions.filter((region) => region.kind === 'structured');
                  if (structured.length) {
                    // Recovery is a best-effort second pass: its failure is
                    // information (the regions stay residue and escalate),
                    // never a reason to lose the page. An abort still
                    // propagates — that is the caller's own cancellation.
                    let recovered: OcrObservationInput[] = [];
                    let confirmations: RecoveryConfirmation[] = [];
                    try {
                      const result = await adapters.regionRecovery.recoverPage(
                        source, pageNumber, structured, pageGeometry, readEvidence, { signal: controller.signal });
                      recovered = result.observations;
                      confirmations = result.confirmations;
                    } catch (error) {
                      abortIfNeeded(controller.signal);
                    }
                    // Blank readings are not evidence; drop them before they
                    // can count against a region's residue.
                    recovered = recovered.filter((observation) => observation.text.trim().length > 0);
                    confirmations = confirmations.filter((confirmation) => confirmation.text.trim().length > 0);
                    ocrObservations = [...ocrObservations, ...recovered];
                    // Attach confirmation receipts to the region each
                    // overlaps most; validity is derived downstream.
                    attributeConfirmations(unreadInkRegions, confirmations).forEach((regionIndex, index) => {
                      if (regionIndex >= 0) unreadInkRegions![regionIndex]!.confirmations.push(confirmations[index]!);
                    });
                  }
                  // Stamp counts with the same derivation the schema uses, so
                  // stored counts always reconcile with retained evidence.
                  const counts = countRecoveredObservations(unreadInkRegions, ocrObservations.map((observation) => ({
                    box: roundBox(observation.box),
                    text: observation.text,
                    ...(observation.recoveryMethod ? { recoveryMethod: observation.recoveryMethod } : {})
                  })));
                  unreadInkRegions.forEach((region, index) => {
                    region.recoveredObservationCount = counts[index]!;
                  });
                }
                const page = assemblePageSpatial({
                  document,
                  pageNumber,
                  nativePage,
                  renderedPage: rendered,
                  ocrPage: { ...ocr, observations: ocrObservations },
                  unreadInkRegions,
                  runId,
                  nativeAdapter: `${adapters.native.name}@${adapters.native.version}`,
                  renderer: `${adapters.renderer.name}@${adapters.renderer.version}`,
                  ocrAdapter: `${adapters.ocr.name}@${adapters.ocr.version}`,
                  ...(adapters.regionRecovery
                    ? { regionRecoveryAdapter: `${adapters.regionRecovery.name}@${adapters.regionRecovery.version}` }
                    : {}),
                  configuration: {
                    renderScale,
                    concurrency,
                    diagnosticPolicy: resolveDiagnosticOptions(options.diagnostics),
                    ...(adapters.ocr.configuration ? { ocrAdapterConfiguration: adapters.ocr.configuration } : {})
                  },
                  association: options.association,
                  diagnostics: options.diagnostics
                });
                pages[pageNumber - 1] = page;
                await options.onPage?.(page);
              } finally {
                await rendered.release?.();
              }
            }
          } catch (error) {
            fail(error);
          }
        };

        await Promise.all(Array.from({ length: concurrency }, () => worker()));
        if (firstError !== undefined) throw firstError;
        abortIfNeeded(controller.signal);
        const completed = pages.filter((page): page is PageSpatial => Boolean(page));
        const provenance: ExtractionProvenance = {
          parserName: 'pagespatial',
          parserVersion: '0.1.0',
          runId,
          createdAt: new Date().toISOString(),
          nativeAdapter: `${adapters.native.name}@${adapters.native.version}`,
          renderer: `${adapters.renderer.name}@${adapters.renderer.version}`,
          ocrAdapter: `${adapters.ocr.name}@${adapters.ocr.version}`,
          ...(adapters.regionRecovery
            ? { regionRecoveryAdapter: `${adapters.regionRecovery.name}@${adapters.regionRecovery.version}` }
            : {}),
          configuration: {
            renderScale,
            concurrency,
            diagnosticPolicy: resolveDiagnosticOptions(options.diagnostics),
            ...(adapters.ocr.configuration ? { ocrAdapterConfiguration: adapters.ocr.configuration } : {})
          }
        };
        const result: PageSpatialDocument = {
          schemaVersion: '0.5.0',
          document,
          pages: completed,
          diagnostics: documentDiagnostics(completed),
          provenance
        };
        return pageSpatialDocumentSchema.parse(result) as PageSpatialDocument;
      } finally {
        options.signal?.removeEventListener('abort', forwardAbort);
      }
    }
  };
}
