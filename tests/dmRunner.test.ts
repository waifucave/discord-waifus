// The DM runner end to end (spec 9.1, 9.9): RuntimeOrchestrator → DmRunner → the real
// ContextRuntime with the waifu harness, over a fake DM transport and a scripted model.

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationKey } from "../src/orchestration/context/keys.js";
import { readDmLimit, readDmState, updateDmLimit } from "../src/orchestration/dm/dmStore.js";
import { recordWaifuNotes } from "../src/orchestration/stores/memories.js";
import { DM_DISCRETION_LINE } from "../src/orchestration/waifuHarness.js";
import { AgentConfigSchema, MemoryStoreSchema } from "../src/shared/schemas/domain.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { DmDiscord, ScriptedPipeline, USER, USER_2, deferred, dmRoot, dmRuntime, seedDmWorld, until } from "./dmFixtures.js";
import { removeTempRoot } from "./testUtils.js";

vi.setConfig({ testTimeout: 30_000 });

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const KEY = conversationKey({ kind: "dm", waifuId: "aria", userId: USER });

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

function systemCount(request: ScriptedPipeline["requests"][number]): number {
  return request.prompt!.messages.filter((m) => m.role === "system").length;
}

describe("DM runner", () => {
  it("allowDms off: no reply, no model call, no DM files", async () => {
    const { root, storage } = await dmRoot(roots);
    await seedDmWorld(storage, { dm: { allowDms: false } });
    const discord = new DmDiscord();
    const pipeline = new ScriptedPipeline();
    const runtime = dmRuntime(storage, discord, pipeline);
    await runtime.handleDirectMessage(discord.dm("hi"));
    await runtime.settleBackground();
    expect(discord.sent).toEqual([]);
    expect(pipeline.requests).toEqual([]);
    expect(await exists(path.join(root, "user", "dms"))).toBe(false);
    expect(await exists(path.join(root, "user", "conversations", KEY))).toBe(false);
    await runtime.stop();
  });

  it("a 3-message burst gets one reply with the waifu harness, her memories and the DM cache key", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    // Learned in a server: global memory reaches the DM (same memories as servers).
    await recordWaifuNotes(storage, {
      waifuId: "aria",
      entries: ["Kevin is allergic to peanuts"],
      origin: { guildId: "100000000000000001", channelId: "200000000000000002" },
      subjects: [{ discordUserId: USER, name: "Kevin" }]
    });
    const discord = new DmDiscord();
    const pipeline = new ScriptedPipeline();
    pipeline.replies.push({ content: "hi kevin! what's up" });
    const runtime = dmRuntime(storage, discord, pipeline, { debounce: { dmMs: 300, dmMaxWaitMs: 5000 } });
    // Three messages within the quiet period (gaps well under dmMs, even on a loaded machine).
    const burst = [discord.dm("hey"), discord.dm("you there?"), discord.dm("got a question")];
    await Promise.all(burst.map((event) => runtime.handleDirectMessage(event)));
    await until(() => discord.sent.length === 1, "the reply");
    await runtime.settleBackground();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await runtime.settleBackground();

    expect(pipeline.requests).toHaveLength(1);
    const request = pipeline.requests[0]!;
    expect(systemCount(request)).toBe(1);
    expect(request.prompt!.messages[0]!.role).toBe("system");
    expect(request.prompt!.promptCacheKey).toBe(`waifu:aria:${KEY}`);
    expect(request.modelId).toBe("gpt-5.4-mini");
    expect(request.availableWaifuIds).toEqual([]);
    expect(request.prompt!.tools.map((tool) => tool.name)).not.toContain("PickNextWaifu");
    expect(request.attribution).toMatchObject({ purpose: "waifu_reply", waifuId: "aria", conversationKey: KEY });
    expect(request.prompt!.debug.system).toContain(DM_DISCRETION_LINE);
    expect(request.prompt!.debug.header).toContain("Private chat with Kevin");
    expect(request.prompt!.debug.header).toContain("Kevin is allergic to peanuts");
    for (const text of ["hey", "you there?", "got a question"]) expect(request.prompt!.debug.transcript).toContain(text);
    expect(discord.sent[0]).toMatchObject({ userId: USER, content: "hi kevin! what's up" });

    const state = await readDmState(storage, USER, "aria");
    expect(state?.recentRuns.map((run) => run.status)).toEqual(["sent"]);
    expect(state?.pendingTriggerMessageId).toBeUndefined();
    expect(state?.lastReplyAt).toBeDefined();
    expect((await readDmLimit(storage, USER, "aria")).replyTimestamps).toHaveLength(1);
    await runtime.stop();
  });

  it("DM memories from add_memory carry origin.dm and the user as subject", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage, { toolUse: true });
    const discord = new DmDiscord();
    const pipeline = new ScriptedPipeline();
    pipeline.replies.push({ content: "noted!", shortTermMemoryEntries: ["Kevin is training for a marathon"] });
    const runtime = dmRuntime(storage, discord, pipeline);
    await runtime.handleDirectMessage(discord.dm("i'm training for a marathon"));
    await runtime.settleBackground();
    const store = await storage.readJson("user/memories.json", MemoryStoreSchema);
    expect(store.memories).toHaveLength(1);
    expect(store.memories[0]).toMatchObject({
      waifuId: "aria",
      origin: { dm: true },
      subjects: [{ discordUserId: USER, name: "Kevin" }]
    });
    expect(pipeline.requests[0]!.prompt!.tools.map((tool) => tool.name)).toEqual(["add_memory"]);
    await runtime.stop();
  });

  it("a message during generation supersedes it: the aborted run is not counted, the rerun answers", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    const discord = new DmDiscord();
    const pipeline = new ScriptedPipeline();
    const hold = deferred();
    let calls = 0;
    pipeline.gate = () => (++calls === 1 ? hold.promise : Promise.resolve());
    const runtime = dmRuntime(storage, discord, pipeline);
    const first = runtime.handleDirectMessage(discord.dm("hey"));
    await until(() => pipeline.requests.length === 1, "first generation");
    await runtime.handleDirectMessage(discord.dm("actually wait"));
    await first;
    await runtime.settleBackground();
    expect(pipeline.requests).toHaveLength(2);
    expect(discord.sent).toHaveLength(1);
    const state = await readDmState(storage, USER, "aria");
    expect(state?.recentRuns.map((run) => run.status)).toEqual(["superseded", "sent"]);
    expect((await readDmLimit(storage, USER, "aria")).replyTimestamps).toHaveLength(1);
    await runtime.stop();
  });

  it("a message during sending lets the reply finish, then reruns exactly once", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    const discord = new DmDiscord();
    const pipeline = new ScriptedPipeline();
    pipeline.replies.push({ content: "first reply" }, { content: "second reply" });
    const gate = deferred();
    discord.sendGate = gate.promise;
    const runtime = dmRuntime(storage, discord, pipeline);
    const first = runtime.handleDirectMessage(discord.dm("hey"));
    await until(() => pipeline.requests.length === 1, "generation");
    await new Promise((resolve) => setTimeout(resolve, 30)); // now waiting on the send gate
    await runtime.handleDirectMessage(discord.dm("one more thing"));
    await runtime.handleDirectMessage(discord.dm("and another"));
    discord.sendGate = undefined;
    gate.resolve();
    await first;
    await until(() => discord.sent.length === 2, "the follow-up reply");
    await runtime.settleBackground();
    expect(pipeline.requests).toHaveLength(2);
    expect(discord.sent.map((s) => s.content)).toEqual(["first reply", "second reply"]);
    const state = await readDmState(storage, USER, "aria");
    expect(state?.recentRuns.map((run) => run.status)).toEqual(["sent", "sent"]);
    expect(pipeline.requests[1]!.prompt!.debug.transcript).toContain("and another");
    await runtime.stop();
  });

  it("holds DM generations to discord.dm.maxConcurrentRuns", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    const discord = new DmDiscord();
    const pipeline = new ScriptedPipeline();
    const hold = deferred();
    let calls = 0;
    pipeline.gate = () => (++calls === 1 ? hold.promise : Promise.resolve());
    const runtime = dmRuntime(storage, discord, pipeline, { dm: { maxConcurrentRuns: 1 } });
    const a = runtime.handleDirectMessage(discord.dm("hi", USER));
    await until(() => pipeline.requests.length === 1, "first generation");
    const b = runtime.handleDirectMessage(discord.dm("hello", USER_2));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(pipeline.requests).toHaveLength(1);
    expect(runtime.dm.semaphore.inUse).toBe(1);
    hold.resolve();
    await Promise.all([a, b]);
    expect(pipeline.requests).toHaveLength(2);
    expect(discord.sent.map((s) => s.userId).sort()).toEqual([USER, USER_2].sort());
    await runtime.stop();
  });

  it("empty and blocked replies are not sent and not counted", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    const discord = new DmDiscord();
    const pipeline = new ScriptedPipeline();
    pipeline.replies.push({ content: "" });
    pipeline.replies.push({ content: "@everyone hi" }, { content: "@everyone hi" });
    const runtime = dmRuntime(storage, discord, pipeline);
    await runtime.handleDirectMessage(discord.dm("hi"));
    await runtime.handleDirectMessage(discord.dm("hello?"));
    await runtime.settleBackground();
    expect(discord.sent).toEqual([]);
    const state = await readDmState(storage, USER, "aria");
    expect(state?.recentRuns.map((run) => run.status)).toEqual(["empty", "blocked"]);
    expect((await readDmLimit(storage, USER, "aria")).replyTimestamps).toEqual([]);
    await runtime.stop();
  });

  it("Discord 50007 marks the DM undeliverable until the user writes again", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    const discord = new DmDiscord();
    const pipeline = new ScriptedPipeline();
    discord.sendErrors.push(Object.assign(new Error("Cannot send messages to this user"), { code: 50007 }));
    const runtime = dmRuntime(storage, discord, pipeline);
    await runtime.handleDirectMessage(discord.dm("hi"));
    let state = await readDmState(storage, USER, "aria");
    expect(state?.recentRuns.map((run) => run.status)).toEqual(["undeliverable"]);
    expect(state?.undeliverableSince).toBeDefined();
    expect((await readDmLimit(storage, USER, "aria")).replyTimestamps).toEqual([]);
    // A resume pass does not retry an undeliverable conversation.
    await runtime.dm.resume();
    await runtime.settleBackground();
    expect(pipeline.requests).toHaveLength(1);
    // The next inbound clears the flag and she answers.
    await runtime.handleDirectMessage(discord.dm("hello again"));
    state = await readDmState(storage, USER, "aria");
    expect(state?.undeliverableSince).toBeUndefined();
    expect(discord.sent).toHaveLength(1);
    await runtime.stop();
  });

  it("a bot shared by two enabled waifus takes no DMs and /api/runtime warns dm_bot_shared", async () => {
    const { root, storage } = await dmRoot(roots);
    await seedDmWorld(storage, { sharedBot: true });
    const discord = new DmDiscord();
    const pipeline = new ScriptedPipeline();
    const runtime = dmRuntime(storage, discord, pipeline);
    expect(await runtime.dmStatus()).toEqual({ eligibleWaifus: [], warnings: ["dm_bot_shared:aria-bot"] });
    await runtime.handleDirectMessage(discord.dm("hi"));
    expect(discord.sent).toEqual([]);
    expect(await exists(path.join(root, "user", "dms"))).toBe(false);
    await runtime.stop();
  });

  it("warns dm_missing_model for a DM waifu without a model", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage, { modelId: null });
    const runtime = dmRuntime(storage, new DmDiscord(), new ScriptedPipeline());
    expect((await runtime.dmStatus()).warnings).toEqual(["dm_missing_model:aria"]);
    await runtime.stop();
  });
});

