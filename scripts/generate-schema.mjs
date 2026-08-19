import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { toJSONSchema } from 'zod';
import { pageSpatialDocumentSchema } from '../dist/schema.js';

const target = resolve('schemas/pagespatial.schema.json');
const schema = toJSONSchema(pageSpatialDocumentSchema, { target: 'draft-2020-12' });

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

if (process.argv.includes('--check')) {
  const existing = await readFile(target, 'utf8');
  if (existing !== output) {
    throw new Error('Committed JSON Schema is stale. Run npm run build.');
  }
  console.log('JSON Schema is current.');
} else {
  await writeFile(target, output);
  console.log(`Generated ${target}`);
}
