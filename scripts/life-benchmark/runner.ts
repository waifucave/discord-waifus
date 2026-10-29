// One benchmark run (spec §33.2): a scenario's timeline played against her real life on a simulated
// clock. Between turns the clock jumps to the next scenario event, the next scheduler tick (every
// `tickMinutes`) or the next time one of her wakeups is due; while she thinks no simulated time
// passes, except the waits she declares herself (what people write meanwhile is delivered then).
// Everything is observed from outside the life: what reached the fake server, the wakes the router
// took, her life log (tool calls and results), her home files and the model calls.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readLifeFile, readLifeLog, readLifeState, listLogEpochs } from "../../src/life/lifeStore.js";
import { homeStoreFor } from "../../src/life/home/index.js";
import { parseLocalDateTime } from "../../src/life/clock.js";
import { untilOf } from "../../src/life/wakeups/file.js";
import { nextTimes } from "../../src/life/wakeups/schedule.js";
import { selfSummaryOf } from "../../src/life/rest.js";
import type { Wake } from "../../src/shared/schemas/life.js";
import { evaluateProbes } from "./probes.js";
import { computeMetrics, factsFound } from "./metrics.js";
import { messageText, type CallRecord } from "./models.js";
import type { SentRecord, SimClock } from "./fakeServer.js";
import { scenarioClock, scenarioStartMs, scenarioTimeMs, type MessageEvent, type Scenario, type ScenarioEvent } from "./scenario.js";
import type { RunRecord, RunStatus, SummaryCapture, TranscriptEvent } from "./types.js";
import { withVariant, type PromptVariant } from "./variants.js";
import { buildWorld, routeId, type ModelPick, type World } from "./world.js";
import type { ProviderKeyLookup } from "../../src/models/credentials.js";

/** The dollars every run of an invocation shares (`--max-usd`): no new turn starts once it is spent. */
export class Budget {
  spent = 0;
  constructor(readonly maxUsd?: number) {}
  add(usd: number | undefined): void {
    if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) this.spent += usd;
  }
  get exceeded(): boolean {
    return this.maxUsd !== undefined && this.spent >= this.maxUsd;
  }
}

export class BudgetExceededError extends Error {
  readonly kind = "budget";
  constructor() {
    super("benchmark --max-usd reached");
  }
}

export type RunSpec = {
  runId: string;
  scenario: Scenario;
  model: ModelPick;
  variant: PromptVariant;
  repeat: number;
  dryRun: boolean;
  web: boolean;
  credentials?: ProviderKeyLookup;
  budget: Budget;
  tempBase?: string;
  /** Progress lines (the CLI prints them). */
  progress?: (line: string) => void;
};

/** Checkpoint snapshots for probes: her home's text files and the next firing of each wakeup, at a time. */
export type Checkpoint = { at: string; label: string; home: Record<string, string>; wakeupsDue: string[] };

/** `blockA`: her prompt's block A as her last epoch had it (a variant's edits included). */
export type RunOutput = RunRecord & { checkpoints: Checkpoint[]; blockA?: string };

const MAX_HOME_FILE = 64 * 1024;

/** Her home's text files (path under ~ → text), files over 64 KB left out. */
export async function snapshotHome(world: Pick<World, "root" | "waifuId">): Promise<Record<string, string>> {
  const base = path.join(world.root, "user", "waifus", world.waifuId, "home");
  const out: Record<string, string> = {};
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const full = path.join(dir, name);
      const info = await stat(full).catch(() => undefined);
      if (!info) continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      if (info.isDirectory()) await walk(full, relative);
      else if (info.size <= MAX_HOME_FILE) {
        const text = await readFile(full, "utf8").catch(() => undefined);
        if (text !== undefined && !text.includes("\u0000")) out[relative] = text;
      }
    }
  };
  await walk(base, "");
  return out;
}

