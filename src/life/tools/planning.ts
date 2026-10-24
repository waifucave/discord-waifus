// `watch_for`, `list_watches`, `cancel_watch`, `schedule_wake`, `list_schedule`, `cancel_wake`
// (Living cast spec §6.5, §6.6).

import { z } from "zod";
import type { Reminder, Watch, WatchBinding } from "../../shared/schemas/life.js";
import { dayTimeText, parseLocalDateTime } from "../clock.js";
import { readLifeFile, updateLifeFile } from "../lifeStore.js";
import { resolvePerson } from "../people.js";
import { collectPlaces, handleOf, resolvePlace } from "../places.js";
import { activeWatches, MAX_ACTIVE_WATCHES } from "../watches.js";
import { parseInput, toolError, UNKNOWN_PLACE, type LifeTool, type ToolContext, type ToolOutput } from "./types.js";

export const MAX_PENDING_REMINDERS = 20;
const MIN_AHEAD_MS = 5 * 60_000;
const MAX_AHEAD_MS = 30 * 24 * 3_600_000;

const quote = (text: string) => `"${text.replace(/"/g, "'")}"`;

// ---- watches ------------------------------------------------------------------------------------

const BindingInput = z
  .object({
    place: z.string().min(1).optional(),
    from: z.string().min(1).max(100).optional(),
    words: z.array(z.string().min(1).max(60)).min(1).max(10).optional(),
    any_message: z.boolean().optional()
  })
  .refine((binding) => binding.place !== undefined || binding.from !== undefined || binding.words !== undefined || binding.any_message === true, {
    message: "each binding needs a place, from, words or any_message"
  });

const WatchInput = z.object({
  bindings: z.array(BindingInput).min(1).max(5),
  note: z.string().max(200),
  expires_in_minutes: z.number().int().min(5).max(10080),
  once: z.boolean().default(true)
});

async function watchFor(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(WatchInput, input);
  if (!parsed.ok) return parsed.output;
  const { deps, waifu } = ctx;
  const args = parsed.value;
  const now = deps.now();
  const places = await collectPlaces(deps.storage, waifu.id);
  const bindings: WatchBinding[] = [];
  for (const binding of args.bindings) {
    const out: WatchBinding = {};
    if (binding.place) {
      const place = await resolvePlace(deps.storage, waifu.id, binding.place);
      if (!place) return toolError(UNKNOWN_PLACE);
      out.placeKey = place.placeKey;
    }
    if (binding.from) {
      const person = await resolvePerson(deps, places, binding.from);
      if (!person.ok) return toolError(person.error);
      out.fromUserId = person.userId;
      out.fromName = person.name;
    }
    if (binding.words) out.words = binding.words.map((word) => word.trim()).filter(Boolean);
    if (binding.any_message) out.anyMessage = true;
    bindings.push(out);
  }
  let created: Watch | undefined;
  let full = false;
  await updateLifeFile(deps.storage, waifu.id, "watches", (file) => {
    const active = activeWatches(file, now);
    if (active.length >= MAX_ACTIVE_WATCHES) {
      full = true;
      return active.length === file.watches.length ? file : { ...file, watches: active };
    }
    created = {
      id: `w${file.nextId}`,
      note: args.note,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + args.expires_in_minutes * 60_000).toISOString(),
      once: args.once,
      bindings,
      fires: []
    };
    return { ...file, nextId: file.nextId + 1, watches: [...active, created] };
  });
  if (full || !created) return toolError(`you already have ${MAX_ACTIVE_WATCHES} watches; cancel one first`);
  return { content: `watching ${created.id} until ${dayTimeText(new Date(created.expiresAt), deps.timeZone)}` };
}

async function bindingText(ctx: ToolContext, binding: WatchBinding): Promise<string> {
  const parts: string[] = [];
  if (binding.placeKey) parts.push(await handleOf(ctx.deps.storage, ctx.waifu.id, binding.placeKey));
  if (binding.fromUserId) parts.push(`from ${binding.fromName ?? `<@${binding.fromUserId}>`}`);
  if (binding.words?.length) parts.push(`words: ${binding.words.join(", ")}`);
  if (binding.anyMessage) parts.push("any message");
  return parts.join(" ");
}

async function listWatches(_input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const watches = activeWatches(await readLifeFile(ctx.deps.storage, ctx.waifu.id, "watches"), ctx.deps.now());
  if (watches.length === 0) return { content: "(no watches)" };
  const lines: string[] = [];
  for (const watch of watches) {
    const bindings = await Promise.all(watch.bindings.map((binding) => bindingText(ctx, binding)));
    lines.push(
      `${watch.id} · until ${dayTimeText(new Date(watch.expiresAt), ctx.deps.timeZone)}${watch.once ? " · once" : ""} · ${bindings.join(" | ")} · note: ${quote(watch.note)}`
    );
  }
  return { content: lines.join("\n") };
}

const IdInput = z.object({ id: z.string().min(1).max(20) });

async function cancelWatch(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(IdInput, input);
  if (!parsed.ok) return parsed.output;
  const id = parsed.value.id.trim().toLowerCase();
  let found = false;
  await updateLifeFile(ctx.deps.storage, ctx.waifu.id, "watches", (file) => {
    const watches = file.watches.filter((watch) => watch.id !== id);
    found = watches.length !== file.watches.length;
    return found ? { ...file, watches } : file;
  });
  if (!found) return toolError(`no watch ${id}; use list_watches`);
  return { content: `cancelled ${id}` };
}

