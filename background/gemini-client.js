/**
 * Google AI (Gemini) API Client for Immersive Gemini Extension.
 * Supports:
 * 0. Dynamic Model Discovery (GET /v1beta/models) for the user's API Key
 * 1. Structured JSON batch paragraph translation (with inline placeholder preservation & glossary)
 * 2. Contextual selection analysis & vocabulary breakdown
 * 3. Instant input-box translation (Triple-Space trigger)
 * 4. YouTube subtitle context-window batch translation
 * 5. Experimental YouTube multimodal audio live transcription & translation
 * 6. Native Multimodal PDF document layout & paragraph bilingual extraction
 */

import { TONE_PRESETS } from '../shared/constants.js';
import {
  getActiveModelId,
  getActiveProtocol,
  getProviderDefinition,
  getLanguageEnglishName,
  parseGlossary,
  incrementUsageStats,
  saveSettings
} from '../shared/storage.js';

function buildSystemInstruction(settings, targetLangCode) {
  const targetLangName = getLanguageEnglishName(targetLangCode || settings.targetLang);
  const preset = TONE_PRESETS[settings.tonePreset] || TONE_PRESETS.standard;
  const glossaryEntries = parseGlossary(settings.glossaryText);

  let instruction = `You are an expert bilingual translator and localization specialist.
Target Language: ${targetLangName}.
Style & Tone Guideline: ${preset.instruction}
Critical Rules:
1. Keep inline placeholders such as {{0}}, {{1}}, <c0>...</c0>, code snippets, URLs, and LaTeX math ($...$) intact.
2. Do NOT add meta-commentary or explanations unless explicitly asked.
3. If an input segment is already entirely in ${targetLangName} or is purely a number/code/symbol, return it unchanged.`;

  if (glossaryEntries.length > 0) {
    const glossaryLines = glossaryEntries
      .map((g) => `- "${g.source}" -> "${g.target}"`)
      .join('\n');
    instruction += `\n\nMandatory Domain Glossary (Always apply these exact translations when encountered):\n${glossaryLines}`;
  }

  if (settings.customSystemPrompt && settings.customSystemPrompt.trim()) {
    instruction += `\n\nAdditional User Instructions:\n${settings.customSystemPrompt.trim()}`;
  }

  return instruction;
}

/**
 * Mask any API keys or Bearer tokens from upstream error messages so keys are never leaked in UI toasts or screenshots.
 */
