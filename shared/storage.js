/**
 * Persistent storage manager backed by chrome.storage.local.
 * Ensures service workers and UI pages always read/write consistent state.
 */

import { DEFAULT_SETTINGS, GEMINI_MODELS, LLM_PROVIDERS, LANGUAGES, TRANSLATION_STYLES } from './constants.js';
import './protocol.js';

const STORAGE_KEY = 'immersive_gemini_settings_v1';
const STATS_KEY = 'immersive_gemini_stats_v1';

export function getProviderDefinition(providerId) {
  return LLM_PROVIDERS.find((p) => p.id === providerId) || LLM_PROVIDERS[0];
}

export function getActiveProtocol(settings) {
  return globalThis.QingJianSettings.resolveProtocol(settings);
}

export async function getSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY] || {};
  const merged = { ...DEFAULT_SETTINGS, ...stored, apiProtocol: getActiveProtocol(stored) };

  // Ensure providerConfigs has current active provider snapshot for seamless provider switching
  const pId = merged.providerId || 'google';
  const pDef = getProviderDefinition(pId);
  const configs = { ...(merged.providerConfigs || {}) };
  if (!configs[pId]) {
    configs[pId] = {
      apiKey: merged.apiKey || '',
      apiBaseUrl: merged.apiBaseUrl || pDef.defaultBaseUrl,
      apiProtocol: merged.apiProtocol || pDef.protocol,
      modelId: merged.modelId || '',
      customModelId: merged.customModelId || '',
      availableModels: Array.isArray(merged.availableModels) ? merged.availableModels : []
    };
  }
  merged.providerConfigs = configs;
  return merged;
}

// Serialize read/modify/write across options, popup and worker contexts as well.
function withSettingsLock(update) {
  return globalThis.navigator?.locks
    ? navigator.locks.request('qingjian-settings-write', update) : update();
}
let settingsUpdateChain = Promise.resolve();
export function saveSettings(partialSettings, { expected } = {}) {
  const update = () => withSettingsLock(() => writeSettings(partialSettings, expected));
  settingsUpdateChain = settingsUpdateChain.then(update, update);
  return settingsUpdateChain;
}

// Content scripts send only these UI preferences to the extension origin.
// Merging here uses the same lock as popup/options, never a webpage's stale snapshot.
export async function saveContentSettings(patch) {
  const validators = {
    translationStyle: value => TRANSLATION_STYLES.some(style => style.id === value),
    floatingBallPositionY: value => Number.isFinite(value) && value >= 10 && value <= 90,
    alwaysTranslateDomains: value => typeof value === 'string',
    autoTranslateAllPages: value => typeof value === 'boolean',
    autoTranslateOnlinePdf: value => typeof value === 'boolean'
  };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length ||
    Object.entries(patch).some(([key, value]) => !Object.hasOwn(validators, key) || !validators[key](value))) {
    throw new Error('网页设置更新包含不允许的字段或无效值');
  }
  await saveSettings(patch);
  // Do not return the merged settings: they contain credentials.
}

async function writeSettings(partialSettings, expected) {
  const current = await getSettings();
  if (expected && ['providerId', 'apiProtocol', 'apiBaseUrl', 'apiKey', 'modelId', 'customModelId']
    .some(key => current[key] !== expected[key])) return null;
  const updated = { ...current, ...partialSettings };
  // A provider switch without an explicit protocol must not inherit the old provider's protocol.
  updated.apiProtocol = getActiveProtocol(
    partialSettings.providerId && partialSettings.providerId !== current.providerId
      ? partialSettings : updated
  );

  const pId = updated.providerId || 'google';
  const pDef = getProviderDefinition(pId);
  const configs = { ...(updated.providerConfigs || {}) };
  configs[pId] = {
    ...(configs[pId] || {}),
    apiKey: updated.apiKey ?? '',
    apiBaseUrl: updated.apiBaseUrl || pDef.defaultBaseUrl,
    apiProtocol: updated.apiProtocol || pDef.protocol,
    modelId: updated.modelId ?? '',
    customModelId: updated.customModelId ?? '',
    availableModels: Array.isArray(updated.availableModels) ? updated.availableModels : []
  };
  updated.providerConfigs = configs;

  await chrome.storage.local.set({ [STORAGE_KEY]: updated });
  return updated;
}

export function resetSettings() {
  const reset = async () => {
    await chrome.storage.local.set({ [STORAGE_KEY]: { ...DEFAULT_SETTINGS } });
    return { ...DEFAULT_SETTINGS };
  };
  const update = () => withSettingsLock(reset);
  settingsUpdateChain = settingsUpdateChain.then(update, update);
  return settingsUpdateChain;
}

