import assert from 'node:assert/strict';

function largePagePdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10000 10000] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const text = 'BT /F1 200 Tf 500 9000 Td (Large PDF page) Tj ET\n0.2 0.4 0.6 rg 500 1000 1000 1000 re f';
  objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  let output = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((value,index) => { offsets.push(Buffer.byteLength(output)); output += `${index+1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

export async function verifyPdfRenderBudgetBrowser(context, sw) {
  const checks = [], errors = [], page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  const check = text => { checks.push(text); console.log(`  ✓ ${text}`); };
  try {
    await page.goto(`chrome-extension://${new URL(sw.url()).host}/studio/studio.html`);
    await page.locator('#fileInput').setInputFiles({ name: 'large-page.pdf', mimeType: 'application/pdf', buffer: largePagePdf() });
    await page.waitForFunction(() => document.querySelector('#workspaceSplitMain').dataset.documentState === 'ready');
    const image = page.locator('[data-left-pdf-page="1"] img');
    await image.waitFor();
    const size = await image.evaluate(async img => { await img.decode(); return { width: img.naturalWidth, height: img.naturalHeight }; });
    assert.ok(size.width <= 4096 && size.height <= 4096 && size.width * size.height <= 4*1024*1024);
    check('Actual large MediaBox PDF file import renders within pixel/edge budget instead of allocating a 20000px canvas');
    const result = await page.evaluate(async bytes => {
      const { openPdfDocument, renderPdfPageToCanvas } = await import('./pdf-engine.js');
      const opened = await openPdfDocument(new Uint8Array(bytes).buffer);
      try {
        const rendered = await renderPdfPageToCanvas(opened.pdfDoc, 1);
        const info = { text: rendered.textItems.map(t => t.str).join(' '), width: rendered.width, valid: rendered.textItems.every(t => t.x >= 0 && t.right <= rendered.width && t.top >= 0 && t.bottom <= rendered.height) };
        rendered.canvas.width = rendered.canvas.height = 0;
        const controller = new AbortController();
        const task = renderPdfPageToCanvas(opened.pdfDoc, 1, 2, { signal: controller.signal }); controller.abort();
        try { await task; info.cancelled = false; } catch(e) { info.cancelled = e.name === 'AbortError'; }
        // Allow cancelled acquisition to finish before subsequent work.
        await opened.pdfDoc.getPage(1);
        const next = await renderPdfPageToCanvas(opened.pdfDoc, 1);
        info.nextRendered = next.width > 0;
        next.canvas.width = next.canvas.height = 0;
        return info;
      } finally { await opened.pdfDoc.destroy(); }
    }, Array.from(largePagePdf()));
    assert.match(result.text, /Large PDF page/); assert.equal(result.valid,true); assert.equal(result.cancelled,true); assert.equal(result.nextRendered,true);
    check('Bundled PDF.js stream text coordinates follow clamped scale; abort permits subsequent bounded rendering');
    assert.deepEqual(errors, []); return { checks, errors };
  } finally { await page.close(); }
}
