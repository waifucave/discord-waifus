// Memory subjects (spec 8.8): who a memory is about, keyed by stable ids. Replaces the old
// capitalized-token `entities` heuristic. Pure helpers plus a small loader for the subject
// directory (guild member caches + configured waifus).

import path from "node:path";
import {
  GuildMembersFileSchema,
  type GuildMemberCacheEntry,
  type MemorySubject,
  type WaifuConfig,
  createEmptyRevisionedFile
} from "../shared/schemas/domain.js";
import type { StorageService } from "../storage/storageService.js";
import type { Participant } from "./context/types.js";
import { listWaifus } from "./stores/config.js";

// Waifu-tool notes sit between ephemeral chatter and user memories; both the migration and the
// live write path must agree on this value.
export const WAIFU_NOTE_STRENGTH = 2;

/** Canonical form for name comparisons (NFKC, case-folded, whitespace collapsed). */
export function normalizeName(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

export type SubjectDirectoryMember = { userId: string; names: string[] };
export type SubjectDirectoryWaifu = { id: string; names: string[]; displayName: string };

/** Everything needed to resolve names to subjects and refresh subject names at render time. */
export type SubjectDirectory = {
  members: SubjectDirectoryMember[]; // human members only (bots are resolved as waifus)
  waifus: SubjectDirectoryWaifu[];
};

function memberNames(member: GuildMemberCacheEntry): string[] {
  return [member.guildDisplayName, member.globalDisplayName, member.username].filter(
    (name): name is string => typeof name === "string" && name.trim().length > 0
  );
}

export function buildSubjectDirectory(
  members: GuildMemberCacheEntry[],
  waifus: Array<Pick<WaifuConfig, "id" | "name" | "displayName">>
): SubjectDirectory {
  return {
    members: members.filter((member) => !member.bot).map((member) => ({ userId: member.userId, names: memberNames(member) })),
    waifus: waifus.map((waifu) => ({
      id: waifu.id,
      displayName: waifu.displayName || waifu.name,
      names: [...new Set([waifu.displayName, waifu.name].filter(Boolean))]
    }))
  };
}

/** Member cache of one guild (empty when unknown) plus every configured waifu. */
export async function loadSubjectDirectory(storage: StorageService, guildId?: string): Promise<SubjectDirectory> {
  const [members, waifus] = await Promise.all([
    guildId ? readGuildMembers(storage, guildId) : Promise.resolve([]),
    listWaifus(storage).catch(() => [] as WaifuConfig[])
  ]);
  return buildSubjectDirectory(members, waifus);
}

export async function readGuildMembers(storage: StorageService, guildId: string): Promise<GuildMemberCacheEntry[]> {
  try {
    const file = await storage.readJson(
      path.join("user", "servers", guildId, "members.json"),
      GuildMembersFileSchema,
      GuildMembersFileSchema.parse(createEmptyRevisionedFile({ guildId, members: [] }))
    );
    return file.members;
  } catch {
    return [];
  }
}

/**
 * Resolve one display name to a subject only when it UNIQUELY matches a human member name or a
 * waifu name (ambiguous and unknown names resolve to undefined: the old entities were
 * capitalized words, not necessarily people).
 */
export function resolveSubjectName(name: string, directory: SubjectDirectory): MemorySubject | undefined {
  const key = normalizeName(name);
  if (!key) return undefined;
  const members = directory.members.filter((member) => member.names.some((candidate) => normalizeName(candidate) === key));
  const waifus = directory.waifus.filter(
    (waifu) => normalizeName(waifu.id) === key || waifu.names.some((candidate) => normalizeName(candidate) === key)
  );
  if (members.length + waifus.length !== 1) return undefined;
  if (members.length === 1) return { discordUserId: members[0]!.userId, name: name.trim() };
  return { waifuId: waifus[0]!.id, name: waifus[0]!.displayName };
}

/** Resolve a list of names; unresolvable or ambiguous names are dropped, duplicates collapsed. */
export function resolveSubjectNames(names: string[], directory: SubjectDirectory): MemorySubject[] {
  return dedupeSubjects(
    names.map((name) => resolveSubjectName(name, directory)).filter((s): s is MemorySubject => s !== undefined)
  );
}

/** True when `name` occurs in `text` as a whole word (any occurrence for CJK names); NFKC, case-folded. */
export function wordBoundaryIncludes(text: string, name: string): boolean {
  const normalizedName = normalizeName(name);
  if (normalizedName.length < 2) return false;
  const haystack = normalizeName(text);
  let index = haystack.indexOf(normalizedName);
  while (index >= 0) {
    const before = index === 0 ? "" : haystack[index - 1]!;
    const after = haystack[index + normalizedName.length] ?? "";
    const isWordChar = (ch: string) => /[\p{L}\p{N}]/u.test(ch);
    // CJK names have no word boundaries; accept any occurrence.
    const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(normalizedName);
    if (cjk || ((!before || !isWordChar(before)) && (!after || !isWordChar(after)))) return true;
    index = haystack.indexOf(normalizedName, index + 1);
  }
  return false;
}

/**
 * Subjects named in free text: every directory entry (member or waifu) one of whose names
 * appears as a whole word, provided that name is not shared by another entry.
 */
export function resolveSubjectsInText(text: string, directory: SubjectDirectory): MemorySubject[] {
  const found: MemorySubject[] = [];
  const candidates: Array<{ names: string[]; subject: (name: string) => MemorySubject }> = [
    ...directory.members.map((member) => ({ names: member.names, subject: (name: string) => ({ discordUserId: member.userId, name }) })),
    ...directory.waifus.map((waifu) => ({ names: waifu.names, subject: () => ({ waifuId: waifu.id, name: waifu.displayName }) }))
  ];
  for (const candidate of candidates) {
    const hit = candidate.names.find((name) => wordBoundaryIncludes(text, name) && resolveSubjectName(name, directory) !== undefined);
    if (hit) found.push(candidate.subject(hit));
  }
  return dedupeSubjects(found);
}

/** Subjects from a conversation's participants (id-keyed; names as currently displayed). */
export function participantSubject(participant: Participant): MemorySubject {
  if (participant.waifuId) return { waifuId: participant.waifuId, name: participant.displayName };
  if (participant.discordUserId) return { discordUserId: participant.discordUserId, name: participant.displayName };
  return { name: participant.displayName };
}

function subjectKey(subject: MemorySubject): string {
  if (subject.discordUserId) return `u:${subject.discordUserId}`;
  if (subject.waifuId) return `w:${subject.waifuId}`;
  return `n:${normalizeName(subject.name)}`;
}

/** True when the two subjects denote the same person/waifu (by id; by name only when id-less). */
export function sameSubject(a: MemorySubject, b: MemorySubject): boolean {
  if (a.discordUserId || b.discordUserId) return a.discordUserId !== undefined && a.discordUserId === b.discordUserId;
  if (a.waifuId || b.waifuId) return a.waifuId !== undefined && a.waifuId === b.waifuId;
  return normalizeName(a.name) === normalizeName(b.name);
}

export function subjectsOverlap(a: MemorySubject[], b: MemorySubject[]): boolean {
  return a.some((left) => b.some((right) => sameSubject(left, right)));
}

export function dedupeSubjects(subjects: MemorySubject[]): MemorySubject[] {
  const seen = new Set<string>();
  const out: MemorySubject[] = [];
  for (const subject of subjects) {
    const key = subjectKey(subject);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(subject);
  }
  return out;
}

export function subjectIncludesUser(subjects: MemorySubject[], discordUserId: string): boolean {
  return subjects.some((subject) => subject.discordUserId === discordUserId);
}

/** Render-time name refresh: the current member/waifu name, else the stored last-known name. */
export function subjectNameResolver(directories: SubjectDirectory[]): (subject: MemorySubject) => string {
  return (subject) => {
    if (subject.waifuId) {
      for (const directory of directories) {
        const waifu = directory.waifus.find((candidate) => candidate.id === subject.waifuId);
        if (waifu) return waifu.displayName;
      }
    }
    if (subject.discordUserId) {
      for (const directory of directories) {
        const member = directory.members.find((candidate) => candidate.userId === subject.discordUserId);
        if (member?.names[0]) return member.names[0];
      }
    }
    return subject.name;
  };
}

// ---------------------------------------------------------------------------
// Prompt handles: humans p1…pN in first-appearance order, waifus w:<id>.
// ---------------------------------------------------------------------------

export type ParticipantHandle = { handle: string; participant: Participant; subject: MemorySubject };

export type HandleTable = {
  entries: ParticipantHandle[];
  /** The handle for a subject, when that subject is a participant. */
  handleFor(subject: MemorySubject): string | undefined;
  /** Subjects for handles; unknown handles are dropped. */
  subjectsFor(handles: string[]): MemorySubject[];
};

export function buildHandleTable(participants: Participant[]): HandleTable {
  const entries: ParticipantHandle[] = [];
  let humanIndex = 0;
  const seen = new Set<string>();
  for (const participant of participants) {
    const subject = participantSubject(participant);
    const key = subjectKey(subject);
    if (seen.has(key)) continue;
    seen.add(key);
    const handle = participant.waifuId ? `w:${participant.waifuId}` : `p${(humanIndex += 1)}`;
    entries.push({ handle, participant, subject });
  }
  const byHandle = new Map(entries.map((entry) => [entry.handle.toLowerCase(), entry]));
  return {
    entries,
    handleFor: (subject) => entries.find((entry) => sameSubject(entry.subject, subject))?.handle,
    subjectsFor: (handles) =>
      dedupeSubjects(
        handles
          .map((handle) => byHandle.get(String(handle).trim().toLowerCase())?.subject)
          .filter((subject): subject is MemorySubject => subject !== undefined)
      )
  };
}
