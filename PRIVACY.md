# 隐私政策 / Privacy Policy — 青简 · 译读 (QingJian)

> 最后更新 / Last Updated: 2026-10-31

## 1. 概述 / Overview

**青简 · 译读 (QingJian)** 是一款运行在用户本地浏览器中的开放多模型（BYOK，自带密钥）双语对照阅读与翻译 Chrome 扩展。本项目**不设立、不运营任何开发者后端服务器、中转网关或遥测收集服务**。

**QingJian** is a local, Bring-Your-Own-Key (BYOK) bilingual reading and translation Chrome extension. This project **does not operate any developer backend server, proxy gateway, or telemetry collection service**.

---

## 2. 数据收集与存储 / Data Collection & Local Storage

### 本地存储的数据 / Locally Stored Data
扩展仅在您的浏览器本地存储（`chrome.storage.local`、`chrome.storage.session` 与浏览器本地 `IndexedDB`）中保存以下数据：
1. **API 密钥与模型配置**：您自行填入的各 AI 服务商 API Key、接口地址（Base URL）、模型 ID、目标语言、术语表与系统提示词。
2. **界面与站点偏好**：译文显示样式、悬浮球位置、自动翻译站点规则、当前会话站点暂停状态。
3. **本地翻译缓存与统计**：为减少重复 API 调用与 Token 消耗而在本机 `IndexedDB` 中保存的段落/字幕译文缓存（可在设置页随时关闭或一键清空）及本机累计请求计数。

All API keys, provider configurations, domain rules, and translation caches are stored exclusively inside your local browser (`chrome.storage.local`, `chrome.storage.session`, and local `IndexedDB`). You can clear the cache or reset all settings at any time from the Options page.

---

## 3. 数据传输与第三方服务 / Off-Device Transmission & Third-Party Services

当您主动触发翻译功能（如开启网页双语翻译、Alt 悬停段落翻译、划词精解、三击空格输入框翻译、网页图片翻译、YouTube 双语字幕/音频听译、或文档工作台翻译），或当您开启了自动翻译规则并访问匹配页面时：
- 扩展会从您的浏览器直接向**您所配置的 AI 模型接口地址**（例如 Google Gemini、DeepSeek、OpenAI、OpenRouter 或您自建的兼容接口）发送待翻译的文本、图片、PDF 页面或音频片段，并在请求头中附带您的 API Key 以完成身份验证。
- 在 YouTube 页面启用双语字幕时，扩展会在页面上下文读取或请求当前视频对应的 YouTube 字幕轨道资源。
- 在打开在线 PDF 链接翻译时，浏览器工作台会直接从目标 PDF 链接下载文档字节流并在本地通过内置 PDF.js 解析。

外界 AI 服务商如何处理、保留或使用您发送的请求内容，取决于您所选择的服务商自身的隐私政策与服务条款。请勿在不受信任的第三方自定义接口上翻译包含敏感个人身份、财务、医疗或机密通信的数据。

When translation is triggered manually or by your configured auto-translate rules, the extension sends the selected text, image, PDF page, or audio clip directly from your browser to the **AI API endpoint configured by you**, along with your API key for authentication. How the external model provider processes or retains that data is governed by that provider's own privacy policy and terms of service.

---

## 4. 权限说明 / Permissions Disclosure

| 权限 / Permission | 用途说明 / Purpose |
|---|---|
| `storage` | 在本机保存您的模型配置、API Key、术语表、译文样式与本地统计数据。 |
| `contextMenus` | 提供右键菜单快捷入口（切换网页双语翻译、原位翻译图片文字、在新标签页精译在线 PDF、精解选中文本、打开文档工作台）。 |
| `activeTab` / `tabs` | 获取当前活动标签页地址以匹配您的站点自动翻译规则、识别在线 PDF 链接并展示 PDF 徽标、以及在新标签页打开本地文档翻译工作台。 |
| `scripting` | 当您在扩展安装或更新前已打开的网页上触发翻译时，按需注入双语样式表与内容脚本。 |
| `<all_urls>` | 允许您在任意外文网站上执行段落对照与贴图翻译，并允许后台工作线程直接连接您所选择的任意 AI 服务商接口地址。 |

---

## 5. 合规承诺 / Chrome Web Store Limited Use Certification

- 本扩展**不收集、不上传、不出售**任何用户浏览记录、个人身份信息或翻译内容给扩展开发者或任何无关第三方。
- 所有对网页内容与用户数据的访问仅用于实现用户请求的翻译与双语阅读单一核心功能。
- 本扩展不使用任何数据进行广告投放、用户画像、信用评估或借贷分析。

The use of information received from Google APIs and browser permissions adheres strictly to the Chrome Web Store User Data Policy, including the Limited Use requirements.
