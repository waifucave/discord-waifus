// The Living cast dashboard (§14.3): the Life timeline is generic over tool names and never shows
// what the server left out (D14); Home's notices and today's cost; the Cast editor sends only what
// changed; registry-driven settings forms; Activity's metadata-only calls; the forget limits text.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ForgetPersonPanel, forgetSummary } from "../src/frontend/components/ForgetPersonPanel.js";
import { TurnCell } from "../src/frontend/screens/LifeScreen.js";
import { blockRow, castEvents, groupByTurn, PRIVATE_HIDDEN, stateLabel } from "../src/frontend/screens/lifeView.js";
import { waifuPatch, waifuProblems } from "../src/frontend/screens/castEdit.js";
import { formChanges, nestedPatch, parseField } from "../src/frontend/screens/settingsForm.js";
import { homeNotices, todaysCost } from "../src/frontend/screens/HomeScreen.js";
import { entrySummary } from "../src/frontend/screens/ActivityScreen.js";
import type { HelpKey, LifeLogLineView, LifeStatus, WaifuConfig } from "../src/frontend/api/types.js";
import { FORGET_LIMITS } from "../src/shared/constants/forget.js";
import { WaifuConfigSchema } from "../src/shared/schemas/domain.js";
import { CURRENT_SCHEMA_VERSION } from "../src/shared/schemas/common.js";

const AT = "2026-10-24T14:00:00.000Z";

describe("Life timeline", () => {
  it("shows any tool's own name and arguments, and only a placeholder for hidden private content", () => {
    expect(blockRow({ type: "tool_use", id: "c1", name: "SendMessage", input: { place: "g/#general", text: "hi" } })).toEqual({ tone: "call", label: "SendMessage", text: '{"place":"g/#general","text":"hi"}' });
    expect(blockRow({ type: "tool_use", id: "c2", name: "some_future_tool", input: { a: 1 } }).label).toBe("some_future_tool");
    expect(blockRow({ type: "tool_result", toolUseId: "c1", text: "sent #a1" })).toMatchObject({ tone: "result", text: "sent #a1" });
    expect(blockRow({ type: "tool_result", toolUseId: "c1", isError: true, text: "nope" }).tone).toBe("error");
    expect(blockRow({ type: "tool_use", id: "c3", name: "SendMessage", redacted: true })).toEqual({ tone: "muted", label: "SendMessage", text: PRIVATE_HIDDEN });
    expect(blockRow({ type: "text", redacted: true }).text).toBe(PRIVATE_HIDDEN);
    expect(blockRow({ type: "reasoning" })).toMatchObject({ tone: "muted", label: "thinking" });
  });

  it("groups lines by turn and renders a turn without leaking anything the server hid", () => {
    const lines: LifeLogLineView[] = [
      { seq: 0, at: AT, kind: "notifications", turnId: "t1", role: "user", dm: true, blocks: [{ type: "text", text: "- dm · [private chat redacted]" }] },
      { seq: 1, at: AT, kind: "assistant", turnId: "t1", role: "assistant", dm: true, blocks: [{ type: "text", redacted: true }, { type: "tool_use", id: "c1", name: "ReadMessages", redacted: true }] },
      { seq: 2, at: AT, kind: "assistant", turnId: "t2", role: "assistant", dm: false, blocks: [{ type: "tool_use", id: "c2", name: "WebFetch", input: { url: "https://example.com" } }] }
    ];
    const groups = groupByTurn(lines);
    expect(groups.map((group) => group.lines.length)).toEqual([2, 1]);
    const html = renderToStaticMarkup(createElement(TurnCell, { lines: groups[0]!.lines }));
    expect(html).toContain("private chat");
    expect(html).toContain(PRIVATE_HIDDEN);
    expect(html).toContain("ReadMessages");
    expect(renderToStaticMarkup(createElement(TurnCell, { lines: groups[1]!.lines }))).toContain("→ WebFetch");
  });

  it("names her state from her status", () => {
    const base = { enabled: true, model: { providerId: "anthropic", modelId: "claude-haiku-5-5" }, runtime: { running: true, busy: false, paused: false }, status: "idle" as const };
    expect(stateLabel({ ...base, availability: { state: "awake" } }).word).toBe("Awake");
    expect(stateLabel({ ...base, availability: { state: "asleep", until: "07:00" } })).toMatchObject({ word: "Asleep", detail: "until 07:00" });
    expect(stateLabel({ ...base, status: "turn", availability: { state: "awake" } }).word).toBe("Mid-turn");
    expect(stateLabel({ ...base, model: null, availability: { state: "awake" } }).word).toBe("No model");
  });

  it("recent sends and wakes come from the host log and never name a DM's person", () => {
    const events = castEvents({
      entries: [
        { time: AT, level: "info", message: "Life message sent", context: { category: "life", waifuId: "aria", placeKey: "dm_300000000000000003_aria", messageId: "1" } },
        { time: AT, level: "info", message: "Life message sent", context: { category: "life", waifuId: "aria", placeKey: "g_1_2", messageId: "2" } },
        { time: AT, level: "info", message: "Life turn started", context: { category: "life", waifuId: "mina", turnId: "t", wakes: 2, reasons: ["mention", "dm"] } },
        { time: AT, level: "info", message: "Something else", context: { category: "life", waifuId: "mina" } }
      ]
    });
    expect(events.map((event) => event.text)).toEqual(["sent a message in a DM", "sent a message in g_1_2", "woke (mention, dm)"]);
    expect(JSON.stringify(events)).not.toContain("300000000000000003");
  });
});