export function redactSensitiveText(text, apiKey = '') {
  let out = String(text || '');
  const cleanKey = String(apiKey || '').trim();
  if (cleanKey && cleanKey.length >= 6) {
    out = out.split(cleanKey).join('***REDACTED_KEY***');
    out = out.split(encodeURIComponent(cleanKey)).join('***REDACTED_KEY***');
  }
  out = out.replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza***REDACTED***');
  out = out.replace(/sk-[0-9A-Za-z_-]{12,}/g, 'sk-***REDACTED***');
  out = out.replace(/([?&]key=)[^&\s"']+/gi, '$1***REDACTED***');
  return out;
}

function getCleanBaseUrl(settings) {
  const provider = getProviderDefinition(settings?.providerId);
  const fallback = provider?.defaultBaseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  return (settings?.apiBaseUrl || fallback).trim().replace(/\/+$/, '');
}

function getEndpointUrl(settings, overrideModelId = '') {
  const apiKey = (settings.apiKey || '').trim();
  const provider = getProviderDefinition(settings?.providerId);
  if (!apiKey) {
    throw new Error(
      `尚未配置 ${provider.shortName || 'AI'} API Key，请点击插件右上角「设置」填入您的 API Key。`
    );
  }
  const baseUrl = getCleanBaseUrl(settings);
  const rawModel = (overrideModelId || getActiveModelId(settings)).trim();
  if (!rawModel) {
    throw new Error(
      `尚未配置 ${provider.shortName || 'AI'} 模型，请在插件「设置」中点击「从接口拉取模型」或手动填写您拥有的模型 ID。`
    );
  }
  const cleanModel = rawModel.replace(/^models\//i, '');
  return `${baseUrl}/models/${encodeURIComponent(cleanModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

function getOpenAiEndpoints(settings) {
  const baseUrl = getCleanBaseUrl(settings);
  if (/\/chat\/completions$/i.test(baseUrl)) {
    return {
      chatUrl: baseUrl,
      modelsUrl: baseUrl.replace(/\/chat\/completions$/i, '/models')
    };
  }
  if (/\/v\d+[a-z0-9_-]*$/i.test(baseUrl)) {
    return {
      chatUrl: `${baseUrl}/chat/completions`,
      modelsUrl: `${baseUrl}/models`
    };
  }
  return {
    chatUrl: `${baseUrl}/v1/chat/completions`,
    fallbackChatUrl: `${baseUrl}/chat/completions`,
    modelsUrl: `${baseUrl}/v1/models`,
    fallbackModelsUrl: `${baseUrl}/models`
  };
}

/**
 * 0. Dynamically fetch all models supported by the user's configured provider & API Key.
 * Supports both Google Gemini (/models?key=...) and OpenAI-compatible (GET /models with Bearer token).
 */
export async function fetchAvailableModels(settings) {
  const apiKey = (settings.apiKey || '').trim();
  const provider = getProviderDefinition(settings?.providerId);
  if (!apiKey) {
    throw new Error(`请先输入 ${provider.shortName || 'AI'} API Key 后再拉取模型列表。`);
  }

  const protocol = getActiveProtocol(settings);
  if (protocol === 'openai') {
    return fetchOpenAiAvailableModels(settings, provider, apiKey);
  }

  const baseUrl = getCleanBaseUrl(settings);
  const allRawModels = [];
  let pageToken = '';

  for (let page = 0; page < 5; page++) {
    const tokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
    const url = `${baseUrl}/models?pageSize=100${tokenParam}&key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, { method: 'GET' });

    if (!response.ok) {
      let errDetail = `HTTP ${response.status}`;
      try {
        const errJson = await response.json();
        errDetail = errJson?.error?.message || JSON.stringify(errJson);
      } catch {
        // ignore
      }
      throw new Error(
        `获取模型列表失败 (${response.status}): ${redactSensitiveText(errDetail, apiKey)}`
      );
    }

    const data = await response.json();
    if (Array.isArray(data?.models)) {
      allRawModels.push(...data.models);
    }
    if (data?.nextPageToken) {
      pageToken = data.nextPageToken;
    } else {
      break;
    }
  }

  // Filter models that support generateContent (text/multimodal generation)
  const filtered = allRawModels.filter((m) => {
    if (!m || !m.name) return false;
    const methods = m.supportedGenerationMethods;
    if (Array.isArray(methods) && methods.length > 0) {
      return methods.includes('generateContent');
    }
    return /gemini|gemma|learnlm/i.test(m.name);
  });

  const formatted = filtered.map((m) => {
    const id = String(m.name).replace(/^models\//i, '');
    const displayName = m.displayName || id;
    const label =
      displayName.toLowerCase() === id.toLowerCase()
        ? id
        : `${displayName} (${id})`;
    return {
      id,
      name: label,
      displayName,
      description: m.description || '',
      inputTokenLimit: m.inputTokenLimit || 0,
      outputTokenLimit: m.outputTokenLimit || 0
    };
  });

  const scoreModel = (item) => {
    const id = item.id.toLowerCase();
    if (id.startsWith('gemini-') && id.includes('flash') && !id.includes('8b')) return 800;
    if (id.startsWith('gemini-') && id.includes('pro')) return 750;
    if (id.startsWith('gemini-')) return 600;
    return 100;
  };

  formatted.sort((a, b) => {
    const diff = scoreModel(b) - scoreModel(a);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });

  return formatted;
}

async function fetchOpenAiAvailableModels(settings, provider, apiKey) {
  const { modelsUrl, fallbackModelsUrl } = getOpenAiEndpoints(settings);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json'
  };

  let response = await fetch(modelsUrl, { method: 'GET', headers });
  if (!response.ok && fallbackModelsUrl && response.status === 404) {
    response = await fetch(fallbackModelsUrl, { method: 'GET', headers });
  }

  if (!response.ok) {
    let errDetail = `HTTP ${response.status}`;
    try {
      const errJson = await response.json();
      errDetail = errJson?.error?.message || errJson?.message || JSON.stringify(errJson);
    } catch {
      // ignore
    }
    throw new Error(
      `从 ${provider.shortName} 获取模型列表失败 (${response.status}): ${redactSensitiveText(errDetail, apiKey)}`
    );
  }

  const data = await response.json();
  const rawList = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.models)
      ? data.models
      : Array.isArray(data)
        ? data
        : [];

  const nonChatPattern =
    /embedding|rerank|whisper|tts|speech|moderation|dall-e|babbage|davinci|canary|flux|stable-diffusion/i;

  const presetMap = new Map((provider.models || []).map((m) => [m.id, m]));
  const seen = new Set();
  const formatted = [];

  for (const item of rawList) {
    const rawId = typeof item === 'string' ? item : item?.id || item?.name;
    if (!rawId) continue;
    const id = String(rawId).trim();
    if (!id || seen.has(id) || nonChatPattern.test(id)) continue;
    seen.add(id);

    const preset = presetMap.get(id);
    const displayName = item?.name || item?.display_name || preset?.name || id;
    formatted.push({
      id,
      name: preset?.name || (displayName !== id ? `${displayName} (${id})` : id),
      displayName,
      description: item?.description || preset?.desc || `${provider.shortName} 支持模型`
    });
  }

  if (formatted.length === 0 && Array.isArray(provider.models) && provider.models.length > 0) {
    return [...provider.models];
  }

  // Prioritize the provider's default/preset models at the top of the dropdown
  formatted.sort((a, b) => {
    const aPreset = presetMap.has(a.id) ? 1 : 0;
    const bPreset = presetMap.has(b.id) ? 1 : 0;
    if (aPreset !== bPreset) return bPreset - aPreset;
    return a.id.localeCompare(b.id);
  });

  return formatted;
}

