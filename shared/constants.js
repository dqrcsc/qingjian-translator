/**
 * Shared constants, styles, provider endpoint templates, and default settings for 青简 · 译读 (QingJian).
 * Note: QingJian is a pure BYOK (Bring Your Own Key & Model) extension and does NOT ship with
 * hardcoded built-in models. Users configure their own API Key and either pull available models
 * from their provider endpoint or enter their model ID directly.
 */

export const GEMINI_MODELS = [];

export const TRANSLATION_STYLES = [
  {
    id: 'clean',
    name: '清爽对照',
    desc: '柔和次要文字色彩，自然融入原网页排版'
  },
  {
    id: 'blockquote',
    name: '引用竖线',
    desc: '左侧 Indigo 渐变竖线 + 轻量底色卡片'
  },
  {
    id: 'underline',
    name: '精致虚线',
    desc: '译文底部配以柔和虚线下划线，层次分明'
  },
  {
    id: 'mask',
    name: '学习模糊 (悬停显现)',
    desc: '默认高斯模糊遮罩，鼠标移入时清晰显示，适合外语精读训练'
  },
  {
    id: 'marker',
    name: '荧光马克笔',
    desc: '温暖浅黄荧光衬底，重点内容一目了然'
  },
  {
    id: 'translation-only',
    name: '仅显示译文',
    desc: '隐藏原文段落，享受母语级沉浸式排版阅读'
  }
];

export const LANGUAGES = [
  { code: 'zh-CN', name: '简体中文 (Simplified Chinese)', englishName: 'Simplified Chinese (zh-CN)' },
  { code: 'zh-TW', name: '繁體中文 (Traditional Chinese)', englishName: 'Traditional Chinese (zh-TW)' },
  { code: 'en', name: 'English (英语)', englishName: 'English' },
  { code: 'ja', name: '日本語 (日语)', englishName: 'Japanese' },
  { code: 'ko', name: '한국어 (韩语)', englishName: 'Korean' },
  { code: 'fr', name: 'Français (法语)', englishName: 'French' },
  { code: 'de', name: 'Deutsch (德语)', englishName: 'German' },
  { code: 'es', name: 'Español (西班牙语)', englishName: 'Spanish' },
  { code: 'ru', name: 'Русский (俄语)', englishName: 'Russian' }
];

export const TONE_PRESETS = {
  standard: {
    name: '标准信达雅 (默认)',
    instruction: 'Translate accurately, naturally, and fluently while preserving the original tone, inline formatting, and technical precision.'
  },
  academic: {
    name: '学术论文严谨风',
    instruction: 'Use rigorous, formal academic terminology suitable for peer-reviewed papers and research reports. Preserve all mathematical notations, citations, and domain terms.'
  },
  tech: {
    name: '科技与开发者极客风',
    instruction: 'Use idiomatic software engineering, AI, and developer terminology. Keep code identifiers, API names, CLI flags, and standard acronyms (e.g., DOM, SSR, LLM, KV Cache) in their natural form.'
  },
  literary: {
    name: '文学与深度阅读风',
    instruction: 'Prioritize elegance, rhythm, and literary expressiveness while remaining faithful to the author’s nuances and cultural context.'
  }
};

