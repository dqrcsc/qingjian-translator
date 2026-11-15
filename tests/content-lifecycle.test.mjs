import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../content/content-main.js', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}

for (const cleanupFirst of [true, false]) {
  test(`rapid re-observation survives 65-element cleanup (cleanup first: ${cleanupFirst})`, async () => {
    const frames = [], queued = [];
    let intersect;
    const elements = Array.from({ length: 65 }, () => ({ tagName: 'P',
      dataset: { igStatus: 'done' }, matches: () => true, querySelectorAll: () => [] }));
    const ctx = vm.createContext({
      pageTranslationSession: 0, pageRequests: { cancel() {} }, isPageTranslated: true,
      pendingParagraphQueue: [], flushQueueTimer: 123, scrollRescanTimer: null, postEnableTimers: [], mutationScanTimer: null, pendingScanRoots: new Set(),
      viewportObserver: null, domMutationObserver: null,
      IntersectionObserver: class { constructor(fn) { intersect = fn; } observe() {} unobserve() {} disconnect() {} },
      MutationObserver: class { disconnect() {} }, window: { removeEventListener() {} },
      handleScrollRescan() {}, clearTimeout() {}, cleanupAllImageOverlays() {}, blockMap: new Map(), paragraphSourceSignatures: new WeakMap(),
      totalTranslatedCount: 65, updateFloatingBallStatus() {},
      document: { querySelectorAll: () => elements }, requestAnimationFrame: fn => frames.push(fn),
      unwrapOriginalTextNodes() {}, showPageToast() {}, BLOCK_SELECTOR: 'p', isProseBlock: () => true,
      isElementTranslatable: el => !el.dataset.igStatus, settings: { enableImageTranslate: false },
      queueParagraphForTranslation: el => { el.dataset.igStatus = 'queued'; queued.push(el); }
    });
    vm.runInContext(section('  function ensureObservers(', '\n  /**\n   * Splits multi-paragraph') + '\n' +
      section('  function resetElementTranslationState(', '\n  function queueParagraphForTranslation(') + '\n' +
      section('  function disablePageTranslation(', '\n  function togglePageTranslation('), ctx);
    const drain = async () => { while (frames.length) { frames.shift()(); await Promise.resolve(); } };
    ctx.ensureObservers();
    for (let round = 0; round < 3; round++) {
      ctx.disablePageTranslation();
      assert.equal(ctx.flushQueueTimer, null);
      ctx.isPageTranslated = true;
      elements.forEach(el => ctx.scanAndObserveContainer(el));
      if (cleanupFirst) await drain();
      intersect(elements.map(target => ({ target, isIntersecting: true })));
      if (!cleanupFirst) await drain();
      assert.equal(queued.length, 65 * (round + 1));
      assert.ok(elements.every(el => el.dataset.igStatus === 'queued'));
    }
    ctx.disablePageTranslation();
    await drain();
    assert.ok(elements.every(el => !el.dataset.igStatus && !el.dataset.igCleanupSession));
  });
}

