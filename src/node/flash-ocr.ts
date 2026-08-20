/**
 * Gemini Flash page transcriber for the escalated tier (issue #2).
 *
 * Privacy boundary: this sends a rendered page image to a remote API. Per
 * docs/principles.md §5 it may only be used for pages carrying blocking
 * escalation reasons, and only in deployments where remote processing is
 * authorized. The deterministic local pipeline remains the default path.
 *
 * Measured basis (dev-v11 blocking pages, 2026-08-20 trial doc): union
 * gold recall on gold-blocking pages 437/440 -> 440/440; ~$0.011/page on
 * this dense-page tier; p50 6.9s, p95 44s. Async by design — never on the
 * time-to-searchable critical path.
 */

export interface FlashTranscriptionOptions {
  apiKey: string;
  /** PNG bytes of the rendered page. */
  png: Uint8Array;
  model?: string;
  /** Per-image media resolution level. */
  mediaResolution?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface FlashTranscription {
  proposals: { text: string; modelBoxHint?: [number, number, number, number] }[];
  provenance: { adapter: string; model: string; mediaResolution: string; promptRevision: string; thinkingBudget: number };
  telemetry: { promptTokens: number; outputTokens: number; latencyMs: number };
}

const DEFAULT_MODEL = 'gemini-3.7-flash';
// Validated on all 20 gold blocking pages: HIGH matches ultra_high recall
// for full-page TRANSCRIPTION (409/440 vs 402/440) at ~23% lower cost.
// Adjudication (below) keeps ultra_high — judging fine print needs the
// pixels; emitting big text does not. Resolution follows the task.
const DEFAULT_RESOLUTION = 'MEDIA_RESOLUTION_HIGH';
const ADAPTER = 'flash-escalated-ocr@1';

/**
 * Prompt revision is part of provenance: a changed prompt is a changed
 * extractor, and its outputs are not comparable to earlier enrichments.
 */
const PROMPT_REVISION = 'transcribe-critical-tokens-v1';
const PROMPT = `You are transcribing a PDF page image so its printed values become searchable. Return STRICT JSON:
{
 "tokens": [{"text": "<verbatim as printed: numbers, amounts, percentages, years, dates, including attached currency symbols and unit words>", "box_2d": [ymin, xmin, ymax, xmax]}]
}
Rules: transcribe EXACTLY what is printed — keep commas, periods, currency symbols, signs and unit words verbatim; never normalize, convert, or translate. box_2d is normalized 0-1000 as [ymin, xmin, ymax, xmax]. Include every visible number on the page, including ones drawn inside charts, graphics, and images. Do not include prose sentences; only values and their attached units/labels.`;

export interface FlashAdjudicationOptions {
  apiKey: string;
  /** PNG bytes of the rendered page. */
  png: Uint8Array;
  /** Conflicts to adjudicate, boxes normalized 0-1000 [ymin, xmin, ymax, xmax]. */
  conflicts: readonly { conflictId: string; nativeText: string; ocrText: string; normalizedBox: [number, number, number, number] }[];
  model?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface FlashAdjudication {
  verdicts: { conflictId: string; verdict: 'native' | 'ocr' | 'both-wrong' | 'unsure'; inkText?: string }[];
  provenance: { adapter: string; model: string; mediaResolution: string; promptRevision: string; thinkingBudget: number };
  telemetry: { promptTokens: number; outputTokens: number; latencyMs: number };
}

const ADJUDICATION_PROMPT_REVISION = 'adjudicate-conflicts-page-v2';
/**
 * Adjudication keeps ULTRA_HIGH deliberately: measured on the 46
 * human-adjudicated gold conflicts, page-batched ultra_high scored 45/46
 * with ZERO wrong-side picks (the one miss was a conservative both-wrong),
 * while HIGH scored 41/46 with 4 wrong-side picks — the disqualifying
 * failure mode. Judging fine print needs the pixels.
 */
const ADJUDICATION_RESOLUTION = 'MEDIA_RESOLUTION_ULTRA_HIGH';

/**
 * Page-batched conflict adjudication: one call judges every disputed region
 * on the page (~$0.0023/page at 5.8 conflicts vs $0.011 for full-page
 * transcription). Verdicts are model opinion for the enrichment revision
 * record — they never resolve the recorded conflict, which stays on the
 * canonical page (escalate-don't-vote).
 */
export async function adjudicatePageConflicts(options: FlashAdjudicationOptions): Promise<FlashAdjudication> {
  if (!options.conflicts.length) throw new Error('adjudicatePageConflicts requires at least one conflict.');
  const model = options.model ?? DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const prompt = `Two PDF extractors disagree about text on this page. For each numbered disagreement, look at the page image at the given region (box normalized 0-1000, [ymin, xmin, ymax, xmax]) and judge which reading matches the printed ink. Return STRICT JSON {"verdicts": [{"index": <n>, "verdict": "native" | "ocr" | "both-wrong" | "unsure", "inkText": "<what is actually printed, verbatim>"}]}. Judge ONLY against the visible ink. If both readings mis-transcribe it, answer both-wrong; if the region is not clearly legible, answer unsure.

${options.conflicts
    .map((conflict, index) => `${index}. box ${JSON.stringify(conflict.normalizedBox)}
   native reads: ${JSON.stringify(conflict.nativeText)}
   ocr reads:    ${JSON.stringify(conflict.ocrText)}`)
    .join('\n')}`;
  const started = Date.now();
  let lastError: unknown;
  let promptTokens = 0;
  let outputTokens = 0;
  let retryAfterMs = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, Math.max(retryAfterMs, 1000 * 2 ** (attempt - 1))));
    retryAfterMs = 0;
    const attemptSignal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000);
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'x-goog-api-key': options.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: prompt },
            { inline_data: { mime_type: 'image/png', data: toBase64(options.png) }, mediaResolution: { level: ADJUDICATION_RESOLUTION } }
          ] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'object',
              properties: {
                verdicts: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      index: { type: 'integer' },
                      verdict: { type: 'string', enum: ['native', 'ocr', 'both-wrong', 'unsure'] },
                      inkText: { type: 'string' }
                    },
                    required: ['index', 'verdict']
                  }
                }
              },
              required: ['verdicts']
            },
            maxOutputTokens: 8192,
            thinkingConfig: { thinkingBudget: 0 }
          }
        }),
        signal: attemptSignal
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastError = error;
      continue;
    }
    if (!response.ok) {
      const detail = `Gemini ${response.status}: ${(await response.text()).slice(0, 300)}`;
      if ([429, 500, 502, 503, 504].includes(response.status)) {
        const retryAfter = Number(response.headers?.get?.('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) retryAfterMs = Math.min(retryAfter * 1000, 30_000);
        lastError = new Error(detail);
        continue;
      }
      throw new Error(detail);
    }
    try {
      const payload = await response.json() as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      promptTokens += payload.usageMetadata?.promptTokenCount ?? 0;
      outputTokens += payload.usageMetadata?.candidatesTokenCount ?? 0;
      const text = payload.candidates?.[0]?.content?.parts?.at(-1)?.text;
      if (!text) throw new Error('Gemini returned no text part.');
      const parsed = parseModelJson(text) as { verdicts?: { index?: unknown; verdict?: unknown; inkText?: unknown }[] };
      // Fail-closed response mapping: a conflict must have EXACTLY ONE
      // in-range verdict. Duplicates (even agreeing ones), unknown indexes,
      // and omissions all resolve to 'unsure' — ambiguity must never pick
      // a side, and a wrong-side pick is the disqualifying failure.
      const byIndex = new Map<number, { verdict?: unknown; inkText?: unknown }[]>();
      for (const item of parsed.verdicts ?? []) {
        if (typeof item.index !== 'number' || !Number.isInteger(item.index)) continue;
        if (item.index < 0 || item.index >= options.conflicts.length) continue;
        const list = byIndex.get(item.index) ?? [];
        list.push(item);
        byIndex.set(item.index, list);
      }
      const verdicts = options.conflicts.map((conflict, index) => {
        const answers = byIndex.get(index) ?? [];
        const match = answers.length === 1 ? answers[0] : undefined;
        const answered = typeof match?.verdict === 'string'
          && ['native', 'ocr', 'both-wrong', 'unsure'].includes(match.verdict);
        const verdict = answered
          ? match!.verdict as 'native' | 'ocr' | 'both-wrong' | 'unsure'
          : 'unsure';
        return {
          conflictId: conflict.conflictId,
          verdict,
          // 'unsure' the model actually said differs from 'unsure' we
          // defaulted to (declined/ambiguous/malformed answer): a run whose
          // adjudications silently collapsed must be visible in the record.
          ...(answered ? {} : { unanswered: true }),
          ...(verdict !== 'unsure' && typeof match?.inkText === 'string' && match.inkText.trim()
            ? { inkText: match.inkText.trim() }
            : {})
        };
      });
      return {
        verdicts,
        provenance: { adapter: ADAPTER, model, mediaResolution: ADJUDICATION_RESOLUTION, promptRevision: ADJUDICATION_PROMPT_REVISION, thinkingBudget: 0 },
        telemetry: { promptTokens, outputTokens, latencyMs: Date.now() - started }
      };
    } catch (error) {
      lastError = error;
    }
  }
  const failure = new Error(`Flash adjudication failed after retries: ${String(lastError).slice(0, 200)}`);
  (failure as Error & { telemetry?: object }).telemetry = { promptTokens, outputTokens, latencyMs: Date.now() - started };
  throw failure;
}

