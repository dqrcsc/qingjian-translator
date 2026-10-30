# 文档资源与长字幕优化验收

日期：2026-10-30。基线：v1.0.10 发布提交 8d5c303。此次为 main 开发版优化，版本号保持 1.0.10，不修改既有 Release。

## 输入与解压预算

新增 `studio/document-budget.js`，文档导入与后台模型请求预算分离。一次导入从下载/本地读取开始，90 秒共用到 EPUB 解压/解析或 PDF 初次打开与预览；阶段切换不重置。切换文档、页面退出均联动取消。超限不会自动使用原生 embed 重新下载。

| 限制 | 默认值与执行点 |
| --- | --- |
| 输入 | 100 MiB；Content-Length/File.size 用于提前拒绝，流读取实际字节持续计数 |
| 解压单项 | 32 MiB；实际输出超限立即取消读取 |
| 累计解压 | 256 MiB；所有读取的成员/Flate 流共用，多次读取计入实际工作量 |
| 压缩比 | 展开字节不得超过 max(1 MiB, 压缩字节 × 200) |
| ZIP 项数 | 最多 10000 项；并校验目录边界、重叠、声明/实际大小与 CRC |
| 超时/取消 | TimeoutError、DocumentLimitError、主动取消分别传播；流 reader 解锁，不等待不受控 cancel Promise |

EPUB 和自定义 PDF 本地 Flate 文本提取使用同一解压机制。PDF.js worker 内部解码不属于这些解压配额。同步 DOMParser/CRC/文本处理只能在调用前后或迭代边界检查时限，不宣称强行抢占同步计算。压缩输入、输出分块和拼接缓冲可能短暂共存，字节限额不等于进程 RSS 上限。

验证包含：停滞响应体、分阶段慢响应、声明超限、实际字节超声明、单项/累计/压缩比限制、错误流/永不结束的取消、ZIP 越界/CRC/重复头、解压中取消、替换导入、页面关闭。补测 PDF 打开晚于导入超时才成功的资源归属：旧 worker 必须销毁，不能只把界面设为 error。

## 长 PDF 预览回收

- 左栏最多 6 页预览，离屏移除 IMG 数据引用，保持比例占位；滚回或跳页按需从原 PDF 重绘。
- 共享渲染并发最多 2；可回收缓存以 8 页为目标。翻译期间画布受保护，若与可视页重叠不足可能临时超目标，使用结束再回收。该取舍避免回收正在被译图使用的画布。
- 淘汰清理 canvas 尺寸/引用、JPEG/data URL/base64 与文本渲染数组；文档替换/退出还清理队列、在途任务、原 PDF buffer 和对象 URL。
- 已译文本/译图、完整原 PDF、PDF.js 内部数据及轻量页占位不因预览淘汰而删除。此项不把整个工作台宣称为恒定内存。

实际 30 页浏览器文件导入/滚动场景中，通过 DOM 和 CDP 对象查询观察到：预览 IMG ≤6、渲染记录/画布 ≤8、active ≤2、queue ≤6。回看像素与首次一致且 0 模型请求；淘汰预览后真实 HTML 下载保留译文；替换文档后旧 IMG/native src 不复活。这里是具体场景测量，非虚构堆内存 MB 测量。

## 字幕时间轴虚拟化

- 保留完整 cues，仅挂载可视区域与 overscan，最多 40 个字幕行；上下占位保留滚动范围。
- 动态测量原文/译文行高，ResizeObserver 处理译文及宽度变化；长句不截断。
- 搜索、当前句高亮、点击 seek 仍按完整数据；导出不依赖当前 DOM 窗口或搜索结果。
- 关闭侧栏、换视频及 pagehide 释放窗口、监听器、观察器和测量缓存。

同一 5000 条字幕 fixture：v1.0.10 原代码挂载 5000 行；新代码 ≤40 行。实际浏览器覆盖首尾大幅滚动、搜索第 4321 条/seek、搜索中导出仍有 5000 条、超长字幕/动态译文/resize、关闭重开和导航。Node 另覆盖 10000 条范围选择。

完整字幕数据及行高元数据仍随字幕条数增长；只限制 DOM 数量，不宣称所有字幕内存恒定。此前实时观察记录最近 1000 条上限保持不变。

## 测试与复现

新增：
- `tests/document-budget.test.mjs`、`tests/epub-budget.test.mjs`、`tests/pdf-import-budget.test.mjs`
- `tests/pdf-preview-resources.test.mjs`、`tests/youtube-timeline.test.mjs`
- `scripts/verify-document-budget-browser.mjs`、`scripts/verify-pdf-resources-browser.mjs`、`scripts/verify-youtube-timeline-browser.mjs`
- 既有文档导入测试改为真实流读取控制，保留解析中操作禁用和旧读取结果隔离；旧函数提取测试补齐新的资源/预算依赖，未删除已有断言。

最终结果：`npm run pack` 通过 47 项结构/行为检查、150 项 Node 测试和 235 个 ZIP 运行文件逐字节校验；最终代码完整浏览器回归 93 组通过，`errors=[]`，Chromium 148.0.7778.96；`git diff --check` 通过。所有网络模型场景使用本地 fixture，不消耗付费模型配额。

```sh
npm run pack
CHROMIUM_EXECUTABLE='/Users/dqrcsc/Library/Caches/ms-playwright/chromium-1223/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' npm run test:browser
git diff --check
```

本地浏览器机器可读结果：`dist/browser-verification/results.json`。打包仅用于运行文件一致性验证，生成的开发 ZIP 不替换 GitHub 已发布 v1.0.10 资产。远端验证以本次 main 提交对应的 GitHub Actions 为准。
