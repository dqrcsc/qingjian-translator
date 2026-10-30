# Document Resources Implementation Plan

> Agentic execution: independent EPUB/budget, PDF preview and subtitle tasks use subagents; root integrates import lifecycle, reviews changes and runs the full suite. Optional superpowers execution skills are unavailable; use existing tools.

**Goal:** Bound document input work, reclaim long PDF previews and virtualize long subtitle timelines, then verify and push.
**Architecture:** Shared import budget propagated through streaming reads; separate reconstruction-friendly preview lifecycle; subtitle virtual DOM backed by complete cue data.
**Tech Stack:** Native JS/streams, existing PDF.js, Node tests, Playwright MV3 extension fixtures.
**Spec:** docs/plans/2026-10-30-document-resource-design.md

## Constraints
No new dependencies, no version/release, no bulk deletion, no loss of translated/exported content. User explicitly authorized implementation and push. Agents own disjoint files or named studio.js regions; root owns integration.

## Task 1 — Input budget and EPUB
- [x] Create studio/document-budget.js with createDocumentBudget({signal,timeoutMs,maxInputBytes,maxEntryBytes,maxExpandedBytes,maxEntries,maxCompressionRatio}) and readBoundedResponse/readBoundedFile helpers; expose budget.signal, wait(promise), check(), dispose(), actual expansion accounting.
- [x] Write tests/document-budget.test.mjs and tests/epub-budget.test.mjs: stalled body, header omission/lying length, deadline shared across stages, cancellation, actual expansion beyond declared ZIP size, multiple-entry total, truncation, normal archives.
- [x] Update studio/epub-engine.js readZipArchive/parseEpubFile optional {budget,signal} with safe directory bounds and actual bounded decompression; no silent partial results.
- [x] Agent focused verification; root wires loadOnlinePdfFromUrl/handleFileLoaded to same import budget and prevents automatic unbounded embed on budget failure.

## Task 2 — PDF preview resources
- [x] Inspect getOrRenderPdfPage, ensureLeftPdfPageRendered, initLeftPdfScrollViewer, beginDocumentSession and translateSinglePdfPage ownership.
- [x] Add tests/pdf-preview-resources.test.mjs and scripts/verify-pdf-resources-browser.mjs: many pages, offscreen cleanup, exact restoration, pending render after switch, protected active translation, jump and export retention.
- [x] Implement bounded preview window/concurrency and complete render disposal in studio/studio.js PDF regions; preserve page geometry. Expose browser verifier async verifyPdfResourcesBrowser(context, sw) => {checks,errors}.

## Task 3 — Timeline virtualization
- [x] Test thousands of cues with variable heights, scroll/reverse, translation updates, distant search and seek, full export, sidebar/video reset.
- [x] Implement in content/content-main.js and content/content.css (optional focused helper with manifest linkage), scoped to timeline behavior; keep source data complete.
- [x] Add tests/youtube-timeline.test.mjs and scripts/verify-youtube-timeline-browser.mjs; expose verifyYoutubeTimelineBrowser(context, sw) => {checks,errors}.

## Task 4 — Integrate, verify and push
- [x] Add browser import budget actual-entry tests in scripts/verify-document-budget-browser.mjs, returning {checks,errors}; integrate new verifiers into scripts/verify-browser.mjs.
- [x] Review diffs, update README with exact limits/retention boundaries and docs/verification/2026-10-30-document-resources.md with measured counts.
- [x] Run npm run pack, npm run test:browser, git diff --check; fix failures and commit scoped changes.
- Delivery: push main without force and confirm GitHub Actions; final delivery receipt records the remote result. No tag or Release.
