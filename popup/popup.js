/**
 * Popup Quick-Control Panel Script.
 */

import {
  LLM_PROVIDERS,
  LANGUAGES,
  TRANSLATION_STYLES,
  MESSAGE_TYPES
} from '../shared/constants.js';
import {
  getSettings,
  saveSettings,
  getProviderDefinition,
  getActiveModelId,
  getMergedModelList
} from '../shared/storage.js';
import { isOnlinePdfUrl, normalizeOnlinePdfUrl } from '../shared/utils.js';
import '../shared/request-client.js';

const popupRequests = globalThis.QingJianRequests.createScope();
const quickRequests = globalThis.QingJianRequests.createScope();
window.addEventListener('pagehide', () => {
  invalidatePopupModelRequests();
  quickRequests.cancel();
});

const apiKeyStatusBadge = document.getElementById('apiKeyStatusBadge');
const openOptionsBtn = document.getElementById('openOptionsBtn');
const toggleTranslateBtn = document.getElementById('toggleTranslateBtn');
const toggleBtnIcon = document.getElementById('toggleBtnIcon');
const toggleBtnLabel = document.getElementById('toggleBtnLabel');
const toggleBtnSub = document.getElementById('toggleBtnSub');
const popupSwitchTrack = document.getElementById('popupSwitchTrack');
const autoTranslateDomainCheckbox = document.getElementById('autoTranslateDomainCheckbox');
const autoTranslateAllCheckbox = document.getElementById('autoTranslateAllCheckbox');
const autoTranslateOnlinePdfCheckbox = document.getElementById('autoTranslateOnlinePdfCheckbox');
const currentDomainText = document.getElementById('currentDomainText');
const popupProviderSelect = document.getElementById('popupProviderSelect');
const modelSelect = document.getElementById('modelSelect');
const targetLangSelect = document.getElementById('targetLangSelect');
const styleGrid = document.getElementById('styleGrid');
const quickInput = document.getElementById('quickInput');
const quickTranslateBtn = document.getElementById('quickTranslateBtn');
const quickOutput = document.getElementById('quickOutput');
const openStudioBtn = document.getElementById('openStudioBtn');
const statsSummaryText = document.getElementById('statsSummaryText');

let currentSettings = null;
let activeTab = null;
let currentHost = '';
let isActiveTabOnlinePdf = false;
let isPageCurrentlyTranslated = false;
let isSiteAutoPaused = false;
let popupModelGeneration = 0;

function invalidatePopupModelRequests() {
  popupModelGeneration++;
  popupRequests.cancel();
}

async function refreshPopupModels(expected, generation = popupModelGeneration) {
  try {
    const res = await popupRequests.request({ type: MESSAGE_TYPES.FETCH_MODELS, payload: expected });
    if (!res?.ok || generation !== popupModelGeneration) return;
    const updated = await saveSettings({
      availableModels: res.data.models, modelId: res.data.selectedModelId
    }, { expected });
    if (!updated || generation !== popupModelGeneration) return;
    currentSettings = updated;
    populatePopupProviderSelect(updated);
    populatePopupModelSelect(updated);
    updatePopupStatusBadge(updated);
  } catch {
    // Silent discovery remains optional; settings provides explicit failure feedback.
  }
}

function populatePopupProviderSelect(settings) {
  if (!popupProviderSelect) return;
  const configs = settings?.providerConfigs || {};
  popupProviderSelect.textContent = '';
  for (const p of LLM_PROVIDERS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    const hasConfiguredKey = Boolean(configs[p.id]?.apiKey && String(configs[p.id].apiKey).trim());
    opt.textContent = hasConfiguredKey ? `● ${p.shortName}` : p.shortName;
    popupProviderSelect.appendChild(opt);
  }
  popupProviderSelect.value = settings?.providerId || 'google';
}

