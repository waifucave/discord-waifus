// DM persistence (spec 9.1): the per-conversation DM state and the per-(waifu, user) rate-limit
// counters, plus DM eligibility.
//
// Layout is user-first so owner-initiated per-user deletion is one directory:
//   user/dms/<userId>/<waifuId>.json          DmState      (resource `dm:<userId>:<waifuId>`)
//   user/dms/<userId>/limits/<waifuId>.json   DmLimitState (resource `dm-limit:<userId>:<waifuId>`)
// The two files are separate so a user's /forget can never reset the limiter.

import { readdir } from "node:fs/promises";
import path from "node:path";
import { DmLimitStateSchema, DmStateSchema, type DmLimitState, type DmState } from "../../shared/schemas/dm.js";
import { createEmptyRevisionedFile, type DiscordBotsFile, type WaifuConfig } from "../../shared/schemas/domain.js";
import type { StorageService } from "../../storage/storageService.js";

// Same alphabets as conversation keys: a user id is a Discord id, a waifu id the API's safe id.
const USER_ID = /^[A-Za-z0-9-]+$/;
const WAIFU_ID = /^[A-Za-z0-9._:-]+$/;

function assertIds(userId: string, waifuId: string): void {
  if (typeof userId !== "string" || !USER_ID.test(userId)) throw new Error(`Invalid DM user id: ${String(userId)}`);
  if (typeof waifuId !== "string" || !WAIFU_ID.test(waifuId) || /^\.+$/.test(waifuId)) {
    throw new Error(`Invalid DM waifu id: ${String(waifuId)}`);
  }
}

export function dmUserDir(userId: string): string {
  if (typeof userId !== "string" || !USER_ID.test(userId)) throw new Error(`Invalid DM user id: ${String(userId)}`);
  return path.join("user", "dms", userId);
}

export function dmStatePath(userId: string, waifuId: string): string {
  assertIds(userId, waifuId);
  return path.join("user", "dms", userId, `${waifuId}.json`);
}

export function dmLimitPath(userId: string, waifuId: string): string {
  assertIds(userId, waifuId);
  return path.join("user", "dms", userId, "limits", `${waifuId}.json`);
}

export const dmStateResource = (userId: string, waifuId: string) => `dm:${userId}:${waifuId}`;
export const dmLimitResource = (userId: string, waifuId: string) => `dm-limit:${userId}:${waifuId}`;

function emptyState(userId: string, waifuId: string, botId: string): DmState {
  return DmStateSchema.parse(createEmptyRevisionedFile({ userId, waifuId, botId }));
}

