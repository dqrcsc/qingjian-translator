# Paper Reading Implementation Plan

> **For agentic workers:** Execute independent modules with delegated workers and review integration here. Optional superpowers execution skills were searched and are unavailable; use existing collaboration tools and explicit verification checkpoints.

**Goal:** 修复论文表格与公式阅读，以及站点手动暂停在导航后丢失的问题。
**Architecture:** 安全规则表格解析在既有数学渲染边界；工作台及导出样式同步。后台保存会话暂停，内容脚本自动/手动入口使用统一状态。
**Tech Stack:** MV3 / ES Modules / Node test / Playwright。
**Spec:** `docs/plans/2026-10-30-paper-reading-design.md`

## Global Constraints

- 不发布、不推送；不新增依赖；不批量删除；保留已有荧光马克修复。
- 暂停范围是本次浏览器会话整个站点，手动恢复，长期规则不变。

## 1. 学术表格与配色

Files: studio/math-renderer.js, studio/studio.css, studio/studio.js, background/gemini-client.js, tests/academic-table.test.mjs, scripts/verify-academic-table-browser.mjs。

- [ ] 先以 `renderRichAcademicHtml('A | B\n1 | 2',{blockType:'table'})` 检查得到真实 table；目前失败为只有 br。
- [ ] 实现规则表格解析，含可选外侧竖线、Markdown 对齐行、转义/公式内竖线；不规则输入保留文本。递归复用安全单元格文字/数学渲染，不接受原始 HTML。
- [ ] 白纸表格原文 #475569，译文/公式 #335f65，浅灰表头；深色视图适配浅青灰。同步 HTML 及打印输出。
- [ ] PDF 实际上传、原生协议返回六列表格+公式，验证列坐标/颜色/单元格数、纯译文、实际 HTML 下载及打印模式。
- [ ] `node --test tests/academic-table.test.mjs` 与定向浏览器通过后汇报修改和证据。

## 2. 会话站点暂停

Files: background/site-pause.js, background/service-worker.js, content/content-main.js, shared/constants.js, popup/popup.js, tests/site-pause.test.mjs, scripts/verify-site-pause-browser.mjs。

- [ ] 先测：关闭自动翻译后下一同站点页面/新标签仍自动翻译；临时暂停不能修改 alwaysTranslateDomains。
- [ ] 后台按实际 sender URL 及命中规则生成站点键，chrome.storage.session 串行保存暂停集合；新增读/写消息，校验输入、保存失败返回错误。
- [ ] 自动翻译检查先读暂停；手动切换同步状态；配置失效内部关闭不等同用户暂停；自动 PDF入口遵守状态，显式入口仍工作。
- [ ] UI显示暂停和恢复方式；按站点广播更新状态但不撤回其他页已有译文。
- [ ] 真实入口测试同站点新页/刷新/新标签暂停、无关站点继续、手动恢复、服务worker重建/会话清除语义、快速切换及失败反馈。

## 3. 集成

Files: scripts/verify-browser.mjs, README.md, docs/verification/paper-reading-2026-10-30.md。

- [ ] 注册两个真实入口模块，审查功能宣称与边界。
- [ ] `npm run verify`、`npm run test:browser`，检查前轮 marker 三项及既有回归。
- [ ] 留存表格/公式截图和实际导出，记录确实通过的数量、使用边界和未发布状态。
