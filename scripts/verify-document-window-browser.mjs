import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { buildBilingualEpubBlob } from '../studio/epub-engine.js';

export async function verifyDocumentWindowBrowser(context, sw) {
  const checks = [], errors = [], calls = [];
  const check = label => { checks.push(label); console.log(`  ✓ ${label}`); };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); res.end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body);
    const ids = [...body.messages.at(-1).content.matchAll(/"id"\s*:\s*(\d+)/g)].map(match => Number(match[1]));
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ids.map(id => ({ id, translation: `窗口回归译文 ${id}` }))) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  const download = async format => {
    const pending = page.waitForEvent('download');
    await page.locator('#exportMenuBtn').click(); await page.locator(`[data-export="${format}"]`).click();
    return fs.readFile(await (await pending).path(), 'utf8');
  };
  const bounded = async () => {
    assert.ok(await page.locator('#bilingualStreamContainer [data-block-id]').count() <= 100);
    assert.ok(await page.locator('.source-outline-item').count() <= 100);
    assert.ok(await page.locator('.pdf-toc-item').count() <= 100);
  };
  try {
    await sw.evaluate(url => chrome.storage.local.set({ immersive_gemini_settings_v1: {
      providerId: 'custom', apiProtocol: 'openai', apiBaseUrl: url, apiKey: 'local-window-fixture', modelId: 'window-fixture', enableCache: false,
      enableFloatingBall: false, autoTranslateAllPages: false
    } }), `http://127.0.0.1:${server.address().port}/v1`);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`chrome-extension://${new URL(sw.url()).host}/studio/studio.html`);
    const markdown = Array.from({ length: 10000 }, (_, i) => `${i % 50 === 0 ? '# ' : ''}Unique window paragraph ${i}. Source remains complete.`).join('\n\n');
    await page.locator('#fileInput').setInputFiles({ name: 'ten-thousand-paragraphs.md', mimeType: 'text/markdown', buffer: Buffer.from(markdown) });
    await page.waitForFunction(() => document.querySelector('#workspaceSplitMain').dataset.documentState === 'ready');
    await bounded();
    assert.equal(await page.locator('#bilingualStreamContainer [data-block-id]').count(), 100);
    assert.match(await page.locator('[data-reading-status]').textContent(), /10000 段/);
    assert.ok(await page.locator('*').count() < 2500, 'reading does not mount the full ten-thousand-block tree');
    await page.locator('[data-reading-step="1"]').click();
    assert.equal(await page.locator('#bilingualStreamContainer [data-block-id]').first().getAttribute('data-block-id'), '100');
    await page.locator('[data-reading-page]').fill('100'); await page.locator('[data-reading-page]').press('Enter');
    await page.locator('#bilingualStreamContainer [data-block-id="9999"]').waitFor(); await bounded();
    check('Real 10000-block Markdown import bounds body, source and TOC DOM; next-group and direct last-group navigation retain the final paragraph');

    await page.locator('#streamSearchInput').fill('Unique window paragraph 4321.');
    await page.waitForFunction(() => document.querySelectorAll('#bilingualStreamContainer [data-block-id]').length === 1);
    await page.locator('[data-retrans="4321"]').click();
    await page.waitForFunction(() => document.querySelector('#stream-trans-4321')?.textContent.includes('窗口回归译文 4321'));
    await page.locator('#viewModeSelect').selectOption('translation-full-width');
    assert.equal(await page.locator('#workspaceSplitMain').evaluate(el => el.classList.contains('mode-translation-full-width')), true);
    const exported = await download('html');
    assert.equal((exported.match(/data-block-id="/g) || []).length, 10000);
    assert.match(exported, /Unique window paragraph 0\./); assert.match(exported, /Unique window paragraph 9999\./);
    assert.match(exported, /窗口回归译文 4321/);
    assert.equal(await page.locator('#bilingualStreamContainer [data-block-id]').count(), 1);
    assert.equal(await page.locator('#streamSearchInput').inputValue(), 'Unique window paragraph 4321.');
    assert.equal(calls.length, 1, 'search, navigation and export do not translate other windows');
    check('Distant search, real single-block translation and full-width reading work; HTML exports all 10000 blocks then restores the filtered window');

    await page.locator('[data-toc-window-step="1"]').click();
    await page.locator('[data-toc-block="5000"]').click();
    await page.locator('#bilingualStreamContainer [data-block-id="5000"]').waitFor();
    assert.equal(await page.locator('#streamSearchInput').inputValue(), '');
    assert.equal(await page.locator('[data-reading-page]').inputValue(), '51');
    await bounded();
    await page.locator('#streamSearchInput').fill('Unique window paragraph 4321.');
    await page.waitForFunction(() => document.querySelectorAll('#bilingualStreamContainer [data-block-id]').length === 1);
    assert.match(await page.locator('#stream-trans-4321').textContent(), /窗口回归译文/);
    check('Paged TOC locates a heading outside the current reading window; returning through search retains the translated block');

    const blocks = Array.from({ length: 240 }, (_, id) => ({ id, chapterIndex: id < 120 ? 0 : 1, type: 'paragraph', original: `EPUB window source ${id}.`, translation: '' }));
    const epub = buildBilingualEpubBlob({ bookTitle: 'Window EPUB', chapters: [{ index: 0, title: 'First chapter' }, { index: 1, title: 'Second chapter' }], blocks });
    await page.locator('#viewModeSelect').selectOption('bilingual');
    await page.locator('#streamSearchInput').fill('');
    await page.locator('#fileInput').setInputFiles({ name: 'window.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(await epub.arrayBuffer()) });
    await page.waitForFunction(() => document.querySelector('#leftPaneTitle').textContent.includes('Window EPUB'));
    await page.locator('[data-reading-step="1"]').click();
    await page.locator('#epubChapterSelect').selectOption('1');
    assert.equal(await page.locator('[data-reading-page]').inputValue(), '1');
    await bounded();
    const epubHtml = await download('html');
    assert.match(epubHtml, /EPUB window source 0\./); assert.match(epubHtml, /EPUB window source 239\./);
    assert.equal(await page.locator('#epubChapterSelect').inputValue(), '1');
    await bounded();
    check('Replacing a paged document and changing EPUB chapter reset its window; export retains both chapters and restores the chapter selection');
    assert.deepEqual(errors, []);
    return { checks, errors };
  } finally { await page.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
