/**
 * Manifest V3 Background Service Worker for Immersive Gemini.
 * Handles message routing, two-tier caching, concurrency queue, context menus, and keyboard shortcuts.
 */

import { MESSAGE_TYPES } from '../shared/constants.js';
import {
  getSettings,
  saveContentSettings,
  getActiveModelId,
  getUsageStats,
  incrementUsageStats
} from '../shared/storage.js';
import { hashString, isOnlinePdfUrl, normalizeOnlinePdfUrl } from '../shared/utils.js';
import {
  buildCacheKey,
  buildStyleSignature,
  getCachedTranslations,
  setCachedTranslations,
  getCacheStats,
  clearAllCache
} from './cache-db.js';
import {
  fetchAvailableModels,
  translateBatchWithGemini,
  explainSelectionWithGemini,
  translateInputTextWithGemini,
  translateImageWithGemini,
  translateYoutubeCuesWithGemini,
  translateYoutubeAudioWithGemini,
  analyzePdfWithGemini,
  testGeminiConnection
} from './gemini-client.js';

import { getSitePause, setSitePause, sitePauseRequestUrl, sitePauseScope } from './site-pause.js';

import { requestDocumentConfig } from '../shared/document-config.js';

import { withConcurrencyLimit, abortRequestScope } from './request-queue.js';
import { createRequestBudget, normalizeRequestBudgetSeconds } from '../shared/request-budget.js';

async function getRequestSettings(signal, documentConfig) {
  signal?.throwIfAborted();
  const settings = await getSettings();
  signal?.throwIfAborted();
  return { ...settings, ...documentConfig, ...(documentConfig ? { availableModels: [] } : {}),
    documentModelLocked: Boolean(documentConfig), requestSignal: signal };
}

async function sendMessageToTabSafely(tabId, message) {
  if (!tabId) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}

async function updateSiteAutoTranslatePause(url, paused) {
  const settings = await getSettings();
  const data = await setSitePause(url, settings.alwaysTranslateDomains, paused);
  // Listeners reread canonical session state so overlapping broadcasts cannot
  // restore an older pause value. Existing translated pages keep their content.
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter(tab => /^https?:\/\//i.test(tab.url || '') &&
    sitePauseScope(tab.url, settings.alwaysTranslateDomains) === data.site).map(tab =>
    sendMessageToTabSafely(tab.id, { type: MESSAGE_TYPES.SITE_AUTO_TRANSLATE_STATE_CHANGED })));
  return data;
}

async function openPdfTranslationNewTab(rawPdfUrl, sourceTab = null, autoTranslate = true, automatic = false) {
  const normalizedUrl = normalizeOnlinePdfUrl(rawPdfUrl);
  if (normalizedUrl) {
    const settings = await getSettings();
    const state = await getSitePause(normalizedUrl, settings.alwaysTranslateDomains);
    if (automatic && state.paused) return false;
    if (!automatic && state.paused) await updateSiteAutoTranslatePause(normalizedUrl, false);
  }
  const query = normalizedUrl
    ? `?url=${encodeURIComponent(normalizedUrl)}&auto=${autoTranslate ? '1' : '0'}`
    : '';
  const studioUrl = chrome.runtime.getURL(`studio/studio.html${query}`);
  const createProps = { url: studioUrl, active: true };
  if (sourceTab && typeof sourceTab.index === 'number') {
    createProps.index = sourceTab.index + 1;
  }
  await chrome.tabs.create(createProps);
  return true;
}

// Show a "PDF" badge on the toolbar icon when the user is viewing an online PDF
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab?.url || '';
  if (!url) return;
  if (isOnlinePdfUrl(url)) {
    chrome.action.setBadgeText({ tabId, text: 'PDF' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#4f46e5' }).catch(() => {});
  } else if (changeInfo.status === 'loading') {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
});

// Register Context Menus on install/update
chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: 'immersive-gemini-toggle-page',
      title: '切换网页双语对照翻译 / 在线 PDF 新标签页精译 (Alt+A)',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'immersive-gemini-translate-image',
      title: '🖼️ 识别并原位翻译此图片中的文字 (青简 · 译读)',
      contexts: ['image']
    });
    chrome.contextMenus.create({
      id: 'immersive-gemini-translate-pdf-link',
      title: '📄 在新标签页双语翻译此在线 PDF (青简 · 译读)',
      contexts: ['link', 'page']
    });
    chrome.contextMenus.create({
      id: 'immersive-gemini-explain-selection',
      title: '使用 AI 深度精解选中文本',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'immersive-gemini-open-studio',
      title: '打开 PDF / EPUB / Markdown 文档翻译工作台',
      contexts: ['page', 'action']
    });
  } catch {
    // ignore duplicate context menu registration notices
  }
});