function updatePopupStatusBadge(settings) {
  const provider = getProviderDefinition(settings.providerId);
  const hasKey = Boolean(settings.apiKey && settings.apiKey.trim());
  const activeModel = getActiveModelId(settings);
  if (hasKey && activeModel) {
    apiKeyStatusBadge.textContent = `已配置 · ${provider.shortName} · ${activeModel}`;
    apiKeyStatusBadge.className = 'brand-sub is-ok';
  } else if (!hasKey) {
    apiKeyStatusBadge.textContent = `⚠️ 尚未配置 ${provider.shortName} Key 与模型 (点击去设置)`;
    apiKeyStatusBadge.className = 'brand-sub is-missing';
  } else {
    apiKeyStatusBadge.textContent = `⚠️ 尚未选择或填写模型 ID (点击去设置)`;
    apiKeyStatusBadge.className = 'brand-sub is-missing';
  }
}

function populatePopupModelSelect(settings) {
  const models = getMergedModelList(settings);
  modelSelect.textContent = '';

  if (models.length === 0) {
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '未配置模型 (请先在 ⚙️ 设置中拉取或手填)';
    modelSelect.appendChild(emptyOpt);
    modelSelect.value = '';
    return;
  }

  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    modelSelect.appendChild(opt);
  }

  const activeId = getActiveModelId(settings);
  if (activeId && models.some((m) => m.id === activeId)) {
    modelSelect.value = activeId;
  } else if (models.length > 0) {
    modelSelect.value = models[0].id;
  }
}

async function initPopup() {
  currentSettings = await getSettings();

  populatePopupProviderSelect(currentSettings);
  populatePopupModelSelect(currentSettings);

  // If API Key exists and dynamic models haven't been fetched yet, fetch silently in background
  if (
    currentSettings.apiKey &&
    (!currentSettings.availableModels || currentSettings.availableModels.length === 0)
  ) {
    void refreshPopupModels(currentSettings);
  }

  targetLangSelect.innerHTML = LANGUAGES.map(
    (l) => `<option value="${l.code}">${l.name}</option>`
  ).join('');
  targetLangSelect.value = currentSettings.targetLang;

  // Populate Style Grid
  renderStyleChips(currentSettings.translationStyle);

  // API Key & Model Status
  updatePopupStatusBadge(currentSettings);

  // Query active tab status
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs[0] || null;
  if (activeTab && activeTab.url) {
    isActiveTabOnlinePdf = isOnlinePdfUrl(activeTab.url);
    try {
      const urlObj = new URL(activeTab.url);
      const isHttpTab = urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
      currentHost = isHttpTab ? urlObj.hostname.toLowerCase() : '';
      currentDomainText.textContent = currentHost || '当前站点';
      if (autoTranslateDomainCheckbox) {
        autoTranslateDomainCheckbox.disabled = !currentHost;
      }
      const domains = (currentSettings.alwaysTranslateDomains || '')
        .split(/\r?\n/)
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);
      autoTranslateDomainCheckbox.checked = Boolean(
        currentHost &&
          domains.some((d) => currentHost === d || currentHost.endsWith('.' + d))
      );
    } catch {
      currentDomainText.textContent = '当前页面';
      if (autoTranslateDomainCheckbox) {
        autoTranslateDomainCheckbox.disabled = true;
      }
    }
  } else if (autoTranslateDomainCheckbox) {
    autoTranslateDomainCheckbox.disabled = true;
  }
  if (autoTranslateAllCheckbox) {
    autoTranslateAllCheckbox.checked = Boolean(currentSettings.autoTranslateAllPages);
  }
  if (autoTranslateOnlinePdfCheckbox) {
    autoTranslateOnlinePdfCheckbox.checked = Boolean(currentSettings.autoTranslateOnlinePdf);
  }

  await syncActiveTabTranslationStatus();
  await loadCacheStats();
}

