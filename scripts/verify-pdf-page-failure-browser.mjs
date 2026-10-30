import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { makePageFailurePdf } from '../tests/pdf-page-failure-fixture.mjs';

export async function verifyPdfPageFailureBrowser(context, sw) {
  const checks = [], errors = [], requests = [];
  const check = text => { checks.push(text); console.log(`  ✓ ${text}`); };
  let fail = false;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); res.end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const prompt = body.messages.at(-1).content; requests.push({ prompt, failed: fail });
    res.writeHead(fail ? 401 : 200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    if (fail) { res.end(JSON.stringify({ error: { message: 'synthetic invalid credential' } })); return; }
    const ids = [...prompt.matchAll(/"id"\s*:\s*(\d+)/g)].map(match => Number(match[1]));
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ids.map(id => ({ id, translation: `Recovered ${id}` }))) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  const upload = async (name, textlessFirst) => {
    await page.locator('#fileInput').setInputFiles({ name, mimeType: 'application/pdf', buffer: makePageFailurePdf({ textlessFirst }) });
    await page.waitForFunction(() => document.querySelector('#workspaceSplitMain').dataset.documentState === 'ready');
  };
  const waitIdle = () => page.waitForFunction(() => !document.querySelector('#startTranslateDocBtn').textContent.includes('暂停'));
  try {
    await sw.evaluate(value => chrome.storage.local.set({ immersive_gemini_settings_v1: value }), {
      providerId: 'custom', apiProtocol: 'openai', apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: 'fixture', modelId: 'fixture', targetLang: 'zh-CN', maxConcurrency: 1, enableCache: false,
      enableFloatingBall: false, autoTranslateAllPages: false, autoTranslatePageImages: false
    });
    await page.goto(`chrome-extension://${new URL(sw.url()).host}/studio/studio.html`);
    await upload('textless-first.pdf', true);
    await page.locator('#startTranslateDocBtn').click();
    await page.waitForFunction(() => document.querySelector('#progressCounterBadge').textContent === '1 / 2 页'); await waitIdle();
    assert.match(await page.locator('[data-paper-page="1"]').textContent(), /未提取到可翻译内容/);
    assert.doesNotMatch(await page.locator('[data-paper-page="1"]').textContent(), /SECOND PAGE ONLY/);
    assert.match(await page.locator('[data-paper-page="2"] .stream-orig').textContent(), /SECOND PAGE ONLY/);
    assert.equal(requests.length, 1, 'textless first page must not send page-two text to the model');
    const download = page.waitForEvent('download'); await page.locator('#exportMenuBtn').click(); await page.locator('[data-export="html"]').click();
    const html = await fs.readFile(await (await download).path(), 'utf8');
    assert.match(html, /第 1 \/ 2 页未翻译/);
    assert.equal(html.split('SECOND PAGE ONLY sentence.').length - 1, 1);
    check('Actual mixed PDF import keeps textless page failed and page-two text on page two; HTML export marks the absent page without duplicating source text');

    fail = true; const before = requests.length; await upload('credential-errors.pdf', false);
    await page.locator('#startTranslateDocBtn').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.paper-lazy-title')].filter(el => el.textContent.includes('停止自动重试')).length === 2); await waitIdle();
    assert.equal(requests.length - before, 2);
    for (let i = 0; i < 2; i++) {
      await page.locator('#layoutStyleSelect').selectOption('card-stream');
      await page.locator('#layoutStyleSelect').selectOption('paper-layout');
      await page.locator('#bilingualStreamContainer').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(150);
      await page.locator('#bilingualStreamContainer').evaluate(el => { el.scrollTop = 0; });
    }
    await page.waitForTimeout(300);
    assert.equal(requests.length - before, 2, 're-render and visibility cannot retry a permanent failure');
    assert.equal(await page.locator('#progressCounterBadge').textContent(), '0 / 2 页');
    check('Two PDF pages returning HTTP 401 make exactly two requests; repeated layout/visibility changes do not restart failures or mark pages complete');

    fail = false; await page.locator('[data-translate-page="1"]').click();
    await page.waitForFunction(() => document.querySelector('#progressCounterBadge').textContent === '1 / 2 页'); await waitIdle();
    assert.equal(requests.length - before, 3);
    assert.match(await page.locator('[data-paper-page="2"]').textContent(), /停止自动重试/);
    await page.locator('#startTranslateDocBtn').click();
    await page.waitForFunction(() => document.querySelector('#progressCounterBadge').textContent === '2 / 2 页'); await waitIdle();
    assert.equal(requests.length - before, 4);
    check('Explicit per-page retry recovers only that page; explicit Continue retries the remaining failed page and completes the document');

    fail = true; await page.locator('#jumpPageInput').fill('1'); await page.locator('#translateSinglePageBtn').click();
    await page.locator('[data-paper-page="1"] .paper-page-failure').waitFor(); await waitIdle();
    assert.match(await page.locator('[data-paper-page="1"] .stream-trans').textContent(), /Recovered/);
    assert.equal(await page.locator('#progressCounterBadge').textContent(), '1 / 2 页');
    await page.evaluate(() => { window.__pdfPrintCalls = 0; window.print = () => { window.__pdfPrintCalls++; }; });
    await page.locator('#exportMenuBtn').click(); await page.locator('[data-export="pdf-bilingual"]').click();
    await page.locator('input[name="pdfExportScope"][value="all"]').check();
    await page.locator('#confirmPdfExportBtn').click();
    await page.waitForFunction(() => document.querySelector('#pdfExportLiveStatusText').textContent.includes('部分页面翻译失败，未导出'));
    assert.equal(await page.evaluate(() => window.__pdfPrintCalls), 0);
    check('Failed forced PDF retranslation retains readable previous output but is excluded from completion; full PDF export retries explicitly and refuses to print an incomplete result');
  } finally {
    await page.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  return { checks, errors };
}
