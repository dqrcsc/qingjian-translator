/**
 * Options Page Controller for Immersive Gemini.
 */

import {
  LLM_PROVIDERS,
  TRANSLATION_STYLES,
  LANGUAGES,
  TONE_PRESETS,
  MESSAGE_TYPES
} from '../shared/constants.js';
import {
  getSettings,
  saveSettings,
  resetSettings,
  getProviderDefinition,
  getMergedModelList
} from '../shared/storage.js';

const providerSelect = document.getElementById('providerSelect');
const apiProtocolSelect = document.getElementById('apiProtocolSelect');
const providerHelpText = document.getElementById('providerHelpText');
const apiKeyLabelText = document.getElementById('apiKeyLabelText');
const apiKeyInput = document.getElementById('apiKeyInput');
const toggleKeyVisBtn = document.getElementById('toggleKeyVisBtn');
const testApiBtn = document.getElementById('testApiBtn');
const fetchModelsBtn = document.getElementById('fetchModelsBtn');
const modelListCountBadge = document.getElementById('modelListCountBadge');
const apiTestResult = document.getElementById('apiTestResult');
const modelIdSelect = document.getElementById('modelIdSelect');
const customModelIdInput = document.getElementById('customModelIdInput');
const apiBaseUrlInput = document.getElementById('apiBaseUrlInput');
const resetBaseUrlBtn = document.getElementById('resetBaseUrlBtn');
const temperatureInput = document.getElementById('temperatureInput');
const tempVal = document.getElementById('tempVal');

const targetLangSelect = document.getElementById('targetLangSelect');
const inputTargetLangSelect = document.getElementById('inputTargetLangSelect');
const stylePreviewCards = document.getElementById('stylePreviewCards');

const enableFloatingBallCheck = document.getElementById('enableFloatingBallCheck');
const enableSelectionTooltipCheck = document.getElementById('enableSelectionTooltipCheck');
const enableTripleSpaceInputCheck = document.getElementById('enableTripleSpaceInputCheck');
const enableHoverTranslateCheck = document.getElementById('enableHoverTranslateCheck');
const enableImageTranslateCheck = document.getElementById('enableImageTranslateCheck');
const autoTranslatePageImagesCheck = document.getElementById('autoTranslatePageImagesCheck');

const youtubeAutoEnableCheck = document.getElementById('youtubeAutoEnableCheck');
const youtubeShowSidebarCheck = document.getElementById('youtubeShowSidebarCheck');
const youtubeSubFontSizeInput = document.getElementById('youtubeSubFontSizeInput');
const youtubeTransColorInput = document.getElementById('youtubeTransColorInput');

const tonePresetSelect = document.getElementById('tonePresetSelect');
const glossaryTextarea = document.getElementById('glossaryTextarea');
const customSystemPromptTextarea = document.getElementById('customSystemPromptTextarea');

const autoTranslateOnlinePdfCheck = document.getElementById('autoTranslateOnlinePdfCheck');
const enableCacheCheck = document.getElementById('enableCacheCheck');
const alwaysTranslateDomainsTextarea = document.getElementById('alwaysTranslateDomainsTextarea');
const neverTranslateDomainsTextarea = document.getElementById('neverTranslateDomainsTextarea');
const batchMaxItemsInput = document.getElementById('batchMaxItemsInput');
const maxConcurrencyInput = document.getElementById('maxConcurrencyInput');

const cacheStatsTitle = document.getElementById('cacheStatsTitle');
const clearCacheBtn = document.getElementById('clearCacheBtn');
const resetDefaultBtn = document.getElementById('resetDefaultBtn');
const saveAllBtn = document.getElementById('saveAllBtn');
const saveStatusToast = document.getElementById('saveStatusToast');
const openStudioFromOptionsBtn = document.getElementById('openStudioFromOptionsBtn');

let selectedStyleId = 'clean';
let activeProviderId = 'google';
let cachedProviderConfigs = {};

