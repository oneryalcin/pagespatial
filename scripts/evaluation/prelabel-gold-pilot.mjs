/**
 * Machine pre-labeling for the P0 gold pilot.
 *
 * Proposes gold labels (critical tokens with boxes, chart relations) and
 * conflict adjudications for a stratified page sample, using Gemini as a
 * vision pre-annotator. Output is a PROPOSAL, not gold: every item must be
 * verified by a human in the generated review.html before it becomes a label.
 *
 * Privacy: sends rendered page images of the private corpus to the Gemini
 * API. Run only with explicit authorization from the corpus owner.
 *
 * Usage:
 *   GEMINI_API_KEY=... node scripts/evaluation/prelabel-gold-pilot.mjs \
 *     --sample <pilot-sample.json> \
 *     --run-root .evaluation/runs/<run-id> \
 *     --output .evaluation/gold/<pilot-id>
 *
 * The sample file is an array of entries:
 *   { objectId, path, sha256, pageNumber, labels[], escalated, image }
 * where image is a rendered PNG of that page.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MODEL = 'gemini-3.7-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument ${name}`);
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('GEMINI_API_KEY is required.');

const samplePath = arg('--sample');
const runRoot = arg('--run-root');
const outputDir = arg('--output');
mkdirSync(outputDir, { recursive: true });

const sample = JSON.parse(readFileSync(samplePath, 'utf8'));

// Index dev-run page records by (objectId, pageNumber) for conflict lookup.
const recordIndex = new Map();
const documentsRoot = join(runRoot, 'documents');
for (const doc of readdirSync(documentsRoot)) {
  let pages;
  try { pages = readdirSync(join(documentsRoot, doc, 'pages')); } catch { continue; }
  for (const file of pages) {
    const path = join(documentsRoot, doc, 'pages', file);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (record.pageSpatial) recordIndex.set(`${record.objectId}#${record.pageNumber}`, record);
  }
}

function parseModelJson(text) {
  const stripped = text.trim().replace(/^```(?:json)?\s*/u, '').replace(/```\s*$/u, '');
  return JSON.parse(stripped);
}

async function gemini(parts, level, schema, attempt = 0) {
  const body = {
    contents: [{ parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens: 32768 }
  };
  // ultra_high is only accepted per content item, so resolution always rides
  // on the image part rather than generationConfig.
  for (const part of parts) {
    if (part.inline_data) part.mediaResolution = { level };
  }
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const payload = await response.json();
  const text = payload.candidates?.[0]?.content?.parts?.at(-1)?.text;
  try {
    if (!text) throw new Error('Gemini returned no text part.');
    return { result: parseModelJson(text), usage: payload.usageMetadata };
  } catch (error) {
    if (attempt >= 1) throw new Error(`Unparseable model output after retry: ${String(error).slice(0, 200)}`);
    console.warn('  retrying page: model output was not valid JSON');
    return gemini(parts, level, schema, attempt + 1);
  }
}

// Response schemas are enforced by the API, not requested in prose. A dense
// repetitive page (200-row procurement tables) makes the model drift mid-array
// and emit a doubled key — `"label": "text": "0.00"` — which is unparseable;
// one page failed ~50% of attempts, and one degenerate run burned the entire
// 32k output cap to produce four characters. Retrying cannot fix a systematic
// drift, and repairing the JSON by hand would be worse: this output is an
// answer key, and a salvaged token is a token nobody read off the page.
const LABEL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    criticalTokens: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        // minItems/maxItems are not decoration: a schema that pins the item
        // type but not the arity still returns [763, 122] where four
        // coordinates were meant, and a two-number box locates nothing.
        properties: {
          text: { type: 'STRING' },
          box_2d: { type: 'ARRAY', items: { type: 'INTEGER' }, minItems: 4, maxItems: 4 }
        },
        required: ['text', 'box_2d'],
        propertyOrdering: ['text', 'box_2d']
      }
    },
    chartRelations: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          series: { type: 'STRING', nullable: true },
          category: { type: 'STRING' },
          value: { type: 'STRING' },
          unit: { type: 'STRING', nullable: true }
        },
        required: ['category', 'value'],
        propertyOrdering: ['series', 'category', 'value', 'unit']
      }
    },
    hasTable: { type: 'BOOLEAN' },
    notes: { type: 'STRING' }
  },
  required: ['criticalTokens', 'chartRelations', 'hasTable', 'notes'],
  propertyOrdering: ['criticalTokens', 'chartRelations', 'hasTable', 'notes']
};

const ADJUDICATION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    verdicts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          index: { type: 'INTEGER' },
          verdict: { type: 'STRING', enum: ['native', 'ocr', 'both-wrong', 'different-regions', 'unsure'] },
          inkText: { type: 'STRING' },
          reason: { type: 'STRING' }
        },
        required: ['index', 'verdict', 'inkText'],
        propertyOrdering: ['index', 'verdict', 'inkText', 'reason']
      }
    }
  },
  required: ['verdicts'],
  propertyOrdering: ['verdicts']
};

const LABEL_PROMPT = `You are pre-labeling a PDF page image for a gold evaluation dataset. Return STRICT JSON:
{
 "criticalTokens": [{"text": "<verbatim as printed: numbers, amounts, percentages, years, dates, including attached currency symbols and unit words>", "box_2d": [ymin, xmin, ymax, xmax]}],
 "chartRelations": [{"series": "<series name or null>", "category": "<category/x label>", "value": "<verbatim value>", "unit": "<unit or null>"}],
 "hasTable": true or false,
 "notes": "<1-2 sentences a human verifier should know about this page>"
}
Rules: transcribe EXACTLY what is printed — keep commas, periods, currency symbols, signs and unit words verbatim; never normalize or convert. box_2d is normalized 0-1000 as [ymin, xmin, ymax, xmax]. Include every visible number on the page, including ones inside charts and images. chartRelations only when an actual chart is present.
Page furniture is not content: skip a number if removing it would not change what the text asserts — margin line numbers beside a paragraph, page numbers in a running header or footer, standalone footnote markers. Keep a number if removing it changes the claim: "5 months of transportation" keeps its 5, and numbered table columns (procurement line items, ranked rows) are data, not furniture. When in doubt, include it — a human verifier can delete a token, but cannot recover one you never proposed.`;

function adjudicationPrompt(conflicts) {
  return `Two PDF extractors disagree about text on this page. For each numbered disagreement, look at the page image at the given region (box normalized 0-1000, [ymin, xmin, ymax, xmax]) and judge which reading matches the printed ink. Return STRICT JSON:
{"verdicts": [{"index": <n>, "verdict": "native" | "ocr" | "both-wrong" | "different-regions" | "unsure", "inkText": "<what is actually printed, verbatim>", "reason": "<short>"}]}

Disagreements:
${conflicts.map((conflict, index) => `${index}. box ${JSON.stringify(conflict.normalizedBox)}
   native reads: ${JSON.stringify(conflict.nativeText)}
   ocr reads:    ${JSON.stringify(conflict.ocrText)}`).join('\n')}`;
}

const proposalsPath = join(outputDir, 'proposals.json');
let proposals = [];
try { proposals = JSON.parse(readFileSync(proposalsPath, 'utf8')); } catch { /* fresh run */ }
const done = new Set(proposals.map((page) => `${page.objectId}#${page.pageNumber}`));
let totalPromptTokens = 0;
let totalOutputTokens = 0;

for (const [index, page] of sample.entries()) {
  if (done.has(`${page.objectId}#${page.pageNumber}`)) {
    console.log(`[${index + 1}/${sample.length}] ${page.objectId} p${page.pageNumber}: already done, skipping`);
    continue;
  }
  const imageBase64 = readFileSync(page.image).toString('base64');
  const imagePart = { inline_data: { mime_type: 'image/png', data: imageBase64 } };
  const resolution = page.labels.includes('dense-table')
    ? 'MEDIA_RESOLUTION_ULTRA_HIGH'
    : 'MEDIA_RESOLUTION_HIGH';

  const label = await gemini([structuredClone(imagePart), { text: LABEL_PROMPT }], resolution, LABEL_SCHEMA);
  totalPromptTokens += label.usage?.promptTokenCount ?? 0;
  totalOutputTokens += label.usage?.candidatesTokenCount ?? 0;

  const record = recordIndex.get(`${page.objectId}#${page.pageNumber}`);
  const geometry = record?.pageSpatial?.geometry;
  const conflicts = (record?.pageSpatial?.conflicts ?? []).map((conflict) => {
    const box = record.pageSpatial.ocrObservations.find((observation) => observation.id === conflict.ocrId)?.box;
    return {
      id: conflict.id,
      nativeText: conflict.nativeText,
      ocrText: conflict.ocrText,
      reason: conflict.reason,
      // No fabricated [0,0,0,0] region: without a real box the adjudicator
      // sees null and must locate the text itself.
      normalizedBox: geometry && box
        ? [
            Math.round(box[1] / geometry.height * 1000),
            Math.round(box[0] / geometry.width * 1000),
            Math.round(box[3] / geometry.height * 1000),
            Math.round(box[2] / geometry.width * 1000)
          ]
        : null
    };
  });

  let adjudication = null;
  if (conflicts.length) {
    const response = await gemini(
      [structuredClone(imagePart), { text: adjudicationPrompt(conflicts) }],
      'MEDIA_RESOLUTION_ULTRA_HIGH',
      ADJUDICATION_SCHEMA
    );
    totalPromptTokens += response.usage?.promptTokenCount ?? 0;
    totalOutputTokens += response.usage?.candidatesTokenCount ?? 0;
    adjudication = conflicts.map((conflict, conflictIndex) => ({
      ...conflict,
      proposal: response.result.verdicts?.find((verdict) => verdict.index === conflictIndex) ?? null
    }));
  }

  proposals.push({
    goldProposalSchemaVersion: 'gold-proposal-v1',
    objectId: page.objectId,
    sha256: page.sha256,
    pageNumber: page.pageNumber,
    labels: page.labels,
    escalatedInRun: page.escalated,
    image: page.image,
    mediaResolution: resolution,
    proposal: label.result,
    conflictAdjudications: adjudication,
    provenance: { model: MODEL, createdAt: new Date().toISOString(), runRoot }
  });
  writeFileSync(proposalsPath, JSON.stringify(proposals, null, 1));
  console.log(`[${index + 1}/${sample.length}] ${page.objectId} p${page.pageNumber}: ` +
    `${label.result.criticalTokens?.length ?? 0} tokens, ${conflicts.length} conflicts adjudicated`);
}

console.log(`Wrote ${proposals.length} page proposals. Tokens: ${totalPromptTokens} in / ${totalOutputTokens} out.`);
