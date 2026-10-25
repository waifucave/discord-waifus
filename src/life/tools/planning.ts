// `WatchFor` and `ScheduleWake` (Living cast spec §16.4, §16.5, T2, T3): each appends one entry to
// her own file (`~/watches.json`, `~/schedule.json`); she lists, changes and cancels them by reading
// and editing the file. The write goes through the same checks as any other write of the file.

import { z } from "zod";
import { dayTimeText, parseLocalDateTime } from "../clock.js";
import { checkEnvFor } from "../home/index.js";
import { HomeError } from "../home/homeStore.js";
import { SCHEDULE_FILE, WATCHES_FILE } from "../home/pathRules.js";
import {
  ceilMinute,
  formatEntries,
  localMinuteText,
  MAX_BINDINGS,
  MAX_NOTE_CHARS,
  MAX_REMINDERS,
  MAX_WATCHES,
  MAX_WORDS,
  parseStrictJson,
  REMINDER_MAX_AHEAD_MS,
  REMINDER_MIN_AHEAD_MS
} from "../home/specialFiles.js";
import { storeOf } from "./files.js";
import { parseInput, toolError, type LifeTool, type ToolContext, type ToolOutput } from "./types.js";

/** Her file's entries as written (for appending one), or the reason it can't be added to. */
async function currentEntries(ctx: ToolContext, name: string): Promise<{ ok: true; entries: Array<Record<string, unknown>> } | { ok: false; output: ToolOutput }> {
  const store = storeOf(ctx);
  const text = await store.files.readText(store.home(name)).catch(() => undefined);
  if (!text?.trim()) return { ok: true, entries: [] };
  try {
    const value = parseStrictJson(text);
    if (Array.isArray(value)) return { ok: true, entries: value as Array<Record<string, unknown>> };
  } catch {
    // reported below
  }
  return { ok: false, output: toolError(`~/${name} can't be read as a list right now; fix it first (Read it to see why)`) };
}

async function append(ctx: ToolContext, name: string, entry: Record<string, unknown>): Promise<{ ok: true; id: string } | { ok: false; output: ToolOutput }> {
  const current = await currentEntries(ctx, name);
  if (!current.ok) return current;
  const before = new Set(current.entries.map((existing) => existing["id"]));
  const store = storeOf(ctx);
  try {
    await store.writeText(store.home(name), formatEntries([...current.entries, entry]), checkEnvFor(ctx.deps, ctx.waifu.id));
  } catch (error) {
    if (error instanceof HomeError) return { ok: false, output: toolError(error.message) };
    throw error;
  }
  const saved = await currentEntries(ctx, name);
  const id = saved.ok ? saved.entries.map((existing) => existing["id"]).find((candidate) => typeof candidate === "string" && !before.has(candidate)) : undefined;
  return { ok: true, id: typeof id === "string" ? id : "?" };
}

// ---- WatchFor ----------------------------------------------------------------------------------------

const BindingInput = z
  .object({
    place: z.string().min(1).max(200).optional(),
    from: z.string().min(1).max(100).optional(),
    words: z.array(z.string().min(1).max(60)).min(1).max(MAX_WORDS).optional(),
    any_message: z.boolean().optional()
  })
  .refine((binding) => binding.place !== undefined || binding.from !== undefined || binding.words !== undefined || binding.any_message === true, {
    message: "each binding needs a place, from, words or any_message"
  });

const WatchInput = z.object({
  when: z.array(BindingInput).max(MAX_BINDINGS).default([]),
  note: z.string().max(MAX_NOTE_CHARS),
  timeout_minutes: z.number().int().min(1).max(10_080),
  once: z.boolean().default(true)
});

async function watchFor(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(WatchInput, input);
  if (!parsed.ok) return parsed.output;
  const { deps } = ctx;
  const args = parsed.value;
  const current = await currentEntries(ctx, WATCHES_FILE);
  if (!current.ok) return current.output;
  if (current.entries.length >= MAX_WATCHES) return toolError(`you already have ${MAX_WATCHES} watches; remove one from ~/watches.json first`);
  const timeout = ceilMinute(new Date(deps.now().getTime() + args.timeout_minutes * 60_000));
  const entry = {
    timeout: localMinuteText(timeout, deps.timeZone),
    once: args.once,
    note: args.note,
    when: args.when.map((binding) => ({
      ...(binding.place !== undefined ? { place: binding.place } : {}),
      ...(binding.from !== undefined ? { from: binding.from } : {}),
      ...(binding.words !== undefined ? { words: binding.words.map((word) => word.trim()) } : {}),
      ...(binding.any_message !== undefined ? { any_message: binding.any_message } : {})
    }))
  };
  const saved = await append(ctx, WATCHES_FILE, entry);
  if (!saved.ok) return saved.output;
  const ends = parseLocalDateTime(entry.timeout, deps.timeZone) ?? timeout;
  return { content: `watching ${saved.id} until ${dayTimeText(ends, deps.timeZone)} (in ~/${WATCHES_FILE})` };
}

