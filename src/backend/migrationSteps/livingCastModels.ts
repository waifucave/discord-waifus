// Living cast spec §9.4 / §11.2 `living-cast-models-v1`: the gateway-era model fields become the
// winter model layer's.
//
// - `user/providers.json`: gateway provider ids that winter spells differently are renamed
//   (`google-ai-studio` → `google`, `qwen` → `alibaba`); an existing key under the new id wins.
// - every `user/waifus/<id>/waifu.json` and `user/assistant/config.json`: flat `providerId` /
//   `modelId` / `params` become nested `model: {providerId, modelId, effort?}` by MODEL FAMILY
//   (the table below); a model whose family is not curated is unset and reported in
//   `app/model-warnings.json` (shown in `/api/runtime`) so the owner re-picks. A stored
//   `reasoning.effort` (or `reasoning.enabled: false` → `none`) is carried over when it is a
//   reasoning effort at all; `model-effort-check` then keeps it only if the route lists it.
// - waifus also lose `contextWindow`, `personaDigest` and `tools.toolUse`.
//
// The tables are static so the step's outcome never depends on the installed catalog. Idempotent:
// a file already in the new shape is left byte-identical.

import { readdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "../../storage/atomic.js";
import { isObject, readJsonOrUndefined } from "./memorySupport.js";
import { appendModelWarnings, type ModelWarning } from "../../models/modelWarnings.js";

/** Gateway provider id → winter provider id (only the ids that differ). */
export const GATEWAY_TO_WINTER_PROVIDER: Readonly<Record<string, string>> = {
  "google-ai-studio": "google",
  qwen: "alibaba"
};

export function winterProviderId(gatewayProviderId: string): string {
  return GATEWAY_TO_WINTER_PROVIDER[gatewayProviderId] ?? gatewayProviderId;
}

type Family = "muse-contributor" | "haiku" | "sonnet" | "deepseek-flash" | "luna" | "sol";

/** Curated model family → its route, direct and through OpenRouter (spec §9.2). */
export const FAMILY_ROUTES: Readonly<Record<Family, { direct: { providerId: string; modelId: string }; openrouter: { providerId: string; modelId: string } }>> = {
  "muse-contributor": {
    direct: { providerId: "meta", modelId: "muse-spark-1.3-contributor" },
    openrouter: { providerId: "openrouter", modelId: "meta/muse-spark-1.3-contributor" }
  },
  haiku: {
    direct: { providerId: "anthropic", modelId: "claude-haiku-5-5" },
    openrouter: { providerId: "openrouter", modelId: "anthropic/claude-haiku-5.5" }
  },
  sonnet: {
    direct: { providerId: "anthropic", modelId: "claude-sonnet-5-5" },
    openrouter: { providerId: "openrouter", modelId: "anthropic/claude-sonnet-5.5" }
  },
  "deepseek-flash": {
    direct: { providerId: "deepseek", modelId: "deepseek-flash" },
    openrouter: { providerId: "openrouter", modelId: "deepseek/deepseek-v4.1-flash" }
  },
  luna: {
    direct: { providerId: "openai", modelId: "gpt-6-luna" },
    openrouter: { providerId: "openrouter", modelId: "openai/gpt-6-luna" }
  },
  sol: {
    direct: { providerId: "openai", modelId: "gpt-6.1-sol" },
    openrouter: { providerId: "openrouter", modelId: "openai/gpt-6.1-sol" }
  }
};

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
      warning = {
        scope,
        code: "model_unmapped",
        detail: `${flatProviderId ? `${flatProviderId}/` : ""}${flatModelId} has no curated equivalent; pick a model again.`
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

async function renameProviderKeys(dataRoot: string): Promise<boolean> {
  const filePath = path.join(dataRoot, "user", "providers.json");
  const data = await readJsonOrUndefined(filePath);
  if (!isObject(data) || !isObject(data.providers)) return false;
  const providers = data.providers;
  let changed = false;
  for (const [from, to] of Object.entries(GATEWAY_TO_WINTER_PROVIDER)) {
    const entry = providers[from];
    if (entry === undefined) continue;
    if (providers[to] === undefined && isObject(entry)) providers[to] = { ...entry, providerId: to };
    delete providers[from];
    changed = true;
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

export async function migrateLivingCastModels(dataRoot: string): Promise<string | undefined> {
  let changed = await renameProviderKeys(dataRoot);
  const warnings: Array<Omit<ModelWarning, "at">> = [];
  for (const { id, filePath } of await listWaifuFiles(dataRoot)) {
    const data = await readJsonOrUndefined(filePath);
    if (!isObject(data)) continue;
    const scope = `waifu:${typeof data.id === "string" && data.id ? data.id : id}`;
    const outcome = convertModelFields(data, scope, { waifu: true });
    if (outcome.warning) warnings.push(outcome.warning);
    if (outcome.changed) {
      await atomicWriteJson(filePath, data);
      changed = true;
    }
  }
  const assistantPath = path.join(dataRoot, "user", "assistant", "config.json");
  const assistant = await readJsonOrUndefined(assistantPath);
  if (isObject(assistant)) {
    const outcome = convertModelFields(assistant, "assistant", { waifu: false });
    if (outcome.warning) warnings.push(outcome.warning);
    if (outcome.changed) {
      await atomicWriteJson(assistantPath, assistant);
      changed = true;
    }
  }
  if (warnings.length > 0) await appendModelWarnings(dataRoot, warnings);
  return changed ? "living-cast-models-v1" : undefined;
}
