import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../content/youtube-page-bridge.js', import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const timedtext = (text) => JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: text }] }] });
const track = (languageCode, kind, videoId = 'A') => ({
  languageCode, kind, vssId: `${kind === 'asr' ? 'a' : ''}.${languageCode}`,
  baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${languageCode}${kind ? `&kind=${kind}` : ''}`
});

function harness(tracks = [], selected = null) {
  const listeners = new Map();
  const requests = [];
  const messages = [];
  const selections = [];
  let responseVideoId = 'A';
  let currentTracks = tracks;
  const player = {
    getPlayerResponse: () => ({ videoDetails: { videoId: responseVideoId }, captions: { playerCaptionsTracklistRenderer: { captionTracks: currentTracks } } }),
    getOption: (_module, key) => key === 'tracklist' ? currentTracks : selected,
    setOption: (_module, _key, value) => { selections.push(value); selected = value; },
    loadModule() {}
  };
  class FakeXHR {
    listeners = new Map();
    open() {}
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    removeEventListener(name, fn) { if (this.listeners.get(name) === fn) this.listeners.delete(name); }
    finish(text) { this.responseText = text; this.listeners.get('load')?.call(this); }
  }
  const window = {
    location: new URL('https://www.youtube.com/watch?v=A'),
    addEventListener(name, fn) { const group = listeners.get(name) || []; group.push(fn); listeners.set(name, group); },
    postMessage(value) { messages.push(value); },
    fetch(url, options) {
      return new Promise((resolve) => requests.push({ url: String(url), options, resolve }));
    }
  };
  const fire = (type, data) => { for (const listener of listeners.get(type) || []) listener(data || {}); };
  vm.runInNewContext(source, {
    window, XMLHttpRequest: FakeXHR, URL, AbortController,
    document: { title: 'Bridge fixture - YouTube', getElementById: () => player, querySelector: () => null },
    setTimeout() {}, setInterval() {}
  });
  return {
    window, requests, messages, selections, FakeXHR,
    loaded: () => messages.filter((m) => m.type === 'YT_CUES_LOADED'),
    fire,
    extract() { fire('message', { source: window, data: { source: 'IG_YT_CONTENT_SCRIPT', type: 'REQUEST_YT_TRACKS' } }); },
    navigate(videoId, updatePlayer = true) {
      fire('yt-navigate-start');
      window.location = new URL(`https://www.youtube.com/watch?v=${videoId}`);
      if (updatePlayer) {
        responseVideoId = videoId;
        currentTracks = tracks.map((t) => ({ ...t, baseUrl: t.baseUrl.replace('v=A', `v=${videoId}`) }));
      }
      fire('yt-navigate-finish');
    },
    select(value) { selected = value; },
    reply(index, text = 'Original cue from request.') {
      const body = timedtext(text);
      requests[index].resolve({ ok: true, text: async () => body, clone: () => ({ text: async () => body }) });
    }
  };
}

for (const route of [['B'], ['B', 'A']]) {
  test(`bridge-initiated fetch discards stale A after ${route.join(' → ')}`, async () => {
    const h = harness([track('en')]);
    h.extract();
    assert.equal(h.requests.length, 1);
    for (const id of route) h.navigate(id);
    h.reply(0);
    await tick();
    assert.equal(h.loaded().length, 0);
    assert.equal(h.requests.length, 1, 'no stale fallback request');
  });
  test(`intercepted fetch discards stale A after ${route.join(' → ')}`, async () => {
    const h = harness();
    const pending = h.window.fetch(track('en').baseUrl);
    for (const id of route) h.navigate(id);
    h.reply(0);
    await pending;
    await tick();
    assert.equal(h.loaded().length, 0);
  });
  test(`intercepted XHR discards stale A after ${route.join(' → ')}`, async () => {
    const h = harness();
    const xhr = new h.FakeXHR();
    xhr.open('GET', track('en').baseUrl);
    for (const id of route) h.navigate(id);
    xhr.finish(timedtext('Old XHR caption.'));
    await tick();
    assert.equal(h.loaded().length, 0);
  });
}

test('navigation during response body reading also discards old data', async () => {
  const h = harness([track('en')]);
  h.extract();
  let finishBody;
  h.requests[0].resolve({ ok: true, text: () => new Promise((resolve) => { finishBody = resolve; }) });
  await tick();
  h.navigate('B');
  h.navigate('A');
  finishBody(timedtext('Late body caption.'));
  await tick();
  assert.equal(h.loaded().length, 0);
});

