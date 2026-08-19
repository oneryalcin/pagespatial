import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export async function createBrowserSmokeFixture(rasterLabelPng) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const image = await pdf.embedPng(rasterLabelPng);
  page.drawText('Native heading: PageSpatial smoke fixture', {
    x: 60,
    y: 710,
    size: 18,
    font,
    color: rgb(0, 0, 0)
  });
  page.drawImage(image, { x: 60, y: 430, width: 480, height: 140 });
  return pdf.save();
}
