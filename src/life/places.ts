// Places and their handles (Living cast spec §5.5, §6.1, §6.9 list_places).
//
// A place is a channel, thread or DM she can use, identified by its placeKey (the conversation key:
// `g_<guild>_<channel>` / `dm_<user>_<waifu>`). Tools take a handle instead:
//   rooms    <server-slug>/#<channel-slug>
//   threads  <server-slug>/#<channel-slug>/<thread-slug>
//   DMs      dm/<name-slug>
// Slugs are lower-case and ASCII-folded. `handles.json` maps every handle she was ever given to its
// place: a handle is never reassigned, a rename adds the new slug as the primary handle and keeps
// the old one as an alias, and collisions get `-2`, `-3` in creation order.

import { AsyncLocalStorage } from "node:async_hooks";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { conversationKey, parseConversationKey, type ConversationRef } from "../orchestration/context/keys.js";
import { listDmStates } from "../orchestration/dm/dmStore.js";
import { channelHasWaifus } from "../orchestration/stores/config.js";
import { withThreadChannels } from "../orchestration/stores/threads.js";
import { ServerConfigSchema, type ServerConfig } from "../shared/schemas/domain.js";
import type { PlaceHandles } from "../shared/schemas/life.js";
import type { StorageService } from "../storage/storageService.js";
import { readLifeFile, updateLifeFile } from "./lifeStore.js";

export type PlaceInfo = {
  placeKey: string;
  kind: "room" | "thread" | "dm";
  ref: ConversationRef;
  guildId?: string;
  channelId?: string;
  userId?: string;
  serverName?: string;
  channelName?: string;
  parentName?: string;
  userName?: string;
  /** Rooms: the server is paused (no wakes, no sends). */
  paused?: boolean;
  /** DMs: when the user last wrote. */
  lastInboundAt?: string;
  lastReplyAt?: string;
};

