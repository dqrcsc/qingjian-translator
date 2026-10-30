import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { makeThreePageReadingPdf } from '../tests/reading-pdf-fixture.mjs';

export async function verifyDocumentConfigBrowser(context, sw) {
  const checks = [], errors = [], calls = [];
  const check = label => { checks.push(label); console.log(`  ✓ ${label}`); };
  let holdAfter = 1;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); res.end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const prompt = body.messages.map(m => m.content).join('\n');
    const ids = [...body.messages.at(-1).content.matchAll(/"id"\s*:\s*(\d+)/g)].map(m => Number(m[1]));
    const english = prompt.includes('Target Language: English.');
    const reply = JSON.stringify({ choices: [{ message: { content: JSON.stringify(ids.map(id => ({ id, translation: `${english ? 'English translation' : '中文译文'} ${id} ${body.model}` }))) } }] });
    calls.push({ prompt, model: body.model, res, reply });
    if (calls.length > holdAfter) return;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(reply);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const key = 'immersive_gemini_settings_v1';
  const original = { providerId: 'custom', apiProtocol: 'openai', apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture', modelId: 'original-model', targetLang: 'zh-CN', enableCache: false, batchMaxItems: 1, maxConcurrency: 1, enableFloatingBall: false, autoTranslateAllPages: false };
  const configure = value => sw.evaluate(({ key, value }) => chrome.storage.local.set({ [key]: value }), { key, value });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => errors.push(e.message));
  const download = async format => {
    const pending = page.waitForEvent('download'); await page.locator('#exportMenuBtn').click(); await page.locator(`[data-export="${format}"]`).click();
    return fs.readFile(await (await pending).path(), 'utf8');
  };
  try {
    await configure(original);
    await page.goto(`chrome-extension://${new URL(sw.url()).host}/studio/studio.html`);
    await page.locator('#fileInput').setInputFiles({ name: 'config.md', mimeType: 'text/markdown', buffer: Buffer.from('First source paragraph.\n\nSecond source paragraph.\n\nThird source paragraph.\n\n```js\nconst preserved = 1;\n```') });
    await page.waitForFunction(() => document.querySelector('#workspaceSplitMain').dataset.documentState === 'ready');
    await page.locator('#startTranslateDocBtn').click();
    await page.waitForFunction(() => document.querySelector('.stream-trans')?.textContent.includes('中文译文'));
    // Change configuration while the next model request is pending.
    while (calls.length < 2) await page.waitForTimeout(20);
    await configure({ ...original, targetLang: 'en', modelId: 'new-model', glossaryText: 'word=term' });
    await page.locator('#documentConfigNotice').waitFor({ state: 'visible' });
    const pendingOld = calls.at(-1); pendingOld.res.end(pendingOld.reply);
    await page.waitForTimeout(100);
    const preserved = await page.locator('.stream-trans').allTextContents();
    assert.match(preserved[0], /中文译文/); assert.match(preserved[1], /未翻译/);
    const count = calls.length; await page.locator('#startTranslateDocBtn').click(); await page.waitForTimeout(150);
    assert.equal(calls.length, count, 'conflicted continue cannot silently send new config');
    assert.match(await download('md'), /中文译文/);
    check('Real Studio settings change cancels pending output, preserves completed translation and export, and blocks implicit mixed-config continuation');

    holdAfter = Infinity;
    await page.locator('[data-config-keep]').click();
    await page.waitForFunction(() => document.querySelector('#startTranslateDocBtn').textContent.includes('重新翻译'));
    for (const text of await page.locator('.stream-trans').allTextContents()) assert.match(text, /中文译文.*original-model/);
    assert.equal(calls.at(-1).model, 'original-model');
    assert.match(calls.at(-1).prompt, /Simplified Chinese/);
    check('Explicit keep-original continues with the document language and model snapshot through actual background HTTP despite changed global settings');

    await configure({ ...original, targetLang: 'en', modelId: 'new-model', glossaryText: 'word=updated term' });
    await page.locator('[data-config-new]').waitFor({ state: 'visible' });
    await page.locator('[data-config-new]').evaluate(button => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector('#startTranslateDocBtn').textContent.includes('重新翻译'));
    for (const text of await page.locator('.stream-trans').allTextContents()) assert.match(text, /English translation.*new-model/);
    const newExport = await download('md'); assert.doesNotMatch(newExport, /中文译文/); assert.match(newExport, /English translation/);
    assert.match(newExport, /const preserved = 1/);
    await page.locator('[data-config-restore]').click();
    await page.waitForFunction(() => document.querySelector('#docStatusSubtitle').textContent.includes('恢复上一版'));
    for (const text of await page.locator('.stream-trans').allTextContents()) assert.match(text, /中文译文/);
    await page.locator('[data-retrans="0"]').click();
    await page.waitForFunction(() => document.querySelector('#docStatusSubtitle').textContent.includes('此段重译完成'));
    assert.equal(calls.at(-1).model, 'original-model');
    check('Explicit new-config retranslation produces coherent new export, retains a restorable old version, and restored single-block retranslation uses its original snapshot');

    await configure(original);
    await page.locator('#fileInput').setInputFiles({ name: 'config.pdf', mimeType: 'application/pdf', buffer: makeThreePageReadingPdf() });
    await page.waitForFunction(() => document.querySelector('#workspaceSplitMain').dataset.documentState === 'ready' && document.querySelector('#leftPaneTitle').textContent.includes('config.pdf'));
    await page.locator('#startTranslateDocBtn').click();
    await page.waitForFunction(() => /2 \/ 3 页/.test(document.querySelector('#progressCounterBadge').textContent));
    await configure({ ...original, targetLang: 'en' });
    await page.locator('[data-config-new]').waitFor({ state: 'visible' });
    const pdfCount = calls.length;
    await page.locator('#jumpPageInput').fill('3'); await page.locator('#translateSinglePageBtn').click();
    await page.waitForTimeout(200); assert.equal(calls.length, pdfCount);
    await page.locator('[data-config-keep]').click();
    await page.waitForFunction(() => /3 \/ 3 页/.test(document.querySelector('#progressCounterBadge').textContent));
    assert.match(calls.at(-1).prompt, /Simplified Chinese/);
    check('PDF lazy/single-page continuation cannot mix a changed target language; explicit keep-original completes remaining pages using the bound snapshot');

    await configure({ ...original, targetLang: 'en', modelId: 'new-pdf-model' });
    await page.locator('[data-config-new]').waitFor({ state: 'visible' });
    await page.locator('[data-config-new]').click();
    await page.waitForFunction(() => /[23] \/ 3 页/.test(document.querySelector('#progressCounterBadge').textContent));
    await page.locator('[data-paper-page="3"]').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => /3 \/ 3 页/.test(document.querySelector('#progressCounterBadge').textContent)).catch(async error => {
      console.error(await page.evaluate(() => ({ status: document.querySelector('#docStatusSubtitle').textContent, progress: document.querySelector('#progressCounterBadge').textContent, pages: [...document.querySelectorAll('[data-paper-page]')].map(e => ({ page: e.dataset.paperPage, lazy: e.dataset.lazyPage, rect: e.getBoundingClientRect().toJSON() })) })));
      throw error;
    });
    const lastPageText = await page.locator('[data-paper-page="3"] .stream-trans').allTextContents();
    assert.ok(lastPageText.some(text => text.includes('English translation') && text.includes('new-pdf-model')));
    const pdfExport = await download('html'); assert.doesNotMatch(pdfExport, /中文译文/);
    check('New-config PDF retranslation keeps retained later pages lazy-observable and exports a coherent new-language document after scrolling');
    assert.deepEqual(errors, []);
    return { checks, errors };
  } finally { await page.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
