// Shared helpers for the memory migration steps (raw JSON, lenient: a migration must never fail
// on a stray malformed record).

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { GuildMemberCacheEntry, MemorySubject } from "../../shared/schemas/domain.js";
import { type SubjectDirectory, buildSubjectDirectory, resolveSubjectNames } from "../../orchestration/memorySubjects.js";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJsonOrUndefined(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export type JsonFileRead =
  | { kind: "missing" }
  | { kind: "invalid"; error: unknown }
  | { kind: "ok"; value: unknown };

/** Distinguishes a missing file from one that exists but does not parse (never conflated). */
export async function readJsonFile(filePath: string): Promise<JsonFileRead> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    throw error;
  }
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch (error) {
    return { kind: "invalid", error };
  }
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Capitalized-token heuristic of the pre-Phase-4 `entities` field. Kept only for the legacy
// `memory-store-v2` step, whose output the next steps convert to subjects.
export function extractLegacyEntities(content: string): string[] {
  const tokens = content.match(/\b\p{Lu}[\p{L}\p{N}'-]*\b/gu) ?? [];
  const sentenceInitial = new Set<string>();
  for (const match of content.matchAll(/(?:^|[.!?]\s+)(\p{Lu}[\p{L}\p{N}'-]*)/gu)) {
    sentenceInitial.add(match[1]!);
  }
  const frequency = new Map<string, number>();
  for (const token of tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  const seen = new Set<string>();
  const entities: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (sentenceInitial.has(token) && (frequency.get(token) ?? 0) < 2) continue;
    entities.push(token);
  }
  return entities.slice(0, 8);
}

async function readConfiguredWaifus(dataRoot: string): Promise<Array<{ id: string; name: string; displayName: string }>> {
  const waifusRoot = path.join(dataRoot, "user", "waifus");
  let entries: string[];
  try {
    entries = await readdir(waifusRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const waifus: Array<{ id: string; name: string; displayName: string }> = [];
  for (const entry of entries.sort()) {
    const data = await readJsonOrUndefined(path.join(waifusRoot, entry, "waifu.json"));
    const id = isObject(data) ? nonEmptyString(data.id) : undefined;
    if (!id || !isObject(data)) continue;
    const name = nonEmptyString(data.name) ?? id;
    waifus.push({ id, name, displayName: nonEmptyString(data.displayName) ?? name });
  }
  return waifus;
}

async function readGuildMembersLeniently(dataRoot: string, guildId: string): Promise<GuildMemberCacheEntry[]> {
  if (!/^[A-Za-z0-9-]+$/.test(guildId)) return [];
  const data = await readJsonOrUndefined(path.join(dataRoot, "user", "servers", guildId, "members.json"));
  if (!isObject(data) || !Array.isArray(data.members)) return [];
  const members: GuildMemberCacheEntry[] = [];
  for (const raw of data.members) {
    if (!isObject(raw)) continue;
    const userId = nonEmptyString(raw.userId);
    if (!userId) continue;
    members.push({
      userId,
      ...(nonEmptyString(raw.username) ? { username: raw.username as string } : {}),
      ...(nonEmptyString(raw.globalDisplayName) ? { globalDisplayName: raw.globalDisplayName as string } : {}),
      ...(nonEmptyString(raw.guildDisplayName) ? { guildDisplayName: raw.guildDisplayName as string } : {}),
      bot: raw.bot === true,
      perChannelLastSeenAt: {}
    });
  }
  return members;
}

/** Per-guild subject directories (that guild's member names + every waifu), memoized. */
export function migrationDirectories(dataRoot: string): (guildId: string | undefined) => Promise<SubjectDirectory> {
  let waifus: Promise<Array<{ id: string; name: string; displayName: string }>> | undefined;
  const cache = new Map<string, Promise<SubjectDirectory>>();
  return (guildId) => {
    const key = guildId ?? "";
    let directory = cache.get(key);
    if (!directory) {
      waifus ??= readConfiguredWaifus(dataRoot);
      directory = Promise.all([waifus, guildId ? readGuildMembersLeniently(dataRoot, guildId) : Promise.resolve([])]).then(
        ([cast, members]) => buildSubjectDirectory(members, cast)
      );
      cache.set(key, directory);
    }
    return directory;
  };
}

/** Legacy display-name entities → subjects: only unique member/waifu name matches survive. */
export function entitiesToSubjects(entities: unknown, directory: SubjectDirectory): MemorySubject[] {
  if (!Array.isArray(entities)) return [];
  return resolveSubjectNames(entities.filter((entity): entity is string => typeof entity === "string"), directory);
}

/** Pre-Phase-4 guild id → provenance guild ("global" was the dashboard's placeholder). */
export function legacyGuildId(value: unknown): string | undefined {
  const guildId = nonEmptyString(value);
  return guildId && guildId !== "global" ? guildId : undefined;
}
