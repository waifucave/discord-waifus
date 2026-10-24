// Step `living-cast-server-fields-v1` (Living cast spec §11.2): server files lose the retired
// director's settings — `orchestratorMode`, `stageManagerEnabled`, `contextWindows`,
// `memoryInjectionLimit`, `tools`, `compaction` and `oneShot`. A server that was in one-shot mode with
// a target other than the old default keeps that target as its addressee-detector override
// (`detector.target`); every other `oneShot` is dropped (the global `[detector] target` applies).
// An existing `detector` override is never replaced. Files already in the new shape stay
// byte-identical.

import { readdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DETECTOR_TARGET, DetectorTargetSchema } from "../../shared/schemas/detector.js";
import { atomicWriteJson } from "../../storage/atomic.js";
import { isObject, readJsonFile } from "./memorySupport.js";

const RETIRED_FIELDS = ["orchestratorMode", "stageManagerEnabled", "contextWindows", "memoryInjectionLimit", "tools", "compaction", "oneShot"];
const ONE_SHOT_MODE = "one-shot";

export async function migrateLivingCastServerFields(dataRoot: string): Promise<string | undefined> {
  const serversDir = path.join(dataRoot, "user", "servers");
  let guildIds: string[];
  try {
    guildIds = (await readdir(serversDir)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let changed = 0;
  let overrides = 0;
  for (const guildId of guildIds) {
    const file = path.join(serversDir, guildId, "server.json");
    const read = await readJsonFile(file);
    if (read.kind !== "ok" || !isObject(read.value)) continue;
    const server = read.value;
    if (!RETIRED_FIELDS.some((field) => field in server)) continue;
    const target = isObject(server.oneShot) ? server.oneShot.target : undefined;
    if (
      server.orchestratorMode === ONE_SHOT_MODE &&
      server.detector === undefined &&
      typeof target === "string" &&
      target !== DEFAULT_DETECTOR_TARGET &&
      DetectorTargetSchema.safeParse(target).success
    ) {
      server.detector = { target };
      overrides += 1;
    }
    for (const field of RETIRED_FIELDS) delete server[field];
    await atomicWriteJson(file, server);
    changed += 1;
  }
  return changed > 0 ? `living-cast-server-fields-${changed}${overrides > 0 ? `-detector-${overrides}` : ""}` : undefined;
}
