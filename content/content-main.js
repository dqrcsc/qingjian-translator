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
  });
  function sendModelRequest(message) {
    const scope = message.type === 'TRANSLATE_YOUTUBE_CUES' ? subtitleRequests
      : message.type === 'TRANSLATE_YOUTUBE_AUDIO' ? audioRequests
      : message.type === 'TRANSLATE_SELECTION' ? selectionRequests
      : message.type === 'TRANSLATE_INPUT_TEXT' ? inputRequests : pageRequests;
    return scope.request(message);
  }


  const DEFAULT_SETTINGS = {
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
    const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
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
  let isPageTranslated = false;
  let totalTranslatedCount = 0;
  let pendingParagraphQueue = [];
  let flushQueueTimer = null;
  let blockIdCounter = 1;
  const blockMap = new Map(); // id -> { element, rawText, placeholders }
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
    if (!isExtensionContextValid()) {
      return Promise.resolve(null);
    }
    try {
      const p = message.type === 'TRANSLATE_YOUTUBE_CUES'
        ? sendModelRequest(message) : chrome.runtime.sendMessage(message);
      if (p && typeof p.catch === 'function') {
        return p.catch(() => null);
      }
      return Promise.resolve(p);
    } catch {
      return Promise.resolve(null);
    }
  }

  function safeUpdateStorage(partial) {
    if (!isExtensionContextValid()) return;
    try {
      chrome.storage.local
        .get(STORAGE_KEY)
        .then((res) => {
          if (!isExtensionContextValid()) return;
          return chrome.storage.local.set({
            [STORAGE_KEY]: { ...(res?.[STORAGE_KEY] || {}), ...partial }
          });
        })
        .catch(() => {});
    } catch {
      // ignore invalidated context
    }
  }

  async function loadSettings() {
    if (!isExtensionContextValid()) return;
    try {
      const res = await chrome.storage.local.get(STORAGE_KEY);
      settings = sanitizeContentSettings(res?.[STORAGE_KEY]);
      applyStyleAttribute(settings.translationStyle);
      applyYoutubeCssVariables();
      updateFloatingBallVisibility();
      updateFloatingBallStatus();
      checkAutoTranslateDomainRule();
    } catch {
      // ignore if extension context was invalidated during tab reload
    }
  }

  if (isExtensionContextValid()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORAGE_KEY]) {
        settings = sanitizeContentSettings(changes[STORAGE_KEY].newValue);
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
    return !isMostlyTargetLanguage(sampleText, settings.targetLang);
  }

  let hasAutoOpenedPdfTab = false;

  function checkAutoTranslateDomainRule() {
    const host = window.location.hostname.toLowerCase();
    if (!host || host.includes('youtube.com')) return;
    const neverList = parseDomainList(settings.neverTranslateDomains);
    if (neverList.some((d) => host === d || host.endsWith('.' + d))) return;

    // Online PDF links stay in the browser's native PDF reader by default.
    // Only auto-open the Studio translation tab if the user explicitly enabled `autoTranslateOnlinePdf`.
    if (isOnlinePdfPage()) {
      if (settings.autoTranslateOnlinePdf && !hasAutoOpenedPdfTab) {
        hasAutoOpenedPdfTab = true;
        openCurrentPdfInNewTab();
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
    '[contenteditable="true"]',
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
      if (curr.getAttribute('aria-hidden') === 'true' || curr.hasAttribute('hidden')) {
        return true;
      }
      const clsAndId = `${curr.className || ''} ${curr.id || ''}`;
      if (/visually-hidden|sr-only|screen-reader|a11y|offscreen/i.test(clsAndId)) {
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
        const cRect = curr.getBoundingClientRect();
        if (cRect.width < 4 || cRect.height < 4) {
          return true;
        }
      }
      if (style.clip && style.clip !== 'auto' && /0px|1px/.test(style.clip)) {
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
        return true;
      }
      if (
        (style.overflow === 'hidden' || style.overflowX === 'hidden' || style.overflowY === 'hidden') &&
        ((curr.clientWidth > 0 && curr.clientWidth < 4) ||
          (curr.clientHeight > 0 && curr.clientHeight < 4))
      ) {
        return true;
      }
      curr = curr.parentElement;
    }
    return false;
  }

  function isMostlyTargetLanguage(text, targetLang) {
    const clean = text.replace(/\s+/g, '');
    if (clean.length < 2) return true;
    if (targetLang.startsWith('zh')) {
      const cjkMatches = clean.match(/[\u4e00-\u9fa5]/g);
      const ratio = (cjkMatches ? cjkMatches.length : 0) / clean.length;
      return ratio > 0.6;
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
    if (el.closest('[data-ig-status]')) return false;
    if (el.querySelector('[data-ig-status]')) return false;
    if (el.closest(SKIP_ANCESTOR_SELECTOR)) return false;
    if (isIconFontElement(el) || isVisuallyHidden(el)) return false;

    const tag = el.tagName.toLowerCase();
    const isExplicitProse = el.matches(EXPLICIT_PROSE_SELECTOR);
    const isProse = isExplicitProse || isProseBlock(el);

    // Never translate an outer container if it holds nested block elements
    // (unless it is an explicit tweet/comment text container without nested tweetText)
    if (!isExplicitProse && hasBlockChildren(el)) {
      return false;
    }
    if (isExplicitProse && el.querySelector(EXPLICIT_PROSE_SELECTOR)) {
      return false;
    }

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

    // For non-prose containers (div, span, td, th, a, button),
    // if it has no direct text of its own and wraps child elements, let the inner leaf element be translated instead!
    if (!isProse && el.children.length > 0) {
      const directText = getDirectVisibleText(el);
      if (directText.length < 2) {
        return false;
      }
    }

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
  function wrapOriginalTextNodes(el) {
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

    collect(el);
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
    el.normalize();
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
        if (!isPageTranslated) return;
        const addedRoots = [];
        for (const m of mutations) {
          for (const node of m.addedNodes) {
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
        if (addedRoots.length > 0) {
          requestAnimationFrame(() => {
            for (const root of addedRoots) {
              scanAndObserveContainer(root);
            }
          });
        }
      });
    }
  }

  function scanAndObserveContainer(root = document.body) {
    if (!root || !viewportObserver) return;
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

    for (const el of [...proseList, ...uiLeaves]) {
      if (isElementTranslatable(el)) {
        el.dataset.igStatus = 'observed';
        viewportObserver.observe(el);
      }
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
            current.__igIsParaBreak = true;
            current = afterNode;
            continue;
          } else {
            current.__igIsParaBreak = true;
            break;
          }
        } else {
          const breakAndAfter = current.splitText(matchIndex);
          if (matchLen < breakAndAfter.nodeValue.length) {
            const afterNode = breakAndAfter.splitText(matchLen);
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
          anchorNode: curr.anchorNode,
          breakNode: breakNode || curr.breakNode
        });
      }
      curr = {
        parts: [],
        placeholders: [],
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

      if (
        PROTECTED_TAGS.has(tag) ||
        node.classList.contains('katex') ||
        node.classList.contains('MathJax')
      ) {
        const txt = (node.textContent || '').trim();
        if (txt && txt.length <= 80) {
          const idx = curr.placeholders.length;
          curr.placeholders.push(txt);
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

    // Collapse pre-wrap newline node right after paragraph so display:block translation box has clean spacing
    if (
      record.breakNode &&
      record.breakNode.nodeType === Node.TEXT_NODE &&
      record.breakNode.parentNode &&
      !record.breakNode.parentNode.classList?.contains('ig-orig-newline')
    ) {
      const nlWrap = document.createElement('font');
      nlWrap.className = 'notranslate ig-orig-newline';
      nlWrap.setAttribute('translate', 'no');
      nlWrap.style.display = 'none';
      record.breakNode.parentNode.replaceChild(nlWrap, record.breakNode);
      nlWrap.appendChild(record.breakNode);
    }

    if (targetAnchor.parentNode) {
      targetAnchor.parentNode.insertBefore(nodeToInsert, targetAnchor.nextSibling);
    } else {
      insertNodeInElementCleanly(el, nodeToInsert);
    }
  }

  function queueParagraphForTranslation(el) {
    if (!el || el.dataset.igStatus === 'queued' || el.dataset.igStatus === 'done') return;
    if (isVisuallyHidden(el)) {
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
        placeholders: seg.placeholders,
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
    const CHUNK = 18;
    for (let i = 0; i < results.length; i += CHUNK) {
      const slice = results.slice(i, i + CHUNK);
      await new Promise((resolve) =>
        requestAnimationFrame(() => {
          if (signal?.aborted) { resolve(); return; }
          for (const item of slice) {
            const segId = Number(item.id);
            const record = blockMap.get(segId);
            if (!record || !record.element) continue;
            const el = record.element;

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
              el.dataset.igStatus = 'done';
              continue;
            }

            wrapOriginalTextNodes(el);

            const isInline = record.isMultiSeg ? false : shouldUseInlineMode(el, record.text);
            const transNode = document.createElement('font');
            transNode.className = `notranslate ig-trans-node ${
              isInline ? 'ig-trans-inline' : 'ig-trans-block'
            }`;
            transNode.dataset.igSegId = String(segId);
            transNode.setAttribute('translate', 'no');
            transNode.appendChild(
              restorePlaceholdersToFragment(translatedStr, record.placeholders)
            );
            insertNodeAfterSegmentAnchor(el, record, transNode);
            el.dataset.igStatus = 'done';
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
          if (!record || !record.element) continue;
          const el = record.element;
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
            e.stopPropagation();
            errBadge.remove();
            delete el.dataset.igStatus;
            queueParagraphForTranslation(el);
          });
          insertNodeAfterSegmentAnchor(el, record, errBadge);
          el.dataset.igStatus = 'error';
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

  function openCurrentPdfInNewTab() {
    safeRuntimeSendMessage({
      type: 'OPEN_DOCUMENT_STUDIO',
      payload: {
        pdfUrl: window.location.href,
        autoTranslate: true
      }
    });
  }

  function enablePageTranslation() {
    if (isOnlinePdfPage()) {
      openCurrentPdfInNewTab();
      return;
    }
    isPageTranslated = true;
    ensureObservers();
    scanAndObserveContainer(document.body);
    domMutationObserver.observe(document.body, { childList: true, subtree: true });
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
    pageRequests.cancel();
    isPageTranslated = false;
    pendingParagraphQueue = [];
    window.removeEventListener('scroll', handleScrollRescan);
    if (scrollRescanTimer) {
      clearTimeout(scrollRescanTimer);
      scrollRescanTimer = null;
    }
    postEnableTimers.forEach((t) => clearTimeout(t));
    postEnableTimers = [];
    if (viewportObserver) viewportObserver.disconnect();
    if (domMutationObserver) domMutationObserver.disconnect();

    const translatedEls = Array.from(document.querySelectorAll('[data-ig-status]'));
    const BATCH = 30;
    (async () => {
      for (let i = 0; i < translatedEls.length; i += BATCH) {
        const slice = translatedEls.slice(i, i + BATCH);
        await new Promise((resolve) =>
          requestAnimationFrame(() => {
            for (const el of slice) {
              el.querySelectorAll(
                '.ig-trans-node, .ig-trans-block, .ig-trans-inline, .ig-trans-loading, .ig-trans-error'
              ).forEach((n) => n.remove());
              unwrapOriginalTextNodes(el);
              delete el.dataset.igStatus;
              delete el.dataset.igBlockId;
            }
            resolve();
          })
        );
      }
      cleanupAllImageOverlays();
      blockMap.clear();
      totalTranslatedCount = 0;
      updateFloatingBallStatus();
    })();
    showPageToast('已恢复网页原文显示', 'info');
  }

  function togglePageTranslation() {
    if (isOnlinePdfPage()) {
      openCurrentPdfInNewTab();
      return false;
    }
    if (isPageTranslated) {
      disablePageTranslation();
    } else {
      enablePageTranslation();
    }
    return isPageTranslated;
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

  document.addEventListener(
    'mousemove',
    (e) => {
      const target = e.target?.closest?.(BLOCK_SELECTOR);
      if (hoveredElement && hoveredElement !== target) {
        hoveredElement.classList.remove('ig-hover-target-highlight');
      }
      hoveredElement = target || null;
      if (hoveredElement && e.altKey && settings.enableHoverTranslate) {
        hoveredElement.classList.add('ig-hover-target-highlight');
      }
    },
    { passive: true }
  );

  document.addEventListener('keydown', (e) => {
    if (!settings.enableHoverTranslate) return;
    if (e.key === 'Alt' && hoveredElement) {
      hoveredElement.classList.add('ig-hover-target-highlight');
      if (hoveredElement.dataset.igStatus === 'done') {
        hoveredElement
          .querySelectorAll('.ig-trans-node, .ig-trans-block, .ig-trans-inline')
          .forEach((n) => n.remove());
        unwrapOriginalTextNodes(hoveredElement);
        delete hoveredElement.dataset.igStatus;
      } else if (!hoveredElement.dataset.igStatus) {
        queueParagraphForTranslation(hoveredElement);
      }
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Alt' && hoveredElement) {
      hoveredElement.classList.remove('ig-hover-target-highlight');
    }
  });

  // ============================================================================
  // 5. Input Box Triple-Space Real-Time Translation
  // ============================================================================

  let spacePressTimestamps = [];
  let lastSpaceTarget = null;

  document.addEventListener(
    'keydown',
    async (e) => {
      if (!settings.enableTripleSpaceInput) return;
      if (e.key !== ' ' || e.ctrlKey || e.metaKey || e.altKey) {
        spacePressTimestamps = [];
        return;
      }

      const active = document.activeElement;
      if (!active) return;

      const isInput =
        active.tagName === 'TEXTAREA' ||
        (active.tagName === 'INPUT' &&
          ['text', 'search', 'url', 'email', ''].includes((active.type || 'text').toLowerCase()));
      const isEditable = active.isContentEditable;

      if (!isInput && !isEditable) return;

      const now = Date.now();
      if (lastSpaceTarget !== active) {
        spacePressTimestamps = [];
        lastSpaceTarget = active;
      }

      spacePressTimestamps = spacePressTimestamps.filter((t) => now - t < 650);
      spacePressTimestamps.push(now);

      if (spacePressTimestamps.length >= 3) {
        spacePressTimestamps = [];
        const rawValue = isInput ? active.value : active.innerText || active.textContent || '';
        const trimmed = rawValue.trim();
        if (trimmed.length < 2) return;

        e.preventDefault();
        inputRequests.cancel();
        active.classList.add('ig-input-translating');
        showPageToast('⚡ 正在将输入内容实时翻译为目标外语…', 'info');

        try {
          const res = await sendModelRequest({
            type: 'TRANSLATE_INPUT_TEXT',
            payload: {
              text: trimmed,
              targetLang: settings.inputTargetLang || 'en'
            }
          });

          if (res?.cancelled) return;
          if (!res || !res.ok) {
            throw new Error(res?.error || '输入框翻译失败');
          }

          const translated = res.data?.translatedText || trimmed;
          if (isInput) {
            const nativeSetter = Object.getOwnPropertyDescriptor(
              window[active.tagName === 'TEXTAREA' ? 'HTMLTextAreaElement' : 'HTMLInputElement']
                .prototype,
              'value'
            )?.set;
            if (nativeSetter) {
              nativeSetter.call(active, translated);
            } else {
              active.value = translated;
            }
            active.dispatchEvent(new Event('input', { bubbles: true }));
            active.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (isEditable) {
            active.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, translated);
          }
          showPageToast('✨ 输入框翻译完成', 'success');
        } catch (err) {
          showPageToast(`翻译失败: ${err?.message || '请检查 API Key'}`, 'warn', true);
        } finally {
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
          chrome.storage.local.get(STORAGE_KEY, (res) => {
            chrome.storage.local.set({
              [STORAGE_KEY]: {
                ...(res[STORAGE_KEY] || {}),
                floatingBallPositionY: settings.floatingBallPositionY
              }
            });
          });
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

    domainCheckEl?.addEventListener('change', (e) => {
      e.stopPropagation();
      const host = window.location.hostname.toLowerCase();
      if (!host) return;
      const set = new Set(parseDomainList(settings.alwaysTranslateDomains));
      if (domainCheckEl.checked) {
        set.add(host);
        if (!isPageTranslated && !isOnlinePdfPage()) enablePageTranslation();
      } else {
        set.delete(host);
      }
      const nextDomains = Array.from(set).join('\n');
      settings.alwaysTranslateDomains = nextDomains;
      safeUpdateStorage({ alwaysTranslateDomains: nextDomains });
    });

    globalCheckEl?.addEventListener('change', (e) => {
      e.stopPropagation();
      const enabled = Boolean(globalCheckEl.checked);
      settings.autoTranslateAllPages = enabled;
      if (enabled && !isPageTranslated && !isOnlinePdfPage()) {
        enablePageTranslation();
      }
      safeUpdateStorage({ autoTranslateAllPages: enabled });
    });

    pdfCheckEl?.addEventListener('change', (e) => {
      e.stopPropagation();
      const enabled = Boolean(pdfCheckEl.checked);
      settings.autoTranslateOnlinePdf = enabled;
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
        if (toggleSubText) toggleSubText.textContent = '点击在新标签页打开翻译工作台 ↗';
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
        if (toggleMainText) toggleMainText.textContent = '双语对照：未开启';
        if (toggleSubText) toggleSubText.textContent = '点击此处或按 Alt+A 立即开启';
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
        navigator.clipboard.writeText(d.translation || text);
        ev.target.textContent = '已复制';
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
  let ytVideoTitle = '';
  let ytCurrentVideoId = '';
  let ytDualActive = true;
  let ytSidebarOpen = false;
  let ytOverlayEl = null;
  let ytSidebarEl = null;
  let ytCtrlBtnEl = null;
  let ytInFlightBatchIds = new Set();
  let ytLastRenderedSig = '';
  let ytBoundVideoEl = null;
  let ytAudioRecorder = null;
  let ytAudioListenActive = false;
  let ytAudioSession = 0;
  let ytAudioStream = null;
  let ytAudioButton = null;
  const ytLiveCaptionCache = new Map();
  const ytLiveCaptionInFlight = new Set();

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

    ytDualActive = settings.youtubeAutoEnable !== false;
    ytSidebarOpen = Boolean(settings.youtubeShowSidebar);
    ytCurrentVideoId = getCurrentYoutubeVideoId();
    applyYoutubeCssVariables();

    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data) return;
      if (event.data.source !== 'IG_YT_MAIN_BRIDGE') return;

      if (event.data.type === 'YT_CUES_LOADED') {
        const { cues, videoTitle, videoId } = event.data.payload || {};
        const currentVid = getCurrentYoutubeVideoId();
        if (videoId && currentVid && videoId !== currentVid) {
          return;
        }
        if (Array.isArray(cues) && cues.length > 0) {
          subtitleRequests.cancel();
          ytLiveCaptionInFlight.clear();
          ytCues = cues.map((c) => ({ ...c, translation: '' }));
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
        subtitleRequests.cancel();
        if (ytAudioListenActive) stopYoutubeAudioListen();
        return;
      }

      const currentVid = getCurrentYoutubeVideoId();
      if (currentVid && currentVid !== ytCurrentVideoId) {
        stopYoutubeAudioListen();
        subtitleRequests.cancel();
        ytCurrentVideoId = currentVid;
        ytCues = [];
        ytInFlightBatchIds.clear();
        ytLiveCaptionCache.clear();
        ytLiveCaptionInFlight.clear();
        ytLastRenderedSig = '';
        if (ytOverlayEl) ytOverlayEl.innerHTML = '';
        requestYoutubeTracksFromBridge();
      } else if (ytDualActive && ytCues.length === 0) {
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
      video.addEventListener('seeked', triggerImmediatePrefetch);
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
        if (!ytDualActive) { subtitleRequests.cancel(); stopYoutubeAudioListen(); }
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

    ytSidebarEl = document.createElement('div');
    ytSidebarEl.className = 'ig-yt-timeline-panel';
    ytSidebarEl.innerHTML = `
      <div class="ig-yt-timeline-header">
        <div class="ig-yt-timeline-title">✦ 双语字幕时间轴</div>
        <div class="ig-yt-timeline-actions">
          <button class="ig-yt-mini-btn" data-act="audio-listen" title="使用多模态音频实时听译视频原声">🎙️ 音频听译</button>
          <button class="ig-yt-mini-btn" data-act="export-srt" title="导出双语字幕（支持 Mac 直接打开的 .txt、一键复制或播放器 .srt）">导出字幕</button>
          <button class="ig-yt-mini-btn" data-act="close" title="关闭时间轴">✕</button>
        </div>
      </div>
      <div class="ig-yt-export-bar" data-yt-export-bar="1" hidden>
        <button class="ig-yt-export-opt" data-export-fmt="txt" title="Mac 双击直接用文本编辑打开，无安全拦截弹窗">📄 导出 .txt (直接打开)</button>
        <button class="ig-yt-export-opt" data-export-fmt="copy" title="复制全部带时间戳的中英双语字幕到剪贴板">📋 复制双语全文</button>
        <button class="ig-yt-export-opt" data-export-fmt="srt" title="下载标准 .srt 字幕文件（供 IINA / VLC / 剪映 导入）">🎬 导出 .srt</button>
      </div>
      <div class="ig-yt-timeline-search">
        <input type="text" placeholder="搜索原文字幕或译文关键词…" data-yt-search="1" />
      </div>
      <div class="ig-yt-timeline-list" data-yt-list="1"></div>
    `;
    document.body.appendChild(ytSidebarEl);

    ytSidebarEl.querySelector('[data-act="close"]')?.addEventListener('click', () => {
      ytSidebarOpen = false;
      ytSidebarEl.style.display = 'none';
    });

    const exportBar = ytSidebarEl.querySelector('[data-yt-export-bar]');
    ytSidebarEl.querySelector('[data-act="export-srt"]')?.addEventListener('click', () => {
      if (exportBar) {
        exportBar.hidden = !exportBar.hidden;
      }
      exportYoutubeBilingualSrt('txt');
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
  }

  function renderYoutubeTimelineList(noCaptions = false, filterKeyword = '') {
    if (!ytSidebarEl || ytSidebarEl.style.display === 'none') return;
    const listEl = ytSidebarEl.querySelector('[data-yt-list]');
    if (!listEl) return;

    if (noCaptions && ytCues.length === 0) {
      listEl.innerHTML = `
        <div style="padding:18px;text-align:center;color:#94a3b8;font-size:12.5px;line-height:1.6;">
          当前视频未检测到原生/自动字幕轨道。<br/>
          您可以点击上方 <b>🎙️ 音频听译</b> 按钮，启用多模态音频能力实时听译视频语音！
        </div>
      `;
      return;
    }

    const filtered = filterKeyword
      ? ytCues.filter(
          (c) =>
            c.text.toLowerCase().includes(filterKeyword) ||
            (c.translation && c.translation.toLowerCase().includes(filterKeyword))
        )
      : ytCues;

    listEl.innerHTML = filtered
      .map(
        (c) => `
      <div class="ig-yt-cue-item" data-cue-id="${c.id}" data-start="${c.start}">
        <div class="ig-yt-cue-time">${formatSec(c.start)}</div>
        <div class="ig-yt-cue-orig">${escapeText(c.text)}</div>
        <div class="ig-yt-cue-trans">${escapeText(c.translation || '…')}</div>
      </div>
    `
      )
      .join('');

    listEl.querySelectorAll('.ig-yt-cue-item').forEach((item) => {
      item.addEventListener('click', () => {
        const sec = Number(item.dataset.start);
        window.postMessage(
          { source: 'IG_YT_CONTENT_SCRIPT', type: 'SEEK_VIDEO_TO', seconds: sec },
          '*'
        );
      });
    });
  }

  function formatSec(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }

  async function dispatchCueBatchTranslation(batch) {
    if (!batch || batch.length === 0) return;
    batch.forEach((c) => ytInFlightBatchIds.add(c.id));

    const requestCues = ytCues;
    const requestVideoId = getCurrentYoutubeVideoId();
    const isCurrent = () => requestCues === ytCues && requestVideoId === getCurrentYoutubeVideoId();
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
      if (res && res.ok && Array.isArray(res.data?.cues)) {
        for (const item of res.data.cues) {
          const target = ytCues.find((c) => Number(c.id) === Number(item.id));
          if (target && item.translation) {
            target.translation = item.translation;
            if (ytSidebarEl && ytSidebarEl.style.display !== 'none') {
              const rowTrans = ytSidebarEl.querySelector(
                `.ig-yt-cue-item[data-cue-id="${target.id}"] .ig-yt-cue-trans`
              );
              if (rowTrans) rowTrans.textContent = item.translation;
            }
          }
        }
        ytLastRenderedSig = ''; // Trigger immediate overlay refresh even if paused
      } else {
        batch.forEach((c) => ytInFlightBatchIds.delete(c.id));
      }
    } catch {
      if (!isCurrent()) return;
      batch.forEach((c) => ytInFlightBatchIds.delete(c.id));
    }
  }

  /**
   * Two-tier subtitle prefetching:
   * 1. Fast-First-Paint Micro-Batch (first 3 untranslated cues right at currentTime) -> ~350ms latency
   * 2. Lookahead Batch (next 10 cues in [currentTime, currentTime + 75s]) -> pre-cached seamlessly
   */
  function prefetchYoutubeCuesAround(currentTime) {
    if (!ytDualActive || ytCues.length === 0) return;
    const windowEnd = currentTime + 75;
    const candidates = ytCues.filter(
      (c) =>
        c.end >= currentTime - 1.5 &&
        c.start <= windowEnd &&
        !c.translation &&
        !ytInFlightBatchIds.has(c.id)
    );

    if (candidates.length === 0) return;

    // Check if the immediate cue (within next 10s) is untranslated
    const urgent = candidates.filter((c) => c.start <= currentTime + 10).slice(0, 3);
    if (urgent.length > 0) {
      dispatchCueBatchTranslation(urgent);
      const remaining = candidates.filter((c) => !urgent.includes(c)).slice(0, 10);
      if (remaining.length > 0) {
        dispatchCueBatchTranslation(remaining);
      }
    } else {
      dispatchCueBatchTranslation(candidates.slice(0, 10));
    }
  }

  let lastBridgeTrackRequestAt = 0;

  function isMostlyChineseText(str) {
    if (!str) return false;
    const cjk = (str.match(/[\u4e00-\u9fff]/g) || []).length;
    return cjk / str.length > 0.2;
  }

  function isUnexpectedArabicCaption(str) {
    if (!str) return false;
    const arabicCount = (str.match(/[\u0600-\u06ff]/g) || []).length;
    if (arabicCount < 3) return false;
    const title = ytVideoTitle || document.title || '';
    const titleHasArabic = /[\u0600-\u06ff]/.test(title);
    return !titleHasArabic;
  }

  async function translateLiveYoutubeCaptionText(rawText) {
    if (!rawText || ytLiveCaptionCache.has(rawText) || ytLiveCaptionInFlight.has(rawText)) return;
    if (isMostlyChineseText(rawText) && /^zh/i.test(settings.targetLang || 'zh-CN')) return;
    if (isUnexpectedArabicCaption(rawText)) return;
    const requestCues = ytCues;
    const requestVideoId = getCurrentYoutubeVideoId();
    const isCurrent = () => requestCues === ytCues && requestVideoId === getCurrentYoutubeVideoId();
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
        ytLiveCaptionCache.set(rawText, trans);
        ytLastRenderedSig = '';
      }
    } finally {
      if (isCurrent()) ytLiveCaptionInFlight.delete(rawText);
    }
  }

  function syncYoutubeSubtitlesLoop() {
    const isVideoRoute =
      window.location.hostname.includes('youtube.com') &&
      (window.location.pathname.startsWith('/watch') ||
        window.location.pathname.startsWith('/shorts'));

    if (!isVideoRoute || !ytDualActive || document.hidden) {
      setTimeout(syncYoutubeSubtitlesLoop, 600);
      return;
    }

    const player = document.querySelector('.html5-video-player');
    const video = player ? player.querySelector('video') : document.querySelector('video');

    if (ytCues.length > 0 && video) {
      const t = video.currentTime;
      const activeCue = ytCues.find((c) => t >= c.start && t <= c.end);

      if (activeCue) {
        const sig = `cue:${activeCue.id}|${activeCue.translation || ''}`;
        if (sig !== ytLastRenderedSig) {
          ytLastRenderedSig = sig;
          if (ytOverlayEl) {
            ytOverlayEl.innerHTML = `
              <div class="ig-yt-sub-box">
                <div class="ig-yt-line-orig">${escapeText(activeCue.text)}</div>
                <div class="ig-yt-line-trans">${escapeText(
                  activeCue.translation || '⚡ 正在极速翻译当前句…'
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
        const isStaleArabic = isUnexpectedArabicCaption(liveText);

        if (isStaleArabic) {
          const now = Date.now();
          if (now - lastBridgeTrackRequestAt > 1000) {
            lastBridgeTrackRequestAt = now;
            requestYoutubeTracksFromBridge();
          }
          player.classList.add('ig-yt-dual-active');
        } else if (isAlreadyTargetChinese) {
          // Native YouTube CC is currently set to Chinese; prompt bridge to switch to original track
          const now = Date.now();
          if (now - lastBridgeTrackRequestAt > 1500) {
            lastBridgeTrackRequestAt = now;
            requestYoutubeTracksFromBridge();
          }
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
          const sig = `live:${liveText}|${cachedTrans}`;
          if (sig !== ytLastRenderedSig) {
            ytLastRenderedSig = sig;
            if (ytOverlayEl) {
              ytOverlayEl.innerHTML = `
                <div class="ig-yt-sub-box">
                  <div class="ig-yt-line-orig">${escapeText(liveText)}</div>
                  <div class="ig-yt-line-trans">${escapeText(
                    cachedTrans || '⚡ 正在极速翻译当前句…'
                  )}</div>
                </div>
              `;
            }
            player.classList.add('ig-yt-dual-active');
          }
        }
      } else {
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
    if (!ytSidebarEl || ytSidebarEl.style.display === 'none') return;
    ytSidebarEl.querySelectorAll('.ig-yt-cue-item.is-current').forEach((el) => {
      el.classList.remove('is-current');
    });
    const currentEl = ytSidebarEl.querySelector(`.ig-yt-cue-item[data-cue-id="${cueId}"]`);
    if (currentEl) {
      currentEl.classList.add('is-current');
      currentEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  /**
   * Experimental Gemini Multimodal Live Audio Listen-and-Translate for videos without native captions.
   */
  function stopYoutubeAudioListen() {
    audioRequests.cancel();
    ytAudioListenActive = false;
    ytAudioSession++;
    if (ytAudioRecorder && ytAudioRecorder.state !== 'inactive') ytAudioRecorder.stop();
    ytAudioStream?.getTracks().forEach(track => track.stop());
    ytAudioStream = null;
    ytAudioRecorder = null;
    if (ytAudioButton) {
      ytAudioButton.classList.remove('is-active');
      ytAudioButton.textContent = '🎙️ 音频听译';
    }
  }

  async function toggleExperimentalAudioListen(btnEl) {
    if (ytAudioListenActive) {
      stopYoutubeAudioListen();
      showPageToast('已停止 AI 音频切片听译', 'info');
      return;
    }
    if (settings.apiProtocol !== 'gemini') {
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
      let pendingSlices = 0;
      let latestSliceStart = -1;
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      ytAudioListenActive = true;
      btnEl.classList.add('is-active');
      btnEl.textContent = '⏹ 停止听译';
      showPageToast('🎙️ 已开启 AI 音频切片听译（每 7 秒上传，另需模型响应时间）', 'success');

      let previousSpoken = '';

      const recordSlice = () => {
        if (!isCurrent()) return;
        if (video.paused) {
          setTimeout(recordSlice, 1500);
          return;
        }
        const sliceStart = video.currentTime;
        const chunks = [];
        const recorder = new MediaRecorder(audioStream, { mimeType });
        ytAudioRecorder = recorder;

        recorder.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) chunks.push(ev.data);
        };

        recorder.onstop = async () => {
          if (!isCurrent() || chunks.length === 0) return;
          if (pendingSlices >= 2) {
            stopYoutubeAudioListen();
            showPageToast('模型响应过慢，已停止听译以避免请求积压，请稍后重试。', 'warn');
            return;
          }
          pendingSlices++;
          const blob = new Blob(chunks, { type: mimeType });
          try {
            const base64 = await blobToBase64(blob);
            if (!isCurrent()) return;
            const res = await sendModelRequest({
              type: 'TRANSLATE_YOUTUBE_AUDIO',
              payload: {
                audioBase64: base64,
                mimeType: 'audio/webm',
                previousContext: previousSpoken,
                videoTitle: ytVideoTitle || document.title
              }
            });
            if (!isCurrent()) return;
            if (!res?.ok) throw new Error(res?.error || '音频翻译失败');
            if (res.data?.original) {
              if (sliceStart >= latestSliceStart) {
                previousSpoken = res.data.original;
                latestSliceStart = sliceStart;
              }
              const newCue = {
                id: ytCues.length,
                start: sliceStart,
                end: sliceStart + 7.5,
                text: res.data.original,
                translation: res.data.translation || ''
              };
              // Reindexing changes cue identity: invalidate old batch callbacks too.
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
            if (isCurrent()) {
              stopYoutubeAudioListen();
              showPageToast(`音频听译已停止: ${err?.message || err}`, 'warn');
            }
          } finally {
            pendingSlices--;
          }
        };

        recorder.start();
        setTimeout(() => {
          if (!isCurrent()) return;
          if (recorder.state === 'recording') recorder.stop();
          if (isCurrent()) {
            recordSlice();
          }
        }, 7000);
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
    if (ytCues.length === 0) {
      showPageToast('暂无可导出的字幕数据', 'warn');
      return;
    }
    const formatSrt = (sec) => {
      const s = Math.max(0, Number(sec) || 0);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sc = Math.floor(s % 60);
      const ms = Math.round((s - Math.floor(s)) * 1000);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sc).padStart(
        2,
        '0'
      )},${String(ms).padStart(3, '0')}`;
    };

    const srtContent = ytCues
      .map(
        (c, i) =>
          `${i + 1}\n${formatSrt(c.start)} --> ${formatSrt(c.end)}\n${c.text}\n${
            c.translation || ''
          }\n`
      )
      .join('\n');

    if (format === 'copy') {
      const readableText = ytCues
        .map(
          (c) =>
            `[${formatSec(c.start)}] ${c.text}${c.translation ? `\n${c.translation}` : ''}`
        )
        .join('\n\n');
      navigator.clipboard
        .writeText(readableText)
        .then(() => {
          showPageToast('✅ 已复制全部双语字幕到剪贴板', 'success');
        })
        .catch(() => {
          showPageToast('复制失败，请使用导出 .txt 文件', 'warn');
        });
      return;
    }

    const baseName = sanitizeSubtitleBaseName(ytVideoTitle || document.title);
    const isTxt = format === 'txt';
    const ext = isTxt ? 'bilingual.txt' : 'bilingual.srt';
    const fileHeader = isTxt
      ? `# ${baseName} — 双语字幕对照 (青简 · 译读)\n# 包含标准 SRT 时间轴，可直接阅读或改后缀为 .srt 导入播放器\n\n`
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

  function mountImageControlBar(img) {
    const host = ensureImageHostContainer(img);
    if (!host) return null;
    let bar = host.querySelector(':scope > .ig-img-control-bar');
    if (bar) return bar;

    bar = document.createElement('div');
    bar.className = 'notranslate ig-img-control-bar';
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

  async function translateImageElement(img, options = {}) {
    const { isAuto = false, fallbackSrcUrl = '' } = options;
    if (!img && !fallbackSrcUrl) return;

    if (img) {
      if (img.dataset.igImgStatus === 'loading') return;
      img.dataset.igImgStatus = 'loading';
    }

    const host = img ? ensureImageHostContainer(img) : null;
    const bar = img ? mountImageControlBar(img) : null;
    const triggerBtn = bar?.querySelector('[data-role="trigger"]');

    if (triggerBtn) {
      triggerBtn.textContent = '⏳ 识别译图中…';
    } else if (!isAuto) {
      showPageToast('正在识别图片中的文字并翻译…', 'info');
    }

    const signal = pageRequests.signal;
    try {
      const payload = await extractImagePayload(img, fallbackSrcUrl);
      if (signal.aborted) return;
      const response = await sendModelRequest({
        type: 'TRANSLATE_IMAGE',
        payload: {
          ...payload,
          targetLang: settings.targetLang,
          pageTitle: document.title
        }
      });

      if (signal.aborted || response?.cancelled) return;
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
        img.dataset.igImgStatus = 'done';
        await renderImageTranslationOverlay(host, img, data, regions, bar, triggerBtn);
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
      if (img) delete img.dataset.igImgStatus;
      if (triggerBtn) {
        triggerBtn.textContent = '⚠️ 译图重试';
      }
      if (!isAuto) {
        showPageToast(`图片翻译失败: ${err?.message || err}`, 'warn');
      }
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

  async function renderImageTranslationOverlay(host, img, data, regions, bar, triggerBtn) {
    host
      .querySelectorAll(':scope > .ig-img-overlay-layer, :scope > .ig-img-bilingual-drawer')
      .forEach((el) => el.remove());

    const overlay = document.createElement('div');
    overlay.className = 'notranslate ig-img-overlay-layer';
    overlay.setAttribute('translate', 'no');

    const inpaintedUrl = await inpaintWebpageImageRegions(data.imageDataUrl, regions);
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
    document
      .querySelectorAll('.ig-img-overlay-layer, .ig-img-bilingual-drawer, .ig-img-control-bar')
      .forEach((el) => el.remove());
    document.querySelectorAll('[data-ig-img-status]').forEach((img) => {
      delete img.dataset.igImgStatus;
    });
  }

  function initImageTranslationEngine() {
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

    if (message.type === 'TOGGLE_PAGE_TRANSLATION') {
      const pdfPage = isOnlinePdfPage();
      const active = togglePageTranslation();
      sendResponse({
        ok: true,
        isPageTranslated: active,
        totalTranslatedCount,
        openedPdfTab: pdfPage
      });
      return false;
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
  loadSettings();
  initYoutubeIntegration();
  initImageTranslationEngine();
})();
