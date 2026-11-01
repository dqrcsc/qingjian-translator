import '../shared/request-client.js';
/**
 * Document Studio Controller for Immersive Gemini.
 * Handles PDF (Left Native Viewer + Right Bilingual Stream via Gemini Multimodal or Local Stream),
 * EPUB (Chapter Navigation + Bilingual EPUB Export), Markdown, HTML, TXT, and SRT/VTT files.
 */

import { MESSAGE_TYPES } from '../shared/constants.js';
import { getSettings, getActiveProtocol } from '../shared/storage.js';
import { snapshotDocumentConfig, documentConfigSignature } from '../shared/document-config.js';
import {
  escapeHtml,
  parseSubtitles,
  formatSrtTime,
  createBatches,
  normalizeOnlinePdfUrl
} from '../shared/utils.js';
import { parseEpubFile, buildBilingualEpubBlob } from './epub-engine.js';
import { createDocumentBudget, readBoundedResponse, readBoundedFile } from './document-budget.js';
import {
  extractPdfBlocksLocally,
  extractStructuredPdfPageBlocks,
  estimatePdfPageCount,
  openPdfDocument,
  renderPdfPageToCanvas,
  cropFigureFromPageCanvas,
  cropFigureCanvasObject,
  extractFigureVectorTextGroups,
  renderSeamlessFigureTranslation,
  normalizeFigureLabelsToCrop,
  arrayBufferToBase64
} from './pdf-engine.js';
import {
  renderRichAcademicHtml,
  isAuthorOrAffiliationBlock
} from './math-renderer.js';

const fileInput = document.getElementById('fileInput');
const figureImageInput = document.getElementById('figureImageInput');
const onlinePdfUrlInput = document.getElementById('onlinePdfUrlInput');
const loadOnlinePdfBtn = document.getElementById('loadOnlinePdfBtn');
const loadDemoDocBtn = document.getElementById('loadDemoDocBtn');
const emptyDemoBtn = document.getElementById('emptyDemoBtn');
const pdfModeSelect = document.getElementById('pdfModeSelect');
const layoutStyleSelect = document.getElementById('layoutStyleSelect');
const paperColumnModeSelect = document.getElementById('paperColumnModeSelect');
const viewModeSelect = document.getElementById('viewModeSelect');
const startTranslateDocBtn = document.getElementById('startTranslateDocBtn');
const exportMenuBtn = document.getElementById('exportMenuBtn');
const exportDropdownMenu = document.getElementById('exportDropdownMenu');
const studioSettingsBtn = document.getElementById('studioSettingsBtn');

const docStatusSubtitle = document.getElementById('docStatusSubtitle');
const progressBarWrap = document.getElementById('progressBarWrap');
const progressBarFill = document.getElementById('progressBarFill');
const emptyDropzoneSection = document.getElementById('emptyDropzoneSection');
const dropzoneCard = document.getElementById('dropzoneCard');
const workspaceSplitMain = document.getElementById('workspaceSplitMain');

const leftPaneTitle = document.getElementById('leftPaneTitle');
const rightPaneTitle = document.getElementById('rightPaneTitle');
const toggleTocSidebarBtn = document.getElementById('toggleTocSidebarBtn');
const pdfTocSidebar = document.getElementById('pdfTocSidebar');
const pdfTocList = document.getElementById('pdfTocList');
const pdfTocCountBadge = document.getElementById('pdfTocCountBadge');
const epubChapterSelectWrap = document.getElementById('epubChapterSelectWrap');
const epubChapterSelect = document.getElementById('epubChapterSelect');
const pdfCanvasScrollViewer = document.getElementById('pdfCanvasScrollViewer');
const pdfNativeEmbed = document.getElementById('pdfNativeEmbed');
const sourceOutlineViewer = document.getElementById('sourceOutlineViewer');

const pdfPageJumpWrap = document.getElementById('pdfPageJumpWrap');
const prevPageStepBtn = document.getElementById('prevPageStepBtn');
const nextPageStepBtn = document.getElementById('nextPageStepBtn');
const totalPagesBadge = document.getElementById('totalPagesBadge');
const jumpPageInput = document.getElementById('jumpPageInput');
const translateSinglePageBtn = document.getElementById('translateSinglePageBtn');
const streamSearchInput = document.getElementById('streamSearchInput');
const progressCounterBadge = document.getElementById('progressCounterBadge');
const bilingualStreamContainer = document.getElementById('bilingualStreamContainer');

// PDF Export & Token Confirmation Modal Elements
const pdfExportConfirmModal = document.getElementById('pdfExportConfirmModal');
const closePdfExportModalBtn = document.getElementById('closePdfExportModalBtn');
const cancelPdfExportModalBtn = document.getElementById('cancelPdfExportModalBtn');
const abortAndExportDoneBtn = document.getElementById('abortAndExportDoneBtn');
const confirmPdfExportBtn = document.getElementById('confirmPdfExportBtn');
const modalTotalPagesText = document.getElementById('modalTotalPagesText');
const modalDonePagesText = document.getElementById('modalDonePagesText');
const modalRemainingPagesText = document.getElementById('modalRemainingPagesText');
const scopeAllDescText = document.getElementById('scopeAllDescText');
const scopeTranslatedOnlyDescText = document.getElementById('scopeTranslatedOnlyDescText');
const exportRangeStartInput = document.getElementById('exportRangeStartInput');
const exportRangeEndInput = document.getElementById('exportRangeEndInput');
const pdfExportTokenWarningBox = document.getElementById('pdfExportTokenWarningBox');
const pdfTokenWarnTitle = document.getElementById('pdfTokenWarnTitle');
const pdfTokenWarnBody = document.getElementById('pdfTokenWarnBody');
const pdfExportLiveProgressBox = document.getElementById('pdfExportLiveProgressBox');
const pdfExportLiveStatusText = document.getElementById('pdfExportLiveStatusText');
const pdfExportLivePercentText = document.getElementById('pdfExportLivePercentText');
const pdfExportLiveBarFill = document.getElementById('pdfExportLiveBarFill');

const INITIAL_EAGER_PDF_PAGES = 2;

let currentDoc = {
  loadState: 'idle',
  fileName: '',
  fileType: '', // 'pdf' | 'epub' | 'md' | 'html' | 'srt'
  pdfBlobUrl: '',
  pdfSourceUrl: '',
  pdfArrayBuffer: null,
  pdfDoc: null,
  pageRenderCache: new Map(),
  totalPages: 1,
  translatedPages: new Set(),
  translatingPages: new Set(),
  lazyScrollEnabled: false,
  lazyScrollTriggered: false,
  bookTitle: '',
  bookAuthor: '',
  chapters: [],
  blocks: [] // Array of { id, page, chapterIndex, type, column, original, translation, figureBox2d, figureLabels, imageDataUrl, start, end }
};

// IDs belong to blocks, not their current array position. Reordering or replacing
// PDF pages must never recycle an ID still referenced by an in-flight request.
function allocateBlockId(doc = currentDoc) {
  // An asynchronous import can replace blocks after an image already allocated an ID.
  const minimumNextId = doc.blocks.reduce((next, block) => Math.max(next, block.id + 1), 0);
  doc.nextBlockId = Math.max(Number.isSafeInteger(doc.nextBlockId) ? doc.nextBlockId : 0, minimumNextId);
  return doc.nextBlockId++;
}

function adoptParsedBlocks(blocks, doc = currentDoc) {
  // Import completion can race with image uploads in this same document session.
  // Assign fresh identities instead of reusing parser-local array indices.
  doc.blocks = blocks.map(block => ({ ...block, id: allocateBlockId(doc) }));
}

const blockTranslationVersions = new WeakMap();
const blockRetranslations = new WeakMap();
function beginBlockTranslation(block) {
  const version = (blockTranslationVersions.get(block) || 0) + 1;
  blockTranslationVersions.set(block, version);
  return { block, id: block.id, original: block.original, version };
}
function ownsBlockTranslation(request, doc) {
  return currentDoc === doc && doc.blocks.includes(request.block) &&
    request.block.id === request.id && request.block.original === request.original &&
    blockTranslationVersions.get(request.block) === request.version;
}

let isTranslating = false;
let stopRequested = false;
let isExportBatchRunning = false;
let abortExportBatchMode = null; // null | 'cancel' | 'export-done'
let pendingFigureAttachBlockId = null;
let lazyPageObserver = null;
let leftPdfPageObserver = null;
let isProgrammaticRightScroll = false;
let programmaticScrollTimer = null;
const lazyPageQueue = [];
let isProcessingLazyQueue = false;

function isDocumentReady() {
  return currentDoc.loadState === 'ready';
}

function updateDocumentActions() {
  const ready = isDocumentReady();
  startTranslateDocBtn.disabled = !ready;
  exportMenuBtn.disabled = !ready;
  if (translateSinglePageBtn) translateSinglePageBtn.disabled = !ready;
  if (!ready || isTranslating || isProcessingLazyQueue) return;
  const isPdf = currentDoc.fileType === 'pdf';
  const done = isPdf ? currentDoc.translatedPages.size : currentDoc.blocks.filter(b => b.translation && !b.figureTranslationPending).length;
  const total = isPdf ? currentDoc.totalPages : currentDoc.blocks.length;
  startTranslateDocBtn.textContent = done >= total && total > 0 ? '✦ 重新翻译'
    : isPdf && done > 0 ? '✦ 继续翻译下两页' : '✦ 开始翻译';
}

function setDocumentLoadState(state) {
  currentDoc.loadState = state;
  if (state !== 'ready' || currentDoc.fileType === 'pdf') {
    for (const id of ['documentReadingPager', 'documentTocPager']) {
      const pager = document.getElementById(id);
      if (pager) pager.hidden = true;
    }
  }
  workspaceSplitMain.dataset.documentState = state;
  if (state !== 'ready') exportDropdownMenu.hidden = true;
  updateDocumentActions();
}

const documentRequests = globalThis.QingJianRequests.createScope();
const sendModelRequest = async message => {
  const doc = currentDoc, session = documentSession;
  await getDocumentTranslationSettings();
  if (currentDoc !== doc || session !== documentSession) throw new DOMException('文档翻译已取消', 'AbortError');
  return documentRequests.request({ ...message, documentConfig: doc.translationConfig });
};

const configNotice = document.createElement('div');
configNotice.id = 'documentConfigNotice';
configNotice.hidden = true;
configNotice.setAttribute('role', 'status');
configNotice.style.cssText = 'padding:10px 20px;background:#422f16;color:#fff;line-height:1.8';
configNotice.innerHTML = '<span data-config-message></span> <button type="button" data-config-keep>继续原配置</button> <button type="button" data-config-new>按新配置重译（保留上一版）</button> <button type="button" data-config-restore hidden>恢复上一版译文</button>';
progressBarWrap.before(configNotice);

function stopDocumentTranslations() {
  documentRequests.cancel();
  documentSession++;
  clearTimeout(programmaticScrollTimer);
  programmaticScrollTimer = null;
  isProgrammaticRightScroll = false;
  currentDoc.translatingPages?.clear();
  currentDoc.inFlightPagePromises?.clear();
  currentDoc.lazyScrollEnabled = false;
  currentDoc.lazyScrollTriggered = false;
  lazyPageQueue.length = 0;
  lazyPageObserver?.disconnect();
  isTranslating = false;
  isProcessingLazyQueue = false;
  isExportBatchRunning = false;
  stopRequested = true;
  if (progressBarWrap) progressBarWrap.hidden = true;
  if (pdfExportConfirmModal) pdfExportConfirmModal.hidden = true;
  if (typeof renderWorkspaceBlocks === 'function' && currentDoc.loadState === 'ready') {
    renderWorkspaceBlocks(streamSearchInput?.value?.trim?.() || '');
  }
  updateDocumentActions();
}

function updateDocumentConfigNotice() {
  const conflict = Boolean(currentDoc.configConflict);
  configNotice.hidden = !conflict && !currentDoc.previousTranslation;
  configNotice.querySelector('[data-config-message]').textContent = conflict
    ? '翻译设置已变化，已暂停以避免混用译文。已有内容可继续阅读和导出。'
    : '正在使用新配置；上一版译文保留至关闭或替换文档。';
  configNotice.querySelector('[data-config-keep]').hidden = !conflict;
  configNotice.querySelector('[data-config-new]').hidden = !conflict;
  configNotice.querySelector('[data-config-restore]').hidden = !currentDoc.previousTranslation;
}

function checkDocumentConfig(latest) {
  const doc = currentDoc;
  if (!doc.translationConfig) return;
  const signature = documentConfigSignature(latest);
  const matches = signature === documentConfigSignature(doc.translationConfig) || signature === doc.acceptedGlobalConfig;
  if (!matches && !doc.configConflict) stopDocumentTranslations();
  doc.configConflict = !matches;
  updateDocumentConfigNotice();
}

async function getDocumentTranslationSettings() {
  const doc = currentDoc, session = documentSession;
  const latest = await getSettings();
  if (currentDoc !== doc || session !== documentSession) throw new DOMException('文档翻译已取消', 'AbortError');
  checkDocumentConfig(latest);
  if (doc.configConflict) throw new Error('翻译设置已变化，请选择继续原配置或按新配置重译。');
  doc.translationConfig ||= snapshotDocumentConfig(latest);
  return { ...latest, ...doc.translationConfig };
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.immersive_gemini_settings_v1 || !currentDoc.translationConfig) return;
  const doc = currentDoc;
  const latest = await getSettings();
  if (currentDoc === doc) checkDocumentConfig(latest);
});

let documentConfigChoicePending = false;
async function withDocumentConfigChoice(apply) {
  if (documentConfigChoicePending) return;
  documentConfigChoicePending = true;
  const doc = currentDoc, session = documentSession;
  configNotice.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    const latest = await getSettings();
    if (doc === currentDoc && session === documentSession) apply(doc, latest);
  } catch (error) {
    if (doc === currentDoc) docStatusSubtitle.textContent = `配置选择失败：${error?.message || error}，已保留已有译文。`;
  } finally {
    documentConfigChoicePending = false;
    configNotice.querySelectorAll('button').forEach(button => { button.disabled = false; });
  }
}

configNotice.querySelector('[data-config-keep]').addEventListener('click', () => withDocumentConfigChoice((doc, latest) => {
  doc.acceptedGlobalConfig = documentConfigSignature(latest);
  doc.configConflict = false;
  updateDocumentConfigNotice();
  void startDocumentTranslation();
}));

configNotice.querySelector('[data-config-new]').addEventListener('click', () => withDocumentConfigChoice((doc, latest) => {
  stopDocumentTranslations();
  doc.previousTranslation = {
    blocks: structuredClone(doc.blocks), translatedPages: new Set(doc.translatedPages),
    forceRetranslatePages: new Set(doc.forceRetranslatePages || []),
    failedPages: new Map(doc.failedPages || []),
    translationConfig: doc.translationConfig, targetLang: doc.targetLang
  };
  doc.translationConfig = snapshotDocumentConfig(latest);
  doc.acceptedGlobalConfig = null;
  doc.configConflict = false;
  doc.translatedPages.clear();
  doc.failedPages = new Map();
  doc.forceRetranslatePages = new Set(doc.fileType === 'pdf'
    ? Array.from({ length: doc.totalPages }, (_, index) => index + 1) : []);
  for (const block of doc.blocks) {
    block.translation = block.type === 'code' ? block.original : '';
    if (block.originalImageDataUrl) block.imageDataUrl = block.originalImageDataUrl;
    block.isCanvasInpainted = false;
    block.figureLabels = (block.figureLabels || []).map(label => ({ ...label, translation: '' }));
    block.figureTranslationPending = block.type === 'figure' && Boolean(block.originalImageDataUrl || block.figureLabels.length);
    block.figureTranslationError = '';
  }
  updateDocumentConfigNotice();
  renderWorkspaceBlocks(streamSearchInput.value.trim());
  void startDocumentTranslation();
}));

configNotice.querySelector('[data-config-restore]').addEventListener('click', () => withDocumentConfigChoice((doc, latest) => {
  const previous = doc.previousTranslation;
  if (!previous) return;
  stopDocumentTranslations();
  Object.assign(doc, previous);
  doc.previousTranslation = null;
  doc.acceptedGlobalConfig = documentConfigSignature(latest);
  doc.configConflict = false;
  updateDocumentConfigNotice();
  renderWorkspaceBlocks(streamSearchInput.value.trim());
  updateDocumentActions();
  docStatusSubtitle.textContent = '已恢复上一版译文；继续翻译将使用该版原配置。';
}));
window.addEventListener('pagehide', () => {
  documentRequests.cancel();
  disposePdfPreviewResources();
  void currentDoc.pdfDoc?.destroy().catch(() => {});
});

// Invalidates callbacks from a replaced document, including online downloads.
let documentSession = 0;
function beginDocumentSession() {
  configNotice.hidden = true;
  clearTimeout(programmaticScrollTimer);
  programmaticScrollTimer = null;
  isProgrammaticRightScroll = false;
  documentRequests.cancel();
  disposePdfPreviewResources();
  void currentDoc.pdfDoc?.destroy().catch(() => {});
  if (currentDoc.pdfBlobUrl) URL.revokeObjectURL(currentDoc.pdfBlobUrl);
  documentSession++;
  lazyPageQueue.length = 0;
  lazyPageObserver?.disconnect();
  leftPdfPageObserver?.disconnect();
  currentDoc.translatingPages?.clear();
  isTranslating = false;
  isProcessingLazyQueue = false;
  isExportBatchRunning = false;
  stopRequested = false;
  abortExportBatchMode = null;
  if (pdfExportConfirmModal) pdfExportConfirmModal.hidden = true;
  if (confirmPdfExportBtn) confirmPdfExportBtn.disabled = false;
  return documentSession;
}

// ============================================================================
// 1. File Upload, Online PDF Direct Fetch & Format Parsers
// ============================================================================

fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) handleFileLoaded(file);
});

if (loadOnlinePdfBtn && onlinePdfUrlInput) {
  loadOnlinePdfBtn.addEventListener('click', () => {
    const url = onlinePdfUrlInput.value.trim();
    if (url) {
      loadOnlinePdfFromUrl(url, true);
    }
  });
  onlinePdfUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const url = onlinePdfUrlInput.value.trim();
      if (url) {
        loadOnlinePdfFromUrl(url, true);
      }
    }
  });
}

dropzoneCard.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzoneCard.classList.add('is-dragover');
});

dropzoneCard.addEventListener('dragleave', () => {
  dropzoneCard.classList.remove('is-dragover');
});

dropzoneCard.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzoneCard.classList.remove('is-dragover');
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFileLoaded(file);
});

/**
 * Fetches an online PDF URL directly inside the extension tab (no manual download needed),
 * mounts the native PDF viewer on the left pane, and starts progressive bilingual translation on the right.
 */