export const LLM_PROVIDERS = [
  {
    id: 'google',
    name: 'Google Gemini (官方原生接口)',
    shortName: 'Google Gemini',
    protocol: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: '',
    keyPlaceholder: 'AIzaSy... (在此粘贴您的 Google AI Studio Key)',
    modelPlaceholder: '例如：gemini-2.5-flash 或 gemini-2.5-pro (也可点击拉取模型列表)',
    helpText: '填入 Google AI Studio API Key 后，点击「从接口拉取模型」自动同步可用模型，或直接手动填写模型 ID。',
    models: []
  },
  {
    id: 'deepseek',
    name: 'DeepSeek (深度求索官方)',
    shortName: 'DeepSeek',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: '',
    keyPlaceholder: 'sk-... (在此手动填写您的 DeepSeek API Key)',
    modelPlaceholder: '例如：deepseek-chat 或 deepseek-reasoner',
    helpText: 'DeepSeek 官方接口 (兼容 OpenAI 协议)，填入 API Key 后可一键拉取模型列表或手动填写模型 ID。',
    models: []
  },
  {
    id: 'opencode',
    name: 'OpenCode Go (OpenCode 网关)',
    shortName: 'OpenCode Go',
    protocol: 'openai',
    defaultBaseUrl: 'https://opencode.ai/zen/go/v1',
    defaultModel: '',
    keyPlaceholder: 'sk-... (在此手动填写您的 OpenCode Go API Key)',
    modelPlaceholder: '请填写您在 OpenCode 订阅的模型 ID (或点击拉取模型列表)',
    helpText: 'OpenCode Go 兼容 OpenAI 协议接口，支持修改专属网关地址并拉取或手填您拥有的模型 ID。',
    models: []
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (全球模型聚合网关)',
    shortName: 'OpenRouter',
    protocol: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: '',
    keyPlaceholder: 'sk-or-v1-... (在此手动填写您的 OpenRouter Key)',
    modelPlaceholder: '例如：google/gemini-2.5-flash、deepseek/deepseek-chat、anthropic/claude-3.7-sonnet',
    helpText: 'OpenRouter 统一 OpenAI 协议网关，支持一键拉取全平台模型列表或手动填写任意模型路由 ID。',
    models: []
  },
  {
    id: 'openai',
    name: 'OpenAI (官方接口)',
    shortName: 'OpenAI',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: '',
    keyPlaceholder: 'sk-proj-... (在此手动填写您的 OpenAI API Key)',
    modelPlaceholder: '例如：gpt-4.1-mini、gpt-4.1、gpt-4o-mini',
    helpText: 'OpenAI 官方接口 (或兼容代理地址)，填入 Key 后可自动拉取账号可用模型或手动指定模型 ID。',
    models: []
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow (硅基流动)',
    shortName: '硅基流动',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: '',
    keyPlaceholder: 'sk-... (在此手动填写您的硅基流动 API Key)',
    modelPlaceholder: '例如：deepseek-ai/DeepSeek-V3 或 Qwen/Qwen2.5-72B-Instruct',
    helpText: '硅基流动国内高速推理平台 (兼容 OpenAI 协议)，支持一键拉取平台模型列表或手填模型 ID。',
    models: []
  },
  {
    id: 'dashscope',
    name: '阿里云百炼 (通义千问 Qwen)',
    shortName: '阿里云百炼',
    protocol: 'openai',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: '',
    keyPlaceholder: 'sk-... (在此手动填写您的百炼 API Key)',
    modelPlaceholder: '例如：qwen-plus、qwen-max、qwen-turbo',
    helpText: '阿里云百炼 OpenAI 兼容模式接口，填入 Key 后可拉取可用模型或手动输入模型 ID。',
    models: []
  },
  {
    id: 'moonshot',
    name: 'Moonshot AI (Kimi 月之暗面)',
    shortName: 'Moonshot Kimi',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: '',
    keyPlaceholder: 'sk-... (在此手动填写您的 Moonshot API Key)',
    modelPlaceholder: '例如：kimi-k2-0711-preview 或 moonshot-v1-auto',
    helpText: '月之暗面 Kimi 官方 OpenAI 兼容接口，支持一键拉取账号下可用模型或手动输入模型 ID。',
    models: []
  },
  {
    id: 'zhipu',
    name: '智谱 AI (BigModel GLM)',
    shortName: '智谱 GLM',
    protocol: 'openai',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: '',
    keyPlaceholder: '在此手动填写您的智谱 AI API Key',
    modelPlaceholder: '例如：glm-4-flash 或 glm-4-plus',
    helpText: '智谱开放平台 OpenAI 兼容接口 (/api/paas/v4)，请拉取或手动输入您开通的 GLM 模型 ID。',
    models: []
  },
  {
    id: 'custom',
    name: '自定义服务商 (兼容 OpenAI / Gemini 协议)',
    shortName: '自定义服务商',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: '',
    keyPlaceholder: 'sk-... (在此手动填写您的自定义服务商 API Key)',
    modelPlaceholder: '在此输入您的网关或本地服务支持的任意模型 ID',
    helpText: '支持任意兼容 OpenAI (/v1/chat/completions) 或 Gemini 协议的自建/第三方网关 (OneAPI / NewAPI / Ollama / vLLM 等)。',
    models: []
  }
];

