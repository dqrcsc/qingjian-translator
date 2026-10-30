import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDocumentBudget } from '../studio/document-budget.js';

const source = fs.readFileSync(new URL('../studio/studio.js', import.meta.url), 'utf8');
const identities = source.slice(source.indexOf('function allocateBlockId('), source.indexOf('let isTranslating = false;'));
const readiness = source.slice(source.indexOf('function isDocumentReady('), source.indexOf('const documentRequests ='));
const reading = source.slice(source.indexOf('function getExportViewMode('), source.indexOf('function updateProgressCounterBadge('));
const retranslate = source.slice(source.indexOf('async function retranslateBlock('), source.indexOf('// ============================================================================\n// 2B. Figure'));
function harness() {
  const block = { id: 0, original: 'Original', translation: 'Old translation', type: 'paragraph', page: 1 };
  const element = { textContent: '', innerHTML: '' }, button = { disabled: false }, replies = [];
  let controller = new AbortController();
  const ctx = vm.createContext({ currentDoc: { loadState: 'ready', blocks: [block], bookTitle: 'Fixture' }, documentSession: 1,
    WeakMap, DOMException, documentRequests: { get signal() { return controller.signal; } },
    bilingualStreamContainer: { querySelectorAll: () => [button] }, document: { getElementById: () => element },
    docStatusSubtitle: { textContent: '' }, getDocumentTranslationSettings: async () => ({ targetLang: 'zh-CN' }),
    sendModelRequest: req => new Promise((resolve, reject) => replies.push({ req, resolve, reject })),
    MESSAGE_TYPES: { TRANSLATE_BATCH: 'TRANSLATE_BATCH' }, renderRichAcademicHtml: text => text
  });
  vm.runInContext(readiness + reading + identities + retranslate, ctx);
  return { ctx, block, element, button, replies, cancel() { controller.abort(); controller = new AbortController(); ctx.documentSession++; } };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

test('studio IDs remain unique across insertion, sorting and page replacement; removed/revised blocks reject stale writes', () => {
  const h = harness();
  h.ctx.currentDoc.blocks.push({ id: 1, original: 'Second' });
  const request = h.ctx.beginBlockTranslation(h.block);
  const figure = { id: h.ctx.allocateBlockId(), original: 'Figure' };
  h.ctx.currentDoc.blocks.unshift(figure);
  assert.deepEqual(h.ctx.currentDoc.blocks.map(b => b.id), [2, 0, 1]);
  assert.equal(h.ctx.ownsBlockTranslation(request, h.ctx.currentDoc), true);
  h.ctx.beginBlockTranslation(h.block);
  assert.equal(h.ctx.ownsBlockTranslation(request, h.ctx.currentDoc), false, 'new single-block request supersedes an old batch');
  const oldPageId = h.ctx.allocateBlockId();
  const replacementId = h.ctx.allocateBlockId();
  assert.ok(replacementId > oldPageId);
  const removed = h.ctx.beginBlockTranslation(h.block);
  h.ctx.currentDoc.blocks = h.ctx.currentDoc.blocks.filter(b => b !== h.block);
  assert.equal(h.ctx.ownsBlockTranslation(removed, h.ctx.currentDoc), false);
});

test('single-block 401 preserves previous translation, reports failure, restores button and allows successful retry', async () => {
  const h = harness();
  const failed = h.ctx.retranslateBlock(h.block); await tick();
  assert.equal(h.button.disabled, true);
  h.replies.shift().resolve({ ok: false, error: 'HTTP 401' }); await failed;
  assert.equal(h.block.translation, 'Old translation'); assert.equal(h.element.innerHTML, 'Old translation');
  assert.equal(h.button.disabled, false); assert.match(h.ctx.docStatusSubtitle.textContent, /401.*保留原译文/);
  const retried = h.ctx.retranslateBlock(h.block); await tick();
  assert.equal(h.replies[0].req.payload.bypassCache, true, 'single-block retranslate must bypass cache');
  h.replies.shift().resolve({ ok: true, data: { translations: [{ id: 0, translation: 'New translation' }] } }); await retried;
  assert.equal(h.block.translation, 'New translation'); assert.equal(h.element.innerHTML, 'New translation');
  assert.equal(h.button.disabled, false);
});

test('single-block cancellation and settings failures restore UI, while reentrant clicks send only one request', async () => {
  const h = harness();
  const pending = h.ctx.retranslateBlock(h.block); await tick();
  await h.ctx.retranslateBlock(h.block); assert.equal(h.replies.length, 1);
  h.cancel(); h.replies.shift().resolve({ ok: false, cancelled: true }); await pending;
  assert.equal(h.element.innerHTML, 'Old translation'); assert.equal(h.button.disabled, false);
  assert.match(h.ctx.docStatusSubtitle.textContent, /取消/);
  h.ctx.getDocumentTranslationSettings = async () => { throw new Error('settings unavailable'); };
  await h.ctx.retranslateBlock(h.block);
  assert.equal(h.element.innerHTML, 'Old translation'); assert.equal(h.button.disabled, false);
  assert.match(h.ctx.docStatusSubtitle.textContent, /settings unavailable/);
});

test('a replaced document or block cannot receive a late single-block response', async () => {
  const h = harness();
  const pending = h.ctx.retranslateBlock(h.block); await tick();
  const replacement = { id: 0, original: 'Replacement', translation: 'Replacement translation' };
  h.ctx.currentDoc = { blocks: [replacement] }; h.ctx.documentSession++;
  h.element.innerHTML = 'Replacement translation';
  h.replies.shift().resolve({ ok: true, data: { translations: [{ id: 0, translation: 'Late result' }] } }); await pending;
  assert.equal(replacement.translation, 'Replacement translation'); assert.equal(h.element.innerHTML, 'Replacement translation');
  assert.equal(h.block.translation, 'Old translation');
});

test('studio is private while extension icon resources remain available', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const resources = manifest.web_accessible_resources.flatMap(entry => entry.resources);
  assert.ok(!resources.some(resource => resource.includes('studio') || resource === '*'));
  assert.ok(resources.includes('icons/*.png'));
});

