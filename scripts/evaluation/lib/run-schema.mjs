import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const gitOid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const relativePath = z.string().min(1).refine((value) => !value.startsWith('/') && !value.includes('..'), 'Expected a safe relative path.');
const dataset = z.object({ repoType: z.literal('dataset'), repoId: z.string().min(1), revision: z.string().min(1) }).strict();
const backend = z.object({ actual: z.enum(['wasm', 'webgpu']), events: z.array(z.unknown()) }).strict();
const browserSession = z.object({
  sessionId: z.string().min(1), startedAt: z.iso.datetime(), browser: z.string().min(1), browserVersion: z.string().min(1),
  executablePath: z.string().min(1), userAgent: z.string().nullable(),
  gpu: z.object({ vendor: z.string().nullable(), architecture: z.string().nullable(), device: z.string().nullable(), description: z.string().nullable() }).strict().nullable(),
  warmupMs: z.number().nonnegative(), backend: z.enum(['wasm', 'webgpu'])
}).strict();
const failure = z.object({
  stage: z.string().min(1), errorClass: z.string().min(1), message: z.string().max(8_192), partialEvidence: z.boolean()
}).strict();
const commonEnvelope = z.object({
  schemaVersion: z.literal(1), runId: z.string().min(1), fingerprint: hash,
  corpusId: z.string().min(1), manifestHash: hash, dataset,
  objectId: z.string().min(1), path: relativePath,
  source: z.object({ sha256: hash, pageCount: z.number().int().positive() }).strict(),
  pageNumber: z.number().int().positive(), labels: z.array(z.string())
});

const successEnvelope = commonEnvelope.extend({
  status: z.literal('succeeded'), backend, runtime: browserSession,
  timings: z.object({ inspectorPageMs: z.number().nonnegative(), renderMs: z.number().nonnegative(), ocrMs: z.number().nonnegative(), pageTotalMs: z.number().nonnegative() }).strict(),
  memory: z.object({ nodeRssBytes: z.number().int().nonnegative(), browser: z.unknown() }).strict(),
  goldMetrics: z.literal('not_evaluated'), pageSpatial: z.unknown()
}).strict();

const failedEnvelope = commonEnvelope.extend({
  status: z.enum(['failed', 'timed_out', 'aborted']),
  backend: backend.optional(), timings: z.record(z.string(), z.number().nonnegative()).optional(),
  partialEvidence: z.object({ renderedPage: z.unknown().optional(), ocrPage: z.unknown().optional(), nativePage: z.unknown().optional() }).strict().optional(),
  runtime: browserSession.optional(), failure
}).strict();

export const attemptEnvelopeSchema = z.discriminatedUnion('status', [successEnvelope, failedEnvelope]);

export const pageStateSchema = z.object({
  pageNumber: z.number().int().positive(), status: z.enum(['succeeded', 'resumed', 'failed', 'timed_out', 'aborted']),
  attemptPath: relativePath, attemptSha256: hash,
  outputSha256: hash.optional(), failure: failure.optional()
}).strict().superRefine((state, context) => {
  const accepted = state.status === 'succeeded' || state.status === 'resumed';
  if (accepted !== Boolean(state.outputSha256)) context.addIssue({ code: 'custom', message: 'Accepted pages require exactly one output hash.' });
  if (accepted === Boolean(state.failure)) context.addIssue({ code: 'custom', message: 'Only failed page states require failure details.' });
});

export const documentSummarySchema = z.object({
  schemaVersion: z.literal(1), objectId: z.string().min(1), path: relativePath, sha256: hash,
  pageCount: z.number().int().positive(), selectedPages: z.array(z.number().int().positive()).min(1),
  inspector: z.object({ timings: z.record(z.string(), z.number().nonnegative()), peakSampledRssBytes: z.number().int().nonnegative() }).strict().nullable(),
  wallMs: z.number().nonnegative(), pages: z.array(pageStateSchema).min(1)
}).strict().superRefine((summary, context) => {
  if (new Set(summary.selectedPages).size !== summary.selectedPages.length || new Set(summary.pages.map((page) => page.pageNumber)).size !== summary.pages.length) {
    context.addIssue({ code: 'custom', message: 'Summary page identities must be unique.' });
  }
  if (summary.pages.length !== summary.selectedPages.length || summary.pages.some((page) => !summary.selectedPages.includes(page.pageNumber))) {
    context.addIssue({ code: 'custom', message: 'Summary page states must exactly cover selected pages.' });
  }
});

export const runInvocationSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().min(1), status: z.enum(['completed', 'completed_with_failures']),
  startedAt: z.iso.datetime(), endedAt: z.iso.datetime(),
  corpus: z.object({ corpusId: z.string(), manifestPath: relativePath, manifestHash: hash, dataset, accessScope: z.literal('development-only') }).strict(),
  implementation: z.object({ commit: gitOid, dirty: z.boolean(), workspaceHash: hash, files: z.number().int().positive() }).strict(),
  environment: z.object({
    node: z.string(), platform: z.string(), arch: z.string(),
    cpu: z.object({ model: z.string().min(1), logicalCores: z.number().int().positive() }).strict(),
    totalMemoryBytes: z.number().int().positive(),
    browserSessions: z.array(browserSession)
  }).strict(),
  packages: z.record(z.string(), z.string()), profile: z.record(z.string(), z.unknown()),
  documents: z.array(z.object({ objectId: z.string().min(1), summary: relativePath, sha256: hash }).strict()),
  totals: z.object({
    documents: z.number().int().nonnegative(), pagesExpected: z.number().int().nonnegative(), pagesTerminal: z.number().int().nonnegative(),
    executed: z.number().int().nonnegative(), resumed: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(), failures: z.number().int().nonnegative()
  }).strict(),
  eventLogFailures: z.number().int().nonnegative(), goldMetrics: z.record(z.string(), z.literal('not_evaluated'))
}).strict().superRefine((run, context) => {
  if (run.documents.length !== run.totals.documents) context.addIssue({ code: 'custom', message: 'Run document total is inconsistent.' });
  if (run.totals.pagesTerminal !== run.totals.pagesExpected || run.totals.succeeded + run.totals.failures !== run.totals.pagesTerminal) {
    context.addIssue({ code: 'custom', message: 'Run terminal page totals are inconsistent.' });
  }
  if (run.totals.executed + run.totals.resumed !== run.totals.pagesTerminal) context.addIssue({ code: 'custom', message: 'Run execution/resume totals are inconsistent.' });
  if ((run.status === 'completed') !== (run.totals.failures === 0)) context.addIssue({ code: 'custom', message: 'Run status is inconsistent with failures.' });
});
