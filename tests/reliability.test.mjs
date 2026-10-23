import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const store = {};
let listener;
const event = { addListener() {} };
globalThis.chrome = {
  storage: { local: {
    async get(key) { return { [key]: structuredClone(store[key]) }; },
    async set(data) { Object.assign(store, structuredClone(data)); }
  }, onChanged: event },
  runtime: { onInstalled: event, onConnect: event, onMessage: { addListener(fn) { listener = fn; } }, getURL: x => x },
  tabs: { onUpdated: event }, contextMenus: { onClicked: event }, commands: { onCommand: event }
};
const client = await import('../background/gemini-client.js');
const cache = await import('../background/cache-db.js');
const { DEFAULT_SETTINGS } = await import('../shared/constants.js');
const { saveSettings } = await import('../shared/storage.js');
const { buildBilingualEpubBlob, readZipArchive } = await import('../studio/epub-engine.js');
const settings = { ...DEFAULT_SETTINGS, providerId: 'custom', apiProtocol: 'openai', apiBaseUrl: 'https://mock.invalid/v1', apiKey: 'dummy-test-key', modelId: 'audit-model' };
await saveSettings(settings);
await import('../background/service-worker.js');
const items = [{ id: 10, text: 'alpha' }, { id: 20, text: 'beta' }];
let calls;
function mockReplies(...values) {
  calls = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    const value = values[Math.min(calls.length - 1, values.length - 1)];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
  };
}
function message(type, payload) { return new Promise(resolve => listener({ type, payload }, {}, resolve)); }

test('complete out-of-order translations follow IDs', async () => {
  mockReplies([{ id: 20, translation: '乙' }, { id: 10, translation: '甲' }]);
  const result = await client.translateBatchWithGemini(items, settings);
  assert.deepEqual(result.map(x => x.translation), ['甲', '乙']);
});

test('missing IDs retry only the missing subset without positional substitution', async () => {
  mockReplies([{ id: 20, translation: '乙' }], [{ id: 10, translation: '甲' }]);
  const result = await client.translateBatchWithGemini(items, settings);
  assert.deepEqual(result.map(x => x.translation), ['甲', '乙']);
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages.at(-1).content, /"id":10/);
  assert.doesNotMatch(calls[1].messages.at(-1).content, /"id":20/);
});

test('empty or unresolved results fail and are not cached as original text', async () => {
  mockReplies([]);
  const payload = { items: [{ id: 31, text: 'unique uncached original' }] };
  assert.equal((await message('TRANSLATE_BATCH', payload)).ok, false);
  mockReplies([{ id: 31, translation: '正确译文' }]);
  const fresh = await message('TRANSLATE_BATCH', payload);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.data.translations[0].translation, '正确译文');
  assert.equal(fresh.data.translations[0].cached, false);
  assert.equal(calls.length, 1);
});

test('duplicate, unknown, missing and non-integer IDs cannot become successful batches', async () => {
  for (const value of [
    [{ id: 10, translation: '甲' }, { id: 10, translation: '错误' }],
    [{ id: 10, translation: '' }, { id: 10, translation: '重复' }],
    [{ id: 999, translation: '错误' }],
    [{ translation: '无 ID' }],
    [{ id: 10.1, translation: '错误' }],
    [{ id: null, translation: '错误' }]
  ]) {
    mockReplies(value);
    await assert.rejects(() => client.translateBatchWithGemini(items, settings));
  }
});