// Context Menu Click Handler (Always confirms action with visual feedback toast on tab)
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'immersive-gemini-translate-pdf-link') {
    const targetUrl = info.linkUrl || info.srcUrl || info.pageUrl || tab?.url || '';
    await openPdfTranslationNewTab(targetUrl, tab, true);
    return;
  }

  if (info.menuItemId === 'immersive-gemini-open-studio') {
    const candidateUrl = tab?.url && isOnlinePdfUrl(tab.url) ? tab.url : '';
    await openPdfTranslationNewTab(candidateUrl, tab, Boolean(candidateUrl));
    return;
  }

  if (!tab || !tab.id) return;

  if (info.menuItemId === 'immersive-gemini-translate-image' && info.srcUrl) {
    await sendMessageToTabSafely(tab.id, {
      type: MESSAGE_TYPES.SHOW_PAGE_TOAST,
      payload: {
        mode: 'image-translate',
        imageUrl: info.srcUrl
      }
    });
    return;
  }

  if (info.menuItemId === 'immersive-gemini-toggle-page') {
    if (isOnlinePdfUrl(tab.url || info.pageUrl || '')) {
      await openPdfTranslationNewTab(tab.url || info.pageUrl, tab, true);
      return;
    }

    const res = await sendMessageToTabSafely(tab.id, {
      type: MESSAGE_TYPES.TOGGLE_PAGE_TRANSLATION
    });
    if (!res) {
      // Content script might not be injected yet on a pre-existing tab
      try {
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ['content/content.css']
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['shared/protocol.js', 'shared/request-client.js', 'content/content-main.js']
        });
        await sendMessageToTabSafely(tab.id, {
          type: MESSAGE_TYPES.TOGGLE_PAGE_TRANSLATION
        });
      } catch {
        // ignore restricted browser internal pages (chrome://, edge://, chrome web store)
      }
    }
  } else if (info.menuItemId === 'immersive-gemini-explain-selection' && info.selectionText) {
    await sendMessageToTabSafely(tab.id, {
      type: MESSAGE_TYPES.SHOW_PAGE_TOAST,
      payload: {
        mode: 'selection-explain',
        selectionText: info.selectionText
      }
    });
  }
});

// Keyboard Shortcut Commands
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  if (command === 'toggle-page-translation') {
    if (isOnlinePdfUrl(tab.url || '')) {
      await openPdfTranslationNewTab(tab.url, tab, true);
      return;
    }
    await sendMessageToTabSafely(tab.id, {
      type: MESSAGE_TYPES.TOGGLE_PAGE_TRANSLATION
    });
  } else if (command === 'cycle-translation-style') {
    await sendMessageToTabSafely(tab.id, {
      type: MESSAGE_TYPES.CYCLE_TRANSLATION_STYLE
    });
  }
});

/**
 * Handle batch paragraph translation with two-tier cache lookup.
 */
async function handleTranslateBatch(payload, signal, documentConfig) {
  const settings = await getRequestSettings(signal, documentConfig);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length === 0) return { translations: [] };

  const targetLang = payload.targetLang || settings.targetLang;
  const modelId = getActiveModelId(settings);
  const glossarySig = buildStyleSignature(settings);

  const keyedItems = items.map((item, idx) => {
    const id = item.id ?? idx;
    const text = String(item.text || '');
    const cacheKey = buildCacheKey(text, targetLang, modelId, glossarySig, payload.pageTitle || '');
    return { id, text, cacheKey };
  });

  const finalMap = new Map();
  let uncached = keyedItems;
  const bypassCache = Boolean(payload?.bypassCache);

  if (settings.enableCache !== false && !bypassCache) {
    const cachedMap = await getCachedTranslations(keyedItems.map((k) => k.cacheKey));
    uncached = [];
    let hits = 0;
    for (const item of keyedItems) {
      if (cachedMap.has(item.cacheKey)) {
        finalMap.set(item.id, cachedMap.get(item.cacheKey));
        hits++;
      } else {
        uncached.push(item);
      }
    }
    if (hits > 0) {
      await incrementUsageStats({ cacheHits: hits }, settings.requestSignal);
    }
  }

  if (uncached.length > 0) {
    const freshResults = await withConcurrencyLimit(settings.maxConcurrency, () =>
      translateBatchWithGemini(
        uncached.map((u) => ({ id: u.id, text: u.text })),
        settings,
        {
          targetLang,
          pageTitle: payload.pageTitle || ''
        }
      ), signal
    );
    signal?.throwIfAborted();

    const toCache = [];
    for (const res of freshResults) {
      finalMap.set(res.id, res.translation);
      const orig = uncached.find((u) => Number(u.id) === Number(res.id));
      if (orig && res.translation) {
        toCache.push({ key: orig.cacheKey, translation: res.translation });
      }
    }

    if (settings.enableCache !== false && toCache.length > 0) {
      signal?.throwIfAborted();
      await setCachedTranslations(toCache);
    }
  }

  const translations = keyedItems.map((k) => ({
    id: k.id,
    translation: finalMap.get(k.id) ?? k.text,
    cached: !uncached.some((u) => u.id === k.id)
  }));

  signal?.throwIfAborted();
  return { translations, modelId };
}

