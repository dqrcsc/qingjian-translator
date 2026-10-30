# Chrome Web Store Listing — 青简 · 译读 (QingJian) — 双语精读与智译

> Last Updated: 2026-10-30

## Store Listing

**Extension Name**
青简 · 译读 (QingJian) — 双语精读与智译

**Short Description**
青简 · 译读 (QingJian)：开放多模型（支持 Gemini / DeepSeek / OpenCode Go / OpenAI 兼容协议）的双语对照精读与翻译扩展，支持网页段落对照、贴图原位译文、划词语境精解、三击空格速译、YouTube 双语字幕与 PDF/EPUB/MD 文档翻译工作台。

**Detailed Description**
青简 · 译读 (QingJian) 助您在阅读外文网页、浏览社交媒体推文配图、观看 YouTube 视频以及研读学术论文 PDF 与 EPUB 电子书时获得自然流畅的双语对照阅读体验。

核心功能亮点：
1. 纯粹开放多模型自由接入（自带密钥 BYOK，无内置模型绑定）：支持 Google Gemini、DeepSeek、OpenCode Go、OpenRouter、OpenAI、硅基流动、阿里云百炼、Moonshot Kimi、智谱 GLM 及任意兼容接口。支持一键从接口拉取可用模型或手动输入任意模型 ID，各服务商密钥与模型配置独立保存、一键切换。
2. 网页段落级双语对照与贴图原位翻译：尽力保持原网页排版，在原文下方呈现译文，内置清爽对照、引用竖线、精致虚线、外语学习模糊遮罩、荧光马克笔及仅看译文 6 种视觉样式；支持网页插图与社交媒体配图文字原位识别与翻译。
3. 高频跨语言效率交互：选中任意词句即可结合所在段落完整语境获得语境释义、音标与核心词汇语法拆解；在支持的普通输入框和部分富文本区域输入文字后连续按 3 次空格键，可请求转换为目标外语；等待期间继续编辑会取消旧结果；鼠标指向段落后单独按下并松开 Alt 可速译；图片使用其翻译控件。
4. YouTube 视频双语字幕与实验性音频切片听译：自动锁定视频原声字幕轨道并展示上下双语字幕，支持展开右侧同步滚动的双语字幕时间轴、点击跳转视频进度、一键导出双语字幕文件，并提供无字幕视频音频切片听译功能（仅 Gemini 原生音频模型，每 7 秒切片，另需接口响应时间）。
5. 学术论文 PDF 与多格式文档翻译工作台：支持在线 PDF 链接（如 arXiv 论文）直连与本地上传，提供左侧原版 PDF 联动预览、右侧保持论文单/双栏与数学公式排版、论文插图文字区域覆盖与原位中文重绘（效果依赖识别与背景）、按需滚动懒加载翻译（节省 Token），并支持导出保持排版的纯译文或双语 PDF、双语 EPUB 电子书、Markdown 与 HTML 文档。

能力边界：配置密钥或拉取模型列表并不能验证模型的翻译、视觉或音频能力。音频仅支持 Gemini 原生音频模型。PDF 版式和图片文字覆盖为尽力还原，不保证像素级一致；EPUB 导出重建文本与目录，不保留原书图片、字体和 CSS。

使用方式：
第一步：安装扩展后点击浏览器右上角「青简 · 译读」图标进入「设置」，选择您常用的大模型服务商、填入您自己的 API Key，并点击「从接口拉取模型」或手动输入您的模型 ID。
第二步：浏览任意外文网页时按下快捷键 Alt + A（或点击网页右侧悬浮球）即可开启双语对照阅读；访问在线 PDF 时点击扩展或按 Alt + A 即可在新标签页打开学术论文精读工作台。
第三步：在支持的 YouTube 视频启用字幕翻译后，可读取可用轨道或已播放字幕；点击弹窗中的「打开文档翻译工作台」即可上传并翻译本地 PDF、EPUB 或 Markdown 文档。

隐私与安全承诺：
您的所有 API Key、个人术语表配置与翻译缓存均仅保存在您本机浏览器中，翻译内容与认证密钥由您的浏览器直接发往您配置的模型接口（可能是官方接口、自建服务或第三方网关）。项目不运行中转服务器；这不等于离线翻译或内容不离开设备。服务商如何处理和保留内容取决于其政策。

**Category**
Productivity

**Single Purpose**
Translates web pages, webpage images, YouTube video subtitles, and academic/electronic documents (PDF, EPUB, Markdown, HTML) into bilingual views using the user's configured AI model API key.

**Primary Language**
中文 (简体)

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon | 128×128 PNG | ✅ Ready | `icons/icon-128.png` |
| Screenshot 1 (BYOK Setup & Popup) | 1280×800 (2x) | ✅ Ready | `docs/screenshots/01-options-byok-setup.png` |
| Screenshot 2 (Webpage Bilingual & Selection AI) | 1280×800 (2x) | ✅ Ready | `docs/screenshots/02-webpage-bilingual-and-selection.png` |
| Screenshot 3 (Webpage & X.com Image OCR) | 1280×800 (2x) | ✅ Ready | `docs/screenshots/03-image-in-place-translation.png` |
| Screenshot 4 (YouTube Dual Subtitles & Timeline) | 1280×800 (2x) | ✅ Ready | `docs/screenshots/04-youtube-dual-subtitles.png` |
| Screenshot 5 (Academic PDF Studio & Figure Inpainting) | 1280×800 (2x) | ✅ Ready | `docs/screenshots/05-pdf-studio-paper-layout.png` |

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | Saves the user's AI provider configurations, API keys, preferred model, target language, custom glossary, and visual style settings locally on their device. |
| `contextMenus` | permissions | Adds right-click menu options to toggle bilingual webpage translation, translate text inside webpage images, translate online PDF links in a new tab, explain selected text in context, and open the Document Translation Studio. |
| `activeTab` | permissions | Allows triggering bilingual translation on the currently active tab when the user clicks the extension button or uses the keyboard shortcut. |
| `tabs` | permissions | Checks the active tab's URL/domain against the user's auto-translate rules, detects online PDF URLs to display a PDF badge, and opens the built-in Document Translation Studio in a new tab. |
| `scripting` | permissions | Injects the bilingual translation stylesheet and content script into already-open tabs when the user triggers translation. |
| `<all_urls>` | host_permissions | Required so users can translate foreign-language articles, images, online PDFs, and video subtitles on any website they visit, and connect directly to their chosen AI API provider endpoints. |