function imageHarness() {
  const children = [], decodes = [], replies = [], toasts = [];
  let controller = new AbortController();
  const img = { dataset: {}, src: 'fixture.png', isConnected: true };
  const trigger = { textContent: '', classList: { add() {} } };
  const host = { querySelectorAll: () => [...children], appendChild: n => children.push(n) };
  const node = () => ({ className: '', style: {}, setAttribute() {}, appendChild() {},
    remove() { const i = children.indexOf(this); if (i >= 0) children.splice(i, 1); } });
  const ctx = vm.createContext({ WeakMap,
    pageRequests: { get signal() { return controller.signal; } },
    settings: { targetLang: 'zh-CN' }, document: { title: 'fixture', createElement: node,
      querySelectorAll: selector => selector === '[data-ig-img-status]' ? [img] : [...children] },
    invalidateChangedImageSource() {},
    imageSourceSignature: img => [img.currentSrc || '', img.src || '', img.srcset || '', img.sizes || ''].join('\n'),
    ensureImageHostContainer: () => host,
    mountImageControlBar: () => ({ querySelector: selector => selector.includes('trigger') ? trigger : {} }),
    extractImagePayload: async () => ({}), sendModelRequest: () => new Promise((resolve, reject) => replies.push({ resolve, reject })),
    inpaintWebpageImageRegions: () => new Promise(resolve => decodes.push(resolve)),
    releaseImageControls() {}, escapeHtml: String, showPageToast: text => toasts.push(text)
  });
  vm.runInContext(section('  const imageTranslationTasks =', '\n  function sampleWebImageRegionColors(') + '\n' +
    section('  async function renderImageTranslationOverlay(', '\n  function initImageTranslationEngine('), ctx);
  const cancel = () => { controller.abort(); controller = new AbortController(); ctx.cleanupAllImageOverlays(); };
  const reply = () => replies.shift().resolve({ ok: true, data: { hasText: true, summaryTranslation: 'translated', regions: [] } });
  return { ctx, img, trigger, children, replies, decodes, toasts, cancel, reply };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

test('cancel during image decoding cannot append layers or clear replacement loading state', async () => {
  const h = imageHarness();
  const old = h.ctx.translateImageElement(h.img); await tick(); h.reply(); await tick();
  h.cancel();
  const fresh = h.ctx.translateImageElement(h.img); await tick(); h.reply(); await tick();
  h.decodes.shift()(null); await old;
  assert.equal(h.children.length, 0);
  assert.equal(h.img.dataset.igImgStatus, 'loading');
  assert.match(h.trigger.textContent, /识别/);
  h.decodes.shift()(null); await fresh;
  assert.equal(h.children.length, 2);
  assert.equal(h.img.dataset.igImgStatus, 'done');
  assert.equal(h.toasts.filter(text => text.includes('已完成')).length, 1);
});

test('late image request rejection cannot reset a newer request', async () => {
  const h = imageHarness();
  const old = h.ctx.translateImageElement(h.img); await tick();
  const stale = h.replies.shift(); h.cancel();
  const fresh = h.ctx.translateImageElement(h.img); await tick();
  stale.reject(new Error('old network error')); await old;
  assert.equal(h.img.dataset.igImgStatus, 'loading');
  assert.ok(!h.toasts.some(text => text.includes('失败')));
  h.reply(); await tick(); h.decodes.shift()(null); await fresh;
  assert.equal(h.img.dataset.igImgStatus, 'done');
});

test('image source replacement during decoding prevents stale overlay', async () => {
  const h = imageHarness();
  const pending = h.ctx.translateImageElement(h.img); await tick(); h.reply(); await tick();
  h.img.src = 'different.png'; h.decodes.shift()(null); await pending;
  assert.equal(h.children.length, 0);
  assert.equal(h.img.dataset.igImgStatus, undefined);
});

function reclamationHarness() {
  const timers = new Map(), observed = new Set(), scanned = [], cleared = [];
  let nextTimer = 1;
  const ctx = vm.createContext({ Node: { ELEMENT_NODE: 1 }, blockMap: new Map(), paragraphSourceSignatures: new WeakMap(),
    pendingParagraphQueue: [], flushQueueTimer: null, pendingScanRoots: new Set(), mutationScanTimer: null,
    viewportObserver: { unobserve: el => observed.delete(el) }, imageTranslationTasks: new WeakMap(),
    imageControlBars: new WeakMap(), releaseImageControls() {},
    hoveredElement: null, lastContextMenuImage: null, isPageTranslated: true,
    document: { body: { isConnected: true } }, unwrapOriginalTextNodes() {},
    scanAndObserveContainer: root => scanned.push(root),
    setTimeout(fn) { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout(id) { cleared.push(id); timers.delete(id); }
  });
  vm.runInContext(section('  function pruneDetachedParagraphs(', '\n  function handleScrollRescan(') + '\n' +
    section('  function resetElementTranslationState(', '\n  function queueParagraphForTranslation('), ctx);
  const element = (connected = false) => ({ nodeType: 1, isConnected: connected,
    dataset: { igStatus: 'queued', igBlockId: '1' }, querySelectorAll: () => [] });
  return { ctx, timers, observed, scanned, cleared, element };
}

test('removal drops queued and active DOM records, observations and image ownership; moved nodes survive', () => {
  const h = reclamationHarness();
  const removed = h.element(), active = h.element(), moved = h.element(true), img = h.element();
  img.dataset = { igImgStatus: 'loading' };
  h.ctx.blockMap.set(1, { element: removed }); h.ctx.blockMap.set(2, { element: active });
  h.ctx.blockMap.set(3, { element: moved });
  h.ctx.pendingParagraphQueue = [{ id: 1 }, { id: 3 }];
  for (const el of [removed, moved, img]) h.observed.add(el);
  h.ctx.imageTranslationTasks.set(img, {});
  h.ctx.hoveredElement = removed; h.ctx.lastContextMenuImage = img;
  h.ctx.releaseDetachedContent(removed); h.ctx.releaseDetachedContent(img); h.ctx.releaseDetachedContent(moved);
  h.ctx.pruneDetachedParagraphs();
  assert.deepEqual([...h.ctx.blockMap.keys()], [3]);
  assert.deepEqual(Array.from(h.ctx.pendingParagraphQueue, item => item.id), [3]);
  assert.deepEqual([...h.observed], [moved]);
  assert.equal(h.ctx.imageTranslationTasks.has(img), false);
  assert.equal(h.ctx.hoveredElement, null); assert.equal(h.ctx.lastContextMenuImage, null);
  assert.equal(removed.dataset.igStatus, undefined, 'reinsertion can be observed again');
  assert.equal(moved.dataset.igStatus, 'queued', 'synchronous DOM moves retain active work');
  moved.isConnected = false;
  h.ctx.flushQueueTimer = 123;
  h.ctx.pruneDetachedParagraphs();
  assert.equal(h.ctx.pendingParagraphQueue.length, 0);
  assert.equal(h.ctx.flushQueueTimer, null);
  assert.deepEqual(h.cleared, [123]);
});

test('mutation bursts retain bounded roots and skip removed roots at scan time', () => {
  const h = reclamationHarness();
  const roots = Array.from({ length: 150 }, () => h.element(true));
  h.ctx.scheduleMutationScan(roots);
  assert.equal(h.ctx.pendingScanRoots.size, 1);
  assert.equal(h.timers.size, 1, 'one timer per burst');
  const later = h.element(true);
  h.ctx.scheduleMutationScan([later]); later.isConnected = false;
  [...h.timers.values()][0]();
  assert.deepEqual(h.scanned, [h.ctx.document.body]);
  assert.equal(h.ctx.pendingScanRoots.size, 0);
  assert.equal(h.ctx.mutationScanTimer, null);
});

test('success and error rendering release records while error badges can retry', async () => {
  const h = reclamationHarness(), inserted = [], retried = [];
  Object.assign(h.ctx, {
    requestAnimationFrame: fn => fn(), totalTranslatedCount: 0, updateFloatingBallStatus() {},
    wrapOriginalTextNodes() {}, shouldUseInlineMode: () => false, restorePlaceholdersToFragment: text => text,
    insertNodeAfterSegmentAnchor: (el, record, node) => inserted.push({ el, node }),
    queueParagraphForTranslation: el => retried.push(el), showPageToast() {}
  });
  h.ctx.document.createElement = () => ({ dataset: {}, setAttribute() {}, appendChild() {}, remove() {},
    addEventListener(type, fn) { this[type] = fn; } });
  vm.runInContext(section('  function normalizeForComparison(', '\n  function isOnlinePdfPage('), h.ctx);
  const successful = h.element(true), failed = h.element(true), removed = h.element();
  for (const [id, el] of [[1, successful], [2, failed], [3, removed]]) h.ctx.blockMap.set(id, { element: el, text: 'source', placeholders: [] });
  await h.ctx.renderBatchResultsWithRAF([{ id: 1, translation: '译文' }, { id: 3, translation: '过期' }]);
  await h.ctx.renderBatchErrorWithRAF([{ id: 2 }], 'fixture failure');
  assert.equal(h.ctx.blockMap.size, 0);
  assert.equal(inserted.length, 2, 'detached node receives no late result');
  assert.equal(successful.dataset.igStatus, 'done');
  assert.equal(failed.dataset.igStatus, 'error');
  inserted[1].node.click({ stopPropagation() {} });
  assert.deepEqual(retried, [failed]);
  assert.equal(failed.dataset.igStatus, undefined);

  // Multi-segment element with a lingering sibling segment in blockMap clears all state on error retry
  const multiEl = h.element(true);
  let removedChildNodes = 0;
  multiEl.querySelectorAll = () => [{ remove() { removedChildNodes++; } }];
  h.ctx.blockMap.set(10, { element: multiEl, text: 'seg1', placeholders: [], isMultiSeg: true });
  h.ctx.blockMap.set(11, { element: multiEl, text: 'seg2', placeholders: [], isMultiSeg: true });
  h.ctx.pendingParagraphQueue = [{ id: 10, text: 'seg1' }];
  await h.ctx.renderBatchErrorWithRAF([{ id: 11 }], 'segment failure');
  assert.equal(h.ctx.blockMap.has(10), true);
  inserted.at(-1).node.click({ stopPropagation() {} });
  assert.equal(h.ctx.blockMap.size, 0, 'sibling segment record must be purged before re-queuing');
  assert.equal(h.ctx.pendingParagraphQueue.length, 0);
  assert.ok(removedChildNodes > 0, 'existing partial segment nodes must be removed on retry');
});

test('replacing only an image releases old controls and binds the new button to the new image', () => {
  const h = reclamationHarness(), requested = [];
  const host = { children: [], querySelector() { return this.children.find(n => n.className?.includes('ig-img-control-bar')); },
    querySelectorAll() { return this.children.filter(n => /ig-img-overlay-layer|ig-img-bilingual-drawer/.test(n.className)); },
    appendChild(node) { this.children.push(node); node.parentElement = this; } };
  const makeNode = () => ({ dataset: {}, children: [], setAttribute() {},
    appendChild(node) { this.children.push(node); }, addEventListener(name, fn) { this[name] = fn; },
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); this.parentElement = null; } });
  h.ctx.document.createElement = makeNode;
  h.ctx.ensureImageHostContainer = () => host;
  h.ctx.translateImageElement = img => requested.push(img);
  vm.runInContext(section('  const imageControlBars =', '\n  async function extractImagePayload('), h.ctx);
  const old = h.element(true), fresh = h.element(true);
  old.tagName = fresh.tagName = 'IMG';
  old.dataset = fresh.dataset = {};
  const oldBar = h.ctx.mountImageControlBar(old);
  const overlay = makeNode(); overlay.className = 'ig-img-overlay-layer'; host.appendChild(overlay);
  old.isConnected = false;
  h.ctx.releaseDetachedContent(old);
  assert.equal(host.children.length, 0);
  const newBar = h.ctx.mountImageControlBar(fresh);
  assert.notEqual(newBar, oldBar);
  newBar.children[0].click({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(requested, [fresh]);
  // Even if no mutation observer is active, mounting a replacement drops a stale bar.
  fresh.isConnected = false;
  const latest = h.element(true);
  assert.notEqual(h.ctx.mountImageControlBar(latest), newBar);
  assert.equal(host.children.length, 1);
});

function subtitleHarness() {
  let now = 0;
  const replies = [], errors = [];
  const ctx = vm.createContext({
    Date: { now: () => now }, subtitleRequests: { cancel() {} },
    document: { title: 'fixture', addEventListener() {}, body: { appendChild: node => errors.push(node) }, querySelector: () => null,
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, remove() {} }) },
    getCurrentYoutubeVideoId: () => 'video', settings: { targetLang: 'zh-CN' },
    isMostlyChineseText: () => false, renderYoutubeTimelineList() {},
    safeRuntimeSendMessage: () => new Promise(resolve => replies.push(resolve))
  });
  vm.runInContext(section('  let ytCues =', '  function getCurrentYoutubeVideoId(') + '\n' +
    section('  async function dispatchCueBatchTranslation(', '\n  /**\n   * Two-tier subtitle prefetching:') + '\n' +
    section('  async function translateLiveYoutubeCaptionText(', '\n  function syncYoutubeSubtitlesLoop('), ctx);
  vm.runInContext("ytCues = [{ id: 1, text: 'Hello fixture', start: 0, end: 10 }]", ctx);
  const run = live => vm.runInContext(live ? "translateLiveYoutubeCaptionText('Hello fixture')" : 'dispatchCueBatchTranslation(ytCues)', ctx);
  return { ctx, replies, errors, run, advance: ms => { now += ms; } };
}

