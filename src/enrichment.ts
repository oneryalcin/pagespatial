import { z } from 'zod';
import { buildCorroborationPool, poolCorroborates } from './corroborate.js';
import { criticalTokens, normalizeEvidenceText } from './text.js';
import type { PageSpatial } from './types.js';

/**
 * Escalated-tier enrichment (issue #2): when a page carries blocking
 * escalation reasons, a stronger model may transcribe it and PROPOSE tokens
 * the deterministic witnesses missed. Principles §4/§5 constrain the shape:
 *
 * - The canonical PageSpatial record is NEVER mutated. Enrichment is a
 *   separate revision record, bound fail-closed to the exact page record it
 *   enriched (SHA-256 of the canonical page JSON). Any reparse — even of
 *   identical input — changes the digest (provenance runId/createdAt are
 *   deliberately inside it: conservative, at the cost of re-enriching after
 *   identical reparses), so stale enrichments never silently reattach.
 * - Model proposals are TEXT ONLY. The model's box claims are kept as an
 *   explicitly-labelled coarse hint for highlight UX; they are never
 *   evidence geometry and never enter association (reject-don't-repair:
 *   fabricated geometry is worse than none).
 * - Every proposal carries a derived corroboration status against the
 *   page's own witnesses. A proposal no witness supports stays 'novel' —
 *   searchable downstream only with its model-proposed, uncorroborated
 *   trust label attached.
 * - Off the critical path: the deterministic parse indexes immediately;
 *   enrichment lands as a follow-up revision seconds later.
 */

export type ProposalCorroboration = 'corroborated-both' | 'corroborated-native' | 'corroborated-ocr' | 'novel';

export interface EnrichmentProposal {
  /** Verbatim model transcription of one token/value. */
  text: string;
  /**
   * Model-claimed location, normalized 0-1000 as [ymin, xmin, ymax, xmax].
   * A COARSE HINT for highlight UX only — never evidence geometry, never
   * used for association or validation.
   */
  modelBoxHint?: [number, number, number, number];
  /** Derived: which deterministic witnesses corroborate this text. */
  corroboration: ProposalCorroboration;
}

/**
 * A model verdict on one recorded conflict. Opinion, not resolution: the
 * conflict stays on the canonical page (escalate-don't-vote); downstream
 * ranking may weight by the verdict, carrying its model provenance.
 */
export interface ConflictAdjudication {
  /** Must reference a conflict id present on the base page (fail-closed). */
  conflictId: string;
  verdict: 'native' | 'ocr' | 'both-wrong' | 'unsure';
  /**
   * Present when the verdict was DEFAULTED (the model declined, answered
   * ambiguously, or answered malformed) rather than actually judged. A run
   * whose adjudications silently collapsed must be visible in the record.
   */
  unanswered?: true;
  /** Model transcription of the disputed ink, verbatim. */
  inkText?: string;
}

export interface OperationProvenance {
  adapter: string;
  model: string;
  mediaResolution: string;
  promptRevision: string;
  /** Model thinking budget (0 = disabled) — extractor config, so provenance. */
  thinkingBudget: number;
}

export interface EscalatedOcrEnrichment {
  enrichmentSchemaVersion: 'enrichment-0.2.0';
  documentId: string;
  revisionId: string;
  documentSha256: string;
  pageId: string;
  pageNumber: number;
  /**
   * SHA-256 of the canonical JSON of the exact PageSpatial record this
   * enrichment was computed against. Joins fail closed: a reparsed page no
   * longer matches and the stale enrichment must be discarded, never
   * silently reattached.
   */
  basePageDigest: string;
  createdAt: string;
  /** Why this page was routed to the escalated tier (blocking reasons at parse time). */
  trigger: { blockingReasons: string[] };
  /**
   * Per-operation provenance: proposals come from `transcription`,
   * adjudications from `adjudication`. A record carries exactly the
   * provenance of the operations that ran — attributing one operation's
   * output to another's extractor config is false provenance.
   */
  provenance: {
    transcription?: OperationProvenance;
    adjudication?: OperationProvenance;
  };
  proposals: EnrichmentProposal[];
  /** Verdicts on the base page's recorded conflicts (may be empty). */
  adjudications: ConflictAdjudication[];
  /** Measured cost/latency telemetry for the economics ledger. */
  telemetry: { promptTokens: number; outputTokens: number; latencyMs: number };
  trust: 'untrusted-document-content';
}

const boxHintSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

const operationProvenanceSchema = z.object({
  adapter: z.string().min(1),
  model: z.string().min(1),
  mediaResolution: z.string().min(1),
  promptRevision: z.string().min(1),
  thinkingBudget: z.number().int().nonnegative()
}).strict();