describe("Home", () => {
  it("lists owner notices, unfinished upgrades and forgets, queued scrubs and model notices", () => {
    const notices = homeNotices(
      { models: { warnings: [{ scope: "waifu:aria", label: "Aria", code: "model_unmapped", detail: "pick again", dismissible: true }] } } as never,
      {
        notices: ["aria is linked to a Discord bot that has no token"],
        forgetJobs: [{ userId: "300000000000000003", at: AT, pending: [{ part: "archive", failures: 1, retried: true }] }],
        incompleteMigrations: [{ step: "x-v1", detail: "1 file could not be parsed", at: AT }],
        corruptForgetCopies: 1,
        pendingScrubs: [{ waifuId: "aria", count: 2 }],
        intake: { paused: false, pausedAt: null, marks: 0 },
        waifusWithoutBot: [{ waifuId: "aria", reason: "bot_no_token" }]
      },
      new Map([["aria", "Aria"]])
    );
    expect(notices.map((notice) => notice.chip)).toEqual(["notice", "migration", "forget", "forget", "scrub queued", "model_unmapped"]);
    expect(notices.at(-1)?.dismiss).toBeTypeOf("function");
  });

  it("today's cost is the report's last (host-local) day", () => {
    const today = todaysCost({
      from: "2026-10-18",
      to: "2026-10-24",
      timeZone: "UTC",
      groupBy: ["day", "waifu"],
      totals: {} as never,
      skippedLines: 0,
      groups: [
        { key: ["2026-10-23", "aria"], costUsd: 5 } as never,
        { key: ["2026-10-24", "aria"], costUsd: 0.25 } as never,
        { key: ["2026-10-24", "mina"], costUsd: 0.5 } as never
      ]
    });
    expect(today.total).toBe(0.75);
    expect(today.byWaifu.get("aria")).toBe(0.25);
  });
});

describe("Cast editor", () => {
  const stored = WaifuConfigSchema.parse({ schemaVersion: CURRENT_SCHEMA_VERSION, revision: 4, updatedAt: AT, id: "aria", name: "Aria", displayName: "Aria", model: { providerId: "anthropic", modelId: "claude-haiku-5-5" } }) as WaifuConfig;

  it("sends only the keys that changed, with her revision; unsetting the model sends null", () => {
    expect(waifuPatch(stored, { ...stored })).toEqual({ revision: 4 });
    expect(waifuPatch(stored, { ...stored, wakeOnName: false, life: { dailyBudgetUsd: 3 } })).toEqual({ revision: 4, wakeOnName: false, life: { dailyBudgetUsd: 3 } });
    expect(waifuPatch(stored, { ...stored, model: undefined })).toEqual({ revision: 4, model: null });
    const dm = { ...stored.dm, sleepNotice: "zzz, back in the morning" };
    expect(waifuPatch(stored, { ...stored, dm })).toEqual({ revision: 4, dm });
  });

  it("explains schedule, budget and DM problems before saving", () => {
    expect(waifuProblems(stored)).toEqual([]);
    expect(waifuProblems({ ...stored, availability: { sleep: { enabled: true, start: "23:00", end: "23:00" }, busy: [{ start: "09:00", end: "10:00", reason: " " }] } })).toHaveLength(2);
    expect(waifuProblems({ ...stored, life: { dailyBudgetUsd: 0 } })).toHaveLength(1);
    expect(waifuProblems({ ...stored, dm: { ...stored.dm, rateLimit: { maxReplies: 0, windowMinutes: 60 } } })).toHaveLength(1);
  });
});