for (const live of [false, true]) {
  test(`${live ? 'live captions' : 'cue batches'} latch permanent failures, bound transient retries, and reject old-session state`, async () => {
    const h = subtitleHarness();
    const pending = h.run(live); h.replies.shift()({ ok: false, error: 'API failed (401)' }); await pending;
    for (let i = 0; i < 20; i++) { h.advance(10000); await h.run(live); }
    assert.equal(h.replies.length, 0, '401 stays stopped despite future frame ticks');
    assert.match(h.errors[0].textContent, /已暂停/);
    h.ctx.resetYoutubeTranslationSession();
    for (let attempt = 0; attempt < 3; attempt++) {
      const request = h.run(live); assert.equal(h.replies.length, 1);
      h.replies.shift()({ ok: false, error: 'API failed (503)' }); await request;
      await h.run(live); assert.equal(h.replies.length, 0, 'no retry before backoff');
      h.advance(2 ** attempt * 1000);
    }
    h.advance(60000); await h.run(live); assert.equal(h.replies.length, 0, 'three attempts exhaust session retry budget');
    h.ctx.resetYoutubeTranslationSession();
    const old = h.run(live), stale = h.replies.shift();
    h.ctx.resetYoutubeTranslationSession();
    const fresh = h.run(live), current = h.replies.shift();
    stale({ ok: false, error: 'API failed (401)' }); await old;
    current({ ok: true, data: { cues: [{ id: 1, translation: '你好' }] } }); await fresh;
    assert.equal(vm.runInContext('ytTranslationStopped', h.ctx), false);
    assert.equal(vm.runInContext('ytTranslationBusy', h.ctx), false);
    assert.equal(vm.runInContext(live ? "ytLiveCaptionCache.get('Hello fixture')" : 'ytCues[0].translation', h.ctx), '你好');

    // If the player DOM was replaced so ytErrorEl became detached (isConnected: false), next failure re-mounts it
    vm.runInContext('ytLiveCaptionCache.clear(); ytCues[0].translation = "";', h.ctx);
    h.errors[0].isConnected = false;
    const prevErrorCount = h.errors.length;
    const afterDetach = h.run(live); h.replies.shift()({ ok: false, error: 'API failed (401)' }); await afterDetach;
    assert.equal(h.errors.length, prevErrorCount + 1, 'detached error banner must be recreated and re-appended');
  });
}

