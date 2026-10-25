// The Living cast dashboard (§14.3): the Life timeline is generic over tool names and never shows
// what the server left out (D14); Home's notices and today's cost; the Cast editor sends only what
// changed; registry-driven settings forms; Activity's metadata-only calls; the forget limits text.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ForgetPersonPanel, forgetSummary } from "../src/frontend/components/ForgetPersonPanel.js";
import { TurnCell } from "../src/frontend/screens/LifeScreen.js";
import { blockRow, breadcrumbs, castEvents, fileSize, groupByTurn, matchingReveal, mergeTimeline, PRIVATE_HIDDEN, settledAll, stateLabel, watchWhenText } from "../src/frontend/screens/lifeView.js";
import { FileRow, ReminderList, WatchList } from "../src/frontend/screens/LifeFiles.js";
import { PRIVATE_FILE_NAME } from "../src/shared/constants/files.js";
import { ConfirmDialog } from "../src/frontend/components/ConfirmDialog.js";
import { detectorChoiceOf, detectorPatch } from "../src/frontend/screens/RoomsScreen.js";
import { waifuPatch, waifuProblems } from "../src/frontend/screens/castEdit.js";
import { formChanges, formText, nestedPatch, parseField } from "../src/frontend/screens/settingsForm.js";
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
    const base = { enabled: true, hasBot: true, model: { providerId: "anthropic", modelId: "claude-haiku-5-5" }, runtime: { running: true, busy: false, paused: false }, status: "idle" as const };
    expect(stateLabel({ ...base, availability: { state: "awake" } }).word).toBe("Awake");
    expect(stateLabel({ ...base, availability: { state: "asleep", until: "07:00" } })).toMatchObject({ word: "Asleep", detail: "until 07:00" });
    expect(stateLabel({ ...base, status: "turn", availability: { state: "awake" } }).word).toBe("Mid-turn");
    expect(stateLabel({ ...base, model: null, availability: { state: "awake" } }).word).toBe("No model");
    expect(stateLabel({ ...base, hasBot: false, availability: { state: "awake" } }).word).toBe("No bot");
  });

  it("recent sends and wakes come from the host log and never name a DM's person", () => {
    const events = castEvents({
      entries: [
        { time: AT, level: "info", message: "Life message sent", context: { category: "life", waifuId: "ella", placeKey: "dm_300000000000000003_ella", messageId: "1" } },
        { time: AT, level: "info", message: "Life message sent", context: { category: "life", waifuId: "ella", placeKey: "g_1_2", place: "bake-club/#general", messageId: "2" } },
        { time: AT, level: "info", message: "Life reaction added", context: { category: "life", waifuId: "ella", placeKey: "g_1_3", messageId: "3" } },
        { time: AT, level: "info", message: "Life turn started", context: { category: "life", waifuId: "mina", turnId: "t", wakes: 2, reasons: ["mention", "dm"] } },
        { time: AT, level: "info", message: "Something else", context: { category: "life", waifuId: "mina" } }
      ]
    });
    // A room by her handle; an older line without one never shows a raw key (review: Home feed).
    expect(events.map((event) => event.text)).toEqual(["sent a message in a DM", "sent a message in bake-club/#general", "reacted in a channel", "woke (mention, dm)"]);
    expect(JSON.stringify(events)).not.toContain("300000000000000003");
  });
});

describe("Home", () => {
  it("lists owner notices, unfinished upgrades and forgets, queued scrubs and model notices", () => {
    const notices = homeNotices(
      { models: { warnings: [{ scope: "waifu:ella", label: "Ella", code: "model_unmapped", detail: "pick again", dismissible: true }] } } as never,
      {
        notices: ["ella is linked to a Discord bot that has no token"],
        forgetJobs: [{ userId: "300000000000000003", at: AT, pending: [{ part: "archive", failures: 1, retried: true }] }],
        incompleteMigrations: [{ step: "x-v1", detail: "1 file could not be parsed", at: AT }],
        corruptForgetCopies: 1,
        pendingScrubs: [{ waifuId: "ella", count: 2 }],
        intake: { paused: false, pausedAt: null, marks: 0 },
        waifusWithoutBot: [{ waifuId: "ella", reason: "bot_no_token" }]
      },
      new Map([["ella", "Ella"]])
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
        { key: ["2026-10-23", "ella"], costUsd: 5 } as never,
        { key: ["2026-10-24", "ella"], costUsd: 0.25 } as never,
        { key: ["2026-10-24", "mina"], costUsd: 0.5 } as never
      ]
    });
    expect(today.total).toBe(0.75);
    expect(today.byWaifu.get("ella")).toBe(0.25);
  });
});

