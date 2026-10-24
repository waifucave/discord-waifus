// Living cast spec §9.2: a stored reasoning effort must be one the route lists. Re-validated at
// every boot against the INSTALLED winter catalog (a winter upgrade can change a route's efforts);
// an effort no longer listed is dropped and reported in `app/model-warnings.json`. A route the
// installed catalog does not carry is left untouched (it is reported live as unavailable instead).

import path from "node:path";
import type { WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import { atomicWriteJson } from "../../storage/atomic.js";
import { installedCatalog, routeKey } from "../../models/catalog.js";
import { appendModelWarnings, type ModelWarning } from "../../models/modelWarnings.js";
import { isObject, readJsonOrUndefined } from "./memorySupport.js";
import { listWaifuFiles } from "./livingCastModels.js";

function listedEfforts(catalog: WinterCatalog, providerId: string, modelId: string): string[] | undefined {
  const descriptor = catalog.models.find((model) => model.key === routeKey({ providerId, modelId }));
  if (!descriptor) return undefined;
  const reasoning = descriptor.reasoning;
  return reasoning && reasoning.supported.value === true ? reasoning.efforts : [];
}

function checkDocument(data: Record<string, unknown>, scope: string, catalog: WinterCatalog): Omit<ModelWarning, "at"> | undefined {
  const model = data.model;
  if (!isObject(model) || typeof model.effort !== "string") return undefined;
  if (typeof model.providerId !== "string" || typeof model.modelId !== "string") return undefined;
  const efforts = listedEfforts(catalog, model.providerId, model.modelId);
  if (efforts === undefined || efforts.includes(model.effort)) return undefined;
  const dropped = model.effort;
  delete model.effort;
  return {
    scope,
    code: "effort_dropped",
    detail: `Effort "${dropped}" is not listed for ${model.providerId}/${model.modelId}; the route's default applies.`,
    previous: `${model.providerId}/${model.modelId} (effort ${dropped})`
  };
}

export async function checkStoredModelEfforts(dataRoot: string, catalog: WinterCatalog = installedCatalog()): Promise<string | undefined> {
  const warnings: Array<Omit<ModelWarning, "at">> = [];
  const documents: Array<{ filePath: string; scope: string }> = [
    ...(await listWaifuFiles(dataRoot)).map(({ id, filePath }) => ({ filePath, scope: `waifu:${id}` })),
    { filePath: path.join(dataRoot, "user", "assistant", "config.json"), scope: "assistant" }
  ];
  for (const { filePath, scope } of documents) {
    const data = await readJsonOrUndefined(filePath);
    if (!isObject(data)) continue;
    const resolvedScope = scope.startsWith("waifu:") && typeof data.id === "string" && data.id ? `waifu:${data.id}` : scope;
    const warning = checkDocument(data, resolvedScope, catalog);
    if (!warning) continue;
    warnings.push(warning);
    // The warning first: a crash between the two writes never loses what was dropped.
    await appendModelWarnings(dataRoot, [warning]);
    await atomicWriteJson(filePath, data);
  }
  if (warnings.length === 0) return undefined;
  return `model-effort-check-${warnings.length}`;
}
