# PDF engine upgrade and end-to-end cancellation

Scope: replace vendored PDF.js with the official pinned 6.4.299 distribution and make translation cancellation reach queued and active background work. Keep the existing UI and translation result shapes.

Design:
- Bundle ES module/worker and required CMaps, fonts, WASM and license files, record npm SHA-512 and per-file SHA-256. Use modern loading/render task promises and real workers; disable JS evaluation and load assets locally.
- Use one runtime Port per frontend scope with request IDs for response routing. Disconnect aborts all controllers in that scope in one worker event, preventing queue-admission races between separate disconnect events. Disconnect means cancellation; the browser disconnects ports when their document disappears. Frontend scopes cancel related ports on pause, document/video/track replacement and audio stop. No cross-tab cancellation identifier is exposed.
- An AbortController lives in the service worker for each port. Abort removes a queued semaphore entry and reaches model calls, retry delays and image downloads. Check the signal before caching a result. Retain generation checks to discard responses that won a cancellation race.
- Abort document fetch/loading/render tasks too; destroy the replaced PDF document and release its object URL.

Acceptance:
- Node regressions: queued/active cancellation, no retry/cache after cancellation, subsequent tasks can run, request ownership isolation, client port lifecycle.
- Real Chromium extension test: load/parse/render fixture PDFs with a worker under MV3 CSP, verify text/coordinates and non-white pixels, check bundled assets; cancel a running and queued request against a local HTTP server and confirm the socket closes without sending queued work.
- Run package verification, review changes, push without force and confirm remote HEAD.

Boundary: aborting the client connection cannot guarantee an external provider stops computation or reverses charges. Tests use local fixtures and a local mock API, not paid model calls.
