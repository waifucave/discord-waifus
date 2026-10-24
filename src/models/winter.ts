// The process's winter provider runtime: the installed catalog, a registry with winter's shipped
// adapters, and winter's history renderer over that registry. Built once, lazily. Tests build
// their own with `createWinterRuntime({ catalog, adapters })`.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import {
  createHistoryRenderer,
  createRegistry,
  createShippedAdapters,
  setWinterIdentity,
  type WinterIdentity,
  type ProviderAdapter,
  type ProviderRegistry,
  type WinterHistoryRenderer
} from "@yanlinglabs/winter-provider-runtime";
import { installedCatalog } from "./catalog.js";

export type WinterRuntime = {
  catalog: WinterCatalog;
  registry: ProviderRegistry;
  renderer: WinterHistoryRenderer;
};

/** The User-Agent product token and contact winter puts on the wire (W9 `setWinterIdentity`). */
export const DISCORD_WAIFUS_IDENTITY = Object.freeze({
  product: "discord-waifus",
  // winter's brand profile: a lowercase token (letters, digits, hyphens), never first-party.
  codexOriginator: "discord-waifus",
  contactUrl: "https://github.com/waifucave/discord-waifus"
});

let identityInstalled = false;

/** The app's own release (`package.json` two levels up from src/models or dist/models), if readable. */
function appVersion(): string | undefined {
  try {
    const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** The identity winter puts on the wire: Discord Waifus and its own release (`User-Agent: discord-waifus/<version>`). */
export function discordWaifusIdentity(version: string | undefined = appVersion()): WinterIdentity {
  return { ...DISCORD_WAIFUS_IDENTITY, ...(version ? { version } : {}) };
}

/**
 * Names Discord Waifus and its release (not winter's) in every provider request's identity headers
 * (winter 0.0.56 W9). winter validates the identity and throws `TypeError` on a value its brand
 * profile refuses; a version it refuses is dropped rather than breaking every call. Idempotent.
 */
export function installWinterIdentity(): void {
  if (identityInstalled) return;
  for (const identity of [discordWaifusIdentity(), discordWaifusIdentity("")]) {
    try {
      setWinterIdentity(identity);
      break;
    } catch (error) {
      // A refused identity must never break model calls: the next candidate, else winter's default.
      if (!(error instanceof TypeError)) throw error;
    }
  }
  identityInstalled = true;
}

export function createWinterRuntime(o: { catalog?: WinterCatalog; adapters?: ProviderAdapter[] } = {}): WinterRuntime {
  const catalog = o.catalog ?? installedCatalog();
  const registry = createRegistry(catalog);
  for (const adapter of o.adapters ?? createShippedAdapters(catalog)) registry.register(adapter);
  return { catalog, registry, renderer: createHistoryRenderer(registry) };
}

let shared: WinterRuntime | undefined;

export function sharedWinterRuntime(): WinterRuntime {
  if (!shared) {
    installWinterIdentity();
    shared = createWinterRuntime();
  }
  return shared;
}