test('damaged placeholders fail rather than being cached, and multi-item batches retry only the damaged item', async () => {
  mockReplies([{ id: 1, translation: '丢失了占位符' }]);
  await assert.rejects(() => client.translateBatchWithGemini([{ id: 1, text: 'Use {{0}} and {{1}}.' }], settings), /占位/);

  const batchWithPlaceholder = [
    { id: 10, text: 'Keep {{0}} intact.' },
    { id: 20, text: 'Plain sentence.' }
  ];
  mockReplies(
    [{ id: 10, translation: '丢失占位符' }, { id: 20, translation: '普通句子' }],
    [{ id: 10, translation: '保留 {{0}} 完整。' }]
  );
  const recovered = await client.translateBatchWithGemini(batchWithPlaceholder, settings);
  assert.deepEqual(recovered.map(x => x.translation), ['保留 {{0}} 完整。', '普通句子']);
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages.at(-1).content, /"id":10/);
  assert.doesNotMatch(calls[1].messages.at(-1).content, /"id":20/);

  mockReplies(
    [{ id: 10, translation: '丢失占位符' }, { id: 20, translation: '普通句子' }],
    [{ id: 10, translation: '重试仍丢失占位符' }]
  );
  await assert.rejects(() => client.translateBatchWithGemini(batchWithPlaceholder, settings), /占位/);
});

test('subtitle IDs retry missing items and reject an empty result', async () => {
  mockReplies([{ id: 20, translation: '乙' }], [{ id: 10, translation: '甲' }]);
  const result = await client.translateYoutubeCuesWithGemini({ cues: items }, settings);
  assert.deepEqual(result.map(x => x.translation), ['甲', '乙']);
  mockReplies([]);
  await assert.rejects(() => client.translateYoutubeCuesWithGemini({ cues: items }, settings));
});

test('real background batch entry counts successful output once across subset retry and cache hits', async () => {
  const { getUsageStats } = await import('../shared/storage.js');
  for (const type of ['TRANSLATE_BATCH', 'TRANSLATE_YOUTUBE_CUES']) {
    const entries = [{ id: 10, text: `${type} {{0}}` }, { id: 20, text: `${type} plain` }];
    const payload = type === 'TRANSLATE_BATCH' ? { items: entries } : { cues: entries };
    const before = await getUsageStats();
    mockReplies([{ id: 10, translation: '损坏' }, { id: 20, translation: '正确' }],
      [{ id: 10, translation: '保留 {{0}}' }]);
    assert.equal((await message(type, payload)).ok, true);
    assert.equal(calls.length, 2);
    const after = await getUsageStats();
    assert.equal(after.totalParagraphs - before.totalParagraphs, 2);
    assert.equal(after.estimatedCharsTranslated - before.estimatedCharsTranslated,
      entries.reduce((sum, entry) => sum + entry.text.length, 0));
    assert.equal(after.totalRequests - before.totalRequests, 2);
    assert.equal((after.batchRetries || 0) - (before.batchRetries || 0), 1);
    assert.equal((await message(type, payload)).ok, true);
    assert.equal(calls.length, 2, 'cache hit must not call the model again');
    assert.equal((await getUsageStats()).totalParagraphs, after.totalParagraphs);
    const failed = entries.map(entry => ({ ...entry, text: entry.text + ' failed' }));
    mockReplies([{ id: 10, translation: '损坏' }, { id: 20, translation: '正确' }],
      [{ id: 10, translation: '仍损坏' }]);
    assert.equal((await message(type, type === 'TRANSLATE_BATCH' ? { items: failed } : { cues: failed })).ok, false);
    assert.equal((await getUsageStats()).totalParagraphs, after.totalParagraphs);
  }
});

test('cache identity includes endpoint, protocol, provider, prompt and context', () => {
  const sig = cache.buildStyleSignature(settings);
  for (const changed of [
    { apiBaseUrl: 'https://another.invalid/v1' }, { apiProtocol: 'gemini' },
    { providerId: 'openai' }, { glossaryText: 'bank=河岸' }, { customSystemPrompt: 'literal' }
  ]) assert.notEqual(sig, cache.buildStyleSignature({ ...settings, ...changed }));
  assert.notEqual(cache.buildCacheKey('bank', 'zh-CN', 'model', sig, 'river'), cache.buildCacheKey('bank', 'zh-CN', 'model', sig, 'finance'));
});

