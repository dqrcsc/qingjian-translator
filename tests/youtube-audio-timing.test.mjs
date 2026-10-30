import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../content/content-main.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('  function stopYoutubeAudioListen('), source.indexOf('  function blobToBase64('));
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness({ delayed = false } = {}) {
  const timers = new Map(), recorders = [], listeners = new Map(), requests = [], tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  let timerId = 0, cancellations = 0;
  const video = { currentTime: 100, playbackRate: 2, paused: false, seeking: false, ended: false,
    captureStream: () => ({ getAudioTracks: () => tracks, getTracks: () => tracks }),
    addEventListener(name, listener) { listeners.set(name, listener); }, removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); } };
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['audio']) }); this.done = this.onstop(); }
  }
  const ctx = vm.createContext({ Blob, MediaRecorder: Recorder, MediaStream: class {},
    QingJianSettings: { resolveProtocol: () => 'gemini' }, settings: {},
    ytAudioListenActive: false, ytAudioSession: 0, ytAudioRecorder: null, ytAudioStream: null, ytAudioButton: null, ytAudioCleanup: null,
    ytCues: [], ytVideoTitle: '', ytOverlayEl: null, ytCaptionSource: '', ytInFlightBatchIds: new Set(), ytLiveCaptionInFlight: new Set(),
    subtitleRequests: { cancel() {} }, audioRequests: { cancel() { cancellations++; } },
    document: { querySelector: () => video, title: 'fixture' }, getCurrentYoutubeVideoId: () => 'fixture',
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id),
    showPageToast() {}, renderYoutubeTimelineList() {}, blobToBase64: async () => 'eA==',
    sendModelRequest: message => new Promise(resolve => { requests.push({ message, resolve }); if (!delayed) resolve({ ok: true, data: { original: `spoken ${requests.length}`, translation: '译文' } }); }) });
  vm.runInContext(code, ctx);
  return { ctx, video, timers, recorders, listeners, requests, tracks,
    get cancellations() { return cancellations; },
    start: () => ctx.toggleExperimentalAudioListen({ classList: { add() {}, remove() {} }, textContent: '' }),
    fire(name) { listeners.get(name)?.(); },
    async elapsed(end) { video.currentTime = end; const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); await tick(); }
  };
}

test('audio cues use media time at 2x and retain that endpoint while the model is delayed', async () => {
  const h = harness({ delayed: true }); await h.start();
  await h.elapsed(114);
  assert.equal(h.requests.length, 1);
  h.video.currentTime = 130;
  h.requests[0].resolve({ ok: true, data: { original: 'spoken', translation: '译文' } }); await tick();
  assert.deepEqual({ start: h.ctx.ytCues[0].start, end: h.ctx.ytCues[0].end }, { start: 100, end: 114 });
  h.ctx.stopYoutubeAudioListen();
});

test('pause finishes a partial slice without a polling loop; playing and rate changes split contiguous media intervals', async () => {
  const h = harness(); await h.start(); h.video.currentTime = 104; h.video.paused = true; h.fire('pause'); await tick();
  assert.equal(h.ctx.ytCues[0].end, 104); assert.equal(h.timers.size, 0); assert.equal(h.recorders.length, 1);
  h.video.paused = false; h.fire('playing'); assert.equal(h.recorders.length, 2);
  h.video.currentTime = 108; h.video.playbackRate = 0.5; h.fire('ratechange'); await tick();
  assert.equal(h.ctx.ytCues[1].start, 104); assert.equal(h.ctx.ytCues[1].end, 108);
  await h.elapsed(111.5); assert.equal(h.ctx.ytCues[2].start, 108); assert.equal(h.ctx.ytCues[2].end, 111.5);
  h.ctx.stopYoutubeAudioListen(); assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0); assert.ok(h.tracks.every(t => t.stopped));
});

test('seeking discards partial recording and invalidates old model replies without stopping the new position', async () => {
  const h = harness({ delayed: true }); await h.start(); await h.elapsed(114);
  h.video.currentTime = 500; h.video.seeking = true; h.fire('seeking');
  assert.equal(h.cancellations, 1); assert.equal(h.timers.size, 0);
  h.requests[0].resolve({ ok: true, data: { original: 'OLD', translation: '旧位置' } }); await tick();
  assert.equal(h.ctx.ytCues.length, 0);
  h.video.seeking = false; h.fire('seeked'); await h.elapsed(514);
  h.requests.at(-1).resolve({ ok: true, data: { original: 'NEW', translation: '新位置' } }); await tick();
  assert.equal(h.ctx.ytCues.length, 1); assert.equal(h.ctx.ytCues[0].start, 500); assert.equal(h.ctx.ytCues[0].end, 514);
  h.ctx.stopYoutubeAudioListen(); assert.equal(h.listeners.size, 0); assert.equal(h.timers.size, 0);
});

test('stop drops pending audio replies and removes every media listener and timer', async () => {
  const h = harness({ delayed: true }); await h.start(); await h.elapsed(114);
  h.ctx.stopYoutubeAudioListen();
  h.requests[0].resolve({ ok: true, data: { original: 'late', translation: '迟到' } }); await tick();
  assert.equal(h.ctx.ytCues.length, 0); assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0);
  assert.equal(h.ctx.ytAudioRecorder, null); assert.equal(h.ctx.ytAudioCleanup, null);
});
