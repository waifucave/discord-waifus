# Discord Waifus OCR Linux x64 glibc

Platform package for the Discord Waifus bundled OCR runtime.

This package is installed as an optional dependency by `@starlight-ai/discord-waifus` on matching Linux x64 glibc hosts. It is expected to contain a package-local `tesseract` executable, its runtime libraries, and `eng.traineddata`; the main app resolves these paths through `ocr-manifest.json` and never relies on a global Tesseract install.