const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);
const KNOWN_TEXT_ONLY_MODEL_RE =
  /(^|\/)(deepseek-(chat|reasoner)|qwen-(plus|turbo|max)|glm-4-(air|flash))$/i;

export async function fetchWithTimeoutAndRetry(
  url,
  init,
  { timeoutMs = 45000, maxRetries = 2, baseDelayMs = 600 } = {}
) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('API 请求超时 (45s)')), timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal
      });
      clearTimeout(timer);
      if (RETRYABLE_HTTP_STATUS.has(response.status) && attempt < maxRetries) {
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      return response;
    } catch (err) {
      clearTimeout(timer);
      lastError =
        err?.name === 'AbortError'
          ? new Error('API 请求超时，请检查网络连接或稍后重试')
          : err;
      if (attempt < maxRetries) {
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
    }
  }
  throw lastError || new Error('网络请求失败');
}

async function callOpenAiCompatibleApi(settings, payload, overrideModelId = '') {
  const apiKey = (settings.apiKey || '').trim();
  const provider = getProviderDefinition(settings?.providerId);
  if (!apiKey) {
    throw new Error(
      `尚未配置 ${provider.shortName || 'AI'} API Key，请点击插件右上角「设置」填入您的 API Key。`
    );
  }

  const activeModel = (overrideModelId || getActiveModelId(settings)).trim();
  if (!activeModel) {
    throw new Error(
      `尚未配置 ${provider.shortName || 'AI'} 模型，请在插件「设置」中点击「从接口拉取模型」或手动填写您拥有的模型 ID。`
    );
  }
  const { chatUrl, fallbackChatUrl } = getOpenAiEndpoints(settings);

  let systemText =
    payload?.systemInstruction?.parts
      ?.map((p) => p?.text)
      .filter(Boolean)
      .join('\n') || '';

  const userParts = payload?.contents?.[0]?.parts || [];
  const nonImageBinary = userParts.some(
    (p) => p?.inlineData && !String(p.inlineData.mimeType || '').startsWith('image/')
  );
  if (nonImageBinary) {
    throw new Error(
      `当前所选服务商 (${provider.shortName}) 使用 OpenAI 协议，不支持 PDF/音频原生二进制流直传，已自动切换为文本流解析翻译。`
    );
  }

  const userText = userParts
    .map((p) => p?.text)
    .filter(Boolean)
    .join('\n');

  const imageInlineParts = userParts.filter(
    (p) => p?.inlineData && String(p.inlineData.mimeType || '').startsWith('image/')
  );

  if (imageInlineParts.length > 0 && KNOWN_TEXT_ONLY_MODEL_RE.test(activeModel)) {
    throw new Error(
      `当前所选模型 (${activeModel}) 为纯文本模型，不支持图片视觉识别。请切换至支持多模态视觉的模型（如 Gemini、GPT-4o、Claude 或 Qwen-VL）。`
    );
  }

  const wantsJson = payload?.generationConfig?.responseMimeType === 'application/json';
  if (wantsJson) {
    systemText = `${systemText}\n\nIMPORTANT OUTPUT FORMAT RULE: Respond ONLY with valid raw JSON matching the requested structure. Do NOT wrap the output in markdown code fences (\`\`\`json) or add any conversational text.`.trim();
  }

  const messages = [];
  if (systemText) {
    messages.push({ role: 'system', content: systemText });
  }
  if (imageInlineParts.length > 0) {
    const contentArr = [{ type: 'text', text: userText }];
    for (const imgPart of imageInlineParts) {
      contentArr.push({
        type: 'image_url',
        image_url: {
          url: `data:${imgPart.inlineData.mimeType};base64,${imgPart.inlineData.data}`
        }
      });
    }
    messages.push({ role: 'user', content: contentArr });
  } else {
    messages.push({ role: 'user', content: userText });
  }

  const openAiBody = {
    model: activeModel,
    messages,
    temperature: Number(payload?.generationConfig?.temperature ?? settings.temperature ?? 0.2),
    stream: false
  };

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };

  let response = await fetchWithTimeoutAndRetry(chatUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(openAiBody)
  });

  if (!response.ok && fallbackChatUrl && response.status === 404) {
    response = await fetchWithTimeoutAndRetry(fallbackChatUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(openAiBody)
    });
  }

  if (!response.ok) {
    let errDetail = `HTTP ${response.status}`;
    try {
      const errJson = await response.json();
      errDetail = errJson?.error?.message || errJson?.message || JSON.stringify(errJson);
    } catch {
      const text = await response.text();
      if (text) errDetail = text.slice(0, 240);
    }
    if (
      imageInlineParts.length > 0 &&
      (response.status === 400 || response.status === 422) &&
      /image_url|vision|multimodal|content.*string/i.test(errDetail)
    ) {
      throw new Error(
        `当前模型 (${activeModel}) 不支持视觉识图，请切换至支持多模态视觉的模型 (${redactSensitiveText(errDetail, apiKey)})`
      );
    }
    throw new Error(
      `${provider.shortName} API 请求失败 (${response.status}): ${redactSensitiveText(errDetail, apiKey)}`
    );
  }

  const data = await response.json();
  const choice = data?.choices?.[0];
  let rawContent = choice?.message?.content;
  if (Array.isArray(rawContent)) {
    rawContent = rawContent
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('');
  }
  const cleanText = String(rawContent || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();

  if (!cleanText) {
    throw new Error(`${provider.shortName} API 未返回有效文本内容。`);
  }
  return cleanText;
}

