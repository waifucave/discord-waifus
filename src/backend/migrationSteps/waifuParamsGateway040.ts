import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createGateway, type Gateway } from "@waifucave/gateway";
import { resolveModelTarget } from "../../orchestration/pipeline/resolveTarget.js";
import { atomicWriteJson } from "../../storage/atomic.js";

// Step `waifu-params-gateway-040-v1` (spec 8.2/8.10, once per app version, after
// `configs-to-gateway-params`): the 0.4.0 catalog rejects some params the old one accepted (e.g.
// `temperature` on opus-4-7), and write endpoints validate the resolved stored state, so a stale
// value would make every later save of that waifu/agent return 400. This drops every stored
// param the gateway's own `validate()` rejects for the config's model. It runs through the live
// registry, so it is idempotent: a second run finds nothing left to drop.

const AGENT_DIRS = ["orchestrator", "stage-manager", "reviewer", "assistant"];
const MAX_PASSES = 8;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}

/** Drops rejected keys from `params` in place; returns the dropped names. */
function dropRejectedParams(gateway: Gateway, providerId: string, modelId: string, params: Record<string, unknown>): string[] {
  const dropped: string[] = [];
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const result = gateway.validate(providerId, modelId, { params });
    if (result.ok) break;
    let changed = false;
    for (const violation of result.violations) {
      if (violation.param in params) {
        delete params[violation.param];
        dropped.push(violation.param);
        changed = true;
      }
    }
    // A violation that does not name a stored param (e.g. a forced-state rule) is not ours to fix.
    if (!changed) break;
  }
  return dropped;
}

async function cleanConfigDoc(gateway: Gateway, filePath: string): Promise<number> {
  const data = await readJson(filePath);
  if (!isObject(data) || !isObject(data.params) || Object.keys(data.params).length === 0) return 0;
  if (typeof data.modelId !== "string" || data.modelId.length === 0) return 0;
  let target: ReturnType<typeof resolveModelTarget>;
  try {
    target = resolveModelTarget({
      providerId: typeof data.providerId === "string" ? data.providerId : undefined,
      modelId: data.modelId
    });
  } catch {
    return 0; // unknown model: nothing to validate against (waifus doctor reports it)
  }
  if (!gateway.getCapabilities(target.providerId, target.modelId)) return 0;
  const dropped = dropRejectedParams(gateway, target.providerId, target.modelId, data.params);
  if (dropped.length === 0) return 0;
  await atomicWriteJson(filePath, data);
  return dropped.length;
}

export async function migrateWaifuParamsGateway040(dataRoot: string): Promise<string | undefined> {
  const gateway = createGateway({});
  let dropped = 0;

  for (const agent of AGENT_DIRS) {
    dropped += await cleanConfigDoc(gateway, path.join(dataRoot, "user", agent, "config.json"));
  }

  const waifusRoot = path.join(dataRoot, "user", "waifus");
  let entries: string[];
  try {
    entries = await readdir(waifusRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    entries = [];
  }
  for (const entry of entries) {
    dropped += await cleanConfigDoc(gateway, path.join(waifusRoot, entry, "waifu.json"));
  }

  return dropped > 0 ? `waifu-params-gateway-040-${dropped}` : undefined;
}
