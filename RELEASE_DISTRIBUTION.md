# Release Distribution Map

## Current Distribution Goal

- npm ships a small installer/updater CLI: `@starlight-ai/discord-waifus`
- GitHub Releases ship the runnable app bundle: `discord-waifus-app.tar.gz`
- GitHub source remains in the normal repository for development, issues, and docs

This replaces the old flow where `waifus init` and `waifus update` downloaded the source repository archive and built the app locally.

## Old Flow

1. Install the global CLI from npm.
2. `waifus init` or first-run bootstrap downloads the GitHub source archive.
3. The CLI runs `pnpm install`.
4. The CLI runs `pnpm build`.
5. The local machine ends up with source code plus build outputs.

Problems with that model:

- install quality depends on the user’s local build environment
- startup/update takes longer
- GitHub delivers source instead of a release artifact
- it feels closer to a dev bootstrapper than a production installer

## New Flow

1. Install the global CLI from npm.
2. `waifus init` or first-run bootstrap resolves a GitHub Release.
3. The CLI downloads `discord-waifus-app.tar.gz`.
4. The CLI optionally verifies `discord-waifus-app.sha256`.
5. The CLI extracts the prebuilt app bundle into the project directory.
6. The CLI runs `pnpm install --prod --frozen-lockfile`.
7. The CLI initializes `.waifus/` and starts the app.

`waifus update` now repeats the same release-bundle flow and preserves local runtime directories such as `.waifus/`.

## Bundle Contents

The release bundle is source-free and contains only runtime files:

- `package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `README.md`
- `.waifus-release.json`
- `defaults/`
- `packages/backend/package.json`
- `packages/backend/dist/`
- `packages/dashboard/package.json`
- `packages/dashboard/next.config.js`
- `packages/dashboard/.next/`

The bundle intentionally excludes:

- `packages/backend/src/`
- `packages/dashboard/src/`
- `packages/cli/`
- dev-only configs and build inputs not required at runtime

## Runtime Dependency Model

The release bundle is prebuilt, but it is not fully dependency-free. After extraction, the CLI still installs runtime dependencies from npm using the bundle’s own lockfile.

That means:

- GitHub Releases provide the app build
- npm registry still provides package dependencies
- npm package updates are only needed when the installer/updater logic changes

## Maintainer Workflow

1. Publish or update the source code on GitHub as usual.
2. Run `pnpm build:release-bundle -- --version <app-version>`.
3. Upload these two files to a GitHub Release:
   - `artifacts/discord-waifus-app.tar.gz`
   - `artifacts/discord-waifus-app.sha256`
4. Users update with `waifus update`.

Recommended tag format:

- `app-v0.3.0`

The CLI can install the latest GitHub Release by default or a specific release tag through `--release`.