test('Japanese ASR is preferred to unrelated English manual captions', async () => {
  const h = harness([track('en'), track('ja', 'asr')]);
  h.extract();
  assert.equal(new URL(h.requests[0].url).searchParams.get('lang'), 'ja');
  h.reply(0, 'これは日本語の字幕です。');
  await tick();
  assert.equal(h.loaded()[0].payload.languageCode, 'ja');
});

test('manual captions in the ASR language remain preferred', () => {
  const h = harness([track('en'), track('ja', 'asr'), track('ja')]);
  h.extract();
  const url = new URL(h.requests[0].url);
  assert.equal(url.searchParams.get('lang'), 'ja');
  assert.equal(url.searchParams.has('kind'), false);
});

test('explicit current Chinese or Arabic track is preserved and accepted', async () => {
  for (const [language, text] of [['zh', '这是真实的中文原始字幕。'], ['ar', 'هذه ترجمة عربية أصلية صحيحة']]) {
    const chosen = track(language);
    const h = harness([track('en', 'asr'), chosen], chosen);
    h.extract();
    assert.equal(new URL(h.requests[0].url).searchParams.get('lang'), language);
    h.reply(0, text);
    await tick();
    assert.equal(h.loaded()[0].payload.cues[0].text, text);
    assert.equal(h.selections.length, 0, 'must not override the current player selection');
  }
});

test('stale player metadata is not fetched for the next video', () => {
  const h = harness([track('en')]);
  h.navigate('B', false);
  h.extract();
  assert.equal(h.requests.length, 0);
});

test('valid current fetch and XHR still dispatch source-bound cues', async () => {
  const h = harness([track('en')]);
  const pending = h.window.fetch(track('en').baseUrl);
  h.reply(0);
  await pending;
  await tick();
  const xhr = new h.FakeXHR();
  xhr.open('GET', track('en').baseUrl);
  xhr.finish(timedtext('Current XHR caption.'));
  assert.equal(h.loaded().length, 2);
  assert.equal(h.loaded()[0].payload.videoId, 'A');
  assert.equal(h.loaded()[1].payload.videoId, 'A');
});

test('navigate-start invalidates while the address bar still contains the old video', async () => {
  const h = harness([track('en')]);
  h.extract();
  h.fire('yt-navigate-start');
  assert.equal(h.window.location.search, '?v=A');
  h.reply(0);
  await tick();
  h.extract();
  assert.equal(h.loaded().length, 0);
  assert.equal(h.requests.length, 1, 'no extraction while navigation is pending');
});

test('timedtext URLs without v still bind to the originating navigation generation', async () => {
  const h = harness();
  const pending = h.window.fetch('https://www.youtube.com/api/timedtext?lang=en');
  h.navigate('B');
  h.navigate('A');
  h.reply(0);
  await pending;
  await tick();
  assert.equal(h.loaded().length, 0);
  const current = h.window.fetch('https://www.youtube.com/api/timedtext?lang=en');
  h.reply(1);
  await current;
  await tick();
  assert.equal(h.loaded()[0].payload.videoId, 'A');
});

test('an explicitly mismatching timedtext video id cannot be relabeled', async () => {
  const h = harness();
  const pending = h.window.fetch(track('en', undefined, 'B').baseUrl);
  h.reply(0);
  await pending;
  await tick();
  assert.equal(h.loaded().length, 0);
});

test('external timedtext requests are still intercepted while bridge fetch is pending', async () => {
  const h = harness([track('en')]);
  h.extract();
  const external = h.window.fetch(track('en').baseUrl);
  h.reply(1, 'Concurrent external caption.');
  await external;
  await tick();
  assert.equal(h.loaded()[0].payload.cues[0].text, 'Concurrent external caption.');
  h.reply(0);
  await tick();
});

test('changing the selected language invalidates pending output and cached replay', async () => {
  const chosen = track('zh');
  const h = harness([track('en', 'asr'), chosen]);
  h.extract();
  h.select(chosen);
  h.extract();
  h.reply(1, '当前选择的中文。');
  await tick();
  h.reply(0, 'Old English cue.');
  await tick();
  assert.equal(h.loaded().length, 1);
  assert.equal(h.loaded()[0].payload.languageCode, 'zh');
  h.extract();
  assert.equal(h.requests.length, 2, 'current track cache is reused');
  assert.equal(h.loaded().at(-1).payload.languageCode, 'zh');
});