function populateStaticOptions() {
  if (providerSelect) {
    providerSelect.innerHTML = LLM_PROVIDERS.map(
      (p) => `<option value="${p.id}">${p.name}</option>`
    ).join('');
  }

  const langHtml = LANGUAGES.map((l) => `<option value="${l.code}">${l.name}</option>`).join('');
  targetLangSelect.innerHTML = langHtml;
  inputTargetLangSelect.innerHTML = langHtml;

  tonePresetSelect.innerHTML = Object.entries(TONE_PRESETS)
    .map(([key, val]) => `<option value="${key}">${val.name}</option>`)
    .join('');
}

function updateProviderMetaUi(providerId) {
  const provider = getProviderDefinition(providerId);
  if (providerHelpText) {
    providerHelpText.textContent = provider.helpText || '';
  }
  if (apiKeyLabelText) {
    apiKeyLabelText.textContent = `${provider.shortName} API Key`;
  }
  if (apiKeyInput) {
    apiKeyInput.placeholder = provider.keyPlaceholder || '在此粘贴您的 API Key...';
  }
  if (apiBaseUrlInput) {
    apiBaseUrlInput.placeholder = provider.defaultBaseUrl || '';
  }
  if (customModelIdInput) {
    customModelIdInput.placeholder =
      provider.modelPlaceholder || '直接输入您拥有的模型 ID；留空则使用左侧下拉模型';
  }
}

function renderModelDropdown(settings, selectedIdOverride = '') {
  const models = getMergedModelList(settings);
  const dynamicCount = Array.isArray(settings?.availableModels)
    ? settings.availableModels.length
    : 0;

  if (dynamicCount > 0) {
    modelListCountBadge.textContent = `(已同步此 Key 支持的 ${dynamicCount} 个模型)`;
  } else if (models.length > 0) {
    modelListCountBadge.textContent = `(已配置自定义模型 · 点击右侧按钮可从接口同步列表)`;
  } else {
    modelListCountBadge.textContent = `(尚未配置 · 请点击右侧拉取，或在旁侧手动输入模型 ID)`;
  }

  modelIdSelect.textContent = '';
  if (models.length === 0) {
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '-- 尚未配置模型（请点击右侧拉取，或在右侧输入框手填模型 ID） --';
    modelIdSelect.appendChild(emptyOpt);
    modelIdSelect.value = '';
    return;
  }

  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    modelIdSelect.appendChild(opt);
  }

  const targetId = selectedIdOverride || settings?.modelId || settings?.customModelId || '';
  if (models.some((m) => m.id === targetId)) {
    modelIdSelect.value = targetId;
  } else if (models.length > 0) {
    modelIdSelect.value = models[0].id;
  }
}

function renderStyleCards(activeId) {
  selectedStyleId = activeId;
  stylePreviewCards.innerHTML = TRANSLATION_STYLES.map(
    (s) => `
    <div class="style-preview-card ${s.id === activeId ? 'is-selected' : ''}" data-style="${s.id}">
      <h4>${s.name}</h4>
      <p>${s.desc}</p>
    </div>
  `
  ).join('');

  stylePreviewCards.querySelectorAll('.style-preview-card').forEach((card) => {
    card.addEventListener('click', () => {
      renderStyleCards(card.dataset.style);
    });
  });
}