test('asynchronous imports allocate fresh IDs after image uploads and reject a late attachment to a retired block', async () => {
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start) + start.length));
  let releaseText;
  const ctx = vm.createContext({ currentDoc: { loadState: 'ready', blocks: [] }, documentSession: 1, lazyPageQueue: [], isTranslating: false, isProcessingLazyQueue: false, translateSinglePageBtn: {}, exportDropdownMenu: {},
    emptyDropzoneSection: {}, workspaceSplitMain: { dataset: {} }, epubChapterSelectWrap: {}, pdfCanvasScrollViewer: {},
    pdfNativeEmbed: { removeAttribute() {} }, sourceOutlineViewer: {}, pdfPageJumpWrap: {}, startTranslateDocBtn: {}, exportMenuBtn: {},
    docStatusSubtitle: {}, leftPaneTitle: {}, progressBarWrap: {}, progressBarFill: { style: {} },
    jumpPageInput: { value: '1' }, streamSearchInput: { value: '' }, renderWorkspaceBlocks() {},
    createDocumentBudget, TextDecoder, documentRequests: { signal: new AbortController().signal, cancel() {} }, disposePdfPreviewResources() {},
    readBoundedFile: async file => new TextEncoder().encode(await file.text()).buffer,
    getDocumentTranslationSettings: async () => ({ targetLang: 'zh-CN' }),
    FileReader: class { readAsDataURL() { this.result = 'data:image/png;base64,AA=='; this.onloadend(); } },
    sendModelRequest: async () => ({ ok: true, data: { regions: [], summaryTranslation: 'Figure translation' } }),
    MESSAGE_TYPES: { TRANSLATE_IMAGE: 'image' }, normalizeFigureLabelsToCrop: () => [],
    loadImageToCanvas: async () => null, setTimeout() {}, document: { title: 'Fixture', getElementById: () => null }, pendingFigureAttachBlockId: null
  });
  vm.runInContext(readiness + identities + section('async function handleFileLoaded(', '\nfunction parseMarkdownToBlocks(') +
    section('function parseMarkdownToBlocks(', '\nfunction parseHtmlDocumentToBlocks(') +
    section('async function handleFigureImageFile(', '\nif (figureImageInput)'), ctx);
  const loading = ctx.handleFileLoaded({ name: 'two-blocks.md', text: () => new Promise(resolve => { releaseText = resolve; }) }, { session: 1 });
  await ctx.handleFigureImageFile({ name: 'blocked.png', type: 'image/png' });
  assert.equal(ctx.currentDoc.blocks.length, 0, 'image actions are blocked while parsing');
  assert.equal(ctx.currentDoc.loadState, 'loading');
  releaseText('ALPHA original.\n\nBETA original.'); await loading;
  assert.equal(ctx.currentDoc.loadState, 'ready');
  await ctx.handleFigureImageFile({ name: 'first.png', type: 'image/png' });
  const firstFigure = ctx.currentDoc.blocks[0];
  const stale = ctx.beginBlockTranslation(firstFigure);
  let releaseAttachment;
  ctx.sendModelRequest = () => new Promise(resolve => { releaseAttachment = resolve; });
  const attaching = ctx.handleFigureImageFile({ name: 'late-attachment.png', type: 'image/png' }, firstFigure.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof releaseAttachment, 'function');
  ctx.adoptParsedBlocks([{ original: 'ALPHA original.', translation: '' }, { original: 'BETA original.', translation: '' }]);
  assert.deepEqual(Array.from(ctx.currentDoc.blocks, block => block.id), [3, 4], 'replacement parser indices cannot reuse allocated figure ID 2');
  releaseAttachment({ ok: true, data: { regions: [], summaryTranslation: 'Late attachment' } });
  await attaching;
  assert.ok(ctx.currentDoc.blocks.every(block => !block.imageDataUrl && !block.translation));
  assert.match(ctx.docStatusSubtitle.textContent, /原图注已被替换/);
  ctx.sendModelRequest = async () => ({ ok: true, data: { regions: [], summaryTranslation: 'Figure translation' } });
  assert.equal(ctx.ownsBlockTranslation(stale, ctx.currentDoc), false, 'replacement retired the old figure object');
  await ctx.handleFigureImageFile({ name: 'second.png', type: 'image/png' });
  assert.deepEqual(Array.from(ctx.currentDoc.blocks, block => block.id), [5, 3, 4]);
  assert.match(ctx.currentDoc.blocks[0].original, /second.png/);
  assert.equal(ctx.currentDoc.blocks[1].original, 'ALPHA original.');
  assert.equal(ctx.currentDoc.blocks[2].original, 'BETA original.');
  ctx.currentDoc.blocks = [];
  assert.equal(ctx.allocateBlockId(), 6, 'removal or an import with fewer blocks must not move the counter backwards');
});