async function loadOnlinePdfFromUrl(rawUrl, autoStartTranslate = true) {
  const pdfUrl = normalizeOnlinePdfUrl(rawUrl);
  if (!pdfUrl) return;
  const session = beginDocumentSession();
  setDocumentLoadState('loading');
  const budget = createDocumentBudget({ signal: documentRequests.signal });
  const signal = budget.signal;

  if (onlinePdfUrlInput) {
    onlinePdfUrlInput.value = pdfUrl;
  }

  let inferredName = 'online-paper.pdf';
  try {
    const parsedUrl = new URL(pdfUrl);
    const seg = parsedUrl.pathname.split('/').filter(Boolean).pop() || 'paper';
    inferredName = seg.endsWith('.pdf') ? seg : `${seg}.pdf`;
  } catch (_) {
    // Keep fallback name
  }

  emptyDropzoneSection.hidden = true;
  workspaceSplitMain.hidden = false;
  epubChapterSelectWrap.hidden = true;
  if (pdfCanvasScrollViewer) pdfCanvasScrollViewer.hidden = true;
  pdfNativeEmbed.hidden = true;
  sourceOutlineViewer.hidden = false;
  sourceOutlineViewer.innerHTML = `
    <div class="source-outline-item">⏳ 正在拉取原 PDF 文档：<b>${escapeHtml(inferredName)}</b> …</div>
  `;
  if (pdfPageJumpWrap) pdfPageJumpWrap.hidden = false;

  docStatusSubtitle.textContent = `正在在线拉取 PDF：${pdfUrl} …`;
  leftPaneTitle.textContent = `📕 在线 PDF (${inferredName})`;
  progressBarWrap.hidden = false;
  progressBarFill.style.width = '18%';

  bilingualStreamContainer.innerHTML = `
    <div class="stream-block-card">
      <div class="stream-orig">⏳ 正在直接拉取在线 PDF 文档：<b>${escapeHtml(pdfUrl)}</b></div>
      <div class="stream-trans">拉取完成后将优先翻译前 ${INITIAL_EAGER_PDF_PAGES} 页，向下滚动时自动按需续译后续页面（避免一次性消耗过多 Token）…</div>
    </div>
  `;

  try {
    const response = await budget.wait(fetch(pdfUrl, {
      signal,
      method: 'GET',
      credentials: 'omit',
      headers: {
        Accept: 'application/pdf,*/*;q=0.8'
      }
    }));
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`在线 PDF 下载失败 (HTTP ${response.status})`);
    }
    const ab = await readBoundedResponse(response, budget);
    if (session !== documentSession) return;
    const headerBytes = new Uint8Array(ab.slice(0, 8));
    const headerAscii = new TextDecoder('ascii').decode(headerBytes);
    const isPdfBinary = headerAscii.startsWith('%PDF-');

    if (!response.ok || !isPdfBinary) {
      setDocumentLoadState('error');
      // Do not restart an unbounded native download after a failed import.
      pdfNativeEmbed.hidden = true;
      pdfNativeEmbed.removeAttribute('src');
      progressBarWrap.hidden = true;
      docStatusSubtitle.textContent = `⚠️ 在线 PDF 地址未返回有效 PDF 文件 (HTTP ${response.status})`;
      bilingualStreamContainer.innerHTML = `
        <div class="stream-block-card">
          <div class="stream-orig" style="color:#fca5a5;font-weight:600;">
            ⚠️ 无法从 <code>${escapeHtml(pdfUrl)}</code> 获取有效的 PDF 二进制流（服务器返回状态：HTTP ${response.status}）。
          </div>
          <div class="stream-trans">
            请确认左侧视图中的在线论文编号或链接是否已正式发布。<br/><br/>
            您可以直接在顶部输入框替换为任意真实在线 PDF 链接，或点击下方按钮立即测试真实的 arXiv 论文在线直译：
            <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
              <button id="tryRealArxivBtn1" class="primary-action-btn mini-btn" type="button">
                📄 实测 arXiv 真实论文 (Attention Is All You Need - 1706.03762)
              </button>
              <button id="tryRealArxivBtn2" class="ghost-btn mini-btn" type="button">
                📄 实测 arXiv 真实论文 (DeepSeek-R1 - 2501.12948)
              </button>
            </div>
          </div>
        </div>
      `;
      document.getElementById('tryRealArxivBtn1')?.addEventListener('click', () => {
        loadOnlinePdfFromUrl('https://arxiv.org/pdf/1706.03762', true);
      });
      document.getElementById('tryRealArxivBtn2')?.addEventListener('click', () => {
        loadOnlinePdfFromUrl('https://arxiv.org/pdf/2501.12948', true);
      });
      return;
    }

    const file = { name: inferredName, size: ab.byteLength };
    await handleFileLoaded(file, {
      session,
      budget,
      buffer: ab,
      sourceUrl: pdfUrl,
      autoStartTranslate
    });
  } catch (err) {
    if (session !== documentSession) return;
    setDocumentLoadState('error');
    progressBarWrap.hidden = true;
    docStatusSubtitle.textContent = `⚠️ 在线加载 PDF 失败: ${err?.message || err}`;
    bilingualStreamContainer.innerHTML = `
      <div class="stream-block-card">
        <div class="stream-orig" style="color:#fca5a5;">⚠️ 在线加载 PDF 失败：${escapeHtml(err?.message || String(err))}</div>
        <div class="stream-trans">请检查网络连接或该 PDF 链接是否可公开访问。</div>
      </div>
    `;
  } finally {
    budget.dispose();
  }
}

async function handleFileLoaded(file, options = {}) {
  const session = options.session ?? beginDocumentSession();
  if (session !== documentSession) return;
  const budget = options.budget || createDocumentBudget({ signal: documentRequests.signal });
  let pendingPdfOpen = null;
  try {
    const name = file.name;
    const ext = name.split('.').pop().toLowerCase();

    if (currentDoc.pdfBlobUrl) {
      URL.revokeObjectURL(currentDoc.pdfBlobUrl);
    }
    lazyPageQueue.length = 0;

    currentDoc = {
      loadState: 'loading',
      fileName: name.replace(/\.[^.]+$/, ''),
      fileType: ext,
      pdfBlobUrl: '',
      pdfSourceUrl: options.sourceUrl || '',
      pdfArrayBuffer: null,
      pdfDoc: null,
      pageRenderCache: new Map(),
      totalPages: 1,
      translatedPages: new Set(),
      translatingPages: new Set(),
      lazyScrollEnabled: false,
      lazyScrollTriggered: false,
      bookTitle: name.replace(/\.[^.]+$/, ''),
      bookAuthor: '',
      chapters: [],
      blocks: []
    };

    emptyDropzoneSection.hidden = true;
    workspaceSplitMain.hidden = false;
    epubChapterSelectWrap.hidden = true;
    if (pdfCanvasScrollViewer) pdfCanvasScrollViewer.hidden = true;
    pdfNativeEmbed.hidden = true;
    sourceOutlineViewer.hidden = false;
    if (pdfPageJumpWrap) pdfPageJumpWrap.hidden = true;
    setDocumentLoadState('loading');
    startTranslateDocBtn.textContent = '✦ 开始翻译';

    docStatusSubtitle.textContent = options.sourceUrl
      ? `正在解析在线 PDF：${name}`
      : `正在解析文档：${name}`;

    const ab = options.buffer || await readBoundedFile(file, budget);
    budget.check();
    if (session !== documentSession) return;

    if (ext === 'pdf') {
      currentDoc.fileType = 'pdf';
      if (session !== documentSession) return;
      if (!new TextDecoder('ascii').decode(ab.slice(0, 8)).startsWith('%PDF-')) {
        throw new Error('文件不是有效的 PDF 文档');
      }
      currentDoc.pdfArrayBuffer = ab;
      pendingPdfOpen = openPdfDocument(ab, { signal: budget.signal });
      const opened = await budget.wait(pendingPdfOpen);
      if (session !== documentSession) {
        void opened.pdfDoc?.destroy().catch(() => {});
        return;
      }
      if (!opened.pdfDoc) throw new Error('PDF 无法解析，请检查文件是否损坏、加密或不受支持');
      currentDoc.pdfDoc = opened.pdfDoc;
      pendingPdfOpen = null;
      currentDoc.totalPages = Math.max(1, opened.numPages || estimatePdfPageCount(ab));
      currentDoc.pdfBlobUrl = URL.createObjectURL(new Blob([ab], { type: 'application/pdf' }));

      document.title = `${name} - 双语 PDF 对照翻译 | 青简 · 译读`;
      leftPaneTitle.textContent = `📕 ${name} (共 ${currentDoc.totalPages} 页)`;
      sourceOutlineViewer.hidden = true;

      if (currentDoc.pdfDoc && pdfCanvasScrollViewer) {
        pdfNativeEmbed.hidden = true;
        pdfCanvasScrollViewer.hidden = false;
        const ok = await budget.wait(initLeftPdfScrollViewer());
        if (session !== documentSession) return;
        if (!ok) {
          showNativePdfEmbed(currentDoc.pdfBlobUrl);
        }
      } else {
        showNativePdfEmbed(currentDoc.pdfBlobUrl);
      }

      if (pdfPageJumpWrap) {
        pdfPageJumpWrap.hidden = false;
        if (jumpPageInput) {
          jumpPageInput.max = String(currentDoc.totalPages);
          jumpPageInput.value = '1';
        }
        if (totalPagesBadge) {
          totalPagesBadge.textContent = `/ ${currentDoc.totalPages}`;
        }
      }
      progressCounterBadge.textContent = `0 / ${currentDoc.totalPages} 页`;

      if (pdfModeSelect && pdfModeSelect.value === 'local-stream') {
        const localBlocks = await extractPdfBlocksLocally(ab, { budget });
        if (session !== documentSession) return;
        if (localBlocks.length > 0) {
          adoptParsedBlocks(localBlocks);
          renderWorkspaceBlocks();
        }
      } else {
        bilingualStreamContainer.innerHTML = `
          <div class="stream-block-card">
            <div class="stream-orig">已就绪（共 <b>${currentDoc.totalPages}</b> 页）：点击顶部 <b>✦ 开始翻译</b>，将默认首译前 ${Math.min(
              INITIAL_EAGER_PDF_PAGES,
              currentDoc.totalPages
            )} 页，并在您向下滚动阅读时自动按需翻译后续页面（大幅节省 Token）。</div>
          </div>
        `;
      }

    } else if (ext === 'epub') {
      currentDoc.fileType = 'epub';
      const parsed = await parseEpubFile(ab, { budget });
      if (session !== documentSession) return;
      currentDoc.bookTitle = parsed.bookTitle;
      currentDoc.bookAuthor = parsed.bookAuthor;
      currentDoc.chapters = parsed.chapters;
      adoptParsedBlocks(parsed.blocks);

      leftPaneTitle.textContent = `📗 EPUB: ${parsed.bookTitle}`;
      if (parsed.chapters.length > 0) {
        epubChapterSelectWrap.hidden = false;
        epubChapterSelect.innerHTML =
          `<option value="all">全部章节 (${parsed.blocks.length} 段)</option>` +
          parsed.chapters
            .map((c) => `<option value="${c.index}">${escapeHtml(c.title)} (${c.blocks.length}段)</option>`)
            .join('');
      }
      renderWorkspaceBlocks();
    } else if (ext === 'srt' || ext === 'vtt') {
      currentDoc.fileType = 'srt';
      const text = new TextDecoder().decode(ab);
      if (session !== documentSession) return;
      const cues = parseSubtitles(text).filter(cue => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start);
      if (!cues.length) throw new Error('没有可翻译字幕：文件为空、没有有效字幕条目或时间格式无法解析，请检查 SRT / VTT 文件');
      adoptParsedBlocks(cues.map((c) => ({
        page: 1,
        type: 'subtitle',
        start: c.start,
        end: c.end,
        original: c.text,
        translation: ''
      })));
      leftPaneTitle.textContent = `🎬 字幕文件 (${name})`;
      renderWorkspaceBlocks();
    } else if (ext === 'html' || ext === 'htm') {
      currentDoc.fileType = 'html';
      const text = new TextDecoder().decode(ab);
      if (session !== documentSession) return;
      adoptParsedBlocks(parseHtmlDocumentToBlocks(text));
      if (!currentDoc.blocks.length) throw new Error('HTML 中没有可提取的正文，请检查文件内容或转换为文本后重试');
      leftPaneTitle.textContent = `📙 HTML 文档 (${name})`;
      renderWorkspaceBlocks();
    } else {
      currentDoc.fileType = 'md';
      const text = new TextDecoder().decode(ab);
      if (session !== documentSession) return;
      adoptParsedBlocks(parseMarkdownToBlocks(text));
      leftPaneTitle.textContent = `📘 Markdown / 文本 (${name})`;
      renderWorkspaceBlocks();
    }
    budget.check();
    setDocumentLoadState('ready');
    docStatusSubtitle.textContent = `已加载文档：${name}`;
    if (options.autoStartTranslate) void startDocumentTranslation();
  } catch (err) {
    // A timed-out open may resolve just after cancellation; it still owns a worker.
    if (pendingPdfOpen) void pendingPdfOpen.then(opened => opened.pdfDoc?.destroy()).catch(() => {});
    if (session !== documentSession) return;
    documentRequests.cancel();
    disposePdfPreviewResources(currentDoc);
    void currentDoc.pdfDoc?.destroy().catch(() => {});
    currentDoc.pdfDoc = null;
    currentDoc.pdfArrayBuffer = null;
    currentDoc.blocks = [];
    if (currentDoc.pdfBlobUrl) URL.revokeObjectURL(currentDoc.pdfBlobUrl);
    currentDoc.pdfBlobUrl = '';
    pdfNativeEmbed.hidden = true;
    pdfNativeEmbed.removeAttribute('src');
    setDocumentLoadState('error');
    progressBarWrap.hidden = true;
    docStatusSubtitle.textContent = `⚠️ 文档加载失败: ${err?.message || err}`;
    startTranslateDocBtn.disabled = true;
  } finally {
    if (!options.budget) budget.dispose();
  }

}

