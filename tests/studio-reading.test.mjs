import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../studio/studio.js', import.meta.url), 'utf8');
const section = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a) + a.length));

test('Markdown preserves closed and EOF fences, tildes and shorter nested backticks', () => {
  const ctx = vm.createContext({});
  vm.runInContext(section('function parseMarkdownToBlocks(', '\nfunction parseHtmlDocumentToBlocks('), ctx);
  for (const fence of ['```', '~~~', '````']) {
    for (const closed of [false, true]) {
      const code = `${fence}js\nimportant();\n\`\`\` shorter nested content${closed ? '\n' + fence : ''}`;
      const blocks = ctx.parseMarkdownToBlocks('Intro.\n\n' + code);
      assert.equal(blocks.length, 2);
      assert.equal(blocks[1].type, 'code'); assert.equal(blocks[1].original, code);
    }
  }
  assert.equal(ctx.parseMarkdownToBlocks('').length, 0);
});

test('export snapshots include every block and restore search/chapter/layout without observing lazy pages', () => {
  const main = { innerHTML: 'filtered', scrollTop: 17 };
  const ctx = vm.createContext({ bilingualStreamContainer: main, streamSearchInput: { value: 'alpha' },
    epubChapterSelect: { value: '2' }, layoutStyleSelect: { value: 'card-stream' },
    renderWorkspaceBlocks: (filter, options) => {
      if (options?.forExport) { assert.equal(options.allChapters, true); assert.equal(options.forcePaperLayout, true); assert.equal(filter, ''); main.innerHTML = 'alpha beta'; }
      else { assert.equal(filter, 'alpha'); main.innerHTML = 'filtered'; }
    }
  });
  vm.runInContext(section('function snapshotCompleteDocumentHtml(', '\nfunction exportTranslatedDocument('), ctx);
  assert.equal(ctx.snapshotCompleteDocumentHtml(), 'alpha beta');
  assert.equal(main.innerHTML, 'filtered'); assert.equal(main.scrollTop, 17);
  assert.equal(ctx.epubChapterSelect.value, '2'); assert.equal(ctx.layoutStyleSelect.value, 'card-stream');
});

test('both translation views normalize to pure exports and untranslated text stays marked', () => {
  const ctx = vm.createContext({ viewModeSelect: { value: 'translation-full-width' },
    renderRichAcademicHtml: text => text });
  vm.runInContext(section('function getExportViewMode(', '\nfunction updateProgressCounterBadge('), ctx);
  assert.equal(ctx.getExportViewMode(), 'translation-only');
  assert.equal(ctx.getExportViewMode('translation-only'), 'translation-only');
  assert.equal(ctx.getExportViewMode('bilingual'), 'bilingual');
  const html = ctx.renderBlockTranslation({ original: 'Untranslated original', translation: '', type: 'paragraph' });
  assert.match(html, /untranslated-label/); assert.match(html, /Untranslated original/);
  assert.equal(ctx.renderBlockTranslation({ original: 'Old', translation: 'Translated' }), 'Translated');
});

const readiness = section('function isDocumentReady(', 'const documentRequests =');
const identities = section('function allocateBlockId(', 'let isTranslating = false;');
const start = section('async function startDocumentTranslation(', '\n// ============================================================================');

