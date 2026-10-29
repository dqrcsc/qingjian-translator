# v1.0.9 Reading Integrity Implementation Plan

**Goal:** Fix the seven defects confirmed in the 2026-10-30 v1.0.8 audit, add full-width translation reading, verify real extension entry points and publish v1.0.9 with a ZIP and Chinese release notes.

**Architecture:** Keep the existing MV3, background request and Studio model. Scope paragraph state to translated source segments; preserve link semantics. Gate document actions on successful parsing, propagate explicit PDF retranslation intent, and generate complete HTML independently of current search/chapter view. Add a third Studio view that hides the left source pane and right originals without losing untranslated content.

**Tech Stack:** Native JavaScript/CSS, Node tests, Playwright Chromium, existing PDF.js 6.4.299.

**Spec:** User-approved audit at `/Users/dqrcsc/codex/github_research/reports/qingjian-v1.0.8-audit-2026-10-30/README.md` and explicit request to fix/publish v1.0.9.

## Constraints
- No new runtime dependencies, broad refactoring, paid model calls, or bulk deletion.
- Preserve source DOM, original links, model cancellation and document identity protections.
- Bilingual/translation-only existing selections remain compatible; full-width is a separate explicit mode.
- Source text remains readable until a valid translation exists. Failed imports cannot translate/export.
- Local checks, complete browser suite, package verification and commit-specific GitHub CI must pass before public release.

## Task 1: Web translation completeness and keyboard semantics
Files: `content/content-main.js`, `content/content.css`, `tests/content-lifecycle.test.mjs`, focused new tests/browser verifier.
- [ ] Reproduce partial multi-segment hiding and identical-result behavior with real manifest injection.
- [ ] Associate hiding with source segment completion, leaving pending/failed/skipped segments visible.
- [ ] Preserve clickable safe links in translation-only mode and original DOM on restoration.
- [ ] Defer Alt-only action until keyup when no combination occurred; retain Alt-hover usability.
- [ ] Test delayed/failed segments, retry, styles/restoration, links, Alt-only and Alt+A/S.

## Task 2: Studio readiness, PDF retranslations and Markdown integrity
Files: `studio/studio.js`, related Node tests.
- [ ] Add loading/ready/error state and guard handlers as well as buttons; late imports retain existing session checks.
- [ ] Pass `bypassCache` through forced PDF page and figure-text batches; continuation preserves cache behavior.
- [ ] Update PDF completion button from current progress, including lazy completion.
- [ ] Preserve EOF code fences in Markdown parser.
- [ ] Verify delayed file/PDF parsing, failed import, full/page retranslations and ordinary continuation.

## Task 3: Complete exports and full-width reading
Files: `studio/studio.js`, `studio/studio.html`, `studio/studio.css`, related Node/browser tests.
- [ ] Export complete HTML from document state independently of search, chapter and selected layout; restore view after preparation.
- [ ] Add bilingual, right-only translation and full-width translation modes; normalize pure translation for MD/EPUB/PDF export.
- [ ] Mark untranslated fallback text visibly rather than hiding it; preserve search, layout and document replacement behavior.
- [ ] Verify actual downloaded HTML contains all source/translation blocks and that layout mode is restored.

## Task 4: Integration and release
Files: `scripts/verify-browser.mjs`, new browser modules, `README.md`, `CHANGELOG.md`, `CHROMEWEBSTORE.md`, `docs/releases/v1.0.9.zh-CN.md`, `docs/verification/v1.0.9.md`, version JSON files.
- [ ] Independently review fixes against all seven original reproductions.
- [ ] Run `npm run pack` and `npm run test:browser`; validate exact ZIP contents and SHA-256.
- [ ] Synchronize version 1.0.9 and Chinese documentation with actual behavior and limitations.
- [ ] Commit scoped implementation and release changes, create annotated tag, push main/tag.
- [ ] Wait for commit-specific main/tag CI; publish Release with ZIP and Chinese notes, verify public asset digest and tag target.