## Privacy & Data Use

### Data Collection

The extension has no project-operated collection server. It stores settings and caches locally, but sends content to the user-configured AI endpoint to provide translation. The endpoint operator is a recipient of that content. This technical inventory is a submission aid, not a completed Chrome Web Store privacy declaration or approval.

| Data | Local handling | Off-device transmission | Recipient / purpose |
|------|----------------|-------------------------|---------------------|
| API keys | Saved in browser extension storage | Sent in authentication headers or Gemini query parameters | User-configured model endpoint, for API authentication |
| Webpage text, selected text, input-box text, surrounding context/title | Read for requested or enabled automatic translation; translations may be cached locally | Yes, when the feature is triggered | User-configured model endpoint, for translation/explanation |
| Images, PDF pages, document text | Processed in the browser | Selected images/pages/text sent when translation is triggered | User-configured model endpoint, for recognition/translation |
| YouTube subtitles and captured audio | Read/captured for enabled subtitle/audio features | Subtitle text or audio slices sent to the model; subtitle resources fetched from YouTube | Configured endpoint and YouTube as required by each feature |
| Personal, health, financial or communication details within translated content | Not separately categorized | May be included if present in the content selected for translation | Same configured endpoint; do not describe these categories as categorically never transmitted |

Automatic translation settings can trigger requests without a separate click for each paragraph or image. Users should review the endpoint, enabled features and model provider's data policy. The extension does not sell data; it cannot make a retention guarantee on behalf of external providers.

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Distribution

**Visibility**: Public
**Regions**: All regions

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.0.14 | 2026-10-30 | Serialized content settings, configuration invalidation, validated multimodal results, live translated links, code-safe Markdown roundtrips and empty subtitle feedback. | GitHub release; Chrome Web Store submission not performed |
| 1.0.13 | 2026-10-30 | Correct PDF page ownership and failure recovery, input draft protection, dynamic source invalidation, complete HTML text and consistent export layout, figure label retranslation and capability wording. | GitHub release; Chrome Web Store submission not performed |
| 1.0.12 | 2026-10-30 | Document configuration snapshots, bounded PDF pixels and cancellation, media-time audio slices, manual timeline reading, 100-item document windows and corrected capability wording. | GitHub release; Chrome Web Store submission not performed |
| 1.0.9 | 2026-10-30 | Reading integrity, clickable translation links, Alt gesture isolation, import readiness, complete HTML exports, PDF forced refresh, EOF code preservation and full-width translation view. | GitHub release; Chrome Web Store submission not performed |
| 1.0.8 | 2026-10-23 | Studio single-block and full-document retranslate cache bypass, multi-segment retry cleanup, and YouTube detached error banner remounting. | Ready |
| 1.0.7 | 2026-10-23 | Studio private entry, monotonic block IDs, YouTube failure backoff, bounded stats accounting, Web Locks settings serialization, and Gemini native output guards. | GitHub release |
| 1.0.6 | 2026-10-23 | Per-request 90s total budget (configurable 30-300s) and detached webpage DOM/observer reclamation. | GitHub release |
| 1.0.5 | 2026-10-23 | Raw-settings protocol normalization, rapid-toggle and image decode lifecycle guards, deduplicated batch output statistics, real content-script browser regressions. | GitHub release; store submission not performed in this release workflow |
| 1.0.4 | 2026-10-22 | Multi-item batch placeholder subset retry, upgraded Gemini audio protocol fallback, and rapid page-translation toggle cleanup guards. | Ready |
| 1.0.3 | 2026-10-21 | Official PDF.js 6.4.299, local worker/assets, end-to-end cancellation and real Chromium regression checks. | Awaiting store review |
| 1.0.2 | 2026-10-21 | Reliability fixes, regression tests, EPUB navigation, release licensing and corrected data-flow disclosures. See CHANGELOG.md for validation boundaries. | Awaiting browser acceptance / store review |
| 1.0.0 | 2026-10-21 | Initial public release of 青简 · 译读 (QingJian) featuring Pure Open-Model BYOK AI Engine (Gemini, DeepSeek, OpenCode Go, OpenRouter, OpenAI, SiliconFlow, Qwen, Kimi, GLM), Webpage Bilingual Translation with 6 visual styles, Webpage/X.com Image In-Place OCR Translation, Selection AI Deep Explanation, Triple-Space Input Translation, YouTube Dual Subtitles + Audio Translation, and Academic PDF (Layout-Preserving + Seamless Figure Inpainting + Lazy Loading) / EPUB / Markdown Document Studio. | Ready |
