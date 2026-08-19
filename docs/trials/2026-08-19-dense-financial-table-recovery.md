# Dense financial table recovery

Date: 2026-08-19

Decision: the previously reported 47.54% critical-token recall is rejected. It measured PDF text-run segmentation, not preservation of the visible financial values.

## Source and configuration

- Source SHA-256: `83b9fbe416413cbbf134f302a3a1cf76c2f98b3acbb69afa173ef1374d29fb9c`
- Page: 30 of the Sygnus 2025 annual report
- PDF Inspector: 1.14.2
- PDF.js: 5.5.207
- OCR: PP-OCRv6 Tiny, WebGPU, render scale 1.6
- Page OCR inference: 3,494 ms
- OCR table-region observations: 61
- OCR table-region mean confidence: 0.9897; minimum confidence: 0.8956

## Result

The visible table contains 39 independently transcribed critical header and numeric tokens.

| Evidence source | Exact critical values | Recall |
| --- | ---: | ---: |
| PDF Inspector positioned text | 39 / 39 | 100% |
| PP-OCRv6 Tiny | 39 / 39 | 100% |
| Source-preserving union | 39 / 39 | 100% |

PDF Inspector also produced a Markdown table containing all 39 values. Its structure was not perfect: it attached the `Other Assets:` section label to the preceding investments row and combined an unlabeled total into that row. Raw positioned observations and PP-OCR geometry preserve the separate evidence, but the inferred row relationships remain derived and require their own gold evaluation.

After same-line fragment reconstruction, PDF.js and PDF Inspector also agree on all 45 critical tokens across the complete page: 45 / 45 precision and 45 / 45 recall. This replaces the invalid comparison of 61 PDF.js run fragments with 45 complete visible tokens.

## Why the old score failed

PDF.js returned some single visible values as several adjacent font runs. Examples:

```text
27 + , + 148,453  -> 27,148,453
147 + ,366,013    -> 147,366,013
31,511, + 163     -> 31,511,163
```

The old evaluator tokenized each PDF.js run independently, then compared those fragments with the correctly reconstructed Inspector value. That made a better reconstruction appear missing and produced the false 47.54% result.

## Evaluator correction

Critical-token evaluation must:

1. join adjacent, same-line numeric fragments before tokenization;
2. normalize thousands separators, Unicode minus signs, and accounting negatives without discarding currency, percentage, unit, or sign semantics;
3. score against independent visible-cell gold labels, not another parser's run boundaries;
4. measure table row, column, header, and spanning-cell relationships separately from value preservation.

This result validates recovery on one page only. It does not replace the sealed multi-document corpus required by the production rubric.