function parseModelJson(text: string): unknown {
  const stripped = text.trim().replace(/^```(?:json)?\s*/u, '').replace(/```\s*$/u, '');
  return JSON.parse(stripped);
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export async function transcribePageImage(options: FlashTranscriptionOptions): Promise<FlashTranscription> {
  const model = options.model ?? DEFAULT_MODEL;
  const resolution = options.mediaResolution ?? DEFAULT_RESOLUTION;
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const parts: Record<string, unknown>[] = [
    { text: PROMPT },
    {
      inline_data: { mime_type: 'image/png', data: toBase64(options.png) },
      // ultra_high is only accepted per content item, never globally.
      mediaResolution: { level: resolution }
    }
  ];
  const started = Date.now();
  let lastError: unknown;
  let promptTokens = 0;
  let outputTokens = 0;
  let retryAfterMs = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, Math.max(retryAfterMs, 1000 * 2 ** (attempt - 1))));
    retryAfterMs = 0;
    // Bounded per-attempt deadline: a stalled request must fail the
    // attempt, never hang the whole batch. Composes with the caller's
    // signal when provided.
    const attemptSignal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000);
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'x-goog-api-key': options.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseMimeType: 'application/json',
          // Constrained decoding: without a schema ~20% of dense pages came
          // back as malformed JSON (unescaped quotes inside transcriptions).
          responseSchema: {
            type: 'object',
            properties: {
              tokens: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    text: { type: 'string' },
                    box_2d: { type: 'array', items: { type: 'integer' } }
                  },
                  required: ['text']
                }
              }
            },
            required: ['tokens']
          },
          maxOutputTokens: 32_768,
          // Transcription needs eyes, not reasoning: thinking tokens bill
          // as output and add latency with no measured recall benefit.
          thinkingConfig: { thinkingBudget: 0 }
        }
      }),
        signal: attemptSignal
      });
    } catch (error) {
      // Network errors and per-attempt timeouts are transient; a caller
      // abort is terminal.
      if (options.signal?.aborted) throw error;
      lastError = error;
      continue;
    }
    // Transient statuses retry with backoff; anything else is terminal.
    if (!response.ok) {
      const detail = `Gemini ${response.status}: ${(await response.text()).slice(0, 300)}`;
      if ([429, 500, 502, 503, 504].includes(response.status)) {
        const retryAfter = Number(response.headers?.get?.('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) retryAfterMs = Math.min(retryAfter * 1000, 30_000);
        lastError = new Error(detail);
        continue;
      }
      throw new Error(detail);
    }
    try {
      const payload = await response.json() as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      // Cost telemetry accumulates across attempts: retried spend is real
      // spend, and §5 treats measured cost as a first-class metric.
      promptTokens += payload.usageMetadata?.promptTokenCount ?? 0;
      outputTokens += payload.usageMetadata?.candidatesTokenCount ?? 0;
      const text = payload.candidates?.[0]?.content?.parts?.at(-1)?.text;
      if (!text) throw new Error('Gemini returned no text part.');
      const parsed = parseModelJson(text) as { tokens?: { text?: unknown; box_2d?: unknown }[] };
      const proposals = (parsed.tokens ?? [])
        .filter((token) => typeof token.text === 'string' && token.text.trim().length > 0)
        .map((token) => ({
          text: (token.text as string).trim(),
          ...(Array.isArray(token.box_2d) && token.box_2d.length === 4 && token.box_2d.every((value) => Number.isFinite(value))
            ? { modelBoxHint: token.box_2d as [number, number, number, number] }
            : {})
        }));
      return {
        proposals,
        provenance: { adapter: ADAPTER, model, mediaResolution: resolution, promptRevision: PROMPT_REVISION, thinkingBudget: 0 },
        telemetry: {
          promptTokens,
          outputTokens,
          latencyMs: Date.now() - started
        }
      };
    } catch (error) {
      lastError = error;
    }
  }
  const failure = new Error(`Flash transcription failed after retries: ${String(lastError).slice(0, 200)}`);
  (failure as Error & { telemetry?: object }).telemetry = { promptTokens, outputTokens, latencyMs: Date.now() - started };
  throw failure;
}
