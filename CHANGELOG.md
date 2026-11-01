# Changelog

## 1.0.18 — 2026-11-01

本版完成全量代码安全审计修复、Chrome Web Store 合规加固、React/Vue 宿主 DOM 兼容保护、滚动扫描性能优化，以及 Studio 文档工作台与设置页多项边界缺陷修复。

### 商店合规与后台安全加固

- 精简 `manifest.json` 的 `description` 至 124 字符（符合商店 ≤132 字符上限），为 `web_accessible_resources` 启用 `"use_dynamic_url": true`，并新增中英双语 `PRIVACY.md` 隐私与 Limited Use 声明。
- 在 `service-worker.js` 中新增 `assertPrivilegedExtensionSender` 与 `mergeAdminTestSettings`，拒绝普通网页 Content Script 调用管理接口（`TEST_API_KEY` / `FETCH_MODELS` / `CLEAR_CACHE`），并防止自定义 `apiBaseUrl` 泄露已存储的 `apiKey`。
- 为快捷键 `Alt+A` / `Alt+S` 补充脚本动态注入兜底（`ensureContentScriptAndSendMessage`）；修正 IndexedDB 连接关闭自动重连与唤醒首次写入淘汰检查。
- 支持 `Retry-After` 响应头退避，修复 `responseSchema` 回退与 400 重复请求，新增 `MAX_TOKENS` 批次自动对半拆分重试、划词/输入框翻译 `thinkingBudget: 0` 加速、OpenAI 推理模型自动省略 `temperature`，以及图片拉取协议/MIME/20MB 体积校验。

### 网页内容脚本、YouTube 与 Studio 工作台修复

- 网页取消翻译时仅合并扩展自身拆分的 `__igSplitFromPrev` 文本节点，移除 `el.normalize()` 以保护 React/Vue 相邻文本节点引用；引入单次扫描祖先可见性缓存 `activeScanVisibilityCache` 降低滚动扫描布局开销。
- 补全多语种（日/韩/俄/英）目标语言检测、Alt 悬停翻译容器与可编辑区域过滤、`pageshow` bfcache 恢复清理、YouTube 广告期间暂停正片字幕及十六进制 HTML 实体解码。
- 在 Studio `translateSinglePdfPage` 中移除多页 PDF 页面渲染缺失时整份上传 `pdfArrayBuffer` 的危险回退；通过 `inFlightPagePromises` 共享在途页面翻译 Promise；保护用户粘贴附图（`userAttached`）；剔除 EPUB 导出中的非法 XML 1.0 控制字符并限制 LaTeX 递归深度。
- 修复设置页 `temperature = 0` 保存被重置为 `0.2` 的问题，增加恢复默认配置二次确认、Popup 子域名后缀匹配与中文输入法 `isComposing` 回车过滤，并为所有深色页面声明 `color-scheme: dark`。

## 1.0.17 — 2026-10-31

本版修复高密度学术 PDF 单页翻译触发 45 秒单次尝试超时后重发起重试、最终撞上 90 秒总时间预算报错（`请求已超过总时间预算（90 秒）`）的问题，并将原生矢量文本 PDF 单页拆分为并发小批次翻译以显著降低单页耗时。

### 超时预算对齐与禁止超时重跑

- 修复 `fetchWithTimeoutAndRetry` 在单次尝试超时（原文本请求 45 秒、多模态 75 秒）后误判外层 `callerSignal` 未终止而重头发起第 2 次重试、最终必然在 90 秒处撞上 `createRequestBudget` 总预算的缺陷：单次请求超时后直接快速失败，不再浪费剩余预算重跑慢请求。
- 将 OpenAI 兼容接口与 Gemini 原生接口的单次尝试超时统一对齐到用户配置的 `requestBudgetSeconds`（默认 90 秒，最低不小于 85 秒），并对 Gemini `2.5-pro` 模型补充 `thinkingBudget: 128` 思考预算上限。

### 原生矢量文本 PDF 并发小批次加速

- 对于具备完整 PDF.js 矢量文本层的学术论文（如 arXiv LaTeX 论文），无论使用 OpenAI 兼容协议还是 Gemini 协议，均优先复用本地毫秒级 2D 坐标版面重建提取结构化段落，仅对扫描件或缺少矢量文本层的页面回退整页多模态图片识别，省去整页英文原文重复回传的数千输出 Token。
- 单页 PDF 段落按小批次（每批最多 3 段 / 900 字符）切分并通过 `Promise.all` 并发提交后台并发池，使每个小批次独立享有完整时间预算并并发完成。

## 1.0.16 — 2026-10-31