describe("Cast editor", () => {
  const stored = WaifuConfigSchema.parse({ schemaVersion: CURRENT_SCHEMA_VERSION, revision: 4, updatedAt: AT, id: "ella", name: "Ella", displayName: "Ella", model: { providerId: "anthropic", modelId: "claude-haiku-5-5" } }) as WaifuConfig;

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
    // frontend.staticDir: unset clears it with null, so an emptied field clears it (review).
    expect(parseField(key({ type: "string", nullable: false, flags: ["nullUnset"] }), "")).toEqual({ ok: true, value: null });
    expect(parseField(key({ type: "number", min: 0, minExclusive: true }), "0")).toMatchObject({ ok: false, error: "More than 0." });
  });

  it("only changed keys become a nested patch", () => {
    const keys = [key({}), key({ path: "life.maxSendPlacesPerTurn", id: "app.life.maxSendPlacesPerTurn", max: 10 })];
    const config = { life: { maxSendsPerTurn: 8, maxSendPlacesPerTurn: 3 } };
    const { changes, errors } = formChanges(keys, config, { "life.maxSendsPerTurn": "8", "life.maxSendPlacesPerTurn": "5" });
    expect(errors).toEqual({});
    expect(nestedPatch(changes)).toEqual({ life: { maxSendPlacesPerTurn: 5 } });
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
      lives: [{ waifuId: "ella", removedLines: 2, removedSentences: 1, removedNotes: 1, needsReview: [{ where: "notes/x.md", line: "Kevin" }] }],
      pending: [{ part: "archive", failures: 3, retried: false }]
    });
    expect(lines.join("\n")).toContain("3 member-list entries");
    expect(lines.join("\n")).toContain("ella: 2 log line(s)");
    expect(lines.join("\n")).toContain("given up after three tries");
  });
});

// Keep the LifeStatus import used (types only).
export type _LifeStatus = LifeStatus;

describe("review: dashboard fixes", () => {
  const line = (seq: number): LifeLogLineView => ({ seq, at: AT, kind: "assistant", blocks: [{ type: "text", text: `line ${seq}` }], dm: false });

  it("shows a response only while it answers the reveal toggle as it is now", () => {
    const revealed = { includePrivate: true, summary: "secret" };
    expect(matchingReveal(revealed, true)).toBe(revealed);
    // Un-revealing: the private page is never shown again, also when the refetch fails.
    expect(matchingReveal(revealed, false)).toBeUndefined();
    expect(matchingReveal(undefined, false)).toBeUndefined();
  });

  it("merges older pages with the live page by seq; a live page that no longer reaches them is a gap", () => {
    const older = [line(0), line(1), line(2)];
    expect(mergeTimeline(older, [line(2), line(3)])).toEqual({ lines: [line(0), line(1), line(2), line(3)], gap: false });
    expect(mergeTimeline(older, [line(3), line(4)]).gap).toBe(false);
    expect(mergeTimeline(older, [line(9), line(10)])).toEqual({ lines: [line(9), line(10)], gap: true });
    expect(mergeTimeline([], [line(5)]).lines).toEqual([line(5)]);
  });

  it("one failing life never blanks the others", async () => {
    await expect(settledAll([Promise.resolve(1), Promise.reject(new Error("x")), Promise.resolve(3)])).resolves.toEqual([1, 3]);
  });

  it("a refresh that fails keeps the last answer, and one where every life fails keeps the whole cast", async () => {
    // A brief Remote Access reconnect fails every request at once: that used to answer an empty
    // list, and Home's "Who is up" lost the whole cast until the next poll.
    await expect(settledAll([Promise.resolve(1), Promise.reject(new Error("x")), Promise.resolve(3)], [10, 20, 30])).resolves.toEqual([1, 20, 3]);
    const offline = new Error("NetworkError");
    await expect(settledAll([Promise.reject(offline), Promise.reject(new Error("y"))], [10, 20])).rejects.toBe(offline);
    await expect(settledAll([Promise.reject(offline)])).rejects.toBe(offline);
    await expect(settledAll([])).resolves.toEqual([]);
  });

  it("a cleared custom detector target stays custom (never Off) and cannot be saved empty", () => {
    expect(detectorChoiceOf(undefined)).toEqual({ mode: "inherit", target: "" });
    expect(detectorChoiceOf("")).toEqual({ mode: "off", target: "" });
    expect(detectorChoiceOf("laya:english")).toEqual({ mode: "custom", target: "laya:english" });
    expect(detectorPatch({ mode: "custom", target: "  " })).toBeUndefined();
    expect(detectorPatch({ mode: "custom", target: " laya:english " })).toEqual({ detector: { target: "laya:english" } });
    expect(detectorPatch({ mode: "off", target: "" })).toEqual({ detector: { target: "" } });
    expect(detectorPatch({ mode: "inherit", target: "" })).toEqual({ detector: null });
  });

  it("a secret is write-only in the forms: never shown, sent only when typed", () => {
    const secret: HelpKey = { id: "provider.apiKey", group: "provider", path: "apiKey", type: "string", typeLabel: "string", nullable: false, help: "Key.", flags: ["secret"], applies: "live", cli: [] };
    expect(formText(secret, "sk-stored")).toBe("");
    expect(formChanges([secret], { apiKey: "sk-stored" }, { apiKey: "" }).changes).toEqual({});
    expect(formChanges([secret], { apiKey: "sk-stored" }, { apiKey: "sk-new" }).changes).toEqual({ apiKey: "sk-new" });
  });

  it("confirmation dialogs are dialogs with a title and the safe choice first", () => {
    const html = renderToStaticMarkup(createElement(ConfirmDialog, { title: "Reset Ella's life?", cancelLabel: "Keep", confirmLabel: "Reset", onCancel: () => undefined, onConfirm: () => undefined, children: "text" }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/aria-labelledby="([^"]+)"[\s\S]*id="\1"/u);
    expect(html.indexOf("Keep")).toBeLessThan(html.indexOf("Reset<"));
    // The forget panel's id field has a label.
    expect(renderToStaticMarkup(createElement(ForgetPersonPanel))).toMatch(/<label[^>]*for="([^"]+)"[\s\S]*<input[^>]*id="\1"/u);
  });
});

