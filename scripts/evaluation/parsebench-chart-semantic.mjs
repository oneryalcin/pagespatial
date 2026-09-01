#!/usr/bin/env node
/** Bounded ParseBench chart treatment: Basic output plus Gemini chart rows. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

const MODEL = 'gemini-3.7-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const EXPECTED_DOCUMENTS = new Set([
  '05021ff2-en_p19',
  'ADL_Future_of_automotive_mobility_2024_1_p17',
  'US_Professional_Services_Partner_Compensation_Survey_2024_p11',
]);

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1];
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('GEMINI_API_KEY is required');
const basicDir = arg('--basic-dir');
const dataRoot = arg('--data-root');
const outputDir = arg('--output-dir');
const evidencePath = arg('--evidence');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const resultFiles = readdirSync(basicDir).filter((name) => name.endsWith('.result.json')).sort();
const stems = new Set(resultFiles.map((name) => name.replace(/\.result\.json$/u, '')));
if (resultFiles.length !== 3 || [...EXPECTED_DOCUMENTS].some((stem) => !stems.has(stem))) {
  throw new Error('The treatment requires exactly the three pinned ParseBench chart results');
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    charts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          relations: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                series: { type: 'STRING', nullable: true },
                category: { type: 'STRING' },
                value: { type: 'STRING' },
                unit: { type: 'STRING', nullable: true },
              },
              required: ['category', 'value'],
              propertyOrdering: ['series', 'category', 'value', 'unit'],
            },
          },
        },
        required: ['title', 'relations'],
        propertyOrdering: ['title', 'relations'],
      },
    },
  },
  required: ['charts'],
  propertyOrdering: ['charts'],
};

const PROMPT = `Read only the charts visible in this PDF page image. Transcribe every legible plotted data relation needed to reconstruct each chart.
Return the category or x-axis label, series or legend label, value exactly as printed or visually encoded, and unit when present.
For bars or points without printed data labels, estimate from the visible axis as accurately as possible. Preserve negative signs. Do not include prose numbers outside charts. Do not infer facts not visible in the chart. Return only the schema-constrained JSON.`;

function cleanCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll(/\s+/gu, ' ').trim();
}

function chartMarkdown(charts) {
  const sections = [];
  for (const chart of charts) {
    const rows = chart.relations ?? [];
    if (!rows.length) continue;
    sections.push(`#### ${cleanCell(chart.title) || 'Chart data'}`);
    sections.push('');
    sections.push('| Category | Series | Value | Unit |');
    sections.push('| --- | --- | ---: | --- |');
    for (const row of rows) {
      sections.push(`| ${cleanCell(row.category)} | ${cleanCell(row.series)} | ${cleanCell(row.value)} | ${cleanCell(row.unit)} |`);
    }
    sections.push('');
  }
  if (!sections.length) throw new Error('Gemini returned no chart relations');
  return `### Semantic chart transcription\n\n${sections.join('\n')}`;
}

async function transcribe(imageBytes) {
  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: 'image/png', data: imageBytes.toString('base64') }, mediaResolution: { level: 'media_resolution_high' } },
      { text: PROMPT },
    ] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 16384,
      temperature: 0,
    },
  };
  const started = performance.now();
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 240)}`);
  const payload = await response.json();
  const text = payload.candidates?.[0]?.content?.parts?.at(-1)?.text;
  if (!text) throw new Error('Gemini returned no JSON text');
  return { result: JSON.parse(text), usage: payload.usageMetadata ?? {}, latencyMs: Math.round(performance.now() - started) };
}

mkdirSync(join(outputDir, 'chart'), { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), 'pagespatial-parsebench-chart-'));
const evidence = {
  schema_version: 1,
  experiment: 'parsebench-chart-semantic-bounded',
  model: MODEL,
  corpus: 'ParseBench pinned test/chart cohort',
  documents: [],
};

try {
  for (const file of resultFiles) {
    const stem = file.replace(/\.result\.json$/u, '');
    const basicPath = join(basicDir, file);
    const basicBytes = readFileSync(basicPath);
    const record = JSON.parse(basicBytes);
    const pdfPath = join(dataRoot, 'docs', 'chart', `${stem}.pdf`);
    const renderStem = join(temporary, stem);
    execFileSync('pdftoppm', ['-png', '-singlefile', '-r', '180', pdfPath, renderStem], { stdio: 'ignore' });
    const imageBytes = readFileSync(`${renderStem}.png`);
    const treatment = await transcribe(imageBytes);
    const addition = chartMarkdown(treatment.result.charts);
    const page = record.output?.pages?.[0];
    if (!page || typeof page.markdown !== 'string') throw new Error(`${file}: missing Basic page Markdown`);
    page.markdown = `${page.markdown}\n\n${addition}`;
    for (const layoutPage of record.output.layout_pages ?? []) {
      if (typeof layoutPage.md === 'string') layoutPage.md = `${layoutPage.md}\n\n${addition}`;
      if (typeof layoutPage.text === 'string') layoutPage.text = `${layoutPage.text}\n\n${addition}`;
    }
    record.output.markdown = record.output.pages.map((item) => item.markdown).join('\n\n');
    record.pipeline_name = 'pagespatial_semantic_chart';
    record.output.pipeline_name = 'pagespatial_semantic_chart';
    record.latency_in_ms = Number(record.latency_in_ms ?? 0) + treatment.latencyMs;
    const outputBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    writeFileSync(join(outputDir, 'chart', file), outputBytes);
    evidence.documents.push({
      id: `chart/${stem}`,
      pdf_sha256: sha256(readFileSync(pdfPath)),
      basic_result_sha256: sha256(basicBytes),
      rendered_png_sha256: sha256(imageBytes),
      semantic_result_sha256: sha256(outputBytes),
      gemini_latency_ms: treatment.latencyMs,
      gemini_usage: treatment.usage,
      chart_count: treatment.result.charts.length,
      relation_count: treatment.result.charts.reduce((sum, chart) => sum + (chart.relations?.length ?? 0), 0),
    });
    console.log(JSON.stringify({ id: stem, latency_ms: treatment.latencyMs, relations: evidence.documents.at(-1).relation_count }));
  }
  evidence.basic_results_unchanged = resultFiles.every((file, index) =>
    sha256(readFileSync(join(basicDir, file))) === evidence.documents[index].basic_result_sha256);
  evidence.completed_at = new Date().toISOString();
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
