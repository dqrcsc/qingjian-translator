# Changelog

## 1.0.10 — 2026-10-30

### YouTube 字幕恢复与会话一致性

- 扩展升级或重新加载导致连接失效时，明确提示刷新页面，不再误报“字幕返回为空”或一直显示正在翻译；暂停、退避与等待状态同步显示。
- 首次加载等待保存的设置，修复自动字幕开关及默认时间轴侧栏不生效；运行中修改偏好立即同步。
- 抓取字幕时绑定视频 ID 和导航代次；快速切换视频、A→B→A 和迟到的 fetch/XHR 响应不再污染当前视频。
- 切换目标语言、模型、接口、术语或提示词时取消旧请求并清除旧译文，保留原文与时间；普通重试仍保留已成功译文。
- 尊重播放器当前有效字幕轨选择；没有有效选择时结合 ASR 等元数据选轨，修复日语 ASR 被无关英语人工轨抢占，以及中文/阿拉伯语字幕被误判的问题。

### 实时字幕与 EPUB 阅读完整性

- 实时原生字幕兜底新增已观察片段时间轴、搜索和 TXT/SRT/复制导出，重复轮询去重、跳转分段；保留最近 1000 条并提示淘汰数量。
- 局部字幕导出标记 `observed-partial`，明确只包含已捕获片段；打开导出菜单不再自动下载 TXT，修复 SRT 毫秒进位。
- EPUB 按源顺序保留代码块、表格文字、图注、短文本及嵌套列表/引用，避免父子重复；代码保留空白并以转义后的 pre/code 导出。
- 修正“60fps”“保证锁定原声”等功能描述，明确选轨、实时观察和 EPUB 重排边界。

### 升级与使用说明

- 下载 Release 中的 `qingjian-translator-v1.0.10.zip`，解压后在 Chrome / Edge 的扩展管理页开启开发者模式，选择“加载已解压的扩展程序”。
- 已有用户请将安装包解压到原扩展目录并点击“重新加载”，随后刷新已打开的网页，尤其是 YouTube 标签页；无需删除扩展或清除配置。
- 实时字幕导出不包含未观看/未捕获的部分，观察时间不保证等于完整字幕起止时间。EPUB 保留文本，不还原原书图片、CSS 或表格布局。
- 下载/解压预算、长 PDF 内存回收与完整长字幕时间轴虚拟化仍待后续优化。

验证与安装包校验见 [v1.0.10 发布验收](docs/verification/v1.0.10.md)，功能回归详情见 [修复验证记录](docs/verification/2026-10-30-reading-consistency.md)。

## 1.0.9 — 2026-10-30

### 阅读完整性与全宽纯译文

- 网页仅译文按分段完成情况保留未译原文；修复多段元素部分成功时整段原文提前隐藏的问题。
- 保留仅译文模式中的链接交互，恢复双语或关闭翻译后保留原网页结构。
- Alt 单键操作与 Alt+A / Alt+S 组合快捷键区分，避免切样式时误撤销段落译文。
- 工作台增加全宽仅译文视图；原有右侧仅译文视图仍可保留左栏，未译段落明确保留原文。
- 文件解析完成前禁用翻译/导出，失败和过时导入不能产生空文档或错误页数的请求。
- HTML 导出全文，不再把搜索结果或单个章节误当成完整文档。
- PDF 强制重译将绕过缓存的意图传递到逐页文本和图中文字请求；继续未完成页仍可复用缓存。
- Markdown 到达文件末尾时保留未闭合代码围栏内容，避免静默丢失代码。
- 修复 PDF 打印“仅已译页”和指定范围被后置样式覆盖的问题，避免混入范围外页。

