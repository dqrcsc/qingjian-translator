import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';

export async function verifyYoutubeTimelineBrowser(context, sw) {
  const checks = [], errors = [];
  const check = text => { checks.push(text); console.log(`  ✓ ${text}`); };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); res.end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const prompt = JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content;
    const answer = [...prompt.matchAll(/"id"\s*:\s*(\d+)/g)].map(match => ({ id: Number(match[1]), translation: `译文 ${match[1]} ` + '动态变长译文，完整保留。'.repeat(60) }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const cdp = await context.newCDPSession(page);
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: e }) => errors.push(e.exception?.description || e.text));
  await cdp.send('Runtime.enable');
  await page.setViewportSize({ width: 1300, height: 1000 });
  await page.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Long timeline fixture</title><div id="movie_player" class="html5-video-player"><video></video><div class="ytp-right-controls"></div></div>' }));
  try {
    await sw.evaluate(value => chrome.storage.local.set({ immersive_gemini_settings_v1: value }), {
      providerId: 'custom', apiProtocol: 'openai', apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture', modelId: 'fixture', enableCache: false,
      enableYoutubeDualSub: true, youtubeAutoEnable: false, youtubeShowSidebar: true, enableFloatingBall: false, autoTranslateAllPages: false
    });
    await page.goto('https://www.youtube.com/watch?v=long-timeline');
    await page.locator('.ig-yt-timeline-panel').waitFor({ state: 'visible' });
    await page.evaluate(() => {
      window.timelineSeeks = [];
      window.addEventListener('message', e => { if (e.data?.type === 'SEEK_VIDEO_TO') timelineSeeks.push(e.data.seconds); });
      window.postMessage({ source: 'IG_YT_MAIN_BRIDGE', type: 'YT_CUES_LOADED', payload: { videoId: 'long-timeline', cues:
        Array.from({ length: 5000 }, (_, id) => ({ id, start: id * 2, end: id * 2 + 1.9, text: `Unique cue ${id}. ` + (id === 2500 ? 'Very long caption text remains readable. '.repeat(150) : 'English source. '.repeat(id % 4 + 1)) })) } }, '*');
    });
    await page.waitForFunction(() => document.querySelector('[data-yt-coverage]')?.textContent.includes('5000 条'));
    const rows = page.locator('.ig-yt-cue-item'), list = page.locator('[data-yt-list]');
    const initialCount = await rows.count();
    assert.ok(initialCount <= 40, `5000 source cues must not all mount (actual: ${initialCount})`);
    assert.equal(await rows.first().getAttribute('data-cue-id'), '0');
    for (const fraction of [0.25, 0.75, 1, 0.5, 0]) {
      await list.evaluate((el, f) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * f; }, fraction);
      await page.waitForTimeout(160);
      assert.ok(await rows.count() <= 40);
      if (fraction === 1) await page.locator('.ig-yt-cue-item[data-cue-id="4999"]').waitFor();
    }
    await page.locator('.ig-yt-cue-item[data-cue-id="0"]').waitFor();
    check('5000-cue real timeline keeps at most 40 mounted rows through forward/backward scrolling and reaches both endpoints');

    await page.locator('[data-yt-search]').fill('Unique cue 4321.');
    await page.locator('.ig-yt-cue-item[data-cue-id="4321"]').waitFor();
    assert.equal(await rows.count(), 1);
    await rows.first().click();
    await page.waitForFunction(() => window.timelineSeeks.includes(8642));
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-act="export-srt"]').click(); await page.locator('[data-export-fmt="srt"]').click();
    const artifact = await downloadPromise, text = await fs.readFile(await artifact.path(), 'utf8');
    assert.equal((text.match(/ --> /g) || []).length, 5000);
    assert.match(text, /Unique cue 0\./); assert.match(text, /Unique cue 4999\./);
    check('Distant search and actual seek work while SRT download retains all 5000 cues outside the filtered virtual window');

    await page.locator('[data-yt-search]').fill('Unique cue 2500.');
    const long = page.locator('.ig-yt-cue-item[data-cue-id="2500"]'); await long.waitFor();
    const sourceHeight = await long.evaluate(el => el.getBoundingClientRect().height);
    assert.ok(sourceHeight > 1000, 'long row must retain full text height');
    assert.equal(await long.evaluate(el => el.scrollHeight <= el.clientHeight + 1), true, 'row is not clipped');
    await page.locator('[data-yt-search]').fill('');
    await page.evaluate(() => { document.querySelector('video').currentTime = 5000.1; });
    await page.locator('.ig-yt-ctrl-pill > span').nth(1).click();
    await page.waitForFunction(() => document.querySelector('.ig-yt-cue-item[data-cue-id="2500"]')?.classList.contains('is-current'));
    await page.waitForFunction(() => document.querySelector('.ig-yt-cue-item[data-cue-id="2500"] .ig-yt-cue-trans')?.textContent.includes('动态变长译文'));
    await page.waitForTimeout(250);
    assert.ok(await rows.count() <= 40);
    assert.ok(await long.evaluate(el => el.getBoundingClientRect().height) > sourceHeight);
    assert.equal(await long.evaluate(el => el.scrollHeight <= el.clientHeight + 1), true);
    await page.setViewportSize({ width: 900, height: 760 });
    await page.waitForTimeout(200);
    assert.ok(await rows.count() <= 40);
    check('Playback locates an offscreen current cue; very long source and growing translation remain unclipped with measured heights after resize');

    await page.locator('[data-act="close"]').click(); assert.equal(await rows.count(), 0);
    // The deliberately enormous caption can cover controls in this minimal player fixture.
    await page.locator('.ig-yt-ctrl-btn').dispatchEvent('click');
    await page.locator('[data-open-list]').click();
    await page.waitForFunction(() => document.querySelectorAll('.ig-yt-cue-item').length > 0);
    assert.ok(await rows.count() <= 40);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('yt-navigate-start')); history.pushState({}, '', '/watch?v=replacement-timeline'); window.dispatchEvent(new Event('yt-navigate-finish'));
    });
    await page.waitForFunction(() => document.querySelectorAll('.ig-yt-cue-item').length === 0);
    await page.evaluate(() => window.postMessage({ source: 'IG_YT_MAIN_BRIDGE', type: 'YT_CUES_LOADED', payload: { videoId: 'replacement-timeline', cues: [{ id: 0, start: 0, end: 2, text: 'Replacement cue only' }] } }, '*'));
    await page.waitForFunction(() => document.querySelector('.ig-yt-cue-orig')?.textContent === 'Replacement cue only');
    assert.equal(await rows.count(), 1);
    check('Closing sidebar releases mounted timeline rows; reopening restores data, and navigation replaces the old virtual session');
    assert.deepEqual(errors, []); return { checks, errors };
  } finally { await page.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