// Code imported from HTML/EPUB is raw text; only Markdown parser-owned
// fences may be reused. Raw code can itself contain apparent fence lines.
function serializeMarkdownCode(block) {
  const source = String(block.original || '');
  if (block.codeFence) {
    const marker = block.codeFence;
    const lines = source.split('\n');
    const closing = lines.slice(1).some(line => {
      const match = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
      return match && match[1][0] === marker[0] && match[1].length >= marker.length;
    });
    return closing ? source : `${source}\n${marker}`;
  }
  let longest = 0;
  for (const match of source.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${source}\n${fence}`;
}

function parseMarkdownToBlocks(mdText) {
  const lines = mdText.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let inCodeFence = false;
  let fenceMarker = '';
  let codeBuffer = [];
  let paraBuffer = [];

  const flushPara = () => {
    if (paraBuffer.length === 0) return;
    const text = paraBuffer.join(' ').trim();
    paraBuffer = [];
    if (!text) return;
    const isHeading = /^#{1,6}\s+/.test(text);
    blocks.push({
      id: blocks.length,
      page: 1,
      type: isHeading ? 'heading' : 'paragraph',
      original: text,
      translation: ''
    });
  };

  for (const line of lines) {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence && (!inCodeFence || (fence[1][0] === fenceMarker[0] && fence[1].length >= fenceMarker.length && !fence[2].trim()))) {
      if (!inCodeFence) {
        flushPara();
        inCodeFence = true;
        fenceMarker = fence[1];
        codeBuffer = [line];
      } else {
        codeBuffer.push(line);
        inCodeFence = false;
        const codeStr = codeBuffer.join('\n');
        blocks.push({
          id: blocks.length,
          page: 1,
          type: 'code',
          original: codeStr,
          translation: codeStr, // Code blocks stay untranslated
          codeFence: fenceMarker
        });
        codeBuffer = [];
      }
      continue;
    }

    if (inCodeFence) {
      codeBuffer.push(line);
      continue;
    }

    if (!line.trim()) {
      flushPara();
      continue;
    }

    if (/^#{1,6}\s+/.test(line.trim()) || /^[-*+]\s+/.test(line.trim()) || /^\d+\.\s+/.test(line.trim())) {
      flushPara();
      blocks.push({
        id: blocks.length,
        page: 1,
        type: /^#{1,6}\s+/.test(line.trim()) ? 'heading' : 'list',
        original: line.trim(),
        translation: ''
      });
    } else {
      paraBuffer.push(line.trim());
    }
  }
  if (inCodeFence) {
    const codeStr = codeBuffer.join('\n');
    blocks.push({ id: blocks.length, page: 1, type: 'code', original: codeStr, translation: codeStr, codeFence: fenceMarker });
  }
  flushPara();
  return blocks;
}

function parseHtmlDocumentToBlocks(htmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlText, 'text/html');
  const blocks = [];
  const boundaries = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'DT', 'DD',
    'FIELDSET', 'FIGURE', 'FIGCAPTION', 'FOOTER', 'FORM', 'HEADER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'UL']);
  const excluded = el => ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD'].includes(el.tagName) ||
    el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true' ||
    el.style?.display === 'none' || ['hidden', 'collapse'].includes(el.style?.visibility);
  const add = (text, type) => {
    const original = type === 'code' ? text : text.replace(/\s+/g, ' ').trim();
    if (!original.trim()) return;
    blocks.push({ id: blocks.length, page: 1, type, original, translation: type === 'code' ? original : '' });
  };
  const codeText = node => node.nodeType === 3 ? node.nodeValue || ''
    : node.nodeType !== 1 || excluded(node) ? ''
    : node.tagName === 'BR' ? '\n' : Array.from(node.childNodes, codeText).join('');
  const visit = (container, type = 'paragraph') => {
    let text = '';
    const flush = () => { add(text, type); text = ''; };
    const walk = node => {
      if (node.nodeType === 3) { text += node.nodeValue || ''; return; }
      if (node.nodeType !== 1 || excluded(node)) return;
      if (node.tagName === 'BR') { text += '\n'; return; }
      if (boundaries.has(node.tagName)) {
        flush();
        if (node.tagName === 'PRE') add(codeText(node), 'code');
        else visit(node, /^H[1-6]$/.test(node.tagName) ? 'heading' : node.tagName === 'LI' ? 'list' : 'paragraph');
      } else {
        for (const child of node.childNodes) walk(child);
      }
    };
    for (const child of container.childNodes) walk(child);
    flush();
  };
  if (!excluded(doc.body)) visit(doc.body);
  return blocks;
}

// ============================================================================
// 1B. Left Original PDF Smooth Scroll Viewer (Reload-Free Page Navigation)
// ============================================================================

function showNativePdfEmbed(url) {
  if (!url || !pdfNativeEmbed) return;
  if (pdfCanvasScrollViewer) {
    pdfCanvasScrollViewer.hidden = true;
  }
  if (sourceOutlineViewer) {
    sourceOutlineViewer.hidden = true;
  }
  pdfNativeEmbed.hidden = false;
  pdfNativeEmbed.setAttribute('src', url);
  pdfNativeEmbed.src = url;
}

const MAX_CACHED_PAGE_RENDERS = 8;
const MAX_LEFT_PDF_PREVIEWS = 6;
const MAX_CONCURRENT_PDF_RENDERS = 2;

function releasePdfRender(rendered) {
  if (!rendered) return;
  if (rendered.canvas) { rendered.canvas.width = 0; rendered.canvas.height = 0; }
  rendered.canvas = null;
  rendered.jpegDataUrl = '';
  rendered.jpegBase64 = '';
  rendered.textItems = [];
}

function getPdfRenderState(doc) {
  return doc.pdfRenderState ||= { active: 0, queue: [], records: new Map(), disposed: false };
}

function evictPdfPageRender(doc, page) {
  if (doc.translatingPages?.has(page)) return;
  const state = getPdfRenderState(doc);
  const entry = state.records.get(page);
  if (!entry) return;
  state.records.delete(page);
  doc.pageRenderCache?.delete(page);
  entry.controller.abort();
  releasePdfRender(entry.result);
  if (!entry.started) {
    state.queue = state.queue.filter(item => item !== entry);
    entry.resolve(null);
  }
  void Promise.resolve().then(() => drainPdfRenderQueue(doc));
}

function trimPdfPageRenderCache(doc) {
  for (const page of doc.pageRenderCache?.keys() || []) {
    if (doc.pageRenderCache.size <= MAX_CACHED_PAGE_RENDERS) break;
    if (!doc.leftPreviewWanted?.has(page)) evictPdfPageRender(doc, page);
  }
}

function releaseLeftPdfSlot(slot) {
  if (slot.dataset.pageRatio) {
    slot.style.minHeight = '0';
    slot.style.aspectRatio = String(1 / Number(slot.dataset.pageRatio));
  }
  slot.querySelector('img')?.removeAttribute('src');
  slot.innerHTML = `<span class="left-pdf-page-badge">Page ${Number(slot.dataset.leftPdfPage)}</span>
    <div class="left-pdf-page-placeholder" style="position:absolute;inset:0;padding:0;display:grid;place-items:center">滚动到此页时恢复原文预览</div>`;
  slot.classList.remove('is-rendered');
  delete slot.dataset.rendered;
  delete slot.dataset.rendering;
  delete slot.pdfPreviewPromise;
}

function disposePdfPreviewResources(doc = currentDoc) {
  const state = getPdfRenderState(doc);
  state.disposed = true;
  doc.leftPreviewWanted?.clear();
  doc.leftVisiblePages?.clear();
  // The old document is no longer readable by translators after its session ends.
  for (const entry of state.records.values()) {
    entry.controller.abort();
    releasePdfRender(entry.result);
    if (!entry.started) entry.resolve(null);
  }
  state.queue.length = 0;
  state.records.clear();
  doc.pageRenderCache?.clear();
  doc.pdfArrayBuffer = null;
  if (doc.pdfBlobUrl) URL.revokeObjectURL(doc.pdfBlobUrl);
  doc.pdfBlobUrl = '';
  if (doc === currentDoc) {
    pdfNativeEmbed?.removeAttribute('src');
    leftPdfPageObserver?.disconnect();
    pdfCanvasScrollViewer?.querySelectorAll('.left-pdf-page-slot').forEach(releaseLeftPdfSlot);
  }
}

function drainPdfRenderQueue(doc) {
  const state = getPdfRenderState(doc);
  while (!state.disposed && state.active < MAX_CONCURRENT_PDF_RENDERS && state.queue.length) {
    // Pins may defer eviction, but must never allow another large canvas beyond
    // the eight resident/rendering slots. Wait for a translator to release one.
    if ([...state.records.values()].filter(record => record.started).length >= MAX_CACHED_PAGE_RENDERS) {
      const victim = [...doc.pageRenderCache.keys()].find(page => {
        const record = state.records.get(page);
        return record?.started && !doc.leftPreviewWanted?.has(page) && !doc.translatingPages?.has(page);
      });
      if (victim === undefined) break;
      evictPdfPageRender(doc, victim);
    }
    const entry = state.queue.shift();
    if (state.records.get(entry.page) !== entry) continue;
    entry.started = true;
    state.active++;
    Promise.resolve().then(() => {
      entry.controller.signal.throwIfAborted();
      return renderPdfPageToCanvas(doc.pdfDoc, entry.page, 2.0, { signal: entry.controller.signal });
    }).then(rendered => {
      if (state.disposed || entry.controller.signal.aborted || state.records.get(entry.page) !== entry) {
        releasePdfRender(rendered);
        return null;
      }
      entry.result = rendered;
      if (!rendered) { state.records.delete(entry.page); doc.pageRenderCache.delete(entry.page); }
      return rendered;
    }, error => {
      if (state.records.get(entry.page) === entry) { state.records.delete(entry.page); doc.pageRenderCache.delete(entry.page); }
      if (!entry.controller.signal.aborted) throw error;
      return null;
    }).then(entry.resolve, entry.reject).finally(() => {
      state.active--;
      trimPdfPageRenderCache(doc);
      drainPdfRenderQueue(doc);
    });
  }
}

async function getOrRenderPdfPage(pageNum) {
  const doc = currentDoc;
  if (!doc.pdfDoc) return null;
  const state = getPdfRenderState(doc);
  if (state.disposed) return null;
  const p = Math.max(1, Math.min(doc.totalPages || 1, Number(pageNum) || 1));
  doc.pageRenderCache ||= new Map();
  if (doc.pageRenderCache.has(p)) {
    const cached = doc.pageRenderCache.get(p);
    doc.pageRenderCache.delete(p);
    doc.pageRenderCache.set(p, cached);
    return cached;
  }
  const entry = { page: p, controller: new AbortController(), signal: documentRequests.signal, started: false, result: null };
  entry.cancel = () => {
    entry.controller.abort();
    if (!entry.started) {
      state.records.delete(p);
      doc.pageRenderCache.delete(p);
      state.queue = state.queue.filter(item => item !== entry);
      entry.resolve(null);
    }
  };
  entry.promise = new Promise((resolve, reject) => {
    entry.resolve = value => { entry.signal.removeEventListener('abort', entry.cancel); resolve(value); };
    entry.reject = error => { entry.signal.removeEventListener('abort', entry.cancel); reject(error); };
  });
  state.records.set(p, entry);
  doc.pageRenderCache.set(p, entry.promise);
  state.queue.push(entry);
  entry.signal.addEventListener('abort', entry.cancel, { once: true });
  if (entry.signal.aborted) entry.cancel();
  trimPdfPageRenderCache(doc);
  drainPdfRenderQueue(doc);
  return entry.promise;
}

function setLeftPdfPreviewWindow(pages) {
  const doc = currentDoc;
  const wanted = new Set(pages.slice(0, MAX_LEFT_PDF_PREVIEWS));
  doc.leftPreviewWanted = wanted;
  for (const slot of pdfCanvasScrollViewer.querySelectorAll('.left-pdf-page-slot')) {
    const page = Number(slot.dataset.leftPdfPage);
    if (!wanted.has(page)) {
      if (slot.dataset.rendered || slot.dataset.rendering) releaseLeftPdfSlot(slot);
      evictPdfPageRender(doc, page);
    }
  }
  for (const page of wanted) void ensureLeftPdfPageRendered(page);
}

async function ensureLeftPdfPageRendered(pageNum) {
  const doc = currentDoc;
  if (!pdfCanvasScrollViewer || !doc.pdfDoc || getPdfRenderState(doc).disposed) return false;
  const p = Math.max(1, Math.min(doc.totalPages || 1, Number(pageNum) || 1));
  if (!doc.leftPreviewWanted?.has(p)) return false;
  const slot = pdfCanvasScrollViewer.querySelector(`.left-pdf-page-slot[data-left-pdf-page="${p}"]`);
  if (!slot) return false;
  if (slot.dataset.rendered === '1') return true;
  if (slot.pdfPreviewPromise) return slot.pdfPreviewPromise;
  slot.dataset.rendering = '1';
  const pending = (async () => {
    let rendered;
    try { rendered = await getOrRenderPdfPage(p); }
    catch (error) {
      if (currentDoc === doc && slot.isConnected && doc.leftPreviewWanted?.has(p)) {
        const placeholder = slot.querySelector('.left-pdf-page-placeholder');
        if (placeholder) placeholder.textContent = `预览暂不可用：${error?.message || error}。请稍后返回此页重试。`;
        docStatusSubtitle.textContent = `⚠️ 第 ${p} 页预览失败：${error?.message || error}`;
      }
      return false;
    }
    if (currentDoc !== doc || !doc.leftPreviewWanted?.has(p) || !slot.isConnected || getPdfRenderState(doc).disposed) return false;
    const imgSrc = rendered?.jpegDataUrl || (rendered?.jpegBase64 ? `data:image/jpeg;base64,${rendered.jpegBase64}` : '');
    if (!imgSrc) return false;
    slot.dataset.pageRatio = String(rendered.height / rendered.width);
    slot.style.minHeight = '0';
    slot.style.aspectRatio = `${rendered.width} / ${rendered.height}`;
    slot.innerHTML = `<span class="left-pdf-page-badge">Page ${p} / ${doc.totalPages || 1}</span>
      <img class="left-pdf-page-img" src="${imgSrc}" alt="Original PDF Page ${p}" />`;
    slot.classList.add('is-rendered');
    slot.dataset.rendered = '1';
    return true;
  })();
  slot.pdfPreviewPromise = pending;
  try { return await pending; }
  finally {
    if (slot.pdfPreviewPromise === pending) { delete slot.pdfPreviewPromise; delete slot.dataset.rendering; }
  }
}

async function initLeftPdfScrollViewer() {
  const doc = currentDoc;
  if (!pdfCanvasScrollViewer || !doc.pdfDoc) return false;
  leftPdfPageObserver?.disconnect();
  const total = Math.max(1, doc.totalPages || 1);
  doc.leftVisiblePages = new Set();
  doc.leftPreviewWanted = new Set(total >= 2 ? [1, 2] : [1]);
  pdfCanvasScrollViewer.innerHTML = Array.from({ length: total }, (_, idx) => {
    const p = idx + 1;
    return `<div class="left-pdf-page-slot" data-left-pdf-page="${p}">
      <span class="left-pdf-page-badge">Page ${p} / ${total}</span>
      <div class="left-pdf-page-placeholder">正在加载原文档第 ${p} / ${total} 页…</div>
    </div>`;
  }).join('');
  if (typeof IntersectionObserver !== 'undefined') {
    leftPdfPageObserver = new IntersectionObserver(entries => {
      if (currentDoc !== doc || getPdfRenderState(doc).disposed) return;
      for (const entry of entries) {
        const page = Number(entry.target.dataset.leftPdfPage);
        if (entry.isIntersecting) doc.leftVisiblePages.add(page); else doc.leftVisiblePages.delete(page);
      }
      const center = pdfCanvasScrollViewer.getBoundingClientRect().top + pdfCanvasScrollViewer.clientHeight / 2;
      const near = [...doc.leftVisiblePages].sort((a, b) => {
        const distance = page => {
          const rect = pdfCanvasScrollViewer.querySelector(`[data-left-pdf-page="${page}"]`).getBoundingClientRect();
          return Math.abs((rect.top + rect.bottom) / 2 - center);
        };
        return distance(a) - distance(b);
      });
      if (near.length) setLeftPdfPreviewWindow(near);
    }, { root: pdfCanvasScrollViewer, rootMargin: '240px 0px', threshold: 0.01 });
    pdfCanvasScrollViewer.querySelectorAll('.left-pdf-page-slot').forEach(el => leftPdfPageObserver.observe(el));
  }
  const page1Ok = await ensureLeftPdfPageRendered(1);
  if (currentDoc !== doc) return false;
  if (total >= 2 && doc.leftPreviewWanted.has(2)) void ensureLeftPdfPageRendered(2);
  return page1Ok;
}

function suppressLazyObserverBriefly(durationMs = 750) {
  isProgrammaticRightScroll = true;
  if (programmaticScrollTimer) {
    clearTimeout(programmaticScrollTimer);
  }
  programmaticScrollTimer = setTimeout(() => {
    isProgrammaticRightScroll = false;
    programmaticScrollTimer = null;
  }, durationMs);
}

/**
 * Smoothly scrolls ONLY the left original PDF viewer to `pageNum` without reloading
 * the PDF or triggering any right-pane translation.
 */
function scrollLeftPdfToPage(pageNum) {
  const clamped = Math.max(1, Math.min(currentDoc.totalPages || 999, Number(pageNum) || 1));
  if (jumpPageInput) {
    jumpPageInput.value = String(clamped);
  }

  if (currentDoc.fileType !== 'pdf') return;

  if (pdfCanvasScrollViewer && !pdfCanvasScrollViewer.hidden && currentDoc.pdfDoc) {
    const slot = pdfCanvasScrollViewer.querySelector(
      `.left-pdf-page-slot[data-left-pdf-page="${clamped}"]`
    );
    if (slot) {
      setLeftPdfPreviewWindow([clamped, clamped + 1, clamped - 1].filter(page => page >= 1 && page <= currentDoc.totalPages));
      slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
      pdfCanvasScrollViewer
        .querySelectorAll('.left-pdf-page-slot.is-target-pulse')
        .forEach((el) => el.classList.remove('is-target-pulse'));
      slot.classList.add('is-target-pulse');
      setTimeout(() => {
        slot.classList.remove('is-target-pulse');
      }, 1300);
      return;
    }
  }

  if (pdfNativeEmbed && !pdfNativeEmbed.hidden && (currentDoc.pdfBlobUrl || currentDoc.pdfSourceUrl)) {
    const baseUrl = (currentDoc.pdfBlobUrl || currentDoc.pdfSourceUrl).split('#')[0];
    showNativePdfEmbed(`${baseUrl}#page=${clamped}`);
  }
}

// ============================================================================
// 2. Render Split View (Preserve Original Paper Layout + Classic Card Stream)
// ============================================================================