export const escalatedOcrEnrichmentSchema = z.object({
  enrichmentSchemaVersion: z.literal('enrichment-0.2.0'),
  documentId: z.string().min(1),
  revisionId: z.string().min(1),
  documentSha256: z.string().regex(/^[a-f0-9]{64}$/iu),
  pageId: z.string().min(1),
  pageNumber: z.number().int().positive(),
  basePageDigest: z.string().regex(/^[a-f0-9]{64}$/iu),
  createdAt: z.string().min(1),
  trigger: z.object({ blockingReasons: z.array(z.string().min(1)).min(1) }).strict(),
  provenance: z.object({
    transcription: operationProvenanceSchema.optional(),
    adjudication: operationProvenanceSchema.optional()
  }).strict(),
  // Strict everywhere: a smuggled key on a proposal (e.g. evidenceBox,
  // trust) would contradict the text-only invariant while surviving a
  // top-level-only strictness check.
  proposals: z.array(z.object({
    text: z.string().min(1),
    modelBoxHint: boxHintSchema.optional(),
    corroboration: z.enum(['corroborated-both', 'corroborated-native', 'corroborated-ocr', 'novel'])
  }).strict()),
  adjudications: z.array(z.object({
    conflictId: z.string().min(1),
    verdict: z.enum(['native', 'ocr', 'both-wrong', 'unsure']),
    unanswered: z.literal(true).optional(),
    inkText: z.string().min(1).optional()
  }).strict()),
  telemetry: z.object({
    promptTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    latencyMs: z.number().nonnegative()
  }).strict(),
  trust: z.literal('untrusted-document-content')
}).strict();

/** Routing predicate: only blocking pages spend model budget (principles §5). */
export function pageQualifiesForEscalatedEnrichment(page: PageSpatial): boolean {
  return blockingReasons(page).length > 0;
}

export function blockingReasons(page: PageSpatial): string[] {
  return page.diagnostics.escalationReasons
    .filter((reason) => reason.severity === 'blocking')
    .map((reason) => reason.type);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 of the canonical JSON of a page record (WebCrypto, runtime-agnostic). */
export async function pageDigest(page: PageSpatial): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(page));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Tokens a witness pool can corroborate: the critical tokens of every
 * observation text (same-ink canonicalization), as a consumable multiset —
 * each printed occurrence corroborates at most one proposal.
 */
// Pool mechanics live in src/corroborate.ts, shared with cross-family
// second-opinion engagement so the matching semantics cannot drift.

/**
 * Derive each proposal's corroboration status against the page's witnesses.
 * A proposal with critical tokens is corroborated by a pool only when the
 * pool can supply ALL of them (occurrence-consuming). A proposal without
 * critical tokens falls back to normalized-text containment in the pool's
 * observation texts.
 */
export function deriveCorroboration(
  proposals: readonly { text: string; modelBoxHint?: [number, number, number, number] }[],
  page: Pick<PageSpatial, 'nativeObservations' | 'ocrObservations'>
): EnrichmentProposal[] {
  const nativePool = buildCorroborationPool(page.nativeObservations.map((observation) => observation.text));
  const ocrPool = buildCorroborationPool(page.ocrObservations.map((observation) => observation.text));

  return proposals.map((proposal) => {
    const native = poolCorroborates(proposal.text, nativePool);
    const ocr = poolCorroborates(proposal.text, ocrPool);
    const corroboration: ProposalCorroboration = native && ocr
      ? 'corroborated-both'
      : native ? 'corroborated-native' : ocr ? 'corroborated-ocr' : 'novel';
    return {
      text: proposal.text,
      ...(proposal.modelBoxHint ? { modelBoxHint: proposal.modelBoxHint } : {}),
      corroboration
    };
  });
}

export interface BuildEnrichmentInput {
  page: PageSpatial;
  proposals: readonly { text: string; modelBoxHint?: [number, number, number, number] }[];
  adjudications?: readonly ConflictAdjudication[];
  provenance: EscalatedOcrEnrichment['provenance'];
  telemetry: EscalatedOcrEnrichment['telemetry'];
  createdAt?: string;
}

