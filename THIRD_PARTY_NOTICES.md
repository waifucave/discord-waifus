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

## node-qrcode

- Copyright: 2012 Ryan Day
- License: MIT
- Source: https://github.com/soldair/node-qrcode

`qrcode` is bundled into the dashboard to generate pairing QR codes entirely in
the browser. Its MIT license is reproduced below:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is furnished
> to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

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