function renderTocSidebar() {
  if (!pdfTocList || !pdfTocCountBadge) return;
  const tocItems = currentDoc.blocks.filter(
    (b) => b.type === 'heading' || b.type === 'figure'
  );
  pdfTocCountBadge.textContent = String(tocItems.length);
  const tocPager = document.getElementById('documentTocPager');

  if (tocItems.length === 0) {
    if (tocPager) tocPager.hidden = true;
    pdfTocList.innerHTML = `<div style="padding:10px;font-size:11.5px;color:#64748b;">暂无章节或图表索引</div>`;
    return;
  }

  const tocPageCount = Math.max(1, Math.ceil(tocItems.length / DOCUMENT_READING_PAGE_SIZE));
  currentDoc.tocWindowPage = Math.min(Math.max(0, currentDoc.tocWindowPage || 0), tocPageCount - 1);
  if (tocPager) {
    tocPager.hidden = currentDoc.fileType === 'pdf' || tocPageCount <= 1;
    tocPager.querySelector('[data-toc-window-status]').textContent = `${currentDoc.tocWindowPage + 1} / ${tocPageCount}`;
    tocPager.querySelector('[data-toc-window-step="-1"]').disabled = currentDoc.tocWindowPage === 0;
    tocPager.querySelector('[data-toc-window-step="1"]').disabled = currentDoc.tocWindowPage + 1 >= tocPageCount;
  }
  const shownTocItems = currentDoc.fileType === 'pdf' ? tocItems
    : tocItems.slice(currentDoc.tocWindowPage * DOCUMENT_READING_PAGE_SIZE, (currentDoc.tocWindowPage + 1) * DOCUMENT_READING_PAGE_SIZE);

  pdfTocList.innerHTML = shownTocItems
    .map((b) => {
      const label = (b.translation || b.original || '')
        .replace(/^#{1,6}\s*/, '')
        .replace(/\$\$?[^$]+\$\$?/g, '')
        .slice(0, 46);
      const isFig = b.type === 'figure';
      return `
        <div class="pdf-toc-item ${isFig ? 'is-figure' : ''}" data-toc-block="${b.id}" data-toc-page="${b.page || 1}">
          <span class="pdf-toc-item-page">P${b.page || 1}</span>
          ${isFig ? '🖼️ ' : ''}${escapeHtml(label)}
        </div>
      `;
    })
    .join('');

  pdfTocList.querySelectorAll('.pdf-toc-item').forEach((item) => {
    item.addEventListener('click', () => {
      const blockId = item.dataset.tocBlock;
      const pageNum = Number(item.dataset.tocPage) || 1;
      if (currentDoc.fileType !== 'pdf') {
        revealDocumentBlock(Number(blockId));
        return;
      }
      scrollLeftPdfToPage(pageNum);
      suppressLazyObserverBriefly(800);
      const targetEl = bilingualStreamContainer.querySelector(
        `[data-block-id="${blockId}"]`
      );
      targetEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
}

function renderFigure2DCanvasHtml(b) {
  const labels = Array.isArray(b.figureLabels) ? b.figureLabels : [];
  const hasBgImg = Boolean(b.imageDataUrl);
  const isSeamlessInpainted = Boolean(b.isCanvasInpainted && hasBgImg);

  const labelBoxesHtml = labels
    .map((lbl) => {
      const [ymin, xmin, ymax, xmax] = Array.isArray(lbl.box_2d)
        ? lbl.box_2d
        : [120, 100, 220, 420];
      const topPct = Math.max(0.5, Math.min(96, ymin / 10));
      const leftPct = Math.max(0.5, Math.min(96, xmin / 10));
      const widthPct = Math.max(4, Math.min(99 - leftPct, (xmax - xmin) / 10));
      const heightPct = Math.max(2.5, Math.min(99 - topPct, (ymax - ymin) / 10));
      const tip = lbl.original
        ? `原文: ${lbl.original} → ${lbl.translation || ''}`
        : lbl.translation || '';

      if (isSeamlessInpainted) {
        return `
          <div
            class="paper-fig-hover-hotspot"
            style="top:${topPct.toFixed(1)}%;left:${leftPct.toFixed(1)}%;width:${widthPct.toFixed(1)}%;height:${heightPct.toFixed(1)}%;"
            title="${escapeHtml(tip)}"
          ></div>
        `;
      }

      return `
        <div
          class="paper-fig-label-box"
          style="top:${topPct.toFixed(1)}%;left:${leftPct.toFixed(1)}%;width:${widthPct.toFixed(1)}%;min-height:${heightPct.toFixed(1)}%;"
          title="${escapeHtml(tip)}"
        >
          ${escapeHtml(lbl.translation || lbl.original || '')}
        </div>
      `;
    })
    .join('');

  return `
    <div class="paper-figure-box" data-block-id="${b.id}">
      <div class="paper-figure-hover-bar">
        <span class="paper-figure-hover-badge">
          🖼️ 图中文字覆盖译文 (${labels.length} 处)
        </span>
        <div class="paper-figure-hover-actions">
          ${
            labels.length > 0 || b.originalImageDataUrl
              ? `
            <button type="button" data-toggle-fig-overlay="${b.id}" title="切换查看原图或文字覆盖译图">
              👁️ 对比原图
            </button>
          `
              : ''
          }
          <button type="button" class="retranslate-mini-btn" data-retrans="${b.id}" title="重新翻译下方图注">
            ↻ 重译图注
          </button>
        </div>
      </div>
      ${b.figureTranslationPending ? `<div class="untranslated-label" role="status">图中文字尚未完成重译${b.figureTranslationError ? `：${escapeHtml(b.figureTranslationError)}` : ''}；点击顶部开始翻译可继续。</div>` : ''}
      ${
        hasBgImg || labels.length > 0
          ? `
        <div class="paper-figure-canvas ${hasBgImg ? 'has-bg-image' : ''}" id="paper-fig-canvas-${b.id}">
          ${
            hasBgImg
              ? `<img
                  src="${b.imageDataUrl}"
                  data-translated-src="${b.imageDataUrl}"
                  data-original-src="${b.originalImageDataUrl || b.imageDataUrl}"
                  class="paper-fig-bg-img"
                  alt="Figure"
                />`
              : ''
          }
          ${labelBoxesHtml}
        </div>
      `
          : ''
      }
      <div class="paper-figure-caption">
        <div class="stream-orig">${renderRichAcademicHtml(b.original, {
          blockType: 'caption',
          pageNum: b.page
        })}</div>
        <div class="stream-trans" id="stream-trans-${b.id}">${renderBlockTranslation(b, 'caption')}</div>
      </div>
    </div>
  `;
}

function getExportViewMode(mode = viewModeSelect.value) {
  return mode === 'translation-only' || mode === 'translation-full-width' ? 'translation-only' : 'bilingual';
}

function applyDocumentViewMode() {
  bilingualStreamContainer.classList.toggle('mode-translation-only', getExportViewMode() === 'translation-only');
  workspaceSplitMain.classList.toggle('mode-translation-full-width', viewModeSelect.value === 'translation-full-width');
}

function renderBlockTranslation(block, blockType = block.type) {
  const translated = typeof block.translation === 'string' && block.translation.trim();
  return `${translated || block.type === 'code' || block.type === 'equation' ? '' : '<span class="untranslated-label">未翻译，显示原文</span>'}${renderRichAcademicHtml(
    translated ? block.translation : block.original || '', { blockType, pageNum: block.page }
  )}`;
}

function updateProgressCounterBadge() {
  if (!progressCounterBadge) return;
  if (
    currentDoc.fileType === 'pdf' &&
    (!pdfModeSelect || pdfModeSelect.value === 'gemini-multimodal')
  ) {
    const donePages = currentDoc.translatedPages?.size || 0;
    progressCounterBadge.textContent = `${donePages} / ${currentDoc.totalPages || 1} 页`;
  } else {
    const translatedCount = currentDoc.blocks.filter((b) => Boolean(b.translation) && !b.figureTranslationPending).length;
    progressCounterBadge.textContent = `${translatedCount} / ${currentDoc.blocks.length} 段`;
  }
}

const DOCUMENT_READING_PAGE_SIZE = 100;

function documentReadingRange(total, requestedPage = 0) {
  const pages = Math.max(1, Math.ceil(total / DOCUMENT_READING_PAGE_SIZE));
  const page = Math.max(0, Math.min(pages - 1, Math.floor(Number(requestedPage) || 0)));
  return { page, pages, start: page * DOCUMENT_READING_PAGE_SIZE, end: Math.min(total, (page + 1) * DOCUMENT_READING_PAGE_SIZE) };
}

function selectDocumentReadingWindow(blocks, filterKeyword, selectedChapter) {
  const key = JSON.stringify([filterKeyword.toLowerCase(), selectedChapter]);
  if (currentDoc.readingWindowKey !== key) {
    currentDoc.readingWindowKey = key;
    currentDoc.readingWindowPage = 0;
    bilingualStreamContainer.scrollTop = 0;
    sourceOutlineViewer.scrollTop = 0;
  }
  const range = documentReadingRange(blocks.length, currentDoc.readingWindowPage);
  currentDoc.readingWindowPage = range.page;
  const pager = document.getElementById('documentReadingPager');
  if (pager) {
    pager.hidden = false;
    pager.querySelector('[data-reading-status]').textContent = `第 ${range.page + 1} / ${range.pages} 组 · ${blocks.length ? range.start + 1 : 0}–${range.end} / ${blocks.length} 段`;
    const input = pager.querySelector('[data-reading-page]');
    input.value = String(range.page + 1);
    input.max = String(range.pages);
    pager.querySelector('[data-reading-step="-1"]').disabled = range.page === 0;
    pager.querySelector('[data-reading-step="1"]').disabled = range.page + 1 >= range.pages;
  }
  return blocks.slice(range.start, range.end);
}

function revealDocumentBlock(blockId) {
  const block = currentDoc.blocks.find(item => item.id === blockId);
  if (!block) return;
  streamSearchInput.value = '';
  if (currentDoc.fileType === 'epub' && epubChapterSelect.value !== 'all' && Number(epubChapterSelect.value) !== block.chapterIndex) epubChapterSelect.value = 'all';
  const chapter = currentDoc.fileType === 'epub' && epubChapterSelect.value !== 'all' ? Number(epubChapterSelect.value) : null;
  const scoped = chapter === null ? currentDoc.blocks : currentDoc.blocks.filter(item => item.chapterIndex === chapter);
  currentDoc.readingWindowKey = JSON.stringify(['', chapter]);
  currentDoc.readingWindowPage = Math.floor(scoped.indexOf(block) / DOCUMENT_READING_PAGE_SIZE);
  renderWorkspaceBlocks();
  bilingualStreamContainer.querySelector(`[data-block-id="${blockId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderWorkspaceBlocks(filterKeyword = '', { allChapters = false, forcePaperLayout = false, forExport = false } = {}) {
  applyDocumentViewMode();
  let prevScrollTop = bilingualStreamContainer.scrollTop;

  const selectedChapter =
    !allChapters && currentDoc.fileType === 'epub' && epubChapterSelect.value !== 'all'
      ? Number(epubChapterSelect.value)
      : null;

  let visibleBlocks = currentDoc.blocks.filter((b) => {
    if (selectedChapter !== null && b.chapterIndex !== selectedChapter) return false;
    if (!filterKeyword) return true;
    const kw = filterKeyword.toLowerCase();
    const inLabels =
      Array.isArray(b.figureLabels) &&
      b.figureLabels.some(
        (l) =>
          (l.original && l.original.toLowerCase().includes(kw)) ||
          (l.translation && l.translation.toLowerCase().includes(kw))
      );
    return (
      b.original.toLowerCase().includes(kw) ||
      (b.translation && b.translation.toLowerCase().includes(kw)) ||
      inLabels
    );
  });

  if (!forExport) {
    if (currentDoc.fileType !== 'pdf') {
      const oldWindowKey = currentDoc.readingWindowKey;
      visibleBlocks = selectDocumentReadingWindow(visibleBlocks, filterKeyword, selectedChapter);
      if (oldWindowKey !== currentDoc.readingWindowKey) prevScrollTop = 0;
    } else {
      const pager = document.getElementById('documentReadingPager');
      if (pager) pager.hidden = true;
    }
    updateProgressCounterBadge();
    renderTocSidebar();
  }

  // Render Left Outline if not PDF
  if (!forExport && currentDoc.fileType !== 'pdf') {
    sourceOutlineViewer.innerHTML = visibleBlocks
      .map(
        (b) => `
      <div class="source-outline-item ${b.type === 'heading' ? 'is-heading' : ''} ${
          b.type === 'code' ? 'is-code' : ''
        }" data-target-id="${b.id}">
        ${renderRichAcademicHtml(b.original, { blockType: b.type, pageNum: b.page })}
      </div>
    `
      )
      .join('');

    sourceOutlineViewer.querySelectorAll('.source-outline-item').forEach((el) => {
      el.addEventListener('click', () => {
        const card = bilingualStreamContainer.querySelector(
          `[data-block-id="${el.dataset.targetId}"]`
        );
        card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  }

  const isPaperLayout = forcePaperLayout || !layoutStyleSelect || layoutStyleSelect.value === 'paper-layout';
  const isTwoColumn = paperColumnModeSelect && paperColumnModeSelect.value === 'two-column';

  bilingualStreamContainer.classList.toggle('mode-paper-layout', isPaperLayout);
  if (rightPaneTitle) {
    rightPaneTitle.textContent = isPaperLayout ? '📄 保持排版' : '✦ 卡片流';
  }

  if (isPaperLayout) {
    const pagesMap = new Map();
    for (const b of visibleBlocks) {
      const p = Number(b.page) || 1;
      if (!pagesMap.has(p)) pagesMap.set(p, []);
      pagesMap.get(p).push(b);
    }

    const totalPages = Math.max(
      currentDoc.totalPages || 1,
      ...Array.from(pagesMap.keys()),
      1
    );

    const isPdfLazyMode =
      currentDoc.fileType === 'pdf' &&
      (!pdfModeSelect || pdfModeSelect.value === 'gemini-multimodal') &&
      !filterKeyword;

    const pageNumbersToRender = isPdfLazyMode
      ? Array.from({ length: totalPages }, (_, idx) => idx + 1)
      : Array.from(pagesMap.keys()).sort((a, b) => a - b);

    bilingualStreamContainer.innerHTML = pageNumbersToRender
      .map((pageNum) => {
        const pageBlocks = pagesMap.get(pageNum);
        const pageFailure = currentDoc.failedPages?.get(pageNum);
        if (!pageBlocks || pageBlocks.length === 0) {
          const isLoadingThisPage = currentDoc.translatingPages?.has(pageNum);
          return `
            <article
              class="${forExport ? 'paper-untranslated-page' : 'paper-page-lazy-placeholder'} ${isLoadingThisPage ? 'is-loading-page' : ''}"
              data-paper-page="${pageNum}"
              data-lazy-page="${pageNum}"
            >
              <div class="paper-lazy-title">
                ${
                  forExport ? `第 ${pageNum} / ${totalPages} 页未翻译，原页内容未包含在此 HTML 中，请查阅原 PDF。` : pageFailure
                    ? `⚠️ 第 ${pageNum} / ${totalPages} 页翻译失败（已停止自动重试）` : isLoadingThisPage
                    ? `⏳ 正在流式解析第 ${pageNum} / ${totalPages} 页（保留原图 + 原文排版）…`
                    : `📄 第 ${pageNum} / ${totalPages} 页（待滚动按需翻译）`
                }
              </div>
              <div class="paper-lazy-desc">
                ${
                  pageFailure ? escapeHtml(pageFailure) : isLoadingThisPage
                    ? '正在提取本页学术段落、裁剪原始插图并生成图中标签译文…'
                    : '为节省 Token 消耗，向下滚动至此页时将自动触发翻译，您也可点击下方按钮立即翻译本页。'
                }
              </div>
              <div style="display:flex;gap:8px;align-items:center;justify-content:center;">
                <button type="button" class="ghost-btn mini-btn page-jump-pill" data-page="${pageNum}">定位左页 (P${pageNum})</button>
                ${
                  isLoadingThisPage
                    ? ''
                    : `<button type="button" class="ghost-btn mini-btn" data-translate-page="${pageNum}">${pageFailure ? '↻ 重试' : '⚡ 立即翻译'}第 ${pageNum} 页</button>`
                }
              </div>
            </article>
          `;
        }

        const blocksHtml = pageBlocks
          .map((b) => {
            if (b.type === 'figure') {
              return renderFigure2DCanvasHtml(b);
            }
            if (b.type === 'code') {
              return `
                <div class="paper-block is-full-span" data-block-id="${b.id}">
                  <pre style="background:#0f172a;color:#38bdf8;padding:12px 14px;border-radius:6px;font-family:ui-monospace,monospace;font-size:12px;white-space:pre-wrap;">${escapeHtml(
                    b.original
                  )}</pre>
                </div>
              `;
            }

            const isAuthor = isAuthorOrAffiliationBlock(
              b.original || b.translation,
              b.type,
              pageNum
            );
            const effectiveType = isAuthor ? 'author' : b.type;

            const blockTypeClass = isAuthor
              ? 'paper-author-block is-full-span'
              : b.type === 'heading'
              ? 'paper-heading-block is-heading'
              : b.type === 'table'
              ? 'paper-table-block is-table'
              : b.type === 'equation'
              ? 'paper-equation-block is-full-span'
              : `paper-para-block ${b.column === 'full' ? 'is-full-span' : ''}`;

            const origHtml = renderRichAcademicHtml(b.original, {
              blockType: effectiveType,
              pageNum
            });
            const transHtml = renderBlockTranslation(b, effectiveType);

            // For standalone equations where original and translation are identical formulas, avoid showing two identical equations in bilingual mode
            const isIdenticalEquation =
              b.type === 'equation' &&
              (b.original || '').replace(/\s+/g, '') ===
                (b.translation || '').replace(/\s+/g, '');

            return `
              <div class="paper-block ${blockTypeClass}" data-block-id="${b.id}">
                <div class="paper-block-toolbar">
                  <button type="button" class="page-jump-pill" data-page="${pageNum}" title="左侧原 PDF 滚动定位至第 ${pageNum} 页">P${pageNum} 定位左页</button>
                  <button type="button" class="retranslate-mini-btn" data-retrans="${b.id}">↻ 重译</button>
                </div>
                ${
                  isIdenticalEquation
                    ? ''
                    : `<div class="stream-orig">${origHtml}</div>`
                }
                <div class="stream-trans" id="stream-trans-${b.id}">${transHtml}</div>
              </div>
            `;
          })
          .join('');

        const needsLazyPageTranslation =
          isPdfLazyMode &&
          (!currentDoc.translatedPages?.has(pageNum) ||
            currentDoc.forceRetranslatePages?.has(pageNum));
        return `
          <article class="paper-sheet-page" data-paper-page="${pageNum}" ${!forExport && needsLazyPageTranslation ? `data-lazy-page="${pageNum}"` : ''}>
            ${pageFailure ? `<div class="paper-page-failure" role="status">本页重译失败，以下保留上一版内容：${escapeHtml(pageFailure)}${forExport ? '' : ` <button type="button" data-translate-page="${pageNum}">↻ 重试本页</button>`}</div>` : ''}
            <header class="paper-sheet-header">
              <span>${escapeHtml(currentDoc.bookTitle || currentDoc.fileName || 'Academic Paper')}</span>
              <span>Page ${pageNum} / ${totalPages}</span>
            </header>
            <div class="paper-sheet-body ${isTwoColumn ? 'is-two-column' : ''}">
              ${blocksHtml}
            </div>
          </article>
        `;
      })
      .join('');
  } else {
    // Classic Dark Bilingual Stream Card View (Preserved)
    bilingualStreamContainer.innerHTML = visibleBlocks
      .map((b) => {
        if (b.type === 'code') {
          return `
            <div class="stream-block-card" data-block-id="${b.id}">
              <pre style="font-family:ui-monospace,monospace;font-size:12px;color:#38bdf8;white-space:pre-wrap;">${escapeHtml(
                b.original
              )}</pre>
            </div>
          `;
        }

        const badgeLabel =
          currentDoc.fileType === 'pdf'
            ? `Page ${b.page || 1} / ${currentDoc.totalPages || 1}`
            : currentDoc.fileType === 'srt'
            ? `${formatSrtTime(b.start)}`
            : `#${b.id + 1}`;

        const figureLabelsHtml =
          Array.isArray(b.figureLabels) && b.figureLabels.length > 0
            ? `
            <div class="stream-figure-labels-grid">
              ${b.figureLabels
                .map(
                  (l) => `
                  <span class="stream-figure-label-chip" title="${escapeHtml(l.original || '')}">
                    ${l.original ? `<small>${escapeHtml(l.original)} →</small>` : ''}${escapeHtml(
                    l.translation || ''
                  )}
                  </span>
                `
                )
                .join('')}
            </div>
          `
            : '';

        return `
          <div class="stream-block-card ${b.type === 'heading' ? 'is-heading' : b.type === 'table' ? 'is-table' : b.type === 'equation' ? 'is-equation' : ''}" data-block-id="${b.id}">
            <div class="stream-block-meta">
              <span class="page-jump-pill" data-page="${b.page || 1}" title="点击将左侧原文档平滑滚动至第 ${b.page || 1} 页">${badgeLabel}${
          b.type === 'figure' ? ' · 🖼️ 图表' : ''
        } · 定位左页</span>
              <button class="retranslate-mini-btn" data-retrans="${b.id}">↻ 重译此段</button>
            </div>
            ${
              b.imageDataUrl
                ? `<div style="margin:8px 0;"><img src="${b.imageDataUrl}" style="max-width:100%;border-radius:6px;" alt="Figure" /></div>`
                : ''
            }
            <div class="stream-orig">${renderRichAcademicHtml(b.original, {
              blockType: b.type,
              pageNum: b.page
            })}</div>
            <div class="stream-trans" id="stream-trans-${b.id}">${renderBlockTranslation(b)}</div>
            ${figureLabelsHtml}
          </div>
        `;
      })
      .join('');
  }

  // Export serializes the complete model, without installing reading-only controls/listeners.
  if (forExport) return;

  // Restore scroll position so lazy page insertions don't jump the reader
  if (prevScrollTop > 0) {
    bilingualStreamContainer.scrollTop = prevScrollTop;
  }

  // Bind "定位左页" / page pill: ONLY smoothly scroll the left original PDF viewer to pageNum (no reload, no translation)
  bilingualStreamContainer.querySelectorAll('.page-jump-pill').forEach((pill) => {
    pill.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pageNum = Number(pill.dataset.page) || 1;
      scrollLeftPdfToPage(pageNum);
    });
  });

  // Bind figure overlay toggle button (swap between seamless translated figure and original figure)
  bilingualStreamContainer.querySelectorAll('[data-toggle-fig-overlay]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const blockId = btn.dataset.toggleFigOverlay;
      const canvasEl = document.getElementById(`paper-fig-canvas-${blockId}`);
      if (canvasEl) {
        const hidden = canvasEl.classList.toggle('hide-fig-overlays');
        const imgEl = canvasEl.querySelector('.paper-fig-bg-img');
        if (imgEl && imgEl.dataset.originalSrc && imgEl.dataset.translatedSrc) {
          imgEl.src = hidden ? imgEl.dataset.originalSrc : imgEl.dataset.translatedSrc;
        }
        btn.textContent = hidden ? '👁️ 查看译图' : '👁️ 对比原图';
      }
    });
  });

  // Bind attach figure screenshot button
  bilingualStreamContainer.querySelectorAll('[data-attach-fig]').forEach((btn) => {
    btn.addEventListener('click', () => {
      pendingFigureAttachBlockId = Number(btn.dataset.attachFig);
      figureImageInput?.click();
    });
  });

  // Bind immediate single-page translate button inside lazy placeholder
  bilingualStreamContainer.querySelectorAll('[data-translate-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pageNum = Number(btn.dataset.translatePage) || 1;
      queueLazyPageTranslation(pageNum, true);
    });
  });

  // Bind single block re-translate. Re-rendering may replace buttons while a request is active.
  bilingualStreamContainer.querySelectorAll('.retranslate-mini-btn').forEach((btn) => {
    const block = currentDoc.blocks.find(item => item.id === Number(btn.dataset.retrans));
    btn.disabled = Boolean(block && blockRetranslations.has(block));
    btn.addEventListener('click', () => { if (block) void retranslateBlock(block); });
  });

  // Re-attach scroll-driven lazy page observer if enabled
  if (!forExport) setupLazyPageObserver();
}

