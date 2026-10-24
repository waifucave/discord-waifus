// Provider keys for model calls (Living cast spec §9.1): read live from `user/providers.json` and
// passed to winter inline, per call. Nothing is cached and nothing goes to an OS keychain.

import { readFileSync } from "node:fs";
import { userDataPath } from "../config/paths.js";

export type ProviderKeyLookup = (providerId: string) => string | undefined;

/**
 * Synchronous lookup over `user/providers.json`, re-read on every call so a key saved through
 * `PUT /api/providers/:providerId/credentials` applies without a restart (storage writes are atomic
 * temp+rename, so a read never sees a partial file). Shape-tolerant on purpose: a malformed file
 * degrades to "no key", never to a throw on the call path.
 */
export function createProviderCredentialsLookup(dataRoot: string): ProviderKeyLookup {
  const filePath = userDataPath(dataRoot, "providers.json");
  return (providerId) => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (parsed === null || typeof parsed !== "object") return undefined;
      const providers = (parsed as { providers?: unknown }).providers;
      if (providers === null || typeof providers !== "object") return undefined;
      const entry = (providers as Record<string, unknown>)[providerId];
      if (entry === null || typeof entry !== "object") return undefined;
      const apiKey = (entry as { apiKey?: unknown }).apiKey;
      return typeof apiKey === "string" && apiKey !== "" ? apiKey : undefined;
    } catch {
      return undefined;
    }
  };
}

/** winter's inline credential reference: the key rides the call, never a store. */
export function inlineAuthRef(apiKey: string): { kind: "inline"; value: string } {
  return { kind: "inline", value: apiKey };
}