/**
 * Handle YouTube subtitle cue batch translation with cache support.
 */
async function handleTranslateYoutubeCues(payload, signal) {
  const settings = await getRequestSettings(signal);
  const cues = Array.isArray(payload?.cues) ? payload.cues : [];
  if (cues.length === 0) return { cues: [] };

  const targetLang = settings.targetLang;
  const modelId = getActiveModelId(settings);
  const glossarySig = buildStyleSignature(settings);

  const keyedCues = cues.map((c) => ({
    ...c,
    cacheKey: buildCacheKey(`YT:${c.text}`, targetLang, modelId, glossarySig,
      JSON.stringify([payload.videoTitle || '', payload.contextBefore || '', payload.contextAfter || '']))
  }));

  const finalMap = new Map();
  let uncached = keyedCues;

  if (settings.enableCache !== false) {
    const cachedMap = await getCachedTranslations(keyedCues.map((c) => c.cacheKey));
    uncached = [];
    let hits = 0;
    for (const c of keyedCues) {
      if (cachedMap.has(c.cacheKey)) {
        finalMap.set(String(c.id), cachedMap.get(c.cacheKey));
        hits++;
      } else {
        uncached.push(c);
      }
    }
    if (hits > 0) {
      await incrementUsageStats({ cacheHits: hits }, settings.requestSignal);
    }
  }

  if (uncached.length > 0) {
    const translated = await withConcurrencyLimit(settings.maxConcurrency, () =>
      translateYoutubeCuesWithGemini(
        {
          cues: uncached.map((c) => ({ id: c.id, text: c.text })),
          contextBefore: payload.contextBefore || '',
          contextAfter: payload.contextAfter || '',
          videoTitle: payload.videoTitle || ''
        },
        settings
      ), signal
    );
    signal?.throwIfAborted();

    const toCache = [];
    for (const item of translated) {
      finalMap.set(String(item.id), item.translation);
      const orig = uncached.find((k) => String(k.id) === String(item.id));
      if (orig && item.translation) {
        toCache.push({ key: orig.cacheKey, translation: item.translation });
      }
    }
    if (settings.enableCache !== false && toCache.length > 0) {
      signal?.throwIfAborted();
      await setCachedTranslations(toCache);
    }
  }

  signal?.throwIfAborted();
  return {
    cues: keyedCues.map((c) => ({
      id: c.id,
      translation: finalMap.get(String(c.id)) ?? c.text
    }))
  };
}