async function retranslateBlock(block) {
  if (!isDocumentReady()) return;
  if (blockRetranslations.has(block) || !currentDoc.blocks.includes(block)) return;
  const doc = currentDoc, session = documentSession, signal = documentRequests.signal;
  const request = beginBlockTranslation(block);
  const task = {};
  blockRetranslations.set(block, task);
  const buttons = () => bilingualStreamContainer.querySelectorAll(`[data-retrans="${request.id}"]`);
  buttons().forEach(btn => { btn.disabled = true; });
  const transEl = document.getElementById(`stream-trans-${request.id}`);
  if (transEl) transEl.textContent = 'AI 正在重译…';
  const isCurrent = () => session === documentSession && !signal.aborted && ownsBlockTranslation(request, doc);
  try {
    const settings = await getDocumentTranslationSettings();
    if (!isCurrent()) throw new DOMException('重译已取消', 'AbortError');
    const response = await sendModelRequest({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: { items: [{ id: request.id, text: request.original }],
        targetLang: settings.targetLang, pageTitle: doc.bookTitle, bypassCache: true }
    });
    if (!isCurrent() || response?.cancelled) throw new DOMException('重译已取消', 'AbortError');
    if (!response?.ok) throw new Error(response?.error || '未收到有效译文');
    const translated = response.data?.translations?.find(item => Number(item.id) === request.id);
    if (!translated || typeof translated.translation !== 'string' || !translated.translation.trim()) {
      throw new Error('未收到对应段落的有效译文');
    }
    block.translation = translated.translation;
    docStatusSubtitle.textContent = '✓ 此段重译完成';
  } catch (error) {
    if (currentDoc === doc && doc.blocks.includes(block)) {
      docStatusSubtitle.textContent = error?.name === 'AbortError'
        ? '此段重译已取消，已保留原译文。'
        : `⚠️ 此段重译失败：${error?.message || error}。已保留原译文，可点击重试。`;
    }
  } finally {
    if (blockRetranslations.get(block) === task) blockRetranslations.delete(block);
    if (currentDoc === doc && doc.blocks.includes(block)) {
      const currentEl = document.getElementById(`stream-trans-${request.id}`);
      if (currentEl) currentEl.innerHTML = renderBlockTranslation(block);
      buttons().forEach(btn => { btn.disabled = false; });
    }
  }
}

// ============================================================================
// 2B. Figure / Diagram Screenshot Upload & Clipboard Paste OCR Translation
// ============================================================================

async function loadImageToCanvas(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth || img.width || 800;
      c.height = img.naturalHeight || img.height || 600;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

async function retranslateDocumentFigure(block, settings, isCurrent) {
  const doc = currentDoc, session = documentSession;
  const originalImage = block.originalImageDataUrl || '';
  const originalLabels = block.figureLabels;
  const check = () => {
    if (!isCurrent() || currentDoc !== doc || session !== documentSession || !doc.blocks.includes(block) ||
        (block.originalImageDataUrl || '') !== originalImage || block.figureLabels !== originalLabels) {
      throw new DOMException('图中文字重译已取消', 'AbortError');
    }
  };
  check();
  let labels = (originalLabels || []).filter(label => String(label.original || '').trim()).map(label => ({ ...label }));
  if (labels.length) {
    const entries = labels.map((label, id) => ({ id, text: label.original }));
    for (const items of createBatches(entries, item => item.text, settings.batchMaxItems || 10, settings.batchMaxChars || 2200)) {
      const res = await sendModelRequest({ type: MESSAGE_TYPES.TRANSLATE_BATCH,
        payload: { items, targetLang: settings.targetLang, pageTitle: doc.bookTitle, bypassCache: true } });
      check();
      if (!res?.ok) throw new Error(res?.error || '图中文字翻译失败');
      for (const item of items) {
        const translated = res.data?.translations?.find(result => Number(result.id) === item.id)?.translation;
        if (typeof translated !== 'string' || !translated.trim()) throw new Error('图中文字译文不完整，请重试');
        labels[item.id].translation = translated;
      }
    }
  } else if (originalImage) {
    const match = originalImage.match(/^data:(image\/[^;,]+);base64,(.+)$/);
    if (!match) throw new Error('原图数据不可用，请重新上传图片');
    const res = await sendModelRequest({ type: MESSAGE_TYPES.TRANSLATE_IMAGE,
      payload: { imageBase64: match[2], mimeType: match[1], targetLang: settings.targetLang, pageTitle: doc.bookTitle } });
    check();
    if (!res?.ok) throw new Error(res?.error || '图中文字识别失败');
    labels = normalizeFigureLabelsToCrop(res.data?.regions || [], [0, 0, 1000, 1000]);
  }
  let canvas, imageDataUrl = originalImage, isCanvasInpainted = false;
  try {
    if (originalImage && labels.length) {
      canvas = await loadImageToCanvas(originalImage);
      check();
      if (!canvas) throw new Error('原图无法解码，图中文字尚未完成重译');
      const rendered = renderSeamlessFigureTranslation(canvas, labels);
      if (!rendered.translatedDataUrl || rendered.labels.length !== labels.length) throw new Error('图中文字重绘不完整，请重试');
      imageDataUrl = rendered.translatedDataUrl;
      labels = rendered.labels;
      isCanvasInpainted = true;
    }
    check();
    block.figureLabels = labels;
    if (originalImage) block.imageDataUrl = imageDataUrl;
    block.isCanvasInpainted = isCanvasInpainted;
    block.figureTranslationPending = false;
    block.figureTranslationError = '';
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

async function handleFigureImageFile(file, attachToBlockId = null) {
  if (currentDoc.loadState === 'loading' || currentDoc.loadState === 'error') return;
  const session = documentSession;
  const attachTarget = attachToBlockId === null ? null : currentDoc.blocks.find(block => block.id === attachToBlockId);
  if (!file || !file.type.startsWith('image/')) return;
  emptyDropzoneSection.hidden = true;
  workspaceSplitMain.hidden = false;

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  if (session !== documentSession) return;
  const base64 = dataUrl.split(',')[1] || '';
  if (!base64) return;

  docStatusSubtitle.textContent = `🖼️ 正在识别图表文字并生成图片文字覆盖译文 (${file.name})…`;
  progressBarWrap.hidden = false;
  progressBarFill.style.width = '40%';

  try {
    const settings = await getDocumentTranslationSettings();
    if (session !== documentSession) return;
    const res = await sendModelRequest({
      type: MESSAGE_TYPES.TRANSLATE_IMAGE,
      payload: {
        imageBase64: base64,
        mimeType: file.type || 'image/png',
        targetLang: settings.targetLang,
        pageTitle: currentDoc.bookTitle || document.title
      }
    });

    if (session !== documentSession) return;
    if (!res || !res.ok) {
      throw new Error(res?.error || '图表文字识别失败');
    }

    const data = res.data || {};
    const rawLabels = (data.regions || []).map((r) => ({
      box_2d: r.box_2d || [100, 100, 220, 400],
      original: r.original || '',
      translation: r.translation || ''
    }));
    let figureLabels = normalizeFigureLabelsToCrop(rawLabels, [0, 0, 1000, 1000]);
    let finalImageDataUrl = dataUrl;
    let isCanvasInpainted = false;

    const imgCanvas = await loadImageToCanvas(dataUrl);
    if (session !== documentSession) return;
    if (imgCanvas && figureLabels.length > 0) {
      const inpainted = renderSeamlessFigureTranslation(imgCanvas, figureLabels);
      if (inpainted.translatedDataUrl) {
        finalImageDataUrl = inpainted.translatedDataUrl;
        figureLabels = inpainted.labels;
        isCanvasInpainted = true;
      }
    }

    if (attachToBlockId !== null && (!attachTarget || !currentDoc.blocks.includes(attachTarget))) {
      throw new Error('原图注已被替换，请重新选择附图位置');
    }
    const targetBlock = attachTarget;

    if (targetBlock) {
      targetBlock.imageDataUrl = finalImageDataUrl;
      targetBlock.originalImageDataUrl = dataUrl;
      targetBlock.isCanvasInpainted = isCanvasInpainted;
      targetBlock.figureTranslationPending = false;
      targetBlock.figureTranslationError = '';
      targetBlock.figureLabels = figureLabels;
      if (!targetBlock.translation && data.summaryTranslation) {
        targetBlock.translation = data.summaryTranslation;
      }
    } else {
      const currentPage = Number(jumpPageInput?.value) || 1;
      const newBlock = {
        id: allocateBlockId(),
        page: currentPage,
        type: 'figure',
        column: 'full',
        userAttached: true,
        original: `Figure (${file.name}): ${figureLabels.map((l) => l.original).filter(Boolean).join(' · ') || 'Uploaded Diagram'}`,
        translation:
          data.summaryTranslation ||
          `图（${file.name}）：已处理 ${figureLabels.length} 处图中文字。`,
        figureLabels,
        imageDataUrl: finalImageDataUrl,
        originalImageDataUrl: dataUrl,
        isCanvasInpainted
      };
      currentDoc.blocks.unshift(newBlock);
    }

    setDocumentLoadState('ready');
    renderWorkspaceBlocks(streamSearchInput.value.trim());
    progressBarFill.style.width = '100%';
    docStatusSubtitle.textContent = figureLabels.length
      ? `✓ 图中文字覆盖翻译完成（已处理 ${figureLabels.length} 处标签；效果依赖识别与背景）`
      : '未发现需要翻译的图中文字（可能无可识别文字或已是目标语言），已保留原图。';
  } catch (err) {
    if (session !== documentSession) return;
    docStatusSubtitle.textContent = `⚠️ 图表翻译失败: ${err?.message || err}`;
  } finally {
    if (session !== documentSession) return;
    pendingFigureAttachBlockId = null;
    setTimeout(() => {
      if (session === documentSession) progressBarWrap.hidden = true;
    }, 1000);
  }
}

if (figureImageInput) {
  figureImageInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFigureImageFile(file, pendingFigureAttachBlockId);
      figureImageInput.value = '';
    }
  });
}

window.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        e.preventDefault();
        handleFigureImageFile(file, pendingFigureAttachBlockId);
        break;
      }
    }
  }
});

// ============================================================================
// 3. Scroll-Driven On-Demand Lazy PDF Page Translation + Authentic Figure Crop
// ============================================================================

function setupLazyPageObserver() {
  const session = documentSession;
  if (lazyPageObserver) {
    lazyPageObserver.disconnect();
    lazyPageObserver = null;
  }

  if (
    !currentDoc.lazyScrollEnabled ||
    !currentDoc.lazyScrollTriggered ||
    currentDoc.fileType !== 'pdf' ||
    (pdfModeSelect && pdfModeSelect.value !== 'gemini-multimodal') ||
    typeof IntersectionObserver === 'undefined'
  ) {
    return;
  }

  lazyPageObserver = new IntersectionObserver(
    (entries) => {
      if (session !== documentSession || stopRequested || !currentDoc.lazyScrollEnabled || !currentDoc.lazyScrollTriggered || isProgrammaticRightScroll) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const pageNum = Number(entry.target.getAttribute('data-lazy-page'));
        if (
          pageNum >= 1 &&
          !currentDoc.failedPages?.has(pageNum) &&
          !currentDoc.translatedPages.has(pageNum) &&
          !currentDoc.translatingPages.has(pageNum)
        ) {
          queueLazyPageTranslation(pageNum, false);
        }
      }
    },
    {
      root: bilingualStreamContainer,
      rootMargin: '260px 0px',
      threshold: 0.05
    }
  );

  bilingualStreamContainer
    .querySelectorAll('.paper-page-lazy-placeholder[data-lazy-page], .paper-sheet-page[data-lazy-page]')
    .forEach((el) => lazyPageObserver.observe(el));
}

for (const eventName of ['scroll', 'wheel', 'touchmove']) {
  bilingualStreamContainer?.addEventListener(eventName, () => {
    if (!currentDoc.lazyScrollEnabled || isProgrammaticRightScroll || stopRequested) return;
    if (!currentDoc.lazyScrollTriggered) {
      currentDoc.lazyScrollTriggered = true;
      setupLazyPageObserver();
    }
  }, { passive: true });
}

function queueLazyPageTranslation(pageNum, prioritize = false) {
  if (!isDocumentReady()) return;
  if (stopRequested && !prioritize) return;
  if (prioritize) stopRequested = false;
  if (!prioritize && currentDoc.failedPages?.has(pageNum)) return;
  if (
    pageNum < 1 ||
    pageNum > (currentDoc.totalPages || 1) ||
    currentDoc.translatedPages.has(pageNum) ||
    currentDoc.translatingPages.has(pageNum)
  ) {
    return;
  }

  if (prioritize) currentDoc.failedPages?.delete(pageNum);

  const existingIdx = lazyPageQueue.indexOf(pageNum);
  if (existingIdx !== -1) {
    if (prioritize && existingIdx > 0) {
      lazyPageQueue.splice(existingIdx, 1);
      lazyPageQueue.unshift(pageNum);
    }
  } else if (prioritize) {
    lazyPageQueue.unshift(pageNum);
  } else {
    lazyPageQueue.push(pageNum);
  }

  processLazyPageQueue();
}

async function processLazyPageQueue() {
  if (isProcessingLazyQueue) return;
  isProcessingLazyQueue = true;
  const session = documentSession;
  if (typeof startTranslateDocBtn !== 'undefined' && startTranslateDocBtn) {
    startTranslateDocBtn.textContent = '⏹ 暂停翻译';
  }

  try {
    while (session === documentSession && lazyPageQueue.length > 0 && !stopRequested) {
      const nextPage = lazyPageQueue.shift();
      if (
        !nextPage ||
        currentDoc.failedPages?.has(nextPage) ||
        currentDoc.translatedPages.has(nextPage) ||
        currentDoc.translatingPages.has(nextPage)
      ) {
        continue;
      }
      await translateSinglePdfPage(nextPage);
      if (session === documentSession && currentDoc.failedPages?.has(nextPage)) {
        lazyPageQueue.length = 0;
        break;
      }
    }
  } finally {
    if (session === documentSession) {
      isProcessingLazyQueue = false;
      updateDocumentActions();
    }
  }
}

/**
 * Translates a single PDF page on demand:
 * 1. Renders that page to an HTML <canvas> via PDF.js and extracts exact vector text coordinates.
 * 2. Sends only that single page image to Gemini (saving ~95% tokens vs sending the whole 41-page PDF).
 * 3. Crops each Figure's authentic original canvas, extracts its vector text items (or fallback vision boxes),
 *    seamlessly inpaints the local background color, and redraws native Chinese text in-place.
 */
