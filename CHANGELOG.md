# Changelog

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