function emptyLimit(userId: string, waifuId: string): DmLimitState {
  return DmLimitStateSchema.parse(createEmptyRevisionedFile({ userId, waifuId }));
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** The DM state, or undefined when none was ever written (never creates the file). */
export async function readDmState(storage: StorageService, userId: string, waifuId: string): Promise<DmState | undefined> {
  try {
    return await storage.readJson(dmStatePath(userId, waifuId), DmStateSchema);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function updateDmState(
  storage: StorageService,
  key: { userId: string; waifuId: string; botId: string },
  transform: (current: DmState) => DmState
): Promise<DmState> {
  return storage.updateRevisionedJson({
    resourceKey: dmStateResource(key.userId, key.waifuId),
    relativePath: dmStatePath(key.userId, key.waifuId),
    schema: DmStateSchema,
    fallback: emptyState(key.userId, key.waifuId, key.botId),
    transform
  });
}

/** Update only an existing state file (pause/forget must not create one). */
export async function updateExistingDmState(
  storage: StorageService,
  userId: string,
  waifuId: string,
  transform: (current: DmState) => DmState
): Promise<DmState | undefined> {
  const current = await readDmState(storage, userId, waifuId);
  if (!current) return undefined;
  return updateDmState(storage, { userId, waifuId, botId: current.botId }, transform);
}

export async function readDmLimit(storage: StorageService, userId: string, waifuId: string): Promise<DmLimitState> {
  return storage.readJson(dmLimitPath(userId, waifuId), DmLimitStateSchema, emptyLimit(userId, waifuId));
}

export async function readDmLimitIfExists(storage: StorageService, userId: string, waifuId: string): Promise<DmLimitState | undefined> {
  try {
    return await storage.readJson(dmLimitPath(userId, waifuId), DmLimitStateSchema);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function updateDmLimit(
  storage: StorageService,
  userId: string,
  waifuId: string,
  transform: (current: DmLimitState) => DmLimitState
): Promise<DmLimitState> {
  return storage.updateRevisionedJson({
    resourceKey: dmLimitResource(userId, waifuId),
    relativePath: dmLimitPath(userId, waifuId),
    schema: DmLimitStateSchema,
    fallback: emptyLimit(userId, waifuId),
    transform
  });
}

async function listDir(storage: StorageService, ...segments: string[]) {
  try {
    return await readdir(storage.dataPath(...segments), { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** Users with a DM directory. */
export async function listDmUserIds(storage: StorageService): Promise<string[]> {
  return (await listDir(storage, "user", "dms"))
    .filter((entry) => entry.isDirectory() && USER_ID.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** Every DM state file (`user/dms/*\/*.json`; the `limits/` subdirectory is not matched). */
export async function listDmStates(storage: StorageService): Promise<DmState[]> {
  const states: DmState[] = [];
  for (const userId of await listDmUserIds(storage)) {
    for (const entry of await listDir(storage, "user", "dms", userId)) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const waifuId = entry.name.slice(0, -5);
      if (!WAIFU_ID.test(waifuId) || /^\.+$/.test(waifuId)) continue;
      const state = await readDmState(storage, userId, waifuId).catch(() => undefined);
      if (state) states.push(state);
    }
  }
  return states;
}

/** Waifu ids with a limits file for the user. */
export async function listDmLimitWaifuIds(storage: StorageService, userId: string): Promise<string[]> {
  return (await listDir(storage, "user", "dms", userId, "limits"))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -5))
    .sort();
}

// ---- eligibility (spec 9.1 "Intents and eligibility") --------------------------------------------

export type DmEligibleWaifu = { waifuId: string; botId: string };

export type DmEligibility = {
  eligible: DmEligibleWaifu[];
  /** `dm_bot_shared:<botId>`, `dm_missing_model:<waifuId>`. */
  warnings: string[];
};

/**
 * Waifu W is DM-eligible on bot B iff W is enabled with `dm.allowDms`, has a model, links to B,
 * B is an enabled waifu bot (not the House bot) and exactly one enabled waifu links to B.
 */
export function computeDmEligibility(
  waifus: readonly WaifuConfig[],
  bots: Pick<DiscordBotsFile, "waifus" | "orchestrator">
): DmEligibility {
  const eligible: DmEligibleWaifu[] = [];
  const warnings = new Set<string>();
  const houseId = bots.orchestrator?.id;
  for (const waifu of waifus) {
    if (!waifu.enabled || !waifu.dm?.allowDms || !waifu.botId) continue;
    const bot = bots.waifus.find((candidate) => candidate.id === waifu.botId);
    if (!bot || bot.enabled === false || bot.id === houseId) continue;
    const linked = waifus.filter((candidate) => candidate.enabled && candidate.botId === bot.id);
    if (linked.length !== 1) {
      warnings.add(`dm_bot_shared:${bot.id}`);
      continue;
    }
    if (!waifu.model) {
      warnings.add(`dm_missing_model:${waifu.id}`);
      continue;
    }
    eligible.push({ waifuId: waifu.id, botId: bot.id });
  }
  return { eligible: eligible.sort((a, b) => a.waifuId.localeCompare(b.waifuId)), warnings: [...warnings].sort() };
}

// ---- forget floor (spec 9.1.4) ---------------------------------------------------------------

const DISCORD_EPOCH_MS = 1_420_070_400_000n;

/** The smallest snowflake Discord could assign at `at`: every earlier message's id is below it. */
export function dmFloorAt(at: Date): string {
  return ((BigInt(at.getTime()) - DISCORD_EPOCH_MS) << 22n).toString();
}

/** Snowflake order (numeric strings: longer is larger). */
export function compareSnowflakes(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The later of two floors: a forget only ever raises the floor, never lowers it. */
export function laterFloor(current: string | undefined, next: string): string {
  return current !== undefined && compareSnowflakes(current, next) > 0 ? current : next;
}

/** True when the message is newer than the floor (or there is none). */
export function aboveFloor(messageId: string, floor: string | undefined): boolean {
  return floor === undefined || compareSnowflakes(messageId, floor) > 0;
}

/** The forget floor of a DM conversation (undefined when it was never forgotten). */
export async function readDmFloor(storage: StorageService, userId: string, waifuId: string): Promise<string | undefined> {
  return (await readDmLimitIfExists(storage, userId, waifuId))?.floorMessageId;
}
