# Escalation economics: the tiered response ladder

**Date:** 2026-08-20 · **Branch:** `escalation-economics` · **Issue:** #17

## The constraint

Owner requirement: escalated-tier spend (~$0.009/corpus page amortized at
the dev corpus's 65% blocking rate) must fall ~10× for production. Two
levers: escalate less, and answer each escalation with the cheapest
sufficient tool. This trial measures the second lever; the first
(blocking-rate precision) is gold-gated work (#1/#5).

## What was measured before anything was built

**A. Resolution follows the task.** Full-page *transcription* on all 20
gold blocking pages: HIGH scored 409/440 vs ultra_high's 402/440 at ~23%
lower cost — ultra_high does not earn its tokens when the output is page
text. Transcription default flipped to HIGH (provenance records it).

**B/C/D. Adjudication shape**, against the 46 human-adjudicated gold
conflicts:

| mode | accuracy | wrong-side picks | $/page (5.8 conflicts) |
|---|---|---|---|
| per-crop, HIGH | 43/46 | 0 | $0.0060 |
| page-batched, HIGH | 41/46 | **4 — disqualifying** | $0.0015 |
| **page-batched, ULTRA_HIGH** | **45/46** | **0** | **$0.0023** |

The failure polarity is the decision criterion, not raw accuracy: a
"both-wrong" miss keeps the conflict flagged (free under
escalate-don't-vote); a wrong-side pick blesses a wrong value (the one
failure this project exists to prevent). Adjudication keeps ultra_high —
judging fine print needs the pixels; emitting big text does not.

## The ladder (as shipped)

- **Conflict/omission pages** → one page-batched adjudication call: every
  disputed region judged in a single request. Verdicts land in the
  enrichment revision record (`enrichment-0.2.0`,
  `adjudications: [{conflictId, verdict, inkText?}]`), each bound
  fail-closed to a conflict recorded on the base page — a verdict on a
  nonexistent conflict is fabricated evidence and is rejected. Verdicts
  are model opinion, never resolution: the conflict stays on the
  canonical page.
- **Starved/residue pages** → full-page transcription at HIGH.
- A page carrying both reason kinds gets both calls; telemetry sums.

## Measured end-to-end (dev-v11, 106 blocking pages, 0 failures)

| | full-page v1 | ladder |
|---|---|---|
| total spend | $1.51 | **$0.58 (2.6×)** |
| per corpus page (162) | $0.0093 | **$0.0036** |
| gold∩blocking union recall | 440/440 | **440/440** |
| latency p50 / p95 | 6.9s / 44s | **3.3s / 13.4s** |

81 pages adjudicated (470 verdicts: 132 native, 295 ocr, 43 both-wrong),
25 transcribed. With the Gemini batch API's standard 50% (enrichment is
async by design, so batch costs nothing in UX): **~$0.0018/corpus page —
5.2× down**.

## Remaining path to 10×

1. **Starved-scan tier is now 40% of spend** (27 pages × $0.0085). These
   are single-witness by fact (no text layer); the candidate $0 rung is a
   second local OCR read as a mechanical corroborator before any model
   call.
2. **Blocking-rate precision** (#5 conflict triage, gold-gated on #1):
   every point of the 65% recovered multiplies everything above.
3. Batch API integration (mechanical, ×2, unimplemented — numbers above
   show it as projection, everything else is measured).

On a typical born-digital mix (5–20% blocking instead of 65%), today's
shipped ladder already lands at **$0.0003–0.0011/corpus page**.