async function translateSinglePdfPage(pageNum, { bypassCache = false, retryFailed = false } = {}) {
  if (!isDocumentReady()) return;
  if (currentDoc.failedPages?.has(pageNum) && !retryFailed) return;
  const forceRetranslate = bypassCache || Boolean(currentDoc.forceRetranslatePages?.has(pageNum));
  if (currentDoc.translatingPages.has(pageNum)) {
    return currentDoc.inFlightPagePromises?.get(pageNum);
  }
  if (currentDoc.translatedPages.has(pageNum) && !forceRetranslate) {
    return;
  }

  if (retryFailed) currentDoc.failedPages?.delete(pageNum);

  const session = documentSession;
  if (forceRetranslate) {
    currentDoc.translatedPages.delete(pageNum);
    currentDoc.forceRetranslatePages ??= new Set();
    currentDoc.forceRetranslatePages.add(pageNum);
  }
  const isCurrent = () => session === documentSession && !stopRequested;
  currentDoc.translatingPages.add(pageNum);
  const totalPages = Math.max(1, currentDoc.totalPages || 1);

  const placeholderEl = bilingualStreamContainer.querySelector(
    `.paper-page-lazy-placeholder[data-lazy-page="${pageNum}"]`
  );
  if (placeholderEl) {
    placeholderEl.classList.add('is-loading-page');
    const titleEl = placeholderEl.querySelector?.('.paper-lazy-title');
    if (titleEl) {
      titleEl.textContent = `⏳ 正在按需翻译第 ${pageNum} / ${totalPages} 页（图片文字覆盖 + 原文排版）…`;
    }
    const descEl = placeholderEl.querySelector?.('.paper-lazy-desc');
    if (descEl) {
      descEl.textContent = '正在提取本页学术段落、裁剪原始插图并生成图中标签译文…';
    }
    const actionBtn = placeholderEl.querySelector?.('[data-translate-page]');
    if (actionBtn) {
      actionBtn.hidden = true;
      if (actionBtn.style) actionBtn.style.display = 'none';
    }
  }

  docStatusSubtitle.textContent = `正在翻译第 ${pageNum} / ${totalPages} 页（图片文字覆盖 + 论文排版）…`;
  progressBarWrap.hidden = false;
  const doneBefore = currentDoc.translatedPages.size;
  progressBarFill.style.width = `${Math.min(95, Math.max(12, Math.round(((doneBefore + 0.5) / totalPages) * 100)))}%`;

  const pageTask = (async () => {
    try {
      const settings = await getDocumentTranslationSettings();
      if (!isCurrent()) return;
      let pageRender = null;
      if (currentDoc.pdfDoc) {
        pageRender = await getOrRenderPdfPage(pageNum);
        if (!isCurrent()) return;
        ensureLeftPdfPageRendered(pageNum);
      }

      const isGeminiProtocol = getActiveProtocol(settings) === 'gemini';
      const localCandidateBlocks =
        pageRender && Array.isArray(pageRender.textItems) && pageRender.textItems.length > 0
          ? extractStructuredPdfPageBlocks(pageRender, pageNum)
          : [];
      const hasRichVectorText =
        Array.isArray(pageRender?.textItems) &&
        pageRender.textItems.length >= 12 &&
        localCandidateBlocks.reduce((sum, b) => sum + (b.original?.length || 0), 0) >= 300;
      const usesGeminiVision = isGeminiProtocol && !hasRichVectorText;
      let rawBlocks = [];

      if (usesGeminiVision) {
        const payload = {
          bypassCache: forceRetranslate,
          targetLang: settings.targetLang,
          pageNumber: pageNum,
          pageHint: `Page ${pageNum} only`
        };

        if (!pageRender?.jpegBase64 && currentDoc.pdfDoc) {
          pageRender = await getOrRenderPdfPage(pageNum);
          if (!isCurrent()) return;
        }

        if (pageRender && pageRender.jpegBase64) {
          payload.pageImageBase64 = pageRender.jpegBase64;
          payload.mimeType = 'image/jpeg';
          payload.pageMimeType = 'image/jpeg';
        } else if (
          !currentDoc.pdfDoc &&
          (currentDoc.totalPages || 1) <= 1 &&
          currentDoc.pdfArrayBuffer &&
          currentDoc.pdfArrayBuffer.byteLength <= 15 * 1024 * 1024
        ) {
          payload.pdfBase64 = arrayBufferToBase64(currentDoc.pdfArrayBuffer);
        } else {
          throw new Error(`无法渲染第 ${pageNum} 页图像以供视觉识别，请重试`);
        }

        const res = await sendModelRequest({
          type: MESSAGE_TYPES.ANALYZE_PDF_MULTIMODAL,
          payload
        });

        if (!isCurrent()) return;
        if (!res || !res.ok) {
          throw new Error(res?.error || `第 ${pageNum} 页解析失败`);
        }

        rawBlocks = res.data?.blocks || [];
      } else {
        // Non-Gemini / OpenAI-compatible text models (e.g., DeepSeek) OR born-digital PDFs with rich vector text:
        // Reconstruct 2-column academic layout, headings, authors, equations, and figure bounding boxes locally via PDF.js 2D coordinates
        rawBlocks = localCandidateBlocks;
        // Only text extracted from this PDF.js page belongs to this page. The
        // whole-document stream fallback uses estimated page numbers and cannot
        // safely fill a textless page in the layout-preserving pipeline.

        const translatableEntries = rawBlocks
          .map((b, idx) => ({ b, idx }))
          .filter(
            ({ b }) =>
              b.type !== 'equation' &&
              b.type !== 'code' &&
              typeof b.original === 'string' &&
              b.original.trim().length > 0
          );

        const pageBatches = createBatches(
          translatableEntries,
          (entry) => entry.b.original,
          Math.min(settings.batchMaxItems || 10, 3),
          Math.min(settings.batchMaxChars || 2400, 900)
        );

        await Promise.all(
          pageBatches.map(async (batch) => {
            if (!isCurrent()) return;
            const batchRes = await sendModelRequest({
              type: MESSAGE_TYPES.TRANSLATE_BATCH,
              payload: {
                bypassCache: forceRetranslate,
                items: batch.map((entry) => ({ id: entry.idx, text: entry.b.original })),
                targetLang: settings.targetLang,
                pageTitle: currentDoc.bookTitle || currentDoc.fileName
              }
            });

            if (!isCurrent()) return;
            if (!batchRes || !batchRes.ok) {
              throw new Error(batchRes?.error || `第 ${pageNum} 页文本翻译失败`);
            }

            const returnedList = batchRes.data?.translations || [];
            for (let i = 0; i < batch.length; i++) {
              const entry = batch[i];
              const matched =
                returnedList.find((tr) => Number(tr.id) === entry.idx) || returnedList[i];
              if (matched && matched.translation) {
                entry.b.translation = matched.translation;
              }
            }
          })
        );
      }

      if (!isCurrent()) return;
      if (rawBlocks.length === 0) throw new Error('此页未提取到可翻译内容；扫描件请使用支持视觉的模型。');
      const newBlocks = [];

      for (let idx = 0; idx < rawBlocks.length; idx++) {
        const b = rawBlocks[idx];
        const isFig = b.type === 'figure';
        const figureBox2d = isFig ? b.figureBox2d || null : null;
        let imageDataUrl = '';
        let originalImageDataUrl = '';
        let isCanvasInpainted = false;
        let cleanFigureLabels = isFig
          ? normalizeFigureLabelsToCrop(b.figureLabels || [], figureBox2d)
          : [];

        if (isFig && pageRender?.canvas && figureBox2d) {
          const cropObj = cropFigureCanvasObject(pageRender.canvas, figureBox2d);
          if (cropObj && cropObj.cropCanvas) {
            originalImageDataUrl = cropObj.originalDataUrl;
            // 1. Extract exact PDF vector text coordinates inside the figure from PDF.js
            const vectorGroups = extractFigureVectorTextGroups(
              pageRender.textItems || [],
              pageRender.width,
              pageRender.height,
              figureBox2d
            );

            const minVectorGroups = usesGeminiVision ? 2 : 1;
            if (vectorGroups.length >= minVectorGroups) {
              const batchRes = await sendModelRequest({
                type: MESSAGE_TYPES.TRANSLATE_BATCH,
                payload: {
                  bypassCache: forceRetranslate,
                  items: vectorGroups.map((g, gIdx) => ({ id: gIdx, text: g.original })),
                  targetLang: settings.targetLang,
                  pageTitle: currentDoc.bookTitle || currentDoc.fileName
                }
              });
              if (!isCurrent()) return;
              if (!batchRes?.ok) throw new Error(batchRes?.error || '图中文字翻译失败');
              if (Array.isArray(batchRes.data?.translations)) {
                for (const tr of batchRes.data.translations) {
                  if (vectorGroups[tr.id] && tr.translation) {
                    vectorGroups[tr.id].translation = tr.translation;
                  }
                }
              }
              const inpainted = renderSeamlessFigureTranslation(
                cropObj.cropCanvas,
                vectorGroups
              );
              imageDataUrl = inpainted.translatedDataUrl || cropObj.originalDataUrl;
              originalImageDataUrl = inpainted.originalDataUrl || cropObj.originalDataUrl;
              cleanFigureLabels = inpainted.labels;
              isCanvasInpainted = true;
            } else if (cleanFigureLabels.length > 0) {
              const inpainted = renderSeamlessFigureTranslation(
                cropObj.cropCanvas,
                cleanFigureLabels
              );
              imageDataUrl = inpainted.translatedDataUrl || cropObj.originalDataUrl;
              originalImageDataUrl = inpainted.originalDataUrl || cropObj.originalDataUrl;
              cleanFigureLabels = inpainted.labels;
              isCanvasInpainted = true;
            } else {
              imageDataUrl = cropObj.originalDataUrl;
            }
          }
        }

        newBlocks.push({
          id: allocateBlockId(),
          page: pageNum,
          type: b.type || 'paragraph',
          column: b.column || 'full',
          original: b.original || '',
          translation: b.translation || '',
          figureBox2d,
          figureLabels: cleanFigureLabels,
          imageDataUrl,
          originalImageDataUrl,
          isCanvasInpainted
        });
      }

      // Replace any existing blocks on this page (preserving user-attached figures) and sort by page number
      const filtered = currentDoc.blocks.filter(
        (b) => Number(b.page) !== pageNum || Boolean(b.userAttached)
      );
      currentDoc.blocks = [...filtered, ...newBlocks]
        .sort((a, b) => (a.page || 1) - (b.page || 1));

      if (!isCurrent()) return;
      currentDoc.translatedPages.add(pageNum);
      currentDoc.failedPages?.delete(pageNum);
      currentDoc.forceRetranslatePages?.delete(pageNum);
      currentDoc.translatingPages.delete(pageNum);

      renderWorkspaceBlocks(streamSearchInput.value.trim());

      const doneCount = currentDoc.translatedPages.size;
      progressBarFill.style.width = `${Math.min(100, Math.round((doneCount / totalPages) * 100))}%`;
      docStatusSubtitle.textContent =
        doneCount < totalPages
          ? `✓ 已完成 ${doneCount} / ${totalPages} 页 · 向下滚动将自动续译后续页面（省 Token）`
          : `✓ 全部 ${totalPages} 页翻译完成`;
    } catch (err) {
      if (session !== documentSession) return;
      currentDoc.failedPages ??= new Map();
      currentDoc.failedPages.set(pageNum, String(err?.message || err));
      currentDoc.translatingPages.delete(pageNum);
      docStatusSubtitle.textContent = `⚠️ 第 ${pageNum} 页翻译失败: ${err?.message || err}`;
      renderWorkspaceBlocks(streamSearchInput.value.trim());
    } finally {
      currentDoc.inFlightPagePromises?.delete(pageNum);
      if (session !== documentSession) return;
      currentDoc.translatingPages.delete(pageNum);
      if (!currentDoc.leftPreviewWanted?.has(pageNum)) evictPdfPageRender(currentDoc, pageNum);
      trimPdfPageRenderCache(currentDoc);
      updateDocumentActions();
      if (currentDoc.translatingPages.size === 0 && lazyPageQueue.length === 0) {
        setTimeout(() => {
          if (session === documentSession) progressBarWrap.hidden = true;
        }, 900);
      }
    }
  })();

  currentDoc.inFlightPagePromises ??= new Map();
  currentDoc.inFlightPagePromises.set(pageNum, pageTask);
  return pageTask;
}

startTranslateDocBtn.addEventListener('click', () => {
  if (!isDocumentReady()) return;
  if (isTranslating || isProcessingLazyQueue) {
    documentRequests.cancel();
    documentSession++;
    currentDoc.translatingPages.clear();
    currentDoc.inFlightPagePromises?.clear();
    isTranslating = false;
    isProcessingLazyQueue = false;
    stopRequested = true;
    lazyPageQueue.length = 0;
    currentDoc.lazyScrollEnabled = false;
    currentDoc.lazyScrollTriggered = false;
    lazyPageObserver?.disconnect();
    if (progressBarWrap) progressBarWrap.hidden = true;
    if (typeof renderWorkspaceBlocks === 'function' && currentDoc.loadState === 'ready') {
      renderWorkspaceBlocks(streamSearchInput?.value?.trim?.() || '');
    }
    updateDocumentActions();
    startTranslateDocBtn.textContent = '✦ 继续翻译';
    docStatusSubtitle.textContent = '⏸ 已暂停自动流式翻译（保留已出译文）';
    return;
  }
  startDocumentTranslation();
});

function navigateToPdfPage(pageNum) {
  const clamped = Math.max(1, Math.min(currentDoc.totalPages || 999, Number(pageNum) || 1));
  scrollLeftPdfToPage(clamped);
  suppressLazyObserverBriefly(800);
  const sheet = bilingualStreamContainer.querySelector(`[data-paper-page="${clamped}"]`);
  if (sheet) {
    sheet.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    const pill = bilingualStreamContainer.querySelector(`.page-jump-pill[data-page="${clamped}"]`);
    pill?.closest('.stream-block-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

if (jumpPageInput) {
  jumpPageInput.addEventListener('change', () => {
    scrollLeftPdfToPage(Number(jumpPageInput.value) || 1);
  });
  jumpPageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigateToPdfPage(Number(jumpPageInput.value) || 1);
    }
  });
}

if (prevPageStepBtn) {
  prevPageStepBtn.addEventListener('click', () => {
    navigateToPdfPage((Number(jumpPageInput?.value) || 1) - 1);
  });
}

if (nextPageStepBtn) {
  nextPageStepBtn.addEventListener('click', () => {
    navigateToPdfPage((Number(jumpPageInput?.value) || 1) + 1);
  });
}

if (translateSinglePageBtn && jumpPageInput) {
  translateSinglePageBtn.addEventListener('click', () => {
    if (!isDocumentReady()) return;
    const pageNum = Math.max(
      1,
      Math.min(currentDoc.totalPages || 999, Number(jumpPageInput.value) || 1)
    );
    navigateToPdfPage(pageNum);
    startDocumentTranslation({ start: pageNum, end: pageNum });
  });
}

async function startDocumentTranslation(targetPageRange = null) {
  if (!isDocumentReady() || isTranslating) return;
  isTranslating = true;
  const session = documentSession;
  const isCurrent = () => session === documentSession && !stopRequested;
  stopRequested = false;
  startTranslateDocBtn.disabled = false;
  startTranslateDocBtn.textContent = '⏹ 暂停翻译';
  progressBarWrap.hidden = false;
  progressBarFill.style.width = '10%';

  try {
    const settings = await getDocumentTranslationSettings();
    if (!isCurrent()) return;
    currentDoc.targetLang = settings.targetLang;
    const usesLazyPdfPipeline =
      currentDoc.fileType === 'pdf' &&
      (!pdfModeSelect || pdfModeSelect.value === 'gemini-multimodal') &&
      currentDoc.pdfArrayBuffer;

    if (
      currentDoc.fileType === 'pdf' &&
      !usesLazyPdfPipeline &&
      currentDoc.blocks.length === 0 &&
      currentDoc.pdfArrayBuffer
    ) {
      docStatusSubtitle.textContent = '正在提取 PDF 文本流并按需翻译首屏段落…';
      const localBlocks = await extractPdfBlocksLocally(currentDoc.pdfArrayBuffer);
      if (!isCurrent()) return;
      adoptParsedBlocks(localBlocks);
      renderWorkspaceBlocks();
    }

    // PDF Lazy Page Pipeline (Gemini Multimodal OR PDF.js 2D Coordinate Layout for DeepSeek/OpenAI):
    // Translate ONLY first 2 pages initially, then lazy-translate on scroll!
    if (usesLazyPdfPipeline) {
      const totalPages = Math.max(1, currentDoc.totalPages || 1);
      // This click permits retrying failures that already existed, not a new
      // failure from an observer task racing the eager first-page loop.
      const failedAtStart = new Set(currentDoc.failedPages?.keys() || []);

      if (targetPageRange) {
        for (let p = targetPageRange.start; p <= targetPageRange.end; p++) {
          currentDoc.translatedPages.delete(p);
          if (!isCurrent()) return;
          await translateSinglePdfPage(p, { bypassCache: true, retryFailed: true });
          if (!isCurrent()) return;
        }
        navigateToPdfPage(targetPageRange.start);
      } else {
        currentDoc.lazyScrollEnabled = false;
        currentDoc.lazyScrollTriggered = false;
        if (typeof lazyPageQueue !== 'undefined') lazyPageQueue.length = 0;
        if (typeof lazyPageObserver !== 'undefined') lazyPageObserver?.disconnect();

        // If all pages were already translated (user clicked '✦ 重新翻译'), reset translatedPages to re-translate from page 1
        if (currentDoc.translatedPages.size >= totalPages) {
          currentDoc.forceRetranslatePages = new Set(Array.from({ length: totalPages }, (_, index) => index + 1));
          currentDoc.translatedPages.clear();
        }
        renderWorkspaceBlocks(streamSearchInput.value.trim());

        // Find the first N untranslated pages (default: first 2 pages) so we don't burn tokens on all 41 pages upfront
        const initialPages = [];
        for (let p = 1; p <= totalPages && initialPages.length < INITIAL_EAGER_PDF_PAGES; p++) {
          if (!currentDoc.translatedPages.has(p)) {
            initialPages.push(p);
          }
        }

        for (const p of initialPages) {
          if (!isCurrent()) return;
          await translateSinglePdfPage(p, { retryFailed: failedAtStart.has(p) });
          if (!isCurrent()) return;
        }

        if (initialPages.some(p => currentDoc.translatedPages.has(p))) {
          currentDoc.lazyScrollEnabled = true;
          if (typeof bilingualStreamContainer !== 'undefined' && bilingualStreamContainer?.scrollTop > 0) {
            currentDoc.lazyScrollTriggered = true;
          }
          if (typeof setupLazyPageObserver === 'function') setupLazyPageObserver();
        }
      }
      return;
    }

    // Standard Batch Pipeline for Markdown, EPUB, HTML, SRT, or Local-Stream PDF
    const selectedChapter =
      currentDoc.fileType === 'epub' && epubChapterSelect.value !== 'all'
        ? Number(epubChapterSelect.value)
        : null;

    const scopeBlocks = currentDoc.blocks.filter(
      (b) =>
        b.type !== 'code' &&
        (selectedChapter === null || b.chapterIndex === selectedChapter)
    );
    const untranslatedBlocks = scopeBlocks.filter((b) => !b.translation || b.figureTranslationPending);
    const isFullRetranslate = untranslatedBlocks.length === 0 && scopeBlocks.length > 0;
    const todoBlocks = isFullRetranslate ? scopeBlocks : untranslatedBlocks;
    if (isFullRetranslate) {
      for (const block of scopeBlocks) {
        if (block.type === 'figure' && (block.originalImageDataUrl || block.figureLabels?.length)) {
          block.figureTranslationPending = true;
          block.figureTranslationError = '';
        }
      }
    }

    const batches = createBatches(
      todoBlocks.filter(block => isFullRetranslate || !block.translation),
      (b) => b.original,
      settings.batchMaxItems || 10,
      settings.batchMaxChars || 2200
    );

    let completed = 0;
    for (const batch of batches) {
      if (!isCurrent()) return;
      const requestDoc = currentDoc;
      const requests = batch.filter(block => requestDoc.blocks.includes(block)).map(beginBlockTranslation);
      if (!requests.length) continue;
      const res = await sendModelRequest({
        type: MESSAGE_TYPES.TRANSLATE_BATCH,
        payload: {
          items: requests.map(request => ({ id: request.id, text: request.original })),
          targetLang: settings.targetLang,
          pageTitle: currentDoc.bookTitle,
          bypassCache: isFullRetranslate
        }
      });

      if (!isCurrent()) return;
      if (!res || !res.ok) {
        throw new Error(res?.error || '批量翻译中断');
      }

      for (const item of res.data?.translations || []) {
        const request = requests.find(entry => entry.id === Number(item.id));
        if (request && ownsBlockTranslation(request, requestDoc)) {
          const target = request.block;
          target.translation = item.translation;
          const domEl = document.getElementById(`stream-trans-${target.id}`);
          if (domEl) {
            domEl.innerHTML = renderRichAcademicHtml(item.translation, {
              blockType: target.type,
              pageNum: target.page
            });
          }
        }
      }

      completed += batch.length;
      const pct = Math.min(100, Math.round((completed / Math.max(1, todoBlocks.length)) * 100));
      progressBarFill.style.width = `${pct}%`;
      updateProgressCounterBadge();
    }

    for (const block of scopeBlocks.filter(item => item.figureTranslationPending)) {
      if (!isCurrent()) return;
      docStatusSubtitle.textContent = '正在按文档配置重译图中文字…';
      try {
        await retranslateDocumentFigure(block, settings, isCurrent);
      } catch (error) {
        if (isCurrent()) {
          block.figureTranslationError = error?.message || '图中文字翻译失败';
          renderWorkspaceBlocks(streamSearchInput.value.trim());
        }
        throw error;
      }
      if (!isCurrent()) return;
      renderWorkspaceBlocks(streamSearchInput.value.trim());
    }
    docStatusSubtitle.textContent = `✓ 文档双语翻译已完成 (${currentDoc.fileName})`;
  } catch (err) {
    if (session !== documentSession) return;
    docStatusSubtitle.textContent = `⚠️ 翻译出错: ${err?.message || err}`;
  } finally {
    if (session !== documentSession) return;
    isTranslating = false;
    stopRequested = false;
    updateDocumentActions();
    setTimeout(() => {
      if (session === documentSession) progressBarWrap.hidden = true;
    }, 1200);
  }
}

// ============================================================================
// 4. Layout-Preserving PDF Export Modal (Token Warning + Batch Completion) & Exports
// ============================================================================

