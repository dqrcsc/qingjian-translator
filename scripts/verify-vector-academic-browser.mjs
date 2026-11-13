import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { makeAcademicPdfFixture } from '../tests/academic-pdf-fixture.mjs';

// Upload -> real PDF.js extraction -> background protocol -> DOM -> actual exports.
// Model responses only translate input text; they never supply layout or formulas.
export async function verifyVectorAcademicBrowser(context, sw) {
  const key = 'immersive_gemini_settings_v1';
  const saved = await sw.evaluate(key => chrome.storage.local.get(key), key);
  const checks = [], errors = [], requests = [], pages = [];
  const check = label => { checks.push(label); console.log(`  ✓ ${label}`); };
  const server = http.createServer(async (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const gemini = !!body.contents;
      const prompt = gemini ? body.contents[0].parts.map(p => p.text || '').join('') : body.messages.at(-1).content;
      assert.equal(typeof prompt, 'string');
      assert.ok(!JSON.stringify(body).includes('inlineData'), 'Rich vector pages must use text, not vision');
      const items = JSON.parse(prompt.split('Input JSON:\n')[1]);
      requests.push({ gemini, items });
      const translations = items.map(({ id, text }) => ({ id, translation: text.startsWith('|')
        ? text.replace('Method', '方法').replace('Score', '得分').replace('Cost', '成本').replace('Alpha', '甲').replace('Beta', '乙')
        : `译文：${text}` }));
      const result = JSON.stringify(translations);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(gemini ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: result }] } }] }
        : { choices: [{ message: { content: result } }] }));
    } catch (err) { errors.push(err.message); res.writeHead(400, cors); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const createPage = async () => {
    const p = await context.newPage(); pages.push(p); p.on('pageerror', e => errors.push(e.message));
    p.setDefaultTimeout(15000); await p.setViewportSize({ width: 1600, height: 1200 }); return p;
  };
  const assertContent = async page => {
    const table = page.locator('.paper-table-block .stream-trans table');
    assert.equal(await table.count(), 1);
    assert.deepEqual(await table.locator('tr').evaluateAll(rows => rows.map(r => [...r.cells].map(c => c.textContent.trim()))),
      [['方法', '得分', '成本'], ['甲', '12', '4'], ['乙', '24', '8']]);
    const xs = await table.locator('tr').evaluateAll(rows => rows.map(r => [...r.cells].map(c => c.getBoundingClientRect().x)));
    for (const row of xs.slice(1)) row.forEach((x,i) => assert.ok(Math.abs(x-xs[0][i])<1));
    const equation = page.locator('.paper-equation-block');
    assert.equal(await equation.count(), 1);
    assert.equal(await equation.locator('.math-frac').count(), 1);
    assert.equal(await equation.locator('.math-sqrt').count(), 1);
    assert.equal(await equation.locator('.math-eq-tag').textContent(), '(1)');
    assert.equal(await equation.locator('.math-num').evaluate(el => getComputedStyle(el).borderBottomWidth), '1px');
    assert.equal(await equation.locator('.math-sqrt-body').evaluate(el => getComputedStyle(el).borderTopWidth), '1px');
    assert.equal(await equation.locator('.math-den .math-sub').textContent(), 'k');
    const tail = page.locator('.paper-block .stream-trans').filter({ hasText: 'The final layer' });
    assert.equal(await tail.locator('.academic-sub').textContent(), 'model');
    assert.equal(await tail.locator('.academic-sub').evaluate(el => getComputedStyle(el).verticalAlign), 'sub');
    assert.match(await page.locator('.paper-sheet-body').textContent(), /After the table, this paragraph must remain visible/);
  };
  try {
    for (const protocol of ['openai', 'gemini']) {
      const offset = requests.length;
      await sw.evaluate(({ key, base, protocol }) => chrome.storage.local.set({ [key]: {
        providerId: 'custom', apiProtocol: protocol, apiBaseUrl: base + (protocol === 'gemini' ? '/v1beta' : '/v1'),
        apiKey: 'fixture', modelId: 'fixture-vector', targetLang: 'zh-CN', enableCache: false,
        enableFloatingBall: false, autoTranslateAllPages: false, maxConcurrency: 3
      } }), { key, base, protocol });
      const page = await createPage();
      await page.goto(`chrome-extension://${new URL(sw.url()).host}/studio/studio.html`);
      await page.locator('#fileInput').setInputFiles({ name: 'vector-academic.pdf', mimeType: 'application/pdf', buffer: makeAcademicPdfFixture() });
      await page.waitForFunction(() => document.querySelector('#workspaceSplitMain').dataset.documentState === 'ready');
      await page.locator('#startTranslateDocBtn').click();
      await page.waitForFunction(() => document.querySelector('#progressCounterBadge').textContent === '1 / 1 页');
      await assertContent(page);
      const batchItems = requests.slice(offset).flatMap(r => r.items);
      assert.ok(batchItems.some(i => i.text.startsWith('| Method | Score | Cost |')), 'Table must already be structured before the model');
      assert.ok(batchItems.every(i => !i.text.includes('softmax')), 'Extracted equations must remain local, not be rewritten by the model');
      assert.ok(requests.slice(offset).every(r => r.gemini === (protocol === 'gemini')));
      check(`Real vector PDF through ${protocol}: coordinates reconstruct fraction, radical, subscript, equation tag and table before model translation; paragraph tails survive`);

      const callCount = requests.length;
      await page.locator('#viewModeSelect').selectOption('translation-full-width');
      await assertContent(page);
      assert.equal(await page.locator('.paper-table-block .stream-orig').isVisible(), false);
      await page.locator('#viewModeSelect').selectOption('bilingual');
      assert.equal(requests.length, callCount);
      const download = page.waitForEvent('download');
      await page.locator('#exportMenuBtn').click(); await page.locator('[data-export="html"]').click();
      const html = await fs.readFile(await (await download).path(), 'utf8');
      const exported = await createPage(); await exported.setContent(html);
      await assertContent(exported);
      await exported.locator('.toggle-label').click(); await assertContent(exported);
      assert.equal(await exported.locator('.paper-table-block .stream-orig').isVisible(), false);
      await exported.emulateMedia({ media: 'print' }); await assertContent(exported);
      check(`${protocol} actual HTML download retains table cell geometry, radical/fraction strokes, inline subscripts and translation-only mode in screen and print`);

      await page.evaluate(() => { window.__vectorPrint = 0; window.print = () => window.__vectorPrint++; });
      await page.locator('#exportMenuBtn').click(); await page.locator('[data-export="pdf-bilingual"]').click();
      await page.locator('input[name="pdfExportScope"][value="all"]').check();
      await page.emulateMedia({ media: 'print' });
      await page.locator('#confirmPdfExportBtn').evaluate(el => el.click());
      await page.waitForFunction(() => window.__vectorPrint === 1);
      await assertContent(page.locator('#documentPrintSnapshot'));
      const pdfBytes = await page.pdf({ format: 'A4', printBackground: true });
      assert.ok(pdfBytes.length > 1000); assert.equal(pdfBytes.subarray(0,5).toString(), '%PDF-');
      // Re-open the generated print PDF with the bundled worker and inspect its
      // actual pages, rather than treating a nonempty PDF file as success.
      const printedText = await page.evaluate(async bytes => {
        const { openPdfDocument } = await import('./pdf-engine.js');
        const { pdfDoc } = await openPdfDocument(new Uint8Array(bytes).buffer);
        try {
          const texts = [];
          for (let n=1;n<=pdfDoc.numPages;n++) {
            const p = await pdfDoc.getPage(n);
            texts.push((await p.getTextContent()).items.map(i => i.str).join(' '));
            p.cleanup();
          }
          return texts.join(' ');
        } finally { await pdfDoc.destroy(); }
      }, [...pdfBytes]);
      for (const value of ['Attention', 'Method', 'Score', 'Cost', 'Alpha', 'Beta', '12', '24', 'After the table']) {
        assert.ok(printedText.includes(value), `Printed PDF lost ${value}`);
      }
      const out = new URL('../dist/browser-verification/', import.meta.url);
      await fs.mkdir(out, { recursive: true });
      await fs.writeFile(new URL(`vector-academic-${protocol}.pdf`, out), pdfBytes);
      await fs.writeFile(new URL(`vector-academic-${protocol}.html`, out), html);
      await page.emulateMedia({ media: 'screen' });
      await page.locator('.paper-sheet-page').screenshot({ path: new URL(`vector-academic-${protocol}.png`, out).pathname });
      assert.equal(requests.length, callCount, 'Layout switches and exports must not retranslate completed pages');
      check(`${protocol} actual PDF export confirmation reaches print and generates a PDF with complete table/formula layout without extra translation requests`);
      await page.close();
    }
    assert.deepEqual(errors, []); return { checks, errors };
  } finally {
    for (const page of pages) if (!page.isClosed()) await page.close();
    await sw.evaluate(async ({ key, saved }) => {
      if (Object.hasOwn(saved, key)) await chrome.storage.local.set(saved); else await chrome.storage.local.remove(key);
    }, { key, saved });
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