test('worker respects page context in persisted cache keys', async () => {
  mockReplies([{ id: 1, translation: '银行' }], [{ id: 1, translation: '河岸' }]);
  const first = await message('TRANSLATE_BATCH', { items: [{ id: 1, text: 'bank' }], pageTitle: 'finance' });
  const second = await message('TRANSLATE_BATCH', { items: [{ id: 1, text: 'bank' }], pageTitle: 'river' });
  assert.equal(first.data.translations[0].translation, '银行');
  assert.equal(second.data.translations[0].translation, '河岸');
  assert.equal(calls.length, 2);
});

test('timeout includes slow response body', async () => {
  let signal;
  globalThis.fetch = async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ start(controller) {
      const timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); }, 80);
      init.signal.addEventListener('abort', () => { clearTimeout(timer); controller.error(init.signal.reason); }, { once: true });
    } }));
  };
  await assert.rejects(() => client.fetchWithTimeoutAndRetry('https://mock.invalid', {}, { timeoutMs: 10, maxRetries: 0 }), /超时/);
  assert.equal(signal.aborted, true);
});

test('caller cancellation does not retry', async () => {
  let attempts = 0;
  const controller = new AbortController();
  globalThis.fetch = async (_url, init) => {
    attempts++;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  };
  const pending = client.fetchWithTimeoutAndRetry('https://mock.invalid', { signal: controller.signal }, { timeoutMs: 100, baseDelayMs: 1 });
  controller.abort();
  await assert.rejects(() => pending, /abort/i);
  assert.equal(attempts, 1);
});

test('cold IDB hydration obeys memory cap and refreshes LRU', async () => {
  globalThis.indexedDB = { open() {
    const request = {};
    queueMicrotask(() => {
      request.result = { transaction() { return { objectStore() { return {
        get(key) { const req = {}; queueMicrotask(() => { req.result = { translation: key }; req.onsuccess(); }); return req; },
        count() { const req = {}; queueMicrotask(() => { req.result = 3000; req.onsuccess(); }); return req; }
      }; } }; } };
      request.onsuccess();
    });
    return request;
  } };
  try {
    const cold = await import('../background/cache-db.js?cold-test');
    await cold.getCachedTranslations(Array.from({ length: 2501 }, (_, i) => `key-${i}`));
    assert.equal((await cold.getCacheStats()).memoryCount, 2500);
    assert.equal((await cold.getCachedTranslations(['key-2500'])).get('key-2500'), 'key-2500');
    assert.equal((await cold.getCacheStats()).memoryCount, 2500);
  } finally { delete globalThis.indexedDB; }
});