async function callGeminiApi(settings, payload, overrideModelId = '', isRetry = false) {
  if (getActiveProtocol(settings) === 'openai') {
    return callOpenAiCompatibleApi(settings, payload, overrideModelId);
  }

  const activeModel = (overrideModelId || getActiveModelId(settings)).replace(/^models\//i, '');
  const url = getEndpointUrl(settings, activeModel);
  const response = await fetchWithTimeoutAndRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    let errDetail = `HTTP ${response.status}`;
    try {
      const errJson = await response.json();
      errDetail = errJson?.error?.message || JSON.stringify(errJson);
    } catch {
      const text = await response.text();
      if (text) errDetail = text.slice(0, 240);
    }

    // Auto-heal if the selected model is deprecated/404 and the API suggests a replacement or user has fetched models
    if (response.status === 404 && !isRetry) {
      const suggestedMatch = errDetail.match(/models\/([a-zA-Z0-9._-]+)/);
      const firstAvailable =
        Array.isArray(settings?.availableModels) && settings.availableModels[0]?.id
          ? settings.availableModels[0].id
          : '';
      const fallbackModel = suggestedMatch ? suggestedMatch[1] : firstAvailable;
      if (fallbackModel && fallbackModel !== activeModel) {
        console.info(`[QingJian] Auto-switching deprecated model ${activeModel} -> ${fallbackModel}`);
        await saveSettings({ modelId: fallbackModel, customModelId: '' });
        return callGeminiApi(
          { ...settings, modelId: fallbackModel, customModelId: '' },
          payload,
          fallbackModel,
          true
        );
      }
    }

    throw new Error(
      `Gemini API 请求失败 (${response.status}): ${redactSensitiveText(errDetail, settings.apiKey)}`
    );
  }

  const data = await response.json();
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];

  // Join all non-thought text parts (thinking models may emit thought parts before the actual text part)
  const nonThoughtParts = parts.filter((p) => typeof p.text === 'string' && !p.thought);
  const rawText =
    nonThoughtParts.length > 0
      ? nonThoughtParts.map((p) => p.text).join('')
      : parts
          .filter((p) => typeof p.text === 'string')
          .map((p) => p.text)
          .join('');

  if (!rawText) {
    const finishReason =
      candidate?.finishReason || data?.promptFeedback?.blockReason || 'EMPTY_PARTS';
    throw new Error(
      `Gemini API 未返回有效文本 (finishReason: ${finishReason})。`
    );
  }
  return rawText;
}

function safeParseJson(rawText) {
  const trimmed = rawText.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Strip markdown code fences if present
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
      return JSON.parse(fenceMatch[1].trim());
    }
    const bracketStart = trimmed.indexOf('[');
    const bracketEnd = trimmed.lastIndexOf(']');
    if (bracketStart !== -1 && bracketEnd > bracketStart) {
      return JSON.parse(trimmed.slice(bracketStart, bracketEnd + 1));
    }
    const braceStart = trimmed.indexOf('{');
    const braceEnd = trimmed.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
      return JSON.parse(trimmed.slice(braceStart, braceEnd + 1));
    }
    throw new Error('无法解析模型返回的 JSON 结构');
  }
}

/**
 * Build generationConfig that disables unnecessary thinking latency on Flash models
 * (e.g. gemini-2.5-flash, gemini-3-flash) for real-time translation.
 */
function buildFastGenerationConfig(settings, responseSchema = null, includeThinkingZero = true) {
  const activeModel = getActiveModelId(settings).toLowerCase();
  const isFlash = activeModel.includes('flash');

  const config = {
    temperature: Number(settings.temperature ?? 0.2),
    responseMimeType: 'application/json'
  };
  if (responseSchema) {
    config.responseSchema = responseSchema;
  }
  if (includeThinkingZero && isFlash) {
    config.thinkingConfig = { thinkingBudget: 0 };
  }
  return config;
}

/**
 * 1. Batch translate webpage or document paragraphs with strict ID alignment.
 */
