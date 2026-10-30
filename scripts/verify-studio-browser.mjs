import assert from 'node:assert/strict';
import http from 'node:http';
import { makePdfFixture } from '../tests/pdf-fixture.mjs';

// Runs against the real installed extension. Every model/PDF request terminates
// at this module's local server; callers keep ownership of context and worker.
export async function verifyStudioBrowser(context, sw) {
  const checks = [], pages = [], errors = [], calls = [], held = [];
  const extensionId = new URL(sw.url()).host;
  const storageKey = 'immersive_gemini_settings_v1';
  const saved = await sw.evaluate(key => chrome.storage.local.get(key), storageKey);
  const fixture = makePdfFixture();
  let mode = 'normal', pdfRequests = 0, base;
  const until = async (predicate, label) => {
    const deadline = Date.now() + 15000;
    while (!await predicate()) {
      if (Date.now() >= deadline) throw new Error(`Studio verification timeout: ${label}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const server = http.createServer(async (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (req.url === '/fixture.pdf') {
      pdfRequests++;
      res.writeHead(200, { ...cors, 'Content-Type': 'application/pdf' }); res.end(fixture); return;
    }
    if (req.url === '/external') {
      const target = `chrome-extension://${extensionId}/studio/studio.html?url=${encodeURIComponent(base + '/fixture.pdf')}`;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<title>External navigation fixture</title><iframe src="${target}"></iframe><a id="open" href="${target}">Open</a>`);
      return;
    }
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    const content = request.messages.at(-1).content;
    calls.push({ mode, content });
    const reply = output => {
      if (res.destroyed) return;
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }));
    };
    if (Array.isArray(content)) { reply({ hasText: false, summaryTranslation: '', regions: [] }); return; }
    const ids = [...content.matchAll(/"id"\s*:\s*(\d+)/g)].map(match => Number(match[1]));
    const translations = ids.map(id => ({ id, translation: content.includes('ALPHA original')
      ? (id === 0 ? 'ALPHA译文' : 'BETA译文') : `PDF译文 ${id}` }));
    if (mode === 'hold') { held.push({ ids, reply: (value = translations) => reply(value) }); return; }
    if (mode === 'fail') {
      res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"fixture unauthorized"}}'); return;
    }
    reply(translations);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const newPage = async () => { const page = await context.newPage(); pages.push(page); return page; };
  try {
    await sw.evaluate(async ({ key, base }) => {
      await chrome.storage.local.set({ [key]: { providerId: 'custom', apiProtocol: 'openai',
        apiBaseUrl: base + '/v1', apiKey: 'local-fixture-only', modelId: 'fixture-vision',
        enableCache: false, maxConcurrency: 3, autoTranslateAllPages: false,
        enableFloatingBall: false, batchMaxItems: 10, batchMaxChars: 8000 } });
    }, { key: storageKey, base });

    const external = await newPage();
    await external.goto(base + '/external');
    await external.waitForTimeout(500);
    assert.ok(external.frames().every(frame => !frame.url().startsWith(`chrome-extension://${extensionId}/studio/`)));
    assert.equal(pdfRequests, 0); assert.equal(calls.length, 0);
    await external.locator('#open').click();
    await external.waitForTimeout(500);
    assert.ok(!external.url().startsWith(`chrome-extension://${extensionId}/studio/`));
    assert.equal(pdfRequests, 0); assert.equal(calls.length, 0);
    checks.push('External iframe and top-level navigation cannot open private Studio or trigger PDF/model requests');

    const control = await newPage();
    await control.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    const opened = context.waitForEvent('page');
    const response = await control.evaluate(pdfUrl => chrome.runtime.sendMessage({
      type: 'OPEN_DOCUMENT_STUDIO', payload: { pdfUrl, autoTranslate: false }
    }), base + '/fixture.pdf');
    assert.equal(response.ok, true);
    const studio = await opened; pages.push(studio);
    studio.on('pageerror', error => errors.push(error.message));
    await studio.waitForFunction(() => document.querySelector('#startTranslateDocBtn') &&
      !document.querySelector('#startTranslateDocBtn').disabled);
    assert.ok(studio.url().startsWith(`chrome-extension://${extensionId}/studio/studio.html`));
    assert.ok(pdfRequests > 0); assert.equal(calls.length, 0);
    checks.push('The normal OPEN_DOCUMENT_STUDIO background command opens and loads a PDF without auto translation');

    mode = 'hold';
    await studio.locator('#fileInput').setInputFiles({ name: 'race.md', mimeType: 'text/markdown',
      buffer: Buffer.from('ALPHA original paragraph.\n\nBETA original paragraph.') });
    await studio.waitForFunction(() => document.querySelectorAll('.retranslate-mini-btn').length === 2);
    await studio.locator('#startTranslateDocBtn').click();
    await until(() => held.length === 1, 'delayed document batch');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150"><rect width="200" height="150" fill="white"/><text x="10" y="40">Figure</text></svg>';
    await studio.locator('#figureImageInput').setInputFiles({ name: 'figure.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
    // This fixture has no regions: the UI must report no detected labels, not
    // claim a seamless translation. Keep all identity/export assertions below.
    await studio.waitForFunction(() => document.querySelector('#docStatusSubtitle').textContent.includes('未发现需要翻译的图中文字'));
    held.shift().reply();
    await studio.waitForFunction(() => document.querySelector('#docStatusSubtitle').textContent.includes('文档双语翻译已完成'));
    assert.equal((await studio.locator('#stream-trans-0').textContent()).trim(), 'ALPHA译文');
    assert.equal((await studio.locator('#stream-trans-1').textContent()).trim(), 'BETA译文');
    assert.match(await studio.locator('[data-block-id="0"]').textContent(), /ALPHA original/);
    assert.match(await studio.locator('[data-block-id="1"]').textContent(), /BETA original/);
    assert.match(await studio.locator('[data-block-id="2"]').textContent(), /Figure \(figure\.svg\)[\s\S]*已处理 0 处图中文字/);
    await studio.locator('#exportMenuBtn').click();
    const downloadEvent = studio.waitForEvent('download');
    await studio.locator('[data-export="md"]').click();
    const download = await downloadEvent, stream = await download.createReadStream(), chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const markdown = Buffer.concat(chunks).toString();
    assert.match(markdown, /ALPHA original paragraph\.[\s\S]*?ALPHA译文[\s\S]*?BETA original paragraph\.[\s\S]*?BETA译文/);
    assert.match(markdown, /figure\.svg[\s\S]*已处理 0 处图中文字/);
    checks.push('Inserting a figure while a batch is delayed preserves original/translation identities in the UI and actual Markdown export');

    mode = 'fail';
    await studio.locator('[data-retrans="0"]').click();
    await studio.waitForFunction(() => document.querySelector('#docStatusSubtitle').textContent.includes('重译失败'));
    assert.match(await studio.locator('#docStatusSubtitle').textContent(), /401/);
    assert.equal((await studio.locator('#stream-trans-0').textContent()).trim(), 'ALPHA译文');
    assert.equal(await studio.locator('[data-retrans="0"]').isDisabled(), false);
    const beforeRetry = calls.length;
    mode = 'hold';
    await studio.locator('[data-retrans="0"]').click();
    await until(() => held.length === 1, 'single-block retry');
    await studio.locator('[data-retrans="0"]').dispatchEvent('click');
    assert.equal(await studio.locator('[data-retrans="0"]').isDisabled(), true);
    held.shift().reply([{ id: 0, translation: 'ALPHA重试译文' }]);
    await studio.waitForFunction(() => document.querySelector('#stream-trans-0').textContent.includes('ALPHA重试译文'));
    assert.equal(calls.length, beforeRetry + 1);
    assert.equal(await studio.locator('[data-retrans="0"]').isDisabled(), false);
    checks.push('Single-block HTTP 401 preserves the old translation and exposes an error; retry succeeds and reentrant clicks send one request');

    // Translate page 2 first, then page 1: sorting must not rename page 2's IDs.
    mode = 'normal';
    await studio.locator('#fileInput').setInputFiles({ name: 'fixture.pdf', mimeType: 'application/pdf', buffer: fixture });
    await studio.waitForFunction(() => document.querySelector('#jumpPageInput')?.max === '2');
    await studio.locator('#jumpPageInput').fill('2');
    await studio.locator('#translateSinglePageBtn').click();
    await studio.waitForFunction(() => document.querySelector('[data-paper-page="2"] .retranslate-mini-btn') &&
      document.querySelector('#docStatusSubtitle').textContent.includes('已完成'));
    const page2Before = await studio.locator('[data-paper-page="2"] [data-block-id]').evaluateAll(elements =>
      elements.map(el => ({ id: el.dataset.blockId, text: el.textContent })));
    assert.ok(page2Before.length > 0);
    await studio.locator('#jumpPageInput').fill('1');
    await studio.locator('#translateSinglePageBtn').click();
    await studio.waitForFunction(() => document.querySelector('#docStatusSubtitle').textContent.includes('全部 2 页翻译完成'));
    const page2After = await studio.locator('[data-paper-page="2"] [data-block-id]').evaluateAll(elements =>
      elements.map(el => ({ id: el.dataset.blockId, text: el.textContent })));
    assert.deepEqual(page2After, page2Before);
    const allIds = await studio.locator('[data-block-id]').evaluateAll(elements => elements.map(el => el.dataset.blockId));
    assert.equal(new Set(allIds).size, allIds.length);
    checks.push('Translating PDF pages out of order preserves existing block IDs and translations when pages are merged and sorted');

    // A single-block response may arrive after a full-page retry replaced it.
    const retiredId = page2Before[0].id;
    mode = 'hold';
    await studio.locator(`[data-retrans="${retiredId}"]`).click();
    await until(() => held.length === 1, 'old PDF block retranslation');
    mode = 'normal';
    await studio.locator('#jumpPageInput').fill('2');
    await studio.locator('#translateSinglePageBtn').click();
    await studio.waitForFunction(id => !document.querySelector(`[data-block-id="${id}"]`), retiredId);
    const replacementBefore = await studio.locator('[data-paper-page="2"]').textContent();
    held.shift().reply([{ id: Number(retiredId), translation: 'STALE RETIRED BLOCK RESULT' }]);
    await studio.waitForTimeout(200);
    assert.equal(await studio.locator('[data-paper-page="2"]').textContent(), replacementBefore);
    assert.ok(!(await studio.locator('body').textContent()).includes('STALE RETIRED BLOCK RESULT'));
    checks.push('A late single-block response cannot update a replaced PDF page or its new blocks');
    assert.deepEqual(errors, []);
    return checks;
  } finally {
    for (const page of pages) if (!page.isClosed()) await page.close();
    await sw.evaluate(async ({ key, saved }) => {
      if (Object.hasOwn(saved, key)) await chrome.storage.local.set(saved);
      else await chrome.storage.local.remove(key);
    }, { key: storageKey, saved });
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
