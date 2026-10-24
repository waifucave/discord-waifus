import { rename, stat } from "node:fs/promises";
import path from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../../shared/schemas/common.js";
import { atomicWriteJson } from "../../storage/atomic.js";
import { isObject, nonEmptyString, readJsonFile } from "./memorySupport.js";

const SOURCE = path.join("user", "orchestrator", "history.json");
const LEGACY = path.join("user", "orchestrator", "history-legacy.json");
const CAP_PER_GUILD = 300;
const SAFE_GUILD_DIR = /^[A-Za-z0-9._:-]+$/;

// Step `orchestrator-history-per-guild-v1` (spec 9.3): the global `user/orchestrator/history.json`
// is split by `guildId` into `user/servers/<guildId>/orchestrator-history.json` (newest first,
// capped at 300 per guild). Entries with no usable guild go to `user/orchestrator/history-legacy.json`.
// Entries merge by id into whatever a target file already holds (the existing copy wins), so a
// re-run after a crash between the writes and the rename duplicates nothing. The source is renamed
// to `history.json.migrated` last. A missing source is a no-op; an unreadable one fails the boot
// (like the memory steps) so the ledger never records the step as applied over data it could not
// read: after the user repairs or removes the file it still converts.
// CHANGED (review I3): an unreadable source (or target) must not fail boot. It is renamed to
// `<file>.corrupt-<timestamp>` with one warning and the step carries on, so the broken bytes stay
// available for manual repair. The step runs on every boot (a missing source is a no-op), so a
// rollback to an older build that reseeds `history.json` is split again on the next upgrade.
// Entries of guilds without a `server.json` (deleted or departed servers) go to the legacy file:
// they must never recreate a server folder.
export async function migrateOrchestratorHistoryPerGuild(dataRoot: string): Promise<string | undefined> {
  const sourcePath = path.join(dataRoot, SOURCE);
  const read = await readJsonFile(sourcePath);
  if (read.kind === "missing") return undefined;
  if (read.kind === "invalid" || !isObject(read.value) || !Array.isArray(read.value.decisions)) {
    const quarantined = await quarantine(sourcePath);
    console.warn(`user/orchestrator/history.json is not a readable decision history; moved it to ${path.basename(quarantined)} and continuing.`);
    return undefined;
  }

  const byGuild = new Map<string, Record<string, unknown>[]>();
  const legacy: Record<string, unknown>[] = [];
  for (const entry of read.value.decisions) {
    if (!isObject(entry) || !nonEmptyString(entry.id) || !nonEmptyString(entry.createdAt)) continue;
    const guildId = nonEmptyString(entry.guildId);
    if (guildId && SAFE_GUILD_DIR.test(guildId) && !/^\.+$/.test(guildId) && (await hasServerFile(dataRoot, guildId))) {
      const list = byGuild.get(guildId) ?? [];
      list.push(entry);
      byGuild.set(guildId, list);
    } else {
      legacy.push(entry);
    }
  }

  let moved = 0;
  for (const [guildId, entries] of byGuild) {
    moved += await mergeInto(path.join(dataRoot, "user", "servers", guildId, "orchestrator-history.json"), entries, CAP_PER_GUILD);
  }
  if (legacy.length > 0) moved += await mergeInto(path.join(dataRoot, LEGACY), legacy, undefined);

  await rename(sourcePath, `${sourcePath}.migrated`);
  return `migrate-orchestrator-history-per-guild-${moved}`;
}

async function mergeInto(filePath: string, incoming: Record<string, unknown>[], cap: number | undefined): Promise<number> {
  const read = await readJsonFile(filePath);
  let existing: (Record<string, unknown> & { decisions: unknown[] }) | undefined;
  if (read.kind === "invalid" || (read.kind === "ok" && (!isObject(read.value) || !Array.isArray(read.value.decisions)))) {
    const quarantined = await quarantine(filePath);
    console.warn(`${path.basename(path.dirname(filePath))}/${path.basename(filePath)} is unreadable; moved it to ${path.basename(quarantined)} and writing a fresh history.`);
  } else if (read.kind === "ok") {
    existing = read.value as Record<string, unknown> & { decisions: unknown[] };
  }
  const seen = new Set<string>();
  const merged: Record<string, unknown>[] = [];
  for (const entry of [...(existing?.decisions ?? []), ...incoming]) {
    if (!isObject(entry) || typeof entry.id !== "string" || seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  // Newest first; the sort is stable, so equal timestamps keep their file order.
  merged.sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? 1 : String(a.createdAt) > String(b.createdAt) ? -1 : 0));
  const decisions = cap === undefined ? merged : merged.slice(0, cap);
  const previousRevision = existing && typeof existing.revision === "number" ? existing.revision : 0;
  await atomicWriteJson(filePath, {
    ...(existing ?? {}),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    revision: previousRevision + 1,
    updatedAt: new Date().toISOString(),
    decisions
  });
  return incoming.length;
}

async function hasServerFile(dataRoot: string, guildId: string): Promise<boolean> {
  return stat(path.join(dataRoot, "user", "servers", guildId, "server.json")).then((info) => info.isFile(), () => false);
}

async function quarantine(filePath: string): Promise<string> {
  const target = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await rename(filePath, target);
  return target;
}
