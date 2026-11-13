// Original, deterministic multi-page text PDF for real entry/window/export checks.
export function makeLongPdfFixture(count) {
  const objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Count ${count} /Kids [${Array.from({length:count},(_,i)=>`${i+3} 0 R`).join(' ')}] >>`];
  const font=count+3;
  for(let i=0;i<count;i++) objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${font+1+i} 0 R >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for(let i=0;i<count;i++) {
    const text=Array.from({length:14},(_,j)=>`BT /F1 11 Tf 1 0 0 1 50 ${740-j*22} Tm (PageSentinel${i+1} Scientific prose preserves original page content and paragraph ordering.) Tj ET`).join('\n');
    objects.push(`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`);
  }
  const parts=[Buffer.from('%PDF-1.7\n')],offsets=[0];let size=parts[0].length;
  for(let i=0;i<objects.length;i++){offsets.push(size);const b=Buffer.from(`${i+1} 0 obj\n${objects[i]}\nendobj\n`);parts.push(b);size+=b.length;}
  parts.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));return Buffer.concat(parts);
}
