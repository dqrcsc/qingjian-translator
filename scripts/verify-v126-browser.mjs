import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { readZipArchive } from '../studio/epub-engine.js';
import { makeAcademicPdfFixture } from '../tests/academic-pdf-fixture.mjs';
import { makeLongPdfFixture } from '../tests/long-pdf-fixture.mjs';

export async function verifyV126Browser(context, sw) {
  const checks = [], errors = [], pages = [], calls = [];
  const settingsKey = 'immersive_gemini_settings_v1';
  const saved = await sw.evaluate(key => chrome.storage.local.get(key), settingsKey);
  let mode = 'normal', translations = ['Arriba', 'Ir', 'IA'], labelCount = 20;
  let releaseHeld, heldArrival, notifyHeld;
  const server = http.createServer(async (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Content-Type': 'application/json' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      const gemini = Boolean(body.contents);
      const content = gemini ? body.contents[0].parts : body.messages.at(-1).content;
      const prompt = Array.isArray(content) ? content.map(p => p.text || '').join('') : content;
      const vision = Array.isArray(content) && content.some(p => p.inlineData || p.type === 'image_url');
      calls.push({ mode, gemini, prompt, vision });
      if (mode.startsWith('held') && prompt.includes('PageSentinel9')) {
        notifyHeld(); await new Promise(resolve => { releaseHeld = resolve; });
        if (mode === 'held-failure') { res.writeHead(400, cors); res.end('{"error":{"message":"fixture rejected page"}}'); return; }
      }
      let answer;
      if (prompt.includes('Selected Text:')) answer = mode === 'selection-invalid' ? {} : { translation: '河岸', contextualMeaning: '这里指河流的岸边。', breakdown: [] };
      else if (prompt.includes('extract ALL content')) {
        assert.match(prompt, /ALL meaningful/); assert.match(prompt, /ANY source language/);
        assert.doesNotMatch(prompt, /at most 10|ONLY the key English/);
        answer = mode === 'toc'
          ? Array.from({ length: 120 }, (_, i) => ({ page: 1, type: 'heading', original: `Section ${i + 1}`, translation: `章节 ${i + 1}` }))
          : [{ page: 1, type: 'figure', original: '日本語の図', translation: 'Figura', figureBox2d: [430, 160, 610, 680],
            figureLabels: Array.from({ length: labelCount }, (_, i) => ({ original: `日本語 ${i}`, translation: `Texto ${i}`, box_2d: [440 + Math.floor(i / 5) * 37, 170 + i % 5 * 95, 465 + Math.floor(i / 5) * 37, 250 + i % 5 * 95] })) }];
      } else if (vision) answer = { hasText: true, regions: ['Up', 'Go', 'AI'].map((original, i) => ({ original, translation: translations[i], box_2d: [20 + i * 200, 30, 100 + i * 200, 200] })) };
      else answer = JSON.parse(prompt.split('Input JSON:\n')[1]).map(item => ({ id: item.id, translation: `译文：${item.text}` }));
      res.writeHead(200, cors);
      res.end(JSON.stringify(gemini ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(answer) }] } }] }
        : { choices: [{ message: { content: JSON.stringify(answer) } }] }));
    } catch (error) { errors.push(error.message); res.writeHead(500, cors); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, id = new URL(sw.url()).host;
  const settings = { providerId: 'custom', apiProtocol: 'openai', apiBaseUrl: base + '/v1', apiKey: 'fixture', modelId: 'fixture', targetLang: 'zh-CN', enableCache: false,
    enableSelectionTooltip: true, enableFloatingBall: false, autoTranslateAllPages: false, enableYoutubeDualSub: true, youtubeAutoEnable: false, youtubeShowSidebar: true };
  const save = values => sw.evaluate(({ key, values }) => chrome.storage.local.set({ [key]: values }), { key: settingsKey, values });
  const check = label => { checks.push(label); console.log(`  ✓ ${label}`); };
  const newPage = async () => { const p = await context.newPage(); pages.push(p); p.setDefaultTimeout(15000); p.on('pageerror', e => errors.push(e.message)); return p; };
  const page = await newPage();
  const upload = async (buffer, name = 'fixture.pdf') => {
    await page.goto(`chrome-extension://${id}/studio/studio.html`);
    await page.locator('#fileInput').setInputFiles({ name, mimeType: 'application/pdf', buffer });
    await page.waitForFunction(() => document.querySelector('#workspaceSplitMain').dataset.documentState === 'ready');
  };
  const download = async format => {
    const done = page.waitForEvent('download');
    await page.locator('#exportMenuBtn').click(); await page.locator(`[data-export="${format}"]`).click();
    return fs.readFile(await (await done).path(), format === 'epub' ? undefined : 'utf8');
  };
  const printedText = bytes => page.evaluate(async bytes => {
    const { openPdfDocument } = await import('./pdf-engine.js');
    const { pdfDoc } = await openPdfDocument(new Uint8Array(bytes).buffer);
    try {
      const texts = [];
      for (let n = 1; n <= pdfDoc.numPages; n++) {
        const p = await pdfDoc.getPage(n); texts.push((await p.getTextContent()).items.map(i => i.str).join(' ')); p.cleanup();
      }
      return texts.join('\n');
    } finally { await pdfDoc.destroy(); }
  }, [...bytes]);
  try {
    for (const protocol of ['openai', 'gemini']) {
      await save({ ...settings, apiProtocol: protocol, apiBaseUrl: base + (protocol === 'gemini' ? '/v1beta' : '/v1') });
      mode = 'selection-invalid';
      const web = await newPage();
      await web.route('https://selection.v126.example/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><p id="word">The river bank was flooded.</p>' }));
      await web.goto('https://selection.v126.example/test'); await web.locator('.ig-sel-trigger').waitFor({ state: 'attached' });
      const before = await sw.evaluate(() => chrome.storage.local.get('immersive_gemini_stats_v1'));
      await web.evaluate(() => {
        const text = document.querySelector('#word').firstChild, range = document.createRange(); range.setStart(text, 10); range.setEnd(text, 14);
        getSelection().removeAllRanges(); getSelection().addRange(range);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 80, clientY: 80 }));
      });
      await web.locator('.ig-sel-trigger').click(); await web.locator('[data-selection-retry]').waitFor();
      assert.match(await web.locator('.ig-sel-card').textContent(), /响应格式无效/); assert.equal(await web.locator('.ig-sel-trans').count(), 0);
      const after = await sw.evaluate(() => chrome.storage.local.get('immersive_gemini_stats_v1'));
      for (const field of ['totalParagraphs', 'estimatedCharsTranslated']) assert.equal(after.immersive_gemini_stats_v1?.[field] || 0, before.immersive_gemini_stats_v1?.[field] || 0);
      mode = 'normal'; await web.locator('[data-selection-retry]').click(); await web.locator('.ig-sel-trans').getByText('河岸').waitFor();
      check(`${protocol} actual selection rejects empty explanation without success counting; visible retry recovers`);
      await web.close();
    }
    const image = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 600; c.height = 260;
      const g = c.getContext('2d'); g.fillStyle = 'white'; g.fillRect(0, 0, 600, 260); g.fillStyle = 'black'; g.font = '20px sans-serif';
      ['Up', 'Go', 'AI'].forEach((text, i) => g.fillText(text, 20, 30 + i * 60));
      return { png: c.toDataURL().split(',')[1], jpeg: c.toDataURL('image/jpeg').split(',')[1] };
    });
    for (const [language, labels] of [['es', ['Arriba', 'Ir', 'IA']], ['ja', ['上', '行く', '人工知能']], ['ar', ['أعلى', 'اذهب', 'ذكاء']]]) {
      translations = labels; await save({ ...settings, targetLang: language });
      await upload(makeAcademicPdfFixture(), 'unprocessed.pdf');
      await page.locator('#figureImageInput').setInputFiles({ name: 'short-labels.png', mimeType: 'image/png', buffer: Buffer.from(image.png, 'base64') });
      await page.waitForFunction(() => document.querySelector('#docStatusSubtitle').textContent.includes('已处理 3 处'));
      assert.equal(await page.locator('.paper-fig-hover-hotspot').count(), 3);
      const html = await download('html'); for (const label of labels) assert.ok(html.includes(label));
      assert.match(html, /第 1 页正文未完成翻译/);
      if (language === 'es') {
        const md = await download('md'), epub = await download('epub');
        assert.match(md, /未处理或失败页：1/);
        const zip = await readZipArchive(Uint8Array.from(epub).buffer);
        const texts = await Promise.all([...zip].filter(([name]) => name.endsWith('.xhtml')).map(([, value]) => value.getText()));
        assert.match(texts.join(''), /未处理或失败页：1/);
        assert.equal(await page.locator('#progressCounterBadge').textContent(), '0 / 1 页');
      }
      await page.locator('[data-retry-figure]').click();
      await page.waitForFunction(() => document.querySelector('#docStatusSubtitle').textContent.includes('此图文字处理完成'));
      assert.equal(await page.locator('.paper-fig-hover-hotspot').count(), 3);
      check(`${language} real image attachment/retry retains all short labels; HTML preserves regions and flags unfinished PDF body`);
    }
    check('Actual MD and EPUB downloads mark attached-only PDF body missing, while progress remains 0/1');
    // Hold only print image decoding; imports and the reading image use the native decoder.
    await page.locator('#startTranslateDocBtn').click();
    await page.waitForFunction(() => document.querySelector('#progressCounterBadge').textContent === '1 / 1 页');
    await page.evaluate(() => {
      window.__printCalls = 0; window.print = () => window.__printCalls++;
      window.__nativeDecode = HTMLImageElement.prototype.decode; window.__releasePrintImages = [];
      HTMLImageElement.prototype.decode = function () {
        return this.closest('#documentPrintSnapshot') ? new Promise(resolve => window.__releasePrintImages.push(resolve)) : window.__nativeDecode.call(this);
      };
    });
    await page.locator('#exportMenuBtn').click(); await page.locator('[data-export="pdf-bilingual"]').click(); await page.locator('#confirmPdfExportBtn').click();
    await page.waitForFunction(() => window.__releasePrintImages.length > 0);
    assert.equal(await page.locator('#documentPrintSnapshot [id]').count(), 0, 'snapshot cannot receive ID-based reading updates');
    await page.locator('[data-export="pdf-bilingual"]').evaluate(button => button.click());
    assert.match(await page.locator('#docStatusSubtitle').textContent(), /已有 PDF 导出/);
    assert.equal(await page.locator('#documentPrintSnapshot').count(), 1);
    await page.locator('#fileInput').setInputFiles({ name: 'replacement.pdf', mimeType: 'application/pdf', buffer: makeLongPdfFixture(2) });
    await page.waitForFunction(() => document.querySelector('#workspaceSplitMain').dataset.documentState === 'ready');
    await page.evaluate(() => { HTMLImageElement.prototype.decode = window.__nativeDecode; window.__releasePrintImages.forEach(resolve => resolve()); });
    await page.waitForFunction(() => !document.querySelector('#documentPrintSnapshot'));
    assert.equal(await page.evaluate(() => window.__printCalls), 0);
    assert.match(await page.locator('#leftPaneTitle').textContent(), /replacement/);
    check('Pending print-image decoding blocks duplicate PDF exports; replacing the real PDF cancels and releases the snapshot without printing stale content');
    await save({ ...settings, apiProtocol: 'gemini', apiBaseUrl: base + '/v1beta', targetLang: 'es' });
    for (const count of [10, 11, 20]) {
      labelCount = count; mode = 'normal';
      await upload(makeAcademicPdfFixture({ sparse: true, rasterJpeg: Buffer.from(image.jpeg, 'base64'), withFormula: false }), 'sparse-native.pdf');
      await page.locator('#startTranslateDocBtn').click(); await page.waitForFunction(() => document.querySelector('#progressCounterBadge').textContent === '1 / 1 页');
      assert.equal(await page.locator('.paper-fig-hover-hotspot').count(), count);
      assert.ok((await download('html')).includes(`Texto ${count - 1}`));
    }
    check('Native Gemini actual sparse PDF entry and downloaded HTML preserve 10/11/20 labels with uncapped multilingual prompts');
    mode = 'toc'; await upload(makeLongPdfFixture(1, { linesPerPage: 1 }), 'large-index.pdf');
    await page.locator('#startTranslateDocBtn').click(); await page.waitForFunction(() => document.querySelector('#progressCounterBadge').textContent === '1 / 1 页');
    assert.equal(await page.locator('.pdf-toc-item').count(), 100);
    await page.locator('[data-toc-window-step="1"]').click(); assert.equal(await page.locator('.pdf-toc-item').count(), 20);
    await page.locator('.pdf-toc-item').last().click(); assert.equal(await page.locator('#jumpPageInput').inputValue(), '1');
    check('PDF directory with 120 real native headings mounts 100 entries, reaches the final 20 and navigates from the last entry');

    await save(settings); mode = 'normal';
    await upload(makeLongPdfFixture(17, { linesPerPage: 1 }), 'groups.pdf');
    await page.locator('#startTranslateDocBtn').click(); await page.waitForFunction(() => document.querySelector('#progressCounterBadge').textContent === '2 / 17 页');
    await page.locator('[data-reading-step="1"]').click(); assert.equal(await page.locator('#jumpPageInput').inputValue(), '9');
    await page.locator('[data-reading-page]').fill('3'); await page.locator('[data-reading-page]').press('Enter');
    assert.equal(await page.locator('#jumpPageInput').inputValue(), '17');
    assert.equal(await page.locator('#bilingualStreamContainer [data-paper-page]').count(), 1);
    check('Actual PDF group button and numeric group jump synchronize page input to 9 then 17 and retain bounded reading DOM');

    for (const failure of [false, true]) {
      mode = 'normal'; await upload(makeLongPdfFixture(9, { linesPerPage: 1 }), 'concurrent-export.pdf');
      await page.locator('#startTranslateDocBtn').click(); await page.waitForFunction(() => document.querySelector('#progressCounterBadge').textContent === '2 / 9 页');
      heldArrival = new Promise(resolve => { notifyHeld = resolve; }); mode = failure ? 'held-failure' : 'held-success';
      await page.locator('#jumpPageInput').fill('9'); await page.locator('#jumpPageInput').press('Enter'); await page.locator('[data-translate-page="9"]').click(); await heldArrival;
      await page.evaluate(() => { window.__v126Print = null; window.print = () => {
        window.__v126Print = [...document.querySelectorAll('#documentPrintSnapshot [data-paper-page]')].map(p => Number(p.dataset.paperPage));
      }; });
      await page.locator('#exportMenuBtn').click(); await page.locator('[data-export="pdf-bilingual"]').click();
      await page.locator('input[name="pdfExportScope"][value="translated-only"]').check();
      await page.locator('#confirmPdfExportBtn').click(); await page.waitForFunction(() => document.title.includes('双语对照排版'));
      releaseHeld();
      // Download HTML through its actual handler while a PDF snapshot is alive.
      const htmlEvent = page.waitForEvent('download');
      await page.locator('[data-export="html"]').evaluate(button => button.click());
      const html = await fs.readFile(await (await htmlEvent).path(), 'utf8'); assert.ok(html.includes('PageSentinel1'));
      await page.waitForFunction(() => window.__v126Print !== null);
      assert.deepEqual(await page.evaluate(() => window.__v126Print), [1, 2]);
      const bytes = await page.pdf({ format: 'A4', printBackground: true });
      const text = await printedText(bytes); assert.match(text, /PageSentinel1 /); assert.match(text, /PageSentinel2 /); assert.doesNotMatch(text, /PageSentinel9 /);
      await page.waitForFunction(() => !document.querySelector('#documentPrintSnapshot'));
      assert.equal(await page.locator('#jumpPageInput').inputValue(), '9');
      check(`Concurrent page-9 ${failure ? 'failure' : 'success'} and HTML download cannot alter the confirmed PDF range; reopened generated PDF contains only pages 1/2`);
    }
    mode = 'normal';
    const yt = await newPage(); let captionCalls = 0, oversized = true;
    await yt.route('https://www.youtube.com/**', async route => {
      if (route.request().url().includes('/api/timedtext')) {
        captionCalls++;
        await route.fulfill({ contentType: 'application/json', body: oversized ? ' '.repeat(8 * 1024 * 1024 + 1)
          : JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Recovered complete subtitle.' }] }] }) });
      } else await route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Budget fixture</title><div id="movie_player" class="html5-video-player"><video></video><div class="ytp-right-controls"></div></div><script>
        const track = { languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=budget126&lang=en' };
        const player = document.getElementById('movie_player');
        player.getPlayerResponse = () => ({ videoDetails: { videoId: 'budget126' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [track] } } });
        player.getOption = (_, key) => key === 'track' ? track : [track];
        </script>` });
    });
    await yt.goto('https://www.youtube.com/watch?v=budget126');
    await yt.locator('.ig-yt-translation-error').filter({ hasText: '字节预算' }).waitFor();
    assert.equal(captionCalls, 1);
    oversized = false; await yt.locator('.ig-yt-translation-error button').click();
    await yt.locator('.ig-yt-cue-item').filter({ hasText: 'Recovered complete subtitle.' }).waitFor();
    assert.equal(captionCalls, 2);
    check('Actual MAIN-world subtitle download surfaces byte limit, deduplicates repeated extraction, and explicit retry restores the complete timeline');
    assert.deepEqual(errors, []);
    return { checks, errors };
  } finally {
    releaseHeld?.();
    for (const p of pages) if (!p.isClosed()) await p.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await sw.evaluate(saved => chrome.storage.local.set(saved), saved);
  }
}
