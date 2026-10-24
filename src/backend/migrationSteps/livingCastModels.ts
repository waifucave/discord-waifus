// Living cast spec §9.4 / §11.2 `living-cast-models-v1`: the gateway-era model fields become the
// winter model layer's.
//
// - `user/providers.json`: gateway provider ids that winter spells differently are renamed
//   (`google-ai-studio` → `google`, `qwen` → `alibaba`); an existing key under the new id wins, and
//   the old entry is archived (owner-private) before it is removed.
// - every `user/waifus/<id>/waifu.json` and `user/assistant/config.json`: flat `providerId` /
//   `modelId` / `params` become nested `model: {providerId, modelId, effort?}` by MODEL FAMILY
//   (the table below); a model whose family is not curated is unset and reported in
//   `app/model-warnings.json` (shown in `/api/runtime`) so the owner re-picks. A stored
//   `reasoning.effort` (or `reasoning.enabled: false` → `none`) is carried over when it is a
//   reasoning effort at all; `model-effort-check` then keeps it only if the route lists it.
// - waifus also lose `contextWindow`, `personaDigest` and `tools.toolUse`.
// - Nothing is lost: every document is copied to `user/.archive/living-cast/models/<scope>.json`
//   (the spec's Living cast archive, §7.4 / §11.2) before it is rewritten, and a warning (with the
//   old model as `previous`) is written before the document it is about.
//
// The tables are static so the step's outcome never depends on the installed catalog. Idempotent:
// a file already in the new shape is left byte-identical.

import { readdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "../../storage/atomic.js";
import { isObject, readJsonOrUndefined } from "./memorySupport.js";
import { appendModelWarnings, type ModelWarning } from "../../models/modelWarnings.js";
import { CURATED_FAMILY_ROUTES, type CuratedFamily } from "../../models/defaults.js";

/** Gateway provider id → winter provider id (only the ids that differ). */
export const GATEWAY_TO_WINTER_PROVIDER: Readonly<Record<string, string>> = {
  "google-ai-studio": "google",
  qwen: "alibaba"
};

export function winterProviderId(gatewayProviderId: string): string {
  return GATEWAY_TO_WINTER_PROVIDER[gatewayProviderId] ?? gatewayProviderId;
}

type Family = CuratedFamily;

/** Curated model family → its route, direct and through OpenRouter (spec §9.2). */
export const FAMILY_ROUTES = CURATED_FAMILY_ROUTES;

/**
 * The family of a gateway model id (an OpenRouter id without its `vendor/` prefix). Only curated
 * families map: Opus/Fable, `-pro` tiers, non-contributor Muse Spark (contributor variants enable
 * training, so they are never chosen for someone who did not choose one) and every other family
 * are unmappable.
 */
export function modelFamily(gatewayModelId: string): Family | undefined {
  const id = gatewayModelId.toLowerCase();
  if (/(^|-)pro($|-)/u.test(id)) return undefined;
  if (/^muse-spark-[\d.]+-contributor$/u.test(id)) return "muse-contributor";
  if (/^claude-haiku-/u.test(id)) return "haiku";
  if (/^claude-sonnet-/u.test(id)) return "sonnet";
  if (/^deepseek-v[\d.]+-flash(?:-\d+)?$/u.test(id) || id === "deepseek-flash") return "deepseek-flash";
  if (/^gpt-[\d.]+-luna$/u.test(id)) return "luna";
  if (/^gpt-[\d.]+-sol$/u.test(id)) return "sol";
  return undefined;
}

/** The curated route for a stored gateway pair, or undefined when its family is not curated. */
export function mapGatewayModel(providerId: string | undefined, modelId: string): { providerId: string; modelId: string } | undefined {
  const viaOpenRouter = providerId === "openrouter" || (providerId === undefined && modelId.includes("/"));
  const bare = viaOpenRouter && modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
  const family = modelFamily(bare);
  if (!family) return undefined;
  const provider = providerId === undefined ? undefined : winterProviderId(providerId);
  const routes = FAMILY_ROUTES[family];
  if (viaOpenRouter) return { ...routes.openrouter };
  // A family is only mapped on its own vendor's API; another provider serving it is unmappable.
  if (provider !== undefined && provider !== routes.direct.providerId) return undefined;
  return { ...routes.direct };
}

const EFFORT_VOCABULARY = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** A stored gateway `params` record → a reasoning effort to carry over, if any. */
export function effortFromParams(params: unknown): string | undefined {
  if (!isObject(params)) return undefined;
  const effort = params["reasoning.effort"];
  if (typeof effort === "string" && EFFORT_VOCABULARY.has(effort)) return effort;
  if (params["reasoning.enabled"] === false) return "none";
  return undefined;
}

type ConvertOutcome = { changed: boolean; warning?: Omit<ModelWarning, "at"> };

/** Mutates one config document in place. */
export function convertModelFields(data: Record<string, unknown>, scope: string, o: { waifu: boolean }): ConvertOutcome {
  let changed = false;
  let warning: ConvertOutcome["warning"];
  const flatModelId = typeof data.modelId === "string" && data.modelId.length > 0 ? data.modelId : undefined;
  const flatProviderId = typeof data.providerId === "string" && data.providerId.length > 0 ? data.providerId : undefined;
  const hasNested = isObject(data.model) && typeof data.model.providerId === "string" && typeof data.model.modelId === "string";
  if (flatModelId && !hasNested) {
    const route = mapGatewayModel(flatProviderId, flatModelId);
    if (route) {
      const effort = effortFromParams(data.params);
      data.model = { ...route, ...(effort ? { effort } : {}) };
    } else {
      const previous = `${flatProviderId ? `${flatProviderId}/` : ""}${flatModelId}`;
      warning = {
        scope,
        code: "model_unmapped",
        detail: `${previous} has no curated equivalent; pick a model again.`,
        previous
      };
    }
    changed = true;
  }
  for (const key of ["providerId", "modelId", "params"]) {
    if (key in data) {
      delete data[key];
      changed = true;
    }
  }
  if (o.waifu) {
    for (const key of ["contextWindow", "personaDigest"]) {
      if (key in data) {
        delete data[key];
        changed = true;
      }
    }
    if (isObject(data.tools)) {
      if ("toolUse" in data.tools) {
        delete data.tools.toolUse;
        changed = true;
      }
      if (Object.keys(data.tools).length === 0) {
        delete data.tools;
        changed = true;
      }
    }
  }
  return { changed, ...(warning ? { warning } : {}) };
}

/** The Living cast archive (spec §7.4, §11.2). */
export const LIVING_CAST_ARCHIVE_DIR = path.join("user", ".archive", "living-cast");

/** `user/.archive/living-cast/models/<scope>.json`; `waifu:<id>` becomes `waifu-<id>.json`. */
export function modelArchivePath(dataRoot: string, scope: string): string {
  return path.join(dataRoot, LIVING_CAST_ARCHIVE_DIR, "models", `${scope.replace(/[^A-Za-z0-9._-]/gu, "-")}.json`);
}

/** Owner-private copy of provider entries replaced by a rename (keys included). */
export function providerArchivePath(dataRoot: string): string {
  return path.join(dataRoot, LIVING_CAST_ARCHIVE_DIR, "providers.json");
}

/** Copies a document to the archive once: the first original is the one kept. */
async function archiveOriginal(filePath: string, original: unknown): Promise<void> {
  if ((await readJsonOrUndefined(filePath)) !== undefined) return;
  await atomicWriteJson(filePath, original);
}

async function renameProviderKeys(dataRoot: string): Promise<boolean> {
  const filePath = path.join(dataRoot, "user", "providers.json");
  const data = await readJsonOrUndefined(filePath);
  if (!isObject(data) || !isObject(data.providers)) return false;
  const providers = data.providers;
  let changed = false;
  const archived: Record<string, unknown> = {};
  for (const [from, to] of Object.entries(GATEWAY_TO_WINTER_PROVIDER)) {
    const entry = providers[from];
    if (entry === undefined) continue;
    if (providers[to] === undefined && isObject(entry)) providers[to] = { ...entry, providerId: to };
    // The new id already had its own key: the old one is archived, never silently dropped.
    else archived[from] = entry;
    delete providers[from];
    changed = true;
  }
  if (Object.keys(archived).length > 0) {
    const archivePath = providerArchivePath(dataRoot);
    const existing = await readJsonOrUndefined(archivePath);
    const kept = isObject(existing) && isObject(existing.providers) ? existing.providers : {};
    // atomicWriteJson writes 0600: the archive holds keys, like providers.json.
    await atomicWriteJson(archivePath, { providers: { ...archived, ...kept } });
  }
  if (changed) await atomicWriteJson(filePath, data);
  return changed;
}

export async function listWaifuFiles(dataRoot: string): Promise<Array<{ id: string; filePath: string }>> {
  const waifusRoot = path.join(dataRoot, "user", "waifus");
  let entries: string[];
  try {
    entries = await readdir(waifusRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.sort().map((entry) => ({ id: entry, filePath: path.join(waifusRoot, entry, "waifu.json") }));
}

/** Converts one document: archive the original, then the warning, then the rewritten file. */
async function migrateDocument(dataRoot: string, filePath: string, scope: (data: Record<string, unknown>) => string, o: { waifu: boolean }): Promise<boolean> {
  const data = await readJsonOrUndefined(filePath);
  if (!isObject(data)) return false;
  const original = structuredClone(data);
  const resolvedScope = scope(data);
  const outcome = convertModelFields(data, resolvedScope, o);
  if (!outcome.changed) return false;
  await archiveOriginal(modelArchivePath(dataRoot, resolvedScope), original);
  if (outcome.warning) await appendModelWarnings(dataRoot, [outcome.warning]);
  await atomicWriteJson(filePath, data);
  return true;
}

export async function migrateLivingCastModels(dataRoot: string): Promise<string | undefined> {
  let changed = await renameProviderKeys(dataRoot);
  for (const { id, filePath } of await listWaifuFiles(dataRoot)) {
    const scope = (data: Record<string, unknown>) => `waifu:${typeof data.id === "string" && data.id ? data.id : id}`;
    if (await migrateDocument(dataRoot, filePath, scope, { waifu: true })) changed = true;
  }
  const assistantPath = path.join(dataRoot, "user", "assistant", "config.json");
  if (await migrateDocument(dataRoot, assistantPath, () => "assistant", { waifu: false })) changed = true;
  return changed ? "living-cast-models-v1" : undefined;
}