describe("registry-driven settings forms", () => {
  const key = (over: Partial<HelpKey>): HelpKey => ({ id: "app.life.maxSendsPerTurn", group: "app", path: "life.maxSendsPerTurn", type: "integer", typeLabel: "integer 1–50", min: 1, max: 50, nullable: false, help: "Messages per turn.", flags: [], applies: "live", cli: [], ...over });

  it("parses each type against its bounds", () => {
    expect(parseField(key({}), "6")).toEqual({ ok: true, value: 6 });
    expect(parseField(key({}), "60")).toMatchObject({ ok: false });
    expect(parseField(key({}), "1.5")).toMatchObject({ ok: false });
    expect(parseField(key({ type: "enum", enum: ["auto", "apple-vision"] }), "auto")).toEqual({ ok: true, value: "auto" });
    expect(parseField(key({ type: "string-list" }), "a/b\nc/d, e/f")).toEqual({ ok: true, value: ["a/b", "c/d", "e/f"] });
    expect(parseField(key({ type: "string", nullable: true }), "")).toEqual({ ok: true, value: null });
    expect(parseField(key({ type: "string", nullable: false }), "")).toEqual({ ok: true, value: "" });
  });

  it("only changed keys become a nested patch", () => {
    const keys = [key({}), key({ path: "life.maxToolRounds", id: "app.life.maxToolRounds", max: 30 })];
    const config = { life: { maxSendsPerTurn: 8, maxToolRounds: 12 } };
    const { changes, errors } = formChanges(keys, config, { "life.maxSendsPerTurn": "8", "life.maxToolRounds": "14" });
    expect(errors).toEqual({});
    expect(nestedPatch(changes)).toEqual({ life: { maxToolRounds: 14 } });
  });
});

describe("Activity", () => {
  it("labels a life call as metadata only and shows its counts, never content", () => {
    const summary = entrySummary({ role: "life", modelId: "claude-haiku-5-5", metadataOnly: true, payload: { messageCount: 12, toolCount: 9 } });
    expect(summary).toEqual({ title: "life · claude-haiku-5-5", metadataOnly: true, line: "12 messages · 9 tools" });
    expect(entrySummary({ role: "assistant", content: "hello" }).line).toBe("hello");
  });
});

describe("forget person", () => {
  it("states every limit of the scrub, including DM images, before anything runs", () => {
    const html = renderToStaticMarkup(createElement(ForgetPersonPanel));
    for (const line of FORGET_LIMITS) expect(html).toContain(line.replace(/'/gu, "&#x27;"));
    expect(html).toContain("DM image");
  });

  it("summarises the full §7.5 result", () => {
    const lines = forgetSummary({
      discordUserId: "300000000000000003",
      dryRun: false,
      dmContexts: 1,
      dmStates: 1,
      dmLimits: 1,
      cachedImages: 2,
      memberLists: 3,
      archive: { files: 4, removed: 1, unreadable: 0, skipped: 0 },
      lives: [{ waifuId: "aria", removedLines: 2, removedSentences: 1, removedNotes: 1, needsReview: [{ where: "notes/x.md", line: "Kevin" }] }],
      pending: [{ part: "archive", failures: 3, retried: false }]
    });
    expect(lines.join("\n")).toContain("3 member-list entries");
    expect(lines.join("\n")).toContain("aria: 2 log line(s)");
    expect(lines.join("\n")).toContain("given up after three tries");
  });
});

// Keep the LifeStatus import used (types only).
export type _LifeStatus = LifeStatus;
