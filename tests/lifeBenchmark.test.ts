// The life benchmark (spec §33, scripts/life-benchmark/): a dry run end to end on the tiny scenario
// with the scripted fake model, the probes, the metrics, prompt variants, the report, merge-grades
// and re-summarising, and the CLI refusing to spend without --yes. No network: the suite's fetch is
// loopback only, and the dry run is checked to have tried nothing else.

import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBlockA } from "../src/life/lifeHarness.js";
import { WaifuConfigSchema } from "../src/shared/schemas/domain.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { mergeGradesInto, readSummary, resummariseInto, runBenchmark, selectModels } from "../scripts/life-benchmark/bench.js";
import { GradeSchema, gateOf, renderChat } from "../scripts/life-benchmark/grading.js";
import { computeMetrics, factsFound, longestBurst, mentions } from "../scripts/life-benchmark/metrics.js";
import { evaluateProbes } from "../scripts/life-benchmark/probes.js";
import { defineScenario, scenarioClock, scenarioTimeMs, type ScenarioInput } from "../scripts/life-benchmark/scenario.js";
import { SCENARIOS } from "../scripts/life-benchmark/scenarios/index.js";
import tiny from "../scripts/life-benchmark/scenarios/tiny.js";
import type { TranscriptEvent } from "../scripts/life-benchmark/types.js";
import { BASELINE, BUILT_IN_VARIANTS, applyVariant, withVariant } from "../scripts/life-benchmark/variants.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const attempted: string[] = [];
let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    attempted.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return realFetch(input, init);
  }) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  attempted.length = 0;
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const HAIKU = { providerId: "anthropic", modelId: "claude-haiku-5-5" };
const GATE = { minFirstTry: 0.8, minProbes: 0.6 };

async function tempDir(): Promise<string> {
  const root = await makeTempRoot("life-bench-test-");
  roots.push(root);
  return root;
}

describe("scenarios", () => {
  it("every shipped scenario is valid, spans several days and has probes and must-keep facts", () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.probes.length, scenario.id).toBeGreaterThan(0);
      expect(scenario.facts.length, scenario.id).toBeGreaterThan(0);
      if (scenario.id !== "tiny") expect(scenarioTimeMs(scenario, scenario.end) - scenarioTimeMs(scenario, `d1 ${scenario.start.time}`), scenario.id).toBeGreaterThan(2 * 86_400_000);
    }
  });

  it("refuses broken references and times out of order", () => {
    const base: ScenarioInput = {
      id: "broken",
      title: "t",
      description: "d",
      start: { date: "2026-11-02", time: "09:00", timeZone: "UTC" },
      end: "d1 12:00",
      server: { id: "810000000000000009", name: "S", channels: [{ key: "general", id: "820000000000000009" }] },
      people: [{ key: "kim", id: "830000000000000009", name: "Kim" }],
      waifu: { name: "Ella", persona: "p" },
      events: [{ at: "d1 10:00", place: "#general", from: "kim", text: "hi" }]
    };
    expect(() => defineScenario({ ...base, events: [{ at: "d1 10:00", place: "#random", from: "kim", text: "hi" }] })).toThrow(/unknown place #random/u);
    expect(() => defineScenario({ ...base, events: [{ at: "d1 10:00", place: "#general", from: "bob", text: "hi" }] })).toThrow(/unknown person bob/u);
    expect(() => defineScenario({ ...base, events: [{ at: "d1 11:00", place: "#general", from: "kim", text: "a" }, { at: "d1 10:00", place: "#general", from: "kim", text: "b" }] })).toThrow(/earlier than the one before/u);
    expect(() => defineScenario({ ...base, probes: [{ id: "p", kind: "recalls", ask: "nope", mentions: ["x"] }] })).toThrow(/no event labelled nope/u);
    expect(() => defineScenario({ ...base, events: [{ at: "d1 10:00", place: "dm:kim", from: "kim", text: "hi", replyTo: "later" }] })).toThrow(/replyTo later/u);
  });

  it("scenario times are wall times in the scenario's zone, across a DST change", () => {
    const scenario = defineScenario({ ...tiny, id: "dst", start: { date: "2026-10-24", time: "09:00", timeZone: "Europe/London" }, end: "d3 09:00", events: [{ at: "d1 10:00", place: "#general", from: "kevin", text: "hi" }], facts: [], probes: [], dryRun: [] } as ScenarioInput);
    expect(new Date(scenarioTimeMs(scenario, "d1 09:00")).toISOString()).toBe("2026-10-24T08:00:00.000Z");
    expect(new Date(scenarioTimeMs(scenario, "d3 09:00")).toISOString()).toBe("2026-10-26T09:00:00.000Z");
    expect(scenarioClock(scenario, Date.parse("2026-10-26T09:00:00.000Z"))).toBe("d3 09:00");
  });
});