test('startDocumentTranslation re-translates completed blocks with bypassCache when all blocks in scope are already translated', async () => {
  const startIdx = source.indexOf('async function startDocumentTranslation(');
  const startSection = source.slice(
    startIdx,
    source.indexOf('\n// ============================================================================', startIdx)
  );
  const sentPayloads = [];
  const blocks = [
    { id: 1, type: 'paragraph', original: 'First', translation: '初译一' },
    { id: 2, type: 'paragraph', original: 'Second', translation: '初译二' }
  ];
  const ctx = vm.createContext({
    currentDoc: { loadState: 'ready', fileType: 'md', fileName: 'demo.md', bookTitle: 'Demo', blocks, translatedPages: new Set() },
    documentSession: 1, isTranslating: false, stopRequested: false,
    startTranslateDocBtn: {}, exportMenuBtn: {}, translateSinglePageBtn: {}, isProcessingLazyQueue: false, progressBarWrap: {}, progressBarFill: { style: {} },
    docStatusSubtitle: { textContent: '' }, epubChapterSelect: { value: 'all' },
    getDocumentTranslationSettings: async () => ({ targetLang: 'zh-CN', batchMaxItems: 10, batchMaxChars: 2200 }),
    createBatches: list => (list.length ? [list] : []),
    MESSAGE_TYPES: { TRANSLATE_BATCH: 'TRANSLATE_BATCH' },
    sendModelRequest: async req => {
      sentPayloads.push(req.payload);
      return { ok: true, data: { translations: req.payload.items.map(it => ({ id: it.id, translation: `重译:${it.text}` })) } };
    },
    document: { getElementById: () => null },
    renderRichAcademicHtml: text => text,
    updateProgressCounterBadge() {},
    setTimeout() {},
    WeakMap
  });
  vm.runInContext(readiness + identities + startSection, ctx);
  await ctx.startDocumentTranslation();
  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0].bypassCache, true);
  assert.deepEqual(blocks.map(b => b.translation), ['重译:First', '重译:Second']);
});
