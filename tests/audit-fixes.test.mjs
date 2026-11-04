import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { isOnlinePdfUrl } from '../shared/utils.js';
import { buildBilingualEpubBlob } from '../studio/epub-engine.js';
import { renderLatexMathToHtml, renderRichAcademicHtml } from '../studio/math-renderer.js';
import { extractStructuredPdfPageBlocks } from '../studio/pdf-engine.js';

const swSource = fs.readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8');
const contentSource = fs.readFileSync(new URL('../content/content-main.js', import.meta.url), 'utf8');
const optionsSource = fs.readFileSync(new URL('../options/options.js', import.meta.url), 'utf8');
const studioSource = fs.readFileSync(new URL('../studio/studio.js', import.meta.url), 'utf8');

function sliceBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `Start marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `End marker not found: ${endMarker}`);
  return src.slice(start, end);
}

test('service-worker assertPrivilegedExtensionSender blocks webpage content scripts and mergeAdminTestSettings prevents apiKey exfiltration', () => {
  const snippet = sliceBetween(
    swSource,
    'function assertPrivilegedExtensionSender(',
    'async function updateSiteAutoTranslatePause('
  );
  const ctx = vm.createContext({
    URL,
    chrome: {
      runtime: {
        id: 'ext-id-123',
        getURL: (p = '') => `chrome-extension://ext-id-123/${p.replace(/^\//, '')}`
      }
    }
  });
  vm.runInContext(snippet, ctx);

  // Webpage content script sender must be rejected
  assert.throws(
    () => ctx.assertPrivilegedExtensionSender({ id: 'ext-id-123', url: 'https://malicious.example/page.html' }),
    /仅允许扩展设置页面或弹窗执行此管理操作/
  );

  // Extension options/popup page sender must be allowed
  assert.doesNotThrow(() =>
    ctx.assertPrivilegedExtensionSender({
      id: 'ext-id-123',
      url: 'chrome-extension://ext-id-123/options/options.html'
    })
  );

  // Overriding apiBaseUrl without explicit apiKey must not inherit stored apiKey
  const current = {
    apiKey: 'sk-secret-stored-key',
    apiBaseUrl: 'https://api.openai.com/v1'
  };
  const mergedCrossHost = ctx.mergeAdminTestSettings(
    current,
    { apiBaseUrl: 'https://attacker.example/v1' },
    null
  );
  assert.equal(mergedCrossHost.apiKey, '');

  const mergedSameHost = ctx.mergeAdminTestSettings(
    current,
    { apiBaseUrl: 'https://api.openai.com/v1' },
    null
  );
  assert.equal(mergedSameHost.apiKey, 'sk-secret-stored-key');
});

test('content-main isMostlyTargetLanguage supports ja/ko/ru and unwrapOriginalTextNodes preserves framework sibling text nodes', () => {
  const foreignSnippet = sliceBetween(
    contentSource,
    '  function isForeignPageLikely(',
    '  let hasAutoOpenedPdfTab ='
  );
  const langSnippet = sliceBetween(
    contentSource,
    '  function isMostlyTargetLanguage(',
    '  function isNonTranslatableTokenOrMetric('
  );
  const ctx = vm.createContext({
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    settings: { targetLang: 'zh-CN' },
    document: {
      documentElement: { getAttribute: () => 'en' },
      querySelectorAll: () => [{ textContent: 'the and of to in is that for with on as are this by be at' }]
    }
  });
  vm.runInContext(foreignSnippet + '\n' + langSnippet, ctx);

  assert.equal(ctx.isMostlyTargetLanguage('これは日本語のテスト文章です。翻訳をスキップします。', 'ja'), true);
  assert.equal(ctx.isMostlyTargetLanguage('This is an English sentence.', 'ja'), false);
  assert.equal(ctx.isMostlyTargetLanguage('이것은 한국어 테스트 문장입니다.', 'ko'), true);
  assert.equal(ctx.isMostlyTargetLanguage('Это тестовое предложение на русском языке.', 'ru'), true);
  assert.equal(ctx.isForeignPageLikely(), true);

  // Verify unwrapOriginalTextNodes only merges nodes marked __igSplitFromPrev
  const unwrapSnippet = sliceBetween(
    contentSource,
    '  function unwrapOriginalTextNodes(',
    '  function restorePlaceholdersToFragment('
  );
  const nodeA = { nodeType: 3, nodeValue: 'Hello ' };
  const nodeB = { nodeType: 3, nodeValue: 'React' }; // NOT split by extension
  const nodeC = { nodeType: 3, nodeValue: ' World', __igSplitFromPrev: true };
  const children = [nodeA, nodeB, nodeC];
  function syncSiblings() {
    for (let i = 0; i < children.length; i++) {
      children[i].previousSibling = children[i - 1] || null;
      children[i].nextSibling = children[i + 1] || null;
      children[i].remove = function () {
        const idx = children.indexOf(this);
        if (idx !== -1) children.splice(idx, 1);
        syncSiblings();
      };
    }
  }
  syncSiblings();

  const mockEl = {
    childNodes: children,
    querySelectorAll: () => [],
    get firstChild() {
      return children[0] || null;
    }
  };
  vm.runInContext(unwrapSnippet, ctx);
  ctx.unwrapOriginalTextNodes(mockEl);

  // nodeA and nodeB must stay separate; nodeC (__igSplitFromPrev) must merge into nodeB
  assert.equal(children.length, 2);
  assert.equal(children[0].nodeValue, 'Hello ');
  assert.equal(children[1].nodeValue, 'React World');
});

