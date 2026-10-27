// Dreaming (Living cast spec §18.4, owner decisions T3 and T4): nightly, while she sleeps, a separate
// memory keeper (no life log, no persona) reads what was said since her last dream in her
// transcripts, adds the day's memories to her notes and checks every note against that window.
//
// The window: for every conversation she can read (§18.3), the lines after her dream cursor
// (`life/dream-cursor.json`: per conversation, the time and id of the last line a finished dream
// covered; the first dream after the upgrade starts at the transcript store's start). Only lines she
// could see count (a room's access intervals). The cursor moves only when a dream session finishes:
// an aborted or failed one changes nothing, and the next dream covers the longer window. A window
// whose rendered text is over `life.dreamWindowMaxChars` runs in several sessions, oldest
// conversations' days first, each moving the cursor for what it covered.
//
// Model: `life.dreamModel` when it is set and offered, else her own model (and her effort). Tools:
// her file tools (Read, Write, Edit, Bash) in session mode: `/transcripts` read-only, `~/life/` refused (§21.6),
// profile.json included. Round cap `life.dreamMaxRounds`. One report line per dream in `maintenance.jsonl`.

import { readFile } from "node:fs/promises";
import { findCuratedModel, type CuratedModel } from "../models/catalog.js";
import type { WaifuConfig } from "../shared/schemas/domain.js";
import { atomicWriteJson } from "../storage/atomic.js";
import type { StorageService } from "../storage/storageService.js";
import { clockText, dayTimeText, timeLine } from "./clock.js";
import type { LifeDeps } from "./deps.js";
import { dayPlanFor } from "./home/index.js";
import { appendMaintenanceReport } from "./lifeStore.js";
import { lifeModelOf } from "./lifeLoop.js";
import { homeListing, runSession, type MaintenanceOutcome } from "./maintenance.js";
import { lifeLocks, lifePaths } from "./paths.js";
import { compareLines, insideIntervals, readTranscriptDay, readTranscriptsStartedAt, type TranscriptLine } from "./transcripts/store.js";
import { renderTranscriptDay, TranscriptView, transcriptsVirtual, type TranscriptFolder } from "./transcripts/view.js";

export type DreamCursor = { conversations: Record<string, { at: string; id: string }> };

export function dreamSystem(waifu: Pick<WaifuConfig, "name">): string {
  return `You keep ${waifu.name}'s memory. Her notes are files in her home, written in her own voice (keep their voice and layout). MEMORY.md is the index: one short line per note, linking to it. In /transcripts (read-only) her own lines are written as "you".`;
}

export const DREAM_INSTRUCTION = [
  "[system] She is asleep: time to dream. Her home (~) holds her notes; /transcripts holds what was said where she is, one file per place per day. Leave ~/life/ alone (her day, reminders, watches, profile and places are hers to keep).",
  "1. Read the dream window below: in each file, only the lines from the line number given (as Read numbers them).",
  "2. Add memories from the window only: new people, places, facts, plans, how things felt. Write them as her notes, in her voice and the layout her notes already use, and add a line to MEMORY.md for each new note.",
  "3. Check every note against the window. Change a fact only when the window clearly says otherwise (the newest wins) and keep everything else exactly as it is. Never delete or change a note because the window doesn't mention it. You may grep older transcript days to confirm a fact the window touches, but add nothing from before the window.",
  "4. Keep MEMORY.md short and its links valid; merge duplicates you notice.",
  "5. When you're done, reply with one short line saying what changed."
].join("\n");

/** The report's summary when the window is empty (no model is called). */
export const DREAM_NOTHING_NEW = "nothing new since the last dream";

// ---- the cursor ----------------------------------------------------------------------------------------

export async function readDreamCursor(storage: StorageService, waifuId: string): Promise<DreamCursor> {
  try {
    const parsed = JSON.parse(await readFile(storage.dataPath(lifePaths.dreamCursor(waifuId)), "utf8")) as { conversations?: unknown };
    const out: DreamCursor = { conversations: {} };
    if (parsed.conversations && typeof parsed.conversations === "object") {
      for (const [key, value] of Object.entries(parsed.conversations as Record<string, unknown>)) {
        const entry = value as { at?: unknown; id?: unknown } | null;
        if (entry && typeof entry.at === "string" && typeof entry.id === "string" && Number.isFinite(Date.parse(entry.at))) out.conversations[key] = { at: entry.at, id: entry.id };
      }
    }
    return out;
  } catch {
    return { conversations: {} };
  }
}

async function updateDreamCursor(storage: StorageService, waifuId: string, transform: (cursor: DreamCursor) => DreamCursor | undefined): Promise<void> {
  await storage.withLocks([lifeLocks.maintenance(waifuId)], async () => {
    const current = await readDreamCursor(storage, waifuId);
    const next = transform(structuredClone(current));
    if (!next || JSON.stringify(next) === JSON.stringify(current)) return;
    await atomicWriteJson(storage.dataPath(lifePaths.dreamCursor(waifuId)), next);
  });
}

