import { readdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "../../storage/atomic.js";
import { isObject, readJsonOrUndefined } from "./memorySupport.js";

// Step `server-drop-enabled-flags-v1` (spec 9.7, O8): removes the server-level `enabled` flag and
// every channel `enabled` flag from `user/servers/<guildId>/server.json`. A channel is live when it
// has at least one enabled waifu and `paused` is the server kill switch, so the flags carried no
// information (the channel flag was never read; the server flag defaulted to false and only gated
// restart resume). `paused` and `enabledWaifuIds` are left alone: nobody's `enabled: false` is
// turned into a pause, because the default was false and an explicit choice cannot be told apart.
// Idempotent; raw JSON, files that do not parse are left for the loader to report.

/** Returns the number of server files rewritten. */
export async function dropServerEnabledFlags(dataRoot: string): Promise<number> {
  const serversRoot = path.join(dataRoot, "user", "servers");
  let entries: string[];
  try {
    entries = await readdir(serversRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const entry of entries) {
    const filePath = path.join(serversRoot, entry, "server.json");
    const data = await readJsonOrUndefined(filePath);
    if (!isObject(data)) continue;
    let changed = false;
    if ("enabled" in data) {
      if (data.enabled === false) {
        console.warn(`Server ${entry}: the removed \`enabled: false\` flag was dropped and does not pause it; set \`paused\` to silence the server.`);
      }
      delete data.enabled;
      changed = true;
    }
    if (isObject(data.channels)) {
      for (const channel of Object.values(data.channels)) {
        if (isObject(channel) && "enabled" in channel) {
          delete channel.enabled;
          changed = true;
        }
      }
    }
    if (!changed) continue;
    await atomicWriteJson(filePath, data);
    count += 1;
  }
  return count;
}

export async function migrateServerDropEnabledFlags(dataRoot: string): Promise<string | undefined> {
  const count = await dropServerEnabledFlags(dataRoot);
  return count > 0 ? `server-drop-enabled-flags-${count}` : undefined;
}