test('EPUB export preserves chapter grouping, navigation and target-language metadata', async () => {
  const blob = buildBilingualEpubBlob({ bookTitle: '<Book>', bookAuthor: 'A&B', targetLang: 'fr', blocks: [
    { chapterIndex: 0, chapterTitle: 'One', original: 'hello', translation: 'bonjour' },
    { chapterIndex: 1, chapterTitle: 'Two', original: 'world', translation: 'monde' }
  ] });
  const entries = await readZipArchive(await blob.arrayBuffer());
  const opf = await entries.get('OEBPS/content.opf').getText();
  assert.match(opf, /properties="nav"/);
  assert.match(opf, /<dc:language>fr<\/dc:language>/);
  assert.match(opf, /property="dcterms:modified">\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
  assert.equal((opf.match(/<itemref /g) || []).length, 2);
  const nav = await entries.get('OEBPS/nav.xhtml').getText();
  assert.match(nav, /epub:type="toc"/);
  assert.match(nav, /One/); assert.match(nav, /Two/);
  for (const href of [...nav.matchAll(/href="([^"]+)"/g)].map(m => m[1])) assert.ok(entries.has(`OEBPS/${href}`));
});

test('YouTube response cannot write to a new video or a replacement track', async () => {
  const src = await readFile(new URL('../content/content-main.js', import.meta.url), 'utf8');
  const start = src.indexOf('  async function dispatchCueBatchTranslation(');
  const fn = src.slice(start, src.indexOf('\n  /**', start));
  let reply;
  let videoId = 'old';
  const context = vm.createContext({ ytInFlightBatchIds: new Set(), ytCues: [{ id: 0, text: 'old' }], ytVideoTitle: 'old', ytSidebarEl: null, ytLastRenderedSig: '', getCurrentYoutubeVideoId: () => videoId, safeRuntimeSendMessage: () => new Promise(r => { reply = r; }) });
  vm.runInContext(`${fn}\nthis.pending = dispatchCueBatchTranslation(ytCues);`, context);
  videoId = 'new';
  context.ytCues = [{ id: 0, text: 'new', translation: '' }];
  reply({ ok: true, data: { cues: [{ id: 0, translation: '旧译文' }] } });
  await context.pending;
  assert.equal(context.ytCues[0].translation, '');
  // Replacing the caption track without changing the video must be safe too.
  vm.runInContext('this.pending = dispatchCueBatchTranslation(ytCues);', context);
  context.ytCues = [{ id: 0, text: 'replacement track', translation: '' }];
  reply({ ok: true, data: { cues: [{ id: 0, translation: '上一轨道' }] } });
  await context.pending;
  assert.equal(context.ytCues[0].translation, '');
});

const studioSource = await readFile(new URL('../studio/studio.js', import.meta.url), 'utf8');
function sourceFunction(src, name, next) {
  const a = src.indexOf(`async function ${name}(`);
  return src.slice(a, src.indexOf(next, a));
}
function documentState() {
  return { fileType: 'pdf', fileName: 'test', totalPages: 1, pdfDoc: null, pdfArrayBuffer: new ArrayBuffer(1), blocks: [], translatedPages: new Set(), translatingPages: new Set(), pageRenderCache: new Map() };
}
function studioContext() {
  let reply;
  let sent;
  const requested = new Promise(resolve => { sent = resolve; });
  const ctx = vm.createContext({
    currentDoc: documentState(), documentSession: 1, stopRequested: false, documentRequests: { signal: new AbortController().signal },
    bilingualStreamContainer: { querySelector: () => null },
    docStatusSubtitle: { textContent: '' }, progressBarWrap: {}, progressBarFill: { style: {} },
    getSettings: async () => settings, getActiveProtocol: () => 'gemini',
    arrayBufferToBase64: () => 'AA==', MESSAGE_TYPES: { ANALYZE_PDF_MULTIMODAL: 'PDF' },
    sendModelRequest: () => { sent(); return new Promise(r => { reply = r; }); },
    renderWorkspaceBlocks() {}, streamSearchInput: { value: '' }, lazyPageQueue: [], setTimeout() {}
  });
  vm.runInContext(sourceFunction(studioSource, 'translateSinglePdfPage', '\nstartTranslateDocBtn.addEventListener'), ctx);
  return { ctx, requested, respond: value => reply(value) };
}

test('PDF translation commits valid results only to its originating document', async () => {
  const { ctx, requested, respond } = studioContext();
  const pending = ctx.translateSinglePdfPage(1);
  await requested;
  ctx.documentSession++;
  ctx.currentDoc = documentState();
  ctx.docStatusSubtitle.textContent = 'new document';
  respond({ ok: true, data: { blocks: [{ type: 'paragraph', original: 'old', translation: '旧' }] } });
  await pending;
  assert.equal(ctx.currentDoc.blocks.length, 0);
  assert.equal(ctx.currentDoc.translatedPages.size, 0);
  assert.equal(ctx.docStatusSubtitle.textContent, 'new document');
});

test('PDF empty results remain failed while a valid page completes', async () => {
  for (const blocks of [[], [{ type: 'paragraph', original: 'hello', translation: '你好' }]]) {
    const { ctx, requested, respond } = studioContext();
    const pending = ctx.translateSinglePdfPage(1);
    await requested;
    respond({ ok: true, data: { blocks } });
    await pending;
    assert.equal(ctx.currentDoc.translatedPages.has(1), blocks.length > 0);
    assert.equal(ctx.currentDoc.translatingPages.size, 0);
    if (!blocks.length) assert.match(ctx.docStatusSubtitle.textContent, /失败/);
  }
});

test('pausing a PDF before its response prevents marking the page complete', async () => {
  const { ctx, requested, respond } = studioContext();
  const pending = ctx.translateSinglePdfPage(1);
  await requested;
  ctx.stopRequested = true;
  respond({ ok: true, data: { blocks: [{ type: 'paragraph', original: 'hello', translation: '你好' }] } });
  await pending;
  assert.equal(ctx.currentDoc.translatedPages.size, 0);
  assert.equal(ctx.currentDoc.blocks.length, 0);
  assert.equal(ctx.currentDoc.translatingPages.size, 0);
});

test('old page-render failures cannot delete the new document render cache', async () => {
  let finish;
  const old = documentState(); old.pdfDoc = {};
  const ctx = vm.createContext({ documentRequests: { signal: new AbortController().signal }, currentDoc: old, MAX_CACHED_PAGE_RENDERS: 8, renderPdfPageToCanvas: () => new Promise(r => { finish = r; }) });
  vm.runInContext(sourceFunction(studioSource, 'getOrRenderPdfPage', '\nasync function ensureLeftPdfPageRendered'), ctx);
  const pending = ctx.getOrRenderPdfPage(1);
  const fresh = documentState(); fresh.pageRenderCache.set(1, 'new page');
  ctx.currentDoc = fresh;
  finish(null);
  await pending;
  assert.equal(fresh.pageRenderCache.get(1), 'new page');
});

test('ordinary document translation discards old results and leaves new run flags intact', async () => {
  let reply, sent;
  const requested = new Promise(r => { sent = r; });
  const ctx = vm.createContext({ currentDoc: { ...documentState(), fileType: 'md', blocks: [{ id: 1, original: 'old' }] }, documentSession: 1,
    isTranslating: false, stopRequested: false, startTranslateDocBtn: {}, progressBarWrap: {}, progressBarFill: { style: {} },
    getSettings: async () => settings, createBatches: blocks => [blocks], MESSAGE_TYPES: { TRANSLATE_BATCH: 'batch' },
    sendModelRequest: () => { sent(); return new Promise(r => { reply = r; }); },
    docStatusSubtitle: { textContent: '' }, setTimeout() {}
  });
  vm.runInContext(sourceFunction(studioSource, 'startDocumentTranslation', '\n// ============================================================================'), ctx);
  const pending = ctx.startDocumentTranslation(); await requested;
  ctx.documentSession++;
  ctx.currentDoc = { ...documentState(), fileType: 'md', blocks: [{ id: 1, original: 'new' }] };
  ctx.isTranslating = true;
  reply({ ok: true, data: { translations: [{ id: 1, translation: '旧' }] } });
  await pending;
  assert.equal(ctx.currentDoc.blocks[0].translation, undefined);
  assert.equal(ctx.isTranslating, true);
});

test('all translation task types share the configured concurrency bound', async () => {
  await saveSettings({ maxConcurrency: 1, enableCache: false });
  let active = 0, peak = 0;
  globalThis.fetch = async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5));
    active--;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ id: 1, translation: '你好' }]) } }] }));
  };
  try {
    await Promise.all([
      message('TRANSLATE_BATCH', { items: [{ id: 1, text: 'hello' }] }),
      message('TRANSLATE_INPUT_TEXT', { text: 'hello', targetLang: 'zh-CN' }),
      message('TRANSLATE_SELECTION', { text: 'hello', contextParagraph: 'hello world' }),
      message('TRANSLATE_IMAGE', { imageBase64: 'AA==', mimeType: 'image/png' }),
      message('ANALYZE_PDF_MULTIMODAL', { pageImageBase64: 'AA==' })
    ]);
    assert.equal(peak, 1);
  } finally { await saveSettings(settings); }
});

