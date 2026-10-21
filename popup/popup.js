/**
 * Popup Quick-Control Panel Script.
 */

import {
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
  const provider = getProviderDefinition(currentSettings.providerId);

  populatePopupModelSelect(currentSettings);

  // If API Key exists and dynamic models haven't been fetched yet, fetch silently in background
  if (
    currentSettings.apiKey &&
    (!currentSettings.availableModels || currentSettings.availableModels.length === 0)
  ) {
    (async () => {
      try {
        const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.FETCH_MODELS });
        if (res && res.ok) {
          currentSettings = await getSettings();
          populatePopupModelSelect(currentSettings);
          const pDef = getProviderDefinition(currentSettings.providerId);
          apiKeyStatusBadge.textContent = `● ${pDef.shortName} · ${getActiveModelId(currentSettings)}`;
        }
      } catch {
        // ignore
      }
    })();
  }

  targetLangSelect.innerHTML = LANGUAGES.map(
    (l) => `<option value="${l.code}">${l.name}</option>`
  ).join('');
  targetLangSelect.value = currentSettings.targetLang;

  // Populate Style Grid
  renderStyleChips(currentSettings.translationStyle);

  // API Key & Model Status
  const hasKey = Boolean(currentSettings.apiKey && currentSettings.apiKey.trim());
  const activeModel = getActiveModelId(currentSettings);
  if (hasKey && activeModel) {
    apiKeyStatusBadge.textContent = `● ${provider.shortName} · ${activeModel}`;
    apiKeyStatusBadge.className = 'brand-sub is-ok';
  } else if (!hasKey) {
    apiKeyStatusBadge.textContent = `⚠️ 尚未配置 ${provider.shortName} Key 与模型 (点击去设置)`;
    apiKeyStatusBadge.className = 'brand-sub is-missing';
  } else {
    apiKeyStatusBadge.textContent = `⚠️ 尚未选择或填写模型 ID (点击去设置)`;
    apiKeyStatusBadge.className = 'brand-sub is-missing';
  }

  // Query active tab status
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs[0] || null;
  if (activeTab && activeTab.url) {
    isActiveTabOnlinePdf = isOnlinePdfUrl(activeTab.url);
    try {
      const urlObj = new URL(activeTab.url);
      currentHost = urlObj.hostname.toLowerCase();
      currentDomainText.textContent = currentHost || '当前站点';
      const domains = (currentSettings.alwaysTranslateDomains || '')
        .split(/\r?\n/)
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);
      autoTranslateDomainCheckbox.checked = domains.includes(currentHost);
    } catch {
      currentDomainText.textContent = '当前页面';
    }
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
    toggleBtnSub.textContent = '已识别在线 PDF 文档 · 点击即刻拉取并对照精译 (Alt+A)';
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
    toggleBtnLabel.textContent = isYoutube
      ? '网页评论翻译：未开启 (视频字幕已接管)'
      : '双语对照翻译：未开启';
    toggleBtnSub.textContent = '点击此处或按 Alt + A 立即开启对照翻译';
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

async function launchOnlinePdfInNewTab() {
  if (!activeTab?.url) return;
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
        files: ['content/content-main.js']
      });
      const res = await chrome.tabs.sendMessage(activeTab.id, {
        type: MESSAGE_TYPES.TOGGLE_PAGE_TRANSLATION
      });
      if (res && res.ok) {
        updateToggleButtonUI(res.isPageTranslated, res.totalTranslatedCount);
      }
    } catch {
      toggleBtnSub.textContent = '⚠️ Chrome 内部页面不支持脚本注入，请打开普通网页或文档工作台';
    }
  }
});

modelSelect.addEventListener('change', async () => {
  const val = modelSelect.value;
  currentSettings = await saveSettings({ modelId: val, customModelId: '' });
  if (currentSettings.apiKey) {
    apiKeyStatusBadge.textContent = `● API 已就绪 (${getActiveModelId(currentSettings)})`;
  }
});

targetLangSelect.addEventListener('change', async () => {
  currentSettings = await saveSettings({ targetLang: targetLangSelect.value });
});

autoTranslateDomainCheckbox.addEventListener('change', async () => {
  if (!currentHost) return;
  const set = new Set(
    (currentSettings.alwaysTranslateDomains || '')
      .split(/\r?\n/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  if (autoTranslateDomainCheckbox.checked) {
    set.add(currentHost);
  } else {
    set.delete(currentHost);
  }
  currentSettings = await saveSettings({
    alwaysTranslateDomains: Array.from(set).join('\n')
  });
});

autoTranslateAllCheckbox?.addEventListener('change', async () => {
  currentSettings = await saveSettings({
    autoTranslateAllPages: Boolean(autoTranslateAllCheckbox.checked)
  });
});

autoTranslateOnlinePdfCheckbox?.addEventListener('change', async () => {
  const enabled = Boolean(autoTranslateOnlinePdfCheckbox.checked);
  currentSettings = await saveSettings({
    autoTranslateOnlinePdf: enabled
  });
  if (enabled && isActiveTabOnlinePdf) {
    await launchOnlinePdfInNewTab();
  }
});

async function runQuickTranslate() {
  const text = quickInput.value.trim();
  if (!text) return;
  quickOutput.hidden = false;
  quickOutput.textContent = 'AI 正在思考与翻译…';
  try {
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.TRANSLATE_BATCH,
      payload: {
        items: [{ id: 0, text }],
        targetLang: targetLangSelect.value
      }
    });
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

initPopup();