describe("DM rate limit (acceptance 3)", () => {
  it("withholds reply 31 inside 60 minutes, sends exactly one notice, survives a restart and resumes after freesAt", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    const discord = new DmDiscord();
    const pipeline = new ScriptedPipeline();
    let runtime = dmRuntime(storage, discord, pipeline);
    for (let i = 0; i < 30; i += 1) await runtime.handleDirectMessage(discord.dm(`message ${i}`));
    expect(discord.sent).toHaveLength(30);
    expect(pipeline.requests).toHaveLength(30);

    await runtime.handleDirectMessage(discord.dm("message 31"));
    expect(pipeline.requests).toHaveLength(30); // no model call when limited
    expect(discord.sent).toHaveLength(31);
    expect(discord.sent[30]!.content).toMatch(/^I need a little break — talk to you in about \d+ minutes!$/);
    await runtime.handleDirectMessage(discord.dm("message 32"));
    expect(discord.sent).toHaveLength(31); // one notice per limited period

    // A restart does not reset the counter.
    await runtime.stop();
    runtime = dmRuntime(storage, discord, pipeline);
    await runtime.handleDirectMessage(discord.dm("message 33"));
    expect(discord.sent).toHaveLength(31);
    expect(pipeline.requests).toHaveLength(30);
    let state = await readDmState(storage, USER, "aria");
    expect(state?.recentRuns.slice(-3).map((run) => run.status)).toEqual(["notice_sent", "rate_limited", "rate_limited"]);

    // Time passes beyond freesAt: shift every stored reply back past the window.
    await updateDmLimit(storage, USER, "aria", (current) => ({
      ...current,
      replyTimestamps: current.replyTimestamps.map((ts) => new Date(Date.parse(ts) - 61 * 60_000).toISOString())
    }));
    await runtime.handleDirectMessage(discord.dm("back yet?"));
    expect(pipeline.requests).toHaveLength(31);
    expect(discord.sent).toHaveLength(32);
    state = await readDmState(storage, USER, "aria");
    expect(state?.recentRuns.at(-1)?.status).toBe("sent");
    // Her own notice is part of her transcript.
    expect(pipeline.requests[30]!.prompt!.debug.transcript).toContain("I need a little break");
    expect((await readDmLimit(storage, USER, "aria")).replyTimestamps).toHaveLength(1);
    await runtime.stop();
  });

  it("uses the per-waifu template and stays silent when notifyWhenLimited is off", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage, { dm: { rateLimit: { maxReplies: 1, windowMinutes: 60 }, limitNotice: "{name} needs {retryInMinutes} min, {user}" } });
    const discord = new DmDiscord();
    const pipeline = new ScriptedPipeline();
    const runtime = dmRuntime(storage, discord, pipeline);
    await runtime.handleDirectMessage(discord.dm("one"));
    await runtime.handleDirectMessage(discord.dm("two"));
    expect(discord.sent[1]!.content).toMatch(/^Aria needs (59|60) min, Kevin$/);
    await runtime.stop();

    const quiet = await dmRoot(roots);
    await seedDmWorld(quiet.storage, { dm: { rateLimit: { maxReplies: 1, windowMinutes: 60 }, notifyWhenLimited: false } });
    const discord2 = new DmDiscord();
    const runtime2 = dmRuntime(quiet.storage, discord2, new ScriptedPipeline());
    await runtime2.handleDirectMessage(discord2.dm("one"));
    await runtime2.handleDirectMessage(discord2.dm("two"));
    expect(discord2.sent).toHaveLength(1);
    expect((await readDmState(quiet.storage, USER, "aria"))?.recentRuns.at(-1)?.status).toBe("rate_limited");
    await runtime2.stop();
  });
});

