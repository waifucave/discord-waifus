// People as a life sees them (Living cast spec §6.5 `from`, §7.5): her own author ids, the forget
// records' "(removed)" rule, and the people she knows by name (guild directory members of her
// servers, recent authors in her places, DM users).

import { readDiscordBotsFile } from "../orchestration/stores/config.js";
import { readForgottenPeople, type ForgottenPerson } from "../orchestration/dm/forgotten.js";
import type { WaifuConfig } from "../shared/schemas/domain.js";
import type { StorageService } from "../storage/storageService.js";
import type { LifeDeps } from "./deps.js";
import type { PlaceInfo } from "./places.js";
import { memberDisplayName } from "../discord/directoryView.js";
import { normalizeName } from "./text.js";

/** Her bot's Discord ids (the bot id and its application id). */
export async function selfAuthorIds(storage: StorageService, waifu: Pick<WaifuConfig, "botId">): Promise<string[]> {
  if (!waifu.botId) return [];
  const bots = await readDiscordBotsFile(storage).catch(() => undefined);
  const bot = bots?.waifus.find((candidate) => candidate.id === waifu.botId);
  return [...new Set([waifu.botId, ...(bot?.applicationId ? [bot.applicationId] : [])])];
}

/**
 * §7.5 step 1: a forgotten user's messages written at or before the forget time render as
 * `(removed)`; newer ones render normally.
 */
export function isRemovedMessage(message: { authorId: string; createdAt: string }, forgotten: readonly ForgottenPerson[]): boolean {
  const at = Date.parse(message.createdAt);
  return forgotten.some((person) => person.userId === message.authorId && Number.isFinite(at) && at <= Date.parse(person.at));
}

/** The forget records (a corrupt file throws `ForgetRecordCorruptError`: never "nobody forgotten"). */
export function forgottenPeople(storage: StorageService): Promise<ForgottenPerson[]> {
  return readForgottenPeople(storage);
}

export type KnownPerson = { userId: string; names: string[] };

/** People she can name: members of her servers, recent authors in her places, her DM users. */
export async function knownPeople(deps: LifeDeps, places: readonly PlaceInfo[]): Promise<KnownPerson[]> {
  const people = new Map<string, Set<string>>();
  const add = (userId: string, name: string | undefined) => {
    if (!userId || !name?.trim()) return;
    let names = people.get(userId);
    if (!names) people.set(userId, (names = new Set()));
    names.add(name.trim());
  };
  const guilds = new Set(places.flatMap((place) => (place.guildId ? [place.guildId] : [])));
  for (const guildId of guilds) {
    const members = await deps.directory.members(guildId).catch(() => []);
    for (const member of members) {
      if (member.bot) continue;
      add(member.userId, memberDisplayName(member));
      add(member.userId, member.username);
      add(member.userId, member.globalDisplayName);
    }
  }
  for (const place of places) {
    if (place.kind === "dm" && place.userId) add(place.userId, place.userName);
    for (const message of deps.conversations.bufferedMessages(place.ref)) {
      if (!message.authorIsBot) add(message.authorId, message.authorName);
    }
  }
  return [...people].map(([userId, names]) => ({ userId, names: [...names] }));
}

export type PersonLookup = { ok: true; userId: string; name: string } | { ok: false; error: string };

/** `<@123>` / `123` → that id; a name → the one person she knows by it (§6.5). */
export async function resolvePerson(deps: LifeDeps, places: readonly PlaceInfo[], input: string): Promise<PersonLookup> {
  const trimmed = input.trim();
  const mention = /^<@!?(\d{5,25})>$/.exec(trimmed) ?? /^(\d{15,25})$/.exec(trimmed);
  const people = await knownPeople(deps, places);
  if (mention) {
    const userId = mention[1]!;
    return { ok: true, userId, name: people.find((person) => person.userId === userId)?.names[0] ?? userId };
  }
  const wanted = normalizeName(trimmed.replace(/^@/, ""));
  if (!wanted) return { ok: false, error: "error: name the person or use <@id>" };
  const matches = people.filter((person) => person.names.some((name) => normalizeName(name) === wanted));
  if (matches.length === 1) return { ok: true, userId: matches[0]!.userId, name: matches[0]!.names[0]! };
  if (matches.length > 1) return { ok: false, error: `error: more than one person called ${trimmed.replace(/^@/, "")}; use <@id>` };
  return { ok: false, error: `error: you don't know anyone called ${trimmed.replace(/^@/, "")}; use <@id>` };
}
