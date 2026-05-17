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
npm publish ./starlight-ai-discord-waifus-1.0.0.tgz --access public
```

The npm package owns the global `waifus` binary through `package.json#bin`.
Installing a newer version of the same package globally rewrites the existing
global `waifus` shim. If another package owns that binary, npm may require the
user to uninstall the conflicting package or use `--force`.