describe("DM restart, pause and shutdown (acceptance 4)", () => {
  it("a restart mid-DM still delivers the reply after boot", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    const discord = new DmDiscord();
    const stuck = new ScriptedPipeline();
    stuck.gate = () => new Promise(() => undefined); // never finishes before the restart
    const before = dmRuntime(storage, discord, stuck);
    const pending = before.handleDirectMessage(discord.dm("are you there?"));
    await until(() => stuck.requests.length === 1, "generation");
    await before.stop();
    await pending;
    const state = await readDmState(storage, USER, "aria");
    expect(state?.pendingTriggerMessageId).toBeDefined();
    expect(state?.recentRuns.map((run) => run.status)).toEqual(["interrupted"]);
    expect(discord.sent).toEqual([]);

    const pipeline = new ScriptedPipeline();
    pipeline.replies.push({ content: "sorry, i'm here!" });
    const after = dmRuntime(storage, discord, pipeline);
    await after.start();
    await until(() => discord.sent.length === 1, "the reply after boot");
    await after.settleBackground();
    expect(discord.sent[0]!.content).toBe("sorry, i'm here!");
    expect((await readDmState(storage, USER, "aria"))?.pendingTriggerMessageId).toBeUndefined();
    await after.stop();
  });

  it("shutdown flushes a debounced DM into pending, and boot answers it", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    const discord = new DmDiscord();
    const pipeline = new ScriptedPipeline();
    const before = dmRuntime(storage, discord, pipeline, { debounce: { dmMs: 60_000, dmMaxWaitMs: 60_000 } });
    await before.handleDirectMessage(discord.dm("hi"));
    await before.stop();
    expect((await readDmState(storage, USER, "aria"))?.pendingTriggerMessageId).toBeDefined();
    expect(pipeline.requests).toEqual([]);
    const after = dmRuntime(storage, discord, pipeline);
    await after.start();
    await until(() => discord.sent.length === 1, "the reply after boot");
    await after.stop();
  });

  it("outside the resume window a pending DM is cleared, not answered", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    const discord = new DmDiscord();
    const pipeline = new ScriptedPipeline();
    const before = dmRuntime(storage, discord, pipeline, { debounce: { dmMs: 60_000, dmMaxWaitMs: 60_000 } });
    await before.handleDirectMessage(discord.dm("hi"));
    await before.stop();
    const after = dmRuntime(storage, discord, pipeline, { dm: { resumeWindowMinutes: 0 } });
    await after.dm.resume();
    await after.settleBackground();
    expect(discord.sent).toEqual([]);
    expect((await readDmState(storage, USER, "aria"))?.pendingTriggerMessageId).toBeUndefined();
    await after.stop();
  });

  it("pause: nothing is sent while paused (pending cleared); resume catches up within the window", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    const discord = new DmDiscord();
    const pipeline = new ScriptedPipeline();
    let paused = false;
    pipeline.gate = () => new Promise(() => undefined);
    const runtime = dmRuntime(storage, discord, pipeline, { isPaused: () => paused });
    const pending = runtime.handleDirectMessage(discord.dm("hello?"));
    await until(() => pipeline.requests.length === 1, "generation");
    paused = true;
    await runtime.pause();
    await pending;
    let state = await readDmState(storage, USER, "aria");
    expect(state?.pendingTriggerMessageId).toBeUndefined();
    expect(state?.recentRuns.map((run) => run.status)).toEqual(["interrupted"]);
    // A DM while paused is recorded but not answered.
    await runtime.handleDirectMessage(discord.dm("still there?"));
    expect(discord.sent).toEqual([]);
    expect(pipeline.requests).toHaveLength(1);

    pipeline.gate = undefined;
    pipeline.replies.push({ content: "back now" });
    paused = false;
    runtime.resumeAfterPause();
    await until(() => discord.sent.length === 1, "catch-up after resume");
    await runtime.settleBackground();
    state = await readDmState(storage, USER, "aria");
    expect(pipeline.requests.at(-1)!.prompt!.debug.transcript).toContain("still there?");
    expect(state?.recentRuns.at(-1)?.status).toBe("sent");
    await runtime.stop();
  });

  it("a paused boot answers nothing until resume", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    const discord = new DmDiscord();
    const pipeline = new ScriptedPipeline();
    let paused = true;
    const runtime = dmRuntime(storage, discord, pipeline, { isPaused: () => paused });
    await runtime.start();
    await runtime.handleDirectMessage(discord.dm("hi"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(discord.sent).toEqual([]);
    paused = false;
    runtime.resumeAfterPause();
    await until(() => discord.sent.length === 1, "catch-up after resume");
    await runtime.stop();
  });

  it("never writes the DM transcript into logs: DM log lines carry ids and status only", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    const discord = new DmDiscord();
    const lines: string[] = [];
    const logger = {
      debug: (m: string, c?: unknown) => lines.push(`${m} ${JSON.stringify(c ?? {})}`),
      info: (m: string, c?: unknown) => lines.push(`${m} ${JSON.stringify(c ?? {})}`),
      warn: (m: string, c?: unknown) => lines.push(`${m} ${JSON.stringify(c ?? {})}`),
      error: (m: string, c?: unknown) => lines.push(`${m} ${JSON.stringify(c ?? {})}`)
    };
    const pipeline = new ScriptedPipeline();
    pipeline.replies.push({ content: "a very secret reply" });
    const runtime = dmRuntime(storage, discord, pipeline, { logger });
    await runtime.handleDirectMessage(discord.dm("my very secret question"));
    await runtime.stop();
    const dmLines = lines.filter((line) => line.startsWith("DM "));
    expect(dmLines.length).toBeGreaterThan(0);
    expect(dmLines.join("\n")).not.toContain("secret");
  });
});