验证与边界见 [v1.0.9 验收记录](docs/verification/v1.0.9.md)。安装包与中文说明见 [v1.0.9 Release](https://github.com/dqrcsc/qingjian-translator/releases/tag/v1.0.9)。

## 1.0.8 — 2026-10-23

### 重译绕过缓存与复合元素重试清理

- **工作台单段重译与全文「重新翻译」绕过缓存**：`handleTranslateBatch` 新增 `bypassCache` 支持，强制重新调用模型并用最新译文更新持久缓存；`retranslateBlock` 单段重译及已完成文档点击「✦ 重新翻译」（含 PDF 已完成页重置与常规文档已译段落重译）均自动启用 `bypassCache: true`，未完成文档继续仅补译未译段落并复用缓存。
- **网页多段元素局部失败重试清理**：复合元素（`isMultiSeg`）点击 `⚠️ 重试` 徽章时，清理归属该节点的残留分段记录与旧子节点并重置元素状态，避免已成功子段出现双份译文叠加。
- **YouTube 错误状态条自动重挂载与预取简化**：当播放器 DOM 重建导致 `ytErrorEl` 脱离文档树（`isConnected === false`）时自动重建挂载，并移除 `prefetchYoutubeCuesAround` 中被单请求互斥锁短路的同帧冗余调用。

验证：47 项结构/功能检查、82 项 Node 回归测试与 234 个 ZIP 运行时文件校验全部通过。安装包与说明见 [v1.0.8 Release](https://github.com/dqrcsc/qingjian-translator/releases/tag/v1.0.8)。

## 1.0.7 — 2026-10-23

### 安全、译文归属与失败恢复

- 收紧文档工作台入口，外部网页不能通过嵌入工作台静默触发模型请求；扩展按钮、右键菜单等正常入口保留。
- 文档块保持稳定身份，插图、PDF 乱序合并及过时重译响应不再把译文写到别的段落；单段重译失败保留原译文、显示错误并恢复重试。
- YouTube 字幕与原生字幕回退遇到永久错误时停止自动请求；暂时错误有界退避，支持明确重试及设置变更后恢复，切换视频或离开后返回不会被旧响应污染。
- 统计读取可取消、物理写入保持串行，调用方最多等待记账 250ms；存储失败不丢弃成功译文，待写队列上限 32，避免异常存储占用模型并发槽或无限积压。
- 模型发现不再由后台无条件覆盖配置；设置页、弹窗检查发起时的服务商与配置快照，跨窗口写入串行，快速切换不会显示旧服务商模型。
- 同一图片节点更换 src/srcset 或响应式 currentSrc 后旧译图和在途结果失效；释放控件同步清理悬停标记，关闭网页翻译后手动译图仍可恢复。
- 缓存磁盘读取/清理失败如实报告不可用或部分成功，不再将内存数量冒充磁盘数量或误报全量清除成功。
- 补齐真实扩展入口、浏览器、跨窗口及 Gemini 原生协议测试；拒绝纯 thought、被阻断和被截断的 Gemini 输出，防止伪成功和缓存污染。

验证细节与使用边界见 [v1.0.7 验收记录](docs/verification/v1.0.7.md)。安装包与中文更新说明见 [v1.0.7 Release](https://github.com/dqrcsc/qingjian-translator/releases/tag/v1.0.7)。

## 1.0.6 — 2026-10-23

### 请求总时间预算与长网页资源回收

- 每个后台模型请求默认共用 90 秒总预算，设置页可调整为 30–300 秒；排队、图片下载、响应读取、重试退避、接口兼容回退和子集补译不会重新计时。超时明确报错，保留主动取消的原有语义与原子队列清理。
- 段落完成或失败后释放内部记录；移除节点时取消观察并剔除待发段落，迟到结果不写回已移除节点。保留同步 DOM 搬移，支持移除后重新插入。将动态扫描合并为可取消定时器及有界根集合。
- 图片节点被替换但父容器保留时，清理旧控件、覆盖层及其图片引用；新控件绑定新图片，避免旧按钮被复用。
- 补齐实际后台 Port / legacy 入口、超时后重试、兼容回退、子集补译、队列、迟到响应和设置页持久化回归；Chromium 直接检查扩展持有的段落记录与观察目标，覆盖连续增删、同步搬移、重新插入和图片替换。

验证：47 项检查、54 项 Node 回归、真实 Chromium 和 ZIP 逐文件验证。见 [验收记录](docs/verification/2026-10-23-budget-and-resource-reclamation.md)。安装包与中文更新说明见 [v1.0.6 Release](https://github.com/dqrcsc/qingjian-translator/releases/tag/v1.0.6)。

## 1.0.5 — 2026-10-23

### Configuration and lifecycle fixes

- Resolve the protocol from raw settings before applying defaults. Share the resolver across content scripts and storage read/save/change entry points; load it in manifest and fallback injection paths. Missing non-Google protocols no longer inherit Gemini and bypass the audio capture gate.
- Retire old paragraph cleanup state before re-observing it. Deferred cleanup cannot erase a new session's observed or queued paragraphs, including multi-frame cleanup and repeated toggles.
- Track image request ownership with a WeakMap and preserve the scope abort signal through decoding. Cancelled, replaced or detached image operations cannot append stale overlays, reset replacement loading state or show stale error/success UI.

### Statistics and regression coverage

- Count translated paragraphs and source characters once, only at the successful outer paragraph/subtitle batch boundary. Subset retries no longer inflate completed output; track subset retry batches separately as `batchRetries`. Historical counters are preserved because past duplicate counts cannot be reconstructed reliably. Request counters remain application estimates, not billing or exact HTTP-attempt counts.
- Add raw-setting provider/protocol matrices, repeated rapid-toggle scheduling, image decode/replacement tests and background storage/cache accounting checks, including cancellation during subset repair.
- Extend real Chromium tests to manifest-injected webpage content, both RAF/observer orderings, image decode cancellation and replacement, initial storage loading and YouTube audio-button protocol gating. Audio capture itself is stubbed; all model calls use local fixtures.

Validation: 46 checks, 39 Node regressions, real Chromium suite and exact-content ZIP validation. See [verification record](docs/verification/v1.0.5.md). Existing PDF layout/EPUB resource and external-provider cancellation limits remain.

## 1.0.4 — 2026-10-22

### Edge-case and resilience fixes

- **Multi-item batch placeholder recovery**: When an individual item in a multi-item paragraph or subtitle batch omits an inline `{{n}}` placeholder on the first pass, retain the valid translations from the batch and retry only the damaged item via the missing-subset retry path; still reject and prevent caching if the retry or a single-item request fails placeholder validation.
- **Default/upgraded Gemini protocol resolution in content script**: Add `providerId: 'google'` and `apiProtocol: 'gemini'` to content-script `DEFAULT_SETTINGS` and resolve the active protocol consistently in `toggleExperimentalAudioListen`, preventing default Google Gemini users whose storage lacks an explicit `apiProtocol` key from being blocked before YouTube audio capture.
- **Page translation rapid-toggle & image cancellation state**: Clear `flushQueueTimer` and reset `blockMap`, `totalTranslatedCount` and image overlays synchronously in `disablePageTranslation`, and guard deferred `requestAnimationFrame` DOM cleanup with `igCleanupSession` so immediately re-enabling page translation does not lose newly queued paragraphs. Reset `data-ig-img-status="loading"` when an image translation request is cancelled.

## 1.0.3 — 2026-10-21

### PDF.js upgrade

- Replace the modified PDF.js 1.9.426 scripts with the official unmodified **6.4.299 legacy ES module distribution**. Load a real local module worker, use modern loading/render task promises and viewport options, and preserve the caller's input buffer.
- Bundle CMaps, standard fonts, ICC profiles, WASM decoders/fallbacks and their licenses. Pin npm SHA-512 and per-file SHA-256; reproduce with `scripts/vendor-pdfjs.mjs`.
- Set `isEvalSupported: false`. Extension CSP allows local WASM compilation but not JavaScript unsafe-eval or Blob workers. An explicit local Worker avoids PDF.js's Blob wrapper for extension URLs.
- Abort PDF downloads/loading/rendering with the document lifecycle. Destroy replaced documents/workers and revoke old object URLs. Display load failures rather than silently treating failed parsing as a usable PDF.

### End-to-end cancellation

- Frontend scopes multiplex requests over owned runtime ports. Pause, document/video/track replacement, audio stop and page close disconnect the appropriate scope; the worker first removes all its queued entries, then aborts active fetches. Separate tabs/scopes remain independent.
- Propagate AbortSignal through Gemini/OpenAI calls, image downloads, response-body buffering and retry delays. Prevent cancelled results from entering translation caches. Keep session guards for responses that finish just before cancellation.
- Include online PDF fetching, document loading/rendering, web translation, image translation, subtitles/audio, popup quick translation and settings API requests. Popup non-model commands remain on the ordinary message channel.
- Extend CI with pinned Playwright and real Chromium extension tests against a local HTTP fixture. No production API keys or paid model calls are needed.

### Verification and limits

`npm run pack` runs 45 structural/functional checks, 29 regression tests and release ZIP inspection. `npm run test:browser` exercises a real MV3 extension: PDF worker startup, text/coordinates, rotated-page dimensions, vector/raster rendering, loading cancellation, actual pause/switch/close cancellation and successful subsequent requests. See `docs/verification/v1.0.3.md` for the observed browser and results.

Client-side abort closes the HTTP connection; it cannot guarantee that an external provider stops computation or reverses charges. These tests do not certify every PDF feature, browser or model. Layout reconstruction and EPUB resource-preservation limits from v1.0.2 still apply.

## 1.0.2 — 2026-10-21

### Correctness and reliability

- Match paragraph/subtitle translations strictly by ID. Reject duplicate, unknown, malformed IDs and damaged inline placeholders; retry only missing items once. Empty/unresolved responses fail visibly instead of being cached as successful original text.
- Version cache keys and include provider, protocol, endpoint, style and context. Existing v1 cache entries will not be reused; new translations may incur API calls. Bound memory to 2,500 entries even when hydrating from IndexedDB.
- Apply request timeouts through response-body completion, preserve caller cancellation, and avoid consuming an error body twice. Share concurrency limits across translation task types.
- Discard stale document/video/track responses, including after pause. Empty PDF analysis stays failed; export requiring unfinished pages does not silently print an incomplete result.
- Reject unsupported audio protocols before capture. Stop capture on failure, explicit stop or video change; bound pending audio slices and preserve chronological cue order.
- Export EPUB chapter XHTML, navigation, reading order, target language and modification metadata. Export remains a reconstructed text edition.
- Label popup state as configured rather than implying a successful API connection.

### Release checks

- Add 22 focused regression tests using mocked API, storage and UI boundaries; retain the existing 43 checks.
- `npm run pack` now runs verification before packaging, then inspects actual ZIP contents and version consistency.
- Ship MIT and Apache-2.0 license texts and third-party provenance notes. Correct README/store data-flow and capability statements.

### Validation boundaries and remaining work

Automated checks do not replace loading the extension in Chrome with a real configured provider. No paid/model requests were used for these regressions. Before publishing to the store, manually exercise webpage translation, YouTube track/video switching, audio start/stop, PDF pause/document switching and PDF/EPUB export in representative browsers/readers.

- Pause/switch invalidates callbacks but does not cancel already-dispatched background/model work or refund provider charges.
- Usage counters remain estimates; model capability discovery is not a runtime guarantee. OpenAI-compatible PDF processing uses local text/coordinate extraction, not automatic vision OCR for scanned pages.
- PDF reconstruction and background-color text overlays cannot guarantee original layout or complex-image preservation. EPUB exports do not preserve original images, styles or fonts; EPUBCheck/reader interoperability has not been certified by the Node tests.
- The bundled PDF.js 1.9.426 is unchanged. An upgrade and dependency security review need separate rendering/worker compatibility validation; see THIRD_PARTY_NOTICES.md.
- The existing broad host permissions and local key-storage architecture remain. This release corrects disclosure and runtime failures; it is not a completed security or Chrome Web Store compliance audit.
