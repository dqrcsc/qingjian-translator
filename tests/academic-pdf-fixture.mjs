// Original vector PDF. Real PDF.js glyph coordinates exercise extraction before
// translation; the mock model must not manufacture formulas or table structure.
export function makeAcademicPdfFixture({ blankScore = false, rasterJpeg = null } = {}) {
  const ops = [];
  const text = (x, y, value, size = 10, font = 'F1') => {
    const escaped = value.replace(/[\\()]/g, '\\$&');
    ops.push(`BT /${font} ${size} Tf 1 0 0 1 ${x} ${800-y} Tm (${escaped}) Tj ET`);
  };
  text(70, 65, 'Vector academic regression', 16);
  for (let i=0;i<(rasterJpeg ? 12 : 5);i++) {
    text(70, 105+i*(rasterJpeg ? 10 : 16), 'This paragraph preserves the original scientific context and the reading order of this page.');
  }
  if (!rasterJpeg) {
    text(70, 195, 'The final layer produces outputs of dimension ');
    text(275,195,'d'); text(281,197,'model',7);text(303,195,' = 512.');
    text(150,260,'Attention(Q, K, V) = softmax(');
    text(284,253,'QK');text(298,249,'T',7);
    text(284,259,'Ö',10,'F2'); // Adobe Symbol 0xD6 = radical, top-hung baseline
    text(292,267,'d');text(298,269,'k',7);
    text(309,260,')V');text(515,260,'(1)');
    ops.push('283 540 m 306 540 l S');
  }
  if (rasterJpeg) {
    ops.push('q 300 0 0 130 100 320 cm /Im1 Do Q');
    text(100,510,'Figure 1: Raster chart with English labels.');
    text(70,600,'After the figure, this paragraph must remain visible.');
  } else {
    text(180,325,'Table 1: Comparison of methods.');
    const cells = [['Method','Score','Cost'],['Alpha',blankScore ? '' : '12','4'],['Beta','24','8']];
    for(let r=0;r<cells.length;r++)cells[r].forEach((v,c)=>text([90,270,440][c],365+r*24,v));
    text(70,485,'After the table, this paragraph must remain visible and must not become a table row.');
  }
  const content=Buffer.from(ops.join('\n'),'latin1');
  const objects=[
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> ${rasterJpeg ? '/XObject << /Im1 7 0 R >>' : ''} >> /Contents 6 0 R >>`),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>'),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`),content,Buffer.from('\nendstream')])
  ];
  if (rasterJpeg) objects.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 600 /Height 260 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${rasterJpeg.length} >>\nstream\n`),rasterJpeg,Buffer.from('\nendstream')]));
  const parts=[Buffer.from('%PDF-1.7\n')], offsets=[0];let size=parts[0].length;
  objects.forEach((obj,i)=>{offsets.push(size);const part=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),obj,Buffer.from('\nendobj\n')]);parts.push(part);size+=part.length;});
  parts.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(parts);
}
