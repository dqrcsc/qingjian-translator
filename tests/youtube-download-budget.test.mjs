import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../content/youtube-page-bridge.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const valid = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: '字幕完整保留。' }] }] });
function harness(fetch) {
  const listeners = new Map(), timers = [], messages = [];
  const track = { languageCode: 'zh', baseUrl: 'https://www.youtube.com/api/timedtext?v=A&lang=zh' };
  const window = { location: new URL('https://www.youtube.com/watch?v=A'), fetch,
    addEventListener(type, fn) { listeners.set(type, fn); }, postMessage(data) { messages.push(data); } };
  const player = { getPlayerResponse: () => ({ videoDetails: { videoId: 'A' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [track] } } }),
    getOption: (_module, key) => key === 'track' ? track : [track] };
  class XHR { open() {} }
  vm.runInNewContext(source, { window, XMLHttpRequest: XHR, URL, AbortController, TextEncoder, TextDecoder, Date: class extends Date { static now() { return 0; } },
    document: { title: 'Fixture', getElementById: () => player }, setInterval() {},
    setTimeout(fn, ms) { const t = { fn, ms, active: true }; timers.push(t); return t; }, clearTimeout(t) { if (t) t.active = false; } });
  return { window, timers, messages,
    extract(retry = false) { listeners.get('message')({ source: window, data: { source: 'IG_YT_CONTENT_SCRIPT', type: 'REQUEST_YT_TRACKS', retry } }); },
    navigate() { listeners.get('yt-navigate-start')(); },
    loaded: () => messages.filter(m => m.type === 'YT_CUES_LOADED'),
    errors: () => messages.filter(m => m.type === 'YT_CAPTION_DOWNLOAD_FAILED') };
}
test('same-track concurrent requests share one download, and the 8 MiB exact limit is accepted', async () => {
  let calls = 0, reply;
  const h = harness(() => { calls++; return new Promise(resolve => { reply = resolve; }); });
  h.extract(); h.extract(); h.extract(); assert.equal(calls, 1);
  const bytes = new TextEncoder().encode(valid).byteLength;
  reply(new Response(valid + ' '.repeat(8 * 1024 * 1024 - bytes)));
  await tick(); await tick(); assert.equal(h.loaded().length, 1); assert.equal(h.errors().length, 0);
  assert.equal(h.loaded()[0].payload.cues[0].text, '字幕完整保留。');
});
for (const header of [undefined, '1', String(8 * 1024 * 1024 + 1)]) {
  test(`oversized caption stream with length ${header} cancels reader, avoids fallback and allows explicit retry`, async () => {
    let calls = 0, cancelled = false;
    const h = harness(async () => {
      calls++;
      return calls === 1 ? new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } }), { headers: header ? { 'Content-Length': header } : {} }) : new Response(valid);
    });
    h.extract(); await tick(); await tick();
    assert.equal(cancelled, true); assert.match(h.errors()[0].payload.error, /字节预算/); assert.equal(h.loaded().length, 0);
    h.extract(); await tick(); assert.equal(calls, 1);
    h.extract(true); await tick(); await tick(); assert.equal(h.loaded().length, 1); assert.equal(calls, 2);
  });
}
test('JSON3 and original-format fallback share cumulative bytes and a single deadline', async () => {
  let calls = 0;
  const h = harness(async () => {
    calls++;
    return new Response(' '.repeat(5 * 1024 * 1024), { status: calls === 1 ? 503 : 200 });
  });
  h.extract(); await tick(); await tick();
  assert.equal(calls, 2); assert.equal(h.loaded().length, 0); assert.match(h.errors()[0].payload.error, /字节预算/);
  assert.equal(h.timers.filter(t => t.ms === 90000).length, 1);
});
test('deadline aborts a pending body and navigation discards pending results', async () => {
  for (const navigation of [false, true]) {
    let cancelled = false, signal;
    const h = harness(async (_url, opts) => { signal = opts.signal;
      return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([32])); }, cancel() { cancelled = true; } })); });
    h.extract(); await tick();
    if (navigation) h.navigate(); else h.timers.find(t => t.ms === 90000).fn();
    await tick(); assert.equal(signal.aborted, true); assert.equal(cancelled, true); assert.equal(h.loaded().length, 0);
    if (navigation) assert.equal(h.errors().length, 0); else assert.match(h.errors()[0].payload.error, /90 秒/);
  }
});
test('intercepted copy exceeding budget does not cancel the player response', async () => {
  const body = ' '.repeat(8 * 1024 * 1024 + 1);
  const h = harness(async () => new Response(body));
  const playerResponse = await h.window.fetch('https://www.youtube.com/api/timedtext?v=A&lang=zh');
  assert.equal((await playerResponse.text()).length, body.length);
  await tick(); assert.equal(h.loaded().length, 0); assert.match(h.errors()[0].payload.error, /字节预算/);
});
