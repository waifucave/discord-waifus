# Third-Party Notices

Discord Waifus (`@waifucave/discord-waifus`) is licensed under the MIT
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

## EFF Short Wordlist 1

- Copyright: Electronic Frontier Foundation
- License: Creative Commons Attribution 4.0 International
- Source: https://www.eff.org/files/2016/09/08/eff_short_wordlist_1.txt
- License terms: https://creativecommons.org/licenses/by/4.0/
- EFF copyright policy: https://www.eff.org/copyright

`contracts/wordlists/sas-v1.txt` is an adaptation used for the pairing safety-number display. It
removes 272 entries from EFF Short Wordlist 1 and assigns new zero-based indices to the remaining
1,024 words while retaining their source order. EFF does not endorse this adaptation. The exact
source and derived hashes, selection rules, and change policy are documented in
`contracts/wordlists/README.md`.
