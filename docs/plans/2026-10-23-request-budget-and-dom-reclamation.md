# Request budget and long-page resource reclamation

User authorized implementing the remaining review optimizations and pushing after validation. Keep MV3, existing request ports, atomic scope cancellation and batch result contracts. No new runtime dependency or release/tag requested.

## Design

Each background model request owns one deadline controller starting at receipt. Default 90 seconds, configurable 30–300 seconds in settings. Queue wait, storage/cache access, downloads, body reading, network retry/backoff, compatibility fallback and missing-subset repair share that signal. Per-attempt timeout remains 45 seconds. A budget timeout is an explicit retryable UI failure, not silent user cancellation. Keep the exact same controller in the port scope map and queue to preserve removal-before-abort ordering. A Promise race bounds the response even if an auxiliary storage operation stalls; cooperative checks prevent subsequent requests and late model results from reaching cache/UI. Local storage writes already started before expiry may finish; no cross-storage rollback is promised.

Release paragraph records as rendering settles. On DOM removals, unobserve detached paragraphs/images, discard queued detached paragraphs, invalidate image ownership, release image controls even when their host remains connected, and clear hover/context-menu references. Check current connectivity so synchronous DOM moves are preserved. Batch mutation scans with a bounded root set and a cancellable timer, avoiding indefinite RAF retention on background tabs. Existing active mixed HTTP batches may finish, but detached elements cannot receive results; total budgets bound their lifetime.

Alternatives: per-attempt limits cannot bound nested retries; cancelling a whole page for each removal would interrupt unrelated live content; repeated full-document polling would add unnecessary work. Use the existing scope and MutationObserver boundaries.

## Tasks and acceptance

- [x] `shared/request-budget.js`, `background/service-worker.js`: deadline controller, duration normalization, configuration relative to original start, response race/disposal and distinct timeout error. Tests: queue expiration sends no API request; backoff/subset/fallback share time; timeout responds once; user scope cancellation remains atomic; model results arriving after expiry cannot populate cache.
- [x] `shared/constants.js`, `options/options.html`, `options/options.js`: default 90s, numeric settings input with 30–300s clamp and precise help text. Test default/invalid/boundary values and persistence.
- [x] `content/content-main.js`: settle/delete records, detached node observer/queue/reference cleanup, bounded mutation-root timer, disabled/disconnected guards. Tests: completed maps empty, removal before flush, active result after removal, synchronous move, reinsertion, failed retry, disable clears retained work.
- [x] `scripts/verify-content-browser.mjs`: real page repeated append/remove cycles, native observer unregistration and no late DOM commits; exercise timeout recovery via actual background port with controlled timer acceleration (no production test hooks).
- [x] Run `npm run pack`, `npm run test:browser`, review diff, record counts and retained-resource measurements.

Verification measures extension-owned strong references and observers, not a universal heap-memory guarantee. Browser tests use local HTTP fixtures; no production credentials or paid model calls. Document any timeout-vs-provider-computation boundary.

## Delivery

Push the verified commit to origin/main without force, then confirm its GitHub Actions result. The final task response records the actual commit and CI run.