test('EPUB builder strips illegal XML 1.0 control characters and math renderer guards deep recursion', async () => {
  const blob = buildBilingualEpubBlob({
    bookTitle: 'Control\u0000Char\u000CBook',
    bookAuthor: 'Author\u0007',
    targetLang: 'zh-CN',
    blocks: [
      {
        id: 0,
        chapterIndex: 0,
        chapterTitle: 'Chapter 1\u000B',
        type: 'paragraph',
        original: 'Valid text with form-feed \f and bell \u0007',
        translation: '包含控制字符的译文\u0000\u0008'
      }
    ]
  });
  const ab = await blob.arrayBuffer();
  const rawText = new TextDecoder().decode(ab);
  assert.equal(rawText.includes('ControlCharBook'), true);
  assert.equal(rawText.includes('Author\u0007'), false);
  assert.equal(rawText.includes('Chapter 1\u000B'), false);
  assert.equal(rawText.includes('Valid text with form-feed  and bell '), true);
  assert.equal(rawText.includes('包含控制字符的译文\u0000'), false);

  // Deeply nested LaTeX braces must not overflow call stack
  const deepLatex = '{'.repeat(120) + 'x + y' + '}'.repeat(120);
  const rendered = renderLatexMathToHtml(deepLatex, false);
  assert.ok(rendered.includes('x'));
});