// Central runtime message dispatcher
async function dispatchRequest(message, sender, sendResponse, signal) {
    try {
      const documentConfig = requestDocumentConfig(message, sender, chrome.runtime.getURL('studio/studio.html'));
      signal?.throwIfAborted();
      switch (message.type) {
        case MESSAGE_TYPES.GET_SITE_AUTO_TRANSLATE_STATE:
        case MESSAGE_TYPES.SET_SITE_AUTO_TRANSLATE_STATE: {
          const url = await sitePauseRequestUrl(sender, message.payload, chrome.runtime.getURL(''));
          const data = message.type === MESSAGE_TYPES.SET_SITE_AUTO_TRANSLATE_STATE
            ? await updateSiteAutoTranslatePause(url, message.payload?.paused)
            : await getSitePause(url, (await getSettings()).alwaysTranslateDomains);
          sendResponse({ ok: true, data });
          break;
        }
        case MESSAGE_TYPES.UPDATE_CONTENT_SETTINGS: {
          await saveContentSettings(message.payload);
          sendResponse({ ok: true });
          break;
        }
        case MESSAGE_TYPES.TRANSLATE_BATCH: {
          const data = await handleTranslateBatch(message.payload, signal, documentConfig);
          sendResponse({ ok: true, data });
          break;
        }
        case MESSAGE_TYPES.TRANSLATE_SELECTION: {
          const settings = await getRequestSettings(signal);
          const data = await withConcurrencyLimit(settings.maxConcurrency, () => explainSelectionWithGemini(message.payload || {}, settings), signal);
          sendResponse({ ok: true, data });
          break;
        }
        case MESSAGE_TYPES.TRANSLATE_INPUT_TEXT: {
          const settings = await getRequestSettings(signal);
          const translatedText = await withConcurrencyLimit(settings.maxConcurrency, () => translateInputTextWithGemini(message.payload || {}, settings), signal);
          sendResponse({ ok: true, data: { translatedText } });
          break;
        }
        case MESSAGE_TYPES.TRANSLATE_IMAGE: {
          const settings = await getRequestSettings(signal, documentConfig);
          const data = await withConcurrencyLimit(settings.maxConcurrency, () =>
            translateImageWithGemini(message.payload || {}, settings), signal
          );
          sendResponse({ ok: true, data });
          break;
        }
        case MESSAGE_TYPES.TRANSLATE_YOUTUBE_CUES: {
          const data = await handleTranslateYoutubeCues(message.payload || {}, signal);
          sendResponse({ ok: true, data });
          break;
        }
        case MESSAGE_TYPES.TRANSLATE_YOUTUBE_AUDIO: {
          const settings = await getRequestSettings(signal);
          const data = await withConcurrencyLimit(settings.maxConcurrency, () => translateYoutubeAudioWithGemini(message.payload || {}, settings), signal);
          sendResponse({ ok: true, data });
          break;
        }
        case MESSAGE_TYPES.ANALYZE_PDF_MULTIMODAL: {
          const settings = await getRequestSettings(signal, documentConfig);
          const blocks = await withConcurrencyLimit(settings.maxConcurrency, () => analyzePdfWithGemini(message.payload || {}, settings), signal);
          sendResponse({ ok: true, data: { blocks } });
          break;
        }
        case MESSAGE_TYPES.TEST_API_KEY: {
          const current = await getSettings();
          const merged = { ...current, ...(message.payload || {}), requestSignal: signal };
          const res = await testGeminiConnection(merged);
          sendResponse({ ok: true, data: res });
          break;
        }
        case MESSAGE_TYPES.FETCH_MODELS: {
          const current = await getSettings();
          const merged = { ...current, ...(message.payload || {}), requestSignal: signal };
          const models = await fetchAvailableModels(merged);
          let nextModelId = merged.modelId;
          if (models.length > 0 && !models.some((m) => m.id === nextModelId)) {
            nextModelId = models[0].id;
          }
          signal?.throwIfAborted();
          // Model discovery is read-only; the requesting UI owns configuration updates.
          sendResponse({ ok: true, data: { models, selectedModelId: nextModelId } });
          break;
        }
        case MESSAGE_TYPES.GET_CACHE_STATS: {
          const [cacheStats, usageStats] = await Promise.all([
            getCacheStats(),
            getUsageStats()
          ]);
          sendResponse({ ok: true, data: { ...cacheStats, ...usageStats } });
          break;
        }
        case MESSAGE_TYPES.CLEAR_CACHE: {
          const res = await clearAllCache();
          sendResponse({ ok: res.cleared, data: res, error: res.cleared ? undefined : '内存缓存已清空，磁盘缓存清理失败，请重试。' });
          break;
        }
        case MESSAGE_TYPES.OPEN_OPTIONS_PAGE: {
          await chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        }
        case MESSAGE_TYPES.OPEN_DOCUMENT_STUDIO: {
          const pdfUrl = message.payload?.pdfUrl || '';
          const autoTranslate = message.payload?.autoTranslate !== false;
          const opened = await openPdfTranslationNewTab(pdfUrl, sender?.tab || null, Boolean(pdfUrl && autoTranslate), message.payload?.automatic === true);
          sendResponse({ ok: true, opened, paused: !opened });
          break;
        }
        case MESSAGE_TYPES.SYNC_TAB_BADGE: {
          const tabId = sender?.tab?.id;
          if (tabId) {
            const isTranslated = Boolean(message.payload?.isPageTranslated);
            const tabUrl = sender?.tab?.url || '';
            if (isOnlinePdfUrl(tabUrl)) {
              await chrome.action.setBadgeText({ tabId, text: 'PDF' }).catch(() => {});
              await chrome.action.setBadgeBackgroundColor({ tabId, color: '#4f46e5' }).catch(() => {});
            } else if (isTranslated) {
              await chrome.action.setBadgeText({ tabId, text: '✓' }).catch(() => {});
              await chrome.action.setBadgeBackgroundColor({ tabId, color: '#10b981' }).catch(() => {});
            } else {
              await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
            }
          }
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      sendResponse({
        ok: false,
        cancelled: Boolean(signal?.aborted),
        error: signal?.aborted ? '请求已取消' : err?.message || String(err)
      });
    }
}

async function dispatchMessage(message, sender, sendResponse, requestBudget) {
  if (!cancellableTypes.has(message.type)) return dispatchRequest(message, sender, sendResponse);
  const budget = requestBudget || createRequestBudget();
  try {
    const settings = await budget.wait(getSettings());
    budget.configure(normalizeRequestBudgetSeconds(settings.requestBudgetSeconds) * 1000);
    budget.signal.throwIfAborted();
    const response = await budget.wait(new Promise(resolve => {
      void dispatchRequest(message, sender, resolve, budget.signal);
    }));
    budget.signal.throwIfAborted();
    sendResponse(response);
  } catch (error) {
    const timedOut = budget.signal.aborted && budget.signal.reason?.name === 'TimeoutError';
    sendResponse({ ok: false, timedOut, cancelled: budget.signal.aborted && !timedOut,
      error: timedOut ? budget.signal.reason.message : budget.signal.aborted ? '请求已取消' : error?.message || String(error) });
  } finally {
    budget.dispose();
  }
}

// Keep non-model commands and older installed clients compatible.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return false;
  void dispatchMessage(message, sender, sendResponse);
  return true;
});

