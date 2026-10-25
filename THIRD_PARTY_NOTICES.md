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

## Her own computer (Living cast: Bash, Read and image tools)

These npm dependencies are installed with the app (pinned exactly in `package.json`); each is
distributed under its own license, available at its source URL.

- **just-bash** 3.6.0 — Apache License 2.0 — https://github.com/vercel-labs/just-bash. The simulated
  shell behind the waifus' `Bash` tool. It ships a WebAssembly build of **CPython** 3.13 (Python
  Software Foundation License Version 2 — https://docs.python.org/3/license.html) used for
  `python3`.
- **unpdf** 1.8.1 — MIT — https://github.com/unjs/unpdf. Bundles Mozilla **PDF.js** (Apache License
  2.0 — https://github.com/mozilla/pdf.js); used to read PDF text.
- **jpeg-js** 0.4.4 — BSD-3-Clause — https://github.com/jpeg-js/jpeg-js (JPEG decode and encode).
- **omggif** 1.0.10 — MIT — https://github.com/deanm/omggif (GIF decode and encode).
- **@stacksjs/ts-webp** 0.1.6 — MIT — https://github.com/stacksjs/ts-webp (WebP decode and encode).

just-bash also brings these with it. npm installs them although the app never runs them: the
waifus' Bash leaves out `sqlite3`, `tar` and `js-exec`, the only commands that use them, and npm
cannot skip one package's optional dependencies without skipping the app's own (the Remote Access
helpers are optional dependencies too).

- **sql.js** 1.15.1 — MIT — https://github.com/sql-js/sql.js (SQLite compiled to WebAssembly; behind
  just-bash's `sqlite3`).
- **@mongodb-js/zstd** 7.0.0 — Apache License 2.0 — https://github.com/mongodb-js/zstd (optional
  native addon; its install script fetches a prebuilt binary with `prebuild-install`; behind `tar`'s
  zstd mode). If it fails to install, nothing in the app changes.
- **node-liblzma** 2.2.0 — LGPL-3.0 — https://github.com/oorabona/node-liblzma (optional native addon,
  loaded with `node-gyp-build`; behind `tar`'s xz mode). Dynamically linked and unmodified; if it
  fails to install, nothing in the app changes.
- **typescript** 6.0.3 — Apache License 2.0 — https://github.com/microsoft/TypeScript (a runtime
  dependency of just-bash for its `js-exec` command).
