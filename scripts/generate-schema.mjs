import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { toJSONSchema } from 'zod';
import { pageSpatialDocumentSchema } from '../dist/schema.js';
import { escalatedOcrEnrichmentSchema } from '../dist/enrichment.js';
import { compactPageSpatialSchema } from '../dist/compact.js';

const target = resolve('schemas/pagespatial.schema.json');
const enrichmentTarget = resolve('schemas/pagespatial-enrichment.schema.json');
const compactTarget = resolve('schemas/pagespatial-compact.schema.json');
const schema = toJSONSchema(pageSpatialDocumentSchema, { target: 'draft-2020-12' });
const enrichmentSchema = toJSONSchema(escalatedOcrEnrichmentSchema, { target: 'draft-2020-12' });
const compactSchema = toJSONSchema(compactPageSpatialSchema, { target: 'draft-2020-12' });

function enforceExactTuples(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.prefixItems)) {
    node.minItems = node.prefixItems.length;
    node.maxItems = node.prefixItems.length;
    node.items = false;
  }
  for (const value of Object.values(node)) enforceExactTuples(value);
}

enforceExactTuples(schema);
schema.$id = 'https://pagespatial.dev/schema/0.1.0/pagespatial.schema.json';
schema.title = 'PageSpatialDocument';
const output = `${JSON.stringify(schema, null, 2)}\n`;
enforceExactTuples(enrichmentSchema);
enrichmentSchema.$id = 'https://pagespatial.dev/schema/0.1.0/pagespatial-enrichment.schema.json';
enrichmentSchema.title = 'EscalatedOcrEnrichment';
const enrichmentOutput = `${JSON.stringify(enrichmentSchema, null, 2)}\n`;
enforceExactTuples(compactSchema);
compactSchema.$id = 'https://pagespatial.dev/schema/0.1.0/pagespatial-compact.schema.json';
compactSchema.title = 'CompactPageSpatial';
const compactOutput = `${JSON.stringify(compactSchema, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const existing = await readFile(target, 'utf8');
  if (existing !== output) {
    throw new Error('Committed JSON Schema is stale. Run npm run build.');
  }
  const existingEnrichment = await readFile(enrichmentTarget, 'utf8').catch(() => '');
  if (existingEnrichment !== enrichmentOutput) {
    throw new Error('Committed enrichment JSON Schema is stale. Run npm run build.');
  }
  const existingCompact = await readFile(compactTarget, 'utf8').catch(() => '');
  if (existingCompact !== compactOutput) {
    throw new Error('Committed compact JSON Schema is stale. Run npm run build.');
  }
  console.log('JSON Schema is current.');
} else {
  await writeFile(target, output);
  await writeFile(enrichmentTarget, enrichmentOutput);
  await writeFile(compactTarget, compactOutput);
  console.log(`Generated ${target}, ${enrichmentTarget}, and ${compactTarget}`);
}