const contentSource = await readFile(new URL('../content/content-main.js', import.meta.url), 'utf8');
function audioContext(protocol = 'gemini') {
  let reply, sent;
  const requested = new Promise(r => { sent = r; });
  const toasts = [], timers = [], recorders = [];
  let stopped = 0;
  const stream = { getAudioTracks: () => [{}], getTracks: () => [{ stop() { stopped++; } }] };
  const button = { classList: { add() {}, remove() {} }, textContent: '' };
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
  }
  const ctx = vm.createContext({ ytAudioListenActive: false, ytAudioRecorder: null, ytAudioStream: null, ytAudioSession: 0, ytAudioButton: null,
    QingJianSettings: globalThis.QingJianSettings, audioRequests: { cancel() {} }, subtitleRequests: { cancel() {} }, settings: { apiProtocol: protocol }, showPageToast: text => toasts.push(text),
    document: { querySelector: () => ({ paused: false, currentTime: 0, captureStream: () => stream }), title: 'video' },
    MediaStream: class {}, MediaRecorder: Recorder, getCurrentYoutubeVideoId: () => 'video', ytVideoTitle: 'video', ytCues: [], ytOverlayEl: null,
    ytInFlightBatchIds: new Set(), ytLiveCaptionInFlight: new Set(),
    Blob, blobToBase64: async () => 'AA==', sendModelRequest: () => { sent(); return new Promise(r => { reply = r; }); },
    setTimeout: fn => { timers.push(fn); }, renderYoutubeTimelineList() {}
  });
  const a = contentSource.indexOf('  function stopYoutubeAudioListen(');
  vm.runInContext(contentSource.slice(a, contentSource.indexOf('\n  function blobToBase64', a)), ctx);
  return { ctx, toasts, button, recorders, requested, stopped: () => stopped, respond: value => reply(value) };
}

