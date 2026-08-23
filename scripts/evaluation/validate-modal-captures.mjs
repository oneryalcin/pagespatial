/**
 * §14.4 criterion 2 checker: every successful document contains exactly its
 * probed page count, and each returned page is either a canonical schema
 * 0.6.0 PageSpatial record (zod pageSpatialSchema) or an explicit
 * failed-page record ({ok: false, failure}). Nonzero exit on any violation.
 *
 * Usage:
 *   node scripts/evaluation/validate-modal-captures.mjs --results <file-or-dir>
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pageSpatialSchema } from '../../dist/schema.js';

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1];
}

const listFiles = (path) => statSync(path).isDirectory()
  ? readdirSync(path).map((name) => join(path, name)).filter((file) => statSync(file).isFile())
  : [path];

function loadCaptures(path) {
  const captures = [];
  for (const file of listFiles(path)) {
    const text = readFileSync(file, 'utf8').trim();
    if (!text) continue;
    if (text.startsWith('[')) captures.push(...JSON.parse(text));
    else if (text.startsWith('{') && !text.includes('\n')) captures.push(JSON.parse(text));
    else captures.push(...text.split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  }
  return captures;
}

const resultsPath = flag('--results');
if (!resultsPath) throw new Error('--results is required');

let documents = 0;
let completed = 0;
let pagesValid = 0;
let pagesFailedRecords = 0;
const violations = [];
for (const entry of loadCaptures(resultsPath)) {
  const result = entry?.kind === 'result' ? entry.result : entry?.kind === 'exception' ? null : entry;
  if (!result) continue;
  documents += 1;
  if (result.status !== 'completed') continue;
  completed += 1;
  if (result.pages.length !== result.page_count) {
    violations.push({ request_id: result.request_id, why: `pages ${result.pages.length} != page_count ${result.page_count}` });
  }
  for (const page of result.pages) {
    if (page.ok) {
      const check = pageSpatialSchema.safeParse(page.pageSpatial);
      if (!check.success) {
        violations.push({ request_id: result.request_id, page: page.pageNumber, why: `schema: ${check.error.issues[0]?.message}` });
      } else if (page.pageSpatial.schemaVersion !== '0.6.0') {
        violations.push({ request_id: result.request_id, page: page.pageNumber, why: `schemaVersion ${page.pageSpatial.schemaVersion}` });
      } else {
        pagesValid += 1;
      }
    } else if (page.failure) {
      pagesFailedRecords += 1;
    } else {
      violations.push({ request_id: result.request_id, page: page.pageNumber, why: 'not ok and no explicit failure record' });
    }
  }
}

console.log(JSON.stringify({
  documents, completed,
  pages_schema_valid: pagesValid,
  pages_explicit_failed_records: pagesFailedRecords,
  violations
}, null, 1));
process.exitCode = violations.length === 0 ? 0 : 1;