/** A forget: the cursor forgets conversations that were removed (§18.5). */
export async function dropDreamCursorEntries(storage: StorageService, waifuId: string, keys: ReadonlySet<string>): Promise<void> {
  await updateDreamCursor(storage, waifuId, (cursor) => {
    let changed = false;
    for (const key of Object.keys(cursor.conversations)) {
      if (!keys.has(key)) continue;
      delete cursor.conversations[key];
      changed = true;
    }
    return changed ? cursor : undefined;
  });
}

// ---- the window ------------------------------------------------------------------------------------------

/** One transcript day file's part of the window. */
export type DreamChunk = {
  folder: TranscriptFolder;
  day: string;
  /** `/transcripts/bake-club/general/2026-10-24.md`. */
  path: string;
  /** The window's lines in this file, oldest first. */
  lines: TranscriptLine[];
  /** Lines before this one in the same file (the window starts in the middle of the day). */
  after?: TranscriptLine;
  /** Where the window starts in the rendered file, as Read numbers its lines (with `after`). */
  fromLine?: number;
  chars: number;
};

export type DreamWindow = { start: string; chunks: DreamChunk[]; lines: number; chars: number };

function afterCursor(line: TranscriptLine, cursor: { at: string; id: string } | undefined, start: number): boolean {
  if (!cursor) return Date.parse(line.at) >= start;
  return compareLines(line, cursor) > 0;
}

/** Every line she could see since her dream cursor, by conversation and day. */
export async function dreamWindow(deps: Pick<LifeDeps, "storage" | "timeZone" | "now">, waifu: Pick<WaifuConfig, "id">): Promise<DreamWindow> {
  const view = new TranscriptView({ storage: deps.storage, waifuId: waifu.id, timeZone: deps.timeZone, now: deps.now });
  const cursor = await readDreamCursor(deps.storage, waifu.id);
  const known = await readTranscriptsStartedAt(deps.storage.dataRoot);
  const startedAt = known ?? new Date(0).toISOString();
  const start = Date.parse(startedAt);
  const chunks: DreamChunk[] = [];
  /** Where each conversation's window starts (its cursor, else the store's start). */
  const starts = new Map<string, number>();
  for (const folder of await view.list()) {
    const mark = cursor.conversations[folder.key];
    if (mark || known) starts.set(folder.key, mark ? Date.parse(mark.at) : start);
    const fromDay = mark ? mark.at : startedAt;
    for (const day of await view.days(folder)) {
      // A day ends before the window starts: skipped without reading it (a day is at most 26 hours).
      if (Date.parse(`${day}T23:59:59.999Z`) + 14 * 3_600_000 < Date.parse(fromDay)) continue;
      const all = (await readTranscriptDay(deps.storage.dataRoot, folder.key, day)).filter((line) => folder.dm || !folder.intervals || insideIntervals(folder.intervals, line.at));
      const lines = all.filter((line) => afterCursor(line, mark, start));
      if (lines.length === 0) continue;
      const before = all.filter((line) => !afterCursor(line, mark, start));
      const text = renderTranscriptDay({ handle: folder.handle, day, lines, waifuId: waifu.id, timeZone: deps.timeZone, refs: new Map() });
      // The header, then one rendered line per transcript line plus one per line break in its text.
      const fromLine = 2 + before.reduce((sum, line) => sum + 1 + (line.text.replace(/\r\n/gu, "\n").match(/\n/gu)?.length ?? 0), 0);
      chunks.push({
        folder,
        day,
        path: transcriptsVirtual([...folder.segments, `${day}.md`]),
        lines,
        ...(before.length > 0 ? { after: before[before.length - 1]!, fromLine } : {}),
        chars: text.length
      });
    }
  }
  chunks.sort((a, b) => compareLines(a.lines[0]!, b.lines[0]!));
  // The window starts where the earliest conversation in it starts (its first line when nothing says).
  const chunkStarts = chunks.map((chunk) => starts.get(chunk.folder.key) ?? Date.parse(chunk.lines[0]!.at));
  return {
    start: chunkStarts.length > 0 ? new Date(Math.min(...chunkStarts)).toISOString() : startedAt,
    chunks,
    lines: chunks.reduce((sum, chunk) => sum + chunk.lines.length, 0),
    chars: chunks.reduce((sum, chunk) => sum + chunk.chars, 0)
  };
}

/** The window split into sessions of at most `maxChars` (a single larger day is a session of its own). */
export function dreamSessions(chunks: readonly DreamChunk[], maxChars: number): DreamChunk[][] {
  const sessions: DreamChunk[][] = [];
  let current: DreamChunk[] = [];
  let size = 0;
  for (const chunk of chunks) {
    if (current.length > 0 && size + chunk.chars > maxChars) {
      sessions.push(current);
      current = [];
      size = 0;
    }
    current.push(chunk);
    size += chunk.chars;
  }
  if (current.length > 0) sessions.push(current);
  return sessions;
}