export function onSettingsChanged(callback) {
  const listener = (changes, areaName) => {
    if (areaName === 'local' && changes[STORAGE_KEY]) {
      const raw = changes[STORAGE_KEY].newValue || {};
      const newVal = { ...DEFAULT_SETTINGS, ...raw, apiProtocol: getActiveProtocol(raw) };
      callback(newVal);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

let statsUpdateChain = Promise.resolve();
let pendingStatsUpdates = 0;
const MAX_PENDING_STATS_UPDATES = 32;

export async function getUsageStats() {
  const result = await chrome.storage.local.get(STATS_KEY);
  return result[STATS_KEY] || {
    totalRequests: 0,
    totalParagraphs: 0,
    cacheHits: 0,
    batchRetries: 0,
    estimatedCharsTranslated: 0
  };
}

// Storage APIs cannot be aborted, but their callers must release request slots.
// A late read must never resume an expired update and write stale counters.
function waitForStorage(promise, signal, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    if (timeoutMs) timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
    Promise.resolve(promise).then(value => {
      cleanup();
      if (signal?.aborted) reject(signal.reason);
      else resolve(value);
    }, error => { cleanup(); reject(error); });
    if (signal?.aborted) abort();
  });
}

export function incrementUsageStats({ requests = 0, paragraphs = 0, chars = 0, cacheHits = 0, batchRetries = 0 }, signal) {
  signal?.throwIfAborted();
  // Accounting is best effort when storage is unavailable; never retain an unbounded queue.
  if (pendingStatsUpdates >= MAX_PENDING_STATS_UPDATES) return Promise.resolve(null);
  pendingStatsUpdates++;
  const runUpdate = async () => {
    signal?.throwIfAborted();
    const current = await waitForStorage(getUsageStats(), signal);
    signal?.throwIfAborted();
    const next = {
      batchRetries: (current.batchRetries || 0) + batchRetries,
      totalRequests: (current.totalRequests || 0) + requests,
      totalParagraphs: (current.totalParagraphs || 0) + paragraphs,
      cacheHits: (current.cacheHits || 0) + cacheHits,
      estimatedCharsTranslated: (current.estimatedCharsTranslated || 0) + chars
    };
    // Keep physical writes serialized even when their original caller has stopped waiting.
    await chrome.storage.local.set({ [STATS_KEY]: next });
    return next;
  };
  statsUpdateChain = statsUpdateChain.then(runUpdate, runUpdate)
    .finally(() => { pendingStatsUpdates--; });
  // Slow bookkeeping must not turn successful model output into repeated request timeouts.
  return waitForStorage(statsUpdateChain, signal, 250).catch(() => {
    signal?.throwIfAborted();
    return null; // Failed bookkeeping must not discard a successful translation.
  });
}

export function getActiveModelId(settings) {
  const custom = settings?.customModelId ? settings.customModelId.trim() : '';
  const selected = settings?.modelId ? settings.modelId.trim() : '';
  const firstFetched =
    Array.isArray(settings?.availableModels) && settings.availableModels[0]?.id
      ? String(settings.availableModels[0].id).trim()
      : '';
  const raw = custom || selected || firstFetched || '';
  if (!raw) return '';
  return getActiveProtocol(settings) === 'gemini'
    ? raw.replace(/^models\//i, '')
    : raw;
}

/**
 * Return the user's configured / dynamically fetched models for the active provider.
 * No built-in models are injected; only models fetched via the user's API Key or manually entered are returned.
 */
export function getMergedModelList(settings) {
  const dynamicList = Array.isArray(settings?.availableModels) ? settings.availableModels : [];
  const seen = new Set();
  const result = [];
  for (const m of dynamicList) {
    if (!m || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    result.push(m);
  }
  const manualIds = [settings?.customModelId, settings?.modelId]
    .map((x) => (x ? String(x).trim() : ''))
    .filter(Boolean);
  for (const id of manualIds) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push({ id, name: id });
    }
  }
  return result;
}

export function getLanguageEnglishName(code) {
  const found = LANGUAGES.find((l) => l.code === code);
  return found ? found.englishName : code;
}

export function parseGlossary(glossaryText) {
  if (!glossaryText || !glossaryText.trim()) return [];
  const entries = [];
  const lines = glossaryText.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const sepIdx = line.indexOf('=') !== -1 ? line.indexOf('=') : line.indexOf(':');
    if (sepIdx > 0) {
      const source = line.slice(0, sepIdx).trim();
      const target = line.slice(sepIdx + 1).trim();
      if (source && target) {
        entries.push({ source, target });
      }
    }
  }
  return entries;
}
