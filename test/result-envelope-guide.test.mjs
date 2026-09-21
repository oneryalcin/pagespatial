import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';

const guide = readFileSync(new URL('../docs/result-envelope-guide.md', import.meta.url), 'utf8');
const apiGuide = readFileSync(new URL('../docs/api-guide.md', import.meta.url), 'utf8');
const compactSchema = JSON.parse(readFileSync(
  new URL('../schemas/pagespatial-compact.schema.json', import.meta.url),
  'utf8',
));

test('schema guide compact example is valid and matches the canonical page schema', () => {
  const match = /```json\n([\s\S]*?)\n```/u.exec(guide);
  assert.ok(match, 'guide must contain one JSON example');
  const example = JSON.parse(match[1]);
  assert.deepEqual(Object.keys(example), [
    'schema_version', 'representation', 'job_id', 'attempt_id',
    'input_sha256', 'page_count', 'pages',
  ]);
  assert.equal(example.schema_version, 'pagespatial-compact-v1');
  assert.equal(example.representation, 'compact');
  assert.equal(example.pages.length, example.page_count);
  const validate = new Ajv2020({ allErrors: true }).compile(compactSchema);
  assert.equal(validate(example.pages[0].page_compact), true, JSON.stringify(validate.errors));
  assert.deepEqual(example.pages[1], {
    page_number: 2,
    ok: false,
    failure: { code: 'page_failed', message: 'Page could not be parsed.' },
  });
});

test('schema guide states the compact and evidence boundary and selector', () => {
  assert.match(guide, /omitted\s+`view` and `view=compact` select the compact result/u);
  assert.match(guide, /Use `view=evidence`/u);
  assert.match(guide, /not evidence/u);
  assert.match(guide, /unknown `schema_version`/u);
  assert.match(apiGuide, /omitted result view returns the compact derived representation/u);
  assert.match(apiGuide, /\?view=evidence/u);
  assert.match(apiGuide, /result envelope guide/u);
});