describe("DM observer", () => {
  it("reads the DM ledger without server flags and stores what it learns as DM-origin memories of her", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    await storage.writeJson("stage-manager", "user/stage-manager/config.json", AgentConfigSchema, AgentConfigSchema.parse({
      ...createRevisionedBase(), enabled: true, providerId: "openai", modelId: "gpt-5.4-mini", contextWindow: 80, prompt: ""
    }));
    const discord = new DmDiscord();
    const pipeline = new ScriptedPipeline();
    const inputs: string[] = [];
    (pipeline as ScriptedPipeline & { decideStageManagerObservations: unknown }).decideStageManagerObservations = async (request: {
      observerInput?: string;
      availableWaifuIds?: string[];
    }) => {
      inputs.push(request.observerInput ?? "");
      expect(request.availableWaifuIds).toEqual(["aria"]);
      return [{ waifuId: "aria", content: "Kevin is running a marathon in May.", importance: 5, kind: "fact" as const }];
    };
    const runtime = dmRuntime(storage, discord, pipeline);
    await runtime.handleDirectMessage(discord.dm("running a marathon in may!"));
    await runtime.memoryJobs.requestObserveThrough({ kind: "dm", waifuId: "aria", userId: USER }, 1);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain("running a marathon in may!");
    const store = await storage.readJson("user/memories.json", MemoryStoreSchema);
    expect(store.memories).toHaveLength(1);
    expect(store.memories[0]).toMatchObject({ waifuId: "aria", origin: { dm: true } });
    await runtime.stop();
  });
});

describe("DM files", () => {
  it("stores state at user/dms/<user>/<waifu>.json and counters under limits/", async () => {
    const { root, storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    const discord = new DmDiscord();
    const runtime = dmRuntime(storage, discord, new ScriptedPipeline());
    await runtime.handleDirectMessage(discord.dm("hi"));
    await runtime.stop();
    const state = JSON.parse(await readFile(path.join(root, "user", "dms", USER, "aria.json"), "utf8"));
    expect(state).toMatchObject({ waifuId: "aria", userId: USER, botId: "aria-bot", userDisplayName: "Kevin" });
    const limits = JSON.parse(await readFile(path.join(root, "user", "dms", USER, "limits", "aria.json"), "utf8"));
    expect(limits.replyTimestamps).toHaveLength(1);
  });
});