function homeDiff(before: Record<string, string>, after: Record<string, string>): { changed: string[]; text: string } {
  const changed: string[] = [];
  const parts: string[] = [];
  for (const file of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (file === "life/places.md" || before[file] === after[file]) continue;
    changed.push(file);
    if (after[file] === undefined) parts.push(`--- ~/${file} (deleted)`);
    else parts.push(`--- ~/${file}${before[file] === undefined ? " (new)" : ""}\n${after[file]}`);
  }
  return { changed, text: parts.join("\n\n") };
}

/** Her notes as one text (what the dream leaves her with): every home file but the generated places list. */
function notesText(home: Record<string, string>): string {
  return Object.entries(home)
    .filter(([file]) => file !== "life/places.md")
    .map(([file, text]) => `--- ~/${file}\n${text}`)
    .join("\n\n");
}

/** When each of her wakeups next fires or ends, after `now`. */
async function wakeupTimes(world: World, now: Date): Promise<Date[]> {
  const store = homeStoreFor(world.runtime.cast.deps, world.waifu);
  const { entries } = await store.readWakeups().catch(() => ({ entries: [] }));
  const tz = world.scenario.start.timeZone;
  const out: Date[] = [];
  for (const entry of entries) {
    if (entry.disabled !== undefined) continue;
    if (entry.kind === "at" && entry.when) {
      const due = parseLocalDateTime(entry.when, tz);
      if (due) out.push(due);
    } else if (entry.kind === "every") out.push(...nextTimes(entry, now, tz, 1));
    else {
      const until = untilOf(entry, tz);
      if (until) out.push(until);
    }
  }
  return out;
}

type Timed = { event: ScenarioEvent; atMs: number };

export async function runOne(spec: RunSpec): Promise<RunOutput> {
  return withVariant(spec.variant, () => runInside(spec));
}

