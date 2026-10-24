// `waifus wake | life | forget | usage` (Living cast spec §14.2): a waifu's life from the command
// line, over the running host's API (usage reads the ledger directly, so it works offline too).
// Life-log rendering is generic over tool names: a call prints its name and arguments as given.

import { FORGET_LIMITS_TEXT } from "../shared/constants/forget.js";
import type {
  LifeLogResponseSchema,
  LifeStatusResponseSchema,
  PeopleForgetResponseSchema,
  WakeResponseSchema
} from "../shared/schemas/api.js";
import type { z } from "zod";
import { localDayKey } from "../life/clock.js";
import { hostTimeZone } from "../orchestration/context/timeFormat.js";
import { assertTimeZone, parseGroupBy, shiftDay, usageReport, UsageQueryError, type UsageReport } from "../orchestration/usageReport.js";
import { call, CliFailure, EXIT, requireHost, usageError, type CliContext, type ExitCode } from "./cliContext.js";

type LifeStatus = z.output<typeof LifeStatusResponseSchema>;
type LifeLog = z.output<typeof LifeLogResponseSchema>;
type WakeResult = z.output<typeof WakeResponseSchema>;
type ForgetResult = z.output<typeof PeopleForgetResponseSchema>;

const SAFE_ID = /^[A-Za-z0-9._:-]+$/u;
const SNOWFLAKE = /^\d{17,20}$/u;

function waifuIdArg(raw: string | undefined): string {
  if (!raw) throw usageError("Name a waifu (her id, as in waifus list waifu).");
  if (!SAFE_ID.test(raw) || /^\.+$/u.test(raw)) throw usageError(`Invalid waifu id: ${raw}.`);
  return raw;
}

const WAKE_OUTCOMES: Record<WakeResult["outcome"], string> = {
  queued: "woken: her turn starts shortly",
  deferred: "queued for later: she is asleep or over her budget",
  quiet: "merged into a wake already waiting",
  dropped: "not woken: the cast is paused or she is disabled",
  queued_offline: "queued: Discord is offline, the wake runs when the cast connects"
};

/** `waifus wake WAIFU [NOTE…]`: an owner wake (skips sleep and budget), with a note she sees. */
export async function wakeCommand(ctx: CliContext, args: readonly string[], o: { stdin?: boolean } = {}): Promise<ExitCode> {
  const waifuId = waifuIdArg(args[0]);
  const note = (o.stdin ? ((await ctx.readStdin()) ?? "") : args.slice(1).join(" ")).trim();
  if (note.length > 500) throw usageError("A wake note is at most 500 characters.");
  const host = await requireHost(ctx);
  const { body } = await call<WakeResult>(host, { method: "POST", path: `/api/waifus/${encodeURIComponent(waifuId)}/wake`, body: note ? { note } : {} }, `Waking ${waifuId}`);
  if (ctx.json) ctx.out(JSON.stringify({ ok: true, ...body }, null, 2));
  else ctx.out(`${waifuId}: ${WAKE_OUTCOMES[body.outcome]}`);
  return EXIT.ok;
}

function shortJson(value: unknown, max = 160): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function oneLine(text: string, max = 400): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One life-log line, generic over tool names. */
export function renderLogLine(line: LifeLog["lines"][number]): string[] {
  const head = `[${line.at}] #${line.seq} ${line.kind}${line.role ? ` ${line.role}` : ""}${line.dm ? " (private chat)" : ""}`;
  if (line.boundary) return [`${head}: new epoch (from ${line.boundary.fromEpoch}, ${line.boundary.reason}, ${line.boundary.keptTurns} turns kept)`];
  const out = [head];
  for (const block of line.blocks) {
    if (block.redacted) {
      out.push(`  ${block.type === "tool_use" ? `→ ${block.name ?? "tool"}(…)` : block.type === "tool_result" ? "←" : "·"} [private chat redacted]`);
      continue;
    }
    switch (block.type) {
      case "text":
        out.push(`  ${oneLine(block.text ?? "")}`);
        break;
      case "tool_use":
        out.push(`  → ${block.name ?? "tool"}(${shortJson(block.input ?? {})})`);
        break;
      case "tool_result":
        out.push(`  ←${block.isError ? " error:" : ""} ${oneLine(block.text ?? "", 240)}`);
        break;
      case "image":
        out.push("  [image]");
        break;
      case "reasoning":
        out.push("  [reasoning]");
        break;
      default:
        out.push(`  [${block.type}]`);
    }
  }
  return out;
}

