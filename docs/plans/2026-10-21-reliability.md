# v1.0.2 reliability implementation plan

Goal: fix the reproducible translation, cache, async-session and export failures diagnosed against v1.0.1, then verify and push the release commit.

Design approved by the user's request to implement the preceding diagnosis. Keep the existing MV3/vanilla JavaScript architecture. Reject an invalid batch explicitly rather than inventing successful translations. Retry missing IDs once; cache only a completely validated batch. Use session identity checks at async write boundaries. Buffer API responses inside the timeout window because all current model requests are non-streaming. Rebuild EPUB chapter/navigation metadata without claiming original-resource preservation.

Alternatives considered: per-item result states would require changing every consumer and are unnecessary for the immediate correctness fix; a framework/backend rewrite adds unrelated risk. The chosen design keeps existing success/error message shapes.

## Tasks and acceptance

- [x] `background/gemini-client.js`, `background/service-worker.js`: strict integer IDs, reject duplicates/unknown IDs, retry missing subsets once, reject empty/unresolved results and damaged placeholders. Regression tests must prove no wrong-ID fallback or failed-result caching.
- [x] `background/cache-db.js`: versioned provider/protocol/endpoint/context key signatures; bounded memory insertion for both disk reads and writes. Tests: context isolation, old-key invalidation, 2501 cold reads stay at 2500.
- [x] `background/gemini-client.js`: header+body timeout, transient retry, caller cancellation, safe upstream error parsing. Tests: delayed headers/body, 401, 503, cancellation; preserve existing non-streaming callers.
- [x] `content/content-main.js`, `studio/studio.js`: video/document generations, stale async callbacks discarded, stop/session changes suppress audio results, unsupported audio rejected before capture. Tests execute original callbacks with delayed results and switched sessions.
- [x] `studio/epub-engine.js`: chapter files, navigation, modified metadata, target language; retain text-only export scope. Tests inspect generated ZIP and XML resources.
- [x] `scripts/pack-release.mjs`, licenses and docs: ship license materials, document vendor provenance limitations, align privacy/capability claims and v1.0.2 release notes. Verify packaged entries and version consistency.
- [x] Run existing verify + regression suite + package inspection and review diff.

Delivery: commit and push `main` without force, then confirm remote commit equals local HEAD. The Git history and delivery message serve as the push receipt.

Validation: `npm run pack` passed 43 existing checks, 22 regression tests and exact-content inspection of 30 ZIP entries.

No real API keys or paid requests are required. Browser/model/visual compatibility remains a separate manual acceptance boundary and must be stated in the release notes.