describe("her files, reminders and watches (§16.11)", () => {
  it("a DM file the server left unnamed stays unnamed and cannot be opened", () => {
    const hidden = renderToStaticMarkup(createElement(FileRow, { entry: { name: PRIVATE_FILE_NAME, kind: "file", size: 30, modified: AT, private: true, redacted: true }, onOpen: () => undefined }));
    expect(hidden).toContain(PRIVATE_FILE_NAME);
    expect(hidden).toContain("private chat");
    expect(hidden).not.toContain("<button");
    const plain = renderToStaticMarkup(createElement(FileRow, { entry: { name: "people", path: "/home/ella/people", kind: "dir", size: 0, modified: AT }, onOpen: () => undefined }));
    expect(plain).toContain("people/");
    expect(plain).toContain("folder");
    expect(fileSize(1234)).toBe("1.2 KB");
  });

  it("walks back from a folder to her home or /tmp", () => {
    expect(breadcrumbs({ root: "home", dir: "/home/ella/people/friends", display: "~/people/friends" })).toEqual([
      { label: "~", dir: "/home/ella" },
      { label: "people", dir: "/home/ella/people" },
      { label: "friends", dir: "/home/ella/people/friends" }
    ]);
    expect(breadcrumbs({ root: "tmp", dir: "/tmp", display: "/tmp" })).toEqual([{ label: "/tmp", dir: "/tmp" }]);
  });

  it("lists reminders and watches with delete buttons; a private watch shows only that it is private", () => {
    const reminders = renderToStaticMarkup(createElement(ReminderList, { data: { waifuId: "ella", timeZone: "UTC", entries: [{ id: "r4", at: "2026-10-25 18:00", repeat: "daily", note: "check the flyer" }] }, onDelete: () => undefined }));
    expect(reminders).toContain("check the flyer");
    expect(reminders).toContain("daily");
    expect(reminders).toContain("delete");
    const watches = {
      waifuId: "ella",
      timeZone: "UTC",
      includePrivate: false,
      entries: [
        { id: "w3", timeout: "2026-10-25 18:00", once: true, note: "tea", when: [] },
        { id: "w4", timeout: "2026-10-25 19:00", once: true, note: PRIVATE_FILE_NAME, when: [{ place: PRIVATE_FILE_NAME }], private: true as const }
      ]
    };
    const html = renderToStaticMarkup(createElement(WatchList, { data: watches, includePrivate: false, onDelete: () => undefined }));
    expect(html).toContain("timer · tea");
    expect(html).toContain(PRIVATE_HIDDEN);
    expect(html).toContain("private chat");
    expect(watchWhenText({ when: [{ place: "bake-club/#general", from: "Mina", words: ["brownie"] }] })).toBe("in bake-club/#general · from Mina · words: brownie");
  });
});

