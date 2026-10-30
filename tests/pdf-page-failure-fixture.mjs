// Synthetic two-page PDF: optional textless first page, unique text on page two.
export function makePageFailurePdf({ textlessFirst = true } = {}) {
  const content = [textlessFirst ? '0 0 1 rg 20 20 100 100 re f'
    : 'BT /F1 18 Tf 30 300 Td (FIRST PAGE ONLY sentence.) Tj ET',
    'BT /F1 18 Tf 30 300 Td (SECOND PAGE ONLY sentence.) Tj ET'];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    ...[6, 7].map(n => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents ${n} 0 R >>`),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...content.map(text => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`)];
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}` +
    `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