/** The opening message's window text: each file with where its window part starts. */
export function windowText(chunks: readonly DreamChunk[], o: { start: string; timeZone: string; more?: boolean }): string {
  const total = chunks.reduce((sum, chunk) => sum + chunk.lines.length, 0);
  const lines = [`The dream window starts ${dayTimeText(new Date(o.start), o.timeZone)}. Read these transcript files (${total} line${total === 1 ? "" : "s"} in all):`];
  for (const chunk of chunks) {
    // A line number, not a time: several lines can share a minute (unambiguous where the window starts).
    const where = chunk.after ? `from line ${chunk.fromLine ?? 2} on, after the ${clockText(new Date(chunk.after.at), o.timeZone)} line` : "the whole file";
    lines.push(`- ${chunk.path} (${where}, ${chunk.lines.length} line${chunk.lines.length === 1 ? "" : "s"})`);
  }
  if (o.more) lines.push("(The rest of the window comes in a later session: only these files now.)");
  return lines.join("\n");
}

// ---- the dream ---------------------------------------------------------------------------------------------

/** The dream's model: `life.dreamModel` when set and offered, else hers (with her effort). */
export function dreamModelOf(deps: Pick<LifeDeps, "catalog" | "config">, waifu: WaifuConfig): { model: CuratedModel; effort?: string } | undefined {
  const configured = deps.config().life.dreamModel;
  if (configured) {
    const model = findCuratedModel(configured, deps.catalog());
    if (model) return { model, ...(configured.effort ? { effort: configured.effort } : {}) };
  }
  const model = lifeModelOf(deps, waifu);
  return model ? { model, ...(waifu.model?.effort ? { effort: waifu.model.effort } : {}) } : undefined;
}

export type DreamOutcome = MaintenanceOutcome & { sessions: number; lines: number; conversations: number; windowStart: string };

/** Her nightly dream plus its report line (the caller holds her life lock). */
export async function runDream(deps: LifeDeps, o: { waifu: WaifuConfig; signal?: AbortSignal }): Promise<DreamOutcome | undefined> {
  const chosen = dreamModelOf(deps, o.waifu);
  if (!chosen) return undefined;
  const life = deps.config().life;
  const window = await dreamWindow(deps, o.waifu);
  const conversations = new Set(window.chunks.map((chunk) => chunk.folder.key)).size;
  const outcome: DreamOutcome = { rounds: 0, changed: [], summary: "", ok: true, sessions: 0, lines: window.lines, conversations, windowStart: window.start };
  const sessions = dreamSessions(window.chunks, life.dreamWindowMaxChars);
  // Nothing was said since the last dream: nothing to add, and no note is checked against nothing (T4).
  if (sessions.length === 0) outcome.summary = DREAM_NOTHING_NEW;
  for (const [index, chunks] of sessions.entries()) {
    if (o.signal?.aborted) {
      outcome.ok = false;
      outcome.error = "aborted";
      break;
    }
    const session = await runSession(deps, {
      waifu: o.waifu,
      model: chosen.model,
      system: dreamSystem(o.waifu),
      opening: [
        DREAM_INSTRUCTION,
        await homeListing(deps, o.waifu, { possessive: "Her" }),
        windowText(chunks, { start: window.start, timeZone: deps.timeZone, more: index < sessions.length - 1 }),
        timeLine({ now: deps.now(), timeZone: deps.timeZone, availability: o.waifu.availability, day: await dayPlanFor(deps, o.waifu) })
      ],
      maxRounds: life.dreamMaxRounds,
      ...(chosen.effort ? { effort: chosen.effort } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      kind: "dream"
    });
    outcome.sessions += 1;
    outcome.rounds += session.rounds;
    outcome.changed = [...new Set([...outcome.changed, ...session.changed])].sort();
    if (session.summary) outcome.summary = [outcome.summary, session.summary].filter(Boolean).join(" ").slice(0, 500);
    if (!session.ok || o.signal?.aborted) {
      // Nothing covered by this session counts: the next dream reads it again.
      outcome.ok = false;
      outcome.error = session.error ?? "aborted";
      break;
    }
    await updateDreamCursor(deps.storage, o.waifu.id, (cursor) => {
      for (const chunk of chunks) {
        const last = chunk.lines[chunk.lines.length - 1]!;
        const current = cursor.conversations[chunk.folder.key];
        if (!current || compareLines(last, current) > 0) cursor.conversations[chunk.folder.key] = { at: last.at, id: last.id };
      }
      return cursor;
    });
  }
  // An aborted dream is not recorded (it runs again at the next tick; sessions that finished keep their cursor).
  if (outcome.error === "aborted") return outcome;
  await appendMaintenanceReport(deps.storage, o.waifu.id, {
    at: deps.now().toISOString(),
    kind: "maintenance",
    dream: true,
    ok: outcome.ok,
    rounds: outcome.rounds,
    changed: outcome.changed,
    summary: outcome.summary,
    windowStart: outcome.windowStart,
    conversations: outcome.conversations,
    lines: outcome.lines,
    sessions: outcome.sessions,
    ...(outcome.error ? { error: outcome.error } : {})
  });
  deps.logger.info("Life dream ran", { category: "life", waifuId: o.waifu.id, ok: outcome.ok, rounds: outcome.rounds, sessions: outcome.sessions, lines: outcome.lines, changed: outcome.changed.length });
  return outcome;
}
