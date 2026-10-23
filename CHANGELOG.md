# Changelog

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