async function runInside(spec: RunSpec): Promise<RunOutput> {
  const { scenario } = spec;
  const realStart = performance.now();
  const events: TranscriptEvent[] = [];
  const calls: CallRecord[] = [];
  const summaries: SummaryCapture[] = [];
  const checkpoints: Checkpoint[] = [];
  const herMessageIds: string[] = [];
  let currentTurnId: string | undefined;
  let world: World | undefined;
  let delivering = false;
  let status: RunStatus = "done";
  let error: string | undefined;
  const startMs = scenarioStartMs(scenario);
  const endMs = scenarioTimeMs(scenario, scenario.end);
  const timeline: Timed[] = scenario.events.map((event) => ({ event, atMs: scenarioTimeMs(scenario, event.at) }));
  let next = 0;
  const iso = (ms: number) => new Date(ms).toISOString();
  const simNow = () => (world ? world.clock.ms : startMs);
  const push = (event: TranscriptEvent) => events.push(event);
  push({ type: "start", at: iso(startMs), runId: spec.runId, scenario: scenario.id, model: routeId(spec.model), variant: spec.variant.id, repeat: spec.repeat, dryRun: spec.dryRun });

  // ---- epochs, summaries and her log, observed before every model call and after every step ----
  const seenSeq = new Map<number, number>();
  const seenBlocks = new Set<string>();
  /** When she last had a turn (the morning summary's input starts there). */
  let lastActiveMs = startMs;
  let lastEpochSeen = 0;
  let consumedSeq = 0;
  let observing: Promise<void> | undefined;
  const summaryFacts = (at: string, output: string, window?: { fromMs: number }) => {
    const due = scenario.facts.filter((fact) => {
      if (!fact.from) return true;
      const id = world?.messageIdByLabel.get(fact.from);
      const posted = events.find((event) => event.type === "people" && event.messageId === id);
      if (!posted) return false;
      const postedMs = Date.parse(posted.at);
      return postedMs <= Date.parse(at) && (window === undefined || postedMs > window.fromMs);
    });
    return factsFound(due, output);
  };
  const observe = async (): Promise<void> => {
    if (!world) return;
    const w = world;
    const epochs = await listLogEpochs(w.storage, w.waifuId).catch(() => [] as number[]);
    for (const epoch of epochs) {
      const lines = await readLifeLog(w.storage, w.waifuId, epoch).catch(() => []);
      const seen = seenSeq.get(epoch) ?? -1;
      for (const line of lines) {
        if (line.seq <= seen) continue;
        seenSeq.set(epoch, line.seq);
        const message = line.message as { role?: string; content?: unknown } | null;
        if (line.kind === "compaction_boundary" && line.boundary && epoch > lastEpochSeen) {
          lastEpochSeen = epoch;
          if (epoch === 1 && line.boundary.reason === "first") continue;
          const reason = line.boundary.reason;
          const after = calls.filter((call) => call.seq > consumedSeq && call.result);
          let candidate: CallRecord | undefined;
          let kind: SummaryCapture["kind"] = "compaction";
          if (reason === "rest" || reason === "cache_rest") {
            kind = reason;
            candidate = [...after].reverse().find((call) => call.restNotice);
          } else if (reason === "self") {
            kind = "self";
            candidate = [...after].reverse().find((call) => call.purpose === "life" && selfSummaryOf(call.result!.text) !== undefined);
          } else candidate = [...after].reverse().find((call) => call.purpose === "compaction" && call.result!.text.trim() && call.result!.finishReason !== "length");
          consumedSeq = calls.length > 0 ? calls[calls.length - 1]!.seq : consumedSeq;
          let summaryId: string | undefined;
          if (candidate) {
            const output = kind === "self" ? (selfSummaryOf(candidate.result!.text) ?? "") : candidate.result!.text.trim();
            const inputText = (candidate.input.messages ?? []).map((m) => messageText(m as never)).join("\n\n");
            summaryId = `s${summaries.length + 1}`;
            summaries.push({
              id: summaryId,
              at: line.at,
              kind,
              reason,
              fromEpoch: line.boundary.fromEpoch,
              toEpoch: epoch,
              route: candidate.route,
              input: { ...(candidate.input.system ? { system: candidate.input.system } : {}), ...(candidate.input.messages ? { messages: candidate.input.messages } : {}), ...(candidate.input.tools ? { tools: candidate.input.tools } : {}), text: inputText },
              output,
              inputChars: inputText.length,
              outputChars: output.length,
              facts: summaryFacts(line.at, output)
            });
          }
          push({ type: "compaction", at: line.at, fromEpoch: line.boundary.fromEpoch, toEpoch: epoch, reason, summarized: candidate !== undefined, ...(summaryId ? { summaryId } : {}) });
          continue;
        }
        // A new epoch starts with copies of the turns it kept: each block is reported once.
        const fresh = (block: unknown) => {
          const key = `${line.turnId ?? ""}\u0000${line.kind}\u0000${JSON.stringify(block)}`;
          if (seenBlocks.has(key)) return false;
          seenBlocks.add(key);
          return true;
        };
        if (!message || !Array.isArray(message.content)) {
          if (message && typeof message.content === "string" && line.kind === "assistant" && message.content.trim() && fresh(message.content)) push({ type: "thought", at: line.at, epoch, ...(line.turnId ? { turnId: line.turnId } : {}), text: message.content });
          continue;
        }
        for (const block of message.content as Array<Record<string, unknown>>) {
          if (!fresh(block)) continue;
          const base = { at: line.at, epoch, ...(line.turnId ? { turnId: line.turnId } : {}) };
          if (block.type === "tool_use") push({ type: "tool_call", ...base, id: String(block.id), name: String(block.name), input: block.input });
          else if (block.type === "tool_result") {
            const content = typeof block.content === "string" ? block.content : messageText({ content: block.content as never });
            push({ type: "tool_result", ...base, id: String(block.tool_use_id), isError: block.is_error === true, content: content.slice(0, 4_000) });
          } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            if (line.kind === "assistant") push({ type: "thought", ...base, text: block.text });
            else if (line.kind === "notifications") {
              push({ type: "notifications", ...base, text: block.text });
              // Her morning summary (§23): the app's own overnight batch (no model), scored for the
              // facts that came in since she was last awake.
              if (block.text.includes("Good morning")) {
                const input = events.filter((event) => event.type === "people" && Date.parse(event.at) > lastActiveMs && Date.parse(event.at) <= Date.parse(line.at));
                const inputText = input.map((event) => (event.type === "people" ? `[${scenarioClock(scenario, Date.parse(event.at))} ${event.place}] ${event.from}: ${event.text}` : "")).join("\n");
                summaries.push({ id: `s${summaries.length + 1}`, at: line.at, kind: "morning", input: { text: inputText }, output: block.text, inputChars: inputText.length, outputChars: block.text.length, facts: summaryFacts(line.at, block.text, { fromMs: lastActiveMs }) });
              }
            }
          }
        }
      }
    }
  };
  const observeSafely = async () => {
    // One observer at a time; a call that comes in while one runs waits for it.
    while (observing) await observing;
    observing = observe().catch(() => undefined).finally(() => {
      observing = undefined;
    });
    await observing;
  };

  // ---- delivery ----------------------------------------------------------------------------------
  const mentionText = (w: World, event: MessageEvent) => {
    let text = event.text;
    const users: Record<string, string> = {};
    for (const key of event.mentions) {
      const who = key === "her" ? { id: scenario.waifu.botUserId, name: scenario.waifu.displayName ?? scenario.waifu.name } : w.personByKey(key)!;
      users[who.id] = who.name;
      const at = new RegExp(`@${who.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu");
      text = at.test(text) ? text.replace(at, `<@${who.id}>`) : `<@${who.id}> ${text}`;
    }
    return { text, users };
  };
  const deliver = async (w: World, timed: Timed): Promise<void> => {
    const event = timed.event;
    if (event.kind === "quiet") return;
    const person = w.personByKey(event.kind === "join" ? event.who : event.from)!;
    const dm = event.place.startsWith("dm:");
    const conversation = dm ? w.server.dmRef(person.id) : w.server.guildRef(scenario.server!.channels.find((channel) => `#${channel.key}` === event.place)!.id);
    if (event.kind === "join") {
      const message = w.server.post(conversation, { id: person.id, name: person.name, bot: false }, "", { type: 7 });
      if (event.label) w.messageIdByLabel.set(event.label, message.id);
      push({ type: "people", at: message.createdAt, place: event.place, from: person.name, text: "[joined the server]", messageId: message.id, join: true, ...(event.label ? { label: event.label } : {}) });
      if (conversation.kind === "guild") await w.runtime.handleDiscordMessage({ guildId: conversation.guildId, channelId: conversation.channelId, messageId: message.id, authorId: person.id, authorDisplayName: person.name, authorBot: false });
      return;
    }
    const { text, users } = mentionText(w, event);
    let replyTo: string | undefined;
    if (event.replyTo?.startsWith("her:")) replyTo = herMessageIds[Number(event.replyTo.slice(4)) - 1];
    else if (event.replyTo) replyTo = w.messageIdByLabel.get(event.replyTo);
    const message = w.server.post(conversation, { id: person.id, name: person.name, bot: false }, text, { ...(replyTo ? { replyTo } : {}), mentions: users, everyone: event.everyone, attachments: event.attachments });
    w.eventByMessageId.set(message.id, event);
    if (event.label) w.messageIdByLabel.set(event.label, message.id);
    push({ type: "people", at: message.createdAt, place: event.place, from: person.name, text: event.text, messageId: message.id, ...(event.label ? { label: event.label } : {}), ...(event.replyTo ? { replyTo: event.replyTo } : {}), ...(event.attachments.length ? { attachments: event.attachments.map((a) => a.name) } : {}) });
    if (conversation.kind === "guild") await w.runtime.handleDiscordMessage({ guildId: conversation.guildId, channelId: conversation.channelId, messageId: message.id, authorId: person.id, authorDisplayName: person.name, authorBot: false });
    else await w.runtime.handleDirectMessage({ waifuId: w.waifuId, botId: w.waifu.botId!, userId: person.id, userDisplayName: person.name, channelId: `dm-${person.id}`, messageId: message.id, createdAt: message.createdAt });
  };
  /** Delivers every event due by `untilMs`, a burst at a time (a room burst fires after its last message, as the intake's hold would). */
  const deliverUntil = async (w: World, untilMs: number): Promise<void> => {
    if (delivering) return;
    delivering = true;
    try {
      const serverHold = w.config.discord.debounce.serverMs;
      while (next < timeline.length && timeline[next]!.atMs <= untilMs) {
        const timed = timeline[next]!;
        next += 1;
        w.clock.set(timed.atMs);
        await deliver(w, timed);
        const following = timeline[next];
        const sameBurst = following && following.event.kind !== "quiet" && timed.event.kind !== "quiet" && following.event.place === timed.event.place && following.atMs - timed.atMs <= serverHold && following.atMs <= untilMs;
        if (!sameBurst) {
          w.runtime.cast.intake.flushDetector();
          await w.runtime.cast.intake.settle();
        }
      }
    } finally {
      delivering = false;
    }
  };

  try {
    world = await buildWorld({
      scenario,
      model: spec.model,
      dryRun: spec.dryRun,
      web: spec.web,
      ...(spec.credentials ? { credentials: spec.credentials } : {}),
      ...(spec.tempBase ? { tempBase: spec.tempBase } : {}),
      sleep: (clock: SimClock) => async (ms: number) => {
        const target = clock.ms + Math.max(0, ms);
        if (world && !delivering) await deliverUntil(world, target);
        clock.set(target);
      },
      onCall: (call) => {
        calls.push(call);
        if (call.purpose === "life" && call.turnId) currentTurnId = call.turnId;
        spec.budget.add(call.result?.costUsd);
        push({
          type: "call",
          at: call.at,
          seq: call.seq,
          purpose: call.purpose,
          ...(call.turnId ? { turnId: call.turnId } : {}),
          route: call.route,
          ...(call.result ? { finish: call.result.finishReason, ...(call.result.inputTokens !== undefined ? { inputTokens: call.result.inputTokens, outputTokens: call.result.outputTokens!, cacheReadTokens: call.result.cacheReadTokens ?? 0 } : {}), ...(call.result.costUsd !== undefined ? { costUsd: call.result.costUsd } : {}), toolCalls: call.result.toolCalls.map((tool) => tool.name) } : {}),
          ...(call.error ? { error: call.error.kind, errorMessage: call.error.message, ...(call.error.status !== undefined ? { errorStatus: call.error.status } : {}), ...(call.error.providerCode ? { errorCode: call.error.providerCode } : {}) } : {}),
          realMs: call.realMs
        });
      },
      onSent: (record: SentRecord) => {
        const place = world?.placeOf(record.placeKey) ?? record.placeKey;
        if (record.kind === "reaction") {
          push({ type: "reaction", at: record.at, place, messageId: record.messageId, emoji: record.emoji ?? "", ...(currentTurnId ? { turnId: currentTurnId } : {}) });
          return;
        }
        herMessageIds.push(record.messageId);
        const label = record.replyToMessageId ? world?.eventByMessageId.get(record.replyToMessageId)?.label : undefined;
        push({ type: "sent", at: record.at, place, dm: record.dm, text: record.content, messageId: record.messageId, ...(record.replyToMessageId ? { replyTo: record.replyToMessageId } : {}), ...(label ? { replyToLabel: label } : {}), ...(record.files ? { files: record.files.map((file) => file.name) } : {}), ...(currentTurnId ? { turnId: currentTurnId } : {}) });
      },
      onLog: (note) => push({ type: "log", ...note })
    });
    const w = world;
    const router = w.runtime.cast.router;
    const route = router.route.bind(router);
    router.route = async (waifuId: string, wake: Wake, options?: Parameters<typeof route>[2]) => {
      const outcome = await route(waifuId, wake, options);
      const place = wake.placeKey ? w.placeOf(wake.placeKey) : undefined;
      push({ type: "wake", at: iso(w.clock.ms), reason: wake.reason, ...(place ? { place } : {}), outcome, ...(wake.note ? { note: wake.note } : {}), ...(wake.fromName ? { fromName: wake.fromName } : {}), wakeId: wake.id });
      return outcome;
    };
    // Nightly maintenance: her home before and after, with the dream's calls as its input.
    const schedulerHooks = (w.runtime.cast.scheduler as unknown as { o?: { hooks?: { maintain?: (...args: never[]) => Promise<void> } } }).o?.hooks;
    if (schedulerHooks?.maintain) {
      const maintain = schedulerHooks.maintain.bind(schedulerHooks) as (...args: unknown[]) => Promise<void>;
      schedulerHooks.maintain = (async (...args: unknown[]) => {
        const before = await snapshotHome(w);
        const fromSeq = calls.length > 0 ? calls[calls.length - 1]!.seq : 0;
        try {
          await maintain(...args);
        } finally {
          const after = await snapshotHome(w);
          const diff = homeDiff(before, after);
          const dreamCalls = calls.filter((call) => call.seq > fromSeq && call.purpose === "maintenance");
          let summaryId: string | undefined;
          if (dreamCalls.length > 0) {
            // Each dream session's last call holds its whole session: the window it was given and
            // every transcript file it read (a new session starts over with fewer messages).
            const size = (call: CallRecord) => call.input.messages?.length ?? 0;
            const sessions = dreamCalls.filter((call, index) => index === dreamCalls.length - 1 || size(dreamCalls[index + 1]!) <= size(call));
            const messages = sessions.flatMap((call) => call.input.messages ?? []);
            const inputText = messages.map((m) => messageText(m as never)).join("\n\n");
            summaryId = `s${summaries.length + 1}`;
            summaries.push({ id: summaryId, at: iso(w.clock.ms), kind: "dream", route: sessions[0]!.route, input: { ...(sessions[0]!.input.system ? { system: sessions[0]!.input.system } : {}), messages, text: inputText }, output: diff.text, inputChars: inputText.length, outputChars: diff.text.length, facts: summaryFacts(iso(w.clock.ms), notesText(after)) });
          }
          push({ type: "maintenance", at: iso(w.clock.ms), changed: diff.changed, ...(summaryId ? { summaryId } : {}) });
        }
      }) as never;
    }
    // Before each model call: the dollar cap, then what her log and epochs show so far (keeps
    // every summary next to the call that made it).
    w.models.setBeforeCall(async () => {
      if (spec.budget.exceeded) throw new BudgetExceededError();
      await observeSafely();
    });

    const settle = async () => {
      await w.runtime.cast.settle();
    };
    const lifeUntilIdle = async () => {
      const life = w.runtime.cast.life(w.waifuId);
      for (let guard = 0; guard < 40; guard += 1) {
        if (spec.budget.exceeded) {
          status = "max_usd";
          return;
        }
        await life.runNow();
        await settle();
        await observeSafely();
        const queue = await readLifeFile(w.storage, w.waifuId, "wakes");
        if (queue.immediate.length === 0 && !life.busy) break;
      }
      const lastCall = [...calls].reverse().find((call) => call.purpose === "life");
      if (lastCall) lastActiveMs = Date.parse(lastCall.at);
    };
    const checkpointTimes = new Map<number, string>();
    for (const probe of scenario.probes) {
      if (probe.kind === "note_mentions" && probe.by) checkpointTimes.set(scenarioTimeMs(scenario, probe.by), probe.by);
      if (probe.kind === "wakeup_in_window" && probe.mode === "scheduled") checkpointTimes.set(scenarioTimeMs(scenario, probe.checkAt ?? probe.from), probe.checkAt ?? probe.from);
    }
    const pendingCheckpoints = [...checkpointTimes.entries()].sort((a, b) => a[0] - b[0]);
    const takeCheckpoint = async (label: string) => {
      const due = (await wakeupTimes(w, w.clock.now())).map((date) => date.toISOString());
      checkpoints.push({ at: iso(w.clock.ms), label, home: await snapshotHome(w), wakeupsDue: due });
      push({ type: "checkpoint", at: iso(w.clock.ms), label });
    };
    const runCheckpoints = async () => {
      while (pendingCheckpoints.length > 0 && pendingCheckpoints[0]![0] <= w.clock.ms) {
        const [, label] = pendingCheckpoints.shift()!;
        await takeCheckpoint(label);
      }
    };

    const tickMs = scenario.tickMinutes * 60_000;
    const align = (ms: number) => Math.ceil(ms / tickMs) * tickMs;
    let nextTick = startMs;
    let lastReport = startMs;
    while (status === "done") {
      const nextEvent = timeline[next]?.atMs ?? Number.POSITIVE_INFINITY;
      const due = (await wakeupTimes(w, w.clock.now())).map((date) => date.getTime()).filter((ms) => ms > w.clock.ms);
      const nextDue = due.length > 0 ? Math.min(...due) : Number.POSITIVE_INFINITY;
      const nextCheckpoint = pendingCheckpoints[0]?.[0] ?? Number.POSITIVE_INFINITY;
      const target = Math.min(nextEvent, nextTick, nextDue, nextCheckpoint);
      if (target > endMs) break;
      w.clock.set(target);
      await deliverUntil(w, w.clock.ms);
      if (w.clock.ms >= nextTick || w.clock.ms >= nextDue) {
        await w.runtime.cast.scheduler.tick();
        nextTick = align(w.clock.ms + 1);
      }
      await runCheckpoints();
      await lifeUntilIdle();
      if (spec.progress && w.clock.ms - lastReport >= 6 * 3_600_000) {
        lastReport = w.clock.ms;
        spec.progress(`${spec.runId}: ${scenarioClock(scenario, w.clock.ms)}, ${events.filter((event) => event.type === "sent").length} messages, $${spec.budget.spent.toFixed(3)} spent overall`);
      }
    }
    if (status === "done") {
      w.clock.set(endMs);
      await deliverUntil(w, endMs);
      await w.runtime.cast.scheduler.tick();
      await lifeUntilIdle();
      await runCheckpoints();
    }
    await observeSafely();
    await takeCheckpoint("end");
  } catch (failure) {
    if (failure instanceof BudgetExceededError) status = "max_usd";
    else {
      status = "error";
      error = failure instanceof Error ? failure.message.slice(0, 300) : "run failed";
    }
  }
  const home = world ? await snapshotHome(world).catch(() => ({})) : {};
  const blockA = world ? await readLifeState(world.storage, world.waifuId).then((state) => state.systemSnapshot?.harness, () => undefined) : undefined;
  const ledgerLines = world?.ledger.lines ?? [];
  const reachedMs = world?.clock.ms ?? startMs;
  if (world) {
    for (const decision of world.detector.decisions) push({ type: "detector", ...decision });
    await world.close();
  }
  const realSeconds = Math.round((performance.now() - realStart) / 100) / 10;
  push({ type: "end", at: iso(reachedMs), status, realSeconds });
  const record = { events, summaries, calls, home, checkpoints, ...(blockA !== undefined ? { blockA } : {}) };
  const probes = evaluateProbes(scenario, record);
  const metrics = computeMetrics({ events, summaries, ledger: ledgerLines, probes });
  return {
    ...record,
    summary: {
      runId: spec.runId,
      scenario: scenario.id,
      model: routeId(spec.model),
      variant: spec.variant.id,
      repeat: spec.repeat,
      dryRun: spec.dryRun,
      status,
      ...(error ? { error } : {}),
      simulated: { from: iso(startMs), to: iso(endMs), reached: iso(reachedMs) },
      realSeconds,
      metrics,
      probes
    }
  };
}