本版修复长耗时 PDF 翻译时 MV3 Service Worker 空闲断连报错（`请求连接已关闭`）、首 2 页预翻译与懒加载观察器抢跑并发，以及按需翻译占位卡片的加载状态展示问题。

### 长连接保活与自动重连

- 后台请求长连接（`qingjian-request-v1`）在存在在途请求时每 15 秒双向发送 `keepalive` 心跳并调用扩展运行时接口，防止慢速大模型响应期间 Service Worker 在 30 秒空闲阈值处被浏览器回收。
- 若非用户主动取消而发生连接意外断开，客户端自动重连并透明重发一次请求；携带图片的多模态请求单次尝试超时调整为 75 秒以匹配 90 秒总时间预算。

### PDF 首 2 页顺序翻译与按需懒加载隔离

- 开始整篇 PDF 翻译时，在首 2 页完成前保持 `lazyScrollEnabled = false`，避免 `210px` 占位卡片同时落入视口导致第 2、3 页与第 1 页抢跑并发。
- 仅在首 2 页至少有 1 页翻译成功且用户实际滚动右侧容器后，才启用后续页面的按需滚动懒加载；若懒加载队列中某页翻译失败，立即清空队列停止自动拉取后续页。
- 页面占位卡片进入加载态时同步更新说明文案并隐藏“立即翻译本页”按钮。

## 1.0.15 — 2026-10-30

本版改善论文表格与公式阅读，修复多行荧光马克样式，并让手动关闭翻译的选择延续到本次会话的同站点后续页面。

### 论文表格与公式

- 规则的竖线分列 / Markdown 表格恢复为真实行列，保留表头、对齐、空单元格、粗体及单元格内的数学和代码。无法可靠识别的结构保留文本，避免猜测错列或丢失内容。
- 白纸表格原文采用清晰灰色，译文和公式统一采用柔和深青灰，配浅灰底和细分隔线；深色流式阅读采用浅青灰。
- HTML 与 PDF 打印入口同步表格布局和配色；修复 HTML 导出中分式横线丢失的问题。

### 手动关闭与自动翻译

- 手动关闭网页翻译后，本次浏览器会话内暂停整个站点的自动翻译；同站点后续页面、新标签页和自动 PDF 工作台入口都遵守暂停。
- 长期自动翻译规则仍保留，弹窗和悬浮球显示临时暂停及恢复方式。手动开启可恢复本站自动翻译，其他已完成的标签页不会撤回译文。
- 明确配置的父域名规则覆盖对应子域名；没有匹配规则时仅按当前主机名暂停，不猜测并合并其他网站。
- 后台休眠后暂停继续保留；浏览器重启或扩展停用、重新加载、更新后临时暂停结束。保存或通信失败会明确提示。

### 荧光马克

- 从整段下半部的背景改为逐行贴合文字的高亮，支持自动换行、手动换行和短标签，行尾空白不再被整块涂黄。
- 保留译文链接点击、其他阅读样式及关闭后恢复原文；切换样式不增加翻译请求。

## 1.0.14 — 2026-10-30

本版修复 v1.0.13 审计确认的 6 类问题，覆盖设置并发保存、多模态结果、配置切换、动态链接、Markdown 代码导出和空字幕反馈。

### 设置保存与配置切换

- 网页样式、悬浮球位置和自动翻译规则通过后台统一保存局部字段，避免覆盖弹窗或设置页刚保存的其他配置；保存失败会显示提示。
- 修改影响翻译的语言、模型、接口、术语、语调等配置时，网页取消旧请求并恢复原文，提示重新开启翻译；不会静默重译整篇网页。
- 旧图片、划词和输入请求同步失效，避免晚到结果混入新配置。YouTube 补齐语调、温度等变化后的字幕失效与重新请求；仅改样式或字号不会重新翻译。

### PDF 与图片结果校验

- PDF 响应即使是合法 JSON，也必须具备有效内容、页码和译文；缺译、异常字段或图形坐标不再计入完成页。
- 代码、公式允许保留原文；真正无文字的图片保留正常无文字提示。
- 图片明确识别到文字却缺少译文时显示失败，不再误报“没有需要翻译的文字”。失败后保留已有内容，可显式重试，不增加无限自动重试。

### 链接、代码和字幕文件

