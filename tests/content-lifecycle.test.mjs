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
      handleScrollRescan() {}, clearTimeout() {}, cleanupAllImageOverlays() {}, blockMap: new Map(),
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
  const ctx = vm.createContext({ Node: { ELEMENT_NODE: 1 }, blockMap: new Map(),
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
