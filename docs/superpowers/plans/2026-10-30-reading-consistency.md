# Reading Consistency Implementation Plan

> Agentic execution: independent module work is delegated; root integrates and reviews each result. Optional superpowers execution sub-skills are not installed in this environment; use existing agent and test tools.

**Goal:** Fix F2–F7 from the v1.0.9 audit without broad refactoring or publishing a new release.
**Architecture:** Preserve MV3 content/MAIN bridge separation and current Studio blocks. Bind subtitle work to navigation/configuration identity; separate observed live cues from complete tracks. Extract EPUB structures in source order without duplicating descendants.
**Tech Stack:** Native JS/CSS, Node tests, Playwright Chromium, existing ZIP/EPUB implementation.
**Spec:** `docs/plans/2026-10-30-reading-consistency-design.md` and user-approved audit `/Users/dqrcsc/codex/github_research/reports/qingjian-v1.0.9-audit-2026-10-30/README.md`.

## Constraints
- No new dependencies, bulk deletion, version changes or external publishing.
- Changes remain within the identified modules and associated tests/docs.
- Actual UI/HTTP/download assertions supplement original-function Node tests.

## Task 1 — Bridge identity and track selection
Files: content/youtube-page-bridge.js; tests/youtube-bridge.test.mjs; scripts/verify-youtube-bridge-browser.mjs.
- [x] Reproduce deferred A fetch returning after B, A→B→A, XHR load, and Japanese ASR plus English manual track.
- [x] Bind `{videoId, generation}` at initiation; check before dispatch, invalidate on navigation; choose source ASR before unrelated manual tracks. Preserve explicit user choice.
- [x] Run focused tests; expose `verifyYoutubeBridgeBrowser(context, sw)` returning `{checks, errors}` for root integration.

## Task 2 — EPUB text integrity
Files: studio/epub-engine.js; tests/epub-integrity.test.mjs; scripts/verify-epub-integrity-browser.mjs.
- [x] Use a real ZIP fixture with prose, nested list/blockquote, short text, pre/code, table and figcaption; verify each sentinel occurs once and code spacing remains.
- [x] Traverse semantic block containers in document order; emit direct text around child blocks; preserve code and retain table cells/row boundaries as text.
- [x] Export code as escaped pre/code; preserve chapter ordering and existing exports. Expose `verifyEpubIntegrityBrowser(context, sw)` returning `{checks, errors}`.

## Task 3 — Settings and observed live subtitle records
Files: content/content-main.js; tests/youtube-state.test.mjs; scripts/verify-content-browser.mjs; scripts/verify-youtube-state-browser.mjs.
- [x] Cold-start test: saved auto=false yields no model request; sidebar=true mounts. Setting changes toggle UI; stale configuration results cannot commit.
- [x] Bootstrap via `loadSettings().then(initYoutubeIntegration)`; explicit change handlers separate preferences from request identity.
- [x] Invalidate completed translations only when model/target/glossary configuration changes; ordinary retry preserves good output.
- [x] Keep observed live records separate from ytCues; deduplicate continuous text, record actual observed playback times, render/search/export selected source, disclose incomplete coverage.
- [x] Test live export, paused playback, seek/revisit, configuration changes and video replacement; keep existing cancellation/error tests.

## Task 4 — Integrate, documentation and verify
Files: scripts/verify-browser.mjs; README.md; docs/verification/2026-10-30-reading-consistency.md.
- [x] Integrate all browser modules, review diffs against the design and audit.
- [x] Correct 60fps/350ms/forced-original-track claims; explain observed-only export, code/table fallback and deferred resource limits.
- [x] Run `npm run verify` and full `npm run test:browser`; verify syntax/diff. Commit local scoped changes after passing, report exact evidence and remaining boundaries.