export async function translateBatchWithGemini(items, settings, options = {}) {
  if (!items || items.length === 0) return [];

  const targetLang = options.targetLang || settings.targetLang;
  const targetLangName = getLanguageEnglishName(targetLang);
  const sysInstruction = buildSystemInstruction(settings, targetLang);
  const pageContext = options.pageTitle ? `Page/Document Context: "${options.pageTitle}"\n` : '';

  const inputPayload = items.map((item, idx) => ({
    id: item.id ?? idx,
    text: item.text
  }));

  const userPrompt = `${pageContext}Translate each item in the following JSON array into ${targetLangName}.
Return a JSON array where each element has the exact same "id" (integer) and its "translation" (string).
Maintain exact 1-to-1 correspondence (${inputPayload.length} items in, ${inputPayload.length} items out).

Input JSON:
${JSON.stringify(inputPayload)}`;

  const schema = {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        id: { type: 'INTEGER' },
        translation: { type: 'STRING' }
      },
      required: ['id', 'translation']
    }
  };

  const payloadWithSchema = {
    systemInstruction: {
      parts: [{ text: sysInstruction }]
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: userPrompt }]
      }
    ],
    generationConfig: buildFastGenerationConfig(settings, schema, true)
  };

  let rawOutput;
  try {
    rawOutput = await callGeminiApi(settings, payloadWithSchema);
  } catch (err) {
    if (
      String(err.message).includes('responseSchema') ||
      String(err.message).includes('thinking') ||
      String(err.message).includes('400')
    ) {
      const fallbackPayload = {
        systemInstruction: { parts: [{ text: sysInstruction }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: buildFastGenerationConfig(settings, schema, false)
      };
      rawOutput = await callGeminiApi(settings, fallbackPayload);
    } else {
      throw err;
    }
  }

  const parsed = safeParseJson(rawOutput);
  const parsedList = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? Array.isArray(parsed.translations)
        ? parsed.translations
        : Array.isArray(parsed.items)
          ? parsed.items
          : Array.isArray(parsed.results)
            ? parsed.results
            : Array.isArray(parsed.data)
              ? parsed.data
              : typeof parsed.translation === 'string'
                ? [parsed]
                : []
      : [];

  const byId = new Map();
  if (Array.isArray(parsedList)) {
    parsedList.forEach((entry, idx) => {
      if (entry && typeof entry.translation === 'string') {
        const key = entry.id !== undefined ? Number(entry.id) : inputPayload[idx]?.id;
        byId.set(key, entry.translation.trim());
      }
    });
  }

  // For OpenAI-compatible text providers (e.g. DeepSeek), if a multi-item batch omitted some IDs, retry the missing subset once
  if (
    getActiveProtocol(settings) === 'openai' &&
    !options._isMissingSubsetRetry &&
    inputPayload.length > 1
  ) {
    const missingItems = inputPayload.filter((item, idx) => {
      const matched =
        byId.get(Number(item.id)) ||
        (typeof parsedList[idx]?.translation === 'string'
          ? parsedList[idx].translation.trim()
          : '');
      return !matched;
    });
    if (missingItems.length > 0 && missingItems.length < inputPayload.length) {
      try {
        const retryTranslated = await translateBatchWithGemini(missingItems, settings, {
          ...options,
          _isMissingSubsetRetry: true
        });
        for (const rt of retryTranslated) {
          if (rt && rt.translation) {
            byId.set(Number(rt.id), rt.translation);
          }
        }
      } catch {
        // Keep partial translations if retry fails
      }
    }
  }

  const totalChars = items.reduce((acc, it) => acc + (it.text?.length || 0), 0);
  await incrementUsageStats({
    requests: 1,
    paragraphs: items.length,
    chars: totalChars
  });

  return inputPayload.map((item, idx) => {
    const matched =
      byId.get(Number(item.id)) ||
      (Array.isArray(parsedList) && typeof parsedList[idx]?.translation === 'string'
        ? parsedList[idx].translation.trim()
        : '');
    return {
      id: item.id,
      translation: matched || item.text
    };
  });
}

/**
 * 2. Contextual AI Selection Deep Explanation & Vocabulary Breakdown.
 */
export async function explainSelectionWithGemini({ text, contextParagraph, targetLang, pageTitle }, settings) {
  const langCode = targetLang || settings.targetLang;
  const targetLangName = getLanguageEnglishName(langCode);
  const sysInstruction = buildSystemInstruction(settings, langCode);

  const prompt = `Analyze and translate the selected text in the context of its surrounding paragraph.
Target Explanation Language: ${targetLangName}
Page Title: ${pageTitle || 'Webpage'}
Surrounding Context Paragraph: """${contextParagraph || text}"""
Selected Text: """${text}"""

Return a JSON object with:
- "translation": Direct, natural translation of the Selected Text fitting the context.
- "phonetic": IPA phonetic transcription or core lemma if it is a word/short phrase, otherwise a 2-4 word summary tag.
- "contextualMeaning": 1-2 sentences explaining the exact nuance or meaning in this specific context (in ${targetLangName}).
- "breakdown": Up to 4 key vocabulary terms, idioms, or grammar structures from the selection, each with {"term", "meaning", "role"}.
- "example": A natural bilingual example sentence showing how the key expression is used.`;

  const payload = {
    systemInstruction: { parts: [{ text: sysInstruction }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.25,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          translation: { type: 'STRING' },
          phonetic: { type: 'STRING' },
          contextualMeaning: { type: 'STRING' },
          breakdown: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                term: { type: 'STRING' },
                meaning: { type: 'STRING' },
                role: { type: 'STRING' }
              },
              required: ['term', 'meaning']
            }
          },
          example: { type: 'STRING' }
        },
        required: ['translation', 'contextualMeaning', 'breakdown']
      }
    }
  };

  const raw = await callGeminiApi(settings, payload);
  await incrementUsageStats({ requests: 1, paragraphs: 1, chars: text.length });
  return safeParseJson(raw);
}

