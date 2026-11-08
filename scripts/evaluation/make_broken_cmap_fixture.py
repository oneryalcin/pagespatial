"""Broken-CMap prose fixture: clean.pdf and broken.pdf render identical pixels, but
broken.pdf's body font ToUnicode
CMap swaps 'e' <-> 'o' (renders right, extracts wrong). Digit lines use a second,
intact font. Trial: docs/trials/2026-11-07-broken-cmap-prose-fixture.md

  uv run --with reportlab --with pikepdf python scripts/evaluation/make_broken_cmap_fixture.py OUT_DIR [HEX_A HEX_B]
(macOS font paths; adjust TTF paths elsewhere.)"""
import re, sys
from pathlib import Path
import pikepdf
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

out = Path(sys.argv[1])
# Optional: two hex code points to swap (default e<->o); e.g. "0076 0079" swaps v<->y.
A, B = (sys.argv[2], sys.argv[3]) if len(sys.argv) > 3 else ("0065", "006F")
out.mkdir(parents=True, exist_ok=True)
pdfmetrics.registerFont(TTFont("Body", "/System/Library/Fonts/Supplemental/Arial.ttf"))
pdfmetrics.registerFont(TTFont("Nums", "/System/Library/Fonts/Supplemental/Courier New.ttf"))
lines = [
    "The committee reviewed the proposal before the general meeting.",
    "Revenue recognition follows the delivery of goods to customers.",
    "Operating expenses were monitored throughout the reporting period.",
    "Management believes the controls over reporting are effective.",
    "These statements should be read together with the annual report.",
    "No other events occurred after the end of the reporting period.",
]
c = canvas.Canvas(str(out / "clean.pdf"), pagesize=letter)
y = 720
for i, line in enumerate(lines * 3):
    c.setFont("Body", 12); c.drawString(72, y, line); y -= 22
    if i % 3 == 2:
        c.setFont("Nums", 12); c.drawString(72, y, f"Total for item {i}: $ {1250 + 37 * i:,}.00"); y -= 22
c.save()

pdf = pikepdf.open(out / "clean.pdf")
swapped = 0
for page in pdf.pages:
    for name, font in page.Resources.Font.items():
        base = str(font.get("/BaseFont", ""))
        if "Arial" not in base and "Body" not in base:
            continue
        tu = font.ToUnicode
        data = tu.read_bytes().decode("latin-1")
        # bfchar entries: <gid> <unicode>; swap e (0065) and o (006F)
        data2, n = re.subn(rf"<{A}>|<{B}>",
                           lambda m: {f"<{A}>": f"<{B}>", f"<{B}>": f"<{A}>"}[m.group(0)], data)
        swapped += n
        tu.write(data2.encode("latin-1"))
pdf.save(out / "broken.pdf")
print("swapped CMap entries:", swapped)