test('loading and failed imports block actual translation/export handlers, then successful parsing enables controls', async () => {
  let read, requests = 0, downloads = 0;
  const ctx = vm.createContext({ currentDoc: { blocks: [] }, documentSession: 1,
    isTranslating: false, isProcessingLazyQueue: false, lazyPageQueue: [],
    workspaceSplitMain: { dataset: {} }, startTranslateDocBtn: {}, exportMenuBtn: {}, translateSinglePageBtn: {}, exportDropdownMenu: {},
    emptyDropzoneSection: {}, epubChapterSelectWrap: {}, pdfCanvasScrollViewer: {}, pdfNativeEmbed: {}, sourceOutlineViewer: {}, pdfPageJumpWrap: {},
    docStatusSubtitle: {}, leftPaneTitle: {}, progressBarWrap: {}, progressBarFill: { style: {} },
    renderWorkspaceBlocks() {}, TextDecoder,
    getSettings: async () => { requests++; return {}; }, downloadBlob: () => downloads++
  });
  vm.runInContext(readiness + identities + start + section('async function handleFileLoaded(', '\nfunction parseMarkdownToBlocks(') +
    section('function parseMarkdownToBlocks(', '\nfunction parseHtmlDocumentToBlocks(') +
    section('function exportTranslatedDocument(', '\n// ============================================================================'), ctx);
  const loading = ctx.handleFileLoaded({ name: 'delayed.md', text: () => new Promise(resolve => { read = resolve; }) }, { session: 1 });
  assert.equal(ctx.workspaceSplitMain.dataset.documentState, 'loading');
  for (const button of [ctx.startTranslateDocBtn, ctx.exportMenuBtn, ctx.translateSinglePageBtn]) assert.equal(button.disabled, true);
  await ctx.startDocumentTranslation(); ctx.exportTranslatedDocument('html');
  assert.equal(requests, 0); assert.equal(downloads, 0);
  read('Safe complete source.'); await loading;
  assert.equal(ctx.currentDoc.loadState, 'ready'); assert.equal(ctx.currentDoc.blocks[0].original, 'Safe complete source.');
  for (const button of [ctx.startTranslateDocBtn, ctx.exportMenuBtn, ctx.translateSinglePageBtn]) assert.equal(button.disabled, false);
  await ctx.handleFileLoaded({ name: 'broken.md', text: async () => { throw Error('read failed'); } }, { session: 1 });
  assert.equal(ctx.currentDoc.loadState, 'error'); assert.equal(ctx.exportMenuBtn.disabled, true);
  await ctx.startDocumentTranslation(); ctx.exportTranslatedDocument('md');
  assert.equal(requests, 0); assert.equal(downloads, 0);
  await ctx.handleFileLoaded({ name: 'not-a-pdf.pdf', arrayBuffer: async () => new TextEncoder().encode('not PDF').buffer }, { session: 1 });
  assert.equal(ctx.currentDoc.loadState, 'error'); assert.match(ctx.docStatusSubtitle.textContent, /有效的 PDF/);
});

for (const protocol of ['openai', 'gemini']) {
  test(`forced PDF ${protocol} propagates bypassCache to page and vector-label batches; failures retain intent and continuation uses cache`, async () => {
    const requests = [];
    let fail = false;
    const rawBlocks = [{ type: 'figure', original: 'Chart', figureBox2d: [0, 0, 1000, 1000] }, { type: 'paragraph', original: 'Body' }];
    const ctx = vm.createContext({ currentDoc: { loadState: 'ready', fileType: 'pdf', blocks: [], pdfDoc: {},
      totalPages: 3, translatedPages: new Set(), translatingPages: new Set(), forceRetranslatePages: new Set([3]) },
      documentSession: 1, stopRequested: false, isTranslating: false, isProcessingLazyQueue: false, lazyPageQueue: [],
      startTranslateDocBtn: {}, exportMenuBtn: {}, translateSinglePageBtn: {},
      bilingualStreamContainer: { querySelector: () => null }, progressBarWrap: {}, progressBarFill: { style: {} }, docStatusSubtitle: {},
      streamSearchInput: { value: '' }, renderWorkspaceBlocks() {}, setTimeout() {},
      getSettings: async () => ({}), getActiveProtocol: () => protocol,
      getOrRenderPdfPage: async () => ({ canvas: {}, textItems: [{}], jpegBase64: 'AA==', width: 100, height: 100 }), ensureLeftPdfPageRendered() {},
      extractStructuredPdfPageBlocks: () => rawBlocks.map(block => ({ ...block })),
      createBatches: list => [list], normalizeFigureLabelsToCrop: () => [],
      cropFigureCanvasObject: () => ({ cropCanvas: {}, originalDataUrl: 'data:image/png;base64,AA==' }),
      extractFigureVectorTextGroups: () => [{ original: 'Label one' }, { original: 'Label two' }],
      renderSeamlessFigureTranslation: () => ({ translatedDataUrl: 'translated', originalDataUrl: 'original', labels: [] }),
      MESSAGE_TYPES: { TRANSLATE_BATCH: 'batch', ANALYZE_PDF_MULTIMODAL: 'pdf' },
      sendModelRequest: async req => {
        requests.push(req);
        if (fail) return { ok: false, error: 'fixture failure' };
        return { ok: true, data: req.type === 'pdf' ? { blocks: rawBlocks.map(block => ({ ...block })) }
          : { translations: req.payload.items.map(item => ({ id: item.id, translation: 'translated ' + item.text })) } };
      }
    });
    vm.runInContext(readiness + identities + section('async function translateSinglePdfPage(', '\nstartTranslateDocBtn.addEventListener('), ctx);
    fail = true; await ctx.translateSinglePdfPage(3);
    assert.equal(ctx.currentDoc.forceRetranslatePages.has(3), true);
    fail = false; requests.length = 0; await ctx.translateSinglePdfPage(3);
    assert.equal(requests.length, 2, 'page model request and vector-label batch both execute');
    assert.ok(requests.every(req => req.payload.bypassCache === true));
    assert.equal(ctx.currentDoc.forceRetranslatePages.has(3), false);
    requests.length = 0; await ctx.translateSinglePdfPage(1);
    assert.equal(requests.length, 2); assert.ok(requests.every(req => req.payload.bypassCache === false));
    requests.length = 0; await ctx.translateSinglePdfPage(1, { bypassCache: true });
    assert.equal(requests.length, 2); assert.ok(requests.every(req => req.payload.bypassCache === true));
  });
}

