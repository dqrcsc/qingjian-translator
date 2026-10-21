/**
 * Document Studio Controller for Immersive Gemini.
 * Handles PDF (Left Native Viewer + Right Bilingual Stream via Gemini Multimodal or Local Stream),
 * EPUB (Chapter Navigation + Bilingual EPUB Export), Markdown, HTML, TXT, and SRT/VTT files.
 */

import { MESSAGE_TYPES } from '../shared/constants.js';
import { getSettings, getActiveProtocol } from '../shared/storage.js';
import {
  escapeHtml,
  parseSubtitles,
  formatSrtTime,
  createBatches,
  normalizeOnlinePdfUrl
} from '../shared/utils.js';
import { parseEpubFile, buildBilingualEpubBlob } from './epub-engine.js';
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
  bookTitle: '',
  bookAuthor: '',
  chapters: [],
  blocks: [] // Array of { id, page, chapterIndex, type, column, original, translation, figureBox2d, figureLabels, imageDataUrl, start, end }
};

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
    const response = await fetch(pdfUrl, {
      method: 'GET',
      credentials: 'omit',
      headers: {
        Accept: 'application/pdf,*/*;q=0.8'
      }
    });

    const ab = await response.arrayBuffer();
    const headerBytes = new Uint8Array(ab.slice(0, 8));
    const headerAscii = new TextDecoder('ascii').decode(headerBytes);
    const isPdfBinary = headerAscii.startsWith('%PDF-');

    if (!response.ok || !isPdfBinary) {
      showNativePdfEmbed(pdfUrl);
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

    const file = new File([ab], inferredName, { type: 'application/pdf' });
    await handleFileLoaded(file, {
      sourceUrl: pdfUrl,
      autoStartTranslate
    });
  } catch (err) {
    progressBarWrap.hidden = true;
    docStatusSubtitle.textContent = `⚠️ 在线加载 PDF 失败: ${err?.message || err}`;
    bilingualStreamContainer.innerHTML = `
      <div class="stream-block-card">
        <div class="stream-orig" style="color:#fca5a5;">⚠️ 在线加载 PDF 失败：${escapeHtml(err?.message || String(err))}</div>
        <div class="stream-trans">请检查网络连接或该 PDF 链接是否可公开访问。</div>
      </div>
    `;
  }
}

