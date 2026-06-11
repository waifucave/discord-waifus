import { readFileSync } from "node:fs";
import { userDataPath } from "../config/paths.js";

/**
 * Synchronous provider-key lookup for the mounted LLM gateway, whose
 * credentials hook is sync. Reads user/providers.json fresh on every call so
 * key updates via PUT /api/providers/:providerId/credentials apply without a
 * restart (storage writes are atomic temp+rename, so a sync read never sees a
 * partial file). Shape-tolerant by design — a malformed file or a future
 * schema change must degrade to "no credential", never throw on the chat path.
 */
export function createProviderCredentialsLookup(
  dataRoot: string
): (providerId: string) => string | undefined {
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