test('completed PDF retranslation retains force intent for pages beyond the first two', async () => {
  const seen = [];
  const ctx = vm.createContext({ currentDoc: { loadState: 'ready', fileType: 'pdf', pdfArrayBuffer: new ArrayBuffer(1), blocks: [],
    totalPages: 3, translatedPages: new Set([1, 2, 3]) }, isTranslating: false, isProcessingLazyQueue: false, documentSession: 1, stopRequested: false,
    startTranslateDocBtn: {}, exportMenuBtn: {}, translateSinglePageBtn: {}, progressBarWrap: {}, progressBarFill: { style: {} },
    getSettings: async () => ({}), pdfModeSelect: null, INITIAL_EAGER_PDF_PAGES: 2, streamSearchInput: { value: '' }, renderWorkspaceBlocks() {}, setTimeout() {}
  });
  ctx.translateSinglePdfPage = async page => {
    seen.push({ page, forced: ctx.currentDoc.forceRetranslatePages.has(page) });
    ctx.currentDoc.translatedPages.add(page); ctx.currentDoc.forceRetranslatePages.delete(page);
  };
  vm.runInContext(readiness + start, ctx);
  await ctx.startDocumentTranslation();
  assert.deepEqual(seen, [{ page: 1, forced: true }, { page: 2, forced: true }]);
  assert.deepEqual(Array.from(ctx.currentDoc.forceRetranslatePages), [3]);
});

test('PDF printing limits both translated sheets and untranslated placeholders; an empty selection never prints all pages', async () => {
  for (const secondPageType of ['paper-sheet-page', 'paper-untranslated-page']) {
    const pages = [1, 2].map((number, index) => {
      const classes = new Set([index ? secondPageType : 'paper-sheet-page']);
      return { number, getAttribute: () => String(number), classes,
        classList: { add: value => classes.add(value), remove: value => classes.delete(value) } };
    });
    const printed = [];
    const ctx = vm.createContext({ currentDoc: { fileName: 'fixture' }, documentSession: 1,
      isDocumentReady: () => true, getExportViewMode: mode => mode, docStatusSubtitle: {},
      layoutStyleSelect: { value: 'card-stream' }, viewModeSelect: { value: 'translation-full-width' }, streamSearchInput: { value: 'search' },
      document: { title: 'Reader' }, applyDocumentViewMode() {}, renderWorkspaceBlocks() {}, waitForAllPaperImagesLoaded: async () => {},
      setTimeout: callback => callback(), window: { print: () => printed.push(pages.filter(page => !page.classes.has('is-print-excluded-page')).map(page => page.number)) },
      bilingualStreamContainer: { classList: { add() {}, toggle() {} }, querySelectorAll: selector => {
        if (selector === '[data-paper-page]') return pages;
        if (selector.includes('is-print-excluded-page')) return pages.filter(page => page.classes.has('is-print-excluded-page'));
        if (selector === '.paper-sheet-page') return pages.filter(page => page.classes.has('paper-sheet-page'));
        throw Error(selector);
      } }
    });
    vm.runInContext(section('async function executeLayoutPreservingPdfExport(', '\nfunction snapshotCompleteDocumentHtml('), ctx);
    await ctx.executeLayoutPreservingPdfExport('translation-only', [1]);
    assert.deepEqual(printed, [[1]], `range excludes page 2 when it is ${secondPageType}`);
    assert.equal(ctx.viewModeSelect.value, 'translation-full-width'); assert.equal(ctx.layoutStyleSelect.value, 'card-stream');
    await ctx.executeLayoutPreservingPdfExport('translation-only', []);
    assert.equal(printed.length, 1, 'explicit empty range is not all pages');
    assert.match(ctx.docStatusSubtitle.textContent, /没有.*页面/);
    await ctx.executeLayoutPreservingPdfExport('translation-only', null);
    assert.deepEqual(printed[1], [1, 2], 'null retains the explicit all-pages default');
  }
});
