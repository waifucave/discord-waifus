/**
 * providerStatus.ts — /api/providers response assembly: the full gateway provider registry
 * (all 14 ids PROVIDERS knows, the same source src/api/writeValidation.ts validates writes
 * against) with per-provider credential status merged in from user/providers.json.
 *
 * Formerly legacyCatalog.ts, which also synthesised a legacy ModelCapabilityMetadata list from
 * the registry for the now-deleted /api/models route (Task 4, Gateway P3b cutover). That
 * synthesis, and the legacy 6-native-provider scoping it required, are gone as of Gateway P6
 * Task 3 — /api/llm/v1/models is the sole models listing now. This file keeps the docsUrl map
 * and the credential-status assembly, widened to every registry provider.
 */

import { PROVIDERS } from "@waifucave/gateway";
import type { ProviderCredentialsFile } from "../shared/schemas/domain.js";

/** Static docsUrls preserved from the old catalog. Absent for providers we have no known link for. */
const DOCS_URLS: Record<string, string> = {
  xai: "https://docs.x.ai/developers/models",
  deepseek: "https://api-docs.deepseek.com/api/create-chat-completion",
  anthropic: "https://platform.claude.com/docs/en/about-claude/models/overview",
  openai: "https://developers.openai.com/api/docs/models",
  zai: "https://docs.z.ai/guides/overview/migrate-to-glm-new",
  "google-ai-studio": "https://ai.google.dev/gemini-api/docs"
};

export function keyHint(value: string): string {
  return value.length <= 4 ? "****" : `****${value.slice(-4)}`;
}

export type ProviderCredentialStatus =
  | { configured: false }
  | { configured: true; label?: string; updatedAt: string; keyHint: string };

export type ProviderStatusEntry = {
  id: string;
  displayName: string;
  docsUrl?: string;
  credentials: ProviderCredentialStatus;
};

/** Union by id over the full registry: every provider PROVIDERS knows, with its credential status. */
export function providerStatuses(credentials: ProviderCredentialsFile): ProviderStatusEntry[] {
  return PROVIDERS.map((provider) => {
    const saved = credentials.providers[provider.id];
    const docsUrl = DOCS_URLS[provider.id];
    return {
      id: provider.id,
      displayName: provider.displayName,
      ...(docsUrl ? { docsUrl } : {}),
      credentials: saved
        ? {
            configured: true,
            label: saved.label,
            updatedAt: saved.updatedAt,
            keyHint: keyHint(saved.apiKey)
          }
        : { configured: false }
    };
  });
}