- 原网页链接地址、标题或打开方式变化后，译文链接同步更新；同文字节点替换也能正确关联。不允许的链接协议不会进入可点击译文链接，单纯链接属性变化无需请求模型。
- HTML / EPUB 的裸代码导出 Markdown 时生成安全围栏，保留已有 Markdown 围栏、代码空白及内嵌反引号；未闭合代码块补齐结束围栏。重新导入仍按代码处理，不会交给模型翻译。
- 空 SRT/VTT、仅头部或注释、没有有效时间条目的文件明确提示没有可翻译字幕，禁用开始与空导出；有效文件重新上传后可正常使用。

## 1.0.13 — 2026-10-30

本版修复 v1.0.12 审查确认的 8 项问题，重点保护文档内容、用户输入和失败后的恢复行为。

### PDF 页归属与失败恢复

- 无文字层的 PDF 页不再通过全文兜底误用其他页内容；当前页无法提取时明确提示使用支持视觉的模型，其他页仍可继续翻译。
- 失败页保留错误状态，重绘、滚动和切换布局不会再次触发自动请求；可点击页内重试或顶部继续明确重试。
- 后台单请求仍保留既有有限重试与总预算；工作台不再因懒加载重建而无限创建新请求。
- 重译失败时保留可阅读的旧内容，但不计为本次完成；完整 PDF 导出发现页面仍失败时不打印不完整结果。

### 输入保护与动态网页

- 三击空格请求绑定触发时的输入内容和编辑状态。等待期间继续编辑、开始输入法组合、失焦或移除输入框，会取消或作废旧结果，避免覆盖新草稿。
- 富文本替换限定在当前编辑区域；不再使用全局全选，也不会把焦点从其他输入框抢回。
- 已译网页的原文节点更新后会使旧译文失效并重新翻译；晚到响应不能覆盖更新后的原文，扩展自己写译文不会触发重复请求。

### HTML 解析与导出

- 补齐根文本、div、表格单元格等正文提取，修复嵌套列表和引用重复；保留单字符标题、正文顺序和代码文本。
- 排除脚本、样式、模板和显式隐藏内容。没有可提取正文时显示加载错误，不再空白成功。
- 导出的 HTML 与工作台使用一致的双栏流和跨栏规则；补齐图中文字覆盖层坐标、尺寸与样式，保留全文和纯译文切换。

### 附图重译与功能说明

- 按新配置重译非 PDF 文档时，同时更新图注、图内标签和译图；已有原文标签直接翻译后基于原图重绘，缺少标签时才重新识别图片。
- 图内译字失败会显示未完成状态，并从完成计数中排除；可继续重试，上一版恢复会一起恢复原有标签和译图。
- 界面与 README、商店说明统一为“图中文字覆盖”“尽力重排”，明确识别质量、复杂背景和富文本兼容性限制。

## 1.0.12 — 2026-10-30

本版落实 v1.0.11 审查发现的 7 项改进，覆盖文档配置归属、PDF 资源预算与取消、音频时间轴、字幕手动阅读、长文档窗口以及功能说明。

## 文档翻译配置保持一致

- 文档绑定实际生效的语言、模型、接口、术语及提示配置；运行中修改设置会停止旧请求并显示选择提示，避免一份文档静默混用多套译文。
- 可继续原配置，也可明确按新配置重译；新配置重译时保留上一版译文，当前工作台内可恢复。关闭或替换文档前请导出成果，上一版备份不持久化到磁盘。
- 后台实际请求使用文档快照；从模型列表选择的默认模型也会冻结。文档中的 Gemini 模型遇到 404 时明确报错，不自动改用另一模型。
- 配置选择防止连续点击覆盖备份；旧响应不写入新代次。修复新配置重译后 PDF 后续页懒加载、旧滚动抑制状态以及代码块完成计数。

## PDF 像素预算与完整取消

- 创建画布前限制单页最多 4,194,304 像素、单边最多 4096 像素，超大页按比例降低渲染倍率，文字坐标跟随实际倍率。
- 渲染/缓存最多使用 8 个应用画布槽位，并发仍为 2；正在翻译的页受保护，但不会因保护而无限扩容。按单页上限计算，8 个驻留槽位的 RGBA 理论上限为 128 MiB。
- 取消覆盖取页、渲染和流式文字提取；失败/取消释放局部画布，排队任务及时结束，迟到结果不恢复缓存。
- PDF.js 无法立即取消的取页及尚未结束的底层任务单独限量；达到上限时明确提示稍后重试。取消中的短暂重叠、PDF.js 内部数据、JPEG、译图及原文档不计入上述驻留画布预算，不能据此推断整个进程的内存上限。

## YouTube 音频与字幕阅读

