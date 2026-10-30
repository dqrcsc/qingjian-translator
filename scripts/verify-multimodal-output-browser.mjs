import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { makePdfFixture } from '../tests/pdf-fixture.mjs';

// Actual studio uploads -> worker Port -> Gemini/OpenAI HTTP -> rendered state/download.
export async function verifyMultimodalOutputBrowser(context, sw) {
  const checks = [], errors = [], calls = [];
  let mode = 'pdf-empty';
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); res.end(); return; }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      const native = Boolean(body.contents);
      const prompt = native ? body.contents[0].parts.map(p => p.text || '').join('')
        : body.messages.at(-1).content.filter(p => p.type === 'text').map(p => p.text).join('');
      const pdf = prompt.includes('Carefully read the attached academic page');
      const page = Number(prompt.match(/academic page \(Page (\d+)/)?.[1] || 1);
      calls.push({ mode, native, pdf, page });
      let answer;
      if (pdf) {
        const valid = { page, type: 'paragraph', original: `PDF source page ${page}`, translation: `有效 PDF 译文 ${page}` };
        answer = mode === 'pdf-empty' ? [{ ...valid, translation: '' }]
          : mode === 'pdf-partial' ? [{ ...valid, translation: '不应提交的部分新译文' }, { ...valid, original: 'Missing second translation', translation: '' }]
          : mode === 'pdf-code' ? [{ page, type: 'equation', original: '$$x=1$$', translation: '' }, { page, type: 'code', original: '  return x;\n', translation: '' }]
          : [valid];
      } else {
        const region = { original: 'Visible English label', translation: '可见文字译文', box_2d: [100, 100, 400, 900] };
        answer = mode === 'image-empty' ? { hasText: true, regions: [{ ...region, translation: '' }] }
          : mode === 'image-bad-box' ? { hasText: true, regions: [{ ...region, box_2d: [400, 100, 100, 900] }] }
          : mode === 'image-no-text' ? { hasText: false, regions: [], summaryTranslation: '' }
          : { hasText: true, regions: [region], summaryTranslation: '图片内容摘要' };
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(native ? { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] } }] }
        : { choices: [{ message: { content: JSON.stringify(answer) } }] }));
    } catch (error) {
      errors.push(error.message); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Invalid mock request' } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const configure = protocol => sw.evaluate(({ base, protocol }) => chrome.storage.local.set({ immersive_gemini_settings_v1: {
    providerId: 'custom', apiProtocol: protocol, apiBaseUrl: base + (protocol === 'gemini' ? '/v1beta' : '/v1'),
    apiKey: 'local-fixture-only', modelId: protocol === 'gemini' ? 'gemini-output-fixture' : 'vision-output-fixture',
    targetLang: 'zh-CN', enableCache: false, enableFloatingBall: false, autoTranslateAllPages: false
  } }), { base, protocol });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  const check = label => { checks.push(label); console.log(`  ✓ ${label}`); };
  const upload = async (name, buffer) => {
    await page.locator('#fileInput').setInputFiles({ name, mimeType: name.endsWith('.pdf') ? 'application/pdf' : 'text/markdown', buffer });
    await page.waitForFunction(() => document.querySelector('#workspaceSplitMain').dataset.documentState === 'ready');
  };
  const downloadHtml = async () => {
    const event = page.waitForEvent('download'); await page.locator('#exportMenuBtn').click(); await page.locator('[data-export="html"]').click();
    return fs.readFile(await (await event).path(), 'utf8');
  };
  try {
    await configure('gemini'); await page.goto(`chrome-extension://${new URL(sw.url()).host}/studio/studio.html`);
    await upload('native-output.pdf', makePdfFixture()); await page.locator('#startTranslateDocBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('.paper-page-lazy-placeholder .paper-lazy-title').length === 2 && [...document.querySelectorAll('.paper-lazy-title')].every(el => el.textContent.includes('翻译失败')));
    assert.equal(await page.locator('#progressCounterBadge').textContent(), '0 / 2 页');
    const failedCalls = calls.length; await page.waitForTimeout(250); assert.equal(calls.length, failedCalls); assert.equal(failedCalls, 2);
    assert(calls.every(call => call.native && call.pdf));
    check('Native Gemini empty PDF translations fail through actual upload/HTTP, remain 0/2 complete and stop without automatic retry');

    mode = 'pdf-ok'; await page.locator('#startTranslateDocBtn').click();
    await page.waitForFunction(() => document.querySelector('#progressCounterBadge').textContent === '2 / 2 页');
    const oldTranslations = await page.locator('#bilingualStreamContainer .stream-trans').allTextContents();
    assert.deepEqual(oldTranslations, ['有效 PDF 译文 1', '有效 PDF 译文 2']);
    check('Explicit retry replaces native Gemini PDF failures with valid translations and completes only after valid results');

    mode = 'pdf-partial'; await page.locator('#startTranslateDocBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('.paper-page-failure').length === 2);
    assert.equal(await page.locator('#progressCounterBadge').textContent(), '0 / 2 页');
    assert.deepEqual(await page.locator('#bilingualStreamContainer .stream-trans').allTextContents(), oldTranslations);
    const html = await downloadHtml(); assert.match(html, /有效 PDF 译文 1/); assert.match(html, /本页重译失败/); assert.doesNotMatch(html, /不应提交的部分新译文/);
    check('Partially translated native PDF output is rejected atomically; previous page content survives and actual HTML export marks failed retranslation');

    mode = 'pdf-code'; await upload('equations-and-code.pdf', makePdfFixture()); await page.locator('#startTranslateDocBtn').click();
    await page.waitForFunction(() => document.querySelector('#progressCounterBadge').textContent === '2 / 2 页');
    assert.equal(await page.locator('#bilingualStreamContainer .untranslated-label').count(), 0);
    assert.equal(await page.locator('#bilingualStreamContainer pre').count(), 2);
    assert.equal(await page.locator('#bilingualStreamContainer pre').first().textContent(), '  return x;\n');
    assert.match(await downloadHtml(), /return x;/);
    check('Native Gemini equation/code-only pages preserve their exact source without false untranslated labels and export successfully');

    const png = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 260; c.height = 100; const g = c.getContext('2d'); g.fillStyle = 'white'; g.fillRect(0, 0, 260, 100); g.fillStyle = 'black'; g.fillText('Visible English label', 25, 25); return c.toDataURL().split(',')[1]; }), 'base64');
    const uploadImage = () => page.locator('#figureImageInput').setInputFiles({ name: 'image.png', mimeType: 'image/png', buffer: png });
    for (const protocol of ['gemini', 'openai']) {
      await configure(protocol); await upload(`images-${protocol}.md`, Buffer.from('Existing document source remains readable.'));
      mode = 'image-empty'; await uploadImage(); await page.waitForFunction(() => document.querySelector('#docStatusSubtitle').textContent.includes('图表翻译失败'));
      assert.equal(await page.locator('.paper-figure-box').count(), 0);
      assert.match(await page.locator('#bilingualStreamContainer').textContent(), /Existing document source/);
      assert.doesNotMatch(await page.locator('#docStatusSubtitle').textContent(), /未发现需要翻译/);
      mode = 'image-ok'; await uploadImage(); await page.waitForFunction(() => document.querySelector('#docStatusSubtitle').textContent.includes('图中文字覆盖翻译完成'));
      assert.equal(await page.locator('.paper-figure-box').count(), 1);
      const oldImage = await page.locator('.paper-fig-bg-img').getAttribute('src');
      mode = 'image-bad-box'; await uploadImage(); await page.waitForFunction(() => document.querySelector('#docStatusSubtitle').textContent.includes('图表翻译失败'));
      assert.equal(await page.locator('.paper-figure-box').count(), 1); assert.equal(await page.locator('.paper-fig-bg-img').getAttribute('src'), oldImage);
      assert.match(await downloadHtml(), /可见文字译文/);
      check(`${protocol} actual image upload rejects empty translation and invalid box, supports explicit retry, and preserves prior figure/export on failure`);
      mode = 'image-no-text'; await uploadImage(); await page.waitForFunction(() => document.querySelector('#docStatusSubtitle').textContent.includes('未发现需要翻译'));
      assert.equal(await page.locator('.paper-figure-box').count(), 2);
      check(`${protocol} genuine no-text image remains a successful original-image result instead of a translation error`);
    }
    assert.deepEqual(errors, []);
    return { checks, errors };
  } finally { await page.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