async function handleFileLoaded(file, options = {}) {
  const name = file.name;
  const ext = name.split('.').pop().toLowerCase();

  if (currentDoc.pdfBlobUrl) {
    URL.revokeObjectURL(currentDoc.pdfBlobUrl);
  }
  lazyPageQueue.length = 0;

  currentDoc = {
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
  startTranslateDocBtn.disabled = false;
  startTranslateDocBtn.textContent = '✦ 开始翻译';
  exportMenuBtn.disabled = false;

  docStatusSubtitle.textContent = options.sourceUrl
    ? `已加载在线 PDF：${name}`
    : `已加载文档：${name}`;

  if (ext === 'pdf') {
    currentDoc.fileType = 'pdf';
    const ab = await file.arrayBuffer();
    currentDoc.pdfArrayBuffer = ab;
    const opened = await openPdfDocument(ab);
    currentDoc.pdfDoc = opened.pdfDoc;
    currentDoc.totalPages = Math.max(1, opened.numPages || estimatePdfPageCount(ab));
    currentDoc.pdfBlobUrl = URL.createObjectURL(new Blob([ab], { type: 'application/pdf' }));

    document.title = `${name} - 双语 PDF 对照翻译 | 青简 · 译读`;
    leftPaneTitle.textContent = `📕 ${name} (共 ${currentDoc.totalPages} 页)`;
    sourceOutlineViewer.hidden = true;

    if (currentDoc.pdfDoc && pdfCanvasScrollViewer) {
      pdfNativeEmbed.hidden = true;
      pdfCanvasScrollViewer.hidden = false;
      const ok = await initLeftPdfScrollViewer();
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
      const localBlocks = await extractPdfBlocksLocally(ab);
      if (localBlocks.length > 0) {
        currentDoc.blocks = localBlocks;
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

    if (options.autoStartTranslate) {
      startDocumentTranslation();
    }
  } else if (ext === 'epub') {
    currentDoc.fileType = 'epub';
    const ab = await file.arrayBuffer();
    const parsed = await parseEpubFile(ab);
    currentDoc.bookTitle = parsed.bookTitle;
    currentDoc.bookAuthor = parsed.bookAuthor;
    currentDoc.chapters = parsed.chapters;
    currentDoc.blocks = parsed.blocks;

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
    const text = await file.text();
    const cues = parseSubtitles(text);
    currentDoc.blocks = cues.map((c, idx) => ({
      id: idx,
      page: 1,
      type: 'subtitle',
      start: c.start,
      end: c.end,
      original: c.text,
      translation: ''
    }));
    leftPaneTitle.textContent = `🎬 字幕文件 (${name})`;
    renderWorkspaceBlocks();
  } else if (ext === 'html' || ext === 'htm') {
    currentDoc.fileType = 'html';
    const text = await file.text();
    currentDoc.blocks = parseHtmlDocumentToBlocks(text);
    leftPaneTitle.textContent = `📙 HTML 文档 (${name})`;
    renderWorkspaceBlocks();
  } else {
    currentDoc.fileType = 'md';
    const text = await file.text();
    currentDoc.blocks = parseMarkdownToBlocks(text);
    leftPaneTitle.textContent = `📘 Markdown / 文本 (${name})`;
    renderWorkspaceBlocks();
  }
}

function parseMarkdownToBlocks(mdText) {
  const lines = mdText.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let inCodeFence = false;
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
    if (line.trim().startsWith('```')) {
      if (!inCodeFence) {
        flushPara();
        inCodeFence = true;
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
          translation: codeStr // Code blocks stay untranslated
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
  flushPara();
  return blocks;
}

function parseHtmlDocumentToBlocks(htmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlText, 'text/html');
  const blocks = [];
  doc.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, blockquote, pre').forEach((el) => {
    if (el.tagName !== 'PRE' && el.querySelector('p')) return;
    const text = (el.textContent || '').trim();
    if (text.length < 2) return;
    const tag = el.tagName.toLowerCase();
    const isCode = tag === 'pre';
    blocks.push({
      id: blocks.length,
      page: 1,
      type: tag.startsWith('h') ? 'heading' : isCode ? 'code' : 'paragraph',
      original: text,
      translation: isCode ? text : ''
    });
  });
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

async function getOrRenderPdfPage(pageNum) {
  if (!currentDoc.pdfDoc) return null;
  const p = Math.max(1, Math.min(currentDoc.totalPages || 1, Number(pageNum) || 1));
  if (!currentDoc.pageRenderCache) {
    currentDoc.pageRenderCache = new Map();
  }
  if (currentDoc.pageRenderCache.has(p)) {
    const cached = currentDoc.pageRenderCache.get(p);
    // Refresh LRU order
    currentDoc.pageRenderCache.delete(p);
    currentDoc.pageRenderCache.set(p, cached);
    return cached;
  }

  // Evict oldest high-DPI canvas render when exceeding MAX_CACHED_PAGE_RENDERS
  if (currentDoc.pageRenderCache.size >= MAX_CACHED_PAGE_RENDERS) {
    for (const candidatePage of currentDoc.pageRenderCache.keys()) {
      if (currentDoc.translatingPages && currentDoc.translatingPages.has(candidatePage)) {
        continue;
      }
      const evictedPromise = currentDoc.pageRenderCache.get(candidatePage);
      currentDoc.pageRenderCache.delete(candidatePage);
      Promise.resolve(evictedPromise)
        .then((rendered) => {
          if (
            rendered &&
            rendered.canvas &&
            !(currentDoc.translatingPages && currentDoc.translatingPages.has(candidatePage))
          ) {
            rendered.canvas.width = 0;
            rendered.canvas.height = 0;
            rendered.canvas = null;
          }
        })
        .catch(() => {});
      if (currentDoc.pageRenderCache.size < MAX_CACHED_PAGE_RENDERS) {
        break;
      }
    }
  }

  const renderPromise = renderPdfPageToCanvas(currentDoc.pdfDoc, p, 2.0)
    .then((res) => {
      if (!res) {
        currentDoc.pageRenderCache?.delete(p);
      }
      return res;
    })
    .catch(() => {
      currentDoc.pageRenderCache?.delete(p);
      return null;
    });
  currentDoc.pageRenderCache.set(p, renderPromise);
  return renderPromise;
}

async function ensureLeftPdfPageRendered(pageNum) {
  if (!pdfCanvasScrollViewer || !currentDoc.pdfDoc) return false;
  const p = Math.max(1, Math.min(currentDoc.totalPages || 1, Number(pageNum) || 1));
  const slot = pdfCanvasScrollViewer.querySelector(`.left-pdf-page-slot[data-left-pdf-page="${p}"]`);
  if (!slot) return false;
  if (slot.dataset.rendered === '1') return true;
  if (slot.dataset.rendering === '1') {
    await getOrRenderPdfPage(p);
    return slot.dataset.rendered === '1';
  }

  slot.dataset.rendering = '1';
  try {
    const rendered = await getOrRenderPdfPage(p);
    const imgSrc =
      rendered &&
      (rendered.jpegDataUrl ||
        (rendered.jpegBase64 ? `data:image/jpeg;base64,${rendered.jpegBase64}` : ''));
    if (imgSrc) {
      slot.innerHTML = `
        <span class="left-pdf-page-badge">Page ${p} / ${currentDoc.totalPages || 1}</span>
        <img class="left-pdf-page-img" src="${imgSrc}" alt="Original PDF Page ${p}" />
      `;
      slot.classList.add('is-rendered');
      slot.style.removeProperty('min-height');
      slot.dataset.rendered = '1';
      return true;
    }
    if (p === 1 && currentDoc.pdfBlobUrl) {
      showNativePdfEmbed(currentDoc.pdfBlobUrl);
    }
  } catch {
    if (p === 1 && currentDoc.pdfBlobUrl) {
      showNativePdfEmbed(currentDoc.pdfBlobUrl);
    }
  } finally {
    delete slot.dataset.rendering;
  }
  return false;
}

async function initLeftPdfScrollViewer() {
  if (!pdfCanvasScrollViewer || !currentDoc.pdfDoc) return false;
  if (leftPdfPageObserver) {
    leftPdfPageObserver.disconnect();
    leftPdfPageObserver = null;
  }

  const total = Math.max(1, currentDoc.totalPages || 1);
  pdfCanvasScrollViewer.innerHTML = Array.from({ length: total }, (_, idx) => {
    const p = idx + 1;
    return `
      <div class="left-pdf-page-slot" data-left-pdf-page="${p}">
        <span class="left-pdf-page-badge">Page ${p} / ${total}</span>
        <div class="left-pdf-page-placeholder">正在加载原文档第 ${p} / ${total} 页…</div>
      </div>
    `;
  }).join('');

  if (typeof IntersectionObserver !== 'undefined') {
    leftPdfPageObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const p = Number(entry.target.getAttribute('data-left-pdf-page'));
          if (p >= 1) {
            ensureLeftPdfPageRendered(p);
          }
        }
      },
      {
        root: pdfCanvasScrollViewer,
        rootMargin: '240px 0px',
        threshold: 0.01
      }
    );

    pdfCanvasScrollViewer
      .querySelectorAll('.left-pdf-page-slot[data-left-pdf-page]')
      .forEach((el) => leftPdfPageObserver.observe(el));
  }

  // Eagerly render first 2 original pages on the left before starting translation
  const page1Ok = await ensureLeftPdfPageRendered(1);
  if (!page1Ok) {
    return false;
  }
  if (total >= 2) {
    ensureLeftPdfPageRendered(2);
  }
  return true;
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
      ensureLeftPdfPageRendered(clamped);
      if (clamped + 1 <= (currentDoc.totalPages || 1)) {
        ensureLeftPdfPageRendered(clamped + 1);
      }
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

  if (tocItems.length === 0) {
    pdfTocList.innerHTML = `<div style="padding:10px;font-size:11.5px;color:#64748b;">暂无章节或图表索引</div>`;
    return;
  }

  pdfTocList.innerHTML = tocItems
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
          🖼️ 图内文字原位无痕译文 (${labels.length} 处)
        </span>
        <div class="paper-figure-hover-actions">
          ${
            labels.length > 0 || b.originalImageDataUrl
              ? `
            <button type="button" data-toggle-fig-overlay="${b.id}" title="切换查看原图英文或无痕译文图">
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
        <div class="stream-trans" id="stream-trans-${b.id}">${renderRichAcademicHtml(
    b.translation || '待翻译图注…',
    { blockType: 'caption', pageNum: b.page }
  )}</div>
      </div>
    </div>
  `;
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
    const translatedCount = currentDoc.blocks.filter((b) => Boolean(b.translation)).length;
    progressCounterBadge.textContent = `${translatedCount} / ${currentDoc.blocks.length} 段`;
  }
}