function syncExportDropdownItemsByFileType() {
  if (!exportDropdownMenu) return;
  const isSubtitleDoc = currentDoc.fileType === 'srt';
  exportDropdownMenu.querySelectorAll('[data-sub-export]').forEach((el) => {
    el.hidden = !isSubtitleDoc;
  });
  exportDropdownMenu.querySelectorAll('[data-doc-export]').forEach((el) => {
    el.hidden = isSubtitleDoc;
  });
}

exportMenuBtn.addEventListener('click', (e) => {
  if (!isDocumentReady()) return;
  e.stopPropagation();
  syncExportDropdownItemsByFileType();
  exportDropdownMenu.hidden = !exportDropdownMenu.hidden;
});

document.addEventListener('click', () => {
  exportDropdownMenu.hidden = true;
});

exportDropdownMenu.querySelectorAll('button[data-export]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const fmt = btn.dataset.export;
    exportDropdownMenu.hidden = true;
    exportTranslatedDocument(fmt);
  });
});

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function getTranslatedPagesSet() {
  const set = new Set();
  if (currentDoc.translatedPages instanceof Set) {
    for (const p of currentDoc.translatedPages) {
      set.add(Number(p));
    }
  }
  // Retained blocks are readable after a failed retranslation, but do not make
  // that page complete. The lazy PDF pipeline owns completion explicitly.
  if (currentDoc.fileType === 'pdf' && (!pdfModeSelect || pdfModeSelect.value === 'gemini-multimodal')) return set;
  for (const b of currentDoc.blocks || []) {
    if (b.translation && Number(b.page) >= 1) {
      set.add(Number(b.page));
    }
  }
  return set;
}

function formatPageListSummary(pages) {
  if (!pages || pages.length === 0) return '无';
  if (pages.length <= 6) return `第 ${pages.join(', ')} 页`;
  return `第 ${pages.slice(0, 4).join(', ')} … ${pages[pages.length - 1]} 页`;
}

function formatDurationEstimate(minSec, maxSec) {
  if (maxSec < 60) {
    return `${minSec} ~ ${maxSec} 秒`;
  }
  const minM = Math.max(1, Math.round(minSec / 60));
  const maxM = Math.max(minM, Math.round(maxSec / 60));
  return minM === maxM ? `约 ${minM} 分钟` : `约 ${minM} ~ ${maxM} 分钟`;
}

function getSelectedPdfExportViewMode() {
  const checked = document.querySelector('input[name="pdfExportViewMode"]:checked');
  return checked ? checked.value : 'translation-only';
}

function getSelectedPdfExportScope() {
  const checked = document.querySelector('input[name="pdfExportScope"]:checked');
  return checked ? checked.value : 'all';
}

function computeTargetAndPendingPages() {
  const totalPages = Math.max(1, currentDoc.totalPages || 1);
  const translatedSet = getTranslatedPagesSet();
  const scope = getSelectedPdfExportScope();

  let targetPages = [];
  if (scope === 'translated-only') {
    targetPages = Array.from(translatedSet).sort((a, b) => a - b);
    if (targetPages.length === 0) {
      targetPages = [1];
    }
  } else if (scope === 'range') {
    const rawStart = Math.max(1, Math.min(totalPages, Number(exportRangeStartInput?.value) || 1));
    const rawEnd = Math.max(rawStart, Math.min(totalPages, Number(exportRangeEndInput?.value) || totalPages));
    for (let p = rawStart; p <= rawEnd; p++) {
      targetPages.push(p);
    }
  } else {
    for (let p = 1; p <= totalPages; p++) {
      targetPages.push(p);
    }
  }

  const pendingPages =
    currentDoc.fileType === 'pdf'
      ? targetPages.filter((p) => !translatedSet.has(p))
      : [];

  return {
    totalPages,
    translatedSet,
    targetPages,
    pendingPages
  };
}

function refreshPdfExportModalEstimate() {
  if (!pdfExportConfirmModal || pdfExportConfirmModal.hidden) return;
  const { totalPages, translatedSet, targetPages, pendingPages } = computeTargetAndPendingPages();
  const viewMode = getSelectedPdfExportViewMode();
  const modeLabel = viewMode === 'translation-only' ? '纯译文保持排版 PDF' : '中英双语保持排版 PDF';

  if (modalTotalPagesText) modalTotalPagesText.textContent = `${totalPages} 页`;
  if (modalDonePagesText) modalDonePagesText.textContent = `${translatedSet.size} 页`;
  if (modalRemainingPagesText) {
    modalRemainingPagesText.textContent = `${Math.max(0, totalPages - translatedSet.size)} 页`;
  }

  if (scopeAllDescText) {
    const allRemaining = Math.max(0, totalPages - translatedSet.size);
    scopeAllDescText.textContent =
      allRemaining > 0
        ? `自动按序补全剩余 ${allRemaining} 页的翻译，全部完成后导出共 ${totalPages} 页的完整保持排版 PDF`
        : `全部 ${totalPages} 页均已翻译完成，可直接导出完整保持排版 PDF`;
  }

  if (scopeTranslatedOnlyDescText) {
    const doneArr = Array.from(translatedSet).sort((a, b) => a - b);
    scopeTranslatedOnlyDescText.textContent =
      doneArr.length > 0
        ? `仅导出目前已翻译完成的 ${doneArr.length} 页（${formatPageListSummary(doneArr)}），不消耗新 Token`
        : `当前尚未翻译任何页面，将自动翻译第 1 页后导出`;
  }

  if (pendingPages.length > 0) {
    const minTokensK = (pendingPages.length * 2.6).toFixed(1);
    const maxTokensK = (pendingPages.length * 3.6).toFixed(1);
    const estDuration = formatDurationEstimate(pendingPages.length * 5, pendingPages.length * 8);
    const largeDocNotice =
      totalPages >= 10
        ? '<br/>💡 <b>大篇幅论文省 Token 建议</b>：若文档末尾包含大量 References（参考文献）或 Appendix（附录），可切换上方 <b>「🎯 自定义页码范围」</b> 仅翻译并导出正文核心页。'
        : '';

    pdfExportTokenWarningBox?.classList.remove('is-ready');
    if (pdfTokenWarnTitle) {
      pdfTokenWarnTitle.textContent = `⚠️ 懒加载补全翻译与 Token 消耗确认（尚有 ${pendingPages.length} 页未翻译）`;
    }
    if (pdfTokenWarnBody) {
      pdfTokenWarnBody.innerHTML = `
        • <b>待补译页码</b>：共 <b>${pendingPages.length} 页</b>（${formatPageListSummary(pendingPages)}）<br/>
        • <b>预计消耗 Token</b>：约 <b>${minTokensK}k ~ ${maxTokensK}k Tokens</b>（含多模态版面分析 + 图中文字覆盖）<br/>
        • <b>预计等待时间</b>：${estDuration}（翻译完成后将自动为您弹出「${modeLabel}」导出窗口）${largeDocNotice}
      `;
    }
    if (confirmPdfExportBtn && !isExportBatchRunning) {
      confirmPdfExportBtn.textContent = `✦ 确认补全翻译 (${pendingPages.length} 页) 并导出 PDF`;
    }
  } else {
    pdfExportTokenWarningBox?.classList.add('is-ready');
    if (pdfTokenWarnTitle) {
      pdfTokenWarnTitle.textContent = `✅ 所选页码范围（共 ${targetPages.length} 页）已全部翻译完成`;
    }
    if (pdfTokenWarnBody) {
      pdfTokenWarnBody.innerHTML = `
        • <b>导出范围</b>：${formatPageListSummary(targetPages)}（共 ${targetPages.length} 页）<br/>
        • <b>导出样式</b>：<b>${modeLabel}</b>（完整保留论文多页排版、数学公式与原位汉化图表，图片跨页不截断）<br/>
        • <b>额外 Token 消耗</b>：<b>0 Token</b>（所有目标页面均已就绪，点击下方按钮立即导出）
      `;
    }
    if (confirmPdfExportBtn && !isExportBatchRunning) {
      confirmPdfExportBtn.textContent = `✦ 立即导出${modeLabel} (${targetPages.length} 页)`;
    }
  }
}

function openPdfExportConfirmModal(defaultViewMode = 'translation-only') {
  if (!isDocumentReady()) return;
  defaultViewMode = getExportViewMode(defaultViewMode);
  if (!pdfExportConfirmModal) {
    executeLayoutPreservingPdfExport(defaultViewMode, null);
    return;
  }

  const modeRadio = pdfExportConfirmModal.querySelector(
    `input[name="pdfExportViewMode"][value="${defaultViewMode}"]`
  );
  if (modeRadio) modeRadio.checked = true;

  const totalPages = Math.max(1, currentDoc.totalPages || 1);
  const translatedSet = getTranslatedPagesSet();
  if (exportRangeStartInput) {
    exportRangeStartInput.max = String(totalPages);
    exportRangeStartInput.value = '1';
  }
  if (exportRangeEndInput) {
    exportRangeEndInput.max = String(totalPages);
    exportRangeEndInput.value = String(Math.min(totalPages, Math.max(5, translatedSet.size || 5)));
  }

  const allScopeRadio = pdfExportConfirmModal.querySelector(
    'input[name="pdfExportScope"][value="all"]'
  );
  if (allScopeRadio) allScopeRadio.checked = true;

  if (pdfExportLiveProgressBox) pdfExportLiveProgressBox.hidden = true;
  if (abortAndExportDoneBtn) abortAndExportDoneBtn.hidden = true;
  if (confirmPdfExportBtn) confirmPdfExportBtn.disabled = false;

  pdfExportConfirmModal.hidden = false;
  refreshPdfExportModalEstimate();
}

function closePdfExportModal() {
  if (isExportBatchRunning) {
    abortExportBatchMode = 'cancel';
    stopRequested = true;
    documentRequests.cancel();
  }
  if (pdfExportConfirmModal) {
    pdfExportConfirmModal.hidden = true;
  }
}

closePdfExportModalBtn?.addEventListener('click', closePdfExportModal);
cancelPdfExportModalBtn?.addEventListener('click', closePdfExportModal);

document.querySelectorAll('input[name="pdfExportViewMode"], input[name="pdfExportScope"]').forEach((el) => {
  el.addEventListener('change', refreshPdfExportModalEstimate);
});

[exportRangeStartInput, exportRangeEndInput].forEach((inp) => {
  inp?.addEventListener('input', () => {
    const rangeRadio = pdfExportConfirmModal?.querySelector(
      'input[name="pdfExportScope"][value="range"]'
    );
    if (rangeRadio) rangeRadio.checked = true;
    refreshPdfExportModalEstimate();
  });
});

abortAndExportDoneBtn?.addEventListener('click', () => {
  if (isExportBatchRunning) {
    abortExportBatchMode = 'export-done';
    stopRequested = true;
    documentRequests.cancel();
  }
});

confirmPdfExportBtn?.addEventListener('click', async () => {
  if (!isDocumentReady() || isExportBatchRunning) return;
  const session = documentSession;
  const selectedViewMode = getSelectedPdfExportViewMode();
  const { targetPages, pendingPages } = computeTargetAndPendingPages();

  if (pendingPages.length > 0 && currentDoc.fileType === 'pdf') {
    isExportBatchRunning = true;
    abortExportBatchMode = null;
    stopRequested = false;

    if (confirmPdfExportBtn) {
      confirmPdfExportBtn.disabled = true;
      confirmPdfExportBtn.textContent = '⏳ 正在按序补全翻译中…';
    }
    if (abortAndExportDoneBtn) {
      abortAndExportDoneBtn.hidden = false;
    }
    if (pdfExportLiveProgressBox) {
      pdfExportLiveProgressBox.hidden = false;
    }

    try {
      for (let i = 0; i < pendingPages.length; i++) {
        if (abortExportBatchMode || stopRequested) break;
        const pageNum = pendingPages[i];
        const pct = Math.round((i / pendingPages.length) * 100);
        if (pdfExportLiveStatusText) {
          pdfExportLiveStatusText.textContent = `⏳ 正在补全翻译第 ${pageNum} 页（已完成 ${i} / ${pendingPages.length} 页）…`;
        }
        if (pdfExportLivePercentText) {
          pdfExportLivePercentText.textContent = `${pct}%`;
        }
        if (pdfExportLiveBarFill) {
          pdfExportLiveBarFill.style.width = `${Math.max(6, pct)}%`;
        }

        await translateSinglePdfPage(pageNum, { retryFailed: true });
        if (session !== documentSession) return;
        refreshPdfExportModalEstimate();
      }
    } finally {
      if (session !== documentSession) return;
      isExportBatchRunning = false;
      if (confirmPdfExportBtn) confirmPdfExportBtn.disabled = false;
      if (abortAndExportDoneBtn) abortAndExportDoneBtn.hidden = true;
    }

    if (abortExportBatchMode === 'cancel') {
      abortExportBatchMode = null;
      return;
    }

    const doneAfter = getTranslatedPagesSet();
    if (!abortExportBatchMode && targetPages.some(p => !doneAfter.has(p))) {
      if (pdfExportLiveStatusText) pdfExportLiveStatusText.textContent = '部分页面翻译失败，未导出。请重试或选择仅导出已完成页。';
      return;
    }
    const finalPages =
      abortExportBatchMode === 'export-done'
        ? targetPages.filter((p) => doneAfter.has(p))
        : targetPages;
    abortExportBatchMode = null;
    if (finalPages.length === 0) {
      if (pdfExportLiveStatusText) pdfExportLiveStatusText.textContent = '当前范围没有已完成的页面，未导出。';
      return;
    }

    if (pdfExportConfirmModal) pdfExportConfirmModal.hidden = true;
    await executeLayoutPreservingPdfExport(
      selectedViewMode,
      finalPages
    );
    return;
  }

  if (pdfExportConfirmModal) pdfExportConfirmModal.hidden = true;
  await executeLayoutPreservingPdfExport(selectedViewMode, targetPages);
});

async function waitForAllPaperImagesLoaded(container) {
  const imgs = Array.from(
    container.querySelectorAll('.paper-sheet-page:not(.is-print-excluded-page) img')
  );
  await Promise.all(
    imgs.map(async (img) => {
      try {
        if (!img.complete) {
          await new Promise((resolve) => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
          });
        }
        if (typeof img.decode === 'function') {
          await img.decode();
        }
      } catch {
        // ignore single image decode error
      }
    })
  );
}