async function fillFormFromSettings() {
  const s = await getSettings();
  activeProviderId = s.providerId || 'google';
  cachedProviderConfigs = { ...(s.providerConfigs || {}) };
  const provider = getProviderDefinition(activeProviderId);

  if (providerSelect) {
    providerSelect.value = activeProviderId;
  }
  if (apiProtocolSelect) {
    apiProtocolSelect.value = s.apiProtocol || provider.protocol || 'gemini';
  }
  updateProviderMetaUi(activeProviderId);

  apiKeyInput.value = s.apiKey || '';
  apiBaseUrlInput.value = s.apiBaseUrl || provider.defaultBaseUrl;
  renderModelDropdown(s, s.modelId || provider.defaultModel);
  customModelIdInput.value = s.customModelId || '';
  temperatureInput.value = s.temperature ?? 0.2;
  tempVal.textContent = String(s.temperature ?? 0.2);

  targetLangSelect.value = s.targetLang || 'zh-CN';
  inputTargetLangSelect.value = s.inputTargetLang || 'en';
  renderStyleCards(s.translationStyle || 'clean');

  enableFloatingBallCheck.checked = s.enableFloatingBall !== false;
  enableSelectionTooltipCheck.checked = s.enableSelectionTooltip !== false;
  enableTripleSpaceInputCheck.checked = s.enableTripleSpaceInput !== false;
  enableHoverTranslateCheck.checked = s.enableHoverTranslate !== false;
  if (enableImageTranslateCheck) {
    enableImageTranslateCheck.checked = s.enableImageTranslate !== false;
  }
  if (autoTranslatePageImagesCheck) {
    autoTranslatePageImagesCheck.checked = s.autoTranslatePageImages !== false;
  }

  youtubeAutoEnableCheck.checked = s.youtubeAutoEnable !== false;
  youtubeShowSidebarCheck.checked = Boolean(s.youtubeShowSidebar);
  youtubeSubFontSizeInput.value = s.youtubeSubFontSize || 22;
  youtubeTransColorInput.value = s.youtubeTransColor || '#fde047';

  tonePresetSelect.value = s.tonePreset || 'standard';
  glossaryTextarea.value = s.glossaryText || '';
  customSystemPromptTextarea.value = s.customSystemPrompt || '';

  if (autoTranslateOnlinePdfCheck) {
    autoTranslateOnlinePdfCheck.checked = Boolean(s.autoTranslateOnlinePdf);
  }
  if (enableCacheCheck) {
    enableCacheCheck.checked = s.enableCache !== false;
  }
  alwaysTranslateDomainsTextarea.value = s.alwaysTranslateDomains || '';
  neverTranslateDomainsTextarea.value = s.neverTranslateDomains || '';
  batchMaxItemsInput.value = s.batchMaxItems || 10;
  maxConcurrencyInput.value = s.maxConcurrency || 3;

  // Auto-fetch models if API key is present and we haven't fetched dynamic models yet
  if (s.apiKey && (!s.availableModels || s.availableModels.length === 0)) {
    refreshSupportedModels(false);
  }
}

function collectFormValues() {
  const pId = providerSelect ? providerSelect.value : activeProviderId;
  const provider = getProviderDefinition(pId);
  return {
    providerId: pId,
    apiProtocol: apiProtocolSelect ? apiProtocolSelect.value : provider.protocol,
    apiKey: apiKeyInput.value.trim(),
    modelId: modelIdSelect.value || provider.defaultModel,
    customModelId: customModelIdInput.value.trim(),
    apiBaseUrl: apiBaseUrlInput.value.trim() || provider.defaultBaseUrl,
    temperature: Number(temperatureInput.value) || 0.2,
    targetLang: targetLangSelect.value,
    inputTargetLang: inputTargetLangSelect.value,
    translationStyle: selectedStyleId,
    enableFloatingBall: enableFloatingBallCheck.checked,
    enableSelectionTooltip: enableSelectionTooltipCheck.checked,
    enableTripleSpaceInput: enableTripleSpaceInputCheck.checked,
    enableHoverTranslate: enableHoverTranslateCheck.checked,
    enableImageTranslate: enableImageTranslateCheck ? enableImageTranslateCheck.checked : true,
    autoTranslatePageImages: autoTranslatePageImagesCheck
      ? autoTranslatePageImagesCheck.checked
      : true,
    youtubeAutoEnable: youtubeAutoEnableCheck.checked,
    youtubeShowSidebar: youtubeShowSidebarCheck.checked,
    youtubeSubFontSize: Number(youtubeSubFontSizeInput.value) || 22,
    youtubeTransColor: youtubeTransColorInput.value || '#fde047',
    tonePreset: tonePresetSelect.value,
    glossaryText: glossaryTextarea.value,
    customSystemPrompt: customSystemPromptTextarea.value,
    autoTranslateOnlinePdf: Boolean(autoTranslateOnlinePdfCheck?.checked),
    enableCache: enableCacheCheck ? enableCacheCheck.checked : true,
    alwaysTranslateDomains: alwaysTranslateDomainsTextarea.value,
    neverTranslateDomains: neverTranslateDomainsTextarea.value,
    batchMaxItems: Math.max(1, Math.min(25, Number(batchMaxItemsInput.value) || 10)),
    maxConcurrency: Math.max(1, Math.min(8, Number(maxConcurrencyInput.value) || 3))
  };
}