describe("a dry run end to end (tiny scenario, scripted fake model)", () => {
  it("plays her real life on the simulated clock and writes transcripts, summaries, packets, summary.json and the report", async () => {
    const outDir = await tempDir();
    const summary = await runBenchmark({ scenarios: [tiny], models: [HAIKU], variants: [BASELINE, BUILT_IN_VARIANTS[1]!], repeat: 1, concurrency: 2, web: false, dryRun: true, outDir, gate: GATE, tempBase: outDir });
    expect(summary.runs).toHaveLength(2);
    // Nothing but loopback was even tried: no model, Discord, Exa or member-list request.
    expect(attempted.filter((url) => !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/u.test(url))).toEqual([]);
    for (const run of summary.runs) {
      expect(run.status, run.error).toBe("done");
      expect(run.probes.map((probe) => [probe.id, probe.passed])).toEqual(tiny.probes.map((probe) => [probe.id, true]));
      expect(run.metrics).toMatchObject({ messages: 3, failedCalls: 0, firstTrySuccess: 1, retries: 0, loops: 0, longestBurst: 1, probesPassed: 9, probesScored: 9 });
      expect(run.metrics.toolCalls).toBeGreaterThanOrEqual(5);
      expect(run.metrics.turns).toBeGreaterThanOrEqual(4);
      expect(run.gate?.passed).toBe(true);
      expect(run.packets?.length).toBeGreaterThanOrEqual(1);
    }
    const dir = path.join(outDir, "runs", summary.runs[0]!.runId);
    const events = (await readFile(path.join(dir, "transcript.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as TranscriptEvent);
    const types = new Set(events.map((event) => event.type));
    for (const type of ["start", "people", "sent", "wake", "call", "tool_call", "tool_result", "notifications", "compaction", "maintenance", "checkpoint", "end"]) expect(types, type).toContain(type);
    // What reached the fake server, where; the DM stayed a DM.
    expect(events.filter((event) => event.type === "sent").map((event) => event.type === "sent" && [event.place, event.text])).toEqual([
      ["#general", "cinnamon buns all week 🥐"],
      ["#general", "football, obviously ⚽"],
      ["dm:mina", "good luck vibes for wednesday!"]
    ]);
    // Her reminder fired at its time, and the morning came with her bed time's end.
    expect(events.some((event) => event.type === "wake" && event.reason === "reminder" && event.at === "2026-11-03T09:00:00.000Z")).toBe(true);
    // Summaries are saved with their inputs: the nightly dream and the morning batch.
    const summaries = JSON.parse(await readFile(path.join(dir, "summaries.json"), "utf8")) as Array<{ kind: string; input: { text: string } }>;
    expect(summaries.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["dream", "morning"]));
    expect(summaries.find((entry) => entry.kind === "dream")!.input.text).toContain("/transcripts/dm/mina/2026-11-02.md");
    // Her home at the end: the note and the wakeups file the fake model wrote through her tools.
    const home = JSON.parse(await readFile(path.join(dir, "home.json"), "utf8")) as Record<string, string>;
    expect(home["people/mina.md"]).toContain("job interview");
    expect(Object.keys(home)).toEqual(expect.arrayContaining(["MEMORY.md", "life/places.md", "life/wakeups.json"]));
    // The variant reached block A for its run only.
    const briefA = await readFile(path.join(outDir, "runs", summary.runs[1]!.runId, "block-a.txt"), "utf8");
    const baselineA = await readFile(path.join(dir, "block-a.txt"), "utf8");
    expect(briefA).toContain("Most of your messages are a few words");
    expect(baselineA).not.toContain("Most of your messages are a few words");
    expect(baselineA).toContain("<persona>\nElla is a cheerful baker");
    // Judge packets never name the model; the index maps them back.
    const packetFiles = await readdir(path.join(outDir, "judge", "packets"));
    expect(packetFiles.length).toBeGreaterThanOrEqual(2);
    for (const file of packetFiles) expect(await readFile(path.join(outDir, "judge", "packets", file), "utf8")).not.toMatch(/haiku|anthropic|claude/iu);
    const index = JSON.parse(await readFile(path.join(outDir, "judge", "index.json"), "utf8")) as Record<string, { runId: string; kind: string }>;
    expect(Object.values(index).map((entry) => entry.runId).sort()).toEqual(summary.runs.flatMap((run) => (run.packets ?? []).map(() => run.runId)).sort());
    // The variant's chat packet asks about the same personality, with the baseline as reference.
    const variantChat = Object.entries(index).find(([, entry]) => entry.runId === summary.runs[1]!.runId && entry.kind === "chat")![0];
    const packet = JSON.parse(await readFile(path.join(outDir, "judge", "packets", `${variantChat}.json`), "utf8")) as { rubric: Record<string, string>; reference?: string; transcript: string };
    expect(Object.keys(packet.rubric)).toContain("same_personality");
    expect(packet.reference).toContain("Ella (her): cinnamon buns all week");
    expect(packet.transcript).toContain("[d1 18:06 #general] Kevin: @Ella what are you baking this week?");
    // The report and summary.json.
    const report = await readFile(path.join(outDir, "report.md"), "utf8");
    expect(report).toContain("# Life benchmark (dry run: scripted fake model)");
    expect(report).toContain("| `anthropic/claude-haiku-5-5` | baseline | 1 | 9/9 (100%)");
    expect((await readSummary(outDir)).runs).toHaveLength(2);

    // merge-grades: a grader's JSON per packet folds into summary.json and the report.
    await mkdir(path.join(outDir, "grades"), { recursive: true });
    const grades = Object.entries(index).map(([id, entry]) =>
      entry.kind === "chat"
        ? { packet: id, grader: "test", scores: { in_character: 4, natural_short: 5, relevant: 4, kind_to_room: 5, ...(id === variantChat ? { same_personality: 3 } : {}) }, flags: [] }
        : { packet: id, grader: "test", scores: { faithful: 5, complete: 3, nothing_invented: 5, keeps_voice: 2, open_threads: 4 }, invented: [] }
    );
    await writeFile(path.join(outDir, "grades", "all.json"), JSON.stringify(grades));
    await writeFile(path.join(outDir, "grades", "broken.json"), "{ not json");
    const merged = await mergeGradesInto(outDir);
    expect(merged.grades).toBe(grades.length);
    expect(merged.problems.some((problem) => problem.startsWith("broken.json"))).toBe(true);
    const after = await readSummary(outDir);
    expect(after.runs[0]!.grades?.chat).toEqual({ in_character: 4, natural_short: 5, relevant: 4, kind_to_room: 5 });
    expect(after.runs[1]!.grades?.chat?.same_personality).toBe(3);
    expect(await readFile(path.join(outDir, "report.md"), "utf8")).toMatch(/\| 4\.50 \|/u);

    // resummarise: the saved inputs replayed through another model (dry run), scored and packeted.
    const rows = await resummariseInto({ outDir, models: [{ providerId: "openai", modelId: "gpt-6-luna" }], scenarios: [tiny], dryRun: true });
    expect(rows.every((row) => row.error === undefined)).toBe(true);
    expect((await readSummary(outDir)).resummarise?.length ?? 0).toBe(rows.length);
  }, 180_000);
});

describe("probes", () => {
  const at = (time: string) => new Date(scenarioTimeMs(tiny, time)).toISOString();
  const people = (time: string, place: string, text: string, label?: string, messageId = `m-${time}`): TranscriptEvent => ({ type: "people", at: at(time), place, from: "Kevin", text, messageId, ...(label ? { label } : {}) });
  const sent = (time: string, place: string, text: string, extra: Partial<Extract<TranscriptEvent, { type: "sent" }>> = {}): TranscriptEvent => ({ type: "sent", at: at(time), place, dm: place.startsWith("dm:"), text, messageId: `s-${time}`, ...extra });
  const run = (events: TranscriptEvent[], extra: { home?: Record<string, string>; checkpoints?: Array<{ at: string; label: string; home: Record<string, string>; wakeupsDue: string[] }> } = {}) =>
    Object.fromEntries(evaluateProbes(tiny, { events, summaries: [], home: extra.home ?? {}, checkpoints: extra.checkpoints ?? [] }).map((probe) => [probe.id, probe.passed]));

  it("score outcomes: replies, silence, notes at a time, wakeups, follow-ups, recall, privacy, lines and bursts", () => {
    const good = run(
      [
        people("d1 18:06", "#general", "@Ella what are you baking", "ask"),
        sent("d1 18:07", "#general", "cinnamon buns!"),
        people("d1 18:20", "#general", "@Mina tickets?", "for_mina", "mina-q"),
        people("d1 19:00", "dm:mina", "job interview wednesday", "dm_secret"),
        { type: "wake", at: at("d2 09:00"), reason: "reminder", outcome: "queued", wakeId: "w1" },
        sent("d2 09:01", "dm:mina", "good luck!"),
        people("d2 08:30", "#general", "@Ella what do i play", "recall_ask"),
        sent("d2 08:31", "#general", "football ⚽")
      ],
      { checkpoints: [{ at: at("d1 21:00"), label: "d1 21:00", home: { "people/mina.md": "Mina has an interview" }, wakeupsDue: [] }] }
    );
    expect(good).toEqual({ answers_question: true, leaves_mina_alone: true, notes_interview: true, sets_wakeup: true, follows_up: true, recalls_football: true, keeps_dm_private: true, short_lines: true, no_spam: true });

    const bad = run(
      [
        people("d1 18:06", "#general", "@Ella what are you baking", "ask"),
        sent("d1 18:07", "#general", "hmm"),
        people("d1 18:20", "#general", "@Mina tickets?", "for_mina", "mina-q"),
        sent("d1 18:21", "#general", "ooh where are you going", { replyTo: "mina-q" }),
        sent("d1 18:22", "#general", "a".repeat(201)),
        sent("d1 18:23", "#general", "x"),
        sent("d1 18:24", "#general", "y"),
        sent("d1 18:25", "#general", "z"),
        people("d1 19:00", "dm:mina", "job interview wednesday", "dm_secret"),
        sent("d1 19:30", "#general", "mina has a job interview!!"),
        people("d2 08:55", "dm:mina", "morning"),
        sent("d2 09:01", "dm:mina", "hey"),
        people("d2 08:30", "#general", "@Ella what do i play", "recall_ask"),
        sent("d2 08:31", "#general", "no idea")
      ],
      { checkpoints: [{ at: at("d1 21:00"), label: "d1 21:00", home: { "MEMORY.md": "nothing" }, wakeupsDue: [] }] }
    );
    expect(bad).toEqual({ answers_question: false, leaves_mina_alone: false, notes_interview: false, sets_wakeup: false, follows_up: false, recalls_football: false, keeps_dm_private: false, short_lines: false, no_spam: false });
  });

  it("a recall after compaction is n/a without a summary in between, scored with one", () => {
    const scenario = defineScenario({
      ...tiny,
      id: "rac",
      probes: [{ id: "rac", kind: "recall_after_compaction", fact: "dm_secret", ask: "recall_ask", mentions: ["football"] }],
      dryRun: []
    } as ScenarioInput);
    const events: TranscriptEvent[] = [
      { type: "people", at: at("d1 19:00"), place: "dm:mina", from: "Mina", text: "x", messageId: "1", label: "dm_secret" },
      { type: "people", at: at("d2 08:30"), place: "#general", from: "Kevin", text: "?", messageId: "2", label: "recall_ask" },
      { type: "sent", at: at("d2 08:31"), place: "#general", dm: false, text: "football", messageId: "3" }
    ];
    expect(evaluateProbes(scenario, { events, summaries: [], home: {}, checkpoints: [] })[0]!.passed).toBeNull();
    const compacted: TranscriptEvent = { type: "compaction", at: at("d2 07:30"), fromEpoch: 1, toEpoch: 2, reason: "day", summarized: true };
    expect(evaluateProbes(scenario, { events: [...events.slice(0, 2), compacted, events[2]!], summaries: [], home: {}, checkpoints: [] })[0]!.passed).toBe(true);
    // A day compaction that kept every turn (no summary) is not a summary.
    expect(evaluateProbes(scenario, { events: [...events.slice(0, 2), { ...compacted, summarized: false }, events[2]!], summaries: [], home: {}, checkpoints: [] })[0]!.passed).toBeNull();
  });

  it("a scheduled wakeup is read from the snapshot at its check time", () => {
    const scenario = defineScenario({ ...tiny, id: "sched", probes: [{ id: "s", kind: "wakeup_in_window", from: "d2 08:55", to: "d2 09:10", mode: "scheduled", checkAt: "d1 21:00" }], dryRun: [] } as ScenarioInput);
    const at9 = new Date(scenarioTimeMs(scenario, "d2 09:00")).toISOString();
    const result = (due: string[]) => evaluateProbes(scenario, { events: [], summaries: [], home: {}, checkpoints: [{ at: at("d1 21:00"), label: "d1 21:00", home: {}, wakeupsDue: due }] })[0]!.passed;
    expect(result([at9])).toBe(true);
    expect(result([at("d2 11:00")])).toBe(false);
  });
});

describe("metrics", () => {
  it("count tool use generically: failures, first-try success, retries, identical failing loops", () => {
    const call = (id: string, name: string, input: unknown, turnId = "t1"): TranscriptEvent => ({ type: "tool_call", at: "2026-11-02T18:00:00.000Z", epoch: 1, turnId, id, name, input });
    const result = (id: string, isError: boolean): TranscriptEvent => ({ type: "tool_result", at: "2026-11-02T18:00:00.000Z", epoch: 1, turnId: "t1", id, isError, content: isError ? "error: x" : "ok" });
    const events: TranscriptEvent[] = [
      call("a", "Wakeup", { script: "bad" }),
      result("a", true),
      call("b", "Wakeup", { script: "bad" }),
      result("b", true),
      call("c", "Wakeup", { script: "good" }),
      result("c", false),
      call("d", "SendMessage", { x: 1 }),
      result("d", false),
      call("e", "Read", { p: 1 }, "t2"),
      result("e", false),
      { type: "people", at: "2026-11-02T18:01:00.000Z", place: "#general", from: "Kevin", text: "hi", messageId: "1" },
      { type: "sent", at: "2026-11-02T18:02:00.000Z", place: "#general", dm: false, text: "hey there\nhow are you", messageId: "2", turnId: "t1" },
      { type: "sent", at: "2026-11-02T18:02:01.000Z", place: "#general", dm: false, text: "lol", messageId: "3", turnId: "t1" },
      { type: "call", at: "2026-11-02T18:00:00.000Z", seq: 1, purpose: "life", turnId: "t1", route: "a/b", realMs: 3000 },
      { type: "call", at: "2026-11-02T18:00:00.000Z", seq: 2, purpose: "life", turnId: "t2", route: "a/b", realMs: 1000 }
    ];
    const metrics = computeMetrics({
      events,
      summaries: [],
      ledger: [{ at: "x", purpose: "life", providerId: "a", modelId: "b", status: "ok", usageKnown: true, inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, costUsd: 0.5, durationMs: 1 }],
      probes: [{ id: "p", kind: "x", passed: true, detail: "" }, { id: "q", kind: "x", passed: null, detail: "" }]
    });
    expect(metrics).toMatchObject({ toolCalls: 5, failedCalls: 2, retries: 2, loops: 1, firstTrySuccess: 2 / 3, messages: 2, longestBurst: 2, turns: 2, probesPassed: 1, probesScored: 1, usd: 0.5, tokensIn: 400, tokensOut: 10, cacheReadShare: 0.75, secondsPerTurn: 2, messagesPerSendingTurn: 2 });
    expect(metrics.toolCallsByName.Wakeup).toEqual({ calls: 3, failed: 2 });
    expect(metrics.medianLineChars).toBe(9);
    expect(metrics.longestLineChars).toBe(11);
  });

  it("match phrases by word starts and facts by any alternative", () => {
    expect(mentions("She's CLIMBING on Saturday!", "climb saturday")).toBe(true);
    expect(mentions("a goat", "oat")).toBe(false);
    expect(factsFound(tiny.facts, "mina got the train tickets")).toEqual({ kept: ["tickets"], missing: ["interview"] });
    expect(longestBurst([{ type: "sent", at: "", place: "#a", dm: false, text: "1", messageId: "1" }, { type: "sent", at: "", place: "#b", dm: false, text: "2", messageId: "2" }, { type: "sent", at: "", place: "#a", dm: false, text: "3", messageId: "3" }])).toBe(2);
  });
});

describe("prompt variants", () => {
  const waifu = WaifuConfigSchema.parse({ ...createRevisionedBase(), id: "ella", name: "Ella", displayName: "Ella", persona: "a baker", availability: { bedTime: { enabled: false, start: "23:00", end: "07:00" } } });
  const shipped = buildBlockA(waifu, { serverNicknames: [], others: [] }, "UTC");

  it("replace, remove and add paragraphs of block A, keeping the section tags", () => {
    const edited = applyVariant(shipped, {
      id: "v",
      description: "d",
      edits: [{ replace: "When people start a roleplay", with: "NEW ROLEPLAY PARAGRAPH" }, { remove: "What people tell you in private chats" }, { add: "ADDED AFTER IDENTITY", after: "Your name is Ella." }, { add: "ADDED AT THE END OF LIFE" }]
    });
    expect(edited).toContain("\n\nNEW ROLEPLAY PARAGRAPH\n\n");
    expect(edited).not.toContain("When people start a roleplay");
    expect(edited).not.toContain("What people tell you in private chats");
    expect(edited).toContain("ADDED AT THE END OF LIFE\n</life>");
    expect(edited).toContain("<identity>\nYour name is Ella.\n\nADDED AFTER IDENTITY\n</identity>");
    expect(edited.startsWith("<life>\n")).toBe(true);
  });

  it("an edit matching no paragraph or several is an error before any run", () => {
    expect(() => applyVariant(shipped, { id: "v", description: "d", edits: [{ replace: "no such paragraph here", with: "x" }] })).toThrow(/no paragraph/u);
    expect(() => applyVariant(shipped, { id: "v", description: "d", edits: [{ remove: "you" }] })).toThrow(/paragraphs of block A contain/u);
  });

  it("apply to block A only inside the run that carries them", async () => {
    const variant = BUILT_IN_VARIANTS.find((entry) => entry.id === "brief")!;
    const inside = await withVariant(variant, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return buildBlockA(waifu, { serverNicknames: [], others: [] }, "UTC");
    });
    expect(inside).toContain("Most of your messages are a few words");
    expect(buildBlockA(waifu, { serverNicknames: [], others: [] }, "UTC")).toBe(shipped);
  });
});

describe("grading", () => {
  it("the grader schema, the gate and the anonymised chat", () => {
    expect(GradeSchema.safeParse({ packet: "abc123", scores: { in_character: 6 } }).success).toBe(false);
    expect(GradeSchema.parse({ packet: "abc123", scores: { in_character: 4 } })).toMatchObject({ invented: [], flags: [] });
    const summary = { status: "done", metrics: { firstTrySuccess: 0.5, probesPassed: 9, probesScored: 9, messages: 3 } } as never;
    expect(gateOf(summary, GATE)).toMatchObject({ passed: false });
    expect(renderChat(tiny, [{ type: "sent", at: new Date(scenarioTimeMs(tiny, "d1 19:05")).toISOString(), place: "dm:mina", dm: true, text: "hi", messageId: "1" }])).toBe("[d1 19:05 DM with Mina] Ella (her): hi");
  });

  it("model selection: one route per family, contributor routes only when named, efforts checked", () => {
    const families = selectModels("families", { dryRun: true }).map((model) => `${model.providerId}/${model.modelId}`);
    expect(families).toContain("anthropic/claude-haiku-5-5");
    expect(families.some((id) => id.includes("contributor"))).toBe(false);
    expect(selectModels("families", { dryRun: false, credentials: (id) => (id === "openrouter" ? "k" : undefined) }).every((model) => model.providerId === "openrouter")).toBe(true);
    expect(() => selectModels("anthropic/claude-haiku-5-5#bogus", { dryRun: true })).toThrow(/effort bogus/u);
    expect(() => selectModels("nope/model", { dryRun: true })).toThrow(/not a curated route/u);
  });
});

describe("the CLI", () => {
  it("prints the estimate and refuses to spend without --yes (no model call, no results folder)", async () => {
    const dataRoot = await tempDir();
    await mkdir(path.join(dataRoot, "user"), { recursive: true });
    // A made-up key: without --yes nothing reads it beyond "is there one".
    await writeFile(path.join(dataRoot, "user", "providers.json"), JSON.stringify({ revision: 1, providers: { anthropic: { providerId: "anthropic", apiKey: "sk-not-real", createdAt: "2026-10-29T00:00:00.000Z", updatedAt: "2026-10-29T00:00:00.000Z" } } }));
    const outDir = path.join(dataRoot, "out");
    const repo = path.resolve(import.meta.dirname, "..");
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", path.join(repo, "scripts", "benchmark-life.ts"), "--scenarios=tiny", "--models=anthropic/claude-haiku-5-5", `--data-root=${dataRoot}`, `--out=${outDir}`], { cwd: repo, env: { ...process.env, DC_WAIFUS_HOME: dataRoot } });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stdout }));
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("Estimate (rough");
    expect(result.stdout).toContain("Add --yes");
    expect(result.stdout).not.toContain("sk-not-real");
    await expect(readdir(outDir)).rejects.toThrow();
  }, 60_000);
});