test('leaving YouTube for home then returning to the same live video clears cancelled busy ownership', async () => {
  const h = subtitleHarness();
  let poll;
  const location = { hostname: 'www.youtube.com', pathname: '/watch', videoId: 'same-video' };
  Object.assign(h.ctx, {
    window: { location, addEventListener() {} },
    getCurrentYoutubeVideoId: () => location.pathname === '/watch' ? location.videoId : '',
    applyYoutubeCssVariables() {}, requestYoutubeTracksFromBridge() {},
    mountYoutubePlayerUI() {}, stopYoutubeAudioListen() {}, syncYoutubeSubtitlesLoop() {},
    setTimeout() {}, setInterval: fn => { poll = fn; }, requestAnimationFrame() {}
  });
  vm.runInContext(section('  function initYoutubeIntegration()', '  function mountYoutubePlayerUI()'), h.ctx);
  h.ctx.initYoutubeIntegration();
  const pending = h.run(true);
  const cancelled = h.replies.shift();
  h.ctx.subtitleRequests.cancel = () => cancelled({ ok: false, cancelled: true });
  location.pathname = '/'; poll(); await pending;
  assert.equal(vm.runInContext('ytTranslationBusy', h.ctx), false);
  assert.equal(vm.runInContext('ytLiveCaptionInFlight.size', h.ctx), 0);
  location.pathname = '/watch'; poll();
  const resumed = h.run(true);
  assert.equal(h.replies.length, 1, 'same-video live captions can request again without a track-loaded event');
  h.replies.shift()({ ok: true, data: { cues: [{ id: 1, translation: '恢复译文' }] } });
  await resumed;
  assert.equal(vm.runInContext("ytLiveCaptionCache.get('Hello fixture')", h.ctx), '恢复译文');
});