function renderWorkspaceBlocks(filterKeyword = '') {
  const prevScrollTop = bilingualStreamContainer.scrollTop;

  const selectedChapter =
    currentDoc.fileType === 'epub' && epubChapterSelect.value !== 'all'
      ? Number(epubChapterSelect.value)
      : null;

  const visibleBlocks = currentDoc.blocks.filter((b) => {
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

  updateProgressCounterBadge();
  renderTocSidebar();

  // Render Left Outline if not PDF
  if (currentDoc.fileType !== 'pdf') {
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

  const isPaperLayout = !layoutStyleSelect || layoutStyleSelect.value === 'paper-layout';
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
        if (!pageBlocks || pageBlocks.length === 0) {
          const isLoadingThisPage = currentDoc.translatingPages?.has(pageNum);
          return `
            <article
              class="paper-page-lazy-placeholder ${isLoadingThisPage ? 'is-loading-page' : ''}"
              data-paper-page="${pageNum}"
              data-lazy-page="${pageNum}"
            >
              <div class="paper-lazy-title">
                ${
                  isLoadingThisPage
                    ? `⏳ 正在流式解析第 ${pageNum} / ${totalPages} 页（保留原图 + 原文排版）…`
                    : `📄 第 ${pageNum} / ${totalPages} 页（待滚动按需翻译）`
                }
              </div>
              <div class="paper-lazy-desc">
                ${
                  isLoadingThisPage
                    ? '正在提取本页学术段落、裁剪原始插图并生成图中标签译文…'
                    : '为节省 Token 消耗，向下滚动至此页时将自动触发翻译，您也可点击下方按钮立即翻译本页。'
                }
              </div>
              <div style="display:flex;gap:8px;align-items:center;justify-content:center;">
                <button type="button" class="ghost-btn mini-btn page-jump-pill" data-page="${pageNum}">定位左页 (P${pageNum})</button>
                ${
                  isLoadingThisPage
                    ? ''
                    : `<button type="button" class="ghost-btn mini-btn" data-translate-page="${pageNum}">⚡ 立即翻译第 ${pageNum} 页</button>`
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
            const transHtml = renderRichAcademicHtml(
              b.translation || b.original || '待翻译…',
              { blockType: effectiveType, pageNum }
            );

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

        return `
          <article class="paper-sheet-page" data-paper-page="${pageNum}">
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
          <div class="stream-block-card ${b.type === 'heading' ? 'is-heading' : ''}" data-block-id="${b.id}">
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
            <div class="stream-trans" id="stream-trans-${b.id}">${renderRichAcademicHtml(
          b.translation || '待翻译…',
          { blockType: b.type, pageNum: b.page }
        )}</div>
            ${figureLabelsHtml}
          </div>
        `;
      })
      .join('');
  }

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

  // Bind single block re-translate
  bilingualStreamContainer.querySelectorAll('.retranslate-mini-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.retrans);
      const block = currentDoc.blocks.find((x) => x.id === id);
      if (!block) return;
      const transEl = document.getElementById(`stream-trans-${id}`);
      if (transEl) transEl.textContent = 'AI 正在重译…';
      const settings = await getSettings();
      const res = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.TRANSLATE_BATCH,
        payload: {
          items: [{ id: block.id, text: block.original }],
          targetLang: settings.targetLang,
          pageTitle: currentDoc.bookTitle
        }
      });
      if (res && res.ok && res.data?.translations?.[0]) {
        block.translation = res.data.translations[0].translation;
        if (transEl) {
          transEl.innerHTML = renderRichAcademicHtml(block.translation, {
            blockType: block.type,
            pageNum: block.page
          });
        }
      }
    });
  });

  // Re-attach scroll-driven lazy page observer if enabled
  setupLazyPageObserver();
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

async function handleFigureImageFile(file, attachToBlockId = null) {
  if (!file || !file.type.startsWith('image/')) return;
  emptyDropzoneSection.hidden = true;
  workspaceSplitMain.hidden = false;

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const base64 = dataUrl.split(',')[1] || '';
  if (!base64) return;

  docStatusSubtitle.textContent = `🖼️ 正在识别图表文字并生成无痕原位译文 (${file.name})…`;
  progressBarWrap.hidden = false;
  progressBarFill.style.width = '40%';

  try {
    const settings = await getSettings();
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.TRANSLATE_IMAGE,
      payload: {
        imageBase64: base64,
        mimeType: file.type || 'image/png',
        targetLang: settings.targetLang,
        pageTitle: currentDoc.bookTitle || document.title
      }
    });

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
    if (imgCanvas && figureLabels.length > 0) {
      const inpainted = renderSeamlessFigureTranslation(imgCanvas, figureLabels);
      if (inpainted.translatedDataUrl) {
        finalImageDataUrl = inpainted.translatedDataUrl;
        figureLabels = inpainted.labels;
        isCanvasInpainted = true;
      }
    }

    const targetBlock =
      attachToBlockId !== null
        ? currentDoc.blocks.find((b) => b.id === attachToBlockId)
        : null;

    if (targetBlock) {
      targetBlock.imageDataUrl = finalImageDataUrl;
      targetBlock.originalImageDataUrl = dataUrl;
      targetBlock.isCanvasInpainted = isCanvasInpainted;
      if (figureLabels.length > 0) {
        targetBlock.figureLabels = figureLabels;
      }
      if (!targetBlock.translation && data.summaryTranslation) {
        targetBlock.translation = data.summaryTranslation;
      }
    } else {
      const currentPage = Number(jumpPageInput?.value) || 1;
      const newBlock = {
        id: currentDoc.blocks.length,
        page: currentPage,
        type: 'figure',
        column: 'full',
        original: `Figure (${file.name}): ${figureLabels.map((l) => l.original).filter(Boolean).join(' · ') || 'Uploaded Diagram'}`,
        translation:
          data.summaryTranslation ||
          `图（${file.name}）：已完成 ${figureLabels.length} 处图中文字无痕原位重绘。`,
        figureLabels,
        imageDataUrl: finalImageDataUrl,
        originalImageDataUrl: dataUrl,
        isCanvasInpainted
      };
      currentDoc.blocks.unshift(newBlock);
      currentDoc.blocks.forEach((b, idx) => {
        b.id = idx;
      });
    }

    renderWorkspaceBlocks(streamSearchInput.value.trim());
    progressBarFill.style.width = '100%';
    docStatusSubtitle.textContent = `✓ 图表无痕原位翻译完成（共替换 ${figureLabels.length} 处图中文字）`;
  } catch (err) {
    docStatusSubtitle.textContent = `⚠️ 图表翻译失败: ${err?.message || err}`;
  } finally {
    pendingFigureAttachBlockId = null;
    setTimeout(() => {
      progressBarWrap.hidden = true;
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
  if (lazyPageObserver) {
    lazyPageObserver.disconnect();
    lazyPageObserver = null;
  }

  if (
    !currentDoc.lazyScrollEnabled ||
    currentDoc.fileType !== 'pdf' ||
    (pdfModeSelect && pdfModeSelect.value !== 'gemini-multimodal') ||
    typeof IntersectionObserver === 'undefined'
  ) {
    return;
  }

  lazyPageObserver = new IntersectionObserver(
    (entries) => {
      if (isProgrammaticRightScroll) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const pageNum = Number(entry.target.getAttribute('data-lazy-page'));
        if (
          pageNum >= 1 &&
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
    .querySelectorAll('.paper-page-lazy-placeholder[data-lazy-page]')
    .forEach((el) => lazyPageObserver.observe(el));
}

function queueLazyPageTranslation(pageNum, prioritize = false) {
  if (
    pageNum < 1 ||
    pageNum > (currentDoc.totalPages || 1) ||
    currentDoc.translatedPages.has(pageNum) ||
    currentDoc.translatingPages.has(pageNum)
  ) {
    return;
  }

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

  try {
    while (lazyPageQueue.length > 0 && !stopRequested) {
      const nextPage = lazyPageQueue.shift();
      if (
        !nextPage ||
        currentDoc.translatedPages.has(nextPage) ||
        currentDoc.translatingPages.has(nextPage)
      ) {
        continue;
      }
      await translateSinglePdfPage(nextPage);
    }
  } finally {
    isProcessingLazyQueue = false;
  }
}

/**
 * Translates a single PDF page on demand:
 * 1. Renders that page to an HTML <canvas> via PDF.js and extracts exact vector text coordinates.
 * 2. Sends only that single page image to Gemini (saving ~95% tokens vs sending the whole 41-page PDF).
 * 3. Crops each Figure's authentic original canvas, extracts its vector text items (or fallback vision boxes),
 *    seamlessly inpaints the local background color, and redraws native Chinese text in-place.
 */
async function translateSinglePdfPage(pageNum) {
  if (
    currentDoc.translatedPages.has(pageNum) ||
    currentDoc.translatingPages.has(pageNum)
  ) {
    return;
  }

  currentDoc.translatingPages.add(pageNum);
  const totalPages = Math.max(1, currentDoc.totalPages || 1);

  const placeholderEl = bilingualStreamContainer.querySelector(
    `.paper-page-lazy-placeholder[data-lazy-page="${pageNum}"]`
  );
  if (placeholderEl) {
    placeholderEl.classList.add('is-loading-page');
    const titleEl = placeholderEl.querySelector('.paper-lazy-title');
    if (titleEl) {
      titleEl.textContent = `⏳ 正在按需翻译第 ${pageNum} / ${totalPages} 页（原位无痕译图 + 原文排版）…`;
    }
  }

  docStatusSubtitle.textContent = `正在翻译第 ${pageNum} / ${totalPages} 页（原位无痕译图 + 论文排版）…`;
  progressBarWrap.hidden = false;
  const doneBefore = currentDoc.translatedPages.size;
  progressBarFill.style.width = `${Math.min(95, Math.max(12, Math.round(((doneBefore + 0.5) / totalPages) * 100)))}%`;

  try {
    const settings = await getSettings();
    let pageRender = null;
    if (currentDoc.pdfDoc) {
      pageRender = await getOrRenderPdfPage(pageNum);
      ensureLeftPdfPageRendered(pageNum);
    }

    const usesGeminiVision = getActiveProtocol(settings) === 'gemini';
    let rawBlocks = [];

    if (usesGeminiVision) {
      const payload = {
        targetLang: settings.targetLang,
        pageNumber: pageNum,
        pageHint: `Page ${pageNum} only`
      };

      if (pageRender && pageRender.jpegBase64) {
        payload.pageImageBase64 = pageRender.jpegBase64;
        payload.mimeType = 'image/jpeg';
        payload.pageMimeType = 'image/jpeg';
      } else if (currentDoc.pdfArrayBuffer) {
        payload.pdfBase64 = arrayBufferToBase64(currentDoc.pdfArrayBuffer);
      }

      const res = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.ANALYZE_PDF_MULTIMODAL,
        payload
      });

      if (!res || !res.ok) {
        throw new Error(res?.error || `第 ${pageNum} 页解析失败`);
      }

      rawBlocks = res.data?.blocks || [];
    } else {
      // Non-Gemini / OpenAI-compatible text models (e.g., DeepSeek):
      // Reconstruct 2-column academic layout, headings, authors, equations, and figure bounding boxes locally via PDF.js 2D coordinates
      if (pageRender && Array.isArray(pageRender.textItems) && pageRender.textItems.length > 0) {
        rawBlocks = extractStructuredPdfPageBlocks(pageRender, pageNum);
      }
      if (rawBlocks.length === 0 && currentDoc.pdfArrayBuffer) {
        const fallbackAll = await extractPdfBlocksLocally(currentDoc.pdfArrayBuffer);
        const pageSpecific = fallbackAll.filter((b) => Number(b.page) === pageNum);
        rawBlocks = pageSpecific.length > 0 ? pageSpecific : pageNum === 1 ? fallbackAll : [];
      }

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
        settings.batchMaxItems || 10,
        settings.batchMaxChars || 2400
      );

      for (const batch of pageBatches) {
        if (stopRequested) break;
        const batchRes = await chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.TRANSLATE_BATCH,
          payload: {
            items: batch.map((entry) => ({ id: entry.idx, text: entry.b.original })),
            targetLang: settings.targetLang,
            pageTitle: currentDoc.bookTitle || currentDoc.fileName
          }
        });

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
      }
    }

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
            const batchRes = await chrome.runtime.sendMessage({
              type: MESSAGE_TYPES.TRANSLATE_BATCH,
              payload: {
                items: vectorGroups.map((g, gIdx) => ({ id: gIdx, text: g.original })),
                targetLang: settings.targetLang,
                pageTitle: currentDoc.bookTitle || currentDoc.fileName
              }
            });
            if (batchRes && batchRes.ok && Array.isArray(batchRes.data?.translations)) {
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
        id: currentDoc.blocks.length + idx,
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

    // Replace any existing blocks on this page and sort by page number
    const filtered = currentDoc.blocks.filter((b) => Number(b.page) !== pageNum);
    currentDoc.blocks = [...filtered, ...newBlocks]
      .sort((a, b) => (a.page || 1) - (b.page || 1))
      .map((b, i) => ({ ...b, id: i }));

    currentDoc.translatedPages.add(pageNum);
    currentDoc.translatingPages.delete(pageNum);

    renderWorkspaceBlocks(streamSearchInput.value.trim());

    const doneCount = currentDoc.translatedPages.size;
    progressBarFill.style.width = `${Math.min(100, Math.round((doneCount / totalPages) * 100))}%`;
    docStatusSubtitle.textContent =
      doneCount < totalPages
        ? `✓ 已完成 ${doneCount} / ${totalPages} 页 · 向下滚动将自动续译后续页面（省 Token）`
        : `✓ 全部 ${totalPages} 页翻译完成`;
  } catch (err) {
    currentDoc.translatingPages.delete(pageNum);
    docStatusSubtitle.textContent = `⚠️ 第 ${pageNum} 页翻译失败: ${err?.message || err}`;
    renderWorkspaceBlocks(streamSearchInput.value.trim());
  } finally {
    if (currentDoc.translatingPages.size === 0 && lazyPageQueue.length === 0) {
      setTimeout(() => {
        progressBarWrap.hidden = true;
      }, 900);
    }
  }
}

startTranslateDocBtn.addEventListener('click', () => {
  if (isTranslating || isProcessingLazyQueue) {
    stopRequested = true;
    lazyPageQueue.length = 0;
    currentDoc.lazyScrollEnabled = false;
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
    const pageNum = Math.max(
      1,
      Math.min(currentDoc.totalPages || 999, Number(jumpPageInput.value) || 1)
    );
    navigateToPdfPage(pageNum);
    startDocumentTranslation({ start: pageNum, end: pageNum });
  });
}

async function startDocumentTranslation(targetPageRange = null) {
  if (isTranslating) return;
  isTranslating = true;
  stopRequested = false;
  startTranslateDocBtn.disabled = false;
  startTranslateDocBtn.textContent = '⏹ 暂停翻译';
  progressBarWrap.hidden = false;
  progressBarFill.style.width = '10%';

  try {
    const settings = await getSettings();
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
      currentDoc.blocks = await extractPdfBlocksLocally(currentDoc.pdfArrayBuffer);
      renderWorkspaceBlocks();
    }

    // PDF Lazy Page Pipeline (Gemini Multimodal OR PDF.js 2D Coordinate Layout for DeepSeek/OpenAI):
    // Translate ONLY first 2 pages initially, then lazy-translate on scroll!
    if (usesLazyPdfPipeline) {
      const totalPages = Math.max(1, currentDoc.totalPages || 1);

      if (targetPageRange) {
        for (let p = targetPageRange.start; p <= targetPageRange.end; p++) {
          currentDoc.translatedPages.delete(p);
          await translateSinglePdfPage(p);
        }
        navigateToPdfPage(targetPageRange.start);
      } else {
        currentDoc.lazyScrollEnabled = true;
        renderWorkspaceBlocks(streamSearchInput.value.trim());

        // Find the first N untranslated pages (default: first 2 pages) so we don't burn tokens on all 41 pages upfront
        const initialPages = [];
        for (let p = 1; p <= totalPages && initialPages.length < INITIAL_EAGER_PDF_PAGES; p++) {
          if (!currentDoc.translatedPages.has(p)) {
            initialPages.push(p);
          }
        }

        for (const p of initialPages) {
          if (stopRequested) break;
          await translateSinglePdfPage(p);
        }
      }
      return;
    }

    // Standard Batch Pipeline for Markdown, EPUB, HTML, SRT, or Local-Stream PDF
    const selectedChapter =
      currentDoc.fileType === 'epub' && epubChapterSelect.value !== 'all'
        ? Number(epubChapterSelect.value)
        : null;

    const todoBlocks = currentDoc.blocks.filter(
      (b) =>
        b.type !== 'code' &&
        !b.translation &&
        (selectedChapter === null || b.chapterIndex === selectedChapter)
    );

    const batches = createBatches(
      todoBlocks,
      (b) => b.original,
      settings.batchMaxItems || 10,
      settings.batchMaxChars || 2200
    );

    let completed = 0;
    for (const batch of batches) {
      if (stopRequested) break;
      const res = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.TRANSLATE_BATCH,
        payload: {
          items: batch.map((b) => ({ id: b.id, text: b.original })),
          targetLang: settings.targetLang,
          pageTitle: currentDoc.bookTitle
        }
      });

      if (!res || !res.ok) {
        throw new Error(res?.error || '批量翻译中断');
      }

      for (const item of res.data?.translations || []) {
        const target = currentDoc.blocks.find((b) => Number(b.id) === Number(item.id));
        if (target) {
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

    docStatusSubtitle.textContent = `✓ 文档双语翻译已完成 (${currentDoc.fileName})`;
  } catch (err) {
    docStatusSubtitle.textContent = `⚠️ 翻译出错: ${err?.message || err}`;
  } finally {
    isTranslating = false;
    stopRequested = false;
    startTranslateDocBtn.disabled = false;
    startTranslateDocBtn.textContent =
      currentDoc.fileType === 'pdf' &&
      currentDoc.translatedPages.size < (currentDoc.totalPages || 1)
        ? '✦ 继续翻译下两页'
        : '✦ 重新翻译';
    setTimeout(() => {
      progressBarWrap.hidden = true;
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
        • <b>预计消耗 Token</b>：约 <b>${minTokensK}k ~ ${maxTokensK}k Tokens</b>（含多模态版面还原 + 图表原位无痕译字）<br/>
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
  }
});

confirmPdfExportBtn?.addEventListener('click', async () => {
  if (isExportBatchRunning) return;
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

        await translateSinglePdfPage(pageNum);
        refreshPdfExportModalEstimate();
      }
    } finally {
      isExportBatchRunning = false;
      if (confirmPdfExportBtn) confirmPdfExportBtn.disabled = false;
      if (abortAndExportDoneBtn) abortAndExportDoneBtn.hidden = true;
    }

    if (abortExportBatchMode === 'cancel') {
      abortExportBatchMode = null;
      return;
    }

    const doneAfter = getTranslatedPagesSet();
    const finalPages =
      abortExportBatchMode === 'export-done'
        ? targetPages.filter((p) => doneAfter.has(p))
        : targetPages;
    abortExportBatchMode = null;

    if (pdfExportConfirmModal) pdfExportConfirmModal.hidden = true;
    await executeLayoutPreservingPdfExport(
      selectedViewMode,
      finalPages.length > 0 ? finalPages : [1]
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

  renderWorkspaceBlocks('');

  const allowedSet = Array.isArray(pageNumbersToInclude) && pageNumbersToInclude.length > 0
    ? new Set(pageNumbersToInclude.map(Number))
    : null;

  bilingualStreamContainer.querySelectorAll('.paper-sheet-page').forEach((sheet) => {
    const p = Number(sheet.getAttribute('data-paper-page')) || 1;
    if (allowedSet && !allowedSet.has(p)) {
      sheet.classList.add('is-print-excluded-page');
    } else {
      sheet.classList.remove('is-print-excluded-page');
    }
  });

  await waitForAllPaperImagesLoaded(bilingualStreamContainer);

  const modeSuffix = targetViewMode === 'translation-only' ? '纯译文排版' : '双语对照排版';
  document.title = `${baseName}.${modeSuffix}`;

  await new Promise((resolve) => setTimeout(resolve, 120));
  window.print();

  // Restore workspace UI state after print dialog finishes
  setTimeout(() => {
    document.title = prevTitle;
    if (layoutStyleSelect) layoutStyleSelect.value = prevLayout;
    if (viewModeSelect) viewModeSelect.value = prevViewMode;
    bilingualStreamContainer.classList.toggle('mode-paper-layout', prevLayout === 'paper-layout');
    bilingualStreamContainer.classList.toggle(
      'mode-translation-only',
      prevViewMode === 'translation-only'
    );
    bilingualStreamContainer
      .querySelectorAll('.paper-sheet-page.is-print-excluded-page')
      .forEach((el) => el.classList.remove('is-print-excluded-page'));
    if (prevSearch) {
      renderWorkspaceBlocks(prevSearch);
    }
  }, 400);
}

function exportTranslatedDocument(format) {
  const baseName = (currentDoc.fileName || 'qingjian-doc')
    .replace(/^\(\d+\)\s*/g, '')
    .replace(/[\\/:*?"<>|]/g, '_');
  const mode = viewModeSelect.value;

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
      if (b.type === 'code') return b.original;
      if (mode === 'translation-only') return b.translation || b.original;
      return `${b.original}\n\n> ${b.translation || ''}`;
    });
    const blob = new Blob([`\uFEFF${mdLines.join('\n\n')}`], { type: 'text/markdown;charset=utf-8' });
    downloadBlob(blob, `${baseName}.bilingual.md`);
  } else if (format === 'html') {
    // Export full Layout-Preserving HTML (including translated figures, formulas, and 1-click Pure/Bilingual toggle)
    const clonedSheetsHtml = bilingualStreamContainer.innerHTML;
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
  .paper-sheet-body.is-two-column { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); column-gap: 24px; align-items: start; }
  .paper-sheet-body.is-two-column .paper-col-full { grid-column: 1 / -1; }
  .paper-sheet-body.is-two-column .paper-col-left { grid-column: 1; }
  .paper-sheet-body.is-two-column .paper-col-right { grid-column: 2; }
  .paper-block { margin-bottom: 15px; break-inside: avoid; }
  .paper-block-toolbar, .paper-figure-hover-bar, .paper-page-lazy-placeholder { display: none !important; }
  .stream-orig { font-size: 13.5px; line-height: 1.65; color: #4b5563; margin-bottom: 6px; text-align: justify; }
  .stream-trans { font-size: 15px; line-height: 1.78; color: #111827; border-left: 2.5px solid #6366f1; padding-left: 10px; text-align: justify; }
  body.mode-translation-only .stream-orig, #exportModeToggle:checked ~ .export-doc-root .stream-orig { display: none !important; }
  body.mode-translation-only .stream-trans, #exportModeToggle:checked ~ .export-doc-root .stream-trans { border-left: none !important; padding-left: 0 !important; text-indent: 2em; }
  .paper-figure-box { margin: 18px 0 24px; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px; break-inside: avoid; page-break-inside: avoid; }
  .paper-figure-canvas { position: relative; width: 100%; overflow: hidden; margin-bottom: 10px; }
  .paper-fig-bg-img { display: block; max-width: 100%; max-height: 180mm; width: auto; height: auto; margin: 0 auto; }
  .math-expr { font-family: "Times New Roman", "STIX Two Math", Cambria, Georgia, serif; }
  .math-display-block { display: block; text-align: center; margin: 10px 0; padding: 8px 12px; background: #f8fafc; border-radius: 6px; overflow-x: auto; }
  .math-frac { display: inline-flex; flex-direction: column; vertical-align: middle; text-align: center; padding: 0 3px; font-size: 0.9em; }
  .math-frac-num { border-bottom: 1px solid currentColor; padding: 0 2px 1px; line-height: 1.1; }
  .math-frac-den { padding: 1px 2px 0; line-height: 1.1; }
  .academic-sup { font-size: 0.75em; line-height: 0; vertical-align: super; color: #4f46e5; }
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
    const blob = buildBilingualEpubBlob(currentDoc, mode);
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

viewModeSelect.addEventListener('change', () => {
  bilingualStreamContainer.classList.toggle(
    'mode-translation-only',
    viewModeSelect.value === 'translation-only'
  );
});

epubChapterSelect.addEventListener('change', () => {
  renderWorkspaceBlocks(streamSearchInput.value.trim());
});

streamSearchInput.addEventListener('input', () => {
  renderWorkspaceBlocks(streamSearchInput.value.trim());
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
