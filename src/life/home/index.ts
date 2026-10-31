// Her machine as the life sees it (Living cast spec §16): her store from her config, the check
// environment from the running app (her clock, the people she knows), and `~/places.md`.

import { readActiveChatParticipants } from "../../orchestration/stores/participants.js";
import { readWaifu } from "../../orchestration/stores/config.js";
import { DEFAULT_APP_CONFIG } from "../../shared/schemas/config.js";
import { listDmStates } from "../../orchestration/dm/dmStore.js";
import type { WaifuConfig } from "../../shared/schemas/domain.js";
import type { StorageService } from "../../storage/storageService.js";
import { dayTimeText } from "../clock.js";
import type { LifeDeps } from "../deps.js";
import { resolvePerson } from "../people.js";
import { collectPlaces, placeLabel, placesWithHandles, type PlaceInfo } from "../places.js";
import { normalizeName } from "../text.js";
import { HomeStore, homeLimitsOf, type CheckEnv } from "./homeStore.js";
import { herSlug } from "./pathRules.js";
import { emojiListText, emojiUsage } from "./serverEmojis.js";
import type { PersonResolution } from "./specialFiles.js";

export { HomeStore, homeLimitsOf } from "./homeStore.js";

/** Her store (her slug from her name as configured now). */
export function homeStoreFor(deps: Pick<LifeDeps, "storage" | "config"> & Partial<Pick<LifeDeps, "notices" | "now">>, waifu: Pick<WaifuConfig, "id" | "name">): HomeStore {
  return new HomeStore(deps.storage, waifu.id, herSlug(waifu), () => homeLimitsOf(deps.config().life), {
    ...(deps.now ? { now: deps.now } : {}),
    onCorruptSide: (name) =>
      deps.notices?.set(
        `home-side:${waifu.id}:${name}`,
        `${waifu.name}'s life/${name} could not be read and was replaced (a copy is kept beside it); reminders or watches that were due before now were dropped without firing.`
      )
  });
}

/** Checks with the live app: `from` names resolve against everyone she can see. */
export function checkEnvFor(deps: LifeDeps, waifuId: string): CheckEnv {
  return {
    now: deps.now(),
    timeZone: deps.timeZone,
    resolvePerson: async (name) => resolvePerson(deps, await collectPlaces(deps.storage, waifuId), name),
    ...(deps.web?.fetchOffered() === false ? { pagesOff: true } : {})
  };
}

/**
 * Checks without the live app (the API while Discord is offline): a `from` resolves to `<@id>` or to
 * a person she has a private chat with; anyone else waits until the app runs.
 */
export function offlineCheckEnv(storage: StorageService, waifuId: string, o: { now: Date; timeZone: string }): CheckEnv {
  return {
    now: o.now,
    timeZone: o.timeZone,
    resolvePerson: async (name): Promise<PersonResolution> => {
      const trimmed = name.trim();
      const mention = /^<@!?(\d{5,25})>$/u.exec(trimmed) ?? /^(\d{15,25})$/u.exec(trimmed);
      if (mention) return { ok: true, userId: mention[1]!, name: mention[1]! };
      const wanted = normalizeName(trimmed.replace(/^@/u, ""));
      const matches = (await listDmStates(storage).catch(() => [])).filter((state) => state.waifuId === waifuId && state.userDisplayName && normalizeName(state.userDisplayName) === wanted);
      const ids = [...new Set(matches.map((state) => state.userId))];
      if (ids.length === 1) return { ok: true, userId: ids[0]!, name: matches[0]!.userDisplayName! };
      if (ids.length > 1) return { ok: false, error: `more than one person called ${trimmed}; use their place or <@id>` };
      return { ok: false, error: `she doesn't know anyone called ${trimmed} (with Discord offline only her private chats can be named; or use <@id>)` };
    }
  };
}

const DAY_MS = 24 * 3_600_000;

export const PLACES_FILE_NOTE = "(This file is kept up to date for you: you can read it, but changes to it are refused.)";

