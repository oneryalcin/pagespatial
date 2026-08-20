/**
 * Gemini Flash page transcriber for the escalated tier (issue #2).
 *
 * Privacy boundary: this sends a rendered page image to a remote API. Per
 * docs/principles.md §5 it may only be used for pages carrying blocking
 * escalation reasons, and only in deployments where remote processing is
 * authorized. The deterministic local pipeline remains the default path.
 *
 * Measured basis (issue #2): ~92% gold-token recall on escalated pages vs
 * 4-37% for the deterministic witnesses; ~$0.006/page; 4.4s typical.
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
const DEFAULT_RESOLUTION = 'MEDIA_RESOLUTION_ULTRA_HIGH';
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetchImpl(endpoint, {
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
      signal: options.signal ?? null
    });
    if (!response.ok) {
      throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const payload = await response.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const text = payload.candidates?.[0]?.content?.parts?.at(-1)?.text;
    try {
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
          promptTokens: payload.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
          latencyMs: Date.now() - started
        }
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Unparseable model output after retry: ${String(lastError).slice(0, 200)}`);
}