export async function buildEscalatedOcrEnrichment(input: BuildEnrichmentInput): Promise<EscalatedOcrEnrichment> {
  const reasons = blockingReasons(input.page);
  if (!reasons.length) {
    throw new Error('Enrichment is escalated-tier only: the page carries no blocking escalation reason.');
  }
  if (input.proposals.length && !input.provenance.transcription) {
    throw new Error('Proposals require transcription provenance.');
  }
  if ((input.adjudications ?? []).length && !input.provenance.adjudication) {
    throw new Error('Adjudications require adjudication provenance.');
  }
  if (!input.provenance.transcription && !input.provenance.adjudication) {
    throw new Error('Enrichment provenance must name at least one operation.');
  }
  const record: EscalatedOcrEnrichment = {
    enrichmentSchemaVersion: 'enrichment-0.2.0',
    documentId: input.page.documentId,
    revisionId: input.page.revisionId,
    documentSha256: input.page.documentSha256,
    pageId: input.page.pageId,
    pageNumber: input.page.pageNumber,
    basePageDigest: await pageDigest(input.page),
    createdAt: input.createdAt ?? new Date().toISOString(),
    trigger: { blockingReasons: reasons },
    provenance: input.provenance,
    proposals: deriveCorroboration(input.proposals, input.page),
    adjudications: validateAdjudications(input.adjudications ?? [], input.page),
    telemetry: input.telemetry,
    trust: 'untrusted-document-content'
  };
  return escalatedOcrEnrichmentSchema.parse(record) as EscalatedOcrEnrichment;
}

/**
 * Every adjudication must reference a distinct conflict recorded on the
 * base page — a verdict on a conflict that does not exist is fabricated
 * evidence and fails closed.
 */
function validateAdjudications(
  adjudications: readonly ConflictAdjudication[],
  page: Pick<PageSpatial, 'conflicts'>
): ConflictAdjudication[] {
  const known = new Set(page.conflicts.map((conflict) => conflict.id));
  const seen = new Set<string>();
  for (const adjudication of adjudications) {
    if (!known.has(adjudication.conflictId)) {
      throw new Error(`Adjudication references unknown conflict ${adjudication.conflictId}.`);
    }
    if (seen.has(adjudication.conflictId)) {
      throw new Error(`Duplicate adjudication for conflict ${adjudication.conflictId}.`);
    }
    seen.add(adjudication.conflictId);
  }
  return [...adjudications];
}

/**
 * Fail-closed validation of an enrichment against the page record it claims
 * to enrich: identity fields, digest, trigger, and every corroboration
 * status are re-derived.
 *
 * Honest scope: this guards STALENESS (digest of the base page) and
 * INTERNAL CONSISTENCY (corroboration labels re-derive; adjudication
 * conflictIds must reference recorded conflicts, uniquely). It does NOT
 * authenticate content: proposals, adjudication VERDICTS and inkText,
 * provenance, and telemetry are all un-derivable from the page and can be
 * rewritten without failing validation — a flipped verdict is the most
 * consequential such edit, since it blesses one side of a conflict. The
 * library holds no signing key; content authenticity is a deployment
 * concern (sign or ACL the enrichment store).
 *
 * Returns the schema-parsed record: consumers must use `record`, not the
 * input object, so smuggled unknown keys cannot survive into downstream
 * reads.
 */
export async function validateEnrichmentAgainstPage(
  enrichment: EscalatedOcrEnrichment,
  page: PageSpatial
): Promise<{ valid: boolean; issues: string[]; record?: EscalatedOcrEnrichment }> {
  const issues: string[] = [];
  let record: EscalatedOcrEnrichment | undefined;
  const parsed = escalatedOcrEnrichmentSchema.safeParse(enrichment);
  if (!parsed.success) {
    return { valid: false, issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) };
  }
  record = parsed.data as EscalatedOcrEnrichment;
  if (enrichment.documentId !== page.documentId) issues.push('documentId does not match the page record.');
  if (enrichment.pageId !== page.pageId) issues.push('pageId does not match the page record.');
  if (enrichment.documentSha256 !== page.documentSha256) issues.push('documentSha256 does not match.');
  if (enrichment.revisionId !== page.revisionId) issues.push('revisionId does not match.');
  if (enrichment.pageNumber !== page.pageNumber) issues.push('pageNumber does not match.');
  if (enrichment.basePageDigest !== await pageDigest(page)) {
    issues.push('basePageDigest does not match the canonical page record (stale or forged enrichment).');
  }
  const reasons = blockingReasons(page);
  if (!reasons.length) issues.push('Page carries no blocking escalation reason; enrichment is not justified.');
  if (JSON.stringify([...enrichment.trigger.blockingReasons].sort()) !== JSON.stringify([...reasons].sort())) {
    issues.push('Trigger reasons do not match the page diagnostics.');
  }
  const derived = deriveCorroboration(enrichment.proposals, page);
  enrichment.proposals.forEach((proposal, index) => {
    if (proposal.corroboration !== derived[index]!.corroboration) {
      issues.push(`Proposal ${index} corroboration must be ${derived[index]!.corroboration}.`);
    }
  });
  try {
    validateAdjudications(enrichment.adjudications, page);
  } catch (error) {
    issues.push(String(error instanceof Error ? error.message : error));
  }
  return { valid: issues.length === 0, issues, ...(issues.length === 0 ? { record } : {}) };
}