/**
 * One line per server she is cast in that has usable emojis (§28): `- bake-club (Bake Club): :a: :b:
 * (+N more)`, the server named as her handles name it, in the order her rooms list the servers.
 */
async function serverEmojiLines(deps: LifeDeps, places: ReadonlyArray<PlaceInfo & { handle: string }>): Promise<string[]> {
  const servers = new Map<string, { slug: string; name?: string }>();
  for (const place of places) {
    if (!place.guildId || servers.has(place.guildId)) continue;
    servers.set(place.guildId, { slug: place.handle.split("/")[0]!, ...(place.serverName ? { name: place.serverName } : {}) });
  }
  const lines: string[] = [];
  for (const [guildId, server] of servers) {
    const emojis = await deps.directory.availableEmojis(guildId).catch(() => []);
    if (emojis.length === 0) continue;
    const counts = await emojiUsage({ dataRoot: deps.storage.dataRoot, timeZone: deps.timeZone, guildId, now: deps.now() });
    const list = emojiListText(emojis, counts);
    if (list) lines.push(`- ${server.slug}${server.name ? ` (${server.name})` : ""}: ${list}`);
  }
  return lines;
}

/**
 * `~/places.md` (§16.6): her rooms with who was around today and when, her servers' emojis (§28)
 * and her private chats.
 */
export async function placesFileText(deps: LifeDeps, waifuId: string): Promise<string> {
  const places = await placesWithHandles(deps.storage, waifuId);
  const now = deps.now();
  const rooms: string[] = [];
  const dms: string[] = [];
  const emojis = await serverEmojiLines(deps, places);
  for (const place of places) {
    const buffered = deps.conversations.bufferedMessages(place.ref);
    const newest = buffered[buffered.length - 1]?.createdAt;
    if (place.kind === "dm") {
      const last = [place.lastInboundAt, place.lastReplyAt, newest].filter((value): value is string => Boolean(value)).sort().pop();
      dms.push(`- ${place.handle} (${place.userName ?? "someone"})${last ? ` · last message ${dayTimeText(new Date(last), deps.timeZone)}` : ""}`);
      continue;
    }
    const participants = place.guildId && place.channelId ? await readActiveChatParticipants(deps.storage, place.guildId, place.channelId).catch(() => []) : [];
    const seen = participants.filter((person) => now.getTime() - Date.parse(person.lastSeenAt) < DAY_MS).map((person) => person.displayName);
    const last = [newest, ...participants.map((person) => person.lastSeenAt)].filter((value): value is string => Boolean(value)).sort().pop();
    const parts = [`- ${place.handle} (${placeLabel(place)})`];
    if (place.paused) parts.push("paused");
    parts.push(seen.length > 0 ? `people today: ${[...new Set(seen)].slice(0, 12).join(", ")}` : "nobody seen today");
    if (last) parts.push(`last activity ${dayTimeText(new Date(last), deps.timeZone)}`);
    rooms.push(parts.join(" · "));
  }
  return [
    "# Your places",
    PLACES_FILE_NOTE,
    "",
    rooms.length > 0 ? "Rooms:" : "Rooms: none",
    ...rooms,
    "",
    ...(emojis.length > 0 ? ["Server emojis:", ...emojis, ""] : []),
    dms.length > 0 ? "Private chats:" : "Private chats: none",
    ...dms,
    ""
  ].join("\n");
}

/**
 * `~/profile.json` from her config after a dashboard, CLI or HTTP edit (spec §17.1); written only
 * when it says something else. Works with or without the running cast.
 */
export async function rewriteProfileFile(storage: StorageService, waifuId: string): Promise<boolean> {
  const waifu = await readWaifu(storage, waifuId);
  return new HomeStore(storage, waifuId, herSlug(waifu), () => homeLimitsOf(DEFAULT_APP_CONFIG.life)).writeProfileFromConfig();
}

/** Rewrites `~/places.md` when it would change. */
export async function refreshPlacesFile(deps: LifeDeps, waifu: Pick<WaifuConfig, "id" | "name">): Promise<boolean> {
  return homeStoreFor(deps, waifu).writePlaces(await placesFileText(deps, waifu.id));
}
