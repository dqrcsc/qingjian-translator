import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';

// Actual content entry, MediaRecorder lifecycle, MV3 HTTP and downloaded SRT.
// Capture/model bytes are synthetic; no microphone or paid service is used.
export async function verifyYoutubeAudioBrowser(context, sw) {
  const checks = [], errors = [], requests = [], held = [];
  let hold = false;
  const check = text => { checks.push(text); console.log(`  ✓ ${text}`); };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); res.end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.ok(body.contents[0].parts.some(part => part.inlineData?.mimeType === 'audio/webm' && part.inlineData.data));
      const call = { number: requests.length + 1, aborted: false }; requests.push(call);
      res.on('close', () => { if (!res.writableEnded) call.aborted = true; });
      const reply = () => {
        if (res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ original: `Audio sample ${call.number}`, translation: `音频译文${call.number}` }) }] } }] }));
      };
      if (hold) held.push(reply); else reply();
    } catch (error) { errors.push(error.message); res.writeHead(400); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const cdp = await context.newCDPSession(page), contexts = [];
  cdp.on('Runtime.executionContextCreated', ({ context }) => contexts.push(context));
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: e }) => errors.push(e.exception?.description || e.text));
  await cdp.send('Runtime.enable');
  const until = async (fn, description) => {
    const deadline = Date.now() + 10000;
    while (!await fn()) { if (Date.now() > deadline) throw new Error(`Audio fixture timeout: ${description}`); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  await page.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Audio timing fixture</title><div id="movie_player" class="html5-video-player"><video></video><div class="ytp-right-controls"></div></div>' }));
  try {
    await sw.evaluate(value => chrome.storage.local.set({ immersive_gemini_settings_v1: value }), {
      providerId: 'custom', apiProtocol: 'gemini', apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1beta`, apiKey: 'local-audio', modelId: 'audio-fixture', enableCache: false,
      enableYoutubeDualSub: true, youtubeAutoEnable: false, youtubeShowSidebar: true, enableFloatingBall: false, autoTranslateAllPages: false
    });
    await page.goto('https://www.youtube.com/watch?v=audio-timing');
    await page.locator('[data-act="audio-listen"]').waitFor({ state: 'visible' });
    let world;
    await until(async () => {
      for (const candidate of contexts.filter(item => !item.auxData?.isDefault)) {
        try {
          const probe = await cdp.send('Runtime.evaluate', { contextId: candidate.id, expression: 'Boolean(globalThis.__IMMERSIVE_GEMINI_CONTENT_LOADED__)', returnByValue: true });
          if (probe.result.value) { world = candidate.id; return true; }
        } catch { /* navigation retires the initial about:blank contexts */ }
      }
      return false;
    }, 'content isolated world');
    const evaluate = async expression => {
      const result = await cdp.send('Runtime.evaluate', { contextId: world, expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    await evaluate(`(() => {
      const video = document.querySelector('video');
      globalThis.__audioMedia = { time: 100, paused: false, seeking: false, rate: 2, tracksStopped: 0, timers: new Map(), listeners: new Map(), recorders: [] };
      const state = __audioMedia;
      for (const [name, field] of [['currentTime', 'time'], ['paused', 'paused'], ['seeking', 'seeking'], ['playbackRate', 'rate']]) Object.defineProperty(video, name, { configurable: true, get: () => state[field] });
      Object.defineProperty(video, 'ended', { configurable: true, get: () => false });
      const track = { stop() { state.tracksStopped++; } };
      video.captureStream = () => ({ getAudioTracks: () => [track], getTracks: () => [track] });
      globalThis.MediaStream = class {};
      globalThis.MediaRecorder = class {
        static isTypeSupported() { return true; }
        constructor() { this.state = 'inactive'; state.recorders.push(this); }
        start() { this.state = 'recording'; }
        stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['synthetic audio']) }); this.onstop(); }
      };
      const nativeAdd = video.addEventListener.bind(video), nativeRemove = video.removeEventListener.bind(video);
      video.addEventListener = (name, fn, options) => { state.listeners.set(fn, name); nativeAdd(name, fn, options); };
      video.removeEventListener = (name, fn, options) => { state.listeners.delete(fn); nativeRemove(name, fn, options); };
      const nativeSet = setTimeout, nativeClear = clearTimeout; let id = -1;
      globalThis.setTimeout = (fn, delay, ...args) => { if (delay !== 7000) return nativeSet(fn, delay, ...args); state.timers.set(--id, fn); return id; };
      globalThis.clearTimeout = timer => { if (state.timers.has(timer)) state.timers.delete(timer); else nativeClear(timer); };
      state.event = name => video.dispatchEvent(new Event(name));
      state.tick = time => { state.time = time; const entry = state.timers.entries().next().value; if (!entry) throw new Error('No active audio timer'); state.timers.delete(entry[0]); entry[1](); };
    })()`);
    await page.locator('[data-act="audio-listen"]').click();
    await evaluate('__audioMedia.tick(114)');
    await page.waitForFunction(() => document.querySelector('[data-yt-coverage]')?.textContent.includes('1 条'));
    await evaluate('__audioMedia.time = 118; __audioMedia.paused = true; __audioMedia.event("pause")');
    await page.waitForFunction(() => document.querySelector('[data-yt-coverage]')?.textContent.includes('2 条'));
    assert.equal(await evaluate('__audioMedia.timers.size'), 0);
    await evaluate('__audioMedia.paused = false; __audioMedia.event("playing"); __audioMedia.time = 122; __audioMedia.rate = 0.5; __audioMedia.event("ratechange")');
    await page.waitForFunction(() => document.querySelector('[data-yt-coverage]')?.textContent.includes('3 条'));
    await evaluate('__audioMedia.tick(125.5)');
    await page.waitForFunction(() => document.querySelector('[data-yt-coverage]')?.textContent.includes('4 条'));
    check('Actual audio entry records 2x, paused partial, resumed and 0.5x slices using media timestamps through the Gemini native HTTP path');

    hold = true; await evaluate('__audioMedia.tick(129)');
    await until(() => requests.length === 5, 'pending old-position request');
    await evaluate('__audioMedia.time = 500; __audioMedia.seeking = true; __audioMedia.event("seeking")');
    await until(() => requests[4].aborted, 'seek cancels old audio HTTP');
    held.splice(0).forEach(reply => reply()); hold = false;
    await evaluate('__audioMedia.seeking = false; __audioMedia.event("seeked"); __audioMedia.tick(514)');
    await page.waitForFunction(() => document.querySelector('[data-yt-coverage]')?.textContent.includes('5 条'));
    assert.equal(await page.locator('.ig-yt-cue-orig').filter({ hasText: 'Audio sample 5' }).count(), 0);
    check('Seeking discards the crossing recording and cancels old audio HTTP; subsequent capture starts at the new media position');

    const download = page.waitForEvent('download');
    await page.locator('[data-act="export-srt"]').click(); await page.locator('[data-export-fmt="srt"]').click();
    const artifact = await download, srt = await fs.readFile(await artifact.path(), 'utf8');
    assert.equal((srt.match(/ --> /g) || []).length, 5);
    for (const interval of ['00:01:40,000 --> 00:01:54,000', '00:01:54,000 --> 00:01:58,000', '00:01:58,000 --> 00:02:02,000', '00:02:02,000 --> 00:02:05,500', '00:08:20,000 --> 00:08:34,000']) assert.ok(srt.includes(interval), interval);
    assert.ok(!srt.includes('Audio sample 5'));
    check('Downloaded audio SRT preserves actual media intervals for all recorded slices, including fractional seconds and the seek gap');

    hold = true; await evaluate('__audioMedia.tick(528)'); await until(() => requests.length === 7, 'pending request before stop');
    await page.locator('[data-act="audio-listen"]').click();
    await until(() => requests[6].aborted, 'stop cancels audio HTTP');
    held.splice(0).forEach(reply => reply());
    assert.deepEqual(await evaluate('({ timers: __audioMedia.timers.size, listeners: __audioMedia.listeners.size, tracksStopped: __audioMedia.tracksStopped, recording: __audioMedia.recorders.filter(r => r.state !== "inactive").length })'), { timers: 0, listeners: 0, tracksStopped: 1, recording: 0 });
    check('Stopping audio releases all media listeners, seven-second timers and captured tracks; pending responses cannot append cues');
    assert.deepEqual(errors, []); return { checks, errors };
  } finally { await page.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
