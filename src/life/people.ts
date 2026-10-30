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
import { foldName, normalizeName } from "./text.js";

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

/** A name or note title as folded words ("Tom's birthday" → tom s birthday, "Tom & Lou" → tom and lou). */
function nameWords(text: string): string[] {
  return foldName(text.replace(/&/gu, " and "))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Words after a title's first word that make it about something of theirs, or about several people. */
const NOT_ONLY_THEM = new Set(["s", "and", "n", "x", "vs", "with"]);

/**
 * Whether a note title (a file name, a heading, a `Name:` first line) is about someone going by `name`
 * (§35.3): the title is the whole name or its first word; or, for a one-word name, the title starts
 * with it and goes on with something other than a possessive or "and" ("jade-lee", "Kevin (bake
 * club)"; not "Tom's birthday" or "tom-and-lou-movie-night").
 */
function titleNames(title: readonly string[], name: readonly string[]): boolean {
  if (title.length === 0 || name.length === 0) return false;
  const whole = title.join(" ");
  if (whole === name.join(" ") || whole === name[0]) return true;
  return name.length === 1 && title[0] === name[0] && !NOT_ONLY_THEM.has(title[1] ?? "");
}

/** Every Markdown heading's text (any level), and the first line's text before a colon ("Rosa: duo partner"). */
function noteTitles(text: string): string[] {
  const titles = [...text.matchAll(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/gmu)].map((match) => match[1]!);
  const first = text.split("\n").find((line) => line.trim())?.trim();
  if (first && !first.startsWith("#") && first.includes(":")) titles.push(first.slice(0, first.indexOf(":")));
  return titles;
}

/**
 * Whether her home has a note about this person (spec §35.3), by any name they go by (`names`: the
 * window's and those `knownPeople` has): a file (outside `~/life/`, MEMORY.md aside) named after them
 * (`people/aiko.md`, `jade-lee.md`), a heading of any level naming them (`## Aiko` in `friends.md`), a
 * `Name:` first line, or a `<!-- user:<id> -->` mark. Being mentioned in another note does not count.
 */
export function hasNoteFor(notes: ReadonlyMap<string, string>, person: { userId: string; names: readonly string[] }): boolean {
  const names = person.names.map(nameWords).filter((words) => words.join(" ").length >= 2);
  if (names.length === 0) return true;
  for (const [notePath, text] of notes) {
    if (notePath === "MEMORY.md" || notePath.startsWith("life/")) continue;
    if (text.includes(`<!-- user:${person.userId} -->`)) return true;
    const stem = notePath.split("/").at(-1)!.replace(/\.[^.]+$/u, "");
    if ([stem, ...noteTitles(text)].some((candidate) => names.some((name) => titleNames(nameWords(candidate), name)))) return true;
  }
  return false;
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
