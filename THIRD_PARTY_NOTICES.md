# Third-party software

QingJian's own code is licensed under the MIT license in `LICENSE`.

## Mozilla PDF.js

- Files: `studio/vendor/pdf.js` and `studio/vendor/pdf_worker.js`.
- Embedded version: **1.9.426**, build **2558a58d**.
- Copyright 2017 Mozilla Foundation; original notices remain in the bundled files.
- Project: https://github.com/mozilla/pdf.js
- License: Apache License 2.0; full text is included in `licenses/Apache-2.0.txt`.

These vendor files predate QingJian v1.0.2 and are unchanged by that release.
The original vendoring commit does not record a reproducible download/build procedure;
the version above comes from the embedded metadata, not an independently verified
match to an upstream release artifact. A future PDF.js upgrade needs browser,
worker and document-rendering compatibility checks; v1.0.2 does not claim to
complete that upgrade or a dependency security audit.