/**
 * Switch provider: save current provider inputs into cachedProviderConfigs,
 * then pre-fill the newly selected provider's default Base URL, protocol, saved API Key, and model list!
 */
async function handleProviderChange() {
  const newProviderId = providerSelect.value;
  const prevDef = getProviderDefinition(activeProviderId);

  // Snapshot current provider's form fields before switching
  cachedProviderConfigs[activeProviderId] = {
    ...(cachedProviderConfigs[activeProviderId] || {}),
    apiKey: apiKeyInput.value.trim(),
    apiBaseUrl: apiBaseUrlInput.value.trim() || prevDef.defaultBaseUrl,
    apiProtocol: apiProtocolSelect.value || prevDef.protocol,
    modelId: modelIdSelect.value || prevDef.defaultModel,
    customModelId: customModelIdInput.value.trim()
  };

  activeProviderId = newProviderId;
  const nextDef = getProviderDefinition(newProviderId);
  const savedForNext = cachedProviderConfigs[newProviderId] || {};

  updateProviderMetaUi(newProviderId);
  apiProtocolSelect.value = savedForNext.apiProtocol || nextDef.protocol;
  apiBaseUrlInput.value = savedForNext.apiBaseUrl || nextDef.defaultBaseUrl;
  apiKeyInput.value = savedForNext.apiKey || '';
  customModelIdInput.value = savedForNext.customModelId || '';
  apiTestResult.hidden = true;

  const nextAvailableModels = Array.isArray(savedForNext.availableModels)
    ? savedForNext.availableModels
    : [];

  const updated = await saveSettings({
    providerId: newProviderId,
    apiProtocol: apiProtocolSelect.value,
    apiBaseUrl: apiBaseUrlInput.value,
    apiKey: apiKeyInput.value,
    modelId: savedForNext.modelId || nextDef.defaultModel,
    customModelId: customModelIdInput.value,
    availableModels: nextAvailableModels,
    providerConfigs: cachedProviderConfigs
  });

  renderModelDropdown(updated, updated.modelId);
  flashSavedMessage(`✓ 已切换至 ${nextDef.shortName} 并预填 Base URL`);
}

async function refreshSupportedModels(showFeedback = true) {
  const draft = collectFormValues();
  const provider = getProviderDefinition(draft.providerId);
  if (!draft.apiKey) {
    if (showFeedback) {
      apiTestResult.hidden = false;
      apiTestResult.className = 'test-result is-error';
      apiTestResult.textContent = `⚠️ 请先手动填写您的 ${provider.shortName} API Key，再拉取支持的模型列表。`;
    }
    return;
  }

  fetchModelsBtn.disabled = true;
  fetchModelsBtn.textContent = '⏳ 拉取中…';
  try {
    await saveSettings(draft);
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.FETCH_MODELS,
      payload: draft
    });
    if (!res || !res.ok) {
      throw new Error(res?.error || '获取模型列表失败');
    }
    const { models = [], selectedModelId } = res.data || {};
    const updatedSettings = await getSettings();
    cachedProviderConfigs = { ...(updatedSettings.providerConfigs || {}) };
    renderModelDropdown(updatedSettings, selectedModelId);

    if (showFeedback) {
      apiTestResult.hidden = false;
      apiTestResult.className = 'test-result';
      apiTestResult.textContent = `✓ 成功同步 ${provider.shortName} 支持的 ${models.length} 个模型！已更新至下拉菜单（当前选中: ${modelIdSelect.value}）。`;
    }
  } catch (err) {
    if (showFeedback) {
      apiTestResult.hidden = false;
      apiTestResult.className = 'test-result is-error';
      apiTestResult.textContent = `✕ 获取模型列表失败: ${err?.message || err}`;
    }
  } finally {
    fetchModelsBtn.disabled = false;
    fetchModelsBtn.textContent = '🔄 刷新模型列表';
  }
}

