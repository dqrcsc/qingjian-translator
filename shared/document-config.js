// Only translation-affecting fields travel with a document. Scheduling and
// accounting always use current global settings; credentials stay in memory.
import { hashString } from './utils.js';
import { getActiveModelId } from './storage.js';

const FIELDS = ['providerId', 'apiProtocol', 'apiBaseUrl', 'apiKey', 'modelId',
  'customModelId', 'targetLang', 'tonePreset', 'glossaryText', 'customSystemPrompt', 'temperature'];

export function snapshotDocumentConfig(settings = {}) {
  const config = Object.fromEntries(FIELDS.map(key => [key, settings[key] ?? (key === 'temperature' ? 0.2 : '')]));
  config.modelId = getActiveModelId(settings);
  config.customModelId = '';
  return config;
}

export function documentConfigSignature(settings) {
  return hashString(JSON.stringify(snapshotDocumentConfig(settings)));
}

export function requestDocumentConfig(message, sender, studioUrl) {
  if (!message?.documentConfig || sender?.url?.split(/[?#]/)[0] !== studioUrl) return undefined;
  const config = snapshotDocumentConfig(message.documentConfig);
  if (FIELDS.some(key => key === 'temperature'
    ? !Number.isFinite(config[key])
    : typeof config[key] !== 'string')) throw new Error('文档翻译配置无效');
  return config;
}