function renderStyleChips(activeStyle) {
  styleGrid.innerHTML = TRANSLATION_STYLES.map((s) => {
    const isSelected = s.id === activeStyle;
    const stateClass = isSelected
      ? isPageCurrentlyTranslated
        ? 'is-active'
        : 'is-preset'
      : '';
    const tickHtml =
      isSelected && isPageCurrentlyTranslated ? '<span class="style-chip-tick">✓</span>' : '';
    return `
      <button class="style-chip ${stateClass}" data-style="${s.id}" title="${s.desc}">
        ${tickHtml}<span>${s.name.split(' ')[0]}</span>
      </button>
    `;
  }).join('');

  styleGrid.querySelectorAll('.style-chip').forEach((chip) => {
    chip.addEventListener('click', async () => {
      const styleId = chip.dataset.style;
      currentSettings = await saveSettings({ translationStyle: styleId });
      if (activeTab?.id && !isActiveTabOnlinePdf) {
        try {
          await chrome.tabs.sendMessage(activeTab.id, {
            type: MESSAGE_TYPES.SET_TRANSLATION_STYLE,
            payload: { style: styleId }
          });
          if (!isPageCurrentlyTranslated) {
            const res = await chrome.tabs.sendMessage(activeTab.id, {
              type: MESSAGE_TYPES.TOGGLE_PAGE_TRANSLATION
            });
            if (res && res.ok) {
              isSiteAutoPaused = Boolean(res.siteAutoPaused);
              updateToggleButtonUI(res.isPageTranslated, res.totalTranslatedCount);
              return;
            }
          }
        } catch {
          // ignore if restricted tab
        }
      }
      renderStyleChips(styleId);
    });
  });
}

async function syncActiveTabTranslationStatus() {
  if (!activeTab?.id) return;
  try {
    const state = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.GET_SITE_AUTO_TRANSLATE_STATE, payload: { tabId: activeTab.id } });
    if (state?.ok) isSiteAutoPaused = state.data.paused;
  } catch { /* Restricted tabs have no site pause. */ }
  if (isActiveTabOnlinePdf) {
    updateToggleButtonUI(false, 0, false, true);
    return;
  }
  try {
    const status = await chrome.tabs.sendMessage(activeTab.id, {
      type: MESSAGE_TYPES.GET_PAGE_STATUS
    });
    if (status && status.ok) {
      if (status.isPdf) {
        isActiveTabOnlinePdf = true;
      }
      updateToggleButtonUI(
        status.isPageTranslated,
        status.totalTranslatedCount,
        status.isYoutube,
        isActiveTabOnlinePdf
      );
    }
  } catch {
    // Content script not yet injected on this tab
  }
}

function updateToggleButtonUI(isTranslated, count = 0, isYoutube = false, isPdf = false) {
  isPageCurrentlyTranslated = Boolean(isTranslated && !isPdf);

  if (isPdf) {
    toggleTranslateBtn.classList.remove('is-active');
    toggleTranslateBtn.classList.add('is-pdf');
    if (popupSwitchTrack) popupSwitchTrack.hidden = true;
    toggleBtnIcon.textContent = '📄';
    toggleBtnLabel.textContent = '新建标签页开启此在线 PDF 双语翻译 ↗';
    toggleBtnSub.textContent = isSiteAutoPaused ? '本站本次会话已暂停自动翻译 · 点击可恢复并打开工作台' : '已识别在线 PDF 文档 · 点击即刻拉取并对照精译 (Alt+A)';
    if (currentSettings) renderStyleChips(currentSettings.translationStyle);
    return;
  }

  toggleTranslateBtn.classList.remove('is-pdf');
  if (popupSwitchTrack) popupSwitchTrack.hidden = false;

  if (isTranslated) {
    toggleTranslateBtn.classList.add('is-active');
    toggleBtnIcon.textContent = '✓';
    toggleBtnLabel.textContent = '双语对照翻译：已开启';
    toggleBtnSub.textContent = `当前页已翻译 ${count || 0} 个段落 · 点击关闭并恢复原文`;
  } else {
    toggleTranslateBtn.classList.remove('is-active');
    toggleBtnIcon.textContent = '';
    toggleBtnLabel.textContent = isSiteAutoPaused ? '本站本次会话已暂停' : isYoutube
      ? '网页评论翻译：未开启 (视频字幕已接管)'
      : '双语对照翻译：未开启';
    toggleBtnSub.textContent = isSiteAutoPaused ? '手动开启可恢复本站自动翻译；重启浏览器后恢复规则' : '点击此处或按 Alt + A 立即开启对照翻译';
  }

  if (currentSettings) {
    renderStyleChips(currentSettings.translationStyle);
  }
}

