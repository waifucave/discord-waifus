/**
 * providerStatus.ts — `/api/providers` response assembly (Living cast spec §9.2): provider status
 * comes from the winter catalog's provider list. Listed: every provider that serves an allowed
 * route in the installed catalog, the decision providers the addressee detector uses (OpenAI,
 * OpenRouter), the app's own credential providers (`exa`, the optional web-search key, §6.8) and
 * any provider that already has a stored key (so it can be removed), each with its credential status
 * from user/providers.json (redacted key hints only).
 */

import type { WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import { allowedProviderIds, installedCatalog } from "../models/catalog.js";
import type { ProviderCredentialsFile } from "../shared/schemas/domain.js";
import { APP_CREDENTIAL_PROVIDERS } from "./writeValidation.js";

/** Static docsUrls for the providers the curated list and the detector use. */
const DOCS_URLS: Record<string, string> = {
  deepseek: "https://api-docs.deepseek.com/api/create-chat-completion",
  anthropic: "https://platform.claude.com/docs/en/about-claude/models/overview",
  openai: "https://developers.openai.com/api/docs/models",
  meta: "https://dev.meta.ai/docs/models",
  openrouter: "https://openrouter.ai/docs"
};

/** The addressee detector's decision providers (Living cast §4.3). */
const DETECTOR_PROVIDER_IDS = ["openai", "openrouter"];

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

export function providerStatuses(
  credentials: ProviderCredentialsFile,
  o: { allowed?: readonly string[]; catalog?: WinterCatalog } = {}
): ProviderStatusEntry[] {
  const catalog = o.catalog ?? installedCatalog();
  const ids = new Set<string>([
    ...allowedProviderIds({ catalog, ...(o.allowed ? { allowed: o.allowed } : {}) }),
    ...DETECTOR_PROVIDER_IDS,
    ...Object.keys(APP_CREDENTIAL_PROVIDERS),
    ...Object.keys(credentials.providers)
  ]);
  const entries: ProviderStatusEntry[] = [];
  for (const id of ids) {
    const provider = catalog.providers.find((candidate) => candidate.id === id);
    const app = Object.hasOwn(APP_CREDENTIAL_PROVIDERS, id) ? APP_CREDENTIAL_PROVIDERS[id] : undefined;
    const saved = credentials.providers[id];
    if (!provider && !app && !saved) continue;
    const docsUrl = DOCS_URLS[id] ?? app?.docsUrl;
    entries.push({
      id,
      displayName: provider?.displayName ?? app?.displayName ?? id,
      ...(docsUrl ? { docsUrl } : {}),
      credentials: saved
        ? { configured: true, label: saved.label, updatedAt: saved.updatedAt, keyHint: keyHint(saved.apiKey) }
        : { configured: false }
    });
  }
  return entries.sort((a, b) => a.displayName.localeCompare(b.displayName));
}