test('unsupported audio protocol fails before capture while default or upgraded Gemini settings succeed', async () => {
  const a = audioContext('openai'); await a.ctx.toggleExperimentalAudioListen(a.button);
  assert.equal(a.ctx.ytAudioListenActive, false);
  assert.equal(a.recorders.length, 0);
  assert.match(a.toasts.join(' '), /不支持/);

  const upgraded = audioContext();
  upgraded.ctx.settings = {};
  await upgraded.ctx.toggleExperimentalAudioListen(upgraded.button);
  assert.equal(upgraded.ctx.ytAudioListenActive, true);
  assert.equal(upgraded.recorders.length, 1);
  upgraded.ctx.stopYoutubeAudioListen();

  const nonGoogleDefault = audioContext(undefined);
  nonGoogleDefault.ctx.settings = { providerId: 'deepseek' };
  await nonGoogleDefault.ctx.toggleExperimentalAudioListen(nonGoogleDefault.button);
  assert.equal(nonGoogleDefault.ctx.ytAudioListenActive, false);
  assert.equal(nonGoogleDefault.recorders.length, 0);
});

test('disablePageTranslation clears flushQueueTimer and does not wipe a re-enabled session during async RAF cleanup', async () => {
  const rafQueue = [];
  const clearedTimers = [];
  const makeEl = status => ({
    dataset: { igStatus: status, igBlockId: '1' },
    querySelectorAll: () => [{ remove() {} }]
  });
  const elRequeued = makeEl('done');
  const elUntouched = makeEl('done');
  const ctx = vm.createContext({
    pageTranslationSession: 0,
    pageRequests: { cancel() {} },
    isPageTranslated: true,
    pendingParagraphQueue: [{ id: 1, text: 'old' }],
    flushQueueTimer: 99,
    scrollRescanTimer: null,
    postEnableTimers: [],
    viewportObserver: { disconnect() {} },
    domMutationObserver: { disconnect() {} },
    window: { removeEventListener() {} },
    handleScrollRescan() {},
    clearTimeout: id => clearedTimers.push(id),
    cleanupAllImageOverlays() {},
    blockMap: new Map([[1, { element: elRequeued }]]),
    totalTranslatedCount: 5,
    updateFloatingBallStatus() {},
    document: { querySelectorAll: () => [elRequeued, elUntouched] },
    requestAnimationFrame: fn => rafQueue.push(fn),
    unwrapOriginalTextNodes() {},
    showPageToast() {}
  });
  const resetStart = contentSource.indexOf('  function resetElementTranslationState(');
  const resetFn = contentSource.slice(resetStart, contentSource.indexOf('\n  function queueParagraphForTranslation(', resetStart));
  const disableStart = contentSource.indexOf('  function disablePageTranslation(');
  const disableFn = contentSource.slice(disableStart, contentSource.indexOf('\n  function togglePageTranslation(', disableStart));
  vm.runInContext(`${resetFn}\n${disableFn}`, ctx);

  ctx.disablePageTranslation();
  assert.deepEqual(clearedTimers, [99]);
  assert.equal(ctx.flushQueueTimer, null);
  assert.equal(ctx.blockMap.size, 0);
  assert.equal(ctx.totalTranslatedCount, 0);
  assert.equal(elRequeued.dataset.igStatus, undefined);
  assert.equal(elRequeued.dataset.igCleanupSession, '1');

  // Simulate immediate re-enable queuing elRequeued before the RAF cleanup callback fires
  ctx.resetElementTranslationState(elRequeued);
  elRequeued.dataset.igStatus = 'queued';
  ctx.blockMap.set(2, { element: elRequeued });
  ctx.totalTranslatedCount = 1;

  while (rafQueue.length > 0) rafQueue.shift()();
  assert.equal(ctx.blockMap.size, 1);
  assert.equal(ctx.totalTranslatedCount, 1);
  assert.equal(elRequeued.dataset.igStatus, 'queued');
  assert.equal(elUntouched.dataset.igCleanupSession, undefined);
});