/** Lower-case, ASCII-folded slug ("Bake Club!" → "bake-club"); "" when nothing is left. */
export function slugify(text: string | undefined): string {
  return (text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

function tail(id: string | undefined): string {
  return (id ?? "").slice(-4) || "x";
}

/** The handle a place wants right now (before collision suffixes). */
export function baseHandle(place: PlaceInfo): string {
  if (place.kind === "dm") return `dm/${slugify(place.userName) || `user-${tail(place.userId)}`}`;
  const server = slugify(place.serverName) || `server-${tail(place.guildId)}`;
  if (place.kind === "thread") {
    const parent = slugify(place.parentName) || "channel";
    return `${server}/#${parent}/${slugify(place.channelName) || `thread-${tail(place.channelId)}`}`;
  }
  return `${server}/#${slugify(place.channelName) || `channel-${tail(place.channelId)}`}`;
}

/** `Bake Club › #general`, `Bake Club › #general › plans`, `DM with Kevin`. */
export function placeLabel(place: PlaceInfo): string {
  if (place.kind === "dm") return `DM with ${place.userName ?? "someone"}`;
  const server = place.serverName ?? "a server";
  if (place.kind === "thread") return `${server} › #${place.parentName ?? "channel"} › ${place.channelName ?? "thread"}`;
  return `${server} › #${place.channelName ?? "channel"}`;
}

/** Assigns handles to places that lack one and refreshes primaries after renames. Pure. */
export function assignHandles(current: Pick<PlaceHandles, "handles" | "primary">, places: readonly PlaceInfo[]): Pick<PlaceHandles, "handles" | "primary"> & { changed: boolean } {
  const handles = { ...current.handles };
  const primary = { ...current.primary };
  let changed = false;
  for (const place of [...places].sort((a, b) => a.placeKey.localeCompare(b.placeKey))) {
    const base = baseHandle(place);
    // The place already owns its wanted handle (or a suffixed form of it): keep its primary.
    const existing = primary[place.placeKey];
    if (existing && (existing === base || new RegExp(`^${escapeRegExp(base)}-\\d+$`).test(existing)) && handles[existing] === place.placeKey) continue;
    let candidate = base;
    for (let n = 2; handles[candidate] !== undefined && handles[candidate] !== place.placeKey; n += 1) candidate = `${base}-${n}`;
    if (handles[candidate] !== place.placeKey) handles[candidate] = place.placeKey;
    if (primary[place.placeKey] !== candidate) {
      primary[place.placeKey] = candidate;
      changed = true;
    }
  }
  return { handles, primary, changed };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readServer(storage: StorageService, guildId: string): Promise<ServerConfig | undefined> {
  try {
    const server = await storage.readJson(path.join("user", "servers", guildId, "server.json"), ServerConfigSchema);
    return await withThreadChannels(storage, server);
  } catch {
    return undefined;
  }
}

async function listServerIds(storage: StorageService): Promise<string[]> {
  try {
    return (await readdir(storage.dataPath("user", "servers"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

const placeCache = new AsyncLocalStorage<Map<string, Promise<PlaceInfo[]>>>();

/**
 * Runs `work` with one place list per waifu (review M5): a turn reads server files and DM states
 * once, not for every handle and tool call. Outside it every call reads afresh.
 */
export function withPlaceCache<T>(work: () => Promise<T>): Promise<T> {
  return placeCache.run(new Map(), work);
}

/** Every place she can use: rooms and threads where she is cast, and DMs with people who DMed her. */
export async function collectPlaces(storage: StorageService, waifuId: string): Promise<PlaceInfo[]> {
  const cache = placeCache.getStore();
  if (!cache) return readPlaces(storage, waifuId);
  const key = `${storage.dataRoot}\0${waifuId}`;
  let cached = cache.get(key);
  if (!cached) {
    cached = readPlaces(storage, waifuId);
    cache.set(key, cached);
    cached.catch(() => cache.delete(key));
  }
  return [...(await cached)];
}

/**
 * Drops this turn's cached place list (N2): a place that appeared during the turn (someone DMed
 * her for the first time, a channel was cast) is read the next time it is asked for. True when a
 * cache was in use (so a second look can find something new).
 */
export function refreshPlaces(storage: StorageService, waifuId: string): boolean {
  const cache = placeCache.getStore();
  if (!cache) return false;
  cache.delete(`${storage.dataRoot}\0${waifuId}`);
  return true;
}

async function readPlaces(storage: StorageService, waifuId: string): Promise<PlaceInfo[]> {
  const places: PlaceInfo[] = [];
  for (const guildId of (await listServerIds(storage)).sort()) {
    const server = await readServer(storage, guildId);
    if (!server) continue;
    for (const [channelId, channel] of Object.entries(server.channels)) {
      if (!channelHasWaifus(channel) || !(channel.enabledWaifuIds ?? []).includes(waifuId)) continue;
      let ref: ConversationRef;
      try {
        ref = { kind: "guild", guildId, channelId };
        conversationKey(ref);
      } catch {
        continue;
      }
      const thread = channel.thread;
      places.push({
        placeKey: conversationKey(ref),
        kind: thread ? "thread" : "room",
        ref,
        guildId,
        channelId,
        ...(server.name ? { serverName: server.name } : {}),
        ...(channel.name ? { channelName: channel.name } : {}),
        ...(thread ? { parentName: server.channels[thread.parentId]?.name ?? thread.parentId } : {}),
        ...(server.paused ? { paused: true } : {})
      });
    }
  }
  for (const state of await listDmStates(storage)) {
    if (state.waifuId !== waifuId || !state.lastInboundMessageId) continue;
    const ref: ConversationRef = { kind: "dm", waifuId, userId: state.userId };
    let key: string;
    try {
      key = conversationKey(ref);
    } catch {
      continue;
    }
    places.push({
      placeKey: key,
      kind: "dm",
      ref,
      userId: state.userId,
      ...(state.userDisplayName ? { userName: state.userDisplayName } : {}),
      ...(state.lastInboundAt ? { lastInboundAt: state.lastInboundAt } : {}),
      ...(state.lastReplyAt ? { lastReplyAt: state.lastReplyAt } : {})
    });
  }
  return places;
}

/** Her places with their handles (assigning and persisting new ones). */
export async function placesWithHandles(storage: StorageService, waifuId: string): Promise<Array<PlaceInfo & { handle: string }>> {
  const places = await collectPlaces(storage, waifuId);
  const current = await readLifeFile(storage, waifuId, "handles");
  let assigned = assignHandles(current, places);
  if (assigned.changed || Object.keys(assigned.handles).length !== Object.keys(current.handles).length) {
    const saved = await updateLifeFile(storage, waifuId, "handles", (file) => {
      const next = assignHandles(file, places);
      return { ...file, handles: next.handles, primary: next.primary };
    });
    assigned = { handles: saved.handles, primary: saved.primary, changed: false };
  }
  return places.map((place) => ({ ...place, handle: assigned.primary[place.placeKey] ?? baseHandle(place) }));
}

export type ResolvedPlace = PlaceInfo & { handle: string };

/**
 * A tool's `place` argument → her place: a handle, an alias or a raw placeKey (§6.1). Undefined
 * when it names nothing she can use.
 */
export async function resolvePlace(storage: StorageService, waifuId: string, input: string): Promise<ResolvedPlace | undefined> {
  const wanted = input.trim().replace(/^<|>$/g, "");
  const find = async () => {
    const places = await placesWithHandles(storage, waifuId);
    const handles = await readLifeFile(storage, waifuId, "handles");
    const key = handles.handles[wanted] ?? handles.handles[wanted.toLowerCase()] ?? (parseConversationKey(wanted) ? wanted : undefined);
    return key ? places.find((place) => place.placeKey === key) : undefined;
  };
  // A miss on this turn's cached list looks again at the current one (a place new since the turn began).
  return (await find()) ?? (refreshPlaces(storage, waifuId) ? await find() : undefined);
}

/** The label a notification uses for a place that is not (or no longer) hers: never the raw key. */
export function unknownPlaceLabel(placeKey: string): string {
  return placeKey.startsWith("dm_") ? "dm/someone" : "a channel you are not in";
}

/** The handle of a placeKey (assigning one when the place is hers), else a readable fallback. */
export async function handleOf(storage: StorageService, waifuId: string, placeKey: string): Promise<string> {
  const handles = await readLifeFile(storage, waifuId, "handles");
  const known = handles.primary[placeKey];
  if (known) return known;
  const lookup = async () => (await placesWithHandles(storage, waifuId)).find((place) => place.placeKey === placeKey)?.handle;
  return (await lookup()) ?? (refreshPlaces(storage, waifuId) ? await lookup() : undefined) ?? unknownPlaceLabel(placeKey);
}

/** Block B's `<places>` (§5.4): her places at epoch start, handle and name. */
export function renderPlacesBlock(places: ReadonlyArray<PlaceInfo & { handle: string }>): string {
  const rooms = places.filter((place) => place.kind !== "dm");
  const dms = places.filter((place) => place.kind === "dm");
  const lines: string[] = [];
  lines.push(rooms.length > 0 ? "Rooms:" : "Rooms: none yet");
  for (const room of rooms) lines.push(`- ${room.handle} (${placeLabel(room)})`);
  lines.push(dms.length > 0 ? "Private chats:" : "Private chats: none yet");
  for (const dm of dms) lines.push(`- ${dm.handle} (${dm.userName ?? "someone"})`);
  return lines.join("\n");
}

/** Drops a place's handles (forget: her DM handle with the person goes, §7.5 step 3). */
export async function dropPlaceHandles(storage: StorageService, waifuId: string, placeKey: string): Promise<number> {
  let removed = 0;
  await updateLifeFile(storage, waifuId, "handles", (file) => {
    const handles = Object.fromEntries(Object.entries(file.handles).filter(([, key]) => key !== placeKey));
    removed = Object.keys(file.handles).length - Object.keys(handles).length;
    const primary = { ...file.primary };
    delete primary[placeKey];
    return { ...file, handles, primary };
  });
  return removed;
}
