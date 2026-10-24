// Conversation keys (place keys, Living cast §5.5) and the on-disk locations derived from them.
// Pure helpers: no I/O. Path helpers return data-root-relative paths (the form StorageService
// takes) and are validated through resolveDataPath so a malformed key can never escape the root.

import os from "node:os";
import path from "node:path";
import { resolveDataPath } from "../../config/paths.js";

export type ConversationRef =
  | { kind: "guild"; guildId: string; channelId: string } // channelId may be a thread id (spec 9.5)
  | { kind: "dm"; waifuId: string; userId: string };

export type ConversationKey = string & { readonly __brand: "ConversationKey" };

// Discord ids (guild, channel, thread, user) become key segments split on "_", so they must not
// contain it. Real ids are snowflakes (digits); tests may use short ASCII fakes.
const DISCORD_ID = /^[A-Za-z0-9-]+$/;
// Waifu ids follow the API's assertSafeId alphabet (they may contain "_"), dot-only ids refused.
const WAIFU_ID = /^[A-Za-z0-9._:-]+$/;

function assertDiscordId(id: string, label: string): void {
  if (typeof id !== "string" || !DISCORD_ID.test(id)) throw new Error(`Invalid ${label}: ${String(id)}`);
}

function assertWaifuId(id: string): void {
  if (typeof id !== "string" || !WAIFU_ID.test(id) || /^\.+$/.test(id)) {
    throw new Error(`Invalid waifu id: ${String(id)}`);
  }
}

/** "g_<guild>_<channel>" | "dm_<user>_<waifu>". Throws on ids that would break the encoding. */
export function conversationKey(ref: ConversationRef): ConversationKey {
  if (ref.kind === "guild") {
    assertDiscordId(ref.guildId, "guild id");
    assertDiscordId(ref.channelId, "channel id");
    return `g_${ref.guildId}_${ref.channelId}` as ConversationKey;
  }
  assertDiscordId(ref.userId, "user id");
  assertWaifuId(ref.waifuId);
  return `dm_${ref.userId}_${ref.waifuId}` as ConversationKey;
}

export function parseConversationKey(key: string): ConversationRef | undefined {
  if (typeof key !== "string") return undefined;
  const guild = /^g_([A-Za-z0-9-]+)_([A-Za-z0-9-]+)$/.exec(key);
  if (guild) return { kind: "guild", guildId: guild[1]!, channelId: guild[2]! };
  // The waifu id may itself contain "_", so the user id is everything up to the first "_".
  const dm = /^dm_([A-Za-z0-9-]+)_(.+)$/.exec(key);
  if (dm && WAIFU_ID.test(dm[2]!) && !/^\.+$/.test(dm[2]!)) {
    return { kind: "dm", userId: dm[1]!, waifuId: dm[2]! };
  }
  return undefined;
}

// The key is a branded string that callers could forge with a cast, so every path helper
// re-validates it, then proves containment under a probe data root.
function conversationDir(k: ConversationKey): string[] {
  if (!parseConversationKey(k)) throw new Error(`Invalid conversation key: ${String(k)}`);
  return ["user", "conversations", k];
}

function contained(segments: string[]): string {
  const probeRoot = path.resolve(os.tmpdir(), "dc-waifus-path-probe");
  resolveDataPath(probeRoot, ...segments);
  return path.join(...segments);
}

/** user/conversations/<k> (the whole conversation directory). */
export function conversationDirPath(k: ConversationKey): string {
  return contained(conversationDir(k));
}

/** user/conversations/<k>/refs.json */
export function conversationRefsPath(k: ConversationKey): string {
  return contained([...conversationDir(k), "refs.json"]);
}

/** Numeric compare of Discord snowflakes (BigInt): negative, 0 or positive. */
export function compareSnowflakes(a: string, b: string): number {
  if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) {
    throw new TypeError(`Snowflakes must be decimal strings: ${String(a)}, ${String(b)}`);
  }
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
