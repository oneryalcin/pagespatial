import { z } from 'zod';
import { pageProjectionSchema, provenanceSchema } from './schema.js';
import type { PageSpatial } from './types.js';

export const COMPACT_PAGE_SCHEMA_VERSION = 'pagespatial-compact-v1' as const;

export const compactProvenanceSchema = provenanceSchema.pick({
  parserName: true,
  parserVersion: true,
  nativeAdapter: true,
  ocrAdapter: true,
  regionRecoveryAdapter: true,
  renderer: true,
  backend: true,
  configuration: true,
});

export const compactPageSpatialSchema = z.object({
  schemaVersion: z.literal(COMPACT_PAGE_SCHEMA_VERSION),
  documentId: z.string(),
  revisionId: z.string(),
  documentSha256: z.string().regex(/^[a-f0-9]{64}$/iu),
  pageId: z.string(),
  pageNumber: z.number().int().positive(),
  projection: pageProjectionSchema,
  provenance: compactProvenanceSchema,
}).strict();

export type CompactPageSpatial = z.infer<typeof compactPageSpatialSchema>;

/** Deterministic derived view. The PageSpatial record remains the authority. */
export function projectCompactPage(page: PageSpatial): CompactPageSpatial {
  return compactPageSpatialSchema.parse({
    schemaVersion: COMPACT_PAGE_SCHEMA_VERSION,
    documentId: page.documentId,
    revisionId: page.revisionId,
    documentSha256: page.documentSha256,
    pageId: page.pageId,
    pageNumber: page.pageNumber,
    projection: page.projection,
    provenance: compactProvenanceSchema.parse(page.provenance),
  });
}