// ---- reminders ----------------------------------------------------------------------------------

const ScheduleInput = z
  .object({
    at: z.string().min(1).max(40).optional(),
    in_minutes: z.number().int().min(1).max(60 * 24 * 31).optional(),
    note: z.string().max(200),
    repeat: z.enum(["daily", "weekly"]).optional()
  })
  .refine((value) => (value.at === undefined) !== (value.in_minutes === undefined), { message: "give exactly one of at or in_minutes" });

async function scheduleWake(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(ScheduleInput, input);
  if (!parsed.ok) return parsed.output;
  const { deps, waifu } = ctx;
  const args = parsed.value;
  const now = deps.now();
  let due: Date | undefined;
  if (args.at !== undefined) {
    due = parseLocalDateTime(args.at, deps.timeZone);
    if (!due) return toolError("use a local time like 2026-10-25 18:00");
  } else {
    due = new Date(now.getTime() + args.in_minutes! * 60_000);
  }
  const ahead = due.getTime() - now.getTime();
  if (ahead < MIN_AHEAD_MS) return toolError("reminders must be at least 5 minutes ahead");
  if (ahead > MAX_AHEAD_MS) return toolError("reminders can be at most 30 days ahead");
  let created: Reminder | undefined;
  let full = false;
  await updateLifeFile(deps.storage, waifu.id, "schedule", (file) => {
    if (file.reminders.length >= MAX_PENDING_REMINDERS) {
      full = true;
      return file;
    }
    created = {
      id: `r${file.nextId}`,
      note: args.note,
      dueAt: due!.toISOString(),
      ...(args.repeat ? { repeat: args.repeat } : {}),
      createdAt: now.toISOString()
    };
    return { ...file, nextId: file.nextId + 1, reminders: [...file.reminders, created] };
  });
  if (full || !created) return toolError(`you already have ${MAX_PENDING_REMINDERS} reminders; cancel one first`);
  return { content: `set ${created.id} for ${dayTimeText(due, deps.timeZone)}${created.repeat ? `, then ${created.repeat}` : ""}` };
}

async function listSchedule(_input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const file = await readLifeFile(ctx.deps.storage, ctx.waifu.id, "schedule");
  if (file.reminders.length === 0) return { content: "(no reminders)" };
  const lines = [...file.reminders]
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
    .map((reminder) => `${reminder.id} · ${dayTimeText(new Date(reminder.dueAt), ctx.deps.timeZone)}${reminder.repeat ? ` · ${reminder.repeat}` : ""} · ${quote(reminder.note)}`);
  return { content: lines.join("\n") };
}

async function cancelWake(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(IdInput, input);
  if (!parsed.ok) return parsed.output;
  const id = parsed.value.id.trim().toLowerCase();
  let found = false;
  await updateLifeFile(ctx.deps.storage, ctx.waifu.id, "schedule", (file) => {
    const reminders = file.reminders.filter((reminder) => reminder.id !== id);
    found = reminders.length !== file.reminders.length;
    return found ? { ...file, reminders } : file;
  });
  if (!found) return toolError(`no reminder ${id}; use list_schedule`);
  return { content: `cancelled ${id}` };
}

export const planningTools: LifeTool[] = [
  {
    name: "watch_for",
    description:
      "Get notified when something happens: a message in a place, from a person, containing some words, or any message. A binding matches when every field it sets matches; any binding can fire the watch. It expires after the minutes you choose.",
    inputSchema: {
      type: "object",
      properties: {
        bindings: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: {
            type: "object",
            properties: {
              place: { type: "string", description: "A place handle." },
              from: { type: "string", description: "A person's name, or <@id>." },
              words: { type: "array", items: { type: "string" }, maxItems: 10, description: "Any of these words (whole words, any case)." },
              any_message: { type: "boolean" }
            },
            additionalProperties: false
          }
        },
        note: { type: "string", maxLength: 200, description: "A note to yourself, shown when it fires." },
        expires_in_minutes: { type: "integer", minimum: 5, maximum: 10080 },
        once: { type: "boolean", description: "Stop after the first match (default true)." }
      },
      required: ["bindings", "note", "expires_in_minutes"],
      additionalProperties: false
    },
    sideEffect: true,
    run: watchFor
  },
  {
    name: "list_watches",
    description: "List your active watches.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    sideEffect: false,
    run: listWatches
  },
  {
    name: "cancel_watch",
    description: "Cancel one of your watches by id (like w3).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    sideEffect: true,
    run: cancelWatch
  },
  {
    name: "schedule_wake",
    description:
      "Set a reminder that wakes you later with your note. Give either `at` (local time like 2026-10-25 18:00) or `in_minutes`; 5 minutes to 30 days ahead. Optionally repeat daily or weekly.",
    inputSchema: {
      type: "object",
      properties: {
        at: { type: "string", description: "Local date and time, like 2026-10-25 18:00." },
        in_minutes: { type: "integer", minimum: 5 },
        note: { type: "string", maxLength: 200 },
        repeat: { type: "string", enum: ["daily", "weekly"] }
      },
      required: ["note"],
      additionalProperties: false
    },
    sideEffect: true,
    run: scheduleWake
  },
  {
    name: "list_schedule",
    description: "List your pending reminders.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    sideEffect: false,
    run: listSchedule
  },
  {
    name: "cancel_wake",
    description: "Cancel one of your reminders by id (like r4).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    sideEffect: true,
    run: cancelWake
  }
];