export const DEFAULT_SETTINGS = {
  // Multi-Provider AI Engine Configuration (No built-in default model; user configures their own)
  providerId: 'google',
  apiProtocol: 'gemini', // 'gemini' | 'openai'
  apiKey: '',
  apiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  modelId: '',
  customModelId: '',
  availableModels: [], // Dynamically fetched models for the active provider
  providerConfigs: {}, // Per-provider saved state: { [providerId]: { apiKey, apiBaseUrl, apiProtocol, modelId, customModelId, availableModels } }
  temperature: 0.2,

  // Language & Style Preferences
  targetLang: 'zh-CN',
  inputTargetLang: 'en', // Target language for triple-space input box translation
  translationStyle: 'clean',
  tonePreset: 'standard',
  customSystemPrompt: '',

  // Glossary (term -> preferred translation, newline separated "term = translation")
  glossaryText: 'LLM = 大语言模型\nTransformer = Transformer 架构\nAgent = 智能体\nToken = 词元 (Token)',

  // Interactive Features Toggles
  enableFloatingBall: true,
  floatingBallPositionY: 68, // percentage from top
  enableSelectionTooltip: true,
  enableTripleSpaceInput: true,
  enableHoverTranslate: true, // Hold Alt/Option + hover paragraph/image to translate
  enableImageTranslate: true, // Show AI Image OCR & In-Place Translation badge on webpage/X.com images
  autoTranslatePageImages: true, // Automatically translate foreign text inside X.com tweet photos / article diagrams when page translation is enabled
  hoverModifierKey: 'Alt',

  // Webpage Translation Batching & Concurrency
  batchMaxItems: 10,
  batchMaxChars: 2200,
  maxConcurrency: 3,
  requestBudgetSeconds: 90,
  enableCache: true,

  // YouTube Dual Subtitles
  enableYoutubeDualSub: true,
  youtubeAutoEnable: true,
  youtubeSubFontSize: 22,
  youtubeTransColor: '#fde047', // Warm yellow for translated subtitle
  youtubeBgOpacity: 0.72,
  youtubeShowSidebar: false,

  // Domain & Auto-Translate Rules
  autoTranslateAllPages: false, // Global master switch: automatically detect and translate foreign-language pages on load
  autoTranslateOnlinePdf: false, // Online PDF auto-translate switch: false by default (keep native browser PDF reader until user clicks plugin to translate)
  alwaysTranslateDomains: '',
  neverTranslateDomains: 'localhost\n127.0.0.1'
};

export const MESSAGE_TYPES = {
  TRANSLATE_BATCH: 'TRANSLATE_BATCH',
  TRANSLATE_SELECTION: 'TRANSLATE_SELECTION',
  TRANSLATE_INPUT_TEXT: 'TRANSLATE_INPUT_TEXT',
  TRANSLATE_IMAGE: 'TRANSLATE_IMAGE',
  TRANSLATE_YOUTUBE_CUES: 'TRANSLATE_YOUTUBE_CUES',
  TRANSLATE_YOUTUBE_AUDIO: 'TRANSLATE_YOUTUBE_AUDIO',
  ANALYZE_PDF_MULTIMODAL: 'ANALYZE_PDF_MULTIMODAL',
  TEST_API_KEY: 'TEST_API_KEY',
  FETCH_MODELS: 'FETCH_MODELS',
  GET_CACHE_STATS: 'GET_CACHE_STATS',
  CLEAR_CACHE: 'CLEAR_CACHE',
  UPDATE_CONTENT_SETTINGS: 'UPDATE_CONTENT_SETTINGS',
  GET_SITE_AUTO_TRANSLATE_STATE: 'GET_SITE_AUTO_TRANSLATE_STATE',
  SET_SITE_AUTO_TRANSLATE_STATE: 'SET_SITE_AUTO_TRANSLATE_STATE',
  SITE_AUTO_TRANSLATE_STATE_CHANGED: 'SITE_AUTO_TRANSLATE_STATE_CHANGED',
  TOGGLE_PAGE_TRANSLATION: 'TOGGLE_PAGE_TRANSLATION',
  CYCLE_TRANSLATION_STYLE: 'CYCLE_TRANSLATION_STYLE',
  SET_TRANSLATION_STYLE: 'SET_TRANSLATION_STYLE',
  GET_PAGE_STATUS: 'GET_PAGE_STATUS',
  OPEN_OPTIONS_PAGE: 'OPEN_OPTIONS_PAGE',
  OPEN_DOCUMENT_STUDIO: 'OPEN_DOCUMENT_STUDIO',
  SHOW_PAGE_TOAST: 'SHOW_PAGE_TOAST',
  SYNC_TAB_BADGE: 'SYNC_TAB_BADGE'
};
