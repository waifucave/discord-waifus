# Third-Party Notices

Discord Waifus (`@starlight-ai/discord-waifus`) is licensed under the MIT
License. It bundles and depends on the following third-party components for its
optional image-text (OCR) feature.

## tesseract.js and tesseract.js-core

- License: Apache License 2.0
- Source: https://github.com/naptha/tesseract.js

`tesseract.js-core` is a WebAssembly build that embeds:

- **Tesseract OCR** — Apache License 2.0 — https://github.com/tesseract-ocr/tesseract
- **Leptonica** — BSD-2-Clause-like license — https://github.com/DanBloomberg/leptonica

## English trained data (`assets/ocr/eng.traineddata`)

- License: Apache License 2.0
- Source: https://github.com/tesseract-ocr/tessdata

The bundled model lets OCR run fully offline, without downloading language data
at runtime.

Each component is distributed under its own license; the full license texts are
available at the source URLs above.
