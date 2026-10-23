# v1.0.7 reliability implementation plan

**Goal:** Repair the nine confirmed v1.0.6 findings, add real-entry/browser/native Gemini regression coverage, then publish the authorized v1.0.7 ZIP and Chinese release notes.

**Architecture:** Keep MV3 and existing request scopes. Restrict studio exposure, preserve stable document block identity, stop repeated failures, bound auxiliary waits, tie asynchronous settings results to their original provider, invalidate images by source, and report storage failures truthfully.

**Tech stack:** JavaScript modules, Node test runner, Playwright Chromium, local HTTP model fixtures.

**Spec:** The user's approved nine-finding analysis in `../qingjian-translator-review-v106/analysis.zh-CN.md` and this conversation. The user explicitly authorized implementation, GitHub push and v1.0.7 release.

## Constraints and validation

- No new runtime dependency, unrelated refactoring, bulk deletion, or real model credentials.
- Existing 47 structural checks, 54 Node tests and 13 browser groups must keep passing.
- New failure regressions use original entry points and controlled local dependencies; security and content/UI races require actual browser assertions.
- Release only after package validation and remote CI. Preserve all existing public tags.

## Task 1: P1 studio exposure and block identity; P2 retranslation errors

Files: manifest.json, studio/studio.js, scripts/verify-studio-browser.mjs.
- [x] Test external iframe/top navigation produces zero model calls; extension-controlled opening remains valid.
- [x] Remove studio from web-accessible resources. Keep normal background tabs.create opening.
- [x] Allocate monotonic numeric block IDs, never renumber existing blocks on insertion/page merge; resolve results only for still-current block ownership.
- [x] Test a held ALPHA/BETA batch with concurrent image insertion: each source retains its own translation, including export.
- [x] Handle retranslation failure/cancellation and overlapping attempts, retaining previous translation and restoring controls.
- [x] Real browser tests exercise actual controls and delayed/401 local responses.

## Task 2: P2 subtitle failure control and image lifecycle

Files: content/content-main.js, tests/content-lifecycle.test.mjs, scripts/verify-content-browser.mjs.
- [x] Test 401 cue/live-caption failure stops automatic requests for both playback and pause; transient failures have finite attempts and backoff.
- [x] Persist a session failure state, show actionable error, reset on explicit restart/settings change; stale video responses cannot poison the new session.
- [x] Test same-node src/srcset changes, including during a request, invalidate old image results and controls.
- [x] Track image source ownership and handle source/load changes independently of paragraph translation activation.
- [x] Clear hover ownership flags when controls are released; test disable then re-hover recreates exactly one working control.

## Task 3: P2 background/storage/settings and native Gemini

Files: shared/storage.js, background/gemini-client.js, background/cache-db.js, background/service-worker.js, options/options.js, tests/*.test.mjs, scripts/verify-settings-browser.mjs.
- [x] Reproduce statistics-read stall through actual request Port. Make auxiliary statistics waits abortable and ensure the serialized chain recovers without late read committing obsolete data.
- [x] Test switching A to B while A model fetch is delayed. Return fetched models without unconditional background settings mutation; settings UI validates originating provider/config generation before committing.
- [x] Test IDB open/transaction failure produces unavailable counts/partial clear, with actual settings UI not displaying false success.
- [x] Add Gemini native text, multimodal, thought filtering, missing subset, empty/blocked/truncated response fixtures through real client/dispatch; fail malformed responses instead of accepting them as translations.

## Task 4: integration and release

Files: browser orchestrator, manifest/package/lock versions, README, CHANGELOG, docs/releases/v1.0.7.zh-CN.md, docs/verification/v1.0.7.md.
- [x] Integrate isolated browser suites; inspect scoped diff and run `npm run pack` and `npm run test:browser`.
- [x] Record exact test counts and material limitations; synchronize version to 1.0.7 and prepare Chinese release notes.
- [ ] Commit scoped changes, push without force, verify GitHub Actions, create annotated v1.0.7 tag and Release with validated ZIP.
- [ ] Verify published tag target, release body and asset checksum/download metadata.

Local acceptance completed: 47 structural checks, 80 Node tests, 37 browser groups and 234 ZIP files. Remote publication is the final delivery step after this committed plan.
