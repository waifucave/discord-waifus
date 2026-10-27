// `WatchFor` and `ScheduleWake` (Living cast spec §16.4, §16.5, T2, T3): each appends one entry to
// her own file (`~/life/watches.json`, `~/life/reminders.json`); she lists, changes and cancels them by reading
// and editing the file. The write goes through the same checks as any other write of the file, and
// reads and writes the file under one hold of her home lock (nothing the app rewrites in between is
// lost). A check's error names the tool, not the entry (`WatchFor: …`).

import { z } from "zod";
import { dayTimeText, parseLocalDateTime } from "../clock.js";
import { checkEnvFor } from "../home/index.js";
import { HomeError } from "../home/homeStore.js";
import { lifeDisplay, REMINDERS_FILE, WATCHES_FILE } from "../home/pathRules.js";
import {
  ceilMinute,
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
async function currentEntries(ctx: ToolContext, name: typeof REMINDERS_FILE | typeof WATCHES_FILE): Promise<{ ok: true; entries: Array<Record<string, unknown>> } | { ok: false; output: ToolOutput }> {
  const store = storeOf(ctx);
  const text = await store.files.readText(store.life(name)).catch(() => undefined);
  if (!text?.trim()) return { ok: true, entries: [] };
  try {
    const value = parseStrictJson(text);
    if (Array.isArray(value)) return { ok: true, entries: value as Array<Record<string, unknown>> };
  } catch {
    // reported below
  }
  return { ok: false, output: toolError(`${lifeDisplay(name)} can't be read as a list right now; fix it first (Read it to see why)`) };
}

async function append(ctx: ToolContext, tool: "WatchFor" | "ScheduleWake", name: typeof REMINDERS_FILE | typeof WATCHES_FILE, entry: Record<string, unknown>): Promise<{ ok: true; id: string } | { ok: false; output: ToolOutput }> {
  const store = storeOf(ctx);
  try {
    return { ok: true, id: await store.appendEntry(name, entry, checkEnvFor(ctx.deps, ctx.waifu.id)) };
  } catch (error) {
    if (error instanceof HomeError) return { ok: false, output: toolError(asToolError(tool, error.message)) };
    throw error;
  }
}

/** `error: watches.json entry w3: timeout is in the past` → `error: WatchFor: timeout is in the past`. */
export function asToolError(tool: string, message: string): string {
  const problem = message.replace(/^error:\s*/u, "").replace(/^(?:~\/)?(?:watches|reminders|schedule)\.json entry [^:]+:\s*/u, "");
  return `error: ${tool}: ${problem}`;
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
  if (current.entries.length >= MAX_WATCHES) return toolError(`you already have ${MAX_WATCHES} watches; remove one from ~/life/watches.json first`);
  // To the nearest minute (the file's times are whole minutes).
  const timeout = new Date(Math.round((deps.now().getTime() + args.timeout_minutes * 60_000) / 60_000) * 60_000);
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
  const saved = await append(ctx, "WatchFor", WATCHES_FILE, entry);
  if (!saved.ok) return saved.output;
  const ends = parseLocalDateTime(entry.timeout, deps.timeZone) ?? timeout;
  return { content: `watching ${saved.id} until ${dayTimeText(ends, deps.timeZone)} (in ${lifeDisplay(WATCHES_FILE)})` };
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
  const current = await currentEntries(ctx, REMINDERS_FILE);
  if (!current.ok) return current.output;
  if (current.entries.length >= MAX_REMINDERS) return toolError(`you already have ${MAX_REMINDERS} reminders; remove one from ${lifeDisplay(REMINDERS_FILE)} first`);
  const entry = { at: localMinuteText(due, deps.timeZone), ...(args.repeat ? { repeat: args.repeat } : {}), note: args.note };
  const saved = await append(ctx, "ScheduleWake", REMINDERS_FILE, entry);
  if (!saved.ok) return saved.output;
  return { content: `set ${saved.id} for ${dayTimeText(due, deps.timeZone)}${args.repeat ? `, then ${args.repeat}` : ""} (in ${lifeDisplay(REMINDERS_FILE)})` };
}

export const planningTools: LifeTool[] = [
  {
    name: "WatchFor",
    description:
      "Be woken when something you're waiting for happens: an answer from someone you asked, a message in a place, some words, or any message. Use it whenever you ask something or expect news. A binding in when matches when every field it sets matches; any binding fires the watch. Every watch ends at its timeout and you are told when it does: a good moment to follow up if nothing came, and a watch with an empty when is a timer. Watches are saved in ~/life/watches.json; edit that file to change or cancel them.",
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
        timeout_minutes: { type: "integer", minimum: 1, maximum: 10080, description: "Minutes until the watch ends (1–10080, a week)." },
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
      "Wake yourself later with a note: to ask how someone's exam, trip or game went, to check back in a room you like, or for anything you mean to do later. Give either at (local time like 2026-10-25 18:00) or in_minutes; 5 minutes to 30 days ahead; optionally repeat daily or weekly. Reminders are saved in ~/life/reminders.json; edit that file to change or cancel them.",
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
