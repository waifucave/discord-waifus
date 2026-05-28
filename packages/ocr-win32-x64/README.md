# Discord Waifus OCR Windows x64

Platform package for the Discord Waifus bundled OCR runtime.

This package is installed as an optional dependency by `@starlight-ai/discord-waifus` on matching Windows x64 hosts. It is expected to contain a package-local `tesseract.exe`, required DLLs, and `eng.traineddata`; the main app resolves these paths through `ocr-manifest.json` and never relies on a global Tesseract install.
