// Real file inputs, MV3 background HTTP, controls and downloads. No paid API calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { makePdfFixture } from '../tests/pdf-fixture.mjs';
import { makeThreePageReadingPdf } from '../tests/reading-pdf-fixture.mjs';
import { buildBilingualEpubBlob, readZipArchive } from '../studio/epub-engine.js';

export async function verifyReadingStudioBrowser(context, sw) {
  const checks = [], errors = [], calls = [];
  const key = 'immersive_gemini_settings_v1';
  const previous = await sw.evaluate(key => chrome.storage.local.get(key), key);
  const extensionId = new URL(sw.url()).host;
  const pages = new Set();
  let longPdfReplies = false;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
      res.end(); return;
    }
    try {
      assert.equal(req.method, 'POST');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const native = Boolean(body.contents);
      const prompt = native ? body.contents[0].parts.map(part => part.text || '').join('') : body.messages.at(-1).content;
      const ids = [...prompt.matchAll(/"id"\s*:\s*(\d+)/g)].map(match => Number(match[1]));
      const sequence = calls.length + 1;
      const pageNumber = Number(prompt.match(/academic page \(Page (\d+)/)?.[1] || 1);
      calls.push({ native, sequence, ids, pageNumber });
      const translations = native
        ? [{ page: pageNumber, type: 'paragraph', original: `Native PDF page ${pageNumber}`, translation: `原生页面译文请求${sequence}` }]
        : ids.map(id => ({ id, translation: `中文译文请求${sequence}段落${id}${longPdfReplies ? '这是一段供滚动阅读的较长译文。'.repeat(150) : ''}` }));
      if (native) assert.ok(body.contents[0].parts.some(part => part.inlineData?.data), 'PDF must include actual media bytes');
      else assert.ok(ids.length > 0, 'batch request must contain block IDs');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(native
        ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(translations) }] } }] }
        : { choices: [{ message: { content: JSON.stringify(translations) } }] }));
    } catch (error) {
      errors.push(`Reading fixture: ${error.message}`);
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: { message: 'Invalid local reading fixture request' } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const configure = async (protocol = 'openai') => sw.evaluate(async ({ key, base, protocol }) => {
    await chrome.storage.local.set({ [key]: {
      providerId: 'custom', apiProtocol: protocol, apiBaseUrl: `${base}/${protocol === 'gemini' ? 'v1beta' : 'v1'}`,
      apiKey: 'local-reading-fixture', modelId: `reading-fixture-${protocol}`, targetLang: 'zh-CN',
      enableCache: true, batchMaxItems: 10, maxConcurrency: 1, requestBudgetSeconds: 30,
      enableFloatingBall: false, autoTranslateAllPages: false, enableImageTranslate: false
    } });
  }, { key, base, protocol });
  const newStudio = async () => {
    const page = await context.newPage(); pages.add(page);
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(`Reading Studio page: ${error.message}`));
    await page.goto(`chrome-extension://${extensionId}/studio/studio.html`);
    return page;
  };
  const file = (name, text, mimeType = 'text/markdown') => ({ name, mimeType, buffer: Buffer.from(text) });
  const uploadMarkdown = async (page, name, text) => {
    await page.locator('#fileInput').setInputFiles(file(name, text));
    await page.waitForFunction(fragment => document.querySelector('#sourceOutlineViewer').textContent.includes(fragment), text.split('\n')[0]);
    assert.equal(await page.locator('#startTranslateDocBtn').isEnabled(), true);
  };
  const translateText = async page => {
    await page.locator('#startTranslateDocBtn').click();
    await page.waitForFunction(() => document.querySelector('#docStatusSubtitle').textContent.includes('文档双语翻译已完成'));
    await page.waitForFunction(() => document.querySelector('#startTranslateDocBtn').textContent.includes('重新翻译'));
  };
  const download = async (page, format) => {
    const pending = page.waitForEvent('download');
    await page.locator('#exportMenuBtn').click();
    await page.locator(`[data-export="${format}"]`).click();
    const artifact = await pending;
    assert.equal(await artifact.failure(), null);
    return fs.readFile(await artifact.path());
  };
  const run = async (label, action) => {
    const before = new Set(pages);
    try { const detail = await action(); checks.push(`${label}${detail ? ` (${detail})` : ''}`); }
    catch (error) { errors.push(`${label}: ${error.message}`); }
    finally {
      for (const page of pages) if (!before.has(page)) { await page.close(); pages.delete(page); }
    }
  };
  const htmlContents = async buffer => {
    const page = await context.newPage(); pages.add(page);
    await page.setContent(buffer.toString());
    return page;
  };
  const snapshot = page => page.locator('#bilingualStreamContainer [data-block-id]').evaluateAll(nodes =>
    nodes.map(node => ({ id: node.dataset.blockId, page: node.closest('[data-paper-page]')?.dataset.paperPage,
      original: node.querySelector('.stream-orig')?.textContent.trim(), translation: node.querySelector('.stream-trans')?.textContent.trim() })));
  const readyPdf = async (page, name, buffer = makePdfFixture(), totalPages = 2) => {
    await page.locator('#fileInput').setInputFiles({ name, mimeType: 'application/pdf', buffer });
    await page.waitForFunction(totalPages => document.querySelector('#jumpPageInput').max === String(totalPages) &&
      !document.querySelector('#startTranslateDocBtn').disabled &&
      document.querySelector('#bilingualStreamContainer').textContent.includes('已就绪'), totalPages);
  };
  const completedPdf = async (page, previousIds = [], pageNumber = null, totalPages = 2) => {
    await page.waitForFunction(({ previousIds, pageNumber, totalPages }) => {
      const root = document.querySelector('#bilingualStreamContainer');
      const nodes = [...root.querySelectorAll('[data-block-id]')].filter(node => !pageNumber ||
        node.closest('[data-paper-page]')?.dataset.paperPage === String(pageNumber));
      return nodes.length > 0 && nodes.every(node => !previousIds.includes(node.dataset.blockId)) &&
        document.querySelector('#progressCounterBadge').textContent.includes(`${totalPages} / ${totalPages}`) &&
        document.querySelector('#startTranslateDocBtn').textContent.includes('重新翻译') &&
        !root.querySelector('.is-loading-page') &&
        document.querySelector('#docStatusSubtitle').textContent.includes(`全部 ${totalPages} 页翻译完成`);
    }, { previousIds, pageNumber, totalPages });
  };
  try {
    await configure();
    await run('F2 searched card view exports complete paper-layout HTML and restores the current view', async () => {
      const page = await newStudio();
      await uploadMarkdown(page, 'full-export.md', 'Alpha export paragraph.\n\nBeta export paragraph.');
      await translateText(page);
      await page.locator('#layoutStyleSelect').selectOption('card-stream');
      await page.locator('#streamSearchInput').fill('Alpha');
      assert.equal(await page.locator('#bilingualStreamContainer [data-block-id]').count(), 1);
      const before = await page.locator('#bilingualStreamContainer').innerHTML();
      const exported = await htmlContents(await download(page, 'html'));
      assert.match(await exported.locator('.export-doc-root').textContent(), /Alpha export paragraph/);
      assert.match(await exported.locator('.export-doc-root').textContent(), /Beta export paragraph/);
      assert.equal(await exported.locator('.paper-sheet-page').count(), 1, 'HTML export must preserve paper layout even from card mode');
      assert.equal(await exported.locator('[data-block-id]').count(), 2);
      assert.equal(await page.locator('#layoutStyleSelect').inputValue(), 'card-stream');
      assert.equal(await page.locator('#streamSearchInput').inputValue(), 'Alpha');
      assert.equal(await page.locator('#bilingualStreamContainer').innerHTML(), before);
      return '2 exported blocks, 1 filtered reader block';
    });

    await run('F2 EPUB chapter filter does not truncate downloaded HTML', async () => {
      const epub = buildBilingualEpubBlob({ bookTitle: 'Reading fixture', bookAuthor: 'Fixture', blocks: [
        { chapterIndex: 0, chapterTitle: 'Chapter Alpha', original: 'EPUB alpha content.', translation: 'EPUB alpha content.' },
        { chapterIndex: 1, chapterTitle: 'Chapter Beta', original: 'EPUB beta content.', translation: 'EPUB beta content.' }
      ] }, 'translation-only');
      const page = await newStudio();
      await page.locator('#fileInput').setInputFiles({ name: 'chapters.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(await epub.arrayBuffer()) });
      await page.waitForFunction(() => document.querySelector('#epubChapterSelect').options.length === 3);
      await translateText(page);
      await page.locator('#epubChapterSelect').selectOption('0');
      assert.doesNotMatch(await page.locator('#bilingualStreamContainer').innerText(), /EPUB beta content/);
      const exported = await htmlContents(await download(page, 'html'));
      const text = await exported.locator('.export-doc-root').textContent();
      assert.match(text, /EPUB alpha content/); assert.match(text, /EPUB beta content/);
      assert.equal(await page.locator('#epubChapterSelect').inputValue(), '0');
      assert.doesNotMatch(await page.locator('#bilingualStreamContainer').innerText(), /EPUB beta content/);
      return 'both spine chapters exported; reader remains on chapter 1';
    });

    await run('F3 delayed PDF file read disables operations and guards actual click handlers', async () => {
      const page = await newStudio();
      await page.evaluate(() => {
        const native = File.prototype.stream;
        File.prototype.stream = function () {
          const stream = native.call(this);
          if (this.name !== 'held-import.pdf') return stream;
          const reader = stream.getReader();
          return new ReadableStream({ async start(controller) {
            await new Promise(resolve => { globalThis.__releaseReadingFile = resolve; });
            for (;;) { const {done, value} = await reader.read(); if (done) { controller.close(); break; } controller.enqueue(value); }
          }, cancel(reason) { return reader.cancel(reason); } });
        };
      });
      let downloads = 0; page.on('download', () => downloads++);
      await page.locator('#fileInput').setInputFiles({ name: 'held-import.pdf', mimeType: 'application/pdf', buffer: makePdfFixture() });
      await page.waitForFunction(() => Boolean(globalThis.__releaseReadingFile));
      try {
        assert.equal(await page.locator('#workspaceSplitMain').getAttribute('data-document-state'), 'loading');
        assert.equal(await page.locator('#startTranslateDocBtn').isDisabled(), true);
        assert.equal(await page.locator('#exportMenuBtn').isDisabled(), true);
        const before = calls.length;
        // A dispatched event reaches the real listener even when disabled; guards must be independent of CSS/UI.
        await page.evaluate(() => {
          for (const selector of ['#startTranslateDocBtn', '#translateSinglePageBtn', '[data-export="html"]'])
            document.querySelector(selector).dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await page.waitForTimeout(100);
        assert.equal(calls.length, before); assert.equal(downloads, 0);
      } finally { await page.evaluate(() => __releaseReadingFile()); }
      await page.waitForFunction(() => document.querySelector('#workspaceSplitMain').dataset.documentState === 'ready');
      assert.equal(await page.locator('#jumpPageInput').getAttribute('max'), '2');
      assert.equal(await page.locator('#startTranslateDocBtn').isEnabled(), true);
      return '0 HTTP calls and 0 downloads while loading; ready exposes 2 pages';
    });

    for (const [extension, contents, mime] of [
      ['epub', 'not an EPUB', 'application/epub+zip'],
      ['pdf', '%PDF-1.7\nThis truncated PDF has no catalog or pages.', 'application/pdf']
    ]) await run(`F3 failed ${extension.toUpperCase()} import cannot translate or export the empty document`, async () => {
      const page = await newStudio();
      await page.locator('#fileInput').setInputFiles(file(`invalid.${extension}`, contents, mime));
      await page.waitForFunction(() => document.querySelector('#docStatusSubtitle').textContent.includes('文档加载失败'));
      assert.equal(await page.locator('#workspaceSplitMain').getAttribute('data-document-state'), 'error');
      assert.equal(await page.locator('#startTranslateDocBtn').isDisabled(), true);
      assert.equal(await page.locator('#exportMenuBtn').isDisabled(), true);
      let downloads = 0; page.on('download', () => downloads++);
      const before = calls.length;
      await page.evaluate(() => {
        document.querySelector('#startTranslateDocBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        document.querySelector('[data-export="md"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.waitForTimeout(100);
      assert.equal(calls.length, before); assert.equal(downloads, 0);
    });

    await run('F3 a retired file read cannot overwrite the newer imported document', async () => {
      const page = await newStudio();
      await page.evaluate(() => {
        const native = File.prototype.stream;
        File.prototype.stream = function () {
          const stream = native.call(this);
          if (this.name !== 'old-import.md') return stream;
          const reader = stream.getReader();
          let cancelled = false;
          return new ReadableStream({ async start(controller) {
            await new Promise(resolve => { globalThis.__releaseOldReadingFile = resolve; });
            if (cancelled) return;
            for (;;) { const {done, value} = await reader.read(); if (done) { controller.close(); break; } controller.enqueue(value); }
          }, cancel(reason) { cancelled = true; return reader.cancel(reason); } });
        };
      });
      await page.locator('#fileInput').setInputFiles(file('old-import.md', 'OLD import must never appear.'));
      await page.waitForFunction(() => Boolean(globalThis.__releaseOldReadingFile));
      await uploadMarkdown(page, 'new-import.md', 'NEW import survives.');
      await page.evaluate(() => __releaseOldReadingFile());
      await page.waitForTimeout(100);
      assert.match(await page.locator('#sourceOutlineViewer').innerText(), /NEW import survives/);
      assert.doesNotMatch(await page.locator('#sourceOutlineViewer').innerText(), /OLD import/);
      assert.match(await page.locator('#docStatusSubtitle').innerText(), /new-import.md/);
      assert.equal(await page.locator('#workspaceSplitMain').getAttribute('data-document-state'), 'ready');
    });

    for (const protocol of ['openai', 'gemini']) {
      await run(`F4 ${protocol} PDF full and single-page retranslation replace completed blocks with fresh HTTP results`, async () => {
        await configure(protocol);
        const page = await newStudio();
        const filename = `cache-reading-${protocol}.pdf`;
        await readyPdf(page, filename);
        const initialCalls = calls.length;
        await page.locator('#startTranslateDocBtn').click();
        await completedPdf(page);
        const first = await snapshot(page), firstCount = calls.length - initialCalls;
        assert.equal(firstCount, 2, 'two PDF pages must make two model HTTP requests');
        const beforeFull = calls.length;
        await page.locator('#startTranslateDocBtn').click();
        await completedPdf(page, first.map(block => block.id));
        const full = await snapshot(page);
        assert.equal(calls.length - beforeFull, 2, 'full retranslation must bypass both page caches');
        assert.notDeepEqual(full.map(block => block.translation), first.map(block => block.translation));
        const beforeSingle = calls.length;
        await page.locator('#jumpPageInput').fill('1');
        await page.locator('#translateSinglePageBtn').click();
        await completedPdf(page, full.filter(block => block.page === '1').map(block => block.id), 1);
        const single = await snapshot(page);
        assert.equal(calls.length - beforeSingle, 1, 'single-page retranslation must make one fresh request');
        assert.deepEqual(single.filter(block => block.page === '2'), full.filter(block => block.page === '2'), 'other page remains unchanged');
        if (protocol === 'openai') {
          // Re-import the same document, then translate only page 1. The Continue action must reuse page 2's updated cache.
          await readyPdf(page, filename);
          await page.locator('#translateSinglePageBtn').click();
          await page.waitForFunction(() => document.querySelector('#progressCounterBadge').textContent.includes('1 / 2') &&
            document.querySelector('#startTranslateDocBtn').textContent.includes('继续翻译'));
          const beforeContinue = calls.length;
          await page.locator('#startTranslateDocBtn').click();
          await completedPdf(page);
          assert.equal(calls.length, beforeContinue, 'continuing an incomplete PDF must reuse cached page 2');
          assert.deepEqual((await snapshot(page)).filter(block => block.page === '2').map(block => block.translation),
            full.filter(block => block.page === '2').map(block => block.translation), 'cached page 2 must contain the forced retranslation, not its original result');
          // A normal fresh import also proves that the forced single-page output replaced page 1's cache.
          const cached = await snapshot(page);
          await readyPdf(page, filename);
          const beforeCached = calls.length;
          await page.locator('#startTranslateDocBtn').click(); await completedPdf(page);
          assert.equal(calls.length, beforeCached);
          assert.deepEqual((await snapshot(page)).map(block => block.translation), cached.map(block => block.translation));
          return 'first 2 + full 2 + single 1 HTTP; continue 0; cached re-import 0; all changed block IDs verified';
        }
        return 'native inlineData: first 2 + full 2 + single 1 HTTP; all changed block IDs verified';
      });
    }
    await configure();

    await run('F2/F4 unstarted PDF export explains omitted pages without HTTP; forced lazy page 3 stays fresh', async () => {
      const page = await newStudio();
      await page.setViewportSize({ width: 1200, height: 320 });
      await readyPdf(page, 'three-page-reading.pdf', makeThreePageReadingPdf(), 3);
      const beforeExport = calls.length;
      const exported = await htmlContents(await download(page, 'html'));
      assert.equal(await exported.locator('.paper-untranslated-page').count(), 3);
      assert.match(await exported.locator('.export-doc-root').innerText(), /原页内容未包含在此 HTML 中/);
      await page.waitForTimeout(100);
      assert.equal(calls.length, beforeExport, 'unstarted PDF HTML export must not ask a model to fill missing pages');
      longPdfReplies = true;
      try {
        await page.locator('#startTranslateDocBtn').click();
        await page.waitForFunction(() => document.querySelector('#progressCounterBadge').textContent.includes('2 / 3') &&
          document.querySelector('#startTranslateDocBtn').textContent.includes('继续翻译'));
        await page.locator('#bilingualStreamContainer [data-paper-page="3"]').scrollIntoViewIfNeeded();
        await completedPdf(page, [], null, 3);
        const oldThird = (await snapshot(page)).filter(block => block.page === '3');
        const beforeForce = calls.length;
        await page.locator('#bilingualStreamContainer').evaluate(element => { element.scrollTop = 0; });
        await page.locator('#startTranslateDocBtn').click();
        await page.waitForFunction(() => document.querySelector('#progressCounterBadge').textContent.includes('2 / 3') &&
          document.querySelector('#startTranslateDocBtn').textContent.includes('继续翻译'));
        assert.equal(calls.length - beforeForce, 2, 'eager forced pass should retranslate just the first two pages');
        assert.deepEqual((await snapshot(page)).filter(block => block.page === '3'), oldThird, 'old third page remains readable until revisited');
        assert.equal(await page.locator('#bilingualStreamContainer [data-paper-page="3"]').getAttribute('data-lazy-page'), '3');
        const beforeLazy = calls.length;
        await page.locator('#bilingualStreamContainer [data-paper-page="3"]').scrollIntoViewIfNeeded();
        await completedPdf(page, oldThird.map(block => block.id), 3, 3);
        assert.equal(calls.length - beforeLazy, 1, 'scrolling to the deferred forced page must bypass its cached result');
        assert.notDeepEqual((await snapshot(page)).filter(block => block.page === '3').map(block => block.translation), oldThird.map(block => block.translation));
      } finally { longPdfReplies = false; }
      return 'untranslated HTML: 3 visible notices/0 HTTP; forced eager 2 + scrolled page 1 HTTP';
    });

    await run('PDF print media excludes untranslated pages and completed pages outside the selected range', async () => {
      const page = await newStudio();
      await readyPdf(page, 'print-scope.pdf');
      await page.locator('#translateSinglePageBtn').click();
      await page.waitForFunction(() => document.querySelector('#progressCounterBadge').textContent.includes('1 / 2') &&
        document.querySelector('#startTranslateDocBtn').textContent.includes('继续翻译'));
      const printPages = async scope => {
        await page.evaluate(() => {
          globalThis.__readingPrintedPages = null;
          window.print = () => { globalThis.__readingPrintedPages = [...document.querySelectorAll('#bilingualStreamContainer [data-paper-page]')]
            .filter(node => getComputedStyle(node).display !== 'none').map(node => Number(node.dataset.paperPage)); };
        });
        await page.locator('#exportMenuBtn').click();
        await page.locator('[data-export="pdf-bilingual"]').click();
        await page.locator(`input[name="pdfExportScope"][value="${scope}"]`).check();
        if (scope === 'range') {
          await page.locator('#exportRangeStartInput').fill('1');
          await page.locator('#exportRangeEndInput').fill('1');
        }
        // Print hides screen controls, so dispatch through the actual confirm listener after enabling print media.
        await page.emulateMedia({ media: 'print' });
        try {
          await page.locator('#confirmPdfExportBtn').dispatchEvent('click');
          await page.waitForFunction(() => Array.isArray(globalThis.__readingPrintedPages));
          return await page.evaluate(() => __readingPrintedPages);
        } finally {
          await page.emulateMedia({ media: 'screen' });
          await page.waitForTimeout(450); // Production restores the pre-print view after 400 ms.
        }
      };
      const translatedOnly = await printPages('translated-only');
      await page.locator('#jumpPageInput').fill('2');
      await page.locator('#translateSinglePageBtn').click();
      await completedPdf(page);
      const rangeOne = await printPages('range');
      assert.deepEqual({ translatedOnly, rangeOne }, { translatedOnly: [1], rangeOne: [1] });
      return 'actual print CSS visible page IDs: [1] for both scopes; OS dialog intentionally not exercised';
    });

    await run('F7 unclosed Markdown fences preserve the final code in the reader and downloads', async () => {
      const page = await newStudio();
      const markdown = 'Fence introduction.\n\n```python\nprint("important final code")\n';
      await uploadMarkdown(page, 'unclosed.md', markdown);
      assert.match(await page.locator('#sourceOutlineViewer').innerText(), /important final code/);
      assert.match(await page.locator('#bilingualStreamContainer pre').innerText(), /important final code/);
      assert.match((await download(page, 'md')).toString(), /```python\nprint\("important final code"\)/);
      const exported = await htmlContents(await download(page, 'html'));
      assert.match(await exported.locator('pre').innerText(), /important final code/);
    });

    await run('Full-width translation hides the source pane, labels untranslated text and exports the selected mode', async () => {
      const page = await newStudio();
      await uploadMarkdown(page, 'full-width.md', 'Alpha original reading.\n\nBeta original reading.');
      assert.equal(await page.locator('#viewModeSelect option[value="translation-full-width"]').count(), 1);
      const initialWidth = (await page.locator('.right-pane').boundingBox()).width;
      await page.locator('#viewModeSelect').selectOption('translation-full-width');
      assert.equal(await page.locator('.left-pane').isVisible(), false);
      assert.ok((await page.locator('.right-pane').boundingBox()).width > initialWidth * 1.2);
      assert.equal(await page.locator('#bilingualStreamContainer .untranslated-label').count(), 2);
      assert.match(await page.locator('#bilingualStreamContainer').innerText(), /Alpha original reading/);
      await page.locator('#layoutStyleSelect').selectOption('card-stream');
      assert.equal(await page.locator('#bilingualStreamContainer .untranslated-label').count(), 2);
      assert.match(await page.locator('#bilingualStreamContainer').innerText(), /Beta original reading/);
      // Translate one actual block so partial exports must retain the other block with an explicit fallback label.
      await page.locator('#bilingualStreamContainer [data-retrans]').first().click();
      await page.waitForFunction(() => document.querySelector('#bilingualStreamContainer').textContent.includes('中文译文') &&
        document.querySelectorAll('#bilingualStreamContainer .untranslated-label').length === 1);
      const beforePartialExport = calls.length;
      const partial = await htmlContents(await download(page, 'html'));
      assert.equal(await partial.locator('[data-block-id]').count(), 2);
      assert.equal(await partial.locator('.untranslated-label').count(), 1);
      assert.match(await partial.locator('.export-doc-root').innerText(), /Beta original reading/);
      assert.equal(calls.length, beforePartialExport, 'partial HTML export cannot initiate translation');
      await translateText(page);
      const screenshotDir = new URL('../dist/browser-verification/', import.meta.url);
      await fs.mkdir(screenshotDir, { recursive: true });
      await page.screenshot({ path: new URL('studio-full-width.png', screenshotDir).pathname, fullPage: true });
      await page.locator('#streamSearchInput').fill('Alpha original');
      assert.equal(await page.locator('#bilingualStreamContainer [data-block-id]').count(), 1);
      assert.doesNotMatch(await page.locator('#bilingualStreamContainer').innerText(), /Alpha original/);
      assert.match(await page.locator('#bilingualStreamContainer').innerText(), /中文译文/);
      const exported = await htmlContents(await download(page, 'html'));
      assert.equal(await exported.locator('[data-block-id]').count(), 2);
      assert.equal(await exported.locator('.stream-orig').first().isVisible(), false);
      assert.match(await exported.locator('.export-doc-root').innerText(), /中文译文/);
      const markdown = (await download(page, 'md')).toString();
      assert.doesNotMatch(markdown, /Alpha original|Beta original/); assert.match(markdown, /中文译文/);
      const epubBytes = await download(page, 'epub');
      const archive = await readZipArchive(Uint8Array.from(epubBytes).buffer);
      const chapter = await archive.get('OEBPS/chapter.xhtml').getText();
      assert.doesNotMatch(chapter, /Alpha original|Beta original/); assert.match(chapter, /中文译文/);
      assert.equal(await page.locator('#viewModeSelect').inputValue(), 'translation-full-width');
      assert.equal(await page.locator('#streamSearchInput').inputValue(), 'Alpha original');
      // Exercise the real print-export controls; observe print DOM without opening an OS print dialog.
      await page.evaluate(() => {
        window.print = () => { globalThis.__readingPrint = {
          blocks: document.querySelectorAll('#bilingualStreamContainer [data-block-id]').length,
          layout: document.querySelector('#layoutStyleSelect').value,
          mode: document.querySelector('#viewModeSelect').value,
          originalDisplay: getComputedStyle(document.querySelector('#bilingualStreamContainer .stream-orig')).display
        }; };
      });
      await page.locator('#exportMenuBtn').click();
      await page.locator('[data-export="pdf-bilingual"]').click();
      await page.locator('#confirmPdfExportBtn').click();
      await page.waitForFunction(() => Boolean(globalThis.__readingPrint));
      assert.deepEqual(await page.evaluate(() => __readingPrint), { blocks: 2, layout: 'paper-layout', mode: 'bilingual', originalDisplay: 'block' });
      await page.waitForFunction(() => document.querySelector('#viewModeSelect').value === 'translation-full-width' &&
        document.querySelector('#layoutStyleSelect').value === 'card-stream');
      assert.equal(await page.locator('.left-pane').isVisible(), false);
      assert.equal(await page.locator('#streamSearchInput').inputValue(), 'Alpha original');
      assert.equal(await page.locator('#bilingualStreamContainer [data-block-id]').count(), 1);
      await page.locator('#viewModeSelect').selectOption('bilingual');
      assert.equal(await page.locator('.left-pane').isVisible(), true);
      assert.ok(Math.abs((await page.locator('.right-pane').boundingBox()).width - initialWidth) < 2);
      assert.match(await page.locator('#bilingualStreamContainer').innerText(), /Alpha original reading/);
      return 'HTML/MD/EPUB complete; bilingual print DOM verified; full-width reader search/layout restored';
    });
  } finally {
    try {
      for (const page of pages) await page.close();
      await sw.evaluate(async ({ key, previous }) => {
        if (previous[key] === undefined) await chrome.storage.local.remove(key);
        else await chrome.storage.local.set(previous);
      }, { key, previous });
    } finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  }
  return { checks, errors };
}
