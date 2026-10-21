
// Original synthetic fixture: standard font, two columns, rotation, vector graphics
// and a lossless JPEG2000 RGB raster (exercises the bundled OpenJPEG decoder). No third-party document or sensitive content.
export function makePdfFixture() {
  const objects = [];
  const add = text => objects.push(Buffer.isBuffer(text) ? text : Buffer.from(text));
  const stream = (dict, bytes) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from('\nendstream')]);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>');
  add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 8 0 R >> >> /Contents 6 0 R >>');
  add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Rotate 90 /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  add(stream('', Buffer.from('BT /F1 14 Tf 20 360 Td (Left column) Tj 150 0 Td (Right column) Tj ET\n1 0 0 rg 20 220 80 60 re f\nq 80 0 0 80 150 100 cm /Im1 Do Q')));
  add(stream('', Buffer.from('BT /F1 18 Tf 30 300 Td (Rotated page) Tj ET\n0 0 1 rg 20 80 100 100 re f')));
  add(stream('/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode', Buffer.from('AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAAAgAAAAIAAwcHAAAAAAAPY29scgEAAAAAABAAAACkanAyY/9P/1EALwAAAAAAAgAAAAIAAAAAAAAAAAAAAAIAAAACAAAAAAAAAAAAAwcBAQcBAQcBAf9SAAwAAAABAAEEBAAB/1wAB0BASEhQ/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS40/5AACgAAAAAAKQAB/5OAgM+0BAen4AIAk/MCAN/PwAY+0Bj8AEAECQn/2Q==', 'base64')));
  const parts = [Buffer.from('%PDF-1.7\n')], offsets = [0];
  let size = parts[0].length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(size);
    const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), objects[i], Buffer.from('\nendobj\n')]);
    parts.push(part); size += part.length;
  }
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(x => `${String(x).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(parts);
}
