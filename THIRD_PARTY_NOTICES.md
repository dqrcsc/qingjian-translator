# Third-party software

QingJian's own code is licensed under the MIT license in `LICENSE`.

## Mozilla PDF.js 6.4.299

The official **legacy ES module** distribution with the local cancellation patch described below is bundled in `studio/vendor/pdfjs/`, including `pdf.mjs`, `pdf.worker.mjs`, CMaps, standard fonts, ICC profiles and image-decoder WASM/fallback resources. The PDF scripting sandbox and QuickJS evaluator are not included or enabled.

- Project/release: https://github.com/mozilla/pdf.js/releases/tag/v6.4.299
- npm artifact: https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz
- npm integrity: `sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==`
- Copyright Mozilla Foundation and contributors; upstream copyright headers are retained.
- PDF.js license: Apache-2.0 (`studio/vendor/pdfjs/LICENSE` and `licenses/Apache-2.0.txt`).
- Resource licenses: `cmaps/LICENSE`, `standard_fonts/LICENSE_FOXIT`, `standard_fonts/LICENSE_LIBERATION`, `iccs/LICENSE`, and the `wasm/LICENSE_*` files under `studio/vendor/pdfjs/`. These upstream notices are included in release ZIPs too.

`studio/vendor/pdfjs/provenance.json` records each file's upstream path and SHA-256. `scripts/vendor-pdfjs.mjs` verifies the fixed tarball SHA-512 before extracting the selected files; it does not run package install scripts. It applies `scripts/pdfjs-stream-patch.mjs` to both ES modules: acknowledge a late CANCEL after the stream producer has already closed, so `reader.cancel()` settles and releases its resource lease. This local change is marked in both files; upstream and patched SHA-256 values are recorded separately. The patch fails closed if its exact source context changes, and tests exercise the real bundled handlers and verify the original hashes after reversing the patch. See the script header for the reproduction commands. Tests verify every recorded file hash.

Runtime configuration uses an explicit local module worker, local resource URLs and `isEvalSupported: false`. MV3 CSP permits local WASM compilation (`wasm-unsafe-eval`) but does not permit JavaScript `unsafe-eval`, remote scripts or Blob workers. Actual CSP behavior and rendering are tested by `npm run test:browser`; the presence of guarded evaluation helpers in upstream code is not treated as an executed code path.

For the next upgrade, update the fixed version/integrity, regenerate and review the file inventory, run Node plus real-browser tests, and inspect a release ZIP. This release replaces the former modified PDF.js 1.9.426 bundle.

## Development-only dependency

Playwright is pinned in `package-lock.json` for reproducible Chromium acceptance tests. It is not included in the extension ZIP or used by installed extensions.