test('image control bar appears on hover across image/bar/overlay/drawer and disappears on leaving image region', () => {
  const docListeners = new Map(), rootListeners = new Map(), winListeners = new Map();
  let hitNode = null, rafCb = null;
  const makeEl = (tag, cls = '') => {
    const classes = new Set(cls.split(/\s+/).filter(Boolean));
    let rawClassName = cls;
    const el = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      get className() { return rawClassName; },
      set className(val) {
        rawClassName = String(val || '');
        classes.clear();
        rawClassName.split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
      },
      style: {},
      dataset: {},
      children: [],
      parentElement: null,
      isConnected: true,
      classList: {
        add: c => { classes.add(c); el.className = [...classes].join(' '); },
        remove: c => { classes.delete(c); el.className = [...classes].join(' '); },
        toggle: (c, force) => {
          const next = force === undefined ? !classes.has(c) : Boolean(force);
          if (next) classes.add(c); else classes.delete(c);
          el.className = [...classes].join(' ');
          return next;
        },
        contains: c => classes.has(c)
      },
      setAttribute() {},
      addEventListener(type, fn) { this[type] = fn; },
      appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
      remove() {
        if (this.parentElement) {
          this.parentElement.children = this.parentElement.children.filter(n => n !== this);
          this.parentElement = null;
        }
        this.isConnected = false;
      },
      querySelector(sel) {
        if (sel.includes('ig-img-control-bar')) return this.children.find(n => n.classList?.contains('ig-img-control-bar')) || null;
        if (sel.startsWith('img')) return this.children.find(n => n.tagName === 'IMG' && !n.classList?.contains('ig-img-seamless-img')) || null;
        return null;
      },
      querySelectorAll() {
        return this.children.filter(n => n.classList?.contains('ig-img-overlay-layer') || n.classList?.contains('ig-img-bilingual-drawer'));
      },
      closest(sel) {
        const parts = sel.split(',').map(s => s.trim());
        for (let cur = this; cur; cur = cur.parentElement) {
          for (const part of parts) {
            if (part === 'img' && cur.tagName === 'IMG') return cur;
            if (part.startsWith('.') && cur.classList?.contains(part.slice(1))) return cur;
            if (part === '[data-testid="tweetPhoto"]' && cur.dataset?.testid === 'tweetPhoto') return cur;
          }
        }
        return null;
      }
    };
    return el;
  };

  const host = makeEl('figure');
  host.clientWidth = 600;
  const img1 = makeEl('img');
  img1.src = 'https://example.com/a.png';
  img1.offsetParent = host; img1.offsetTop = 10; img1.offsetLeft = 100; img1.offsetWidth = 300;
  const img2 = makeEl('img');
  img2.src = 'https://example.com/b.png';
  img2.offsetParent = host; img2.offsetTop = 240; img2.offsetLeft = 50; img2.offsetWidth = 400;
  const caption = makeEl('figcaption');
  const outside = makeEl('p');
  host.appendChild(img1); host.appendChild(img2); host.appendChild(caption);

  const ctx = vm.createContext({
    Node: { ELEMENT_NODE: 1 },
    WeakMap,
    MutationObserver: class { observe() {} },
    settings: { enableImageTranslate: true, autoTranslatePageImages: false },
    isPageTranslated: false,
    viewportObserver: null,
    imageTranslationTasks: new WeakMap(),
    lastContextMenuImage: null,
    ensureImageHostContainer: () => host,
    isTranslatableContentImage: () => true,
    translateImageElement() {},
    requestAnimationFrame: fn => { rafCb = fn; return 1; },
    window: { addEventListener: (t, fn) => winListeners.set(t, fn) },
    document: {
      documentElement: { addEventListener: (t, fn) => rootListeners.set(t, fn) },
      createElement: tag => makeEl(tag),
      addEventListener: (t, fn) => docListeners.set(t, fn),
      elementFromPoint: () => hitNode,
      querySelectorAll(sel) {
        if (sel === '.ig-img-control-bar') {
          return host.children.filter(n => n.classList?.contains('ig-img-control-bar'));
        }
        if (sel.includes('.ig-img-overlay-layer')) {
          return host.children.filter(n =>
            n.classList?.contains('ig-img-overlay-layer') ||
            n.classList?.contains('ig-img-bilingual-drawer') ||
            n.classList?.contains('ig-img-control-bar')
          );
        }
        return [img1, img2].filter(n => n.dataset?.igImgStatus);
      }
    }
  });
  vm.runInContext(
    section('  const imageControlBars =', '\n  async function extractImagePayload(') + '\n' +
    section('  function cleanupAllImageOverlays(', '\n  // ============================================================================\n  // 9. Message Listener'),
    ctx
  );
  ctx.initImageTranslationEngine();

  // Entering img1 mounts bar1 aligned to img1's box and reveals it
  docListeners.get('mouseover')({ target: img1, clientX: 150, clientY: 50, isTrusted: true });
  const barsAfterImg1 = host.children.filter(n => n.classList.contains('ig-img-control-bar'));
  assert.equal(barsAfterImg1.length, 1);
  const [bar1] = barsAfterImg1;
  assert.equal(bar1.classList.contains('is-visible'), true);
  assert.equal(bar1.style.top, '18px');
  assert.equal(bar1.style.right, '208px');

  // Moving from img1 onto bar1's trigger button keeps bar1 visible
  const triggerBtn = bar1.children[0];
  docListeners.get('mouseout')({ target: img1, relatedTarget: triggerBtn, clientX: 380, clientY: 20, isTrusted: true });
  docListeners.get('mouseover')({ target: triggerBtn, clientX: 380, clientY: 20, isTrusted: true });
  assert.equal(bar1.classList.contains('is-visible'), true);

  // Moving onto overlay hotspot or bilingual drawer keeps bar1 visible
  const overlay = makeEl('div', 'ig-img-overlay-layer');
  const hotspot = makeEl('div', 'ig-img-region-hotspot');
  overlay.appendChild(hotspot);
  host.appendChild(overlay);
  docListeners.get('mouseout')({ target: triggerBtn, relatedTarget: hotspot, clientX: 200, clientY: 60, isTrusted: true });
  docListeners.get('mouseover')({ target: hotspot, clientX: 200, clientY: 60, isTrusted: true });
  assert.equal(bar1.classList.contains('is-visible'), true);

  // Moving from hotspot onto figcaption inside same <figure> hides bar1
  docListeners.get('mouseout')({ target: hotspot, relatedTarget: caption, clientX: 200, clientY: 220, isTrusted: true });
  assert.equal(bar1.classList.contains('is-visible'), false);

  // Re-entering img1 re-shows existing bar1 without creating a duplicate bar
  docListeners.get('mouseover')({ target: img1, clientX: 150, clientY: 50, isTrusted: true });
  assert.equal(host.children.filter(n => n.classList.contains('ig-img-control-bar')).length, 1);
  assert.equal(bar1.classList.contains('is-visible'), true);

  // Moving directly to sibling img2 in same host hides bar1 and mounts/shows bar2 at img2's bounds
  docListeners.get('mouseout')({ target: img1, relatedTarget: img2, clientX: 150, clientY: 260, isTrusted: true });
  docListeners.get('mouseover')({ target: img2, clientX: 150, clientY: 260, isTrusted: true });
  const allBars = host.children.filter(n => n.classList.contains('ig-img-control-bar'));
  assert.equal(allBars.length, 2);
  const [, bar2] = allBars;
  assert.equal(bar1.classList.contains('is-visible'), false);
  assert.equal(bar2.classList.contains('is-visible'), true);
  assert.equal(bar2.style.top, '248px');
  assert.equal(bar2.style.right, '158px');

  // Stationary cursor while page scrolls away hides bar2 on animation frame
  hitNode = outside;
  winListeners.get('scroll')();
  assert.ok(rafCb);
  rafCb();
  assert.equal(bar2.classList.contains('is-visible'), false);

  // Leaving documentElement also hides active bar
  docListeners.get('mouseover')({ target: img1, clientX: 150, clientY: 50, isTrusted: true });
  assert.equal(bar1.classList.contains('is-visible'), true);
  rootListeners.get('mouseleave')();
  assert.equal(bar1.classList.contains('is-visible'), false);

  // Stationary layout-shift mouseover after cleanupAllImageOverlays (including fractional PointerEvent vs integer MouseEvent)
  // stays suppressed until real pointer movement (>1px) or explicit untrusted hover
  docListeners.get('pointerdown')({ target: img1, clientX: 254.6, clientY: 85.4, isTrusted: true });
  docListeners.get('mouseout')({ target: img1, relatedTarget: outside, clientX: 255, clientY: 85, isTrusted: true });
  ctx.cleanupAllImageOverlays();
  assert.equal(host.children.filter(n => n.classList.contains('ig-img-control-bar')).length, 0);
  docListeners.get('mouseover')({ target: img1, clientX: 255, clientY: 85, isTrusted: true });
  assert.equal(host.children.filter(n => n.classList.contains('ig-img-control-bar')).length, 0);
  docListeners.get('pointermove')({ target: img1, clientX: 262, clientY: 88, isTrusted: true });
  const remountedBars = host.children.filter(n => n.classList.contains('ig-img-control-bar'));
  assert.equal(remountedBars.length, 1);
  assert.equal(remountedBars[0].classList.contains('is-visible'), true);
});
