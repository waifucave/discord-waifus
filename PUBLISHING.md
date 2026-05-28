# Publishing

GitHub repository: https://github.com/HeavenllyDemon/Discord-Waifus

npm package: `@starlight-ai/discord-waifus`

npm package URL: https://www.npmjs.com/package/@starlight-ai/discord-waifus

npm registry: https://registry.npmjs.org

## 1.0.0 release flow

```sh
npm run typecheck
npm test
npm run build
npm pack
gh release create v1.0.0 ./starlight-ai-discord-waifus-1.0.0.tgz --title "Discord Waifus 1.0.0"
# The OCR Packages workflow attaches and publishes the platform OCR packages.
npm publish ./starlight-ai-discord-waifus-1.0.0.tgz --access public
```

The npm package owns the global `waifus` binary through `package.json#bin`.
Installing a newer version of the same package globally rewrites the existing
global `waifus` shim. If another package owns that binary, npm may require the
user to uninstall the conflicting package or use `--force`.

## OCR runtime packages

The root package declares platform OCR runtimes as optional dependencies:

- `@starlight-ai/discord-waifus-ocr-darwin-arm64`
- `@starlight-ai/discord-waifus-ocr-darwin-x64`
- `@starlight-ai/discord-waifus-ocr-win32-x64`
- `@starlight-ai/discord-waifus-ocr-linux-x64-gnu`

Each package must be published at the same version as the root package and must
contain a package-local Tesseract binary, required runtime libraries,
`share/tessdata/eng.traineddata`, upstream license files, and
`ocr-manifest.json`. Do not publish an OCR package until `npm pack --dry-run`
shows only that platform's payload.

Use `npm run ocr:assemble -- --package packages/<target>` on the matching OS
and CPU to populate a package, then `npm run ocr:validate -- --package
packages/<target>` before packing it. The `OCR Packages` GitHub Actions
workflow runs this per target, attaches the resulting `.tgz` files to a GitHub
release, and publishes the OCR packages when `NPM_TOKEN` is configured.

GitHub release assets should include the main package tarball and any populated
OCR package tarballs. `waifus update --github` installs the main tarball and the
current platform's OCR tarball when it is present.
