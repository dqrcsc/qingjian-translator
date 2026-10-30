import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';

export async function verifyYoutubeStateBrowser(context, sw) {
  const checks = [], errors = [], calls = [], held = [];
  let marker = '初次译文', hold = false;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); res.end(); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body);
    const prompt = body.messages.at(-1).content, label = marker;
    const answer = [...prompt.matchAll(/"id"\s*:\s*(\d+)/g)].map(m => ({ id: Number(m[1]), translation: label }));
    const reply = () => { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] })); };
    if (hold) held.push(reply); else reply();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let settings = { providerId: 'custom', apiProtocol: 'openai', apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-key', modelId: 'fixture', enableCache: false,
    targetLang: 'zh-CN', youtubeAutoEnable: false, enableYoutubeDualSub: true, youtubeShowSidebar: true, enableFloatingBall: false, autoTranslateAllPages: false };
  const store = async patch => { settings = { ...settings, ...patch }; await sw.evaluate(value => chrome.storage.local.set({ immersive_gemini_settings_v1: value }), settings); };
  const wait = async (fn, label) => { const end = Date.now() + 12000; while (!await fn()) { if (Date.now() > end) throw new Error(`YouTube state timeout: ${label}`); await new Promise(r => setTimeout(r, 25)); } };
  const check = label => { checks.push(label); console.log(`  ✓ ${label}`); };
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const cdp = await context.newCDPSession(page);
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: e }) => errors.push(e.exception?.description || e.text));
  await cdp.send('Runtime.enable');
  await page.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>English title fixture</title><div id="movie_player" class="html5-video-player"><video></video><div class="ytp-right-controls"></div><div class="ytp-caption-window-container"><span class="ytp-caption-segment">Observed English caption</span></div></div>' }));
  try {
    await store({});
    await page.goto('https://www.youtube.com/watch?v=state-fixture');
    await page.locator('.ig-yt-ctrl-pill.is-off').waitFor();
    await page.locator('.ig-yt-timeline-panel').waitFor({ state: 'visible' });
    await page.waitForTimeout(900);
    assert.equal(calls.length, 0);
    check('Saved YouTube auto-off and sidebar-on apply on cold boot without model requests');
    await page.locator('.ig-yt-ctrl-pill > span').nth(1).click();
    await page.waitForFunction(() => document.querySelector('.ig-yt-line-trans')?.textContent === '初次译文');
    await page.waitForFunction(() => document.querySelectorAll('.ig-yt-cue-item').length === 1);
    await page.waitForTimeout(650);
    assert.equal(await page.locator('.ig-yt-cue-item').count(), 1);
    assert.match(await page.locator('[data-yt-coverage]').textContent(), /仅包含已观察/);
    check('Explicit activation translates live captions and records repeated polls only once with partial-coverage notice');
    for (const [patch, label] of [[{ targetLang: 'ja' }, '新目标语言'], [{ modelId: 'replacement-model' }, '新模型'], [{ glossaryText: 'caption=字幕' }, '新术语']]) {
      marker = label;
      await store(patch);
      await page.waitForFunction(label => document.querySelector('.ig-yt-line-trans')?.textContent === label, label);
      assert.equal(await page.locator('.ig-yt-cue-trans').textContent(), label);
    }
    check('Target language, model and glossary changes replace completed live translations through actual background HTTP requests');
    const before = calls.length;
    await store({ enableYoutubeDualSub: false, youtubeShowSidebar: false });
    await page.locator('.ig-yt-ctrl-pill.is-off').waitFor();
    await page.locator('.ig-yt-timeline-panel').waitFor({ state: 'hidden' });
    await page.locator('.ytp-caption-segment').evaluate(el => { el.textContent = 'A new caption while disabled'; });
    await page.waitForTimeout(700); assert.equal(calls.length, before);
    await store({ enableYoutubeDualSub: true, youtubeAutoEnable: true, youtubeShowSidebar: true });
    await page.locator('.ig-yt-ctrl-pill.is-on').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.ig-yt-cue-item').length === 2);
    check('Live settings disable cancels/hides subtitles; re-enable and sidebar preferences take effect without reload');

    await page.locator('[data-yt-search]').fill('Observed English');
    marker = '阿拉伯语译文';
    await page.locator('.ytp-caption-segment').evaluate(el => { el.textContent = 'مرحبا هذا اختبار الترجمة'; });
    await page.waitForFunction(() => document.querySelector('.ig-yt-line-trans')?.textContent === '阿拉伯语译文');
    assert.equal(await page.locator('.ig-yt-cue-item').count(), 1, 'updates preserve search');
    assert.equal(await page.locator('[data-yt-search]').inputValue(), 'Observed English');
    await page.locator('[data-yt-search]').fill('');
    assert.equal(await page.locator('.ig-yt-cue-item').count(), 3);
    check('Arabic captions under an English title translate normally; timeline updates preserve search');
    await page.evaluate(() => { const video = document.querySelector('video'); video.currentTime = 20; video.dispatchEvent(new Event('seeked')); });
    await page.waitForFunction(() => document.querySelectorAll('.ig-yt-cue-item').length === 4);
    let downloads = 0; page.on('download', () => downloads++);
    await page.locator('[data-act="export-srt"]').click();
    assert.equal(downloads, 0, 'opening export menu must not download automatically');
    for (const format of ['txt', 'srt']) {
      const downloadPromise = page.waitForEvent('download'); await page.locator(`[data-export-fmt="${format}"]`).click();
      const download = await downloadPromise; assert.match(download.suggestedFilename(), /observed-partial/);
      const text = await fs.readFile(await download.path(), 'utf8');
      assert.match(text, /Observed English caption/); assert.match(text, /00:00:20,000 -->/);
      if (format === 'txt') assert.match(text, /仅包含已观察/);
      else assert.match(text.replace(/^\uFEFF/, ''), /^1\n00:00:00,000 -->/);
    }
    check('Seek separates observed intervals; real TXT/SRT downloads contain observations and clearly named partial coverage');

    marker = '旧会话迟到'; hold = true;
    await page.locator('.ytp-caption-segment').evaluate(el => { el.textContent = 'Pending old configuration'; });
    await wait(() => held.length > 0, 'held request');
    marker = '新会话有效'; hold = false;
    await store({ targetLang: 'fr' });
    await page.waitForFunction(() => document.querySelector('.ig-yt-line-trans')?.textContent === '新会话有效');
    held.splice(0).forEach(reply => reply());
    await page.waitForTimeout(350);
    assert.equal(await page.locator('.ig-yt-line-trans').textContent(), '新会话有效');
    check('Late old-configuration response cannot overwrite the replacement session');
    await page.evaluate(() => { document.querySelector('.ytp-caption-segment').textContent = ''; history.pushState({}, '', '/watch?v=another-state-fixture'); document.dispatchEvent(new Event('yt-navigate-finish', { bubbles: true })); });
    await page.waitForFunction(() => document.querySelectorAll('.ig-yt-cue-item').length === 0);
    await page.evaluate(() => window.postMessage({ source: 'IG_YT_MAIN_BRIDGE', type: 'YT_CUES_LOADED', payload: { videoId: 'another-state-fixture', cues: [{ id: 0, start: 0, end: 60, text: 'Track source' }] } }, '*'));
    await page.waitForFunction(() => document.querySelector('.ig-yt-cue-trans')?.textContent === '新会话有效');
    marker = '轨道新译文'; await store({ modelId: 'third-model' });
    await page.waitForFunction(() => document.querySelector('.ig-yt-cue-trans')?.textContent === '轨道新译文');
    assert.equal(await page.locator('.ig-yt-cue-item').count(), 1);
    assert.match(await page.locator('[data-yt-coverage]').textContent(), /已加载字幕轨道：1 条，已有译文 1 条/);
    check('Video navigation clears observed records; full tracks replace partial view and retranslate on configuration changes');
    await page.evaluate(() => {
      document.dispatchEvent(new Event('yt-navigate-start', { bubbles: true }));
      history.pushState({}, '', '/watch?v=early-track-fixture');
      document.dispatchEvent(new Event('yt-navigate-finish', { bubbles: true }));
      window.postMessage({ source: 'IG_YT_MAIN_BRIDGE', type: 'YT_CUES_LOADED', payload: { videoId: 'early-track-fixture', cues: [{ id: 0, start: 0, end: 60, text: 'Early new-video track' }] } }, '*');
    });
    await page.waitForFunction(() => document.querySelector('.ig-yt-cue-orig')?.textContent === 'Early new-video track');
    await page.waitForTimeout(1400);
    assert.equal(await page.locator('.ig-yt-cue-orig').textContent(), 'Early new-video track');
    check('Navigation boundary clears old state immediately and retains a new track arriving before the periodic mount');
    assert.deepEqual(errors, []);
    return { checks, errors };
  } finally { await page.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