async function loadCacheStats() {
  try {
    const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.GET_CACHE_STATS });
    if (res && res.ok && res.data) {
      const d = res.data;
      statsSummaryText.textContent = `已译 ${d.totalParagraphs || 0} 段 · 缓存命中 ${
        d.cacheHits || 0
      } 次`;
    }
  } catch {
    // ignore
  }
}

async function resumeSiteAutoTranslate() {
  if (!activeTab?.id) return false;
  try {
    const state = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SET_SITE_AUTO_TRANSLATE_STATE, payload: { tabId: activeTab.id, paused: false } });
    if (!state?.ok) throw new Error(state?.error || '请重试');
    isSiteAutoPaused = false;
    return true;
  } catch (error) {
    toggleBtnSub.textContent = `本站临时暂停状态保存失败：${error?.message || '请刷新后重试'}`;
    return false;
  }
}

async function launchOnlinePdfInNewTab() {
  if (!activeTab?.url || !await resumeSiteAutoTranslate()) return;
  const pdfUrl = normalizeOnlinePdfUrl(activeTab.url);
  const studioUrl = chrome.runtime.getURL(
    `studio/studio.html?url=${encodeURIComponent(pdfUrl)}&auto=1`
  );
  const createProps = { url: studioUrl, active: true };
  if (typeof activeTab.index === 'number') {
    createProps.index = activeTab.index + 1;
  }
  await chrome.tabs.create(createProps);
  window.close();
}

// Event Listeners
toggleTranslateBtn.addEventListener('click', async () => {
  if (!activeTab?.id) return;
  if (isActiveTabOnlinePdf) {
    await launchOnlinePdfInNewTab();
    return;
  }
  try {
    const res = await chrome.tabs.sendMessage(activeTab.id, {
      type: MESSAGE_TYPES.TOGGLE_PAGE_TRANSLATION
    });
    if (res && res.ok) {
      if (res.openedPdfTab) {
        window.close();
        return;
      }
      isSiteAutoPaused = Boolean(res.siteAutoPaused);
      updateToggleButtonUI(res.isPageTranslated, res.totalTranslatedCount);
      return;
    }
  } catch {
    // Inject content script dynamically if tab was open before extension load
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: activeTab.id },
        files: ['content/content.css']
      });
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ['shared/protocol.js', 'shared/request-client.js', 'content/content-main.js']
      });
      const res = await chrome.tabs.sendMessage(activeTab.id, {
        type: MESSAGE_TYPES.TOGGLE_PAGE_TRANSLATION
      });
      if (res && res.ok) {
        isSiteAutoPaused = Boolean(res.siteAutoPaused);
        updateToggleButtonUI(res.isPageTranslated, res.totalTranslatedCount);
      }
    } catch {
      toggleBtnSub.textContent = '⚠️ Chrome 内部页面不支持脚本注入，请打开普通网页或文档工作台';
    }
  }
});

popupProviderSelect?.addEventListener('change', async () => {
  invalidatePopupModelRequests();
  const generation = popupModelGeneration;
  const nextProviderId = popupProviderSelect.value;
  const nextDef = getProviderDefinition(nextProviderId);
  const savedCfg = currentSettings?.providerConfigs?.[nextProviderId] || {};

  const updated = await saveSettings({
    providerId: nextProviderId,
    apiProtocol: savedCfg.apiProtocol || nextDef.protocol,
    apiBaseUrl: savedCfg.apiBaseUrl || nextDef.defaultBaseUrl,
    apiKey: savedCfg.apiKey || '',
    modelId: savedCfg.modelId || nextDef.defaultModel || '',
    customModelId: savedCfg.customModelId || '',
    availableModels: Array.isArray(savedCfg.availableModels) ? savedCfg.availableModels : []
  });
  if (generation !== popupModelGeneration) return;
  currentSettings = updated;

  populatePopupProviderSelect(currentSettings);
  populatePopupModelSelect(currentSettings);
  updatePopupStatusBadge(currentSettings);

  if (
    currentSettings.apiKey &&
    (!currentSettings.availableModels || currentSettings.availableModels.length === 0)
  ) {
    await refreshPopupModels(currentSettings, generation);
  }
});

