import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../studio/studio.js', import.meta.url), 'utf8');
const section = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a) + a.length));
function harness() {
  const doc = { fileType: 'pdf', loadState: 'ready', pdfDoc: {}, pdfArrayBuffer: new ArrayBuffer(1), totalPages: 2,
    blocks: [], translatedPages: new Set(), translatingPages: new Set(), forceRetranslatePages: new Set(), failedPages: new Map() };
  const calls = [], errors = []; let fail = false, finish;
  const ctx = vm.createContext({ Set, Map, currentDoc: doc, documentSession: 1, stopRequested: false, isProcessingLazyQueue: false,
    lazyPageQueue: [], isDocumentReady: () => true, getActiveProtocol: () => 'openai',
    getDocumentTranslationSettings: async () => ({ targetLang: 'zh-CN' }),
    getOrRenderPdfPage: async page => ({ textItems: page === 1 ? [] : [{ str: 'SECOND PAGE ONLY' }] }),
    ensureLeftPdfPageRendered() {}, extractStructuredPdfPageBlocks: () => [{ type: 'paragraph', original: 'SECOND PAGE ONLY', translation: '' }],
    extractPdfBlocksLocally: () => { calls.push('unsafe fallback'); return [{ page: 1, type: 'paragraph', original: 'SECOND PAGE ONLY' }]; },
    createBatches: entries => entries.length ? [entries] : [], MESSAGE_TYPES: { TRANSLATE_BATCH: 'batch' },
    sendModelRequest: async () => { calls.push('model'); if (finish) await new Promise(resolve => { finish.resolve = resolve; }); return fail ? { ok: false, error: 'HTTP 401' } : { ok: true, data: { translations: [{ id: 0, translation: 'Recovered' }] } }; },
    allocateBlockId: () => doc.blocks.length, bilingualStreamContainer: { querySelector: () => null },
    docStatusSubtitle: { textContent: '' }, progressBarWrap: {}, progressBarFill: { style: {} }, streamSearchInput: { value: '' },
    renderWorkspaceBlocks: () => errors.push(ctx.docStatusSubtitle.textContent), evictPdfPageRender() {}, trimPdfPageRenderCache() {}, updateDocumentActions() {}, setTimeout() {}, pdfModeSelect: null,
  });
  vm.runInContext(section('function queueLazyPageTranslation(', '\n/**\n * Translates a single PDF page') +
    section('async function translateSinglePdfPage(', '\nstartTranslateDocBtn.addEventListener(') +
    section('function getTranslatedPagesSet(', '\nfunction formatPageListSummary('), ctx);
  return { ctx, doc, calls, errors, setFail: value => { fail = value; }, hold: () => { finish = {}; return finish; } };
}

test('a textless PDF page fails without importing any text from another page', async () => {
  const h = harness(); await h.ctx.translateSinglePdfPage(1);
  assert.equal(h.calls.length, 0); assert.equal(h.doc.blocks.length, 0);
  assert.equal(h.doc.translatedPages.has(1), false); assert.match(h.doc.failedPages.get(1), /未提取/);
  await h.ctx.translateSinglePdfPage(2); assert.equal(h.doc.blocks[0].page, 2);
  assert.equal(h.doc.blocks[0].original, 'SECOND PAGE ONLY'); assert.equal(h.doc.translatedPages.size, 1);
});

test('failed PDF page cannot be retried by observer queues or stale queued work; explicit retry recovers', async () => {
  const h = harness(); h.setFail(true); await h.ctx.translateSinglePdfPage(2);
  assert.equal(h.calls.length, 1); assert.match(h.doc.failedPages.get(2), /401/);
  h.ctx.queueLazyPageTranslation(2, false); await h.ctx.processLazyPageQueue();
  await h.ctx.translateSinglePdfPage(2); assert.equal(h.calls.length, 1);
  h.setFail(false); h.ctx.queueLazyPageTranslation(2, true);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(h.calls.length, 2); assert.equal(h.doc.failedPages.has(2), false);
  assert.equal(h.doc.translatedPages.has(2), true); assert.equal(h.doc.blocks[0].translation, 'Recovered');
});

test('late failure from a cancelled PDF session cannot mark the current session failed', async () => {
  const h = harness(); h.setFail(true); const held = h.hold(); const task = h.ctx.translateSinglePdfPage(2);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  h.ctx.documentSession++; held.resolve(); await task;
  assert.equal(h.doc.failedPages.size, 0); assert.equal(h.doc.translatedPages.size, 0);
});

test('retained old blocks after failed page retranslation do not count as completed PDF export pages', () => {
  const h = harness(); h.doc.blocks = [{ page: 1, translation: 'Old translation' }];
  h.doc.failedPages.set(1, 'HTTP 401');
  assert.deepEqual([...h.ctx.getTranslatedPagesSet()], []);
  h.doc.translatedPages.add(2); assert.deepEqual([...h.ctx.getTranslatedPagesSet()], [2]);
});

test('lazy page queue stops draining remaining pages when a queued page fails and updates placeholder loading UI', async () => {
  const h = harness();
  h.doc.totalPages = 3;
  const titleEl = { textContent: '📄 第 2 / 3 页待翻译' };
  const descEl = { textContent: '为节省 Token 消耗，向下滚动至此页时将自动触发翻译，您也可点击下方按钮立即翻译本页。' };
  const actionBtn = { style: { display: '' } };
  const classes = new Set();
  const placeholderEl = {
    classList: { add: cls => classes.add(cls) },
    querySelector: sel => {
      if (sel === '.paper-lazy-title') return titleEl;
      if (sel === '.paper-lazy-desc') return descEl;
      if (sel === '[data-translate-page]') return actionBtn;
      return null;
    }
  };
  h.ctx.bilingualStreamContainer = {
    querySelector: sel => sel.includes('data-lazy-page="2"') ? placeholderEl : null
  };

  h.setFail(true);
  h.ctx.queueLazyPageTranslation(2, false);
  h.ctx.queueLazyPageTranslation(3, false);
  for (let i = 0; i < 30; i++) await Promise.resolve();

  assert.equal(classes.has('is-loading-page'), true);
  assert.match(titleEl.textContent, /正在按需翻译第 2 \/ 3 页/);
  assert.equal(descEl.textContent, '正在提取本页学术段落、裁剪原始插图并生成图中标签译文…');
  assert.equal(actionBtn.style.display, 'none');
  assert.equal(h.doc.failedPages.has(2), true);
  assert.equal(h.doc.failedPages.has(3), false, 'page 3 must not be attempted after page 2 fails');
  assert.equal(h.ctx.lazyPageQueue.length, 0, 'lazy queue must be cleared after failure');
  assert.equal(h.calls.length, 1);
});