/**
 * 3. Instant Input Box Translation (Triple-Space shortcut).
 */
export async function translateInputTextWithGemini({ text, targetLang }, settings) {
  const outLangCode = targetLang || settings.inputTargetLang || 'en';
  const outLangName = getLanguageEnglishName(outLangCode);

  const payload = {
    systemInstruction: {
      parts: [
        {
          text: `You are a real-time input box translator. Translate the user's input text naturally and idiomatic into ${outLangName}. If the user's input is already in ${outLangName}, polish it or translate it to ${getLanguageEnglishName(settings.targetLang)} instead. Return ONLY the translated text itself without quotes or explanations.`
        }
      ]
    },
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      temperature: 0.2
    }
  };

  const raw = await callGeminiApi(settings, payload);
  await incrementUsageStats({ requests: 1, paragraphs: 1, chars: text.length });
  return raw.trim().replace(/^["']|["']$/g, '');
}

/**
 * 4. YouTube Subtitle Context-Window Batch Translation.
 */
export async function translateYoutubeCuesWithGemini({ cues, contextBefore = '', contextAfter = '', videoTitle = '' }, settings) {
  if (!cues || cues.length === 0) return [];
  const targetLangName = getLanguageEnglishName(settings.targetLang);
  const sysInstruction = buildSystemInstruction(settings, settings.targetLang);

  const userPrompt = `You are translating timed video subtitles for a YouTube video titled "${videoTitle || 'YouTube Video'}".
Notice that spoken sentences in subtitles are often split across consecutive cue IDs.
Read the surrounding context so split clauses flow naturally in ${targetLangName}, while keeping each cue's translation aligned to its exact "id" so subtitle timing stays synchronized.
Keep each subtitle line concise and easy to read on screen.

Previous Context: "${contextBefore}"
Following Context: "${contextAfter}"

Subtitle Cues to Translate (JSON):
${JSON.stringify(cues.map((c) => ({ id: c.id, text: c.text })))}`;

  const schema = {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        id: { type: 'INTEGER' },
        translation: { type: 'STRING' }
      },
      required: ['id', 'translation']
    }
  };

  const payload = {
    systemInstruction: { parts: [{ text: sysInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: buildFastGenerationConfig(settings, schema, true)
  };

  let raw;
  try {
    raw = await callGeminiApi(settings, payload);
  } catch (err) {
    if (
      String(err.message).includes('thinking') ||
      String(err.message).includes('400')
    ) {
      raw = await callGeminiApi(settings, {
        ...payload,
        generationConfig: buildFastGenerationConfig(settings, schema, false)
      });
    } else {
      throw err;
    }
  }
  const parsed = safeParseJson(raw);
  const mapById = new Map();
  if (Array.isArray(parsed)) {
    parsed.forEach((item, idx) => {
      const id = item.id !== undefined ? Number(item.id) : cues[idx]?.id;
      if (typeof item.translation === 'string') {
        mapById.set(id, item.translation.trim());
      }
    });
  }

  await incrementUsageStats({
    requests: 1,
    paragraphs: cues.length,
    chars: cues.reduce((s, c) => s + (c.text?.length || 0), 0)
  });

  return cues.map((c, idx) => ({
    id: c.id,
    translation: mapById.get(Number(c.id)) || parsed?.[idx]?.translation || c.text
  }));
}

/**
 * 5. Experimental Gemini Multimodal Audio Live Listen-and-Translate for YouTube videos without captions.
 */
export async function translateYoutubeAudioWithGemini({ audioBase64, mimeType = 'audio/webm', previousContext = '', videoTitle = '' }, settings) {
  const targetLangName = getLanguageEnglishName(settings.targetLang);

  const prompt = `Listen to this audio clip from the video "${videoTitle || 'Video'}".
Previous spoken context: "${previousContext}"
1. Transcribe the exact spoken speech in its original language ("original"). If there is no intelligible speech (only music/silence), return empty strings.
2. Translate the spoken speech naturally into ${targetLangName} ("translation").`;

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType,
              data: audioBase64
            }
          },
          { text: prompt }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.15,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          original: { type: 'STRING' },
          translation: { type: 'STRING' }
        },
        required: ['original', 'translation']
      }
    }
  };

  const raw = await callGeminiApi(settings, payload);
  await incrementUsageStats({ requests: 1, paragraphs: 1, chars: 120 });
  return safeParseJson(raw);
}

/**
 * 6. Native Multimodal PDF Analysis & Layout + Figure OCR Extraction for Document Studio.
 * Supports single-page high-DPI image snapshots (`pageImageBase64`, saving ~95% tokens and enabling exact
 * original figure cropping via `figureBox2d`) as well as raw PDF binary (`pdfBase64`).
 */
