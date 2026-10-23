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
      pendingParagraphQueue: [], flushQueueTimer: 123, scrollRescanTimer: null, postEnableTimers: [],
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
    escapeHtml: String, showPageToast: text => toasts.push(text)
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