async function executeLayoutPreservingPdfExport(targetViewMode = 'translation-only', pageNumbersToInclude = null) {
  if (!isDocumentReady()) return;
  if (Array.isArray(pageNumbersToInclude) && pageNumbersToInclude.length === 0) {
    docStatusSubtitle.textContent = '当前范围没有可导出的页面。';
    return;
  }
  targetViewMode = getExportViewMode(targetViewMode);
  const session = documentSession;
  const baseName = (currentDoc.fileName || 'qingjian-doc')
    .replace(/^\(\d+\)\s*/g, '')
    .replace(/[\\/:*?"<>|]/g, '_');

  const prevLayout = layoutStyleSelect ? layoutStyleSelect.value : 'paper-layout';
  const prevViewMode = viewModeSelect ? viewModeSelect.value : 'bilingual';
  const prevSearch = streamSearchInput ? streamSearchInput.value : '';
  const prevTitle = document.title;

  // Switch to Paper Layout + requested View Mode (Pure Translation or Bilingual)
  if (layoutStyleSelect) layoutStyleSelect.value = 'paper-layout';
  if (viewModeSelect) viewModeSelect.value = targetViewMode;
  bilingualStreamContainer.classList.add('mode-paper-layout');
  bilingualStreamContainer.classList.toggle(
    'mode-translation-only',
    targetViewMode === 'translation-only'
  );

  applyDocumentViewMode();
  renderWorkspaceBlocks('', { allChapters: true, forExport: true });

  const allowedSet = Array.isArray(pageNumbersToInclude) && pageNumbersToInclude.length > 0
    ? new Set(pageNumbersToInclude.map(Number))
    : null;

  bilingualStreamContainer.querySelectorAll('[data-paper-page]').forEach((sheet) => {
    const p = Number(sheet.getAttribute('data-paper-page')) || 1;
    if (allowedSet && !allowedSet.has(p)) {
      sheet.classList.add('is-print-excluded-page');
    } else {
      sheet.classList.remove('is-print-excluded-page');
    }
  });

  await waitForAllPaperImagesLoaded(bilingualStreamContainer);
  if (session !== documentSession) return;

  const modeSuffix = targetViewMode === 'translation-only' ? '纯译文排版' : '双语对照排版';
  document.title = `${baseName}.${modeSuffix}`;

  await new Promise((resolve) => setTimeout(resolve, 120));
  if (session !== documentSession) return;
  window.print();

  // Restore workspace UI state after print dialog finishes
  setTimeout(() => {
    if (session !== documentSession) return;
    document.title = prevTitle;
    if (layoutStyleSelect) layoutStyleSelect.value = prevLayout;
    if (viewModeSelect) viewModeSelect.value = prevViewMode;
    bilingualStreamContainer.classList.toggle('mode-paper-layout', prevLayout === 'paper-layout');
    bilingualStreamContainer.classList.toggle(
      'mode-translation-only',
      getExportViewMode(prevViewMode) === 'translation-only'
    );
    bilingualStreamContainer
      .querySelectorAll('.is-print-excluded-page')
      .forEach((el) => el.classList.remove('is-print-excluded-page'));
    applyDocumentViewMode();
    renderWorkspaceBlocks(prevSearch);
  }, 400);
}

function snapshotCompleteDocumentHtml() {
  const scrollTop = bilingualStreamContainer.scrollTop;
  try {
    renderWorkspaceBlocks('', { allChapters: true, forcePaperLayout: true, forExport: true });
    return bilingualStreamContainer.innerHTML;
  } finally {
    renderWorkspaceBlocks(streamSearchInput.value.trim());
    bilingualStreamContainer.scrollTop = scrollTop;
  }
}

function exportTranslatedDocument(format) {
  if (!isDocumentReady()) return;
  const baseName = (currentDoc.fileName || 'qingjian-doc')
    .replace(/^\(\d+\)\s*/g, '')
    .replace(/[\\/:*?"<>|]/g, '_');
  const mode = getExportViewMode();

  if (format === 'pdf-translation-only') {
    openPdfExportConfirmModal('translation-only');
    return;
  }

  if (format === 'pdf-bilingual' || format === 'print-pdf') {
    openPdfExportConfirmModal(format === 'pdf-bilingual' ? 'bilingual' : mode);
    return;
  }

  if (format === 'md') {
    const mdLines = currentDoc.blocks.map((b) => {
      if (b.type === 'code') return serializeMarkdownCode(b);
      if (mode === 'translation-only') return b.translation || `【未翻译，显示原文】\n${b.original}`;
      return `${b.original}\n\n> ${b.translation || ''}`;
    });
    const blob = new Blob([`\uFEFF${mdLines.join('\n\n')}`], { type: 'text/markdown;charset=utf-8' });
    downloadBlob(blob, `${baseName}.bilingual.md`);
  } else if (format === 'html') {
    // Export full Layout-Preserving HTML (including translated figures, formulas, and 1-click Pure/Bilingual toggle)
    const clonedSheetsHtml = snapshotCompleteDocumentHtml();
    const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<title>${escapeHtml(currentDoc.bookTitle || baseName)} - 青简 · 译读 保持排版文档</title>
<style>
  body { margin: 0; padding: 24px 16px 60px; background: #cbd5e1; color: #111827; font-family: "Times New Roman", "Noto Serif SC", "Songti SC", Georgia, serif; }
  .export-topbar { position: sticky; top: 0; z-index: 99; max-width: 840px; margin: 0 auto 20px; padding: 10px 18px; border-radius: 10px; background: rgba(15, 23, 42, 0.94); color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: space-between; box-shadow: 0 10px 25px rgba(0,0,0,0.25); }
  .export-topbar .toggle-label { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 6px; border: 1px solid rgba(129,140,248,0.45); background: #4f46e5; color: #fff; font-size: 12px; font-weight: 600; cursor: pointer; user-select: none; }
  #exportModeToggle { display: none; }
  .paper-sheet-page { max-width: 840px; margin: 0 auto 24px; background: #fff; padding: 42px 48px; border-radius: 4px; box-shadow: 0 10px 30px rgba(15,23,42,0.18); page-break-after: always; }
  .paper-sheet-header { display: flex; justify-content: space-between; padding-bottom: 10px; margin-bottom: 22px; border-bottom: 1px solid #e5e7eb; font-family: sans-serif; font-size: 11.5px; color: #6b7280; }
  .paper-sheet-body.is-two-column { column-count: 2; column-gap: 28px; column-rule: 1px solid rgba(229, 231, 235, 0.7); }
  .paper-block { margin-bottom: 15px; break-inside: avoid-column; position: relative; }
  .paper-block.is-full-span, .paper-block.is-heading, .paper-block.is-figure, .paper-block.is-table, .paper-figure-box { column-span: all; }
  .untranslated-label { display: block; color: #92400e; font: 12px sans-serif; margin-bottom: 5px; text-indent: 0; }
  .paper-untranslated-page { max-width: 840px; margin: 0 auto 24px; padding: 24px; background: #fff; color: #92400e; }
  .paper-untranslated-page button, .paper-untranslated-page .paper-lazy-desc { display: none; }
  .paper-block-toolbar, .paper-figure-hover-bar, .paper-page-lazy-placeholder { display: none !important; }
  .stream-orig { font-size: 13.5px; line-height: 1.65; color: #4b5563; margin-bottom: 6px; text-align: justify; }
  .stream-trans { font-size: 15px; line-height: 1.78; color: #111827; border-left: 2.5px solid #6366f1; padding-left: 10px; text-align: justify; }
  body.mode-translation-only .stream-orig, #exportModeToggle:checked ~ .export-doc-root .stream-orig { display: none !important; }
  body.mode-translation-only .stream-trans, #exportModeToggle:checked ~ .export-doc-root .stream-trans { border-left: none !important; padding-left: 0 !important; text-indent: 2em; }
  .paper-figure-box { margin: 18px 0 24px; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px; break-inside: avoid; page-break-inside: avoid; }
  .paper-figure-canvas { position: relative; box-sizing: border-box; width: 100%; min-height: 220px; background: linear-gradient(to right, rgba(203,213,225,.25) 1px, transparent 1px), linear-gradient(to bottom, rgba(203,213,225,.25) 1px, transparent 1px), #fff; background-size: 24px 24px; border: 1px solid #cbd5e1; border-radius: 6px; overflow: hidden; margin-bottom: 10px; }
  .paper-figure-canvas.has-bg-image { min-height: auto; background: #fff; }
  .paper-fig-bg-img { display: block; width: 100%; height: auto; }
  .paper-fig-label-box { position: absolute; box-sizing: border-box; background: rgba(255,255,255,.96); color: #111827; border: none; border-radius: 2px; padding: 0 2px; font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", -apple-system, sans-serif; font-size: 10.5px; font-weight: 500; line-height: 1.22; box-shadow: none; display: flex; align-items: center; justify-content: center; text-align: center; }
  .paper-fig-hover-hotspot { position: absolute; background: transparent; border: none; border-radius: 2px; }
  .paper-figure-canvas.hide-fig-overlays .paper-fig-label-box, .paper-figure-canvas.hide-fig-overlays .paper-fig-hover-hotspot { opacity: 0 !important; pointer-events: none !important; }
  .math-expr { font-family: "Times New Roman", "STIX Two Math", Cambria, Georgia, serif; }
  .math-display-block { display: block; text-align: center; margin: 10px 0; padding: 8px 12px; background: #f8fafc; border-radius: 6px; overflow-x: auto; }
  .math-frac { display: inline-flex; flex-direction: column; vertical-align: middle; text-align: center; padding: 0 3px; font-size: 0.9em; }
  .math-frac .math-num { border-bottom: 1px solid currentColor; padding: 0 2px 1px; line-height: 1.1; }
  .math-frac.is-binom .math-num { border-bottom: none; }
  .math-frac .math-den { padding: 1px 2px 0; line-height: 1.1; }
  .academic-sup { font-size: 0.75em; line-height: 0; vertical-align: super; color: #4f46e5; }
/* Shared semantic table layout; scrolling preserves columns on narrow viewports. */
.academic-table-scroll { max-width: 100%; overflow-x: auto; text-indent: 0; }
.academic-table { width: 100%; border-collapse: collapse; text-align: left; font-size: 0.92em; line-height: 1.55; color: inherit; }
.academic-table th, .academic-table td { padding: 7px 9px; border-bottom: 1px solid var(--academic-table-line, #d7e1e3); vertical-align: top; min-width: 2em; overflow-wrap: break-word; }
.academic-table th { background: var(--academic-table-head, #edf2f3); font-weight: 600; }
.academic-table .academic-align-left { text-align: left; }
.academic-table .academic-align-center { text-align: center; }
.academic-table .academic-align-right { text-align: right; }
.paper-table-block .stream-orig, .paper-equation-block .stream-orig { color: #475569; }
.paper-table-block .stream-trans, .paper-equation-block .stream-trans { color: #335f65; text-indent: 0 !important; }
.paper-table-block .stream-trans { border-left: 0; padding-left: 0; }

  .paper-table-block { margin: 16px 0; padding: 12px 14px; border-top: 2px solid #0f172a; border-bottom: 2px solid #0f172a; background: #f8fafc; column-span: all; }
  .paper-equation-block { margin: 14px 0; padding: 12px 18px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; text-align: center; }
  .paper-equation-block .stream-orig, .paper-equation-block .stream-trans { text-align: center; text-indent: 0 !important; border-left: none; padding-left: 0; margin-bottom: 4px; }
  .math-display-wrap { display: flex; align-items: center; justify-content: center; gap: 14px; margin: 10px 0; padding: 6px 10px; overflow-x: auto; text-indent: 0 !important; }
  .math-expr.is-display { display: inline-flex; align-items: center; flex-wrap: wrap; justify-content: center; }
  .math-eq-tag { margin-left: auto; color: #475569; flex-shrink: 0; }
  @media print { body { background: #fff; padding: 0; } .export-topbar { display: none !important; } .paper-sheet-page { box-shadow: none; padding: 0; max-width: 100%; } }
</style>
</head>
<body>
  <input type="checkbox" id="exportModeToggle" ${mode === 'translation-only' ? 'checked' : ''} />
  <div class="export-topbar">
    <span><b>青简 · 译读</b> · ${escapeHtml(currentDoc.bookTitle || baseName)}</span>
    <div>
      <label for="exportModeToggle" class="toggle-label">⇄ 切换 纯译文 / 中英双语</label>
    </div>
  </div>
  <div class="export-doc-root">
    ${clonedSheetsHtml}
  </div>
</body>
</html>`;
    const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
    downloadBlob(blob, `${baseName}.bilingual.html`);
  } else if (format === 'epub') {
    const exportDoc = { ...currentDoc, blocks: currentDoc.blocks.map(block => ({ ...block,
      translation: block.translation || (block.type === 'code' || block.type === 'equation'
        ? block.original : `【未翻译，显示原文】\n${block.original}`)
    })) };
    const blob = buildBilingualEpubBlob(exportDoc, mode);
    downloadBlob(blob, `${baseName}.bilingual.epub`);
  } else if (format === 'txt' || format === 'srt') {
    const srt = currentDoc.blocks
      .map(
        (b, i) =>
          `${i + 1}\n${formatSrtTime(b.start ?? i * 3)} --> ${formatSrtTime(
            b.end ?? (i + 1) * 3
          )}\n${b.original}\n${b.translation || ''}\n`
      )
      .join('\n');
    const ext = format === 'txt' ? 'bilingual.txt' : 'bilingual.srt';
    const blob = new Blob([`\uFEFF${srt}`], { type: 'text/plain;charset=utf-8' });
    downloadBlob(blob, `${baseName}.${ext}`);
  }
}

// ============================================================================
// 5. Built-in Sample AI Paper Demo (with Paper Layout & 2D Figure Labels)
// ============================================================================

function loadBuiltInDemo() {
  beginDocumentSession();
  emptyDropzoneSection.hidden = true;
  workspaceSplitMain.hidden = false;
  epubChapterSelectWrap.hidden = true;
  if (pdfCanvasScrollViewer) pdfCanvasScrollViewer.hidden = true;
  pdfNativeEmbed.hidden = true;
  sourceOutlineViewer.hidden = false;
  if (pdfPageJumpWrap) {
    pdfPageJumpWrap.hidden = false;
    if (jumpPageInput) {
      jumpPageInput.max = '3';
      jumpPageInput.value = '3';
    }
    if (totalPagesBadge) {
      totalPagesBadge.textContent = '/ 3';
    }
  }
  startTranslateDocBtn.disabled = false;
  exportMenuBtn.disabled = false;

  currentDoc = {
    fileName: 'MedGraph-Hierarchical-RAG-Paper',
    fileType: 'md',
    pdfBlobUrl: '',
    pdfSourceUrl: '',
    pdfArrayBuffer: null,
    totalPages: 3,
    bookTitle: 'Hierarchical Knowledge Alignment in Medical Large Language Models',
    bookAuthor: '青简 · 译读 (QingJian)',
    chapters: [],
    blocks: [
      {
        id: 0,
        page: 1,
        type: 'heading',
        column: 'full',
        original: '1 Introduction',
        translation: '1 引言'
      },
      {
        id: 1,
        page: 1,
        type: 'paragraph',
        column: 'left',
        original:
          'Large Language Models (LLMs) have demonstrated remarkable capabilities in clinical question answering, yet reconciling top-down expert ontologies with bottom-up corpus-derived knowledge graphs remains a fundamental challenge.',
        translation:
          '大语言模型（LLM）在临床问答任务中展现出了卓越的潜力，但如何将自顶向下的专家医学本体与自底向上的语料库派生知识图谱相融合，仍然是一项核心挑战。'
      },
      {
        id: 2,
        page: 2,
        type: 'figure',
        column: 'full',
        original:
          'Figure 1: System architecture of dual-stream multimodal PDF & webpage image translation.',
        translation:
          '图 1：多模态 PDF 版面保持与网页贴图原位文字翻译的双流系统架构。',
        figureLabels: [
          {
            box_2d: [80, 60, 260, 440],
            original: 'Input: Online PDF / X.com Image',
            translation: '输入：在线 PDF 论文 / X.com 贴图'
          },
          {
            box_2d: [80, 520, 260, 920],
            original: '2D Coordinate OCR & Vision Parser',
            translation: '2D 坐标视觉文字检测与解析器'
          },
          {
            box_2d: [520, 180, 760, 820],
            original: 'Layout-Preserving Bilingual Paper View & In-Place Image Overlay',
            translation: '保持原文排版的论文仿真页与贴图原位译文覆盖层'
          }
        ]
      },
      {
        id: 3,
        page: 3,
        type: 'figure',
        column: 'full',
        original:
          'Figure 2: Overview of the two distinct organizational paradigms: (a) Expert-Defined Medical Ontology (Top-Down) and (b) Corpus-Derived Data Graph (Bottom-Up).',
        translation:
          '图 2：两种截然不同的组织范式概览。(a) 专家定义的医学本体（自上而下）强制执行严格的四层分类体系。(b) 语料库衍生的数据图谱（自下而上）自然涌现出六个语义社区。',
        figureLabels: [
          {
            box_2d: [50, 80, 180, 460],
            original: '(a) Expert-Defined Medical Ontology',
            translation: '(a) 专家定义的医学本体'
          },
          {
            box_2d: [250, 60, 390, 240],
            original: 'Tier 1: Major Category',
            translation: '一层：主要类别'
          },
          {
            box_2d: [250, 270, 390, 460],
            original: 'Tier 2: Minor Category',
            translation: '二层：次要类别'
          },
          {
            box_2d: [470, 60, 610, 240],
            original: 'Tier 3: Broad Scenarios',
            translation: '三层：广泛临床场景'
          },
          {
            box_2d: [470, 270, 610, 460],
            original: 'Tier 4: Specific Disease',
            translation: '四层：具体疾病实体'
          },
          {
            box_2d: [50, 540, 180, 920],
            original: '(b) Corpus-Derived Data Graph',
            translation: '(b) 语料库衍生的数据图谱'
          },
          {
            box_2d: [260, 540, 410, 920],
            original: 'Clinical Reasoning & Differential Diagnosis',
            translation: '临床推理与鉴别诊断'
          },
          {
            box_2d: [480, 540, 630, 920],
            original: 'Pharmacology & Therapeutic Protocols',
            translation: '药理学与治疗方案'
          }
        ]
      },
      {
        id: 4,
        page: 3,
        type: 'heading',
        column: 'full',
        original: '2 Related Work',
        translation: '2 相关工作'
      },
      {
        id: 5,
        page: 3,
        type: 'paragraph',
        column: 'left',
        original:
          'Hierarchical RAG and Graph-Enhanced Retrieval. Standard Retrieval-Augmented Generation (RAG) frameworks operate on flat vector representations, which often struggle to capture multi-hop relational dependencies across dispersed clinical guidelines.',
        translation:
          '分层检索增强生成（Hierarchical RAG）与图增强检索。标准的检索增强生成框架在扁平向量表示上运行，通常难以捕捉分散的临床指南之间的多跳关系依赖。'
      },
      {
        id: 6,
        page: 3,
        type: 'paragraph',
        column: 'right',
        original:
          'Knowledge-Enhanced Pre-training and Fine-tuning. Another prominent line of inquiry directly injects structured domain ontologies into LLM parameters via continual pre-training or structure-aware instruction tuning.',
        translation:
          '知识增强的预训练与微调。另一个重要的研究方向是通过持续预训练或结构感知的指令微调，将结构化领域本体直接注入大语言模型参数中。'
      },
      {
        id: 7,
        page: 3,
        type: 'heading',
        column: 'full',
        original: '3 Methodology',
        translation: '3 方法论'
      },
      {
        id: 8,
        page: 3,
        type: 'paragraph',
        column: 'full',
        original:
          'To bridge the structural gap illustrated in Figure 2, we propose Dual-Graph Alignment (DGA), which jointly optimizes ontological tree constraints and community-level graph embeddings.',
        translation:
          '为了弥合图 2 所示的结构性鸿沟，我们提出了双图对齐框架（DGA），联合优化医学本体树约束与社区级图嵌入表征。'
      }
    ]
  };

  docStatusSubtitle.textContent =
    '已加载「保持原文排版 + 图表内文字原位翻译」示例论文（可在顶部切换「保持排版」与「卡片流」）';
  setDocumentLoadState('ready');
  renderWorkspaceBlocks();
}

loadDemoDocBtn.addEventListener('click', () => {
  loadOnlinePdfFromUrl('https://arxiv.org/pdf/1706.03762', true);
});
emptyDemoBtn.addEventListener('click', loadBuiltInDemo);

if (layoutStyleSelect) {
  layoutStyleSelect.addEventListener('change', () => {
    renderWorkspaceBlocks(streamSearchInput.value.trim());
  });
}

if (paperColumnModeSelect) {
  paperColumnModeSelect.addEventListener('change', () => {
    renderWorkspaceBlocks(streamSearchInput.value.trim());
  });
}

if (toggleTocSidebarBtn && pdfTocSidebar) {
  toggleTocSidebarBtn.addEventListener('click', () => {
    pdfTocSidebar.classList.toggle('is-collapsed');
  });
}

viewModeSelect.addEventListener('change', applyDocumentViewMode);

epubChapterSelect.addEventListener('change', () => {
  renderWorkspaceBlocks(streamSearchInput.value.trim());
});

let documentSearchTimer = null;
streamSearchInput.addEventListener('input', () => {
  clearTimeout(documentSearchTimer);
  const doc = currentDoc;
  documentSearchTimer = setTimeout(() => {
    documentSearchTimer = null;
    if (currentDoc === doc) renderWorkspaceBlocks(streamSearchInput.value.trim());
  }, 180);
});
window.addEventListener('pagehide', () => clearTimeout(documentSearchTimer));

document.getElementById('documentReadingPager')?.addEventListener('click', event => {
  const button = event.target.closest('[data-reading-step]');
  if (!button || !isDocumentReady()) return;
  currentDoc.readingWindowPage = (currentDoc.readingWindowPage || 0) + Number(button.dataset.readingStep);
  bilingualStreamContainer.scrollTop = 0;
  sourceOutlineViewer.scrollTop = 0;
  renderWorkspaceBlocks(streamSearchInput.value.trim());
});
document.querySelector('[data-reading-page]')?.addEventListener('change', event => {
  if (!isDocumentReady()) return;
  currentDoc.readingWindowPage = Math.max(0, (Number(event.target.value) || 1) - 1);
  bilingualStreamContainer.scrollTop = 0;
  sourceOutlineViewer.scrollTop = 0;
  renderWorkspaceBlocks(streamSearchInput.value.trim());
});
document.querySelector('[data-reading-page]')?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    event.currentTarget.dispatchEvent(new Event('change', { bubbles: true }));
  }
});
document.getElementById('documentTocPager')?.addEventListener('click', event => {
  const button = event.target.closest('[data-toc-window-step]');
  if (!button || !isDocumentReady()) return;
  currentDoc.tocWindowPage = (currentDoc.tocWindowPage || 0) + Number(button.dataset.tocWindowStep);
  renderTocSidebar();
  pdfTocList.scrollTop = 0;
});

studioSettingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

function initStudioFromQueryParams() {
  try {
    const params = new URLSearchParams(window.location.search);
    const pdfUrl = params.get('url');
    const auto = params.get('auto') !== '0';
    if (pdfUrl) {
      loadOnlinePdfFromUrl(pdfUrl, auto);
    }
  } catch {
    // ignore malformed query parameters
  }
}

initStudioFromQueryParams();
