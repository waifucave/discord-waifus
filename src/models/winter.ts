// The process's winter provider runtime: the installed catalog, a registry with winter's shipped
// adapters, and winter's history renderer over that registry. Built once, lazily. Tests build
// their own with `createWinterRuntime({ catalog, adapters })`.

import type { WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import {
  createHistoryRenderer,
  createRegistry,
  createShippedAdapters,
  setWinterIdentity,
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
  codexOriginator: "discord_waifus",
  contactUrl: "https://github.com/waifucave/discord-waifus"
});

let identityInstalled = false;

/** Names Discord Waifus (not winter) in every provider request's identity headers. Idempotent. */
export function installWinterIdentity(): void {
  if (identityInstalled) return;
  setWinterIdentity({ ...DISCORD_WAIFUS_IDENTITY });
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
