/**
 * Main Content Script for Immersive Gemini Chrome Extension.
 * Coordinates:
 * 1. Webpage Bilingual DOM Translation Engine (IntersectionObserver + MutationObserver + Inline Placeholder Protection)
 * 2. Shadow-DOM Isolated Floating Ball, Selection AI Deep Popover, and Toast Notifications
 * 3. Input Box Triple-Space Real-Time Translation (<input>, <textarea>, [contenteditable])
 * 4. Single-Paragraph Hover + Alt Quick Translation
 * 5. YouTube Dual Subtitle Overlay, Interactive Timeline Sidebar, and Experimental Gemini Multimodal Audio Translation
 */

(function initImmersiveGeminiContentScript() {
  if (window.__IMMERSIVE_GEMINI_CONTENT_LOADED__) return;
  window.__IMMERSIVE_GEMINI_CONTENT_LOADED__ = true;

  const STORAGE_KEY = 'immersive_gemini_settings_v1';
  const pageRequests = globalThis.QingJianRequests.createScope();
  const subtitleRequests = globalThis.QingJianRequests.createScope();
  const audioRequests = globalThis.QingJianRequests.createScope();
  const selectionRequests = globalThis.QingJianRequests.createScope();
  const inputRequests = globalThis.QingJianRequests.createScope();
  const requestScopes = [pageRequests, subtitleRequests, audioRequests, selectionRequests, inputRequests];
  window.addEventListener('pagehide', () => {
    requestScopes.forEach(scope => scope.cancel());
    if (ytAudioListenActive) stopYoutubeAudioListen();
    disposeYoutubeTimeline();
  });
  window.addEventListener('pageshow', (e) => {
    if (!e?.persisted) return;
    for (const [id, record] of blockMap) {
      blockMap.delete(id);
      if (record.element?.dataset?.igStatus === 'queued') {
        resetElementTranslationState(record.element);
      }
    }
    pendingParagraphQueue = [];
    if (isPageTranslated && document.body) {
      scanAndObserveContainer(document.body);
    }
  });
  function sendModelRequest(message) {
    const scope = message.type === 'TRANSLATE_YOUTUBE_CUES' ? subtitleRequests
      : message.type === 'TRANSLATE_YOUTUBE_AUDIO' ? audioRequests
      : message.type === 'TRANSLATE_SELECTION' ? selectionRequests
      : message.type === 'TRANSLATE_INPUT_TEXT' ? inputRequests : pageRequests;
    return scope.request(message);
  }


  const DEFAULT_SETTINGS = {
    providerId: 'google',
    apiProtocol: 'gemini',
    modelId: '',
    customModelId: '',
    targetLang: 'zh-CN',
    inputTargetLang: 'en',
    translationStyle: 'clean',
    enableFloatingBall: true,
    floatingBallPositionY: 68,
    enableSelectionTooltip: true,
    enableTripleSpaceInput: true,
    enableHoverTranslate: true,
    enableImageTranslate: true,
    autoTranslatePageImages: true,
    enableCache: true,
    batchMaxItems: 10,
    batchMaxChars: 2200,
    enableYoutubeDualSub: true,
    youtubeAutoEnable: true,
    youtubeSubFontSize: 22,
    youtubeTransColor: '#fde047',
    youtubeBgOpacity: 0.72,
    youtubeShowSidebar: false,
    autoTranslateAllPages: false,
    autoTranslateOnlinePdf: false,
    alwaysTranslateDomains: '',
    neverTranslateDomains: 'localhost\n127.0.0.1'
  };

  function sanitizeContentSettings(raw) {
    const merged = { ...DEFAULT_SETTINGS, ...(raw || {}),
      apiProtocol: globalThis.QingJianSettings.resolveProtocol(raw) };
    delete merged.apiKey;
    delete merged.providerConfigs;
    return merged;
  }

  const STYLE_LIST = [
    { id: 'clean', label: '清爽对照' },
    { id: 'blockquote', label: '引用竖线' },
    { id: 'underline', label: '精致虚线' },
    { id: 'mask', label: '学习模糊' },
    { id: 'marker', label: '荧光马克' },
    { id: 'translation-only', label: '仅看译文' }
  ];

  let settings = { ...DEFAULT_SETTINGS };
  let settingsRevision = 0;
  let isPageTranslated = false;
  let siteAutoPaused = false;
  let sitePauseReadRevision = 0;
  let manualToggleRevision = 0;
  let pageTranslationSession = 0;
  let totalTranslatedCount = 0;
  let pendingParagraphQueue = [];
  let flushQueueTimer = null;
  let blockIdCounter = 1;
  const blockMap = new Map(); // id -> { element, rawText, placeholders }
  const paragraphSourceSignatures = new WeakMap();
  let viewportObserver = null;
  let domMutationObserver = null;
  let hoveredElement = null;

  // Shadow DOM UI references
  let shadowRoot = null;
  let floatingBallEl = null;
  let selectionTriggerEl = null;
  let selectionCardEl = null;
  let toastContainerEl = null;
  let lastSelectionData = null;

  // ============================================================================
  // 1. Settings Sync & Domain Rules
  // ============================================================================

  function isExtensionContextValid() {
    try {
      return Boolean(globalThis.chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function safeRuntimeSendMessage(message) {
    const isSubtitle = message.type === 'TRANSLATE_YOUTUBE_CUES';
    const failed = error => {
      if (!isSubtitle) return null;
      const detail = String(error?.message || error?.error || error || '字幕请求连接未返回响应，请重试');
      const invalidated = !isExtensionContextValid() || /extension context invalidated/i.test(detail);
      return invalidated
        ? { ok: false, code: 'EXTENSION_CONTEXT_INVALIDATED', error: '扩展已更新或重新加载，请刷新此页面以恢复字幕翻译。' }
        : { ok: false, error: detail };
    };
    if (!isExtensionContextValid()) return Promise.resolve(failed());
    try {
      const request = isSubtitle ? sendModelRequest(message) : chrome.runtime.sendMessage(message);
      return Promise.resolve(request).then(result => {
        if (isSubtitle && (!result || (!result.ok && !result.cancelled))) return failed(result);
        return result;
      }, failed);
    } catch (error) {
      return Promise.resolve(failed(error));
    }
  }

  async function safeUpdateStorage(partial) {
    try {
      if (!isExtensionContextValid()) throw new Error('扩展已更新，请刷新页面');
      const response = await chrome.runtime.sendMessage({ type: 'UPDATE_CONTENT_SETTINGS', payload: partial });
      if (!response?.ok) throw new Error(response?.error || '设置未保存');
    } catch (error) {
      showPageToast(`设置保存失败：${error?.message || error}`, 'warn');
    }
  }

  async function refreshSiteAutoTranslatePause() {
    const revision = ++sitePauseReadRevision;
    const response = await safeRuntimeSendMessage({ type: 'GET_SITE_AUTO_TRANSLATE_STATE' });
    if (!response?.ok) return false;
    if (revision === sitePauseReadRevision) {
      siteAutoPaused = response.data.paused;
      updateFloatingBallStatus();
    }
    return true;
  }

  async function saveSiteAutoTranslatePause(paused) {
    const response = await safeRuntimeSendMessage({ type: 'SET_SITE_AUTO_TRANSLATE_STATE', payload: { paused } });
    if (!response?.ok) {
      showPageToast(`本站临时暂停状态保存失败：${response?.error || '请刷新后重试'}`, 'warn');
      return false;
    }
    if (!await refreshSiteAutoTranslatePause()) {
      showPageToast('本站临时暂停状态已保存，但状态刷新失败，请刷新页面确认。', 'warn');
      return false;
    }
    return true;
  }

  async function loadSettings() {
    if (!isExtensionContextValid()) return false;
    const revision = settingsRevision;
    try {
      const res = await chrome.storage.local.get(STORAGE_KEY);
      if (revision === settingsRevision) settings = sanitizeContentSettings(res?.[STORAGE_KEY]);
      applyStyleAttribute(settings.translationStyle);
      applyYoutubeCssVariables();
      updateFloatingBallVisibility();
      updateFloatingBallStatus();
      checkAutoTranslateDomainRule();
      return true;
    } catch {
      return false;
    }
  }

  function translationConfigSignature(raw = {}) {
    const protocol = globalThis.QingJianSettings.resolveProtocol(raw);
    const model = String(raw.customModelId || '').trim() || String(raw.modelId || '').trim() || String(raw.availableModels?.[0]?.id || '').trim();
    const rawKey = String(raw.apiKey ?? '');
    let keyDigest = 0;
    for (let i = 0; i < rawKey.length; i++) keyDigest = Math.imul(keyDigest ^ rawKey.charCodeAt(i), 16777619) >>> 0;
    return JSON.stringify([raw.providerId ?? 'google', protocol,
      raw.apiBaseUrl ?? 'https://generativelanguage.googleapis.com/v1beta', rawKey ? `${rawKey.length}:${keyDigest.toString(16)}` : '',
      protocol === 'gemini' ? model.replace(/^models\//i, '') : model,
      raw.targetLang ?? 'zh-CN', raw.tonePreset ?? 'standard', raw.temperature ?? 0.2,
      raw.customSystemPrompt ?? '', raw.glossaryText ?? 'LLM = 大语言模型\nTransformer = Transformer 架构\nAgent = 智能体\nToken = 词元 (Token)']);
  }

  if (isExtensionContextValid()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORAGE_KEY]) {
        const change = changes[STORAGE_KEY];
        settingsRevision++;
        const previous = settings;
        if (translationConfigSignature(change.oldValue) !== translationConfigSignature(change.newValue)) {
          invalidateYoutubeTranslations();
          const hadPageOutput = isPageTranslated || document.querySelector('.ig-trans-node, .ig-img-overlay-layer');
          disablePageTranslation();
          selectionRequests.cancel();
          if (selectionCardEl) selectionCardEl.style.display = 'none';
          invalidateInputTranslation();
          inputRequests.cancel();
          if (hadPageOutput) showPageToast('翻译设置已变化，已恢复原文。请重新开启网页翻译以使用新配置。', 'info');
        }
        if ((change.oldValue?.inputTargetLang ?? 'en') !== (change.newValue?.inputTargetLang ?? 'en')) { invalidateInputTranslation(); inputRequests.cancel(); }
        settings = sanitizeContentSettings(change.newValue);
        syncYoutubePreferences(previous);
        applyStyleAttribute(settings.translationStyle);
        applyYoutubeCssVariables();
        updateFloatingBallVisibility();
        updateFloatingBallStatus();
      }
    });
  }

  function applyStyleAttribute(styleId) {
    document.documentElement.setAttribute('data-ig-style', styleId || 'clean');
    if (shadowRoot) {
      const pills = shadowRoot.querySelectorAll('.ig-style-pill');
      pills.forEach((pill) => {
        const isSelected = pill.dataset.style === styleId;
        pill.classList.toggle('is-active', isSelected && isPageTranslated);
        pill.classList.toggle('is-preset', isSelected && !isPageTranslated);
        const tickEl = pill.querySelector('.ig-pill-tick');
        if (tickEl) {
          tickEl.textContent = isSelected && isPageTranslated ? '✓' : '';
        }
      });
    }
  }

  function parseDomainList(raw) {
    return String(raw || '')
      .split(/\r?\n/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  function isCurrentDomainInAlwaysList() {
    const host = window.location.hostname.toLowerCase();
    if (!host) return false;
    const alwaysList = parseDomainList(settings.alwaysTranslateDomains);
    return alwaysList.some((d) => host === d || host.endsWith('.' + d));
  }

  function isForeignPageLikely() {
    const sampleParagraphs = Array.from(document.querySelectorAll('p, h1, h2, article li')).slice(0, 18);
    const sampleText = sampleParagraphs.map((el) => (el.textContent || '').trim()).join(' ');
    if (sampleText.length < 30) return false;
    const target = String(settings.targetLang || 'zh-CN').toLowerCase();
    const docLang = (document.documentElement?.getAttribute?.('lang') || '').trim().toLowerCase();
    if (docLang) {
      const targetPrimary = target.split('-')[0];
      const docPrimary = docLang.split('-')[0];
      if (targetPrimary !== 'zh' && docPrimary === targetPrimary) return false;
      if (targetPrimary === 'zh' && docPrimary === 'zh') {
        const isTargetTw = target.includes('tw') || target.includes('hk') || target.includes('hant');
        const isDocTw = docLang.includes('tw') || docLang.includes('hk') || docLang.includes('hant');
        if (isTargetTw === isDocTw) return false;
      }
    }
    if (target.startsWith('en') && /\b(the|and|for|that|with|from|this|are|was|have)\b/i.test(sampleText)) {
      const nonAscii = (sampleText.match(/[^\x00-\x7f]/g) || []).length;
      if (nonAscii / sampleText.length < 0.1) return false;
    }
    return !isMostlyTargetLanguage(sampleText, settings.targetLang);
  }

  let hasAutoOpenedPdfTab = false;

  async function checkAutoTranslateDomainRule() {
    const intent = manualToggleRevision;
    if (!await refreshSiteAutoTranslatePause() || intent !== manualToggleRevision || siteAutoPaused) return;
    const host = window.location.hostname.toLowerCase();
    if (!host || host.includes('youtube.com')) return;
    const neverList = parseDomainList(settings.neverTranslateDomains);
    if (neverList.some((d) => host === d || host.endsWith('.' + d))) return;

    // Online PDF links stay in the browser's native PDF reader by default.
    // Only auto-open the Studio translation tab if the user explicitly enabled `autoTranslateOnlinePdf`.
    if (isOnlinePdfPage()) {
      if (settings.autoTranslateOnlinePdf && !hasAutoOpenedPdfTab) {
        hasAutoOpenedPdfTab = true;
        openCurrentPdfInNewTab(true);
      }
      return;
    }

    if (isCurrentDomainInAlwaysList() || (settings.autoTranslateAllPages && isForeignPageLikely())) {
      if (!isPageTranslated) {
        enablePageTranslation();
      }
    }
  }

  // ============================================================================
  // 2. Webpage DOM Paragraph & UI Leaf Detection + Inline Placeholder Protection
  // ============================================================================

  const EXPLICIT_PROSE_SELECTOR = [
    '[data-testid="tweetText"]',
    '.commtext',
    '[data-ad-preview="message"]',
    '[slot="text-body"]'
  ].join(',');

  const PROSE_TAGS = new Set([
    'p',
    'blockquote',
    'dd',
    'dt',
    'figcaption',
    'summary',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'li'
  ]);

  const INLINE_CONTENT_TAGS = new Set([
    'span',
    'a',
    'em',
    'strong',
    'b',
    'i',
    'u',
    's',
    'code',
    'kbd',
    'samp',
    'var',
    'sub',
    'sup',
    'mark',
    'small',
    'abbr',
    'cite',
    'q',
    'time',
    'font',
    'br',
    'img',
    'wbr'
  ]);

  const BLOCK_CONTAINER_TAGS = new Set([
    'p',
    'div',
    'ul',
    'ol',
    'table',
    'section',
    'article',
    'main',
    'aside',
    'nav',
    'header',
    'footer',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'li',
    'blockquote',
    'dl',
    'dt',
    'dd',
    'tr',
    'td',
    'th',
    'form',
    'fieldset'
  ]);

  const BLOCK_SELECTOR = [
    'p',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'li',
    'blockquote',
    'dd',
    'dt',
    'figcaption',
    'summary',
    'td',
    'th',
    'label',
    'a',
    'button',
    'span',
    'div',
    'mat-card-title',
    'mat-panel-title',
    '[data-testid="tweetText"]',
    '.commtext'
  ].join(',');

  const ICON_ELEMENT_SELECTOR = [
    'mat-icon',
    'i.material-icons',
    'i.google-material-icons',
    '[class*="material-icons"]',
    '[class*="material-symbols"]',
    '[class*="google-symbols"]',
    '[class*="fa-"]',
    '[class*="iconfont"]',
    '[role="img"]',
    'svg',
    'canvas',
    'img'
  ].join(',');

  const HIDDEN_A11Y_SELECTOR = [
    '[aria-hidden="true"]',
    '[hidden]',
    '.cdk-visually-hidden',
    '.sr-only',
    '.visually-hidden',
    '.screen-reader-text',
    '[class*="visually-hidden"]',
    '[class*="sr-only"]',
    '[class*="screen-reader"]',
    '[id*="screen-reader"]',
    '[class*="a11y"]'
  ].join(',');

  const SKIP_ANCESTOR_SELECTOR = [
    'pre',
    'code',
    'script',
    'style',
    'noscript',
    'svg',
    'canvas',
    'textarea',
    'input',
    'select',
    'option',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="textbox"]',
    '.cm-editor',
    '.monaco-editor',
    '.CodeMirror',
    '[translate="no"]',
    '.notranslate',
    '#movie_player',
    '.html5-video-player',
    '.ytp-caption-window-container',
    '.ytp-chrome-bottom',
    '.ig-trans-node',
    '.ig-trans-block',
    '.ig-trans-inline',
    '.ig-trans-loading',
    '.ig-trans-error',
    '.ig-orig-text',
    '.ig-yt-dual-overlay',
    '.ig-yt-timeline-panel',
    ICON_ELEMENT_SELECTOR,
    HIDDEN_A11Y_SELECTOR
  ].join(',');

  function isIconFontElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.matches(ICON_ELEMENT_SELECTOR)) return true;
    const tag = el.tagName.toLowerCase();
    if (tag === 'i' && (el.textContent || '').trim().length <= 24) return true;
    const style = window.getComputedStyle(el);
    const ff = (style.fontFamily || '').toLowerCase();
    return (
      ff.includes('material icons') ||
      ff.includes('material symbols') ||
      ff.includes('google symbols') ||
      ff.includes('fontawesome') ||
      ff.includes('iconfont') ||
      ff.includes('codicon')
    );
  }

  let activeScanVisibilityCache = null;

  /**
   * Accurately detect screen-reader-only, clipped, 1x1px, transparent, or offscreen elements
   * by inspecting both the element and its ancestor chain up to document.body.
   */
  function isVisuallyHidden(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
    if (el.closest(HIDDEN_A11Y_SELECTOR)) return true;

    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return true;
    if (rect.right <= 0 || rect.left >= window.innerWidth + 50 || rect.bottom + window.scrollY <= 0) {
      return true;
    }

    let curr = el;
    while (curr && curr !== document.body && curr !== document.documentElement) {
      if (curr !== el && activeScanVisibilityCache?.has(curr)) {
        if (activeScanVisibilityCache.get(curr)) return true;
        break;
      }
      if (curr.getAttribute('aria-hidden') === 'true' || curr.hasAttribute('hidden')) {
        if (curr !== el) activeScanVisibilityCache?.set(curr, true);
        return true;
      }
      const clsAndId = `${curr.className || ''} ${curr.id || ''}`;
      if (/visually-hidden|sr-only|screen-reader|a11y|offscreen/i.test(clsAndId)) {
        if (curr !== el) activeScanVisibilityCache?.set(curr, true);
        return true;
      }

      const style = window.getComputedStyle(curr);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        parseFloat(style.opacity) < 0.05 ||
        parseFloat(style.textIndent) < -500
      ) {
        if (curr !== el) activeScanVisibilityCache?.set(curr, true);
        return true;
      }
      // Only check font-size and transparent color on the element itself (and ignore gradient text clip)
      if (curr === el) {
        if (parseFloat(style.fontSize) < 4) return true;
        const bgClip = (style.webkitBackgroundClip || style.backgroundClip || '').toLowerCase();
        if (
          bgClip !== 'text' &&
          (style.color === 'rgba(0, 0, 0, 0)' || style.color === 'transparent')
        ) {
          return true;
        }
      }
      if (style.display !== 'inline' && style.display !== 'contents') {
        const cRect = curr === el ? rect : curr.getBoundingClientRect();
        if (cRect.width < 4 || cRect.height < 4) {
          if (curr !== el) activeScanVisibilityCache?.set(curr, true);
          return true;
        }
      }
      if (style.clip && style.clip !== 'auto' && /0px|1px/.test(style.clip)) {
        if (curr !== el) activeScanVisibilityCache?.set(curr, true);
        return true;
      }
      if (
        style.clipPath &&
        style.clipPath !== 'none' &&
        (style.clipPath.includes('inset(50%)') ||
          style.clipPath.includes('inset(100%)') ||
          style.clipPath.includes('circle(0') ||
          style.clipPath.includes('polygon(0'))
      ) {
        if (curr !== el) activeScanVisibilityCache?.set(curr, true);
        return true;
      }
      if (
        (style.overflow === 'hidden' || style.overflowX === 'hidden' || style.overflowY === 'hidden') &&
        ((curr.clientWidth > 0 && curr.clientWidth < 4) ||
          (curr.clientHeight > 0 && curr.clientHeight < 4))
      ) {
        if (curr !== el) activeScanVisibilityCache?.set(curr, true);
        return true;
      }
      if (curr !== el) activeScanVisibilityCache?.set(curr, false);
      curr = curr.parentElement;
    }
    return false;
  }

  function isMostlyTargetLanguage(text, targetLang) {
    const clean = text.replace(/\s+/g, '');
    if (clean.length < 2) return true;
    const lang = String(targetLang || 'zh-CN').toLowerCase();
    if (lang.startsWith('zh')) {
      const cjkMatches = clean.match(/[\u4e00-\u9fa5]/g);
      const ratio = (cjkMatches ? cjkMatches.length : 0) / clean.length;
      return ratio > 0.6;
    }
    if (lang.startsWith('ja')) {
      const kanaMatches = clean.match(/[\u3040-\u30ff]/g);
      const jaMatches = clean.match(/[\u3040-\u30ff\u4e00-\u9fa5]/g);
      return Boolean(kanaMatches && kanaMatches.length >= 1 && (jaMatches ? jaMatches.length : 0) / clean.length > 0.5);
    }
    if (lang.startsWith('ko')) {
      const koMatches = clean.match(/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/g);
      return (koMatches ? koMatches.length : 0) / clean.length > 0.5;
    }
    if (lang.startsWith('ru')) {
      const ruMatches = clean.match(/[\u0400-\u04ff]/g);
      return (ruMatches ? ruMatches.length : 0) / clean.length > 0.6;
    }
    return false;
  }

  function isNonTranslatableTokenOrMetric(text) {
    const t = text.trim();
    if (t.length < 2 || t.length > 12000) return true;
    // Chart / Data-grid screen-reader keyboard navigation boilerplate
    if (
      /use the arrow keys to navigate|press page up and page down|to save memory, this table is inactive|to view the data grid for|fill table with data/i.test(
        t
      )
    ) {
      return true;
    }
    // Pure numbers, symbols, punctuation, axis values
    if (/^[\d\s.,:/\-+%$€¥#@()[\]~<>|*=•·]+$/.test(t)) return true;
    // Metrics with units (e.g. 40K, 6M, 100%, 24ms, 12px)
    if (/^[+-]?\d+(\.\d+)?\s*(k|m|b|g|tb|gb|mb|kb|ms|s|min|h|hr|d|px|em|rem|%|fps|hz)$/i.test(t)) {
      return true;
    }
    // Timezones and short dates (e.g. UTC-8, Oct 14, 02:00)
    if (/^(UTC|GMT)[+-]?\d*(:?\d{2})?$/i.test(t)) return true;
    if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(,?\s*\d{4})?$/i.test(t)) {
      return true;
    }
    // URLs or emails
    if (/^(https?:\/\/|www\.|\S+@\S+\.\S+)/i.test(t)) return true;
    // Single-word code identifiers / API key names with underscores, dots, slashes, or digits (e.g. dyj_key, KEY_2026, v1beta)
    if (!/\s/.test(t)) {
      if (/[0-9_./:\\-]/.test(t)) return true;
      if (t.length < 3) return true;
    }
    return false;
  }

  function getDirectVisibleText(el) {
    let acc = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        acc += child.nodeValue || '';
      } else if (child.nodeType === Node.ELEMENT_NODE && child.classList?.contains('ig-orig-text')) {
        acc += child.textContent || '';
      }
    }
    return acc.replace(/\s+/g, ' ').trim();
  }

  function hasBlockChildren(el) {
    for (const child of el.children) {
      if (
        child.classList?.contains('ig-trans-node') ||
        child.classList?.contains('ig-trans-loading') ||
        child.classList?.contains('ig-trans-error') ||
        child.classList?.contains('ig-orig-text')
      ) {
        continue;
      }
      const tag = child.tagName.toLowerCase();
      if (BLOCK_CONTAINER_TAGS.has(tag)) {
        // Ignore empty or purely decorative/icon divs that have no text
        if (tag === 'div' && (child.textContent || '').trim().length === 0) {
          continue;
        }
        return true;
      }
      if (
        child.querySelector &&
        child.querySelector(
          'p, div, ul, ol, table, section, article, h1, h2, h3, h4, h5, h6, li, blockquote'
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Determine if an element is a unified prose/heading block that should be evaluated
   * top-down BEFORE inner inline `<span>`/`<a>` leaves.
   */
  function isProseBlock(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.matches(EXPLICIT_PROSE_SELECTOR)) return true;
    const tag = el.tagName.toLowerCase();
    if (PROSE_TAGS.has(tag)) return true;
    if (tag === 'div' && !hasBlockChildren(el)) {
      if (getDirectVisibleText(el).length >= 2) return true;
      if (el.children.length > 0) {
        const allInlineChildren = Array.from(el.children).every((c) =>
          INLINE_CONTENT_TAGS.has(c.tagName.toLowerCase())
        );
        if (allInlineChildren) {
          const style = window.getComputedStyle(el);
          if (style.display === 'block' || style.display === 'inline') {
            return true;
          }
        }
      }
    }
    return false;
  }

  function isElementTranslatable(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.dataset.igStatus) return false;
    if (el.isContentEditable) return false;
    if ((el.textContent || '').trim().length < 2) return false;

    const tag = el.tagName.toLowerCase();
    const isExplicitProse = el.matches(EXPLICIT_PROSE_SELECTOR);

    // Cheap structural checks before ancestor/layout inspection
    if (!isExplicitProse && hasBlockChildren(el)) {
      return false;
    }
    if (isExplicitProse && el.querySelector(EXPLICIT_PROSE_SELECTOR)) {
      return false;
    }
    if (el.closest('[data-ig-status]')) return false;
    if (el.querySelector('[data-ig-status]')) return false;
    if (el.closest(SKIP_ANCESTOR_SELECTOR)) return false;

    // If a heading or list item has no direct text and wraps a single <a> or <button>,
    // let the inner <a> or <button> be translated so link/button styling stays intact.
    if (
      !isExplicitProse &&
      (tag === 'li' || tag === 'td' || tag === 'th' || /^h[1-6]$/.test(tag)) &&
      el.children.length === 1 &&
      getDirectVisibleText(el).length === 0
    ) {
      const onlyChildTag = el.firstElementChild.tagName.toLowerCase();
      if (onlyChildTag === 'a' || onlyChildTag === 'button') {
        return false;
      }
    }

    const isProse = isExplicitProse || isProseBlock(el);

    // For non-prose containers (div, span, td, th, a, button),
    // if it has no direct text of its own and wraps child elements, let the inner leaf element be translated instead!
    if (!isProse && el.children.length > 0) {
      const directText = getDirectVisibleText(el);
      if (directText.length < 2) {
        return false;
      }
    }

    if (isIconFontElement(el) || isVisuallyHidden(el)) return false;

    const text = extractCleanText(el);
    if (isNonTranslatableTokenOrMetric(text)) return false;
    if (isMostlyTargetLanguage(text, settings.targetLang)) return false;

    return true;
  }

  /**
   * Walk live DOM to extract ONLY visible, non-icon text (preventing .cdk-visually-hidden
   * chart descriptions and <mat-icon>info</mat-icon> ligatures from polluting translation).
   */
  function extractCleanText(el) {
    const parts = [];
    function walk(node) {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.nodeValue || '');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      if (tag === 'br') {
        parts.push('\n');
        return;
      }
      if (
        tag === 'script' ||
        tag === 'style' ||
        tag === 'noscript' ||
        node.classList.contains('ig-trans-node') ||
        node.classList.contains('ig-trans-block') ||
        node.classList.contains('ig-trans-inline') ||
        node.classList.contains('ig-trans-loading') ||
        node.classList.contains('ig-trans-error')
      ) {
        return;
      }
      if (node !== el && (isIconFontElement(node) || isVisuallyHidden(node))) {
        return;
      }
      for (const child of node.childNodes) {
        walk(child);
      }
    }
    walk(el);
    return parts
      .join(' ')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n\n')
      .trim();
  }

  function safeOriginalLinkHref(href) {
    if (!href) return null;
    try {
      const url = new URL(href, document.baseURI);
      return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }

  const translatedLinkSources = new WeakMap();
  function sourceLinks(root) {
    return Array.from(root.querySelectorAll('a')).filter(link => !link.closest('.ig-trans-node, .ig-trans-block, .ig-trans-inline'));
  }
  function syncTranslatedLinks(root) {
    const originals = sourceLinks(root);
    for (const link of root.querySelectorAll('.ig-trans-node a, .ig-trans-block a, .ig-trans-inline a')) {
      const record = translatedLinkSources.get(link);
      if (!record || record.root !== root) continue;
      const original = originals[record.index];
      if (original && (original.textContent || '').trim() === record.text) original.setAttribute('data-ig-orig-inline', '1');
      const href = original && (original.textContent || '').trim() === record.text
        ? safeOriginalLinkHref(original.getAttribute('href')) : null;
      const attributes = { href, title: original?.getAttribute('title') || null,
        target: href && original?.getAttribute('target') === '_blank' ? '_blank' : null,
        rel: href && original?.getAttribute('target') === '_blank' ? 'noopener noreferrer' : null };
      for (const [name, value] of Object.entries(attributes)) {
        if (link.getAttribute(name) === value) continue;
        if (value === null) link.removeAttribute(name); else link.setAttribute(name, value);
      }
    }
  }

  // Link labels are preserved verbatim; the model may reorder tokens, never author URLs.
  function originalLinkPlaceholder(node, root) {
    if (node === root || node.tagName?.toLowerCase() !== 'a') return null;
    const href = safeOriginalLinkHref(node.getAttribute('href'));
    const text = (node.textContent || '').trim();
    if (!href || !text) return null;
    return { type: 'link', text, href, root, index: sourceLinks(root).indexOf(node), title: node.getAttribute('title') || '',
      target: node.getAttribute('target') === '_blank' ? '_blank' : '' };
  }

  /**
   * Protect inline `<code>`, `<kbd>`, `<math>`, `.katex` elements with `{{0}}` tokens
   * while skipping visually-hidden and icon-font children in the live DOM.
   */
  function extractTextWithPlaceholders(el) {
    const placeholders = [];
    const parts = [];
    const PROTECTED_TAGS = new Set(['code', 'kbd', 'samp', 'var', 'math']);

    function walk(node) {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.nodeValue || '');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      if (tag === 'br') {
        parts.push('\n');
        return;
      }
      if (
        tag === 'script' ||
        tag === 'style' ||
        tag === 'noscript' ||
        node.classList.contains('ig-trans-node') ||
        node.classList.contains('ig-trans-block') ||
        node.classList.contains('ig-trans-inline') ||
        node.classList.contains('ig-trans-loading') ||
        node.classList.contains('ig-trans-error')
      ) {
        return;
      }
      if (node !== el && (isIconFontElement(node) || isVisuallyHidden(node))) {
        return;
      }

      const link = originalLinkPlaceholder(node, el);
      if (link) {
        const idx = placeholders.length;
        placeholders.push(link);
        parts.push(` {{${idx}}} `);
        return;
      }

      if (
        PROTECTED_TAGS.has(tag) ||
        node.classList.contains('katex') ||
        node.classList.contains('MathJax')
      ) {
        const txt = (node.textContent || '').trim();
        if (txt && txt.length <= 80) {
          const idx = placeholders.length;
          placeholders.push(txt);
          parts.push(` {{${idx}}} `);
          return;
        }
      }

      for (const child of node.childNodes) {
        walk(child);
      }
    }

    walk(el);
    const text = parts
      .join('')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text, placeholders };
  }

  /**
   * Wrap original visible TEXT_NODEs inside `el` with `<font class="notranslate ig-orig-text">`
   * so that `html[data-ig-style="translation-only"]` can hide original text purely via CSS
   * without disturbing child elements, icons, or flex/grid layouts.
   */
  function wrapOriginalTextNodes(el, sourceNodes = null) {
    if (!el) return;
    const textNodes = [];
    const protectedInlines = [];
    const PROTECTED_TAGS = new Set(['code', 'kbd', 'samp', 'var', 'math']);

    function collect(node) {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        if ((node.nodeValue || '').length > 0) {
          textNodes.push(node);
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      if (
        tag === 'script' ||
        tag === 'style' ||
        tag === 'noscript' ||
        node.classList.contains('ig-trans-node') ||
        node.classList.contains('ig-trans-block') ||
        node.classList.contains('ig-trans-inline') ||
        node.classList.contains('ig-trans-loading') ||
        node.classList.contains('ig-trans-error') ||
        node.classList.contains('ig-orig-text')
      ) {
        return;
      }
      if (node !== el && (isIconFontElement(node) || isVisuallyHidden(node))) {
        return;
      }
      if (originalLinkPlaceholder(node, el)) {
        protectedInlines.push(node);
        return;
      }
      if (
        PROTECTED_TAGS.has(tag) ||
        node.classList.contains('katex') ||
        node.classList.contains('MathJax')
      ) {
        const txt = (node.textContent || '').trim();
        if (txt && txt.length <= 80) {
          protectedInlines.push(node);
          return;
        }
      }
      for (const child of node.childNodes) {
        collect(child);
      }
    }

    if (sourceNodes) {
      for (const node of sourceNodes) if (el.contains(node)) collect(node);
    } else {
      collect(el);
    }
    for (const pNode of protectedInlines) {
      pNode.setAttribute('data-ig-orig-inline', '1');
    }
    for (const tNode of textNodes) {
      if (!tNode.parentNode) continue;
      if (
        tNode.parentNode.nodeType === Node.ELEMENT_NODE &&
        tNode.parentNode.classList?.contains('ig-orig-text')
      ) {
        continue;
      }
      const wrapper = document.createElement('font');
      wrapper.className = 'notranslate ig-orig-text';
      wrapper.setAttribute('translate', 'no');
      tNode.parentNode.replaceChild(wrapper, tNode);
      wrapper.appendChild(tNode);
    }
  }

  function unwrapOriginalTextNodes(el) {
    if (!el) return;
    el.querySelectorAll('[data-ig-orig-inline]').forEach((n) => {
      n.removeAttribute('data-ig-orig-inline');
    });
    el.querySelectorAll('font.ig-orig-text, font.ig-orig-newline').forEach((wrapper) => {
      const parent = wrapper.parentNode;
      if (!parent) return;
      while (wrapper.firstChild) {
        delete wrapper.firstChild.__igIsParaBreak;
        parent.insertBefore(wrapper.firstChild, wrapper);
      }
      wrapper.remove();
    });
    // Merge only text nodes that were split by extractParagraphSegmentsFromElement (__igSplitFromPrev),
    // preserving adjacent text node boundaries owned by host frameworks (React/Vue).
    function mergeSplitTextNodes(node) {
      if (!node || !node.childNodes) return;
      let child = node.firstChild;
      while (child) {
        const next = child.nextSibling;
        if (child.nodeType === 3) {
          delete child.__igIsParaBreak;
          if (child.__igSplitFromPrev && child.previousSibling && child.previousSibling.nodeType === 3) {
            child.previousSibling.nodeValue = (child.previousSibling.nodeValue || '') + (child.nodeValue || '');
            delete child.__igSplitFromPrev;
            child.remove();
          } else {
            delete child.__igSplitFromPrev;
          }
        } else if (child.nodeType === 1) {
          mergeSplitTextNodes(child);
        }
        child = next;
      }
    }
    mergeSplitTextNodes(el);
  }

  function restorePlaceholdersToFragment(translatedText, placeholders) {
    const fragment = document.createDocumentFragment();
    if (!placeholders || placeholders.length === 0) {
      fragment.appendChild(document.createTextNode(translatedText));
      return fragment;
    }

    const parts = String(translatedText).split(/(\{\{\d+\}\})/g);
    for (const part of parts) {
      const m = part.match(/^\{\{(\d+)\}\}$/);
      if (m) {
        const idx = Number(m[1]);
        const codeText = placeholders[idx];
        if (codeText && typeof codeText === 'object' && codeText.type === 'link') {
          const href = safeOriginalLinkHref(codeText.href);
          if (href) {
            const link = document.createElement('a');
            translatedLinkSources.set(link, codeText);
            if (codeText.root && !isPageTranslated) {
              ensureObservers();
              domMutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'target', 'title'] });
            }
            link.href = href;
            link.textContent = codeText.text;
            if (codeText.title) link.title = codeText.title;
            if (codeText.target === '_blank') {
              link.target = '_blank';
              link.rel = 'noopener noreferrer';
            }
            fragment.appendChild(link);
          } else {
            fragment.appendChild(document.createTextNode(codeText.text));
          }
          continue;
        }
        if (codeText !== undefined) {
          const codeEl = document.createElement('code');
          codeEl.textContent = codeText;
          codeEl.style.cssText =
            'padding: 1px 5px; border-radius: 4px; background: rgba(148,163,184,0.18); font-family: ui-monospace, monospace; font-size: 0.9em;';
          fragment.appendChild(codeEl);
          continue;
        }
      }
      if (part) {
        fragment.appendChild(document.createTextNode(part));
      }
    }
    return fragment;
  }

  /**
   * Decide whether a translated element should use Inline Mode (side-by-side on the same line,
   * preserving flex/grid/header/sidebar/legend layout) vs Block Mode (new line below prose paragraphs & headings).
   */
  function shouldUseInlineMode(el, text) {
    if (el.matches(EXPLICIT_PROSE_SELECTOR)) {
      return false;
    }
    const tag = el.tagName.toLowerCase();
    if (
      tag === 'span' ||
      tag === 'a' ||
      tag === 'button' ||
      tag === 'label' ||
      tag === 'th' ||
      tag === 'dt' ||
      tag === 'summary'
    ) {
      return true;
    }

    if (
      el.closest(
        'nav, aside, thead, [role="navigation"], [role="menu"], [role="menubar"], [role="tablist"], [role="toolbar"], [class*="sidebar"], [class*="navbar"], [class*="menubar"], [class*="legend"], [class*="toolbar"]'
      )
    ) {
      return true;
    }

    // If a heading contains an inline action button/icon (e.g. Google Cloud Console card titles), keep inline
    if (/^h[1-6]$/.test(tag) && el.querySelector('button, mat-icon, svg')) {
      return true;
    }

    const style = window.getComputedStyle(el);
    if (
      style.display === 'inline' ||
      style.display === 'inline-block' ||
      style.display === 'flex' ||
      style.display === 'inline-flex' ||
      style.display === 'grid' ||
      style.display === 'inline-grid' ||
      style.whiteSpace === 'nowrap'
    ) {
      return true;
    }

    if (el.parentElement) {
      const pStyle = window.getComputedStyle(el.parentElement);
      if (
        (pStyle.display === 'flex' || pStyle.display === 'inline-flex') &&
        pStyle.flexDirection === 'row' &&
        text.length <= 50
      ) {
        return true;
      }
    }

    if (!PROSE_TAGS.has(tag)) {
      const rect = el.getBoundingClientRect();
      if (text.length <= 50 && rect.height > 0 && rect.height <= 36) {
        return true;
      }
    }

    return false;
  }

  function insertNodeInElementCleanly(el, nodeToInsert) {
    // If el has trailing icon/button children (like <h2>Generate content & Live API <button><mat-icon>info</mat-icon></button></h2>),
    // insert right before the trailing icon/button so it is not separated.
    let lastTextNode = null;
    for (const child of el.childNodes) {
      if (
        (child.nodeType === Node.TEXT_NODE && (child.nodeValue || '').trim().length > 0) ||
        (child.nodeType === Node.ELEMENT_NODE && child.classList?.contains('ig-orig-text'))
      ) {
        lastTextNode = child;
      }
    }
    if (lastTextNode && lastTextNode.nextSibling) {
      let hasRemainingTextSibling = false;
      let sib = lastTextNode.nextSibling;
      while (sib) {
        if (
          sib.nodeType === Node.ELEMENT_NODE &&
          !sib.classList?.contains('ig-trans-node') &&
          !sib.classList?.contains('ig-trans-loading') &&
          !sib.classList?.contains('ig-trans-error') &&
          !isIconFontElement(sib) &&
          sib.tagName.toLowerCase() !== 'button'
        ) {
          hasRemainingTextSibling = true;
          break;
        }
        sib = sib.nextSibling;
      }
      if (!hasRemainingTextSibling) {
        el.insertBefore(nodeToInsert, lastTextNode.nextSibling);
        return;
      }
    }
    el.appendChild(nodeToInsert);
  }

  // ============================================================================
  // 3. Viewport Lazy Translation Queue & Batch DOM Rendering
  // ============================================================================

  let scrollRescanTimer = null;
  let postEnableTimers = [];
  const pendingScanRoots = new Set();
  let mutationScanTimer = null;

  function pruneDetachedParagraphs() {
    const detached = new Set();
    for (const [id, record] of blockMap) {
      if (record.element.isConnected === false) {
        blockMap.delete(id);
        detached.add(record.element);
      }
    }
    for (const el of detached) resetElementTranslationState(el);
    pendingParagraphQueue = pendingParagraphQueue.filter(item => blockMap.has(item.id));
    if (!pendingParagraphQueue.length && flushQueueTimer) {
      clearTimeout(flushQueueTimer);
      flushQueueTimer = null;
    }
  }

  function releaseDetachedContent(root) {
    if (root.nodeType !== Node.ELEMENT_NODE || root.isConnected !== false) return;
    const elements = [root, ...root.querySelectorAll('[data-ig-status], img, [data-ig-cleanup-session]')];
    for (const el of elements) {
      if (el.isConnected !== false) continue;
      viewportObserver?.unobserve(el);
      if (el.dataset.igStatus || el.dataset.igCleanupSession) resetElementTranslationState(el);
      if (el.tagName?.toLowerCase() === 'img') {
        releaseImageControls(imageControlBars.get(el));
        delete el.dataset.igHoverBound;
      }
      if (el.dataset.igImgStatus) {
        imageTranslationTasks.delete(el);
        delete el.dataset.igImgStatus;
      }
    }
    if (hoveredElement?.isConnected === false) hoveredElement = null;
    if (lastContextMenuImage?.isConnected === false) lastContextMenuImage = null;
  }

  function scheduleMutationScan(roots) {
    for (const root of pendingScanRoots) if (root.isConnected === false) pendingScanRoots.delete(root);
    for (const root of roots) if (root.isConnected !== false) pendingScanRoots.add(root);
    if (pendingScanRoots.size > 100) {
      pendingScanRoots.clear();
      pendingScanRoots.add(document.body);
    }
    if (!pendingScanRoots.size || mutationScanTimer) return;
    mutationScanTimer = setTimeout(() => {
      mutationScanTimer = null;
      const roots = [...pendingScanRoots];
      pendingScanRoots.clear();
      if (!isPageTranslated) return;
      for (const root of roots) if (root.isConnected !== false) scanAndObserveContainer(root);
    }, 50);
  }

  // Compare source DOM independently of translation-only CSS and our text wrappers.
  // Translated output/spinners never contribute, so our own rendering is not an edit.
  function originalParagraphSignature(root) {
    const parts = [];
    const walk = node => {
      if (node.nodeType === Node.TEXT_NODE) { parts.push(node.nodeValue || ''); return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.matches('script, style, noscript, .ig-trans-node, .ig-trans-block, .ig-trans-inline, .ig-trans-loading, .ig-trans-error')) return;
      if (node !== root && (node.hidden || node.getAttribute('aria-hidden') === 'true')) return;
      if (node.tagName === 'BR') { parts.push('\n'); return; }
      for (const child of node.childNodes) walk(child);
    };
    walk(root);
    return parts.join('').replace(/\s+/g, ' ').trim();
  }

  function invalidateChangedParagraph(el) {
    const previous = paragraphSourceSignatures.get(el);
    if (previous === undefined || previous === originalParagraphSignature(el)) return false;
    // In-flight batches may contain other paragraphs. Retire only this element's
    // records; their late replies can no longer write into the changed source.
    for (const [id, record] of blockMap) if (record.element === el) blockMap.delete(id);
    pendingParagraphQueue = pendingParagraphQueue.filter(item => blockMap.has(item.id));
    viewportObserver?.unobserve(el);
    resetElementTranslationState(el);
    if (el.isConnected) scheduleMutationScan([el]);
    return true;
  }

  function handleScrollRescan() {
    if (!isPageTranslated || scrollRescanTimer) return;
    scrollRescanTimer = setTimeout(() => {
      scrollRescanTimer = null;
      if (isPageTranslated) {
        scanAndObserveContainer(document.body);
      }
    }, 350);
  }

  function ensureObservers() {
    if (!viewportObserver) {
      viewportObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const el = entry.target;
            viewportObserver.unobserve(el);
            if (el.isConnected === false) continue;
            if (el.tagName && el.tagName.toLowerCase() === 'img') {
              if (
                isPageTranslated &&
                settings.enableImageTranslate !== false &&
                settings.autoTranslatePageImages !== false &&
                el.dataset.igImgStatus === 'observed'
              ) {
                translateImageElement(el, { isAuto: true });
              }
              continue;
            }
            if (isPageTranslated && el.dataset.igStatus === 'observed') {
              queueParagraphForTranslation(el);
            }
          }
        },
        { rootMargin: '550px 0px 550px 0px', threshold: 0.01 }
      );
    }

    if (!domMutationObserver) {
      domMutationObserver = new MutationObserver((mutations) => {
        if (!isPageTranslated) {
          // Manual Alt translations need link updates, without enabling page scanning.
          const roots = new Set(mutations.map(m => m.target.closest?.('[data-ig-status]')).filter(Boolean));
          for (const root of roots) syncTranslatedLinks(root);
          return;
        }
        const addedRoots = [];
        const changedParagraphs = new Set();
        let removed = false;
        for (const m of mutations) {
          const target = m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement;
          const owner = target?.closest('[data-ig-status]');
          if (owner) changedParagraphs.add(owner);
          for (const node of m.removedNodes || []) {
            if (node.nodeType === Node.ELEMENT_NODE && node.isConnected === false) {
              releaseDetachedContent(node);
              removed = true;
            }
          }
          for (const node of m.addedNodes || []) {
            if (
              node.nodeType === Node.ELEMENT_NODE &&
              !node.classList?.contains('ig-trans-node') &&
              !node.classList?.contains('ig-trans-block') &&
              !node.classList?.contains('ig-trans-inline') &&
              !node.classList?.contains('ig-trans-loading') &&
              !node.classList?.contains('ig-trans-error') &&
              !node.classList?.contains('ig-orig-text') &&
              !node.classList?.contains('ig-img-overlay-layer') &&
              !node.classList?.contains('ig-img-control-bar') &&
              !node.classList?.contains('ig-img-bilingual-drawer')
            ) {
              addedRoots.push(node);
            }
          }
        }
        for (const el of changedParagraphs) {
          if (!invalidateChangedParagraph(el)) syncTranslatedLinks(el);
        }
        if (removed) pruneDetachedParagraphs();
        scheduleMutationScan(addedRoots);
      });
    }
  }

  function scanAndObserveContainer(root = document.body) {
    if (!root || root.isConnected === false || !viewportObserver) return;
    const rawCandidates = [];
    if (root.matches && root.matches(BLOCK_SELECTOR)) {
      rawCandidates.push(root);
    }
    if (root.querySelectorAll) {
      root.querySelectorAll(BLOCK_SELECTOR).forEach((el) => rawCandidates.push(el));
    }

    // Process prose & heading blocks first (top-down) so inline formatting tags inside paragraphs,
    // tweets, list items, and headings stay unified; then process innermost UI leaf elements.
    const proseList = [];
    const uiLeaves = [];
    for (const el of rawCandidates) {
      if (isProseBlock(el)) {
        proseList.push(el);
      } else {
        uiLeaves.push(el);
      }
    }
    uiLeaves.reverse();

    activeScanVisibilityCache = typeof WeakMap === 'function' ? new WeakMap() : null;
    try {
      for (const el of [...proseList, ...uiLeaves]) {
        // A new observation owns the element before any old cleanup frame can run.
        if (el.dataset.igCleanupSession) resetElementTranslationState(el);
        if (isElementTranslatable(el)) {
          el.dataset.igStatus = 'observed';
          viewportObserver.observe(el);
        }
      }
    } finally {
      activeScanVisibilityCache = null;
    }

    // Scan content images (e.g. X.com [data-testid="tweetPhoto"] img, article figures, diagrams)
    if (settings.enableImageTranslate !== false) {
      scanAndObserveImagesInContainer(root);
    }
  }

  /**
   * Splits multi-paragraph containers (especially X.com [data-testid="tweetText"] long posts
   * that use "\n\n", "\n1. ...", or <br> inside a single container) into per-paragraph segments,
   * each anchored to the exact DOM node at the end of that paragraph.
   */
  function extractParagraphSegmentsFromElement(el) {
    const PROTECTED_TAGS = new Set(['code', 'kbd', 'samp', 'var', 'math']);
    const isTweetOrPreWrap =
      el.matches?.('[data-testid="tweetText"], [data-testid="twitterArticleRichTextView"]') ||
      window.getComputedStyle(el).whiteSpace?.includes('pre');

    // Pass 1: Split TEXT_NODEs containing paragraph breaks (\n\n, or \n in pre-wrap/tweet containers)
    const rawTextNodes = [];
    function collectRawTextNodes(node) {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        if ((node.nodeValue || '').includes('\n') && !node.__igIsParaBreak) {
          rawTextNodes.push(node);
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      if (
        tag === 'script' ||
        tag === 'style' ||
        tag === 'noscript' ||
        (node !== el && originalLinkPlaceholder(node, el)) ||
        PROTECTED_TAGS.has(tag) ||
        node.classList.contains('katex') ||
        node.classList.contains('MathJax') ||
        node.classList.contains('ig-trans-node') ||
        node.classList.contains('ig-trans-block') ||
        node.classList.contains('ig-trans-inline') ||
        node.classList.contains('ig-trans-loading') ||
        node.classList.contains('ig-trans-error') ||
        node.classList.contains('ig-orig-newline')
      ) {
        return;
      }
      if (node !== el && (isIconFontElement(node) || isVisuallyHidden(node))) {
        return;
      }
      for (const child of node.childNodes) {
        collectRawTextNodes(child);
      }
    }

    collectRawTextNodes(el);

    for (const initialNode of rawTextNodes) {
      let current = initialNode;
      while (current && current.nodeValue) {
        const val = current.nodeValue;
        // Match either double-newline (\n\s*\n+) or single newline in tweet/pre-wrap containers
        const breakRegex = isTweetOrPreWrap ? /\n[ \t\r\n]*/g : /\n[ \t\r]*\n[ \t\r\n]*/g;
        const m = breakRegex.exec(val);
        if (!m) break;

        const matchIndex = m.index;
        const matchLen = m[0].length;

        if (matchIndex === 0) {
          if (matchLen < val.length) {
            const afterNode = current.splitText(matchLen);
            afterNode.__igSplitFromPrev = true;
            current.__igIsParaBreak = true;
            current = afterNode;
            continue;
          } else {
            current.__igIsParaBreak = true;
            break;
          }
        } else {
          const breakAndAfter = current.splitText(matchIndex);
          breakAndAfter.__igSplitFromPrev = true;
          if (matchLen < breakAndAfter.nodeValue.length) {
            const afterNode = breakAndAfter.splitText(matchLen);
            afterNode.__igSplitFromPrev = true;
            breakAndAfter.__igIsParaBreak = true;
            current = afterNode;
            continue;
          } else {
            breakAndAfter.__igIsParaBreak = true;
            break;
          }
        }
      }
    }

    // Pass 2: Walk DOM in order and group into paragraph segments separated by <br> or __igIsParaBreak
    const segments = [];
    let curr = {
      parts: [],
      placeholders: [],
      sourceNodes: [],
      anchorNode: null,
      breakNode: null
    };

    function flushSegment(breakNode = null) {
      const text = curr.parts
        .join('')
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .trim();
      if (text.length > 0) {
        segments.push({
          text,
          placeholders: curr.placeholders,
          sourceNodes: curr.sourceNodes,
          anchorNode: curr.anchorNode,
          breakNode: breakNode || curr.breakNode
        });
      }
      curr = {
        parts: [],
        placeholders: [],
        sourceNodes: [],
        anchorNode: null,
        breakNode: null
      };
    }

    function walkSegments(node) {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const val = node.nodeValue || '';
        if (node.__igIsParaBreak || /^\s*\n+\s*$/.test(val)) {
          flushSegment(node);
          return;
        }
        curr.sourceNodes.push(node);
        if (val.trim().length > 0) {
          curr.parts.push(val);
          curr.anchorNode = node;
        } else if (val.length > 0) {
          curr.parts.push(' ');
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      if (tag === 'br') {
        flushSegment(node);
        return;
      }
      if (
        tag === 'script' ||
        tag === 'style' ||
        tag === 'noscript' ||
        node.classList.contains('ig-trans-node') ||
        node.classList.contains('ig-trans-block') ||
        node.classList.contains('ig-trans-inline') ||
        node.classList.contains('ig-trans-loading') ||
        node.classList.contains('ig-trans-error') ||
        node.classList.contains('ig-orig-newline')
      ) {
        return;
      }
      if (node !== el && (isIconFontElement(node) || isVisuallyHidden(node))) {
        return;
      }

      const link = originalLinkPlaceholder(node, el);
      if (link) {
        const idx = curr.placeholders.length;
        curr.placeholders.push(link);
        curr.parts.push(` {{${idx}}} `);
        curr.sourceNodes.push(node);
        curr.anchorNode = node;
        return;
      }

      if (
        PROTECTED_TAGS.has(tag) ||
        node.classList.contains('katex') ||
        node.classList.contains('MathJax')
      ) {
        const txt = (node.textContent || '').trim();
        if (txt && txt.length <= 80) {
          const idx = curr.placeholders.length;
          curr.placeholders.push(txt);
          curr.sourceNodes.push(node);
          curr.parts.push(` {{${idx}}} `);
          curr.anchorNode = node;
          return;
        }
      }

      for (const child of node.childNodes) {
        walkSegments(child);
      }
    }

    walkSegments(el);
    flushSegment(null);

    if (segments.length <= 1) {
      const single = extractTextWithPlaceholders(el);
      return [
        {
          text: single.text,
          placeholders: single.placeholders,
          anchorNode: null,
          breakNode: null,
          isMultiSeg: false
        }
      ];
    }

    return segments.map((s) => ({
      ...s,
      isMultiSeg: true
    }));
  }

  function insertNodeAfterSegmentAnchor(el, record, nodeToInsert) {
    if (!record.isMultiSeg || !record.anchorNode || !el.contains(record.anchorNode)) {
      insertNodeInElementCleanly(el, nodeToInsert);
      return;
    }

    let targetAnchor = record.anchorNode;
    if (
      targetAnchor.parentElement &&
      targetAnchor.parentElement !== el &&
      targetAnchor.parentElement.classList?.contains('ig-orig-text')
    ) {
      targetAnchor = targetAnchor.parentElement;
    }

    if (targetAnchor.parentNode) {
      targetAnchor.parentNode.insertBefore(nodeToInsert, targetAnchor.nextSibling);
    } else {
      insertNodeInElementCleanly(el, nodeToInsert);
    }
  }

  function resetElementTranslationState(el) {
    if (!el) return;
    el.querySelectorAll(
      '.ig-trans-node, .ig-trans-block, .ig-trans-inline, .ig-trans-loading, .ig-trans-error'
    ).forEach((n) => n.remove());
    unwrapOriginalTextNodes(el);
    delete el.dataset.igStatus;
    delete el.dataset.igBlockId;
    delete el.dataset.igCleanupSession;
    paragraphSourceSignatures.delete(el);
  }

  function queueParagraphForTranslation(el) {
    if (!el || el.isConnected === false || el.dataset.igStatus === 'queued' || el.dataset.igStatus === 'done') return;
    if (el.dataset.igCleanupSession) {
      resetElementTranslationState(el);
    }
    if (
      el.isContentEditable ||
      el.closest?.(SKIP_ANCESTOR_SELECTOR) ||
      (!el.matches?.(EXPLICIT_PROSE_SELECTOR) && hasBlockChildren(el)) ||
      el.querySelector?.('[data-ig-status]') ||
      isVisuallyHidden(el)
    ) {
      delete el.dataset.igStatus;
      return;
    }

    const segments = extractParagraphSegmentsFromElement(el);
    const validSegments = segments.filter(
      (seg) =>
        !isNonTranslatableTokenOrMetric(seg.text) &&
        !isMostlyTargetLanguage(seg.text, settings.targetLang)
    );

    if (validSegments.length === 0) {
      delete el.dataset.igStatus;
      return;
    }

    el.dataset.igStatus = 'queued';
    const sourceSignature = originalParagraphSignature(el);
    paragraphSourceSignatures.set(el, sourceSignature);

    for (const seg of validSegments) {
      const id = blockIdCounter++;
      if (!el.dataset.igBlockId) {
        el.dataset.igBlockId = String(id);
      }

      // Zero-layout-shift inline spinner anchored to each paragraph segment
      const loadingEl = document.createElement('font');
      loadingEl.className = 'notranslate ig-trans-loading';
      loadingEl.dataset.igSegId = String(id);
      loadingEl.setAttribute('translate', 'no');
      insertNodeAfterSegmentAnchor(el, seg, loadingEl);

      blockMap.set(id, {
        element: el,
        text: seg.text,
        sourceSignature,
        placeholders: seg.placeholders,
        sourceNodes: seg.sourceNodes,
        anchorNode: seg.anchorNode,
        breakNode: seg.breakNode,
        isMultiSeg: seg.isMultiSeg
      });
      pendingParagraphQueue.push({ id, text: seg.text });
    }

    if (flushQueueTimer) clearTimeout(flushQueueTimer);
    if (pendingParagraphQueue.length >= (settings.batchMaxItems || 10)) {
      flushTranslationQueue();
    } else {
      flushQueueTimer = setTimeout(flushTranslationQueue, 75);
    }
  }

  async function flushTranslationQueue() {
    pruneDetachedParagraphs();
    if (flushQueueTimer) {
      clearTimeout(flushQueueTimer);
      flushQueueTimer = null;
    }
    if (pendingParagraphQueue.length === 0) return;

    const maxItems = Number(settings.batchMaxItems) || 10;
    const maxChars = Number(settings.batchMaxChars) || 2200;

    const batch = [];
    let charCount = 0;
    while (pendingParagraphQueue.length > 0 && batch.length < maxItems) {
      const next = pendingParagraphQueue[0];
      if (batch.length > 0 && charCount + next.text.length > maxChars) break;
      batch.push(pendingParagraphQueue.shift());
      charCount += next.text.length;
    }

    if (pendingParagraphQueue.length > 0) {
      flushQueueTimer = setTimeout(flushTranslationQueue, 50);
    }

    const signal = pageRequests.signal;
    try {
      const response = await sendModelRequest({
        type: 'TRANSLATE_BATCH',
        payload: {
          items: batch,
          targetLang: settings.targetLang,
          pageTitle: document.title
        }
      });

      if (signal.aborted || response?.cancelled) return;
      if (!response || !response.ok) {
        throw new Error(response?.error || '翻译请求失败');
      }

      const results = response.data?.translations || [];
      await renderBatchResultsWithRAF(results, signal);
    } catch (err) {
      if (!signal.aborted) await renderBatchErrorWithRAF(batch, err?.message || '翻译出错', signal);
    }
  }

  function normalizeForComparison(str) {
    return String(str || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * Batch DOM updates inside requestAnimationFrame per Chrome Extensions performance rules.
   * Uses <font class="notranslate ig-trans-node"> without reparenting host DOM children,
   * and wraps original text nodes in <font class="notranslate ig-orig-text"> so translation-only
   * mode can hide original text cleanly via CSS.
   */
  async function renderBatchResultsWithRAF(results, signal) {
    const updateStatus = el => {
      el.dataset.igStatus = el.querySelectorAll('.ig-trans-loading').length ? 'queued'
        : el.querySelectorAll('.ig-trans-error').length ? 'error' : 'done';
    };
    const CHUNK = 18;
    for (let i = 0; i < results.length; i += CHUNK) {
      const slice = results.slice(i, i + CHUNK);
      await new Promise((resolve) =>
        requestAnimationFrame(() => {
          if (signal?.aborted) { resolve(); return; }
          for (const item of slice) {
            const segId = Number(item.id);
            const record = blockMap.get(segId);
            blockMap.delete(segId);
            if (!record || !record.element) continue;
            const el = record.element;
            if (el.isConnected === false) continue;
            if (record.sourceSignature !== undefined && record.sourceSignature !== originalParagraphSignature(el)) {
              invalidateChangedParagraph(el);
              continue;
            }

            if (record.isMultiSeg) {
              el.querySelectorAll(`[data-ig-seg-id="${segId}"]`).forEach((n) => n.remove());
            } else {
              el.querySelectorAll(
                '.ig-trans-loading, .ig-trans-error, .ig-trans-node, .ig-trans-block, .ig-trans-inline'
              ).forEach((n) => n.remove());
            }

            const translatedStr = String(item.translation || '').trim();
            // Skip inserting redundant translation if identical to original source text
            if (
              !translatedStr ||
              normalizeForComparison(translatedStr) === normalizeForComparison(record.text)
            ) {
              updateStatus(el);
              continue;
            }

            wrapOriginalTextNodes(el, record.sourceNodes);

            const isInline = record.isMultiSeg ? false : shouldUseInlineMode(el, record.text);
            const transNode = document.createElement('font');
            transNode.className = `notranslate ig-trans-node ${
              isInline ? 'ig-trans-inline' : 'ig-trans-block'
            }`;
            transNode.dataset.igSegId = String(segId);
            transNode.setAttribute('translate', 'no');
            transNode.setAttribute('dir', 'auto');
            if (typeof settings !== 'undefined' && settings?.targetLang) {
              transNode.setAttribute('lang', settings.targetLang);
            }
            // Keep paragraph layout outside the inline text fragments so marker
            // backgrounds can follow each wrapped line instead of the whole block.
            const transText = document.createElement('font');
            transText.className = 'ig-trans-text';
            transText.appendChild(
              restorePlaceholdersToFragment(translatedStr, record.placeholders)
            );
            transNode.appendChild(transText);
            insertNodeAfterSegmentAnchor(el, record, transNode);
            updateStatus(el);
            totalTranslatedCount++;
          }
          updateFloatingBallStatus();
          resolve();
        })
      );
    }
  }

  async function renderBatchErrorWithRAF(batch, errorMessage, signal) {
    await new Promise((resolve) =>
      requestAnimationFrame(() => {
        if (signal?.aborted) { resolve(); return; }
        for (const item of batch) {
          const segId = Number(item.id);
          const record = blockMap.get(segId);
          blockMap.delete(segId);
          if (!record || !record.element) continue;
          const el = record.element;
          if (el.isConnected === false) continue;
          if (record.sourceSignature !== undefined && record.sourceSignature !== originalParagraphSignature(el)) {
            invalidateChangedParagraph(el);
            continue;
          }
          if (record.isMultiSeg) {
            el.querySelectorAll(`.ig-trans-loading[data-ig-seg-id="${segId}"]`).forEach((n) => n.remove());
          } else {
            el.querySelectorAll('.ig-trans-loading').forEach((n) => n.remove());
          }

          const errBadge = document.createElement('font');
          errBadge.className = 'notranslate ig-trans-error';
          errBadge.dataset.igSegId = String(segId);
          errBadge.setAttribute('translate', 'no');
          errBadge.textContent = '⚠️ 重试';
          errBadge.title = `${errorMessage} (点击重新翻译)`;
          errBadge.addEventListener('click', (e) => {
            e.preventDefault?.();
            e.stopPropagation();
            errBadge.remove();
            for (const [id, rec] of blockMap) {
              if (rec.element === el) blockMap.delete(id);
            }
            if (pendingParagraphQueue.length > 0) {
              pendingParagraphQueue = pendingParagraphQueue.filter((it) => blockMap.has(it.id));
            }
            resetElementTranslationState(el);
            queueParagraphForTranslation(el);
          });
          insertNodeAfterSegmentAnchor(el, record, errBadge);
          el.dataset.igStatus = el.querySelectorAll('.ig-trans-loading').length ? 'queued' : 'error';
        }
        resolve();
      })
    );
    if (errorMessage.includes('API Key')) {
      showPageToast('请先在插件设置中填入您的 AI API Key', 'warn', true);
    }
  }

  function isOnlinePdfPage() {
    if (document.contentType === 'application/pdf') return true;
    const href = window.location.href;
    if (/^https?:\/\/(export\.)?arxiv\.org\/pdf\//i.test(href)) return true;
    if (/^https?:\/\/openreview\.net\/pdf\b/i.test(href)) return true;
    if (/\.pdf($|\?|#)/i.test(window.location.pathname + window.location.search)) return true;
    if (
      document.querySelector('embed[type="application/pdf"]') &&
      document.body &&
      document.body.children.length <= 6
    ) {
      return true;
    }
    return false;
  }

  function openCurrentPdfInNewTab(automatic = false) {
    return safeRuntimeSendMessage({
      type: 'OPEN_DOCUMENT_STUDIO',
      payload: {
        pdfUrl: window.location.href,
        autoTranslate: true,
        automatic
      }
    });
  }

  function enablePageTranslation() {
    if (isOnlinePdfPage()) {
      openCurrentPdfInNewTab();
      return;
    }
    pageTranslationSession++;
    isPageTranslated = true;
    ensureObservers();
    scanAndObserveContainer(document.body);
    domMutationObserver.observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['href', 'target', 'title'] });
    window.addEventListener('scroll', handleScrollRescan, { passive: true });
    postEnableTimers.forEach((t) => clearTimeout(t));
    postEnableTimers = [
      setTimeout(() => {
        if (isPageTranslated) scanAndObserveContainer(document.body);
      }, 650),
      setTimeout(() => {
        if (isPageTranslated) scanAndObserveContainer(document.body);
      }, 1800)
    ];
    updateFloatingBallStatus();
    showPageToast('已开启网页双语对照翻译', 'success');
  }

  function disablePageTranslation() {
    const cleanupSession = ++pageTranslationSession;
    pageRequests.cancel();
    isPageTranslated = false;
    pendingParagraphQueue = [];
    if (flushQueueTimer) {
      clearTimeout(flushQueueTimer);
      flushQueueTimer = null;
    }
    window.removeEventListener('scroll', handleScrollRescan);
    if (scrollRescanTimer) {
      clearTimeout(scrollRescanTimer);
      scrollRescanTimer = null;
    }
    postEnableTimers.forEach((t) => clearTimeout(t));
    postEnableTimers = [];
    if (mutationScanTimer) clearTimeout(mutationScanTimer);
    mutationScanTimer = null;
    pendingScanRoots.clear();
    if (viewportObserver) viewportObserver.disconnect();
    if (domMutationObserver) domMutationObserver.disconnect();

    cleanupAllImageOverlays();
    blockMap.clear();
    totalTranslatedCount = 0;
    updateFloatingBallStatus();

    const translatedEls = Array.from(document.querySelectorAll('[data-ig-status]'));
    for (const el of translatedEls) {
      delete el.dataset.igStatus;
      delete el.dataset.igBlockId;
      el.dataset.igCleanupSession = String(cleanupSession);
    }
    const BATCH = 30;
    (async () => {
      for (let i = 0; i < translatedEls.length; i += BATCH) {
        const slice = translatedEls.slice(i, i + BATCH);
        await new Promise((resolve) =>
          requestAnimationFrame(() => {
            for (const el of slice) {
              if (el.dataset.igCleanupSession !== String(cleanupSession)) continue;
              resetElementTranslationState(el);
            }
            resolve();
          })
        );
      }
    })();
    showPageToast('已恢复网页原文显示', 'info');
  }

  function togglePageTranslation() {
    manualToggleRevision++;
    const pdfPage = isOnlinePdfPage();
    const enable = pdfPage || !isPageTranslated;
    // Keep immediate visual cancellation; persist the intent before responding
    // to popup/shortcut callers so their next navigation sees the session pause.
    if (!pdfPage) {
      if (enable) enablePageTranslation(); else disablePageTranslation();
    }
    return saveSiteAutoTranslatePause(!enable).then(async saved => {
      if (pdfPage) await openCurrentPdfInNewTab();
      else if (saved && !enable && siteAutoPaused) {
        showPageToast('本站本次会话已暂停自动翻译；手动开启可恢复，重启浏览器后恢复站点规则。', 'info');
      }
      return isPageTranslated;
    });
  }

  function cycleTranslationStyle() {
    const idx = STYLE_LIST.findIndex((s) => s.id === settings.translationStyle);
    const next = STYLE_LIST[(idx + 1) % STYLE_LIST.length];
    settings.translationStyle = next.id;
    applyStyleAttribute(next.id);
    safeUpdateStorage({ translationStyle: next.id });
    showPageToast(`译文样式已切换为：${next.label}`, 'info');
  }

  // ============================================================================
  // 4. Single-Paragraph Hover + Alt Quick Translation
  // ============================================================================

  let altHoverGesture = null;
  const isEditingForHover = () => {
    const active = document.activeElement;
    return active?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(active?.tagName);
  };

  document.addEventListener(
    'mousemove',
    (e) => {
      let target = e.target?.closest?.(BLOCK_SELECTOR) || null;
      while (
        target &&
        target.dataset?.igStatus !== 'done' &&
        typeof isElementTranslatable === 'function' &&
        !isElementTranslatable(target)
      ) {
        target = target.parentElement?.closest?.(BLOCK_SELECTOR) || null;
      }
      if (hoveredElement && hoveredElement !== target) {
        hoveredElement.classList.remove('ig-hover-target-highlight');
      }
      hoveredElement = target || null;
      if (hoveredElement && e.altKey && settings.enableHoverTranslate &&
          !altHoverGesture?.combined && !isEditingForHover()) {
        hoveredElement.classList.add('ig-hover-target-highlight');
      }
    },
    { passive: true }
  );

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Alt') {
      if (altHoverGesture) altHoverGesture.combined = true;
      hoveredElement?.classList.remove('ig-hover-target-highlight');
      return;
    }
    if (e.repeat || !settings.enableHoverTranslate || isEditingForHover()) return;
    altHoverGesture = { combined: e.ctrlKey || e.metaKey || e.shiftKey };
    if (!altHoverGesture.combined) hoveredElement?.classList.add('ig-hover-target-highlight');
  });

  document.addEventListener('keyup', (e) => {
    if (e.key !== 'Alt') {
      if (altHoverGesture) altHoverGesture.combined = true;
      return;
    }
    const gesture = altHoverGesture;
    altHoverGesture = null;
    hoveredElement?.classList.remove('ig-hover-target-highlight');
    if (!gesture || gesture.combined || e.ctrlKey || e.metaKey || e.shiftKey ||
        !settings.enableHoverTranslate || isEditingForHover() || !hoveredElement) return;
    if (hoveredElement.dataset.igStatus === 'done') {
      resetElementTranslationState(hoveredElement);
    } else if (!hoveredElement.dataset.igStatus) {
      queueParagraphForTranslation(hoveredElement);
    }
  });

  window.addEventListener('blur', () => {
    altHoverGesture = null;
    hoveredElement?.classList.remove('ig-hover-target-highlight');
  });

  // ============================================================================
  // 5. Input Box Triple-Space Real-Time Translation
  // ============================================================================

  let spacePressTimestamps = [];
  let lastSpaceTarget = null;
  let pendingInputTranslation = null;

  function readInputTranslationValue(target, isInput) {
    return isInput ? target.value : target.innerText || target.textContent || '';
  }

  function invalidateInputTranslation(task = pendingInputTranslation) {
    if (!task || task !== pendingInputTranslation) return;
    pendingInputTranslation = null;
    task.observer.disconnect();
    task.target.classList.remove('ig-input-translating');
    inputRequests.cancel();
  }

  for (const event of ['beforeinput', 'input', 'compositionstart', 'focusout']) {
    document.addEventListener(event, e => {
      const task = pendingInputTranslation;
      if (task && (task.target === e.target || task.target.contains(e.target))) invalidateInputTranslation(task);
      if (event === 'compositionstart') spacePressTimestamps = [];
    }, true);
  }

  function ownsInputTranslation(task) {
    return pendingInputTranslation === task && task.target.isConnected &&
      document.activeElement === task.target &&
      readInputTranslationValue(task.target, task.isInput) === task.original &&
      (task.isInput || task.target.innerHTML === task.originalHtml);
  }

  document.addEventListener(
    'keydown',
    async (e) => {
      if (!settings.enableTripleSpaceInput) return;
      if (e.isComposing || e.keyCode === 229 || e.repeat || e.key !== ' ' || e.ctrlKey || e.metaKey || e.altKey) {
        spacePressTimestamps = [];
        return;
      }
      const active = document.activeElement;
      if (!active || active.closest?.('.cm-editor, .monaco-editor, .CodeMirror, pre, code')) return;
      const isInput = active.tagName === 'TEXTAREA' ||
        (active.tagName === 'INPUT' && ['text', 'search', 'url', 'email', ''].includes((active.type || 'text').toLowerCase()));
      const isEditable = active.isContentEditable;
      if (!isInput && !isEditable) return;
      const now = Date.now();
      if (lastSpaceTarget !== active) { spacePressTimestamps = []; lastSpaceTarget = active; }
      spacePressTimestamps = spacePressTimestamps.filter(t => now - t < 650);
      spacePressTimestamps.push(now);
      if (spacePressTimestamps.length < 3) return;
      spacePressTimestamps = [];
      const original = readInputTranslationValue(active, isInput);
      const trimmed = original.trim();
      if (trimmed.length < 2) return;
      e.preventDefault();
      invalidateInputTranslation();
      inputRequests.cancel();
      const task = { target: active, isInput, original, originalHtml: isInput ? '' : active.innerHTML };
      task.observer = new MutationObserver(() => {
        if (!ownsInputTranslation(task)) invalidateInputTranslation(task);
      });
      pendingInputTranslation = task;
      task.observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
      active.classList.add('ig-input-translating');
      showPageToast('⚡ 正在将输入内容翻译为目标外语；继续编辑会取消本次替换。', 'info');
      let applying = false;
      try {
        const res = await sendModelRequest({ type: 'TRANSLATE_INPUT_TEXT',
          payload: { text: trimmed, targetLang: settings.inputTargetLang || 'en' } });
        if (res?.cancelled || !ownsInputTranslation(task)) return;
        if (!res?.ok) throw new Error(res?.error || '输入框翻译失败');
        const translated = res.data?.translatedText || trimmed;
        // Release ownership before dispatching our own input event.
        applying = true;
        task.observer.disconnect();
        pendingInputTranslation = null;
        active.classList.remove('ig-input-translating');
        if (isInput) {
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window[active.tagName === 'TEXTAREA' ? 'HTMLTextAreaElement' : 'HTMLInputElement'].prototype, 'value')?.set;
          if (nativeSetter) nativeSetter.call(active, translated);
          else active.value = translated;
          active.dispatchEvent(new Event('input', { bubbles: true }));
          active.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          // Select only this editing host, never the whole document or another editor.
          const range = document.createRange();
          range.selectNodeContents(active);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          if (!document.execCommand('insertText', false, translated)) throw new Error('当前富文本编辑器不支持安全替换');
        }
        showPageToast('✨ 输入框翻译完成', 'success');
      } catch (err) {
        if (pendingInputTranslation === task || applying) {
          showPageToast(`翻译失败: ${err?.message || '请检查 API Key'}`, 'warn', true);
        }
      } finally {
        task.observer.disconnect();
        if (pendingInputTranslation === task) {
          pendingInputTranslation = null;
          active.classList.remove('ig-input-translating');
        }
      }
    },
    true
  );

  // ============================================================================
  // 6. Shadow DOM Isolated UI: Floating Ball + Selection AI Popover + Toasts
  // ============================================================================

  function initShadowUI() {
    if (shadowRoot || !document.body) return;

    const host = document.createElement('div');
    host.id = 'immersive-gemini-shadow-host';
    host.style.cssText =
      'position: fixed; z-index: 2147483646; top: 0; left: 0; width: 0; height: 0; pointer-events: none;';
    document.documentElement.appendChild(host);

    shadowRoot = host.attachShadow({ mode: 'open' });

    const styleEl = document.createElement('style');
    styleEl.textContent = `
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .ig-floating-dock {
        position: fixed;
        right: 0;
        top: 68%;
        transform: translateY(-50%);
        pointer-events: auto;
        z-index: 2147483646;
        display: flex;
        align-items: center;
        user-select: none;
      }
      .ig-floating-Dock-hidden { display: none !important; }
      .ig-ball-main {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 11px 8px 10px;
        border-radius: 999px 0 0 999px;
        background: rgba(30, 41, 59, 0.84);
        backdrop-filter: blur(8px);
        color: #cbd5e1;
        border: 1.5px solid rgba(148, 163, 184, 0.32);
        border-right: none;
        box-shadow: -2px 4px 14px rgba(0, 0, 0, 0.26);
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        opacity: 0.88;
        transform: translateX(4px);
      }
      .ig-floating-dock:hover .ig-ball-main {
        opacity: 1;
        transform: translateX(0);
        padding-right: 14px;
        border-color: rgba(148, 163, 184, 0.55);
      }
      .ig-ball-main.is-active {
        opacity: 1;
        transform: translateX(0);
        background: rgba(15, 23, 42, 0.96);
        color: #ffffff;
        border-color: #10b981;
        box-shadow: -3px 6px 20px rgba(16, 185, 129, 0.38);
      }
      .ig-ball-main.is-pdf {
        opacity: 1;
        transform: translateX(0);
        background: rgba(30, 27, 75, 0.94);
        color: #ffffff;
        border-color: #818cf8;
      }
      .ig-ball-check {
        width: 16px;
        height: 16px;
        border-radius: 999px;
        border: 1.5px solid rgba(148, 163, 184, 0.5);
        background: transparent;
        color: transparent;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 10.5px;
        font-weight: 900;
        line-height: 1;
        transition: all 0.18s ease;
        flex-shrink: 0;
      }
      .ig-ball-main.is-active .ig-ball-check {
        background: #10b981;
        border-color: #34d399;
        color: #ffffff;
        box-shadow: 0 0 8px rgba(16, 185, 129, 0.7);
      }
      .ig-ball-main.is-pdf .ig-ball-check {
        background: #6366f1;
        border-color: #818cf8;
        color: #ffffff;
      }
      .ig-ball-icon {
        font-size: 13.5px;
        font-weight: 800;
        letter-spacing: -0.02em;
      }
      .ig-ball-badge {
        font-size: 10.5px;
        background: rgba(16, 185, 129, 0.22);
        color: #6ee7b7;
        border: 1px solid rgba(16, 185, 129, 0.4);
        padding: 0 5px;
        border-radius: 999px;
        font-weight: 700;
      }
      .ig-ball-badge[hidden] {
        display: none !important;
      }
      .ig-ball-drawer {
        position: absolute;
        right: calc(100% + 8px);
        top: 50%;
        transform: translateY(-50%) scale(0.95);
        transform-origin: right center;
        width: 256px;
        background: rgba(15, 23, 42, 0.97);
        backdrop-filter: blur(14px);
        color: #f8fafc;
        border: 1px solid rgba(148, 163, 184, 0.28);
        border-radius: 14px;
        padding: 12px;
        box-shadow: 0 18px 40px rgba(0, 0, 0, 0.5);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.18s ease, transform 0.18s ease;
      }
      .ig-floating-dock:hover .ig-ball-drawer {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(-50%) scale(1);
      }
      .ig-drawer-title {
        font-size: 11px;
        font-weight: 700;
        color: #94a3b8;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 8px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .ig-drawer-toggle {
        width: 100%;
        padding: 9px 11px;
        border-radius: 10px;
        border: 1.5px solid rgba(148, 163, 184, 0.25);
        background: rgba(30, 41, 59, 0.75);
        color: #cbd5e1;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 10px;
        text-align: left;
        transition: all 0.16s ease;
      }
      .ig-drawer-toggle:hover {
        border-color: rgba(148, 163, 184, 0.5);
        background: rgba(30, 41, 59, 0.95);
      }
      .ig-drawer-toggle.is-active {
        background: rgba(16, 185, 129, 0.14);
        border-color: #10b981;
        color: #ffffff;
        box-shadow: 0 4px 16px rgba(16, 185, 129, 0.18);
      }
      .ig-toggle-left {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .ig-toggle-check {
        width: 20px;
        height: 20px;
        border-radius: 999px;
        border: 1.5px solid rgba(148, 163, 184, 0.45);
        background: rgba(15, 23, 42, 0.6);
        color: transparent;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        font-weight: 900;
        flex-shrink: 0;
        transition: all 0.16s ease;
      }
      .ig-drawer-toggle.is-active .ig-toggle-check {
        background: #10b981;
        border-color: #34d399;
        color: #ffffff;
        box-shadow: 0 0 8px rgba(16, 185, 129, 0.55);
      }
      .ig-toggle-text-wrap {
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
      }
      .ig-toggle-main-text {
        font-size: 12.5px;
        font-weight: 700;
        line-height: 1.25;
      }
      .ig-drawer-toggle.is-active .ig-toggle-main-text {
        color: #6ee7b7;
      }
      .ig-toggle-sub-text {
        font-size: 10.5px;
        color: #94a3b8;
        line-height: 1.2;
      }
      .ig-switch-track {
        width: 34px;
        height: 18px;
        border-radius: 999px;
        background: #334155;
        border: 1px solid rgba(148, 163, 184, 0.3);
        padding: 2px;
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
        transition: background 0.18s ease, border-color 0.18s ease;
      }
      .ig-drawer-toggle.is-active .ig-switch-track {
        background: #10b981;
        border-color: #34d399;
      }
      .ig-switch-thumb {
        width: 12px;
        height: 12px;
        border-radius: 999px;
        background: #94a3b8;
        transform: translateX(0);
        transition: transform 0.18s cubic-bezier(0.16, 1, 0.3, 1), background 0.18s ease;
      }
      .ig-drawer-toggle.is-active .ig-switch-thumb {
        background: #ffffff;
        transform: translateX(16px);
      }
      .ig-drawer-subhead {
        font-size: 10.5px;
        color: #94a3b8;
        margin-bottom: 5px;
      }
      .ig-style-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 5px;
        margin-bottom: 9px;
      }
      .ig-style-pill {
        padding: 5px 8px;
        border-radius: 7px;
        border: 1px solid rgba(148, 163, 184, 0.18);
        background: rgba(30, 41, 59, 0.55);
        color: #94a3b8;
        font-size: 11.5px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        transition: all 0.14s ease;
      }
      .ig-style-pill:hover {
        border-color: rgba(148, 163, 184, 0.45);
        color: #f1f5f9;
      }
      .ig-style-pill.is-preset {
        border: 1px dashed rgba(148, 163, 184, 0.45);
        color: #cbd5e1;
        background: rgba(30, 41, 59, 0.75);
      }
      .ig-style-pill.is-active {
        background: rgba(16, 185, 129, 0.16);
        border: 1.5px solid #10b981;
        color: #ffffff;
        font-weight: 700;
      }
      .ig-pill-tick {
        color: #34d399;
        font-weight: 900;
        font-size: 11px;
      }
      .ig-drawer-checks {
        display: flex;
        flex-direction: column;
        gap: 5px;
        padding: 7px 0;
        border-top: 1px solid rgba(148, 163, 184, 0.15);
        margin-bottom: 4px;
      }
      .ig-drawer-check-label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11.5px;
        color: #cbd5e1;
        cursor: pointer;
      }
      .ig-drawer-check-label input {
        margin: 0;
        accent-color: #10b981;
        cursor: pointer;
      }
      .ig-drawer-footer {
        display: flex;
        gap: 6px;
        border-top: 1px solid rgba(148, 163, 184, 0.15);
        padding-top: 8px;
      }
      .ig-drawer-btn {
        flex: 1;
        padding: 6px 8px;
        border-radius: 7px;
        border: 1px solid rgba(148, 163, 184, 0.25);
        background: rgba(51, 65, 85, 0.65);
        color: #f1f5f9;
        font-size: 11.5px;
        cursor: pointer;
        text-align: center;
      }
      .ig-drawer-btn:hover { background: #3b82f6; border-color: #60a5fa; }

      /* Selection Trigger Icon */
      .ig-sel-trigger {
        position: fixed;
        width: 32px;
        height: 32px;
        border-radius: 10px;
        background: linear-gradient(135deg, #2563eb, #6366f1);
        color: #fff;
        display: none;
        align-items: center;
        justify-content: center;
        font-size: 15px;
        font-weight: 700;
        box-shadow: 0 6px 18px rgba(79, 70, 229, 0.48);
        cursor: pointer;
        pointer-events: auto;
        z-index: 2147483647;
        border: 1.5px solid rgba(255,255,255,0.75);
        transition: transform 0.14s ease;
      }
      .ig-sel-trigger:hover { transform: scale(1.1); }

      /* Selection AI Explanation Popover Card */
      .ig-sel-card {
        position: fixed;
        width: 380px;
        max-width: calc(100vw - 24px);
        max-height: 460px;
        overflow-y: auto;
        background: rgba(15, 23, 42, 0.98);
        color: #f8fafc;
        border: 1px solid rgba(99, 102, 241, 0.45);
        border-radius: 16px;
        padding: 15px 16px;
        box-shadow: 0 24px 52px rgba(0, 0, 0, 0.58);
        pointer-events: auto;
        z-index: 2147483647;
        display: none;
        backdrop-filter: blur(14px);
      }
      .ig-sel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
        padding-bottom: 8px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.18);
      }
      .ig-sel-brand {
        font-size: 12px;
        font-weight: 700;
        color: #a5b4fc;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .ig-sel-actions {
        display: flex;
        gap: 6px;
      }
      .ig-icon-btn {
        background: rgba(51, 65, 85, 0.7);
        border: 1px solid rgba(148, 163, 184, 0.25);
        color: #e2e8f0;
        border-radius: 6px;
        padding: 3px 8px;
        font-size: 11px;
        cursor: pointer;
      }
      .ig-icon-btn:hover { background: #4f46e5; }
      .ig-sel-trans {
        font-size: 15px;
        font-weight: 600;
        color: #fde047;
        line-height: 1.5;
        margin-bottom: 8px;
      }
      .ig-sel-meta {
        font-size: 12px;
        color: #94a3b8;
        margin-bottom: 10px;
        line-height: 1.5;
      }
      .ig-sel-breakdown {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid rgba(148, 163, 184, 0.16);
      }
      .ig-term-row {
        font-size: 12px;
        background: rgba(30, 41, 59, 0.75);
        padding: 6px 9px;
        border-radius: 8px;
        line-height: 1.45;
      }
      .ig-term-word { color: #38bdf8; font-weight: 700; margin-right: 6px; }
      .ig-term-role {
        font-size: 10.5px;
        color: #a5b4fc;
        background: rgba(99, 102, 241, 0.2);
        padding: 1px 5px;
        border-radius: 4px;
        margin-right: 6px;
      }
      .ig-sel-example {
        margin-top: 10px;
        font-size: 12px;
        color: #cbd5e1;
        padding: 7px 10px;
        border-left: 3px solid #6366f1;
        background: rgba(79, 70, 229, 0.1);
        border-radius: 0 7px 7px 0;
      }

      /* Toast Notifications */
      .ig-toast-wrap {
        position: fixed;
        top: 20px;
        right: 20px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        z-index: 2147483647;
        pointer-events: none;
      }
      .ig-toast {
        padding: 10px 15px;
        border-radius: 10px;
        background: rgba(15, 23, 42, 0.95);
        color: #f8fafc;
        border: 1px solid rgba(99, 102, 241, 0.45);
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.38);
        font-size: 12.5px;
        font-weight: 500;
        display: flex;
        align-items: center;
        gap: 8px;
        pointer-events: auto;
        animation: ig-slide-in 0.2s ease-out;
      }
      .ig-toast.is-warn { border-color: #f59e0b; }
      @keyframes ig-slide-in {
        from { opacity: 0; transform: translateY(-8px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `;
    shadowRoot.appendChild(styleEl);

    // 1. Floating Ball Dock
    floatingBallEl = document.createElement('div');
    floatingBallEl.className = 'ig-floating-dock';
    floatingBallEl.style.top = `${settings.floatingBallPositionY || 68}%`;
    floatingBallEl.innerHTML = `
      <div class="ig-ball-drawer">
        <div class="ig-drawer-title">
          <span>青简 · 译读</span>
          <span style="font-size:10px;color:#818cf8;">Alt+A</span>
        </div>
        <button class="ig-drawer-toggle" data-action="toggle-page">
          <div class="ig-toggle-left">
            <span class="ig-toggle-check"></span>
            <div class="ig-toggle-text-wrap">
              <span class="ig-toggle-main-text">双语对照：未开启</span>
              <span class="ig-toggle-sub-text">点击立即开启本页翻译</span>
            </div>
          </div>
          <span class="ig-switch-track">
            <span class="ig-switch-thumb"></span>
          </span>
        </button>
        <div class="ig-drawer-subhead">对照样式 (点击切换并立即生效):</div>
        <div class="ig-style-grid">
          ${STYLE_LIST.map(
            (s) =>
              `<button class="ig-style-pill ${
                s.id === settings.translationStyle ? 'is-preset' : ''
              }" data-style="${s.id}"><span class="ig-pill-tick"></span><span>${s.label}</span></button>`
          ).join('')}
        </div>
        <div class="ig-drawer-checks">
          <label class="ig-drawer-check-label">
            <input type="checkbox" class="ig-check-domain" />
            <span>自动翻译此网站网页</span>
          </label>
          <label class="ig-drawer-check-label">
            <input type="checkbox" class="ig-check-global" />
            <span>自动翻译所有外文网页</span>
          </label>
          <label class="ig-drawer-check-label">
            <input type="checkbox" class="ig-check-pdf" />
            <span>访问在线 PDF 时自动跳转工作台翻译</span>
          </label>
        </div>
        <div class="ig-drawer-footer">
          <button class="ig-drawer-btn" data-action="studio">📄 文档工作台</button>
          <button class="ig-drawer-btn" data-action="options">⚙️ 设置</button>
        </div>
      </div>
      <div class="ig-ball-main" title="点击切换网页双语翻译 (Alt+A) · 上下拖拽调整位置">
        <span class="ig-ball-check"></span>
        <span class="ig-ball-icon">译</span>
        <span class="ig-ball-badge" hidden></span>
      </div>
    `;
    shadowRoot.appendChild(floatingBallEl);

    // Floating Ball Click & Vertical Drag
    const ballMain = floatingBallEl.querySelector('.ig-ball-main');
    let isDraggingBall = false;
    let dragMoved = false;

    ballMain.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      isDraggingBall = true;
      dragMoved = false;
      const startY = e.clientY;

      const onMove = (moveEvent) => {
        if (!isDraggingBall) return;
        if (Math.abs(moveEvent.clientY - startY) > 5) {
          dragMoved = true;
          const pct = Math.max(10, Math.min(90, (moveEvent.clientY / window.innerHeight) * 100));
          floatingBallEl.style.top = `${pct.toFixed(1)}%`;
          settings.floatingBallPositionY = Number(pct.toFixed(1));
        }
      };

      const onUp = () => {
        isDraggingBall = false;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (dragMoved) {
          void safeUpdateStorage({ floatingBallPositionY: settings.floatingBallPositionY });
        } else {
          togglePageTranslation();
        }
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    // Main Toggle Button in Drawer
    const drawerToggleBtn = floatingBallEl.querySelector('.ig-drawer-toggle');
    drawerToggleBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePageTranslation();
    });

    // Domain, Global & Online PDF Auto-Translate Checkboxes in Drawer
    const domainCheckEl = floatingBallEl.querySelector('.ig-check-domain');
    const globalCheckEl = floatingBallEl.querySelector('.ig-check-global');
    const pdfCheckEl = floatingBallEl.querySelector('.ig-check-pdf');

    domainCheckEl?.addEventListener('change', async (e) => {
      e.stopPropagation();
      const host = window.location.hostname.toLowerCase();
      if (!host) return;
      const set = new Set(parseDomainList(settings.alwaysTranslateDomains));
      if (domainCheckEl.checked) {
        set.add(host);
        await saveSiteAutoTranslatePause(false);
        if (!isPageTranslated && !isOnlinePdfPage()) enablePageTranslation();
      } else {
        set.delete(host);
      }
      const nextDomains = Array.from(set).join('\n');
      settings.alwaysTranslateDomains = nextDomains;
      safeUpdateStorage({ alwaysTranslateDomains: nextDomains });
    });

    globalCheckEl?.addEventListener('change', async (e) => {
      e.stopPropagation();
      const enabled = Boolean(globalCheckEl.checked);
      settings.autoTranslateAllPages = enabled;
      if (enabled) await saveSiteAutoTranslatePause(false);
      if (enabled && !isPageTranslated && !isOnlinePdfPage()) {
        enablePageTranslation();
      }
      safeUpdateStorage({ autoTranslateAllPages: enabled });
    });

    pdfCheckEl?.addEventListener('change', async (e) => {
      e.stopPropagation();
      const enabled = Boolean(pdfCheckEl.checked);
      settings.autoTranslateOnlinePdf = enabled;
      if (enabled) await saveSiteAutoTranslatePause(false);
      safeUpdateStorage({ autoTranslateOnlinePdf: enabled });
      if (enabled && isOnlinePdfPage() && !hasAutoOpenedPdfTab) {
        hasAutoOpenedPdfTab = true;
        openCurrentPdfInNewTab();
      }
    });

    // Style Pills & Footer Actions in Drawer
    floatingBallEl.querySelectorAll('.ig-style-pill').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const styleId = btn.dataset.style;
        settings.translationStyle = styleId;
        applyStyleAttribute(styleId);
        safeUpdateStorage({ translationStyle: styleId });
        if (!isPageTranslated && !isOnlinePdfPage()) {
          enablePageTranslation();
        }
      });
    });

    floatingBallEl.querySelectorAll('.ig-drawer-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.dataset.action;
        if (act === 'studio') {
          if (isOnlinePdfPage()) {
            openCurrentPdfInNewTab();
          } else {
            safeRuntimeSendMessage({ type: 'OPEN_DOCUMENT_STUDIO' });
          }
        } else if (act === 'options') {
          safeRuntimeSendMessage({ type: 'OPEN_OPTIONS_PAGE' });
        }
      });
    });

    // 2. Selection Trigger & AI Card
    selectionTriggerEl = document.createElement('div');
    selectionTriggerEl.className = 'ig-sel-trigger';
    selectionTriggerEl.title = '使用 AI 结合上下文精解选中内容';
    selectionTriggerEl.textContent = '✦';
    shadowRoot.appendChild(selectionTriggerEl);

    selectionCardEl = document.createElement('div');
    selectionCardEl.className = 'ig-sel-card';
    shadowRoot.appendChild(selectionCardEl);

    selectionTriggerEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (lastSelectionData) {
        openSelectionExplanationCard(lastSelectionData);
      }
    });

    // 3. Toast Container
    toastContainerEl = document.createElement('div');
    toastContainerEl.className = 'ig-toast-wrap';
    shadowRoot.appendChild(toastContainerEl);

    updateFloatingBallVisibility();
    updateFloatingBallStatus();
  }

  function updateFloatingBallVisibility() {
    if (!floatingBallEl) return;
    floatingBallEl.classList.toggle('ig-floating-Dock-hidden', !settings.enableFloatingBall);
  }

  function updateFloatingBallStatus() {
    if (!floatingBallEl) return;
    const main = floatingBallEl.querySelector('.ig-ball-main');
    const ballCheck = floatingBallEl.querySelector('.ig-ball-check');
    const badge = floatingBallEl.querySelector('.ig-ball-badge');
    const drawerToggle = floatingBallEl.querySelector('.ig-drawer-toggle');
    const toggleCheck = floatingBallEl.querySelector('.ig-toggle-check');
    const toggleMainText = floatingBallEl.querySelector('.ig-toggle-main-text');
    const toggleSubText = floatingBallEl.querySelector('.ig-toggle-sub-text');
    const domainCheckEl = floatingBallEl.querySelector('.ig-check-domain');
    const globalCheckEl = floatingBallEl.querySelector('.ig-check-global');
    const pdfCheckEl = floatingBallEl.querySelector('.ig-check-pdf');

    if (domainCheckEl) {
      domainCheckEl.checked = isCurrentDomainInAlwaysList();
    }
    if (globalCheckEl) {
      globalCheckEl.checked = Boolean(settings.autoTranslateAllPages);
    }
    if (pdfCheckEl) {
      pdfCheckEl.checked = Boolean(settings.autoTranslateOnlinePdf);
    }

    if (isOnlinePdfPage()) {
      main.classList.remove('is-active');
      main.classList.add('is-pdf');
      if (ballCheck) ballCheck.textContent = '↗';
      if (badge) {
        badge.hidden = false;
        badge.textContent = 'PDF';
      }
      if (drawerToggle) {
        drawerToggle.classList.remove('is-active');
        if (toggleCheck) toggleCheck.textContent = '📄';
        if (toggleMainText) toggleMainText.textContent = '在线 PDF 双语翻译';
        if (toggleSubText) toggleSubText.textContent = siteAutoPaused ? '本站本次会话已暂停自动翻译 · 点击可恢复并打开工作台' : '点击在新标签页打开翻译工作台 ↗';
      }
      return;
    }

    main.classList.remove('is-pdf');

    if (isPageTranslated) {
      main.classList.add('is-active');
      if (ballCheck) ballCheck.textContent = '✓';
      if (badge) {
        if (totalTranslatedCount > 0) {
          badge.hidden = false;
          badge.textContent = `${totalTranslatedCount}`;
        } else {
          badge.hidden = true;
        }
      }
      if (drawerToggle) {
        drawerToggle.classList.add('is-active');
        if (toggleCheck) toggleCheck.textContent = '✓';
        if (toggleMainText) toggleMainText.textContent = '双语对照：已开启';
        if (toggleSubText) {
          toggleSubText.textContent =
            totalTranslatedCount > 0
              ? `已译 ${totalTranslatedCount} 段 · 点击关闭并恢复原文`
              : '正在识别并翻译视口段落 · 点击关闭';
        }
      }
    } else {
      main.classList.remove('is-active');
      if (ballCheck) ballCheck.textContent = '';
      if (badge) {
        badge.hidden = true;
        badge.textContent = '';
      }
      if (drawerToggle) {
        drawerToggle.classList.remove('is-active');
        if (toggleCheck) toggleCheck.textContent = '';
        if (toggleMainText) toggleMainText.textContent = siteAutoPaused ? '本站本次会话已暂停' : '双语对照：未开启';
        if (toggleSubText) toggleSubText.textContent = siteAutoPaused ? '手动开启可恢复本站自动翻译；重启浏览器后恢复规则' : '点击此处或按 Alt+A 立即开启';
      }
    }

    applyStyleAttribute(settings.translationStyle);

    safeRuntimeSendMessage({
      type: 'SYNC_TAB_BADGE',
      payload: { isPageTranslated }
    });
  }

  function showPageToast(text, type = 'info', showOptionsAction = false) {
    initShadowUI();
    if (!toastContainerEl) return;
    const toast = document.createElement('div');
    toast.className = `ig-toast ${type === 'warn' ? 'is-warn' : ''}`;
    toast.innerHTML = `<span>${escapeText(text)}</span>`;
    if (showOptionsAction) {
      const btn = document.createElement('button');
      btn.className = 'ig-icon-btn';
      btn.textContent = '去设置';
      btn.addEventListener('click', () => {
        safeRuntimeSendMessage({ type: 'OPEN_OPTIONS_PAGE' });
      });
      toast.appendChild(btn);
    }
    toastContainerEl.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 3400);
  }

  // ============================================================================
  // 7. Selection AI Contextual Deep Explanation
  // ============================================================================

  document.addEventListener('mouseup', (e) => {
    if (!settings.enableSelectionTooltip) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const selectedText = (sel ? sel.toString() : '').trim();
      if (!selectedText || selectedText.length < 2 || selectedText.length > 480) {
        if (selectionTriggerEl) selectionTriggerEl.style.display = 'none';
        return;
      }

      const anchorEl = sel.anchorNode?.parentElement;
      const contextBlock = anchorEl?.closest?.(BLOCK_SELECTOR) || anchorEl;
      const contextParagraph = contextBlock
        ? extractCleanText(contextBlock).slice(0, 600)
        : selectedText;

      const x = Math.min(window.innerWidth - 48, Math.max(12, e.clientX + 10));
      const y = Math.min(window.innerHeight - 48, Math.max(12, e.clientY - 38));

      lastSelectionData = {
        text: selectedText,
        contextParagraph,
        x,
        y
      };

      initShadowUI();
      selectionTriggerEl.style.left = `${x}px`;
      selectionTriggerEl.style.top = `${y}px`;
      selectionTriggerEl.style.display = 'flex';
    }, 20);
  });

  document.addEventListener('mousedown', (e) => {
    if (!shadowRoot) return;
    const path = e.composedPath();
    if (selectionCardEl && !path.includes(selectionCardEl) && !path.includes(selectionTriggerEl)) {
      selectionRequests.cancel();
      selectionCardEl.style.display = 'none';
    }
  });

  async function openSelectionExplanationCard({ text, contextParagraph, x, y }) {
    selectionRequests.cancel();
    initShadowUI();
    selectionTriggerEl.style.display = 'none';

    const cardLeft = Math.min(window.innerWidth - 396, Math.max(12, x - 40));
    const cardTop = Math.min(window.innerHeight - 320, Math.max(12, y + 12));
    selectionCardEl.style.left = `${cardLeft}px`;
    selectionCardEl.style.top = `${cardTop}px`;
    selectionCardEl.style.display = 'block';
    selectionCardEl.innerHTML = `
      <div class="ig-sel-header">
        <span class="ig-sel-brand">✦ AI 语境精解</span>
        <button class="ig-icon-btn" data-close="1">关闭</button>
      </div>
      <div style="font-size:12.5px;color:#94a3b8;padding:10px 0;">正在结合所在段落上下文深度解析…</div>
    `;
    selectionCardEl.querySelector('[data-close]')?.addEventListener('click', () => {
      selectionRequests.cancel();
      selectionCardEl.style.display = 'none';
    });

    try {
      const res = await sendModelRequest({
        type: 'TRANSLATE_SELECTION',
        payload: {
          text,
          contextParagraph,
          targetLang: settings.targetLang,
          pageTitle: document.title
        }
      });

      if (res?.cancelled) return;
      if (!res || !res.ok) {
        throw new Error(res?.error || '划词解析请求失败');
      }

      const d = res.data || {};
      const breakdownHtml = Array.isArray(d.breakdown)
        ? d.breakdown
            .map(
              (b) => `
          <div class="ig-term-row">
            <span class="ig-term-word">${escapeText(b.term)}</span>
            ${b.role ? `<span class="ig-term-role">${escapeText(b.role)}</span>` : ''}
            <span>${escapeText(b.meaning)}</span>
          </div>`
            )
            .join('')
        : '';

      selectionCardEl.innerHTML = `
        <div class="ig-sel-header">
          <span class="ig-sel-brand">✦ AI 语境精解 ${
            d.phonetic ? `· <span style="color:#e2e8f0;font-weight:500;">${escapeText(d.phonetic)}</span>` : ''
          }</span>
          <div class="ig-sel-actions">
            <button class="ig-icon-btn" data-speak="1" title="朗读原文">🔊 朗读</button>
            <button class="ig-icon-btn" data-copy="1" title="复制译文">复制</button>
            <button class="ig-icon-btn" data-close="1">✕</button>
          </div>
        </div>
        <div class="ig-sel-trans">${escapeText(d.translation || text)}</div>
        <div class="ig-sel-meta">${escapeText(d.contextualMeaning || '')}</div>
        ${breakdownHtml ? `<div class="ig-sel-breakdown">${breakdownHtml}</div>` : ''}
        ${d.example ? `<div class="ig-sel-example">💡 ${escapeText(d.example)}</div>` : ''}
      `;

      selectionCardEl.querySelector('[data-close]')?.addEventListener('click', () => {
        selectionRequests.cancel();
        selectionCardEl.style.display = 'none';
      });
      selectionCardEl.querySelector('[data-speak]')?.addEventListener('click', () => {
        if ('speechSynthesis' in window) {
          window.speechSynthesis.cancel();
          const utter = new SpeechSynthesisUtterance(text);
          window.speechSynthesis.speak(utter);
        }
      });
      selectionCardEl.querySelector('[data-copy]')?.addEventListener('click', (ev) => {
        Promise.resolve(navigator.clipboard?.writeText?.(d.translation || text))
          .then(() => { ev.target.textContent = '已复制'; })
          .catch(() => { ev.target.textContent = '复制失败'; });
      });
    } catch (err) {
      selectionCardEl.innerHTML = `
        <div class="ig-sel-header">
          <span class="ig-sel-brand">✦ AI 语境精解</span>
          <button class="ig-icon-btn" data-close="1">✕</button>
        </div>
        <div style="color:#f87171;font-size:12.5px;">⚠️ ${escapeText(err?.message || '请求失败')}</div>
      `;
      selectionCardEl.querySelector('[data-close]')?.addEventListener('click', () => {
        selectionRequests.cancel();
        selectionCardEl.style.display = 'none';
      });
    }
  }

  function escapeText(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  const escapeHtml = escapeText;

  // ============================================================================
  // 8. YouTube Dual Subtitle Engine + Timeline Sidebar + Multimodal Audio Fallback
  // ============================================================================

  let ytCues = [];
  let ytInitialized = false;
  let ytNavigationPending = false;
  let ytCaptionSource = 'none';
  let ytObservedCues = [];
  let ytObservedCueId = 0;
  let ytCurrentObservedCue = null;
  let ytObservedDropped = 0;
  let ytVideoTitle = '';
  let ytCurrentVideoId = '';
  let ytDualActive = true;
  let ytSidebarOpen = false;
  let ytOverlayEl = null;
  let ytSidebarEl = null;
  let ytTimelineWindow = null;
  let ytTimelineFilter = null;
  let ytTimelineCurrentCueId = null;
  let ytCtrlBtnEl = null;
  let ytInFlightBatchIds = new Set();
  let ytLastRenderedSig = '';
  let ytBoundVideoEl = null;
  let ytAudioRecorder = null;
  let ytAudioListenActive = false;
  let ytAudioSession = 0;
  let ytAudioStream = null;
  let ytAudioButton = null;
  let ytAudioCleanup = null;
  const ytLiveCaptionCache = new Map();
  const ytLiveCaptionInFlight = new Set();

  // One automatic request at a time; failures belong to this video/configuration session.
  let ytTranslationSession = 0;
  let ytFailureCount = 0;
  let ytRetryAt = 0;
  let ytTranslationStopped = false;
  let ytTranslationBusy = false;
  let ytErrorEl = null;
  let ytNeedsRefresh = false;

  function resetYoutubeTranslationSession() {
    ytTranslationSession++;
    subtitleRequests.cancel();
    ytInFlightBatchIds.clear();
    ytLiveCaptionInFlight.clear();
    ytFailureCount = 0;
    ytRetryAt = 0;
    ytTranslationStopped = false;
    ytNeedsRefresh = false;
    ytTranslationBusy = false;
    ytErrorEl?.remove();
    ytErrorEl = null;
    ytLastRenderedSig = '';
  }

  function invalidateYoutubeTranslations() {
    resetYoutubeTranslationSession();
    stopYoutubeAudioListen();
    for (const cue of [...ytCues, ...ytObservedCues]) cue.translation = '';
    ytLiveCaptionCache.clear();
    renderYoutubeTimelineList();
  }

  function disposeYoutubeTimeline() {
    ytTimelineWindow?.dispose();
    ytTimelineWindow = null;
    ytTimelineFilter = null;
  }

  function clearYoutubeSourceCues() {
    disposeYoutubeTimeline();
    ytTimelineCurrentCueId = null;
    ytCues = [];
    ytVideoTitle = '';
    ytCaptionSource = 'none';
    ytObservedCues = [];
    ytCurrentObservedCue = null;
    ytObservedCueId = 0;
    ytObservedDropped = 0;
    ytLiveCaptionCache.clear();
    if (ytOverlayEl) ytOverlayEl.innerHTML = '';
    renderYoutubeTimelineList(true);
  }

  function syncYoutubeVideoSession() {
    const videoId = getCurrentYoutubeVideoId();
    if (videoId === ytCurrentVideoId) return false;
    stopYoutubeAudioListen();
    resetYoutubeTranslationSession();
    ytCurrentVideoId = videoId;
    clearYoutubeSourceCues();
    return true;
  }

  function getYoutubeTimelineCues() {
    return ytCues.length ? ytCues : [...ytObservedCues].sort((a, b) => a.start - b.start);
  }

  function observeYoutubeLiveCaption(text, time, translation = '') {
    if (!text || !Number.isFinite(time)) return;
    const t = Math.max(0, time);
    let cue = ytCurrentObservedCue;
    if (!cue || cue.text !== text || t < cue.start || t > cue.end + 1.5) {
      cue = ytObservedCues.find(item => item.text === text && t >= item.start && t <= item.end);
    }
    let changed = false;
    if (!cue) {
      cue = { id: `live-${++ytObservedCueId}`, start: t, end: t + 0.001, text, translation };
      ytObservedCues.push(cue);
      if (ytObservedCues.length > 1000) { ytObservedCues.shift(); ytObservedDropped++; }
      changed = true;
    } else {
      cue.end = Math.max(cue.end, t);
      if (translation && cue.translation !== translation) { cue.translation = translation; changed = true; }
    }
    ytCurrentObservedCue = cue;
    if (changed) renderYoutubeTimelineList();
    return cue;
  }

  function youtubeCoverageText() {
    const cues = getYoutubeTimelineCues();
    const translated = cues.filter(cue => cue.translation).length;
    if (ytCues.length) return `${ytCaptionSource === 'audio' ? '已听译音频片段' : '已加载字幕轨道'}：${cues.length} 条，已有译文 ${translated} 条`;
    return `仅包含已观察到的字幕片段：${cues.length} 条，已有译文 ${translated} 条；时间为观察区间，不是完整视频字幕${ytObservedDropped ? `；已移除最早 ${ytObservedDropped} 条记录` : ''}`;
  }

  function syncYoutubePreferences(previous) {
    if (!ytInitialized) return;
    if (previous.youtubeAutoEnable !== settings.youtubeAutoEnable || previous.enableYoutubeDualSub !== settings.enableYoutubeDualSub) {
      ytDualActive = settings.enableYoutubeDualSub !== false && settings.youtubeAutoEnable !== false;
      resetYoutubeTranslationSession();
      if (!ytDualActive) { stopYoutubeAudioListen(); if (ytOverlayEl) ytOverlayEl.innerHTML = ''; }
      updateYoutubeControlButtonUI();
    }
    if (previous.youtubeShowSidebar !== settings.youtubeShowSidebar) {
      ytSidebarOpen = Boolean(settings.youtubeShowSidebar);
      if (!ytSidebarOpen && ytSidebarEl) { ytSidebarEl.style.display = 'none'; disposeYoutubeTimeline(); }
    }
    mountYoutubePlayerUI();
  }

  function canRequestYoutubeTranslation() {
    return ytDualActive && !ytTranslationStopped && !ytTranslationBusy && Date.now() >= ytRetryAt;
  }

  function recordYoutubeTranslationFailure(error) {
    const message = String(error?.error || error?.message || error || '字幕翻译请求失败');
    ytNeedsRefresh = error?.code === 'EXTENSION_CONTEXT_INVALIDATED' || /extension context invalidated/i.test(message);
    ytLastRenderedSig = '';
    ytFailureCount++;
    const permanent = /\b(?:400|401|402|403|404|422)\b|未配置|不支持|invalid.*(?:key|model)|unauthorized|permission.denied/i.test(message);
    ytTranslationStopped = ytNeedsRefresh || permanent || ytFailureCount >= 3;
    ytRetryAt = Date.now() + 1000 * (2 ** (ytFailureCount - 1));
    if (!ytErrorEl || ytErrorEl.isConnected === false) {
      ytErrorEl = document.createElement('div');
      ytErrorEl.className = 'ig-yt-translation-error notranslate';
      ytErrorEl.setAttribute('role', 'status');
      ytErrorEl.style.cssText = 'position:absolute;top:48px;left:12px;right:12px;z-index:10000;padding:10px;background:#241b16;color:#fff;font:14px sans-serif;pointer-events:auto';
      (document.querySelector('.html5-video-player') || document.body).appendChild(ytErrorEl);
    }
    ytErrorEl.textContent = `${ytNeedsRefresh ? '字幕翻译连接已失效。' : ytTranslationStopped ? '字幕翻译已暂停，请查看错误后重试。' : '字幕翻译暂时失败，正在退避重试。'} ${message} `;
    const retry = document.createElement('button');
    retry.textContent = ytNeedsRefresh ? '刷新页面' : '重新尝试';
    retry.addEventListener('click', () => {
      if (ytNeedsRefresh) window.location.reload();
      else resetYoutubeTranslationSession();
    });
    ytErrorEl.appendChild(retry);
  }

  function clearYoutubeTranslationFailure() {
    ytNeedsRefresh = false;
    ytTranslationStopped = false;
    ytLastRenderedSig = '';
    ytFailureCount = 0;
    ytRetryAt = 0;
    ytErrorEl?.remove();
    ytErrorEl = null;
  }

  function youtubePendingTranslationText() {
    if (ytNeedsRefresh) return '扩展已更新，请刷新页面恢复字幕翻译';
    if (ytTranslationStopped) return '字幕翻译已暂停，请点击上方重新尝试';
    if (Date.now() < ytRetryAt) return '字幕翻译暂时失败，等待重试…';
    return ytTranslationBusy ? '正在翻译字幕…' : '等待字幕翻译…';
  }

  function getCurrentYoutubeVideoId() {
    try {
      const url = new URL(window.location.href);
      if (url.pathname.startsWith('/watch')) {
        return url.searchParams.get('v') || '';
      }
      if (url.pathname.startsWith('/shorts/')) {
        return url.pathname.split('/shorts/')[1]?.split('/')[0] || '';
      }
    } catch {
      // ignore
    }
    return '';
  }

  function applyYoutubeCssVariables() {
    const effectiveSize = Math.max(12, Math.min(36, Number(settings.youtubeSubFontSize) || 22));
    document.documentElement.style.setProperty('--ig-yt-font-size', `${effectiveSize}px`);
    document.documentElement.style.setProperty(
      '--ig-yt-trans-color',
      settings.youtubeTransColor || '#fde047'
    );
    document.documentElement.style.setProperty(
      '--ig-yt-bg-opacity',
      String(settings.youtubeBgOpacity ?? 0.72)
    );
  }

  function requestYoutubeTracksFromBridge() {
    window.postMessage({ source: 'IG_YT_CONTENT_SCRIPT', type: 'REQUEST_YT_TRACKS' }, '*');
  }

  function initYoutubeIntegration() {
    if (!window.location.hostname.includes('youtube.com')) return;

    ytInitialized = true;
    ytDualActive = settings.enableYoutubeDualSub !== false && settings.youtubeAutoEnable !== false;
    ytSidebarOpen = Boolean(settings.youtubeShowSidebar);
    ytCurrentVideoId = getCurrentYoutubeVideoId();
    applyYoutubeCssVariables();

    let ytBridgePollCount = 0;

    window.addEventListener('yt-navigate-start', () => {
      ytNavigationPending = true;
      ytBridgePollCount = 0;
      stopYoutubeAudioListen();
      resetYoutubeTranslationSession();
      clearYoutubeSourceCues();
    });
    window.addEventListener('yt-navigate-finish', () => {
      ytNavigationPending = false;
      ytBridgePollCount = 0;
      syncYoutubeVideoSession();
      requestYoutubeTracksFromBridge();
    });
    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data) return;
      if (event.data.source !== 'IG_YT_MAIN_BRIDGE' || ytNavigationPending) return;
      syncYoutubeVideoSession();

      if (event.data.type === 'YT_CUES_LOADED') {
        const { cues, videoTitle, videoId } = event.data.payload || {};
        const currentVid = getCurrentYoutubeVideoId();
        if (videoId && currentVid && videoId !== currentVid) {
          return;
        }
        if (Array.isArray(cues) && cues.length > 0) {
          subtitleRequests.cancel();
          ytTranslationSession++;
          ytTranslationBusy = false;
          ytLiveCaptionInFlight.clear();
          ytCues = cues
            .filter((c) => c && Number.isFinite(Number(c.start)) && Number.isFinite(Number(c.end)))
            .slice(0, 20000)
            .map((c, idx) => ({
              id: Number.isSafeInteger(Number(c.id)) ? Number(c.id) : idx + 1,
              start: Number(c.start),
              end: Number(c.end),
              text: String(c.text || ''),
              translation: ''
            }));
          ytCaptionSource = 'track';
          ytVideoTitle = videoTitle || document.title;
          ytInFlightBatchIds.clear();
          ytLastRenderedSig = '';
          mountYoutubePlayerUI();
          renderYoutubeTimelineList();
          // Immediately prefetch around current playback time (plus start of video)
          const video = document.querySelector('video');
          const curTime = video ? video.currentTime : 0;
          prefetchYoutubeCuesAround(curTime);
        }
      } else if (event.data.type === 'YT_NO_CAPTIONS_AVAILABLE') {
        if (event.data.payload?.videoId && event.data.payload.videoId !== getCurrentYoutubeVideoId()) return;
        ytVideoTitle = event.data.payload?.videoTitle || document.title;
        mountYoutubePlayerUI();
        renderYoutubeTimelineList(true);
      }
    });

    // Immediately handshake with youtube-page-bridge.js (which runs at document_start)
    // so we don't miss YT_CUES_LOADED events dispatched before document_idle.
    requestYoutubeTracksFromBridge();
    setTimeout(() => {
      if (ytCues.length === 0) requestYoutubeTracksFromBridge();
    }, 700);
    setTimeout(() => {
      if (ytCues.length === 0) requestYoutubeTracksFromBridge();
    }, 2200);

    // Periodically ensure player controls & overlay are mounted as YouTube SPA navigates
    setInterval(() => {
      const isVideoPage =
        window.location.pathname.startsWith('/watch') ||
        window.location.pathname.startsWith('/shorts');
      if (!isVideoPage) {
        // Leaving a video is a session boundary, including returning to the same
        // video later without a fresh cue-track event (live-caption fallback).
        if (ytCurrentVideoId || ytTranslationBusy) {
          resetYoutubeTranslationSession();
          ytCurrentVideoId = '';
          clearYoutubeSourceCues();
        }
        if (ytAudioListenActive) stopYoutubeAudioListen();
        return;
      }

      if (ytNavigationPending) return;
      if (syncYoutubeVideoSession()) {
        ytBridgePollCount = 0;
        requestYoutubeTracksFromBridge();
      } else if (ytDualActive && ytCues.length === 0 && ytBridgePollCount < 6) {
        ytBridgePollCount++;
        requestYoutubeTracksFromBridge();
      }

      mountYoutubePlayerUI();
    }, 1200);

    requestAnimationFrame(syncYoutubeSubtitlesLoop);
  }

  function mountYoutubePlayerUI() {
    const player = document.querySelector('.html5-video-player');
    if (!player) return;

    const hasOverlayContent = Boolean(ytOverlayEl && ytOverlayEl.childElementCount > 0);
    player.classList.toggle(
      'ig-yt-dual-active',
      ytDualActive && (ytCues.length > 0 || hasOverlayContent)
    );

    // Bind seeked / play events on the video element for instant prefetching
    const video = player.querySelector('video');
    if (video && video !== ytBoundVideoEl) {
      ytBoundVideoEl = video;
      const triggerImmediatePrefetch = () => {
        ytLastRenderedSig = '';
        if (ytCues.length > 0) {
          prefetchYoutubeCuesAround(video.currentTime || 0);
        } else {
          requestYoutubeTracksFromBridge();
        }
      };
      video.addEventListener('seeked', () => { ytCurrentObservedCue = null; triggerImmediatePrefetch(); });
      video.addEventListener('playing', triggerImmediatePrefetch);
    }

    // 1. Dual Subtitle Overlay inside Player
    if (!ytOverlayEl || !player.contains(ytOverlayEl)) {
      ytOverlayEl = document.createElement('div');
      ytOverlayEl.className = 'ig-yt-dual-overlay';
      player.appendChild(ytOverlayEl);
    }

    // 2. Control Bar Button inside .ytp-right-controls
    const rightControls = player.querySelector('.ytp-right-controls');
    if (rightControls && (!ytCtrlBtnEl || !rightControls.contains(ytCtrlBtnEl))) {
      ytCtrlBtnEl = document.createElement('button');
      ytCtrlBtnEl.className = 'ytp-button ig-yt-ctrl-btn';
      ytCtrlBtnEl.title = '切换 AI 双语字幕 · 右键打开双语字幕列表';
      updateYoutubeControlButtonUI();

      ytCtrlBtnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        ytDualActive = !ytDualActive;
        resetYoutubeTranslationSession();
        if (!ytDualActive) stopYoutubeAudioListen();
        if (!ytDualActive && ytOverlayEl) ytOverlayEl.innerHTML = '';
        player.classList.toggle('ig-yt-dual-active', ytDualActive && ytCues.length > 0);
        ytLastRenderedSig = '';
        updateYoutubeControlButtonUI();
        if (ytDualActive && ytCues.length === 0) {
          requestYoutubeTracksFromBridge();
        }
      });

      ytCtrlBtnEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleYoutubeTimelineSidebar();
      });

      rightControls.insertBefore(ytCtrlBtnEl, rightControls.firstChild);
    }
    if (ytSidebarOpen && (!ytSidebarEl || !ytSidebarEl.isConnected || ytSidebarEl.style.display === 'none')) {
      ensureYoutubeTimelineSidebar();
      renderYoutubeTimelineList(true);
    }
  }

  function updateYoutubeControlButtonUI() {
    if (!ytCtrlBtnEl) return;
    ytCtrlBtnEl.innerHTML = `
      <span class="ig-yt-ctrl-pill ${ytDualActive ? 'is-on' : 'is-off'}">
        <span class="ig-yt-pill-check">${ytDualActive ? '✓' : ''}</span>
        <span>AI字幕</span>
        <span data-open-list="1" style="padding-left:5px;border-left:1px solid rgba(255,255,255,0.28);" title="展开双语字幕时间轴">☰</span>
      </span>
    `;
    ytCtrlBtnEl.querySelector('[data-open-list]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleYoutubeTimelineSidebar();
    });
  }

  function toggleYoutubeTimelineSidebar() {
    ytSidebarOpen = !ytSidebarOpen;
    if (!ytSidebarOpen) {
      if (ytSidebarEl) ytSidebarEl.style.display = 'none';
      disposeYoutubeTimeline();
      return;
    }
    ensureYoutubeTimelineSidebar();
    renderYoutubeTimelineList(ytCues.length === 0);
  }

  function ensureYoutubeTimelineSidebar() {
    if (ytSidebarEl && document.body.contains(ytSidebarEl)) {
      ytSidebarEl.style.display = 'flex';
      return;
    }

    disposeYoutubeTimeline();
    ytSidebarEl = document.createElement('div');
    ytSidebarEl.className = 'ig-yt-timeline-panel';
    ytSidebarEl.innerHTML = `
      <div class="ig-yt-timeline-header">
        <div class="ig-yt-timeline-title">✦ 双语字幕时间轴</div>
        <div class="ig-yt-timeline-actions">
          <button class="ig-yt-mini-btn" data-act="audio-listen" title="实验性音频切片听译：每 7 秒一片，另需模型响应时间；需要支持音频的 Gemini 原生模型">🎙️ 切片听译</button>
          <button class="ig-yt-mini-btn" data-act="export-srt" title="导出双语字幕（支持 Mac 直接打开的 .txt、一键复制或播放器 .srt）">导出字幕</button>
          <button class="ig-yt-mini-btn" data-act="close" title="关闭时间轴">✕</button>
        </div>
      </div>
      <div class="ig-yt-export-bar" data-yt-export-bar="1" hidden>
        <button class="ig-yt-export-opt" data-export-fmt="txt" title="Mac 双击直接用文本编辑打开，无安全拦截弹窗">📄 导出 .txt (直接打开)</button>
        <button class="ig-yt-export-opt" data-export-fmt="copy" title="复制当前已记录的原文及译文到剪贴板">📋 复制已记录字幕</button>
        <button class="ig-yt-export-opt" data-export-fmt="srt" title="下载标准 .srt 字幕文件（供 IINA / VLC / 剪映 导入）">🎬 导出 .srt</button>
      </div>
      <div data-yt-coverage="1" style="padding:8px 14px;color:#94a3b8;font-size:12px"></div>
      <div class="ig-yt-timeline-search">
        <input type="text" placeholder="搜索原文字幕或译文关键词…" data-yt-search="1" />
        <button class="ig-yt-mini-btn" data-act="follow-current" title="清除搜索并恢复跟随当前字幕">跟随播放中</button>
      </div>
      <div class="ig-yt-timeline-list" data-yt-list="1" tabindex="0" aria-label="字幕时间轴"></div>
    `;
    document.body.appendChild(ytSidebarEl);

    ytSidebarEl.querySelector('[data-act="close"]')?.addEventListener('click', () => {
      ytSidebarOpen = false;
      ytSidebarEl.style.display = 'none';
      disposeYoutubeTimeline();
    });

    const exportBar = ytSidebarEl.querySelector('[data-yt-export-bar]');
    ytSidebarEl.querySelector('[data-act="export-srt"]')?.addEventListener('click', () => {
      if (exportBar) {
        exportBar.hidden = !exportBar.hidden;
      }
    });

    ytSidebarEl.querySelectorAll('[data-export-fmt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fmt = btn.getAttribute('data-export-fmt') || 'txt';
        exportYoutubeBilingualSrt(fmt);
      });
    });

    const audioBtn = ytSidebarEl.querySelector('[data-act="audio-listen"]');
    audioBtn?.addEventListener('click', () => {
      toggleExperimentalAudioListen(audioBtn);
    });

    const searchInput = ytSidebarEl.querySelector('[data-yt-search]');
    searchInput?.addEventListener('input', () => {
      renderYoutubeTimelineList(false, searchInput.value.trim().toLowerCase());
    });
    ytSidebarEl.querySelector('[data-act="follow-current"]')?.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      renderYoutubeTimelineList(false, '');
      ytTimelineWindow?.followCurrent(ytTimelineCurrentCueId);
    });
  }

  function youtubeTimelineRange(offsets, scrollTop, viewportHeight) {
    const count = offsets.length - 1;
    if (!count) return { start: 0, end: 0 };
    const locate = value => {
      let lo = 0, hi = count;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (offsets[mid + 1] <= value) lo = mid + 1;
        else hi = mid;
      }
      return Math.min(lo, count - 1);
    };
    const first = locate(Math.max(0, scrollTop));
    const last = locate(Math.max(0, scrollTop) + Math.max(0, viewportHeight));
    const start = Math.max(0, first - 6);
    return { start, end: Math.min(count, Math.max(first + 1, last + 7), start + 40) };
  }

  function createYoutubeTimelineWindow(list) {
    let cues = [], offsets = [0], activeId = null, frame = 0, disposed = false;
    let rangeStart = -1, rangeEnd = -1, width = list.clientWidth;
    let followPlayback = true, searching = false;
    const followButton = list.parentElement?.querySelector('[data-act="follow-current"]');
    const updateFollowButton = () => {
      if (!followButton) return;
      const following = followPlayback && !searching;
      followButton.textContent = following ? '跟随播放中' : '返回当前句';
      followButton.disabled = following;
      followButton.setAttribute('aria-pressed', String(following));
    };
    const suspendFollow = () => { followPlayback = false; updateFollowButton(); };
    const onKeyDown = event => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) suspendFollow();
    };
    const heights = new Map();
    const rebuildOffsets = () => {
      offsets = [0];
      for (const cue of cues) offsets.push(offsets.at(-1) + (heights.get(String(cue.id))?.height || 96));
    };
    const anchor = () => {
      // Skip the small overscan prefix to find the actual first visible row.
      let actual = youtubeTimelineRange(offsets, list.scrollTop, 0).start;
      while (actual < cues.length - 1 && offsets[actual + 1] <= list.scrollTop) actual++;
      return { id: cues[actual]?.id, delta: list.scrollTop - (offsets[actual] || 0) };
    };
    const updateSpacers = () => {
      const top = list.querySelector('[data-yt-spacer="top"]');
      const bottom = list.querySelector('[data-yt-spacer="bottom"]');
      if (top) top.style.height = `${offsets[Math.max(0, rangeStart)] || 0}px`;
      if (bottom) bottom.style.height = `${Math.max(0, offsets.at(-1) - (offsets[Math.max(0, rangeEnd)] || 0))}px`;
    };
    const restoreAnchor = saved => {
      const index = cues.findIndex(cue => cue.id === saved.id);
      if (index >= 0) list.scrollTop = Math.max(0, offsets[index] + saved.delta);
    };
    const measure = () => {
      const saved = anchor();
      let changed = false;
      if (list.clientWidth !== width) { width = list.clientWidth; heights.clear(); changed = true; }
      for (const row of list.querySelectorAll('.ig-yt-cue-item')) {
        const height = Math.max(1, row.getBoundingClientRect().height + 6);
        const key = row.dataset.cueId;
        if (Math.abs((heights.get(key)?.height || 96) - height) > 0.5) {
          const cue = cues[Number(row.dataset.timelineIndex)];
          heights.set(key, { height, text: cue?.text, translation: cue?.translation });
          changed = true;
        }
      }
      if (changed) { rebuildOffsets(); updateSpacers(); restoreAnchor(saved); }
    };
    const draw = (force = false) => {
      if (disposed) return;
      const { start, end } = youtubeTimelineRange(offsets, list.scrollTop, list.clientHeight);
      if (force || start !== rangeStart || end !== rangeEnd) {
        observer?.disconnect();
        rangeStart = start; rangeEnd = end;
        list.innerHTML = `<div data-yt-spacer="top" aria-hidden="true"></div>` + cues.slice(start, end).map((cue, index) => `
          <div class="ig-yt-cue-item${cue.id === activeId ? ' is-current' : ''}" data-cue-id="${escapeText(String(cue.id))}" data-start="${cue.start}" data-timeline-index="${start + index}">
            <div class="ig-yt-cue-time">${formatSec(cue.start)}</div>
            <div class="ig-yt-cue-orig">${escapeText(cue.text)}</div>
            <div class="ig-yt-cue-trans">${escapeText(cue.translation || '…')}</div>
          </div>`).join('') + '<div data-yt-spacer="bottom" aria-hidden="true"></div>';
        observer?.observe(list);
        for (const row of list.querySelectorAll('.ig-yt-cue-item')) observer?.observe(row);
        schedule();
      }
      updateSpacers();
    };
    const schedule = () => {
      if (frame || disposed) return;
      frame = requestAnimationFrame(() => { frame = 0; if (!disposed) { measure(); draw(); } });
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    const onClick = event => {
      const row = event.target.closest('.ig-yt-cue-item');
      if (row && list.contains(row)) {
        followPlayback = true;
        updateFollowButton();
        window.postMessage({ source: 'IG_YT_CONTENT_SCRIPT', type: 'SEEK_VIDEO_TO', seconds: Number(row.dataset.start) }, '*');
      }
    };
    list.addEventListener('scroll', schedule, { passive: true });
    list.addEventListener('click', onClick);
    // Actual input suspends following; programmatic scrolls/anchor correction do not.
    list.addEventListener('wheel', suspendFollow, { passive: true });
    list.addEventListener('touchstart', suspendFollow, { passive: true });
    list.addEventListener('pointerdown', suspendFollow, { passive: true });
    list.addEventListener('keydown', onKeyDown);
    updateFollowButton();
    return {
      setCues(next, resetScroll = false, isSearching = false) {
        searching = isSearching;
        updateFollowButton();
        const saved = anchor();
        cues = next;
        const valid = new Set(cues.map(cue => String(cue.id)));
        for (const key of heights.keys()) if (!valid.has(key)) heights.delete(key);
        for (const cue of cues) {
          const measured = heights.get(String(cue.id));
          if (measured && (measured.text !== cue.text || measured.translation !== cue.translation)) heights.delete(String(cue.id));
        }
        rebuildOffsets(); draw(true);
        if (resetScroll) list.scrollTop = 0;
        else restoreAnchor(saved);
        draw();
      },
      highlight(id) {
        activeId = id;
        const index = cues.findIndex(cue => cue.id === id);
        if (index < 0) return;
        if (followPlayback && !searching && (offsets[index] < list.scrollTop || offsets[index + 1] > list.scrollTop + list.clientHeight)) list.scrollTop = offsets[index];
        draw();
        for (const row of list.querySelectorAll('.ig-yt-cue-item')) row.classList.toggle('is-current', row.dataset.cueId === String(id));
      },
      followCurrent(id) {
        followPlayback = true;
        updateFollowButton();
        if (id !== null) this.highlight(id);
      },
      dispose() {
        disposed = true; cancelAnimationFrame(frame); observer?.disconnect();
        list.removeEventListener('scroll', schedule); list.removeEventListener('click', onClick);
        list.removeEventListener('wheel', suspendFollow); list.removeEventListener('touchstart', suspendFollow);
        list.removeEventListener('pointerdown', suspendFollow); list.removeEventListener('keydown', onKeyDown);
        list.replaceChildren(); cues = []; offsets = [0]; heights.clear();
      }
    };
  }

  function renderYoutubeTimelineList(noCaptions = false, filterKeyword) {
    if (!ytSidebarEl || ytSidebarEl.style.display === 'none') return;
    const listEl = ytSidebarEl.querySelector('[data-yt-list]');
    if (!listEl) return;

    const timelineCues = getYoutubeTimelineCues();
    filterKeyword ??= ytSidebarEl.querySelector('[data-yt-search]')?.value.trim().toLowerCase() || '';
    const coverage = ytSidebarEl.querySelector('[data-yt-coverage]');
    if (coverage) coverage.textContent = youtubeCoverageText();
    if (noCaptions && timelineCues.length === 0) {
      disposeYoutubeTimeline();
      listEl.innerHTML = `
        <div style="padding:18px;text-align:center;color:#94a3b8;font-size:12.5px;line-height:1.6;">
          当前视频未检测到原生/自动字幕轨道。<br/>
          您可以点击上方 <b>🎙️ 切片听译</b>，尝试实验性 Gemini 音频切片听译（每 7 秒一片，另需模型响应时间）。
        </div>
      `;
      return;
    }

    const filtered = filterKeyword
      ? timelineCues.filter(
          (c) =>
            c.text.toLowerCase().includes(filterKeyword) ||
            (c.translation && c.translation.toLowerCase().includes(filterKeyword))
        )
      : timelineCues;

    const opening = !ytTimelineWindow;
    ytTimelineWindow ||= createYoutubeTimelineWindow(listEl);
    ytTimelineWindow.setCues(filtered, ytTimelineFilter !== filterKeyword, Boolean(filterKeyword));
    ytTimelineFilter = filterKeyword;
    if (opening && !filterKeyword && ytTimelineCurrentCueId !== null) ytTimelineWindow.highlight(ytTimelineCurrentCueId);
  }

  function formatSec(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }

  async function dispatchCueBatchTranslation(batch) {
    if (!batch || batch.length === 0 || !canRequestYoutubeTranslation()) return;
    ytTranslationBusy = true;
    const session = ytTranslationSession;
    batch.forEach((c) => ytInFlightBatchIds.add(c.id));

    const requestCues = ytCues;
    const requestVideoId = getCurrentYoutubeVideoId();
    const isCurrent = () => session === ytTranslationSession && requestCues === ytCues && requestVideoId === getCurrentYoutubeVideoId();
    const firstId = batch[0].id;
    const lastId = batch[batch.length - 1].id;
    const contextBefore = ytCues
      .slice(Math.max(0, firstId - 2), firstId)
      .map((c) => c.text)
      .join(' ');
    const contextAfter = ytCues
      .slice(lastId + 1, lastId + 3)
      .map((c) => c.text)
      .join(' ');

    try {
      const res = await safeRuntimeSendMessage({
        type: 'TRANSLATE_YOUTUBE_CUES',
        payload: {
          cues: batch.map((c) => ({ id: c.id, text: c.text })),
          contextBefore,
          contextAfter,
          videoTitle: ytVideoTitle
        }
      });

      if (!isCurrent()) return;
      if (res && res.ok && Array.isArray(res.data?.cues) && res.data.cues.some(c => c.translation)) {
        clearYoutubeTranslationFailure();
        for (const item of res.data.cues) {
          const target = ytCues.find((c) => Number(c.id) === Number(item.id));
          if (target && item.translation) {
            target.translation = item.translation;
            const row = ytSidebarEl?.querySelector(`.ig-yt-cue-item[data-cue-id="${target.id}"] .ig-yt-cue-trans`);
            if (row) row.textContent = item.translation;
          }
        }
        // Keep the existing long timeline DOM unless translation changes affect a search.
        if (ytSidebarEl?.querySelector('[data-yt-search]')?.value.trim()) renderYoutubeTimelineList();
        const coverage = ytSidebarEl?.querySelector('[data-yt-coverage]');
        if (coverage) coverage.textContent = youtubeCoverageText();
        ytLastRenderedSig = ''; // Trigger immediate overlay refresh even if paused
      } else {
        if (!res?.cancelled) recordYoutubeTranslationFailure(res?.error ? res : '模型未返回有效字幕译文，请重试');
      }
    } catch (error) {
      if (isCurrent()) recordYoutubeTranslationFailure(error);
    } finally {
      if (isCurrent()) {
        batch.forEach((c) => ytInFlightBatchIds.delete(c.id));
        ytTranslationBusy = false;
      }
    }
  }

  /**
   * Two-tier subtitle prefetching:
   * 1. Fast-First-Paint Micro-Batch (first 3 untranslated cues right at currentTime) -> ~350ms latency
   * 2. Lookahead Batch (next 10 cues in [currentTime, currentTime + 75s]) -> pre-cached seamlessly
   */
  function prefetchYoutubeCuesAround(currentTime) {
    if (!canRequestYoutubeTranslation() || ytCues.length === 0) return;
    const windowEnd = currentTime + 75;
    const candidates = ytCues.filter(
      (c) =>
        c.end >= currentTime - 1.5 &&
        c.start <= windowEnd &&
        !c.translation &&
        !ytInFlightBatchIds.has(c.id)
    );

    if (candidates.length === 0) return;

    // Check if the immediate cue (within next 10s) is untranslated; otherwise prefetch lookahead window
    const urgent = candidates.filter((c) => c.start <= currentTime + 10).slice(0, 3);
    dispatchCueBatchTranslation(urgent.length > 0 ? urgent : candidates.slice(0, 10));
  }

  function isMostlyChineseText(str) {
    if (!str) return false;
    const cjk = (str.match(/[\u4e00-\u9fff]/g) || []).length;
    return cjk / str.length > 0.2;
  }

  async function translateLiveYoutubeCaptionText(rawText) {
    if (!canRequestYoutubeTranslation() || !rawText || ytLiveCaptionCache.has(rawText) || ytLiveCaptionInFlight.has(rawText)) return;
    if (isMostlyChineseText(rawText) && /^zh/i.test(settings.targetLang || 'zh-CN')) return;
    const session = ytTranslationSession;
    ytTranslationBusy = true;
    const requestCues = ytCues;
    const requestVideoId = getCurrentYoutubeVideoId();
    const isCurrent = () => session === ytTranslationSession && requestCues === ytCues && requestVideoId === getCurrentYoutubeVideoId();
    ytLiveCaptionInFlight.add(rawText);
    try {
      const res = await safeRuntimeSendMessage({
        type: 'TRANSLATE_YOUTUBE_CUES',
        payload: {
          cues: [{ id: 1, text: rawText }],
          contextBefore: '',
          contextAfter: '',
          videoTitle: ytVideoTitle || document.title
        }
      });
      if (!isCurrent()) return;
      const trans = res?.ok && res?.data?.cues?.[0]?.translation;
      if (trans) {
        clearYoutubeTranslationFailure();
        ytLiveCaptionCache.set(rawText, trans);
        if (ytLiveCaptionCache.size > 1000) ytLiveCaptionCache.delete(ytLiveCaptionCache.keys().next().value);
        for (const cue of ytObservedCues) if (cue.text === rawText) cue.translation = trans;
        renderYoutubeTimelineList();
        ytLastRenderedSig = '';
      } else if (!res?.cancelled) {
        recordYoutubeTranslationFailure(res?.error ? res : '模型未返回有效字幕译文，请重试');
      }
    } catch (error) {
      if (isCurrent()) recordYoutubeTranslationFailure(error);
    } finally {
      if (isCurrent()) {
        ytLiveCaptionInFlight.delete(rawText);
        ytTranslationBusy = false;
      }
    }
  }

  function syncYoutubeSubtitlesLoop() {
    const isVideoRoute =
      window.location.hostname.includes('youtube.com') &&
      (window.location.pathname.startsWith('/watch') ||
        window.location.pathname.startsWith('/shorts'));

    if (!ytNavigationPending) syncYoutubeVideoSession();
    if (!isVideoRoute || ytNavigationPending || !ytDualActive || document.hidden) {
      setTimeout(syncYoutubeSubtitlesLoop, 600);
      return;
    }

    const player = document.querySelector('.html5-video-player');
    if (player?.classList?.contains?.('ad-showing') || player?.classList?.contains?.('ad-interrupting')) {
      setTimeout(syncYoutubeSubtitlesLoop, 600);
      return;
    }
    const video = player ? player.querySelector('video') : document.querySelector('video');

    if (ytCues.length > 0 && video) {
      const t = video.currentTime;
      const activeCue = ytCues.find((c) => t >= c.start && t <= c.end);

      if (activeCue) {
        const pendingText = youtubePendingTranslationText();
        const sig = `cue:${activeCue.id}|${activeCue.translation || pendingText}`;
        if (sig !== ytLastRenderedSig) {
          ytLastRenderedSig = sig;
          if (ytOverlayEl) {
            ytOverlayEl.innerHTML = `
              <div class="ig-yt-sub-box">
                <div class="ig-yt-line-orig">${escapeText(activeCue.text)}</div>
                <div class="ig-yt-line-trans">${escapeText(
                  activeCue.translation || pendingText
                )}</div>
              </div>
            `;
          }
          if (player) player.classList.add('ig-yt-dual-active');
          highlightCurrentTimelineCue(activeCue.id);
        }
        prefetchYoutubeCuesAround(t);
      } else if (ytOverlayEl && ytLastRenderedSig !== '') {
        ytLastRenderedSig = '';
        ytOverlayEl.innerHTML = '';
      }
    } else if (player) {
      // Fallback: Read live native captions from .ytp-caption-window-container .ytp-caption-segment
      // when YouTube's timedtext endpoint requires a POT token or on live streams
      const segments = player.querySelectorAll(
        '.ytp-caption-window-container .ytp-caption-segment'
      );
      const liveText = Array.from(segments)
        .map((s) => (s.textContent || '').trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (liveText) {
        const isAlreadyTargetChinese =
          isMostlyChineseText(liveText) && /^zh/i.test(settings.targetLang || 'zh-CN');
        observeYoutubeLiveCaption(liveText, video?.currentTime || 0,
          isAlreadyTargetChinese ? liveText : ytLiveCaptionCache.get(liveText) || '');
        if (isAlreadyTargetChinese) {
          const sig = `live-zh:${liveText}`;
          if (sig !== ytLastRenderedSig) {
            ytLastRenderedSig = sig;
            if (ytOverlayEl) {
              ytOverlayEl.innerHTML = `
                <div class="ig-yt-sub-box">
                  <div class="ig-yt-line-trans">${escapeText(liveText)}</div>
                </div>
              `;
            }
            player.classList.add('ig-yt-dual-active');
          }
        } else {
          const cachedTrans = ytLiveCaptionCache.get(liveText) || '';
          if (!cachedTrans) {
            translateLiveYoutubeCaptionText(liveText);
          }
          const pendingText = youtubePendingTranslationText();
          const sig = `live:${liveText}|${cachedTrans || pendingText}`;
          if (sig !== ytLastRenderedSig) {
            ytLastRenderedSig = sig;
            if (ytOverlayEl) {
              ytOverlayEl.innerHTML = `
                <div class="ig-yt-sub-box">
                  <div class="ig-yt-line-orig">${escapeText(liveText)}</div>
                  <div class="ig-yt-line-trans">${escapeText(
                    cachedTrans || pendingText
                  )}</div>
                </div>
              `;
            }
            player.classList.add('ig-yt-dual-active');
          }
        }
      } else {
        ytCurrentObservedCue = null;
        if (ytOverlayEl && ytLastRenderedSig !== '') {
          ytLastRenderedSig = '';
          ytOverlayEl.innerHTML = '';
        }
        player.classList.remove('ig-yt-dual-active');
      }
    }

    const nextDelayMs = video && video.paused ? 260 : 85;
    setTimeout(syncYoutubeSubtitlesLoop, nextDelayMs);
  }

  function highlightCurrentTimelineCue(cueId) {
    ytTimelineCurrentCueId = cueId;
    if (!ytSidebarEl || ytSidebarEl.style.display === 'none') return;
    ytTimelineWindow?.highlight(cueId);
  }

  /**
   * Experimental Gemini audio-slice translation for videos without native captions.
   */
  function stopYoutubeAudioListen() {
    audioRequests.cancel();
    ytAudioListenActive = false;
    ytAudioSession++;
    ytAudioCleanup?.();
    ytAudioCleanup = null;
    ytAudioStream?.getTracks().forEach(track => track.stop());
    ytAudioStream = null;
    ytAudioRecorder = null;
    if (ytAudioButton) {
      ytAudioButton.classList.remove('is-active');
      ytAudioButton.textContent = '🎙️ 切片听译';
    }
  }

  async function toggleExperimentalAudioListen(btnEl) {
    if (ytAudioListenActive) {
      stopYoutubeAudioListen();
      showPageToast('已停止 AI 音频切片听译', 'info');
      return;
    }
    const activeProtocol = globalThis.QingJianSettings.resolveProtocol(settings);
    if (activeProtocol !== 'gemini') {
      showPageToast('音频听译需要支持音频的 Gemini 原生协议模型，当前 OpenAI 兼容接口不支持。', 'warn', true);
      return;
    }
    const video = document.querySelector('video');
    if (!video) {
      showPageToast('未找到正在播放的视频元素', 'warn');
      return;
    }

    const captureFn = video.captureStream || video.mozCaptureStream;
    if (typeof captureFn !== 'function') {
      showPageToast('当前浏览器环境不支持视频流音频捕获', 'warn');
      return;
    }

    try {
      const stream = captureFn.call(video);
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        stream.getTracks().forEach(track => track.stop());
        showPageToast('请确保视频未静音且正在播放', 'warn');
        return;
      }

      const audioStream = new MediaStream(audioTracks);
      ytAudioStream = stream;
      ytAudioButton = btnEl;
      const session = ++ytAudioSession;
      const videoId = getCurrentYoutubeVideoId();
      const isCurrent = () => ytAudioListenActive && session === ytAudioSession && videoId === getCurrentYoutubeVideoId();
      const pendingSlices = new Set();
      let latestSliceStart = -1;
      let segmentGeneration = 0;
      let activeSlice = null;
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      ytAudioListenActive = true;
      btnEl.classList.add('is-active');
      btnEl.textContent = '⏹ 停止听译';
      showPageToast('🎙️ 已开启实验性音频切片听译（每 7 秒上传，另需模型响应时间）', 'success');

      let previousSpoken = '';

      const finishSlice = (discard = false) => {
        const slice = activeSlice;
        if (!slice) return;
        activeSlice = null;
        clearTimeout(slice.timer);
        slice.discard = discard;
        // Capture media time BEFORE awaiting data delivery or a model response.
        slice.end = video.currentTime;
        if (slice.recorder.state !== 'inactive') {
          try { slice.recorder.stop(); } catch { slice.discard = true; }
        }
      };

      const recordSlice = () => {
        if (!isCurrent() || activeSlice || video.paused || video.seeking || video.ended) return;
        const sliceStart = video.currentTime;
        const chunks = [];
        let recorder;
        try { recorder = new MediaRecorder(audioStream, { mimeType }); }
        catch (error) {
          stopYoutubeAudioListen();
          showPageToast(`音频录制失败: ${error?.message || error}`, 'warn');
          return;
        }
        ytAudioRecorder = recorder;
        const slice = { recorder, start: sliceStart, end: null, generation: segmentGeneration, discard: false, timer: null };
        activeSlice = slice;
        const ownsSlice = () => isCurrent() && !slice.discard && slice.generation === segmentGeneration;

        recorder.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) chunks.push(ev.data);
        };
        recorder.onerror = () => {
          if (isCurrent()) {
            stopYoutubeAudioListen();
            showPageToast('音频录制失败，已停止听译，请重新尝试。', 'warn');
          }
        };

        recorder.onstop = async () => {
          // An unexpected recorder stop must not leave the session holding a dead slice.
          if (activeSlice === slice) {
            activeSlice = null;
            clearTimeout(slice.timer);
            slice.end = video.currentTime;
          }
          if (!ownsSlice() || chunks.length === 0 || !Number.isFinite(slice.start) || !Number.isFinite(slice.end) || slice.end <= slice.start) return;
          if (pendingSlices.size >= 2) {
            stopYoutubeAudioListen();
            showPageToast('模型响应过慢，已停止听译以避免请求积压，请稍后重试。', 'warn');
            return;
          }
          pendingSlices.add(slice);
          const blob = new Blob(chunks, { type: mimeType });
          try {
            const base64 = await blobToBase64(blob);
            if (!ownsSlice()) return;
            const res = await sendModelRequest({
              type: 'TRANSLATE_YOUTUBE_AUDIO',
              payload: {
                audioBase64: base64,
                mimeType: 'audio/webm',
                previousContext: previousSpoken,
                videoTitle: ytVideoTitle || document.title
              }
            });
            if (!ownsSlice()) return;
            if (!res?.ok) throw new Error(res?.error || '音频翻译失败');
            if (res.data?.original) {
              if (sliceStart >= latestSliceStart) {
                previousSpoken = res.data.original;
                latestSliceStart = sliceStart;
              }
              const newCue = {
                id: ytCues.length,
                start: sliceStart,
                end: slice.end,
                text: res.data.original,
                translation: res.data.translation || ''
              };
              // Reindexing changes cue identity: invalidate old batch callbacks too.
              ytCaptionSource = 'audio';
              ytCues = [...ytCues, newCue].sort((a, b) => a.start - b.start)
                .map((cue, index) => ({ ...cue, id: index }));
              subtitleRequests.cancel();
              ytInFlightBatchIds.clear();
              ytLiveCaptionInFlight.clear();
              if (ytOverlayEl && sliceStart === latestSliceStart) {
                ytOverlayEl.innerHTML = `
                  <div class="ig-yt-sub-box">
                    <div class="ig-yt-line-orig">${escapeText(newCue.text)}</div>
                    <div class="ig-yt-line-trans">${escapeText(newCue.translation)}</div>
                  </div>
                `;
              }
              renderYoutubeTimelineList(false);
            }
          } catch (err) {
            if (ownsSlice()) {
              stopYoutubeAudioListen();
              showPageToast(`音频听译已停止: ${err?.message || err}`, 'warn');
            }
          } finally {
            pendingSlices.delete(slice);
          }
        };

        try { recorder.start(); }
        catch (error) {
          stopYoutubeAudioListen();
          showPageToast(`音频录制失败: ${error?.message || error}`, 'warn');
          return;
        }
        slice.timer = setTimeout(() => {
          if (!isCurrent() || activeSlice !== slice) return;
          finishSlice();
          recordSlice();
        }, 7000);
      };

      const onPause = () => finishSlice();
      const onSeeking = () => {
        // A seek is a discontinuity: queued audio/context from the previous position is stale.
        segmentGeneration++;
        finishSlice(true);
        audioRequests.cancel();
        pendingSlices.clear();
        previousSpoken = '';
        latestSliceStart = -1;
      };
      const onRateChange = () => { finishSlice(); recordSlice(); };
      const listeners = [['pause', onPause], ['ended', onPause], ['seeking', onSeeking],
        ['seeked', recordSlice], ['playing', recordSlice], ['ratechange', onRateChange]];
      for (const [event, listener] of listeners) video.addEventListener(event, listener);
      ytAudioCleanup = () => {
        finishSlice(true);
        for (const [event, listener] of listeners) video.removeEventListener(event, listener);
        pendingSlices.clear();
      };
      recordSlice();
    } catch (err) {
      stopYoutubeAudioListen();
      showPageToast(`音频听译启动失败: ${err?.message || err}`, 'warn');
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const str = String(reader.result || '');
        resolve(str.split(',')[1] || '');
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function sanitizeSubtitleBaseName(rawTitle) {
    const cleaned = String(rawTitle || 'youtube-subtitles')
      .replace(/^\(\d+\)\s*/g, '')
      .replace(/\s*-\s*YouTube$/i, '')
      .replace(/[\\/:*?"<>|()[\]{}'`~#%&$!+=;]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 72);
    return cleaned || 'youtube-subtitles';
  }

  function exportYoutubeBilingualSrt(format = 'txt') {
    const cues = getYoutubeTimelineCues();
    const partial = !ytCues.length || ytCaptionSource === 'audio';
    if (cues.length === 0) {
      showPageToast('暂无可导出的字幕数据', 'warn');
      return;
    }
    const formatSrt = (sec) => {
      const totalMs = Math.max(0, Math.round((Number(sec) || 0) * 1000));
      const s = Math.floor(totalMs / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sc = Math.floor(s % 60);
      const ms = totalMs % 1000;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sc).padStart(
        2,
        '0'
      )},${String(ms).padStart(3, '0')}`;
    };

    const srtContent = cues
      .map(
        (c, i) =>
          `${i + 1}\n${formatSrt(c.start)} --> ${formatSrt(c.end)}\n${c.text}\n${
            c.translation || ''
          }\n`
      )
      .join('\n');

    if (format === 'copy') {
      const readableText = youtubeCoverageText() + '\n\n' + cues
        .map(
          (c) =>
            `[${formatSec(c.start)}] ${c.text}${c.translation ? `\n${c.translation}` : ''}`
        )
        .join('\n\n');
      navigator.clipboard
        .writeText(readableText)
        .then(() => {
          showPageToast('✅ 已复制当前已记录字幕到剪贴板', 'success');
        })
        .catch(() => {
          showPageToast('复制失败，请使用导出 .txt 文件', 'warn');
        });
      return;
    }

    const baseName = sanitizeSubtitleBaseName(ytVideoTitle || document.title);
    const isTxt = format === 'txt';
    const ext = `${partial ? 'observed-partial' : 'bilingual'}.${isTxt ? 'txt' : 'srt'}`;
    const fileHeader = isTxt
      ? `# ${baseName} — 双语字幕对照 (青简 · 译读)\n# ${youtubeCoverageText()}\n# 可直接阅读；播放器请使用单独的 .srt 导出\n\n`
      : '';
    const finalPayload = `\uFEFF${fileHeader}${srtContent}`;

    const blob = new Blob([finalPayload], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);

    if (isTxt) {
      showPageToast('📄 已导出双语字幕 (.txt)，在 Mac 上可直接双击打开阅读', 'success');
    } else {
      showPageToast('🎬 已导出 .srt 字幕（Mac 若双击拦截，请右键「打开方式 → 文本编辑/IINA」或使用 .txt 导出）', 'success');
    }
  }

  // ============================================================================
  // 8B. Webpage & X.com Image OCR & In-Place Translation Engine
  // ============================================================================

  const IMAGE_CONTAINER_SELECTORS =
    '[data-testid="tweetPhoto"] img, article img, main figure img, figure img, [role="article"] img, .markdown-body img';
  let lastContextMenuImage = null;

  function isTranslatableContentImage(img, requireStrictContainer = false) {
    if (!img || img.nodeType !== Node.ELEMENT_NODE || img.tagName.toLowerCase() !== 'img') {
      return false;
    }
    const src = img.currentSrc || img.src || '';
    if (!src || src.startsWith('chrome-extension://')) return false;

    // Exclude avatars, emojis, logos, and tiny decorative icons
    if (
      img.closest(
        '[data-testid="Tweet-User-Avatar"], [data-testid="UserAvatar-Container-unknown"], [class*="avatar" i], [class*="emoji" i], [class*="logo" i], .ig-img-overlay-layer, .ig-img-control-bar'
      )
    ) {
      return false;
    }

    const inPrimaryContent = Boolean(
      img.closest('[data-testid="tweetPhoto"], article, figure, main, [role="article"], .markdown-body')
    );
    if (requireStrictContainer && !inPrimaryContent) {
      return false;
    }

    const rect = img.getBoundingClientRect();
    const w = Math.max(rect.width || 0, img.naturalWidth || 0, img.width || 0);
    const h = Math.max(rect.height || 0, img.naturalHeight || 0, img.height || 0);

    if (inPrimaryContent) {
      return w >= 120 && h >= 80;
    }
    return w >= 200 && h >= 120;
  }

  function ensureImageHostContainer(img) {
    const tweetPhotoHost = img.closest('[data-testid="tweetPhoto"]');
    const host = tweetPhotoHost || img.parentElement;
    if (!host) return null;
    const style = window.getComputedStyle(host);
    if (style.position === 'static') {
      host.classList.add('ig-img-host-rel');
    }
    return host;
  }

  function scanAndObserveImagesInContainer(root = document.body) {
    if (!root || !viewportObserver) return;
    const imgs = [];
    if (root.matches && root.matches('img')) {
      imgs.push(root);
    }
    if (root.querySelectorAll) {
      root.querySelectorAll(IMAGE_CONTAINER_SELECTORS).forEach((img) => imgs.push(img));
    }

    for (const img of imgs) {
      if (img.dataset.igImgStatus) continue;
      if (!isTranslatableContentImage(img, true)) continue;
      mountImageControlBar(img);
      if (settings.autoTranslatePageImages !== false) {
        img.dataset.igImgStatus = 'observed';
        viewportObserver.observe(img);
      }
    }
  }

  const imageControlBars = new WeakMap();
  const imageControlOwners = new WeakMap();
  const imageSources = new WeakMap();

  function imageSourceSignature(img) {
    return [img.currentSrc || '', img.src || '', img.srcset || '', img.sizes || ''].join('\n');
  }

  function invalidateChangedImageSource(img) {
    const signature = imageSourceSignature(img);
    const previous = imageSources.get(img);
    imageSources.set(img, signature);
    if (previous === undefined || previous === signature) return false;
    imageTranslationTasks.delete(img);
    viewportObserver?.unobserve(img);
    delete img.dataset.igImgStatus;
    releaseImageControls(imageControlBars.get(img));
    return true;
  }

  function releaseImageControls(bar) {
    if (!bar) return;
    const owner = imageControlOwners.get(bar);
    if (owner) {
      imageControlBars.delete(owner);
      delete owner.dataset.igHoverBound;
    }
    imageControlOwners.delete(bar);
    bar.parentElement?.querySelectorAll(':scope > .ig-img-overlay-layer, :scope > .ig-img-bilingual-drawer')
      .forEach(node => node.remove());
    bar.remove();
  }

  function mountImageControlBar(img) {
    invalidateChangedImageSource(img);
    const host = ensureImageHostContainer(img);
    if (!host) return null;
    let bar = host.querySelector(':scope > .ig-img-control-bar');
    if (bar && imageControlOwners.get(bar)?.isConnected === false) {
      releaseImageControls(bar);
      bar = null;
    }
    if (bar) return bar;

    bar = document.createElement('div');
    bar.className = 'notranslate ig-img-control-bar';
    imageControlBars.set(img, bar);
    imageControlOwners.set(bar, img);
    bar.setAttribute('translate', 'no');

    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'ig-img-ctrl-btn';
    actionBtn.dataset.role = 'trigger';
    actionBtn.textContent = '🖼️ AI 译图';
    actionBtn.title = '自动识别图片中的外文并原位叠加中文译文（悬停文字可透视原图）';

    const preventNav = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };

    actionBtn.addEventListener('click', (e) => {
      preventNav(e);
      const overlay = host.querySelector(':scope > .ig-img-overlay-layer');
      if (overlay && img.dataset.igImgStatus === 'done') {
        const hidden = overlay.classList.toggle('is-hidden');
        actionBtn.classList.toggle('is-active', !hidden);
        actionBtn.textContent = hidden ? '👁️ 原图 (点此显译文)' : '✓ 译图开启';
        return;
      }
      translateImageElement(img, { isAuto: false });
    });

    bar.appendChild(actionBtn);
    host.appendChild(bar);
    return bar;
  }

  async function extractImagePayload(img, fallbackUrl = '') {
    const src = fallbackUrl || img?.currentSrc || img?.src || '';
    if (src.startsWith('data:image/')) {
      const m = src.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (m) {
        return { mimeType: m[1], imageBase64: m[2], imageUrl: '' };
      }
    }
    // For blob: URLs or same-origin images, try canvas extraction first
    if (img && (src.startsWith('blob:') || src.startsWith(window.location.origin))) {
      try {
        const canvas = document.createElement('canvas');
        const w = Math.min(1600, img.naturalWidth || img.width || 800);
        const h = Math.min(1600, img.naturalHeight || img.height || 600);
        if (w > 0 && h > 0) {
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
          const base64 = dataUrl.split(',')[1] || '';
          if (base64) {
            return { mimeType: 'image/jpeg', imageBase64: base64, imageUrl: src };
          }
        }
      } catch (_) {
        // Cross-origin canvas taint; fall back to service worker fetch via imageUrl
      }
    }
    return { imageUrl: src, imageBase64: '', mimeType: 'image/jpeg' };
  }

  const imageTranslationTasks = new WeakMap();

  async function translateImageElement(img, options = {}) {
    const { isAuto = false, fallbackSrcUrl = '' } = options;
    if (!img && !fallbackSrcUrl) return;

    if (img) {
      invalidateChangedImageSource(img);
      if (img.dataset.igImgStatus === 'loading') return;
      img.dataset.igImgStatus = 'loading';
    }
    const task = {};
    if (img) imageTranslationTasks.set(img, task);
    const sourceUrl = img ? imageSourceSignature(img) : '';
    const ownsImage = () => !img || imageTranslationTasks.get(img) === task;
    const signal = pageRequests.signal;
    const isCurrent = () => !signal.aborted && ownsImage() &&
      (!img || (img.isConnected !== false && imageSourceSignature(img) === sourceUrl));

    const host = img ? ensureImageHostContainer(img) : null;
    const bar = img ? mountImageControlBar(img) : null;
    const triggerBtn = bar?.querySelector('[data-role="trigger"]');

    if (triggerBtn) {
      triggerBtn.textContent = '⏳ 识别译图中…';
    } else if (!isAuto) {
      showPageToast('正在识别图片中的文字并翻译…', 'info');
    }

    const resetCancelledImageState = () => {
      if (!ownsImage()) return;
      if (img && img.dataset.igImgStatus === 'loading') delete img.dataset.igImgStatus;
      if (triggerBtn) triggerBtn.textContent = '🖼️ AI 译图';
    };
    try {
      const payload = await extractImagePayload(img, fallbackSrcUrl);
      if (!isCurrent()) {
        resetCancelledImageState();
        return;
      }
      const response = await sendModelRequest({
        type: 'TRANSLATE_IMAGE',
        payload: {
          ...payload,
          targetLang: settings.targetLang,
          pageTitle: document.title
        }
      });

      if (!isCurrent() || response?.cancelled) {
        resetCancelledImageState();
        return;
      }
      if (!response || !response.ok) {
        throw new Error(response?.error || '图片文字翻译请求失败');
      }

      const data = response.data || {};
      const regions = Array.isArray(data.regions) ? data.regions : [];
      const hasText = Boolean(data.hasText && (regions.length > 0 || data.summaryTranslation));

      if (!hasText) {
        if (img) img.dataset.igImgStatus = 'empty';
        if (triggerBtn) {
          triggerBtn.textContent = isAuto ? '🖼️ AI 译图' : '🖼️ 未检测到外文';
        }
        if (!isAuto) {
          showPageToast('图片中未检测到需要翻译的外文内容', 'info');
        }
        return;
      }

      if (img && host) {
        await renderImageTranslationOverlay(host, img, data, regions, bar, triggerBtn, isCurrent);
        if (!isCurrent()) {
          resetCancelledImageState();
          return;
        }
        img.dataset.igImgStatus = 'done';
        if (!isAuto) {
          showPageToast(`已完成图片文字翻译（共识别 ${regions.length} 处文本区块）`, 'success');
        }
      } else if (data.summaryTranslation) {
        openSelectionExplanationCard({
          text: regions.map((r) => r.original).join('\n') || 'Image OCR',
          contextParagraph: data.summaryTranslation,
          x: window.innerWidth / 2 - 160,
          y: 120
        });
      }
    } catch (err) {
      if (!isCurrent()) {
        resetCancelledImageState();
        return;
      }
      if (img) delete img.dataset.igImgStatus;
      if (triggerBtn) {
        triggerBtn.textContent = '⚠️ 译图重试';
      }
      if (!isAuto) {
        showPageToast(`图片翻译失败: ${err?.message || err}`, 'warn');
      }
    } finally {
      if (img && ownsImage()) imageTranslationTasks.delete(img);
    }
  }

  function sampleWebImageRegionColors(ctx, canvasW, canvasH, x, y, w, h) {
    const sx = Math.max(0, Math.floor(x - 3));
    const sy = Math.max(0, Math.floor(y - 3));
    const sw = Math.min(canvasW - sx, Math.ceil(w + 6));
    const sh = Math.min(canvasH - sy, Math.ceil(h + 6));
    if (sw <= 1 || sh <= 1) {
      return { bgCss: 'rgb(255, 255, 255)', textCss: 'rgb(15, 23, 42)' };
    }
    try {
      const imgData = ctx.getImageData(sx, sy, sw, sh).data;
      const borderSamples = [];
      for (let py = 0; py < sh; py++) {
        for (let px = 0; px < sw; px++) {
          if (px <= 2 || px >= sw - 3 || py <= 2 || py >= sh - 3) {
            const idx = (py * sw + px) * 4;
            if (imgData[idx + 3] < 128) continue;
            const r = imgData[idx];
            const g = imgData[idx + 1];
            const b = imgData[idx + 2];
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            borderSamples.push({ r, g, b, lum });
          }
        }
      }
      let bg = { r: 255, g: 255, b: 255, lum: 255 };
      if (borderSamples.length > 0) {
        borderSamples.sort((a, b) => a.lum - b.lum);
        bg = borderSamples[Math.min(borderSamples.length - 1, Math.floor(borderSamples.length * 0.65))];
      }
      const innerContrast = [];
      for (let py = 2; py < sh - 2; py += 2) {
        for (let px = 2; px < sw - 2; px += 2) {
          const idx = (py * sw + px) * 4;
          const r = imgData[idx];
          const g = imgData[idx + 1];
          const b = imgData[idx + 2];
          const dist = Math.hypot(r - bg.r, g - bg.g, b - bg.b);
          if (dist > 45) {
            innerContrast.push({ r, g, b, dist });
          }
        }
      }
      let fg = bg.lum > 140 ? { r: 15, g: 23, b: 42 } : { r: 248, g: 250, b: 252 };
      if (innerContrast.length >= 3) {
        innerContrast.sort((a, b) => b.dist - a.dist);
        const topN = innerContrast.slice(0, Math.min(12, innerContrast.length));
        fg = {
          r: Math.round(topN.reduce((s, p) => s + p.r, 0) / topN.length),
          g: Math.round(topN.reduce((s, p) => s + p.g, 0) / topN.length),
          b: Math.round(topN.reduce((s, p) => s + p.b, 0) / topN.length)
        };
      }
      return {
        bgCss: `rgb(${bg.r}, ${bg.g}, ${bg.b})`,
        textCss: `rgb(${fg.r}, ${fg.g}, ${fg.b})`
      };
    } catch (_) {
      return { bgCss: 'rgb(255, 255, 255)', textCss: 'rgb(15, 23, 42)' };
    }
  }

  function wrapCanvasTextLines(ctx, text, maxWidth) {
    const clean = String(text || '').trim();
    if (!clean) return [];
    if (ctx.measureText(clean).width <= maxWidth) return [clean];
    const tokens = clean.match(/([A-Za-z0-9_+-]+|\s+|[^\sA-Za-z0-9_+-])/g) || [clean];
    const lines = [];
    let current = '';
    for (const tk of tokens) {
      const next = current + tk;
      if (current && ctx.measureText(next).width > maxWidth) {
        lines.push(current.trim());
        current = tk.trimStart();
      } else {
        current = next;
      }
    }
    if (current.trim()) lines.push(current.trim());
    return lines;
  }

  async function inpaintWebpageImageRegions(imageDataUrl, regions) {
    if (!imageDataUrl) return null;
    const bitmap = await new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = imageDataUrl;
    });
    if (!bitmap) return null;

    const canvas = document.createElement('canvas');
    const W = bitmap.naturalWidth || bitmap.width || 800;
    const H = bitmap.naturalHeight || bitmap.height || 600;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, W, H);

    const fontStack = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", -apple-system, sans-serif';
    const prepared = [];

    for (const reg of regions) {
      if (!reg.translation || !Array.isArray(reg.box_2d) || reg.box_2d.length < 4) continue;
      const [ymin, xmin, ymax, xmax] = reg.box_2d;
      const x = Math.max(0, (xmin / 1000) * W);
      const y = Math.max(0, (ymin / 1000) * H);
      const w = Math.max(16, Math.min(W - x, ((xmax - xmin) / 1000) * W));
      const h = Math.max(12, Math.min(H - y, ((ymax - ymin) / 1000) * H));
      const colors = sampleWebImageRegionColors(ctx, W, H, x, y, w, h);
      prepared.push({ reg, x, y, w, h, colors });
    }

    for (const item of prepared) {
      ctx.fillStyle = item.colors.bgCss;
      ctx.fillRect(item.x, item.y, item.w, item.h);
    }

    for (const item of prepared) {
      const { reg, x, y, w, h, colors } = item;
      const maxFont = Math.min(42, Math.max(11, Math.round(h * 0.72)));
      const minFont = 10;
      let chosenFont = minFont;
      let chosenLines = [reg.translation];

      for (let fs = maxFont; fs >= minFont; fs -= 1) {
        ctx.font = `500 ${fs}px ${fontStack}`;
        const lines = wrapCanvasTextLines(ctx, reg.translation, Math.max(24, w - 4));
        const totalH = lines.length * fs * 1.18;
        const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
        if (totalH <= h + 4 && widest <= w + 6) {
          chosenFont = fs;
          chosenLines = lines;
          break;
        }
        chosenLines = lines;
      }

      ctx.font = `500 ${chosenFont}px ${fontStack}`;
      ctx.fillStyle = colors.textCss;
      ctx.textBaseline = 'middle';
      ctx.textAlign = chosenLines.length === 1 ? 'center' : 'left';

      const lineH = chosenFont * 1.18;
      const blockH = chosenLines.length * lineH;
      const startY = y + (h - blockH) / 2 + lineH / 2;

      for (let i = 0; i < chosenLines.length; i++) {
        const ly = startY + i * lineH;
        const lx = chosenLines.length === 1 ? x + w / 2 : x + 2;
        ctx.fillText(chosenLines[i], lx, ly, w);
      }
    }

    return canvas.toDataURL('image/jpeg', 0.92);
  }

  async function renderImageTranslationOverlay(host, img, data, regions, bar, triggerBtn, isCurrent = () => true) {
    if (!isCurrent()) return;
    host
      .querySelectorAll(':scope > .ig-img-overlay-layer, :scope > .ig-img-bilingual-drawer')
      .forEach((el) => el.remove());

    const overlay = document.createElement('div');
    overlay.className = 'notranslate ig-img-overlay-layer';
    overlay.setAttribute('translate', 'no');

    const inpaintedUrl = await inpaintWebpageImageRegions(data.imageDataUrl, regions);
    // Decoding can outlive cancellation, a new request, or replacement of the image source.
    if (!isCurrent()) return;
    if (inpaintedUrl) {
      const seamlessImg = document.createElement('img');
      seamlessImg.className = 'ig-img-seamless-img';
      seamlessImg.src = inpaintedUrl;
      seamlessImg.alt = img?.alt || 'Translated Image';
      overlay.appendChild(seamlessImg);
    }

    for (const reg of regions) {
      if (!reg.translation) continue;
      const [ymin, xmin, ymax, xmax] = Array.isArray(reg.box_2d)
        ? reg.box_2d
        : [100, 80, 220, 920];
      const topPct = Math.max(0, Math.min(96, ymin / 10));
      const leftPct = Math.max(0, Math.min(96, xmin / 10));
      const widthPct = Math.max(4, Math.min(100 - leftPct, (xmax - xmin) / 10));
      const heightPct = Math.max(2.5, Math.min(100 - topPct, (ymax - ymin) / 10));

      const box = document.createElement('div');
      box.className = inpaintedUrl
        ? 'ig-img-region-hotspot'
        : 'ig-img-region-box';
      box.style.top = `${topPct.toFixed(2)}%`;
      box.style.left = `${leftPct.toFixed(2)}%`;
      box.style.width = `${widthPct.toFixed(2)}%`;
      box.style.height = `${heightPct.toFixed(2)}%`;
      if (!inpaintedUrl) {
        box.textContent = reg.translation;
      }
      if (reg.original) {
        box.title = `原文: ${reg.original}\n译文: ${reg.translation}`;
      }
      overlay.appendChild(box);
    }

    host.appendChild(overlay);

    // Build Bilingual Text Drawer for easy copying / full reading
    const drawer = document.createElement('div');
    drawer.className = 'notranslate ig-img-bilingual-drawer';
    drawer.setAttribute('translate', 'no');
    drawer.hidden = true;

    const itemsHtml = regions
      .map(
        (r) => `
        <div class="ig-img-drawer-row">
          ${r.original ? `<span class="ig-img-drawer-orig">${escapeHtml(r.original)}</span>` : ''}
          <div class="ig-img-drawer-trans">${escapeHtml(r.translation)}</div>
        </div>
      `
      )
      .join('');

    drawer.innerHTML =
      itemsHtml ||
      `<div class="ig-img-drawer-row"><div class="ig-img-drawer-trans">${escapeHtml(
        data.summaryTranslation || ''
      )}</div></div>`;
    host.appendChild(drawer);

    if (triggerBtn) {
      triggerBtn.textContent = '✓ 译图开启';
      triggerBtn.classList.add('is-active');
    }

    if (bar && !bar.querySelector('[data-role="drawer"]')) {
      const drawerBtn = document.createElement('button');
      drawerBtn.type = 'button';
      drawerBtn.className = 'ig-img-ctrl-btn';
      drawerBtn.dataset.role = 'drawer';
      drawerBtn.textContent = '📖 对照文本';
      drawerBtn.title = '展开/收起图片内双语对照文本列表（支持复制）';
      drawerBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        drawer.hidden = !drawer.hidden;
        drawerBtn.classList.toggle('is-active', !drawer.hidden);
      });
      bar.appendChild(drawerBtn);
    }
  }

  function cleanupAllImageOverlays() {
    document.querySelectorAll('.ig-img-control-bar').forEach(releaseImageControls);
    document
      .querySelectorAll('.ig-img-overlay-layer, .ig-img-bilingual-drawer, .ig-img-control-bar')
      .forEach((el) => el.remove());
    document.querySelectorAll('[data-ig-img-status]').forEach((img) => {
      delete img.dataset.igImgStatus;
    });
  }

  function initImageTranslationEngine() {
    // This observer remains active for manual image translation when paragraph translation is off.
    const refresh = img => {
      if (!img || !imageSources.has(img) || !invalidateChangedImageSource(img)) return;
      if (settings.enableImageTranslate !== false && img.isConnected) {
        mountImageControlBar(img);
        if (isPageTranslated && settings.autoTranslatePageImages !== false) {
          img.dataset.igImgStatus = 'observed';
          viewportObserver?.observe(img);
        }
      }
    };
    const imageSourceObserver = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        const target = mutation.target;
        if (target.tagName === 'IMG') refresh(target);
        else if (target.tagName === 'SOURCE') target.closest('picture')?.querySelectorAll('img').forEach(refresh);
      }
    });
    imageSourceObserver.observe(document.documentElement, {
      subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'sizes', 'media', 'type']
    });
    document.addEventListener('load', event => {
      if (event.target?.tagName === 'IMG') refresh(event.target);
    }, true);
    document.addEventListener(
      'contextmenu',
      (e) => {
        const img = e.target?.closest?.('img');
        if (img) {
          lastContextMenuImage = img;
        }
      },
      true
    );

    document.addEventListener(
      'mouseover',
      (e) => {
        if (settings.enableImageTranslate === false) return;
        const img = e.target?.closest?.('img');
        if (!img || img.dataset.igHoverBound) return;
        if (isTranslatableContentImage(img, false)) {
          img.dataset.igHoverBound = '1';
          mountImageControlBar(img);
        }
      },
      { passive: true }
    );
  }

  // ============================================================================
  // 9. Message Listener from Popup / Background Service Worker
  // ============================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return false;
    // Chrome may consume the letter key of an extension shortcut before page keydown.
    if (altHoverGesture && ['TOGGLE_PAGE_TRANSLATION', 'CYCLE_TRANSLATION_STYLE'].includes(message.type)) {
      altHoverGesture.combined = true;
    }

    if (message.type === 'SITE_AUTO_TRANSLATE_STATE_CHANGED') {
      refreshSiteAutoTranslatePause().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message.type === 'TOGGLE_PAGE_TRANSLATION') {
      const pdfPage = isOnlinePdfPage();
      togglePageTranslation().then(active => sendResponse({
        ok: true, isPageTranslated: active, totalTranslatedCount,
        siteAutoPaused, openedPdfTab: pdfPage
      }));
      return true;
    }
    if (message.type === 'CYCLE_TRANSLATION_STYLE') {
      cycleTranslationStyle();
      sendResponse({ ok: true, style: settings.translationStyle });
      return false;
    }
    if (message.type === 'SET_TRANSLATION_STYLE') {
      const styleId = message.payload?.style || 'clean';
      settings.translationStyle = styleId;
      applyStyleAttribute(styleId);
      sendResponse({ ok: true, style: styleId });
      return false;
    }
    if (message.type === 'GET_PAGE_STATUS') {
      sendResponse({
        ok: true,
        isPageTranslated,
        totalTranslatedCount,
        translationStyle: settings.translationStyle,
        siteAutoPaused,
        isYoutube: window.location.hostname.includes('youtube.com'),
        isPdf: isOnlinePdfPage(),
        youtubeCueCount: ytCues.length
      });
      return false;
    }
    if (message.type === 'SHOW_PAGE_TOAST') {
      const p = message.payload || {};
      if (p.mode === 'selection-explain' && p.selectionText) {
        openSelectionExplanationCard({
          text: p.selectionText,
          contextParagraph: p.selectionText,
          x: window.innerWidth / 2 - 150,
          y: 120
        });
      } else if (p.mode === 'image-translate' && (p.srcUrl || p.imageUrl)) {
        const targetSrc = p.srcUrl || p.imageUrl;
        let targetImg = lastContextMenuImage;
        if (!targetImg || (targetImg.currentSrc !== targetSrc && targetImg.src !== targetSrc)) {
          targetImg = Array.from(document.querySelectorAll('img')).find(
            (i) => i.currentSrc === targetSrc || i.src === targetSrc
          );
        }
        translateImageElement(targetImg, { isAuto: false, fallbackSrcUrl: targetSrc });
      } else if (p.text) {
        showPageToast(p.text, p.type || 'info');
      }
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  // Boot sequence
  initShadowUI();
  loadSettings().then(loaded => { if (loaded) initYoutubeIntegration(); });
  initImageTranslationEngine();
})();