test('isOnlinePdfUrl tightened openreview hostname check and options collectFormValues preserves temperature 0', () => {
  assert.equal(isOnlinePdfUrl('https://openreview.net/pdf?id=abc'), true);
  assert.equal(isOnlinePdfUrl('https://api.openreview.net/pdf?id=abc'), true);
  assert.equal(isOnlinePdfUrl('https://evil-openreview.net.attacker.example/pdf?id=abc'), false);

  const collectSnippet = sliceBetween(
    optionsSource,
    'function collectFormValues()',
    '/**\n * Switch provider:'
  );
  const ctx = vm.createContext({
    activeProviderId: 'google',
    providerSelect: { value: 'google' },
    getProviderDefinition: () => ({ protocol: 'gemini', defaultModel: 'gemini-2.5-flash', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta' }),
    apiProtocolSelect: { value: 'gemini' },
    apiKeyInput: { value: 'test-key' },
    modelIdSelect: { value: 'gemini-2.5-flash' },
    customModelIdInput: { value: '' },
    apiBaseUrlInput: { value: '' },
    temperatureInput: { value: '0' },
    targetLangSelect: { value: 'zh-CN' },
    inputTargetLangSelect: { value: 'en' },
    selectedStyleId: 'clean',
    enableFloatingBallCheck: { checked: true },
    enableSelectionTooltipCheck: { checked: true },
    enableTripleSpaceInputCheck: { checked: true },
    enableHoverTranslateCheck: { checked: true },
    enableImageTranslateCheck: { checked: true },
    autoTranslatePageImagesCheck: { checked: true },
    youtubeAutoEnableCheck: { checked: true },
    youtubeShowSidebarCheck: { checked: false },
    youtubeSubFontSizeInput: { value: '22' },
    youtubeTransColorInput: { value: '#fde047' },
    tonePresetSelect: { value: 'standard' },
    glossaryTextarea: { value: '' },
    customSystemPromptTextarea: { value: '' },
    autoTranslateOnlinePdfCheck: { checked: false },
    enableCacheCheck: { checked: true },
    alwaysTranslateDomainsTextarea: { value: '' },
    neverTranslateDomainsTextarea: { value: '' },
    batchMaxItemsInput: { value: '10' },
    maxConcurrencyInput: { value: '3' },
    requestBudgetInput: { value: '50' },
    normalizeRequestBudgetSeconds: (v) => Number(v) || 50
  });
  vm.runInContext(collectSnippet, ctx);
  const collected = ctx.collectFormValues();
  assert.equal(collected.temperature, 0, 'temperature 0 must be preserved instead of coerced to 0.2');
});

test('translateSinglePdfPage shares in-flight promise for concurrent callers and preserves userAttached figures', async () => {
  const readiness = sliceBetween(studioSource, 'function isDocumentReady(', 'const documentRequests =');
  const identities = sliceBetween(studioSource, 'function allocateBlockId(', 'let isTranslating = false;');
  const translatePageFn = sliceBetween(
    studioSource,
    'async function translateSinglePdfPage(',
    '\nstartTranslateDocBtn.addEventListener('
  );

  let releaseModel;
  let modelCallCount = 0;
  const doc = {
    loadState: 'ready',
    fileType: 'pdf',
    pdfDoc: {},
    totalPages: 2,
    blocks: [
      { id: 99, page: 1, type: 'figure', userAttached: true, original: 'User Pasted Figure', translation: '用户粘贴图' }
    ],
    translatedPages: new Set(),
    translatingPages: new Set(),
    forceRetranslatePages: new Set(),
    failedPages: new Map()
  };

  const ctx = vm.createContext({
    Set,
    Map,
    currentDoc: doc,
    documentSession: 1,
    stopRequested: false,
    isTranslating: false,
    isProcessingLazyQueue: false,
    lazyPageQueue: [],
    startTranslateDocBtn: {},
    exportMenuBtn: {},
    translateSinglePageBtn: {},
    bilingualStreamContainer: { querySelector: () => null },
    progressBarWrap: {},
    progressBarFill: { style: {} },
    docStatusSubtitle: {},
    streamSearchInput: { value: '' },
    renderWorkspaceBlocks() {},
    setTimeout() {},
    getDocumentTranslationSettings: async () => ({ targetLang: 'zh-CN' }),
    getActiveProtocol: () => 'openai',
    evictPdfPageRender() {},
    trimPdfPageRenderCache() {},
    getOrRenderPdfPage: async () => ({ textItems: [{ str: 'Page 1 text' }] }),
    ensureLeftPdfPageRendered() {},
    extractStructuredPdfPageBlocks: () => [{ type: 'paragraph', original: 'Page 1 text', translation: '' }],
    createBatches: (list) => [list],
    normalizeFigureLabelsToCrop: () => [],
    MESSAGE_TYPES: { TRANSLATE_BATCH: 'batch' },
    sendModelRequest: async () => {
      modelCallCount++;
      await new Promise((r) => {
        releaseModel = r;
      });
      return { ok: true, data: { translations: [{ id: 0, translation: '第一页译文' }] } };
    }
  });

  vm.runInContext(readiness + identities + translatePageFn, ctx);

  const p1 = ctx.translateSinglePdfPage(1);
  for (let i = 0; i < 5 && !releaseModel; i++) await Promise.resolve();
  // Concurrent call while page 1 is already in-flight must await the same promise
  const p2 = ctx.translateSinglePdfPage(1);
  let p2Resolved = false;
  p2.then(() => {
    p2Resolved = true;
  });
  await Promise.resolve();
  assert.equal(p2Resolved, false, 'concurrent caller must wait for in-flight page translation to finish');

  releaseModel();
  await Promise.all([p1, p2]);
  assert.equal(p2Resolved, true);
  assert.equal(modelCallCount, 1);
  assert.equal(doc.translatedPages.has(1), true);
  assert.equal(doc.blocks.length, 2, 'both userAttached figure and translated page paragraph are preserved');
  assert.equal(doc.blocks.some((b) => b.userAttached && b.original === 'User Pasted Figure'), true);
});

test('extractStructuredPdfPageBlocks keeps elevated author & affiliation superscripts inline without emitting orphan superscript blocks (arXiv:2609.13531 regression)', () => {
  const samplePageRender = {
    width: 1000,
    height: 1400,
    canvas: null,
    textItems: [
      // Paper Title
      {
        str: 'Attention Is All You Need (to Avoid Spurious Oscillations)',
        x: 150,
        y: 145,
        top: 117,
        bottom: 145,
        width: 700,
        height: 28,
        fontSize: 28
      },
      // Author line with 6 elevated superscripts (y = 191, fontSize = 11 vs author baseline y = 199, fontSize = 18)
      { str: 'Jinyoung Jeong', x: 110, y: 199, top: 181, bottom: 199, width: 115, height: 18, fontSize: 18 },
      { str: '1', x: 226, y: 191, top: 180, bottom: 191, width: 7, height: 11, fontSize: 11 },
      { str: ', Joseph B. Choi', x: 234, y: 199, top: 181, bottom: 199, width: 120, height: 18, fontSize: 18 },
      { str: '2', x: 355, y: 191, top: 180, bottom: 191, width: 7, height: 11, fontSize: 11 },
      { str: ', Xinlun Cheng', x: 363, y: 199, top: 181, bottom: 199, width: 110, height: 18, fontSize: 18 },
      { str: '2', x: 474, y: 191, top: 180, bottom: 191, width: 7, height: 11, fontSize: 11 },
      { str: ', H. S. Udaykumar', x: 482, y: 199, top: 181, bottom: 199, width: 138, height: 18, fontSize: 18 },
      { str: '3', x: 621, y: 191, top: 180, bottom: 191, width: 7, height: 11, fontSize: 11 },
      { str: ', Sanghun Choi', x: 629, y: 199, top: 181, bottom: 199, width: 114, height: 18, fontSize: 18 },
      { str: '1,*', x: 744, y: 191, top: 180, bottom: 191, width: 16, height: 11, fontSize: 11 },
      { str: ', and Stephen S. Baek', x: 761, y: 199, top: 181, bottom: 199, width: 158, height: 18, fontSize: 18 },
      { str: '1,2,4,*', x: 920, y: 191, top: 180, bottom: 191, width: 34, height: 11, fontSize: 11 },
      // Affiliations with leading elevated superscripts
      { str: '1', x: 180, y: 223, top: 213, bottom: 223, width: 6, height: 10, fontSize: 10 },
      {
        str: 'School of Mechanical Engineering & IEDT, Kyungpook National University, Daegu, South Korea',
        x: 189,
        y: 230,
        top: 214,
        bottom: 230,
        width: 620,
        height: 16,
        fontSize: 16
      },
      { str: '2', x: 220, y: 249, top: 239, bottom: 249, width: 6, height: 10, fontSize: 10 },
      {
        str: 'School of Data Science, University of Virginia, Charlottesville, VA 22903, USA',
        x: 229,
        y: 256,
        top: 240,
        bottom: 256,
        width: 540,
        height: 16,
        fontSize: 16
      },
      { str: '*', x: 195, y: 275, top: 265, bottom: 275, width: 6, height: 10, fontSize: 10 },
      {
        str: 'Corresponding authors: Sanghun Choi (s-choi@knu.ac.kr) and Stephen Baek (baek@virginia.edu).',
        x: 204,
        y: 282,
        top: 266,
        bottom: 282,
        width: 590,
        height: 16,
        fontSize: 16
      },
      // Abstract Heading & Body
      { str: 'Abstract', x: 110, y: 340, top: 318, bottom: 340, width: 90, height: 22, fontSize: 22 },
      {
        str: 'Can attention move a shock across several cells in one update without breaking it?',
        x: 110,
        y: 372,
        top: 354,
        bottom: 372,
        width: 780,
        height: 18,
        fontSize: 18
      }
    ]
  };

  const blocks = extractStructuredPdfPageBlocks(samplePageRender, 1);
  // Must NOT contain any orphan superscript block like "1 2 2" or "3 1,* 1,2,4,*"
  assert.equal(
    blocks.some((b) => /^[0-9,∗*†‡§\s]+$/.test(b.original)),
    false,
    'No orphan superscript blocks should be emitted'
  );
  assert.equal(blocks[0].type, 'heading');
  assert.equal(blocks[1].type, 'author');
  const authorLines = blocks[1].original.split('\n');
  assert.equal(
    authorLines[0],
    'Jinyoung Jeong$^{1}$, Joseph B. Choi$^{2}$, Xinlun Cheng$^{2}$, H. S. Udaykumar$^{3}$, Sanghun Choi$^{1,*}$, and Stephen S. Baek$^{1,2,4,*}$'
  );
  assert.match(authorLines[1], /^\$\^\{1\}\$ School of Mechanical Engineering/);
  assert.match(authorLines[2], /^\$\^\{2\}\$ School of Data Science/);
  assert.match(authorLines[3], /^\$\^\{\*\}\$ Corresponding authors:/);

  const renderedHtml = renderRichAcademicHtml(blocks[1].original, { blockType: 'author', pageNum: 1 });
  assert.ok(renderedHtml.includes('Jinyoung Jeong<sup class="academic-sup">1</sup>, Joseph B. Choi<sup class="academic-sup">2</sup>'));
  assert.ok(renderedHtml.includes('Stephen S. Baek<sup class="academic-sup">1,2,4,*</sup>'));
});

test('PDF extraction groups multi-column NeurIPS/arXiv author grids (1706.03762) into a single responsive author card block', () => {
  const samplePageRender = {
    width: 1346,
    height: 1742,
    figureRegions: [],
    textItems: [
      // Vertical side-margin arXiv watermark (rotated)
      { str: 'arXiv:1706.03762v7 [cs.CL] 2 Aug 2023', x: 64, y: 1110, top: 1066, bottom: 1110, width: 44, height: 44, fontSize: 44, rotated: true },
      // Top permission notice (2 lines, should be paragraph, not heading)
      { str: 'Provided proper attribution is provided, Google hereby grants permission to', x: 238, y: 211, top: 190, bottom: 211, width: 870, height: 22, fontSize: 22 },
      { str: 'reproduce the tables and figures in this paper solely for use in journalistic or scholarly works.', x: 238, y: 235, top: 213, bottom: 235, width: 870, height: 22, fontSize: 22 },
      // Paper Title
      { str: 'Attention Is All You Need', x: 454, y: 367, top: 330, bottom: 367, width: 439, height: 37, fontSize: 37 },
      // Row 1 of 4 authors (y = 485..529)
      { str: 'Ashish Vaswani', x: 263, y: 485, top: 463, bottom: 485, width: 151, height: 22, fontSize: 22 },
      { str: '∗', x: 414, y: 477, top: 462, bottom: 477, width: 9, height: 15, fontSize: 15 },
      { str: 'Google Brain', x: 280, y: 507, top: 485, bottom: 507, width: 119, height: 22, fontSize: 22 },
      { str: 'avaswani@google.com', x: 247, y: 529, top: 509, bottom: 529, width: 193, height: 20, fontSize: 20 },

      { str: 'Noam Shazeer', x: 502, y: 485, top: 463, bottom: 485, width: 135, height: 22, fontSize: 22 },
      { str: '∗', x: 638, y: 477, top: 462, bottom: 477, width: 9, height: 15, fontSize: 15 },
      { str: 'Google Brain', x: 515, y: 507, top: 485, bottom: 507, width: 119, height: 22, fontSize: 22 },
      { str: 'noam@google.com', x: 502, y: 529, top: 509, bottom: 529, width: 153, height: 20, fontSize: 20 },

      { str: 'Niki Parmar', x: 747, y: 485, top: 463, bottom: 485, width: 120, height: 22, fontSize: 22 },
      { str: '∗', x: 866, y: 477, top: 462, bottom: 477, width: 9, height: 15, fontSize: 15 },
      { str: 'Google Research', x: 736, y: 507, top: 485, bottom: 507, width: 150, height: 22, fontSize: 22 },
      { str: 'nikip@google.com', x: 729, y: 529, top: 509, bottom: 529, width: 163, height: 20, fontSize: 20 },

      { str: 'Jakob Uszkoreit', x: 966, y: 485, top: 463, bottom: 485, width: 155, height: 22, fontSize: 22 },
      { str: '∗', x: 1121, y: 477, top: 462, bottom: 477, width: 9, height: 15, fontSize: 15 },
      { str: 'Google Research', x: 973, y: 507, top: 485, bottom: 507, width: 150, height: 22, fontSize: 22 },
      { str: 'usz@google.com', x: 977, y: 529, top: 509, bottom: 529, width: 143, height: 20, fontSize: 20 },

      // Row 2 of 3 authors (y = 585..629), including multi-symbol superscript "∗ †"
      { str: 'Llion Jones', x: 317, y: 585, top: 563, bottom: 585, width: 109, height: 22, fontSize: 22 },
      { str: '∗', x: 426, y: 577, top: 562, bottom: 577, width: 9, height: 15, fontSize: 15 },
      { str: 'Google Research', x: 301, y: 607, top: 585, bottom: 607, width: 150, height: 22, fontSize: 22 },
      { str: 'llion@google.com', x: 294, y: 629, top: 609, bottom: 629, width: 163, height: 20, fontSize: 20 },

      { str: 'Aidan N. Gomez', x: 582, y: 585, top: 563, bottom: 585, width: 156, height: 22, fontSize: 22 },
      { str: '∗ †', x: 738, y: 577, top: 562, bottom: 577, width: 22, height: 15, fontSize: 15 },
      { str: 'University of Toronto', x: 576, y: 607, top: 585, bottom: 607, width: 190, height: 22, fontSize: 22 },
      { str: 'aidan@cs.toronto.edu', x: 569, y: 629, top: 609, bottom: 629, width: 204, height: 20, fontSize: 20 },

      { str: 'Łukasz Kaiser', x: 896, y: 585, top: 563, bottom: 585, width: 136, height: 22, fontSize: 22 },
      { str: '∗', x: 1032, y: 577, top: 562, bottom: 577, width: 9, height: 15, fontSize: 15 },
      { str: 'Google Brain', x: 909, y: 607, top: 585, bottom: 607, width: 119, height: 22, fontSize: 22 },
      { str: 'lukaszkaiser@google.com', x: 851, y: 629, top: 609, bottom: 629, width: 235, height: 20, fontSize: 20 },

      // Row 3 of 1 author (y = 685..707), including multi-symbol superscript "∗ ‡"
      { str: 'Illia Polosukhin', x: 584, y: 685, top: 663, bottom: 685, width: 152, height: 22, fontSize: 22 },
      { str: '∗ ‡', x: 736, y: 677, top: 662, bottom: 677, width: 22, height: 15, fontSize: 15 },
      { str: 'illia.polosukhin@gmail.com', x: 538, y: 707, top: 687, bottom: 707, width: 265, height: 20, fontSize: 20 },

      // Abstract Heading & Body
      { str: 'Abstract', x: 616, y: 792, top: 766, bottom: 792, width: 102, height: 26, fontSize: 26 },
      { str: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.', x: 311, y: 837, top: 815, bottom: 837, width: 724, height: 22, fontSize: 22 }
    ]
  };

  const blocks = extractStructuredPdfPageBlocks(samplePageRender, 1);
  // Watermark filtered out
  assert.equal(blocks.some((b) => b.original.includes('arXiv:1706.03762')), false);
  // Top permission notice is paragraph, not heading
  assert.equal(blocks[0].type, 'paragraph');
  assert.equal(blocks[1].type, 'heading');
  assert.equal(blocks[1].original, 'Attention Is All You Need');
  // Single unified author block with all 8 author cards
  assert.equal(blocks[2].type, 'author');
  assert.equal(blocks[2].column, 'full');
  // Page must remain single-column ('full' for all blocks)
  assert.equal(blocks.every((b) => b.column === 'full'), true);

  const cards = blocks[2].original.split('\n\n');
  assert.equal(cards.length, 8);
  assert.equal(cards[0], 'Ashish Vaswani$^{∗}$\nGoogle Brain\navaswani@google.com');
  assert.equal(cards[5], 'Aidan N. Gomez$^{∗ †}$\nUniversity of Toronto\naidan@cs.toronto.edu');
  assert.equal(cards[7], 'Illia Polosukhin$^{∗ ‡}$\nillia.polosukhin@gmail.com');

  const renderedHtml = renderRichAcademicHtml(blocks[2].original, { blockType: 'author', pageNum: 1 });
  assert.ok(renderedHtml.includes('class="paper-author-grid"'));
  assert.equal((renderedHtml.match(/class="paper-author-card"/g) || []).length, 8);
  assert.ok(renderedHtml.includes('Aidan N. Gomez<sup class="academic-sup">∗ †</sup>'));
  assert.ok(renderedHtml.includes('Illia Polosukhin<sup class="academic-sup">∗ ‡</sup>'));
});

test('PDF extraction & math renderer preserve paragraph tails with inline equations, narrow glyph spacing, CMEX10 radicals, and 2D stacked fractions (1706.03762 Pages 3-4 regression)', () => {
  // 1. Page 3 regression: Encoder paragraph tail "layers, produce outputs of dimension d_{model} = 512."
  //    and narrow glyph "i" in "predictions for position i can depend"
  const page3Render = {
    width: 1224,
    height: 1584,
    canvas: null,
    textItems: [
      { str: '3.1', x: 216, yBaseline: 1030, top: 1010, bottom: 1033, width: 29.8, height: 23, fontPx: 23.9 },
      { str: 'Encoder and Decoder Stacks', x: 269.8, yBaseline: 1030, top: 1010, bottom: 1033, width: 299.1, height: 23, fontPx: 23.9 },
      { str: 'Encoder:', x: 216, yBaseline: 1072.8, top: 1055, bottom: 1075, width: 82.9, height: 20, fontPx: 19.9 },
      { str: 'The encoder is composed of a stack of N = 6 identical layers. To facilitate these residual connections, all sub-', x: 311.6, yBaseline: 1072.8, top: 1055, bottom: 1075, width: 696, height: 20, fontPx: 19.9 },
      { str: 'layers, produce outputs of dimension ', x: 216, yBaseline: 1094.7, top: 1077, bottom: 1097, width: 300.5, height: 20, fontPx: 19.9 },
      { str: 'd', x: 516.5, yBaseline: 1094.7, top: 1077, bottom: 1097, width: 10.4, height: 20, fontPx: 19.9 },
      { str: 'model', x: 526.9, yBaseline: 1097.7, top: 1085, bottom: 1099, width: 40.3, height: 14, fontPx: 13.9 },
      { str: '=', x: 573.7, yBaseline: 1094.7, top: 1077, bottom: 1097, width: 15.5, height: 20, fontPx: 19.9 },
      { str: '512.', x: 594.8, yBaseline: 1094.7, top: 1077, bottom: 1097, width: 34.9, height: 20, fontPx: 19.9 },
      { str: 'Decoder:', x: 216, yBaseline: 1138.9, top: 1121, bottom: 1141, width: 81.2, height: 20, fontPx: 19.9 },
      { str: 'This masking ensures that the predictions for position', x: 310, yBaseline: 1138.9, top: 1121, bottom: 1141, width: 410, height: 20, fontPx: 19.9 },
      { str: 'i', x: 725.5, yBaseline: 1138.9, top: 1121, bottom: 1141, width: 6.9, height: 20, fontPx: 19.9 },
      { str: 'can depend only on known outputs.', x: 737.3, yBaseline: 1138.9, top: 1121, bottom: 1141, width: 270, height: 20, fontPx: 19.9 }
    ]
  };

  const p3Blocks = extractStructuredPdfPageBlocks(page3Render, 3);
  assert.equal(p3Blocks.length, 3);
  assert.equal(p3Blocks[0].type, 'heading');
  assert.equal(p3Blocks[1].type, 'paragraph', 'Encoder paragraph tail with d_{model} = 512. must stay in paragraph, not split into equation');
  assert.match(p3Blocks[1].original, /layers, produce outputs of dimension d\$_\{model\}\$ = 512\.$/);
  assert.equal(p3Blocks[2].type, 'paragraph');
  assert.match(p3Blocks[2].original, /predictions for position i can depend/, 'Narrow glyph "i" must preserve space before "can"');

  const encoderHtml = renderRichAcademicHtml(p3Blocks[1].original, { blockType: 'paragraph', pageNum: 3 });
  assert.ok(encoderHtml.includes('layers, produce outputs of dimension d<sub class="academic-sub">model</sub> = 512.'));

  // 2. Page 4 regression: CMEX10 top-hung radical sign √ and 2D stacked fraction Eq. (1)
  const page4Render = {
    width: 1224,
    height: 1584,
    canvas: null,
    textItems: [
      { str: '3.2.1', x: 216, yBaseline: 794, top: 774, bottom: 797, width: 47.8, height: 23, fontPx: 23.9 },
      { str: 'Scaled Dot-Product Attention', x: 287.7, yBaseline: 794, top: 774, bottom: 797, width: 311, height: 23, fontPx: 23.9 },
      { str: 'We call our particular attention "Scaled Dot-Product Attention" (Figure 2). The input consists of', x: 216, yBaseline: 836.3, top: 818, bottom: 838, width: 792, height: 20, fontPx: 19.9 },
      { str: 'queries and keys of dimension ', x: 216, yBaseline: 858.2, top: 840, bottom: 860, width: 254, height: 20, fontPx: 19.9 },
      { str: 'd', x: 470, yBaseline: 858.2, top: 840, bottom: 860, width: 10.4, height: 20, fontPx: 19.9 },
      { str: 'k', x: 480.4, yBaseline: 861.2, top: 848, bottom: 862, width: 7.9, height: 14, fontPx: 13.9 },
      { str: ', and values of dimension d', x: 489.4, yBaseline: 858.2, top: 840, bottom: 860, width: 214, height: 20, fontPx: 19.9 },
      { str: 'v', x: 703.4, yBaseline: 861.2, top: 848, bottom: 862, width: 7.4, height: 14, fontPx: 13.9 },
      { str: '. We compute the dot products of the', x: 712, yBaseline: 858.2, top: 840, bottom: 860, width: 296, height: 20, fontPx: 19.9 },
      // Line 3 with CMEX10 top-hung √ whose PDF yBaseline (864.5) is near Line 2 (858.2) while radicand d_k is at yBaseline 880.1
      { str: 'query with all keys, divide each by ', x: 216, yBaseline: 880.1, top: 862, bottom: 882, width: 281.5, height: 20, fontPx: 19.9 },
      { str: '√', x: 497.5, yBaseline: 864.5, top: 847, bottom: 867, width: 16.6, height: 20, fontPx: 19.9 },
      { str: 'd', x: 514.1, yBaseline: 880.1, top: 862, bottom: 882, width: 10.4, height: 20, fontPx: 19.9 },
      { str: 'k', x: 524.5, yBaseline: 883.1, top: 870, bottom: 884, width: 7.9, height: 14, fontPx: 13.9 },
      { str: ', and apply a softmax function.', x: 533.5, yBaseline: 880.1, top: 862, bottom: 882, width: 252, height: 20, fontPx: 19.9 },
      // Display Equation (1): Attention(Q, K, V) = softmax(\frac{QK^T}{\sqrt{d_k}})V (1)
      { str: 'Attention(', x: 458.2, yBaseline: 961.5, top: 944, bottom: 964, width: 85.8, height: 20, fontPx: 19.9 },
      { str: 'Q, K, V', x: 544.0, yBaseline: 961.5, top: 944, bottom: 964, width: 69.5, height: 20, fontPx: 19.9 },
      { str: ') = softmax(', x: 613.5, yBaseline: 961.5, top: 944, bottom: 964, width: 101.4, height: 20, fontPx: 19.9 },
      { str: 'QK', x: 717.3, yBaseline: 948.1, top: 930, bottom: 950, width: 33.9, height: 20, fontPx: 19.9 },
      { str: 'T', x: 751.2, yBaseline: 940.9, top: 928, bottom: 942, width: 10.1, height: 14, fontPx: 13.9 },
      { str: '√', x: 720.2, yBaseline: 960.9, top: 943, bottom: 963, width: 16.6, height: 20, fontPx: 19.9 },
      { str: 'd', x: 736.8, yBaseline: 976.4, top: 958, bottom: 978, width: 10.4, height: 20, fontPx: 19.9 },
      { str: 'k', x: 747.2, yBaseline: 979.4, top: 966, bottom: 980, width: 7.9, height: 14, fontPx: 13.9 },
      { str: ')V', x: 763.7, yBaseline: 961.5, top: 944, bottom: 964, width: 22.9, height: 20, fontPx: 19.9 },
      { str: '(1)', x: 983.5, yBaseline: 961.5, top: 944, bottom: 964, width: 24.5, height: 20, fontPx: 19.9 }
    ]
  };

  const p4Blocks = extractStructuredPdfPageBlocks(page4Render, 4);
  assert.equal(p4Blocks.every((b) => b.column === 'full'), true, 'Page 4 must remain single-column');
  assert.equal(p4Blocks.some((b) => b.original === '√'), false, 'CMEX10 √ must not become an orphan block');
  assert.equal(p4Blocks.length, 3);
  assert.equal(p4Blocks[0].type, 'heading');
  assert.equal(p4Blocks[1].type, 'paragraph');
  assert.match(p4Blocks[1].original, /divide each by \$\\sqrt\{d_\{k\}\}\$, and apply a softmax function\./);
  assert.equal(p4Blocks[2].type, 'equation');
  assert.equal(p4Blocks[2].original, 'Attention(Q, K, V) = softmax($\\frac{QK^{T}}{\\sqrt{d_{k}}}$)V \\tag{1}');

  const eq1Html = renderRichAcademicHtml(p4Blocks[2].original, { blockType: 'equation', pageNum: 4 });
  assert.ok(eq1Html.includes('class="math-frac"'), 'Equation (1) must render a stacked .math-frac fraction');
  assert.ok(eq1Html.includes('class="math-sqrt"'), 'Equation (1) denominator must render .math-sqrt');
  assert.ok(eq1Html.includes('<span class="math-eq-tag">(1)</span>'), 'Equation (1) must render right-aligned equation tag (1)');
});
