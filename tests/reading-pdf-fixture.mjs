import { makePdfFixture } from './pdf-fixture.mjs';

// Add a third page through a valid incremental PDF update. The original two
// fixture pages keep their rotated text, vector drawing and bundled image test.
export function makeThreePageReadingPdf() {
  const original = makePdfFixture();
  const previousXref = Number(original.toString('latin1').match(/startxref\s+(\d+)\s+%%EOF/)?.[1]);
  const content = 'BT /F1 16 Tf 25 340 Td (Third lazy page must be freshly translated.) Tj ET';
  const objects = [
    [2, '<< /Type /Pages /Kids [3 0 R 4 0 R 9 0 R] /Count 3 >>'],
    [9, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 10 0 R >>'],
    [10, `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`]
  ];
  const parts = [original], offsets = [];
  let size = original.length;
  for (const [id, body] of objects) {
    offsets.push(size);
    const bytes = Buffer.from(`${id} 0 obj\n${body}\nendobj\n`);
    parts.push(bytes); size += bytes.length;
  }
  const entry = offset => `${String(offset).padStart(10, '0')} 00000 n \n`;
  parts.push(Buffer.from(`xref\n2 1\n${entry(offsets[0])}9 2\n${entry(offsets[1])}${entry(offsets[2])}` +
    `trailer\n<< /Size 11 /Root 1 0 R /Prev ${previousXref} >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(parts);
}
