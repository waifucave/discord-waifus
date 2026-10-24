// Frozen copies of the runtime helpers and constants that shipped migration steps depend on.
//
// Living cast (L1) removed the modules these came from (memorySubjects.ts, decisions.ts,
// contextWindows.ts, pipeline/resolveTarget.ts). A shipped step must keep its meaning forever, so
// the exact values and logic it ran with live here, owned by the migrations. Never import runtime
// modules from a migration step; never change what is below.

import type { GuildMemberCacheEntry } from "../../shared/schemas/domain.js";
import type { MemorySubject } from "./legacySchemas.js";

// --- decisions.ts (orchestrator-history-responding-waifus) ------------------------------------
export const RETRIGGER_MIN_SECONDS = 10;
export const RETRIGGER_MAX_SECONDS = 28800;

// --- contextWindows.ts (server-context-windows-explicit-v1) -----------------------------------
export type ContextCapKind = "orchestrator" | "waifu" | "stageManager";
/** Pre-B29 server defaults: what a server file without an explicit key used to be filled with. */
export const LEGACY_SERVER_CONTEXT_WINDOWS: Readonly<Record<ContextCapKind, number>> = {
  orchestrator: 20,
  waifu: 50,
  stageManager: 80
};

// --- pipeline/resolveTarget.ts (configs-to-gateway-params) ------------------------------------
/** §7.3: stored ids whose models left the gateway catalog, with their conservative substitutes. */
export const LEGACY_MODEL_MAP: Readonly<Record<string, { providerId: string; modelId: string }>> = {
  "gpt-4o": { providerId: "openai", modelId: "gpt-5-mini" },
  "gpt-4o-mini": { providerId: "openai", modelId: "gpt-5-nano" },
  "glm-5-turbo": { providerId: "zai", modelId: "glm-5" },
  "gemini-3.5-flash": { providerId: "google-ai-studio", modelId: "gemini-3-flash-preview" },
  "gemini-2-0-flash": { providerId: "google-ai-studio", modelId: "gemini-3.6-flash" },
  "gemini-2.0-flash": { providerId: "google-ai-studio", modelId: "gemini-3.6-flash" },
  "mimo-v2-flash": { providerId: "xiaomi", modelId: "mimo-v2.5" },
  "trinity-large": { providerId: "openrouter", modelId: "arcee-ai/trinity-large-thinking" }
};

// --- memorySubjects.ts (memory-store-v2, memories-global-origin-subjects-v1, cross-guild dedupe) ---
// Waifu-tool notes sat between ephemeral chatter and user memories.
export const WAIFU_NOTE_STRENGTH = 2;

/** Canonical form for name comparisons (NFKC, case-folded, whitespace collapsed). */
export function normalizeName(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

export type SubjectDirectoryMember = { userId: string; names: string[] };
export type SubjectDirectoryWaifu = { id: string; names: string[]; displayName: string };
export type SubjectDirectory = {
  members: SubjectDirectoryMember[];
  waifus: SubjectDirectoryWaifu[];
};

function memberNames(member: GuildMemberCacheEntry): string[] {
  return [member.guildDisplayName, member.globalDisplayName, member.username].filter(
    (name): name is string => typeof name === "string" && name.trim().length > 0
  );
}

export function buildSubjectDirectory(
  members: GuildMemberCacheEntry[],
  waifus: Array<{ id: string; name: string; displayName: string }>
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

function resolveSubjectName(name: string, directory: SubjectDirectory): MemorySubject | undefined {
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

function subjectKey(subject: MemorySubject): string {
  if (subject.discordUserId) return `u:${subject.discordUserId}`;
  if (subject.waifuId) return `w:${subject.waifuId}`;
  return `n:${normalizeName(subject.name)}`;
}

function dedupeSubjects(subjects: MemorySubject[]): MemorySubject[] {
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

/** Resolve a list of names; unresolvable or ambiguous names are dropped, duplicates collapsed. */
export function resolveSubjectNames(names: string[], directory: SubjectDirectory): MemorySubject[] {
  return dedupeSubjects(
    names.map((name) => resolveSubjectName(name, directory)).filter((s): s is MemorySubject => s !== undefined)
  );
}

function sameSubject(a: MemorySubject, b: MemorySubject): boolean {
  if (a.discordUserId || b.discordUserId) return a.discordUserId !== undefined && a.discordUserId === b.discordUserId;
  if (a.waifuId || b.waifuId) return a.waifuId !== undefined && a.waifuId === b.waifuId;
  return normalizeName(a.name) === normalizeName(b.name);
}

export function subjectsOverlap(a: MemorySubject[], b: MemorySubject[]): boolean {
  return a.some((left) => b.some((right) => sameSubject(left, right)));
}