test('audio errors stop capture and stopping discards pending results', async () => {
  for (const cancel of [false, true]) {
    const a = audioContext(); await a.ctx.toggleExperimentalAudioListen(a.button);
    const recorder = a.recorders[0]; recorder.ondataavailable({ data: new Blob(['audio']) });
    const pending = recorder.onstop();
    await a.requested;
    if (cancel) a.ctx.stopYoutubeAudioListen();
    a.respond(cancel ? { ok: true, data: { original: 'old', translation: '旧' } } : { ok: false, error: 'unauthorized' });
    await pending;
    assert.equal(a.ctx.ytAudioListenActive, false);
    assert.equal(a.ctx.ytCues.length, 0);
    assert.equal(a.stopped(), 1);
    if (!cancel) assert.match(a.toasts.join(' '), /unauthorized/);
  }
});

test('new audio cues invalidate older caption IDs before reindexing', async () => {
  const a = audioContext();
  a.ctx.ytCues = [{ id: 0, start: 10, text: 'later caption' }];
  const oldCues = a.ctx.ytCues;
  a.ctx.ytInFlightBatchIds.add(0);
  await a.ctx.toggleExperimentalAudioListen(a.button);
  const recorder = a.recorders[0]; recorder.ondataavailable({ data: new Blob(['audio']) });
  const pending = recorder.onstop();
  await a.requested;
  a.respond({ ok: true, data: { original: 'earlier audio', translation: '音频译文' } });
  await pending;
  assert.notEqual(a.ctx.ytCues, oldCues);
  assert.equal(a.ctx.ytCues[0].translation, '音频译文');
  assert.equal(a.ctx.ytCues[1].id, 1);
  assert.equal(a.ctx.ytInFlightBatchIds.size, 0);
  a.ctx.stopYoutubeAudioListen();
});