export async function analyzePdfWithGemini(
  {
    pageImageBase64 = '',
    mimeType = '',
    pageMimeType = '',
    pageNumber = 1,
    pdfBase64 = '',
    pageHint = 'Page 1',
    targetLang
  },
  settings
) {
  const resolvedMimeType = mimeType || pageMimeType || 'image/jpeg';
  const langCode = targetLang || settings.targetLang;
  const targetLangName = getLanguageEnglishName(langCode);
  const sysInstruction = buildSystemInstruction(settings, langCode);

  const isSinglePageImage = Boolean(pageImageBase64);
  const targetDesc = isSinglePageImage ? `Page ${pageNumber}` : pageHint;

  const prompt = `Carefully read the attached academic page (${targetDesc}) and extract ALL content in logical reading order so we can reconstruct a layout-preserving translated page:
1. Whenever the page contains a visual Figure, Chart, Plot, or Architecture Diagram:
   - Emit a block with "page": ${Number(pageNumber) || 1}, "type": "figure", "original": brief title of the figure, "translation": translated title in ${targetLangName}.
   - Provide "figureBox2d": [ymin, xmin, ymax, xmax] normalized 0-1000 on the page bounding ONLY the visual graphic/chart/diagram area (do NOT include the text paragraph caption below the figure inside figureBox2d).
   - Provide "figureLabels": an array of ONLY the key English text phrases/titles/axis names/node labels inside the figure (at most 10 key text labels; NEVER include numbers, percentages like "85.2" or "100%", axis tick numbers, or single symbols). Each label has:
     * "box_2d": [ymin, xmin, ymax, xmax] normalized 0-1000 on the page
     * "original": original English text phrase
     * "translation": concise ${targetLangName} translation
2. Emit the figure's text caption ("Figure N: ...") as a separate block right after the figure with "type": "caption".
3. For the paper title on Page 1, use "type": "heading". For the author names, institutional affiliations, and corresponding author emails on Page 1, use "type": "author" and separate the author list, affiliations, and corresponding author line with "\\n".
4. For section titles (e.g. "Abstract", "1 Introduction", "2 Related Work"), use "type": "heading".
5. For body paragraphs, merge broken lines within the same paragraph and set "column": "left" or "right" if the page uses a 2-column layout, or "full" if single-column.
6. For standalone mathematical equations, emit a block with "type": "equation" and LaTeX $$...$$ notation; for inline mathematical expressions or variables inside paragraphs, use LaTeX $...$ notation.`;

  const schema = {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        page: { type: 'INTEGER' },
        type: { type: 'STRING' },
        column: { type: 'STRING' },
        original: { type: 'STRING' },
        translation: { type: 'STRING' },
        figureBox2d: {
          type: 'ARRAY',
          items: { type: 'INTEGER' }
        },
        figureLabels: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              box_2d: {
                type: 'ARRAY',
                items: { type: 'INTEGER' }
              },
              original: { type: 'STRING' },
              translation: { type: 'STRING' }
            },
            required: ['box_2d', 'original', 'translation']
          }
        }
      },
      required: ['page', 'type', 'original', 'translation']
    }
  };

  const inlineMediaPart = isSinglePageImage
    ? {
        inlineData: {
          mimeType: resolvedMimeType,
          data: pageImageBase64
        }
      }
    : {
        inlineData: {
          mimeType: 'application/pdf',
          data: pdfBase64
        }
      };

  const payloadWithFastConfig = {
    systemInstruction: { parts: [{ text: sysInstruction }] },
    contents: [
      {
        role: 'user',
        parts: [inlineMediaPart, { text: prompt }]
      }
    ],
    generationConfig: buildFastGenerationConfig(settings, schema, true)
  };

  let raw;
  try {
    raw = await callGeminiApi(settings, payloadWithFastConfig);
  } catch {
    const fallbackPayload = {
      ...payloadWithFastConfig,
      generationConfig: buildFastGenerationConfig(settings, schema, false)
    };
    raw = await callGeminiApi(settings, fallbackPayload);
  }

  const blocks = safeParseJson(raw);
  await incrementUsageStats({
    requests: 1,
    paragraphs: Array.isArray(blocks) ? blocks.length : 1,
    chars: Array.isArray(blocks) ? blocks.reduce((s, b) => s + (b.original?.length || 0), 0) : 500
  });
  return Array.isArray(blocks) ? blocks : [];
}