function statusLines(status: LifeStatus): string[] {
  const availability =
    status.availability.state === "awake"
      ? "awake"
      : status.availability.state === "asleep"
        ? `asleep${status.availability.until ? ` until ${status.availability.until}` : ""}`
        : `busy${status.availability.reason ? ` (${status.availability.reason}` : ""}${status.availability.until ? ` until ${status.availability.until}` : ""}${status.availability.reason ? ")" : ""}`;
  const model = status.model ? `${status.model.providerId}/${status.model.modelId}${status.model.effort ? `@${status.model.effort}` : ""}` : "(none)";
  const lines = [
    `${status.displayName} (${status.waifuId})${status.enabled ? "" : " [disabled]"}`,
    `  model:        ${model}${status.hasBot ? "" : "  (speaks through the House bot)"}`,
    `  state:        ${availability}; ${status.status === "turn" ? "mid-turn" : "idle"}${status.runtime.paused ? "; cast paused" : ""}${status.runtime.running ? "" : "; Discord offline"}`,
    `  life:         ${status.started ? `epoch ${status.epoch} since ${status.epochStartedAt}, ${status.logLines} log lines` : "not started yet"}`,
    `  last turn:    ${status.lastTurnEndedAt ?? "never"}${status.failedTurnAt ? `  (last failed turn ${status.failedTurnAt})` : ""}`,
    `  queue:        ${status.queue.immediate} now, ${status.queue.deferred.items} deferred${status.queue.deferred.reason ? ` (${status.queue.deferred.reason})` : ""}, ${status.queue.quiet} quiet`,
    `  today:        $${status.today.costUsd.toFixed(4)} in ${status.today.calls} calls${status.today.budgetUsd !== null ? ` (budget $${status.today.budgetUsd})` : ""}; ${status.today.searches} searches, ${status.today.fetches} fetches`
  ];
  if (status.lastCompaction) lines.push(`  compacted:    ${status.lastCompaction.at} (${status.lastCompaction.reason}${status.lastCompaction.summarized ? "" : ", no summary"})`);
  if (status.counts.needsReview > 0) lines.push(`  needs review: ${status.counts.needsReview} line(s) a forget could not remove for sure (dashboard → Life)`);
  if (status.counts.pendingScrubs > 0) lines.push(`  forget scrubs waiting: ${status.counts.pendingScrubs}`);
  for (const wake of status.queue.wakes.slice(0, 10)) {
    const place = wake.place ? (wake.dm ? " in a DM" : ` in ${wake.place}`) : "";
    const text = wake.preview ? `: ${oneLine(wake.preview, 120)}` : wake.note ? `: "${oneLine(wake.note, 120)}"` : wake.dm ? " [private chat]" : "";
    lines.push(`  · ${wake.reason}${place}${wake.from ? ` from ${wake.from}` : ""}${text}`);
  }
  if (status.summary.hidden) lines.push("  summary:      hidden (it may hold private-chat content; --private shows it)");
  else if (status.summary.text) lines.push("  summary:", ...status.summary.text.split("\n").map((line) => `    ${line}`));
  return lines;
}

/** `waifus life WAIFU [--log] [--limit N] [--private]`. */
export async function lifeCommand(ctx: CliContext, args: readonly string[], o: { log?: boolean; limit?: string; private?: boolean }): Promise<ExitCode> {
  const waifuId = waifuIdArg(args[0]);
  if (args.length > 1) throw usageError("waifus life takes one waifu.");
  let limit = 20;
  if (o.limit !== undefined) {
    limit = Number(o.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw usageError("--limit is a whole number from 1 to 200.");
  }
  const host = await requireHost(ctx);
  const suffix = o.private ? "includePrivate=1" : "";
  const base = `/api/waifus/${encodeURIComponent(waifuId)}/life`;
  const status = (await call<LifeStatus>(host, { method: "GET", path: `${base}${suffix ? `?${suffix}` : ""}` }, `Reading ${waifuId}'s life`)).body;
  const log = o.log
    ? (await call<LifeLog>(host, { method: "GET", path: `${base}/log?limit=${limit}${suffix ? `&${suffix}` : ""}` }, `Reading ${waifuId}'s life log`)).body
    : undefined;
  if (ctx.json) {
    ctx.out(JSON.stringify({ ok: true, status, ...(log ? { log } : {}) }, null, 2));
    return EXIT.ok;
  }
  for (const line of statusLines(status)) ctx.out(line);
  if (log) {
    ctx.out("");
    ctx.out(`Life log, epoch ${log.epoch} (newest ${log.lines.length}${log.hasMore ? ", older lines exist" : ""}):`);
    for (const line of log.lines) for (const text of renderLogLine(line)) ctx.out(text);
    if (log.redactedBlocks > 0) ctx.out(`(${log.redactedBlocks} block(s) from private chats left out; --private shows them on this computer)`);
  }
  return EXIT.ok;
}

function forgetSummary(result: ForgetResult): string[] {
  const verb = result.dryRun ? "would remove" : "removed";
  const lines = [
    `${result.dryRun ? "Dry run for" : "Forgot"} ${result.discordUserId}: ${verb} ${result.dmStates} DM state file(s), ${result.dmContexts} DM conversation(s), ${result.dmLimits} rate-limit file(s), ${result.cachedImages} cached image(s)${result.memberLists !== undefined ? `, ${result.memberLists} member-list entr${result.memberLists === 1 ? "y" : "ies"}` : ""}.`
  ];
  if (result.archive) lines.push(`  archive: ${result.archive.removed} of ${result.archive.files} file(s) scrubbed${result.archive.unreadable ? `, ${result.archive.unreadable} unreadable` : ""}.`);
  for (const life of result.lives ?? []) {
    lines.push(`  ${life.waifuId}: ${life.queued ? "scrub queued" : `${life.removedLines} log line(s), ${life.removedSentences} sentence(s)${life.removedNotes !== undefined ? `, ${life.removedNotes} note(s)` : ""} removed`}${life.needsReview.length ? `; ${life.needsReview.length} line(s) to review` : ""}`);
  }
  if (result.livesQueued?.length) lines.push(`  life scrubs queued (they run when each life next starts): ${result.livesQueued.join(", ")}`);
  for (const pending of result.pending ?? []) {
    lines.push(`  not finished: ${pending.part}${pending.error ? ` (${pending.error})` : ""}; ${pending.retried ? "it runs again at the next start" : "given up after three tries"}`);
  }
  return lines;
}

/** `waifus forget USER_ID [--yes] [--dry-run]`: confirms on a terminal; refuses without one unless --yes. */
export async function forgetCommand(ctx: CliContext, args: readonly string[], o: { yes?: boolean; dryRun?: boolean }): Promise<ExitCode> {
  const userId = args[0];
  if (!userId || args.length > 1) throw usageError("waifus forget takes one Discord user id.");
  if (!SNOWFLAKE.test(userId)) throw usageError(`${userId} is not a Discord user id (a 17–20 digit number).`);
  const host = await requireHost(ctx);
  if (!o.dryRun && !o.yes) {
    if (!ctx.ask) throw usageError("Forget deletes data and needs confirmation: run it on a terminal, or pass --yes.");
    ctx.err(FORGET_LIMITS_TEXT);
    const answer = (await ctx.ask(`Forget ${userId} everywhere on this host? Type "forget" to confirm: `)).trim().toLowerCase();
    if (answer !== "forget") {
      ctx.err("Nothing was changed.");
      return EXIT.usage;
    }
  }
  const { status, body } = await call<ForgetResult>(host, { method: "POST", path: `/api/people/${userId}/forget`, body: { confirm: true, ...(o.dryRun ? { dryRun: true } : {}) }, timeoutMs: 120_000 }, `Forgetting ${userId}`);
  if (ctx.json) ctx.out(JSON.stringify({ ok: true, status, ...body, limits: FORGET_LIMITS_TEXT }, null, 2));
  else {
    for (const line of forgetSummary(body)) ctx.out(line);
    if (o.yes || o.dryRun) ctx.out(FORGET_LIMITS_TEXT);
  }
  return EXIT.ok;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/** `waifus usage`: the usage ledger by local day (or another grouping); reads the files directly. */
export async function usageCommand(
  ctx: CliContext,
  o: { from?: string; to?: string; by?: string; waifu?: string; tz?: string },
  now: () => Date = () => new Date()
): Promise<ExitCode> {
  for (const [flag, value] of [["--from", o.from], ["--to", o.to]] as const) {
    if (value !== undefined && !DAY.test(value)) throw usageError(`${flag} is a day: YYYY-MM-DD.`);
  }
  if (o.waifu !== undefined && (!SAFE_ID.test(o.waifu) || /^\.+$/u.test(o.waifu))) throw usageError(`Invalid waifu id: ${o.waifu}.`);
  let report: UsageReport;
  try {
    const zone = assertTimeZone(o.tz ?? hostTimeZone());
    const to = o.to ?? localDayKey(now(), zone);
    report = await usageReport(ctx.dataRoot, {
      from: o.from ?? shiftDay(to, -6),
      to,
      timeZone: zone,
      groupBy: parseGroupBy(o.by),
      ...(o.waifu ? { waifuId: o.waifu } : {})
    });
  } catch (error) {
    if (error instanceof UsageQueryError) throw new CliFailure(EXIT.usage, error.message);
    throw error;
  }
  if (ctx.json) {
    ctx.out(JSON.stringify({ ok: true, ...report }, null, 2));
    return EXIT.ok;
  }
  ctx.out(`Usage ${report.from} … ${report.to} (${report.timeZone}), by ${report.groupBy.join(", ")}`);
  const rows = report.groups.map((group) => ({
    key: group.label ?? group.key.join(" · "),
    calls: String(group.calls),
    cost: `$${group.costUsd.toFixed(4)}${group.unpricedCalls ? "*" : ""}`,
    tokens: `${group.inputTokens + group.cacheReadTokens + group.cacheWriteTokens} in / ${group.outputTokens} out`
  }));
  rows.push({ key: "total", calls: String(report.totals.calls), cost: `$${report.totals.costUsd.toFixed(4)}${report.totals.unpricedCalls ? "*" : ""}`, tokens: `${report.totals.inputTokens + report.totals.cacheReadTokens + report.totals.cacheWriteTokens} in / ${report.totals.outputTokens} out` });
  const width = Math.max(5, ...rows.map((row) => row.key.length));
  for (const row of rows) ctx.out(`  ${row.key.padEnd(width)}  ${row.calls.padStart(6)} calls  ${row.cost.padStart(11)}  ${row.tokens}`);
  if (report.totals.unpricedCalls) ctx.out("  * some calls have no known price");
  if (report.totals.failedCalls) ctx.out(`  ${report.totals.failedCalls} failed or aborted call(s) included`);
  if (report.skippedLines) ctx.out(`  ${report.skippedLines} unreadable ledger line(s) skipped`);
  return EXIT.ok;
}