modelSelect.addEventListener('change', async () => {
  invalidatePopupModelRequests();
  const generation = popupModelGeneration;
  const val = modelSelect.value;
  const updated = await saveSettings({ modelId: val, customModelId: '' });
  if (generation !== popupModelGeneration) return;
  currentSettings = updated;
  updatePopupStatusBadge(currentSettings);
});

targetLangSelect.addEventListener('change', async () => {
  currentSettings = await saveSettings({ targetLang: targetLangSelect.value });
});

autoTranslateDomainCheckbox.addEventListener('change', async () => {
  if (!currentHost) return;
  const list = (currentSettings.alwaysTranslateDomains || '')
    .split(/\r?\n/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const set = new Set(list);
  if (autoTranslateDomainCheckbox.checked) {
    set.add(currentHost);
  } else {
    for (const d of list) {
      if (currentHost === d || currentHost.endsWith('.' + d)) {
        set.delete(d);
      }
    }
  }
  currentSettings = await saveSettings({
    alwaysTranslateDomains: Array.from(set).join('\n')
  });
  if (autoTranslateDomainCheckbox.checked && !await resumeSiteAutoTranslate()) return;
  await syncActiveTabTranslationStatus();
});

autoTranslateAllCheckbox?.addEventListener('change', async () => {
  currentSettings = await saveSettings({
    autoTranslateAllPages: Boolean(autoTranslateAllCheckbox.checked)
  });
  if (autoTranslateAllCheckbox.checked && !await resumeSiteAutoTranslate()) return;
  await syncActiveTabTranslationStatus();
});

autoTranslateOnlinePdfCheckbox?.addEventListener('change', async () => {
  const enabled = Boolean(autoTranslateOnlinePdfCheckbox.checked);
  currentSettings = await saveSettings({
    autoTranslateOnlinePdf: enabled
  });
  if (enabled && !await resumeSiteAutoTranslate()) return;
  if (enabled && isActiveTabOnlinePdf) {
    await launchOnlinePdfInNewTab();
  }
});

async function runQuickTranslate() {
  const text = quickInput.value.trim();
  if (!text) return;
  quickRequests.cancel();
  quickOutput.hidden = false;
  quickOutput.textContent = 'AI 正在思考与翻译…';
  try {
    const res = await quickRequests.request({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: {
        items: [{ id: 0, text }],
        targetLang: targetLangSelect.value
      }
    });
    if (res?.cancelled) return;
    if (!res || !res.ok) {
      throw new Error(res?.error || '请求失败');
    }
    const trans = res.data?.translations?.[0]?.translation || '';
    quickOutput.textContent = trans;
    await loadCacheStats();
  } catch (err) {
    quickOutput.textContent = `⚠️ ${err?.message || '翻译失败'}`;
  }
}

quickTranslateBtn.addEventListener('click', runQuickTranslate);
quickInput.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    runQuickTranslate();
  }
});

openOptionsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

apiKeyStatusBadge.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

openStudioBtn.addEventListener('click', async () => {
  if (isActiveTabOnlinePdf && activeTab?.url) {
    await launchOnlinePdfInNewTab();
    return;
  }
  const studioUrl = chrome.runtime.getURL('studio/studio.html');
  await chrome.tabs.create({ url: studioUrl });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.qingjian_site_pause_v1) void syncActiveTabTranslationStatus();
});

initPopup();