function arrayBufferToBase64InWorker(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 6b. Webpage & Document Image OCR + Language Detection + In-Place Bounding-Box Translation.
 * Supports X.com tweet images (pbs.twimg.com), article figures, infographics, screenshots, and pasted images.
 */
export async function translateImageWithGemini(
  { imageBase64, mimeType = 'image/jpeg', imageUrl = '', targetLang, pageTitle = '' },
  settings
) {
  let finalBase64 = imageBase64 || '';
  let finalMime = mimeType || 'image/jpeg';

  if (!finalBase64 && imageUrl) {
    if (imageUrl.startsWith('data:')) {
      const m = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (m) {
        finalMime = m[1];
        finalBase64 = m[2];
      }
    } else {
      const resp = await fetch(imageUrl, { credentials: 'omit' });
      if (!resp.ok) {
        throw new Error(`无法拉取图片数据 (HTTP ${resp.status})`);
      }
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.startsWith('image/')) {
        finalMime = contentType.split(';')[0].trim();
      } else if (/\.png(\?|$)/i.test(imageUrl)) {
        finalMime = 'image/png';
      } else if (/\.webp(\?|$)/i.test(imageUrl)) {
        finalMime = 'image/webp';
      }
      const ab = await resp.arrayBuffer();
      finalBase64 = arrayBufferToBase64InWorker(ab);
    }
  }

  if (!finalBase64) {
    throw new Error('未获取到有效的图片数据进行识别');
  }

  const langCode = targetLang || settings.targetLang;
  const targetLangName = getLanguageEnglishName(langCode);
  const sysInstruction = buildSystemInstruction(settings, langCode);

  const prompt = `Detect all visible text blocks inside this image (from page "${pageTitle || 'Webpage'}") and translate them into ${targetLangName}.
Rules:
1. If there is no readable text in the image, or if all text is already in ${targetLangName}, return {"hasText": false, "sourceLang": "", "summaryTranslation": "", "regions": []}.
2. Group adjacent words belonging to the same label, sentence, paragraph, or UI element into a single logical region so the in-place overlay looks clean and structured.
3. For each text region, provide:
   - "box_2d": [ymin, xmin, ymax, xmax] normalized to 0..1000 (where 0,0 is top-left and 1000,1000 is bottom-right of the image)
   - "original": The recognized original text
   - "translation": Concise, natural translation in ${targetLangName} suitable for in-place visual replacement
4. Also provide "summaryTranslation": a full combined translation of all text in the image in reading order.`;

  const schema = {
    type: 'OBJECT',
    properties: {
      hasText: { type: 'BOOLEAN' },
      sourceLang: { type: 'STRING' },
      summaryTranslation: { type: 'STRING' },
      regions: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            box_2d: {
              type: 'ARRAY',
              items: { type: 'INTEGER' }
            },
            original: { type: 'STRING' },
            translation: { type: 'STRING' }
          },
          required: ['box_2d', 'original', 'translation']
        }
      }
    },
    required: ['hasText', 'regions']
  };

  const payload = {
    systemInstruction: { parts: [{ text: sysInstruction }] },
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: finalMime,
              data: finalBase64
            }
          },
          { text: prompt }
        ]
      }
    ],
    generationConfig: buildFastGenerationConfig(settings, schema, true)
  };

  let raw;
  try {
    raw = await callGeminiApi(settings, payload);
  } catch {
    raw = await callGeminiApi(settings, {
      ...payload,
      generationConfig: buildFastGenerationConfig(settings, schema, false)
    });
  }

  const parsed = safeParseJson(raw);
  const regions = Array.isArray(parsed?.regions) ? parsed.regions : [];
  await incrementUsageStats({
    requests: 1,
    paragraphs: Math.max(1, regions.length),
    chars: regions.reduce((s, r) => s + (r.original?.length || 0), 0)
  });

  return {
    hasText: Boolean(parsed?.hasText && regions.length > 0),
    sourceLang: parsed?.sourceLang || '',
    summaryTranslation: parsed?.summaryTranslation || regions.map((r) => r.translation).join('\n'),
    regions,
    imageDataUrl: `data:${finalMime};base64,${finalBase64}`
  };
}

/**
 * 7. Verify API Key connectivity, fetch supported models, and test latency.
 */
export async function testGeminiConnection(overrideSettings) {
  let availableModels = [];
  try {
    availableModels = await fetchAvailableModels(overrideSettings);
  } catch {
    // ignore model list endpoint error if provider does not expose /models
  }

  let targetModelId = getActiveModelId(overrideSettings);

  // If we fetched the key's supported models and the currently selected model isn't set or isn't in that list,
  // automatically pick the top model supported by the user's API Key
  if (
    availableModels.length > 0 &&
    !overrideSettings.customModelId &&
    (!targetModelId || !availableModels.some((m) => m.id === targetModelId))
  ) {
    targetModelId = availableModels[0].id;
  }

  if (!targetModelId) {
    throw new Error(
      '尚未选择或输入模型 ID：请先点击「🔄 从接口拉取模型」，或在「手动指定模型 ID」框中直接输入您拥有的模型名称。'
    );
  }

  const start = Date.now();
  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: 'Translate "Hello, Immersive World!" into Simplified Chinese. Reply with only the translation.'
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1
    }
  };

  const reply = await callGeminiApi(
    { ...overrideSettings, modelId: targetModelId },
    payload,
    targetModelId
  );
  const latencyMs = Date.now() - start;

  if (availableModels.length > 0) {
    await saveSettings({ availableModels, modelId: targetModelId });
  }

  return {
    ok: true,
    modelId: targetModelId,
    latencyMs,
    sampleReply: reply.trim(),
    availableModels
  };
}