const cancellableTypes = new Set([
  MESSAGE_TYPES.TRANSLATE_BATCH, MESSAGE_TYPES.TRANSLATE_SELECTION,
  MESSAGE_TYPES.TRANSLATE_INPUT_TEXT, MESSAGE_TYPES.TRANSLATE_IMAGE,
  MESSAGE_TYPES.TRANSLATE_YOUTUBE_CUES, MESSAGE_TYPES.TRANSLATE_YOUTUBE_AUDIO,
  MESSAGE_TYPES.ANALYZE_PDF_MULTIMODAL, MESSAGE_TYPES.TEST_API_KEY, MESSAGE_TYPES.FETCH_MODELS
]);
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'qingjian-request-v1') return;
  const controllers = new Map();
  let disconnected = false;
  let keepaliveTimer = null;
  const pingKeepalive = () => {
    if (disconnected || controllers.size === 0) return;
    try { chrome.runtime?.getPlatformInfo?.().catch?.(() => {}); } catch {}
    try { port.postMessage({ type: 'keepalive' }); } catch {}
  };
  const syncKeepalive = () => {
    if (disconnected || controllers.size === 0) {
      if (keepaliveTimer !== null) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      return;
    }
    if (keepaliveTimer === null) {
      keepaliveTimer = setInterval(pingKeepalive, 15000);
      keepaliveTimer?.unref?.();
    }
  };
  port.onDisconnect.addListener(() => {
    disconnected = true;
    syncKeepalive();
    // Abort the entire scope in one event before any freed slot admits a waiter.
    abortRequestScope(controllers.values());
    controllers.clear();
  });
  port.onMessage.addListener((packet = {}) => {
    if (disconnected) return;
    if (packet?.type === 'keepalive') {
      pingKeepalive();
      return;
    }
    const { requestId, message } = packet;
    if (!Number.isSafeInteger(requestId) || controllers.has(requestId)) return;
    if (!cancellableTypes.has(message?.type)) {
      port.postMessage({ requestId, response: { ok: false, error: '不支持的可取消请求' } });
      return;
    }
    const budget = createRequestBudget();
    const controller = budget.controller;
    controllers.set(requestId, controller);
    syncKeepalive();
    void dispatchMessage(message, port.sender, response => {
      controllers.delete(requestId);
      syncKeepalive();
      if (disconnected) return;
      try { port.postMessage({ requestId, response }); } catch { controller.abort(); }
    }, budget);
  });
});