- 实验性音频切片使用实际媒体起止时间，修复倍速播放字幕区间错误；暂停和变速结束当前连续片段，跳转废弃跨位置片段并取消旧请求。
- 停止听译释放计时器、媒体监听与捕获轨道；导出字幕保留实际时间和跳转间隔。仍是约 7 秒一片、加模型响应时间的切片听译，不是流式语音。
- 时间轴支持手动阅读：滚轮、触摸、拖动和键盘操作后暂停自动跟随，避免下一句播放把列表拉走；点击“返回当前句”恢复跟随，搜索和全量导出保持可用。

## 长文档阅读与功能说明

- 非 PDF 文档正文、左侧原文大纲和目录分别最多显示一组 100 项，支持翻组、组号回车跳转和远端目录定位；搜索增加 180 ms 去抖。
- 全宽纯译文、章节选择与单段重译继续可用。阅读窗口不裁剪文档数据，HTML/打印及其他导出仍基于全文；全量导出会临时生成完整内容，不承诺导出阶段恒定内存。
- 统一 README、工作台、字幕入口及商店说明：按协议和模型能力区分文本/视觉/音频，明确版式与译图效果边界，去除结构化输出“100% 合法”等承诺。

## 安装与升级

下载 `qingjian-translator-v1.0.12.zip` 并解压，在 Chrome / Edge 扩展管理页开启开发者模式，选择“加载已解压的扩展程序”。已有用户更新原扩展目录后点击“重新加载”，无需卸载或清空配置。

请先导出正在处理的文档，再重新加载扩展；随后刷新已有网页和 YouTube 标签页。Release 附同名 `.zip.sha256` 校验文件。没有提交 Chrome Web Store 审核。

回归均使用合成文档、受控媒体和本地模拟模型接口，不代表已经验证所有在线 YouTube 变体或真实模型翻译质量。具体验收见 [v1.0.12 发布验收](docs/verification/v1.0.12.md)。

## 1.0.11 — 2026-10-30

### 下载与解压总预算

- 单次文档导入共用 90 秒总时限，覆盖在线下载、本地读取、EPUB 解压/解析及 PDF 初次打开；阶段切换不重新计时。
- 输入上限 100 MiB，实际流读取持续计数；EPUB 单项解压上限 32 MiB、累计 256 MiB、最多 10000 项，展开字节不得超过 `max(1 MiB, 压缩字节 × 200)`。
- 自定义 PDF 本地 Flate 文本提取也接入实际解压预算；ZIP 增加目录边界、重叠、实际大小和 CRC 校验。
- 超时、超限、切换文档及关闭页面会停止对应读取；不再通过原生 PDF embed 自动重新下载而绕过预算。
- 修复 PDF 打开操作在超时后才返回成功时的 worker 清理，避免迟到结果遗留资源。

### 长 PDF 资源回收

- 左栏最多保留 6 页预览，并发渲染最多 2 页；离屏释放 canvas、JPEG/base64、图片及渲染文本引用，保留占位高度。
- 渲染缓存以 8 页为回收目标，正在翻译的画布临时保护，使用结束再回收；回看或跳页从原 PDF 重绘，不重新调用模型。
- 文档替换和退出清理队列、在途渲染、原 PDF buffer 与对象 URL，旧结果不再恢复已清除预览。
- 保留已译正文和译图，预览回收不影响阅读内容及导出完整性。

### 长字幕时间轴虚拟化

- 时间轴仅挂载可见区域及附近字幕，最多 40 行；动态测量原文、译文及窗口宽度变化，长句不截断。
- 支持完整数据搜索、当前句高亮与跳转；导出仍包含全部已加载字幕，不受可视窗口或搜索过滤影响。
- 关闭侧栏、切换视频及页面退出时释放窗口、观察器和测量缓存；重新打开可恢复查看。

### 升级与使用边界

- 下载 `qingjian-translator-v1.0.11.zip` 并解压，在 Chrome / Edge 扩展管理页开启开发者模式，选择“加载已解压的扩展程序”。已有用户可更新原扩展目录并点击“重新加载”，无需卸载或清除配置。
- 升级后刷新已有网页，尤其是 YouTube 标签页；完成或导出正在处理的文档后再重新加载扩展。
- 文档导入预算独立于模型请求预算；同步解析只能在调用前后检查时限，PDF.js 内部解码不属于 EPUB/本地 Flate 解压额度。
- 已译正文、译图、原 PDF 和完整字幕数据仍按内容保留；本版限制可重建预览与字幕 DOM，不承诺进程整体内存恒定。

详细验证见 [v1.0.11 发布验收](docs/verification/v1.0.11.md) 与 [资源优化验收](docs/verification/2026-10-30-document-resources.md)。

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
