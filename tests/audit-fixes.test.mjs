import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { isOnlinePdfUrl } from '../shared/utils.js';
import { buildBilingualEpubBlob } from '../studio/epub-engine.js';
import { renderLatexMathToHtml } from '../studio/math-renderer.js';

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