async function refreshCacheStats() {
  try {
    const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.GET_CACHE_STATS });
    if (res && res.ok && res.data) {
      const d = res.data;
      cacheStatsTitle.textContent = `本地已缓存 ${d.indexedDbCount || 0} 条译文 · 累计翻译 ${
        d.totalParagraphs || 0
      } 段 · 缓存命中 ${d.cacheHits || 0} 次`;
    }
  } catch {
    // ignore
  }
}

function flashSavedMessage(msg = '✓ 已保存所有配置') {
  saveStatusToast.textContent = msg;
  setTimeout(() => {
    saveStatusToast.textContent = '';
  }, 2800);
}

/**
 * Fix Sidebar Navigation Highlighting (Click + Scroll Spy + Hash Sync)
 */
function setupSidebarNavigationHighlight() {
  const navItems = Array.from(document.querySelectorAll('.nav-list .nav-item'));
  const sections = navItems
    .map((item) => {
      const id = item.dataset.section || (item.getAttribute('href') || '').replace(/^#/, '');
      return document.getElementById(id);
    })
    .filter(Boolean);

  if (navItems.length === 0 || sections.length === 0) return;

  let isClickScrolling = false;
  let clickScrollTimer = null;

  function setActiveSection(sectionId) {
    navItems.forEach((item) => {
      const id = item.dataset.section || (item.getAttribute('href') || '').replace(/^#/, '');
      item.classList.toggle('is-active', id === sectionId);
    });
  }

  navItems.forEach((item) => {
    item.addEventListener('click', (e) => {
      const targetId = item.dataset.section || (item.getAttribute('href') || '').replace(/^#/, '');
      const targetSection = document.getElementById(targetId);
      if (!targetSection) return;
      e.preventDefault();

      isClickScrolling = true;
      if (clickScrollTimer) clearTimeout(clickScrollTimer);
      setActiveSection(targetId);
      history.replaceState(null, '', `#${targetId}`);

      targetSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      clickScrollTimer = setTimeout(() => {
        isClickScrolling = false;
      }, 650);
    });
  });

  function updateActiveOnScroll() {
    if (isClickScrolling) return;
    const viewportTriggerY = 180;
    let activeId = sections[0].id;

    for (const sec of sections) {
      const rect = sec.getBoundingClientRect();
      if (rect.top <= viewportTriggerY) {
        activeId = sec.id;
      }
    }

    // If scrolled all the way to the bottom of the page, highlight the last section
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 40) {
      activeId = sections[sections.length - 1].id;
    }

    setActiveSection(activeId);
  }

  window.addEventListener('scroll', updateActiveOnScroll, { passive: true });
  window.addEventListener('hashchange', () => {
    const hashId = window.location.hash.replace(/^#/, '');
    if (hashId && document.getElementById(hashId)) {
      setActiveSection(hashId);
    }
  });

  if (window.location.hash) {
    const initialId = window.location.hash.replace(/^#/, '');
    if (initialId && document.getElementById(initialId)) {
      setActiveSection(initialId);
    }
  }
}

// Event Listeners
if (providerSelect) {
  providerSelect.addEventListener('change', handleProviderChange);
}

if (apiProtocolSelect) {
  apiProtocolSelect.addEventListener('change', async () => {
    await saveSettings({ apiProtocol: apiProtocolSelect.value });
    flashSavedMessage(
      `✓ 已切换通信协议为 ${apiProtocolSelect.value === 'openai' ? 'OpenAI 兼容协议' : 'Gemini 原生协议'}`
    );
  });
}

if (resetBaseUrlBtn) {
  resetBaseUrlBtn.addEventListener('click', async () => {
    const provider = getProviderDefinition(providerSelect.value);
    apiBaseUrlInput.value = provider.defaultBaseUrl;
    await saveSettings({ apiBaseUrl: provider.defaultBaseUrl });
    flashSavedMessage(`✓ 已恢复 ${provider.shortName} 默认 Base URL`);
  });
}

temperatureInput.addEventListener('input', () => {
  tempVal.textContent = temperatureInput.value;
});

toggleKeyVisBtn.addEventListener('click', () => {
  const isPwd = apiKeyInput.type === 'password';
  apiKeyInput.type = isPwd ? 'text' : 'password';
  toggleKeyVisBtn.textContent = isPwd ? '隐藏' : '显示';
});

fetchModelsBtn.addEventListener('click', () => {
  refreshSupportedModels(true);
});

modelIdSelect.addEventListener('change', async () => {
  // Clear customModelId if user picks from the dropdown so dropdown selection takes effect immediately
  customModelIdInput.value = '';
  await saveSettings({ modelId: modelIdSelect.value, customModelId: '' });
  flashSavedMessage(`✓ 已切换模型为 ${modelIdSelect.value}`);
});

testApiBtn.addEventListener('click', async () => {
  const draft = collectFormValues();
  const provider = getProviderDefinition(draft.providerId);
  await saveSettings(draft);
  apiTestResult.hidden = false;
  apiTestResult.className = 'test-result';
  apiTestResult.textContent = `正在向 ${provider.shortName} (${draft.apiBaseUrl}) 发起连接与延迟测试…`;

  try {
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.TEST_API_KEY,
      payload: draft
    });
    if (!res || !res.ok) {
      throw new Error(res?.error || '连接测试失败');
    }
    const d = res.data;
    const latestSettings = await getSettings();
    cachedProviderConfigs = { ...(latestSettings.providerConfigs || {}) };
    renderModelDropdown(latestSettings, d.modelId);

    const modelCountInfo =
      Array.isArray(d.availableModels) && d.availableModels.length > 0
        ? ` · 已同步 ${d.availableModels.length} 个可用模型`
        : '';
    apiTestResult.className = 'test-result';
    apiTestResult.textContent = `✓ ${provider.shortName} 连接成功！当前生效模型: ${d.modelId}${modelCountInfo} · 响应延迟: ${d.latencyMs}ms · 测试译文: "${d.sampleReply}"`;
  } catch (err) {
    apiTestResult.className = 'test-result is-error';
    apiTestResult.textContent = `✕ 连接失败: ${err?.message || err}`;
  }
});

saveAllBtn.addEventListener('click', async () => {
  const values = collectFormValues();
  const updated = await saveSettings(values);
  cachedProviderConfigs = { ...(updated.providerConfigs || {}) };
  flashSavedMessage('✓ 已保存所有配置并实时同步至所有标签页');
});

clearCacheBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.CLEAR_CACHE });
  await refreshCacheStats();
  flashSavedMessage('✓ 已清空本地翻译缓存');
});

resetDefaultBtn.addEventListener('click', async () => {
  await resetSettings();
  await fillFormFromSettings();
  flashSavedMessage('✓ 已恢复默认配置');
});

openStudioFromOptionsBtn.addEventListener('click', async () => {
  const url = chrome.runtime.getURL('studio/studio.html');
  await chrome.tabs.create({ url });
});

// Initialize
populateStaticOptions();
setupSidebarNavigationHighlight();
fillFormFromSettings();
refreshCacheStats();