// ---- ScheduleWake --------------------------------------------------------------------------------------

const ScheduleInput = z
  .object({
    at: z.string().min(1).max(40).optional(),
    in_minutes: z.number().int().min(1).max(60 * 24 * 31).optional(),
    note: z.string().max(MAX_NOTE_CHARS),
    repeat: z.enum(["daily", "weekly"]).optional()
  })
  .refine((value) => (value.at === undefined) !== (value.in_minutes === undefined), { message: "give exactly one of at or in_minutes" });

async function scheduleWake(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(ScheduleInput, input);
  if (!parsed.ok) return parsed.output;
  const { deps } = ctx;
  const args = parsed.value;
  const now = deps.now();
  let due: Date | undefined;
  if (args.at !== undefined) {
    due = parseLocalDateTime(args.at, deps.timeZone);
    if (!due) return toolError("use a local time like 2026-10-25 18:00");
  } else {
    due = ceilMinute(new Date(now.getTime() + args.in_minutes! * 60_000));
  }
  const ahead = due.getTime() - now.getTime();
  // `in_minutes` is checked as given (the due time is rounded up to a whole minute).
  if (args.in_minutes !== undefined ? args.in_minutes * 60_000 < REMINDER_MIN_AHEAD_MS : ahead < REMINDER_MIN_AHEAD_MS - 60_000) return toolError("reminders must be at least 5 minutes ahead");
  if (ahead > REMINDER_MAX_AHEAD_MS) return toolError("reminders can be at most 30 days ahead");
  const current = await currentEntries(ctx, SCHEDULE_FILE);
  if (!current.ok) return current.output;
  if (current.entries.length >= MAX_REMINDERS) return toolError(`you already have ${MAX_REMINDERS} reminders; remove one from ~/${SCHEDULE_FILE} first`);
  const entry = { at: localMinuteText(due, deps.timeZone), ...(args.repeat ? { repeat: args.repeat } : {}), note: args.note };
  const saved = await append(ctx, SCHEDULE_FILE, entry);
  if (!saved.ok) return saved.output;
  return { content: `set ${saved.id} for ${dayTimeText(due, deps.timeZone)}${args.repeat ? `, then ${args.repeat}` : ""} (in ~/${SCHEDULE_FILE})` };
}

export const planningTools: LifeTool[] = [
  {
    name: "WatchFor",
    description:
      "Get notified when something happens: a message in a place, from a person, with some words, or any message. A binding in when matches when every field it sets matches; any binding fires the watch. Every watch ends at its timeout and you are told when it does, so a watch with an empty when is a timer. Watches are saved in ~/watches.json; edit that file to change or cancel them.",
    inputSchema: {
      type: "object",
      properties: {
        when: {
          type: "array",
          maxItems: MAX_BINDINGS,
          description: "What to watch for (0–5 bindings; [] for a plain timer).",
          items: {
            type: "object",
            properties: {
              place: { type: "string", description: "A place handle." },
              from: { type: "string", description: "A person's name, or <@id>." },
              words: { type: "array", items: { type: "string" }, maxItems: MAX_WORDS, description: "Any of these words (whole words, any case)." },
              any_message: { type: "boolean" }
            },
            additionalProperties: false
          }
        },
        note: { type: "string", maxLength: MAX_NOTE_CHARS, description: "A note to yourself, shown when it fires or times out." },
        timeout_minutes: { type: "integer", minimum: 1, maximum: 10080, description: "When the watch ends (at most a week)." },
        once: { type: "boolean", description: "Stop after the first match (default true)." }
      },
      required: ["note", "timeout_minutes"],
      additionalProperties: false
    },
    sideEffect: true,
    run: watchFor
  },
  {
    name: "ScheduleWake",
    description:
      "Set a reminder that wakes you later with your note. Give either at (local time like 2026-10-25 18:00) or in_minutes; 5 minutes to 30 days ahead; optionally repeat daily or weekly. Reminders are saved in ~/schedule.json; edit that file to change or cancel them.",
    inputSchema: {
      type: "object",
      properties: {
        at: { type: "string", description: "Local date and time, like 2026-10-25 18:00." },
        in_minutes: { type: "integer", minimum: 5 },
        note: { type: "string", maxLength: MAX_NOTE_CHARS },
        repeat: { type: "string", enum: ["daily", "weekly"] }
      },
      required: ["note"],
      additionalProperties: false
    },
    sideEffect: true,
    run: scheduleWake
  }
];
