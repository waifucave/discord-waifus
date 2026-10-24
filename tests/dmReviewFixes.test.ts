// Review fixes for the Phase 5 DM work: the forget floor (C1), the semaphore (I1), DM/guild memory
// separation (I2), DM provenance and forget by origin (I3), redacted DM logs (I4) and the minor
// items (limit notice abort, dmMs=0 double run, image purge, preempted-channel hold, crash
// after send).

import { mkdir, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationKey, conversationLedgerPath } from "../src/orchestration/context/keys.js";
import { dmForget } from "../src/orchestration/dm/dmForget.js";
import { Semaphore } from "../src/orchestration/dm/dmRunner.js";
import { readDmLimit, readDmState, updateDmState } from "../src/orchestration/dm/dmStore.js";
import { applyDreamOps } from "../src/orchestration/dream.js";
import { forgetUser } from "../src/orchestration/memoryForget.js";
import { sameOriginScore } from "../src/orchestration/memorySnapshot.js";
import { mergedDmOrigin } from "../src/orchestration/observer.js";
import { readMemoryStore } from "../src/orchestration/stores/memories.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { ConversationLedgerSchema, type LedgerEntry } from "../src/shared/schemas/context.js";
import {
  AgentConfigSchema,
  MemoryStoreSchema,
  ServerConfigSchema,
  createEmptyRevisionedFile,
  type MemoryRecord
} from "../src/shared/schemas/domain.js";
import type { StorageService } from "../src/storage/storageService.js";
import { DmDiscord, ScriptedPipeline, USER, USER_2, deferred, dmRoot, dmRuntime, seedDmWorld, until } from "./dmFixtures.js";
import { removeTempRoot } from "./testUtils.js";

vi.setConfig({ testTimeout: 30_000 });

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const DM = { kind: "dm" as const, waifuId: "aria", userId: USER };
const KEY = conversationKey(DM);
const T = "2026-10-01T12:00:00.000Z";
const exists = (file: string) => access(file).then(() => true, () => false);

type ObserverRequest = { observerInput?: string; availableWaifuIds?: string[] };

/** A scripted pipeline that also observes (records inputs, answers with `ops`). */
function observingPipeline(ops: unknown[] = []) {
  const pipeline = new ScriptedPipeline();
  const inputs: string[] = [];
  (pipeline as ScriptedPipeline & { decideStageManagerObservations: unknown }).decideStageManagerObservations = async (request: ObserverRequest) => {
    inputs.push(request.observerInput ?? "");
    return ops.splice(0);
  };
  return { pipeline, inputs };
}

async function enableObserver(storage: StorageService) {
  await storage.writeJson("stage-manager", "user/stage-manager/config.json", AgentConfigSchema, AgentConfigSchema.parse({
    ...createRevisionedBase(), enabled: true, providerId: "openai", modelId: "gpt-5.4-mini", contextWindow: 80, prompt: ""
  }));
}

function memory(id: string, o: Partial<MemoryRecord>): MemoryRecord {
  return {
    id,
    waifuId: "aria",
    content: `Memory ${id}`,
    kind: "fact",
    source: "stage_manager",
    pinned: false,
    strength: 3,
    origin: {},
    subjects: [{ discordUserId: USER, name: "Kevin" }],
    revision: 0,
    createdAt: T,
    updatedAt: T,
    status: "active",
    ...o
  };
}

async function seedMemories(storage: StorageService, memories: MemoryRecord[]) {
  await storage.writeJson("memories:global", "user/memories.json", MemoryStoreSchema, MemoryStoreSchema.parse(createEmptyRevisionedFile({ memories })));
}

describe("C1: the forget floor", () => {
  for (const scope of ["everything", "conversation"] as const) {
    it(`after /forget (${scope}) the next DM's prompt and observer never see the old chat, across a restart too`, async () => {
      const { storage } = await dmRoot(roots);
      await seedDmWorld(storage);
      await enableObserver(storage);
      const discord = new DmDiscord();
      const { pipeline, inputs } = observingPipeline();
      let runtime = dmRuntime(storage, discord, pipeline);
      await runtime.handleDirectMessage(discord.dm("my password is swordfish"));
      expect(pipeline.requests[0]!.prompt!.debug.transcript).toContain("swordfish");

      await runtime.handleDmForgetCommand({ waifuId: "aria", botId: "aria-bot", userId: USER, scope });
      expect((await readDmLimit(storage, USER, "aria")).floorMessageId).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 5)); // the next snowflake is above the floor
      await runtime.handleDirectMessage(discord.dm("hello again"));
      const prompt = pipeline.requests.at(-1)!.prompt!.debug;
      expect(prompt.transcript).toContain("hello again");
      expect(JSON.stringify(prompt)).not.toContain("swordfish");
      await runtime.memoryJobs.requestObserveThrough(DM, 999);
      expect(inputs.length).toBeGreaterThan(0);
      for (const input of inputs) expect(input).not.toContain("swordfish");

      // A restart (fresh conversation cache) keeps the floor.
      await runtime.stop();
      runtime = dmRuntime(storage, discord, pipeline);
      await runtime.handleDirectMessage(discord.dm("third message"));
      expect(JSON.stringify(pipeline.requests.at(-1)!.prompt!.debug)).not.toContain("swordfish");
      await runtime.stop();
    });
  }
});

describe("I1: semaphore", () => {
  it("an aborted waiter leaves the queue and the next waiter gets the freed slot", async () => {
    const semaphore = new Semaphore(() => 1);
    const release = await semaphore.acquire();
    const abortA = new AbortController();
    const a = semaphore.acquire(abortA.signal);
    const b = semaphore.acquire();
    expect(semaphore.waiting).toBe(2);
    abortA.abort(new Error("superseded"));
    await expect(a).rejects.toThrow("superseded");
    expect(semaphore.waiting).toBe(1);
    release();
    const releaseB = await b;
    expect(semaphore.inUse).toBe(1);
    releaseB();
    expect(semaphore.inUse).toBe(0);
    // An already aborted signal never takes a free slot.
    const aborted = new AbortController();
    aborted.abort(new Error("gone"));
    await expect(semaphore.acquire(aborted.signal)).rejects.toThrow("gone");
    expect(semaphore.inUse).toBe(0);
  });

  it("with maxConcurrentRuns=1, a superseded waiting DM run never blocks the next one", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    const discord = new DmDiscord();
    const pipeline = new ScriptedPipeline();
    const hold = deferred();
    let calls = 0;
    pipeline.gate = () => (++calls === 1 ? hold.promise : Promise.resolve());
    const runtime = dmRuntime(storage, discord, pipeline, { dm: { maxConcurrentRuns: 1 } });
    const active = runtime.handleDirectMessage(discord.dm("hi", USER_2));
    await until(() => pipeline.requests.length === 1, "the active run");
    const a = runtime.handleDirectMessage(discord.dm("first", USER));
    await until(() => runtime.dm.semaphore.waiting === 1, "A waiting");
    // A newer message supersedes A while it waits; its rerun (B) must run once the slot frees.
    const b = runtime.handleDirectMessage(discord.dm("second", USER));
    hold.resolve();
    await Promise.all([active, a, b]);
    await runtime.settleBackground();
    expect(discord.sent.filter((s) => s.userId === USER)).toHaveLength(1);
    expect(runtime.dm.semaphore.inUse).toBe(0);
    await runtime.stop();
  });
});

describe("I2: DM and guild memories stay apart", () => {
  it("the DM observer sees only this user's DM memories, and its edits stay DM-origin", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    await enableObserver(storage);
    await seedMemories(storage, [
      memory("own", { content: "own dm fact", origin: { dm: true, userId: USER } }),
      memory("guild", { content: "guild fact", origin: { guildId: "100000000000000001" } }),
      memory("other", { content: "other dm fact", origin: { dm: true, userId: USER_2 } })
    ]);
    const discord = new DmDiscord();
    const { pipeline, inputs } = observingPipeline([{ op: "update", memory: "m1", content: "own dm fact, updated" }]);
    const runtime = dmRuntime(storage, discord, pipeline);
    await runtime.handleDirectMessage(discord.dm("hi"));
    await runtime.memoryJobs.requestObserveThrough(DM, 999);
    expect(inputs[0]).toContain("own dm fact");
    expect(inputs[0]).not.toContain("guild fact");
    expect(inputs[0]).not.toContain("other dm fact");
    const store = await readMemoryStore(storage);
    expect(store.memories.find((m) => m.id === "own")).toMatchObject({ content: "own dm fact, updated", origin: { dm: true, userId: USER } });
    expect(store.memories.find((m) => m.id === "guild")).toMatchObject({ content: "guild fact", origin: { guildId: "100000000000000001" } });
    await runtime.stop();
  });

  it("a guild observer never receives DM-origin memories", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    await enableObserver(storage);
    const GUILD = "100000000000000001";
    const CHANNEL = "200000000000000002";
    await storage.writeJson(`server:${GUILD}`, `user/servers/${GUILD}/server.json`, ServerConfigSchema, ServerConfigSchema.parse({
      ...createRevisionedBase(), guildId: GUILD, name: "Bake Club", channels: { [CHANNEL]: { channelId: CHANNEL, name: "general", enabledWaifuIds: ["aria"] } }
    }));
    const key = conversationKey({ kind: "guild", guildId: GUILD, channelId: CHANNEL });
    const entry: LedgerEntry = { id: "300000000000000001", seq: 1, authorId: USER, authorName: "Kevin", authorIsBot: false, at: T, kind: "default", body: "hi all", images: [], state: "live", sealed: true };
    await storage.writeJson(`ledger:${key}`, conversationLedgerPath(key), ConversationLedgerSchema, ConversationLedgerSchema.parse(createEmptyRevisionedFile({
      conversationKey: key, nextSeq: 2, entries: { [entry.id]: entry }, events: []
    })));
    await seedMemories(storage, [
      memory("private", { content: "private dm fact", origin: { dm: true, userId: USER } }),
      memory("guild", { content: "guild fact", origin: { guildId: GUILD } })
    ]);
    const { pipeline, inputs } = observingPipeline();
    const runtime = dmRuntime(storage, new DmDiscord(), pipeline);
    await runtime.memoryJobs.startStageManagerRun(GUILD, CHANNEL);
    expect(inputs[0]).toContain("guild fact");
    expect(inputs[0]).not.toContain("private dm fact");
    await runtime.stop();
  });

  it("any merge involving a DM-origin source keeps the DM origin (observer and dream)", () => {
    const dm = { origin: { dm: true as const, userId: USER } };
    const guild = { origin: { guildId: "1" } };
    expect(mergedDmOrigin({ guildId: "1" }, guild, [dm])).toEqual(dm.origin);
    expect(mergedDmOrigin({ guildId: "1" }, guild, [guild])).toBeUndefined();
    expect(mergedDmOrigin({ dm: true, userId: USER }, guild, [guild])).toEqual({ dm: true, userId: USER });
    const records = [memory("a", { origin: { guildId: "1" }, content: "Kevin likes tea" }), memory("b", { origin: dm.origin, content: "Kevin likes green tea" })];
    const result = applyDreamOps(records, [{ op: "merge", memoryIndices: [1, 2], content: "Kevin likes green tea", entities: [] }], new Map([[1, "a"], [2, "b"]]), {
      now: new Date(T)
    });
    expect(result.memories.find((m) => m.status === "active")).toMatchObject({ origin: dm.origin });
  });
});

describe("I3: DM provenance and forget by origin", () => {
  it("DM observer adds carry origin { dm, userId }, and forget deletes DM-origin records without subjects", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    await enableObserver(storage);
    const discord = new DmDiscord();
    const { pipeline } = observingPipeline([{ waifuId: "aria", content: "Likes rainy days.", importance: 5, kind: "preference" }]);
    const runtime = dmRuntime(storage, discord, pipeline);
    await runtime.handleDirectMessage(discord.dm("i love rainy days"));
    await runtime.memoryJobs.requestObserveThrough(DM, 999);
    let store = await readMemoryStore(storage);
    expect(store.memories).toHaveLength(1);
    expect(store.memories[0]).toMatchObject({ origin: { dm: true, userId: USER } });
    const forgot = await runtime.forgetDm({ userId: USER, waifuId: "aria", scope: "all" });
    expect(forgot.deleted.memories).toBe(1);
    store = await readMemoryStore(storage);
    expect(store.memories).toEqual([]);
    await runtime.stop();
  });

  it("forget-user also deletes DM-origin records of the user that name no subject", async () => {
    const { storage } = await dmRoot(roots);
    await seedMemories(storage, [
      memory("dm", { origin: { dm: true, userId: USER }, subjects: [] }),
      memory("other", { origin: { dm: true, userId: USER_2 }, subjects: [] })
    ]);
    const result = await forgetUser(storage, { discordUserId: USER });
    expect(result.memories).toBe(1);
    expect((await readMemoryStore(storage)).memories.map((m) => m.id)).toEqual(["other"]);
  });

  it("the same-origin boost counts only the user's own DM", () => {
    expect(sameOriginScore({ dm: true, userId: USER }, DM)).toBe(1);
    expect(sameOriginScore({ dm: true, userId: USER_2 }, DM)).toBe(0);
    expect(sameOriginScore({ dm: true }, DM)).toBe(0);
  });

  it("forget waits for an in-flight DM observer and cancels its idle timer, so nothing recreates the conversation", async () => {
    const { root, storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    await enableObserver(storage);
    const discord = new DmDiscord();
    const pipeline = new ScriptedPipeline();
    const hold = deferred();
    let observed = 0;
    (pipeline as ScriptedPipeline & { decideStageManagerObservations: unknown }).decideStageManagerObservations = async () => {
      observed += 1;
      await hold.promise;
      return [{ waifuId: "aria", content: "Kevin is moving.", importance: 5, kind: "fact" }];
    };
    const runtime = dmRuntime(storage, discord, pipeline, { stageManagerIdleDelayMs: 20 });
    await runtime.handleDirectMessage(discord.dm("i'm moving next week"));
    await until(() => observed === 1, "the idle observer run");
    const forgetting = runtime.forgetDm({ userId: USER, waifuId: "aria", scope: "all" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    hold.resolve();
    await forgetting;
    await new Promise((resolve) => setTimeout(resolve, 60));
    await runtime.settleBackground();
    expect(await exists(path.join(root, "user", "conversations", KEY))).toBe(false);
    expect((await readMemoryStore(storage)).memories).toEqual([]);
    expect(observed).toBe(1);
    await runtime.stop();
  });
});

describe("I4: DM text never reaches the logs", () => {
  it("redacts the trim, clean and length-cut paths too", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    const discord = new DmDiscord();
    const lines: string[] = [];
    const log = (m: string, c?: unknown) => void lines.push(`${m} ${JSON.stringify(c ?? {})}`);
    const logger = { debug: log, info: log, warn: log, error: log };
    const pipeline = new ScriptedPipeline();
    const long = Array.from({ length: 4 }, (_, i) => `This is secret sentence ${i} about cupcakes.`).join(" ");
    pipeline.replies.push(
      { content: long }, // trim
      { content: "Aria: a secret greeting" }, // clean (leading self name)
      { content: "secret one. secret two and then", finishReason: "length" }, // length cut
      { content: "Aria:" }, // entirely removed during cleaning → retry
      { content: "fine" }
    );
    const runtime = dmRuntime(storage, discord, pipeline, { logger });
    for (const text of ["one", "two", "three", "four"]) await runtime.handleDirectMessage(discord.dm(text));
    await runtime.stop();
    expect(lines.some((line) => line.startsWith("Trimmed waifu reply"))).toBe(true);
    expect(lines.some((line) => line.startsWith("Cleaned waifu reply"))).toBe(true);
    expect(lines.some((line) => line.startsWith("Waifu reply hit the output limit"))).toBe(true);
    expect(lines.join("\n")).not.toContain("secret");
  });
});

describe("minor review items", () => {
  it("an aborted run never sends the limit notice", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage, { dm: { rateLimit: { maxReplies: 1, windowMinutes: 60 } } });
    const discord = new DmDiscord();
    const runtime = dmRuntime(storage, discord, new ScriptedPipeline());
    await runtime.handleDirectMessage(discord.dm("one"));
    expect(discord.sent).toHaveLength(1);
    // Abort the run right when it reads the clock (after the limit check started).
    const dm = runtime.dm as unknown as { now: () => Date; slots: Map<string, { controller?: AbortController }> };
    dm.now = () => {
      for (const slot of dm.slots.values()) slot.controller?.abort(new Error("runtime paused"));
      return new Date();
    };
    await runtime.handleDirectMessage(discord.dm("two"));
    expect(discord.sent).toHaveLength(1);
    expect((await readDmLimit(storage, USER, "aria")).limitNoticeSentAt).toBeUndefined();
    await runtime.stop();
  });

  it("dmMs = 0: two messages during one generation start exactly one rerun", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    const discord = new DmDiscord();
    const pipeline = new ScriptedPipeline();
    pipeline.gate = () => (pipeline.requests.length === 1 ? new Promise(() => undefined) : Promise.resolve());
    const runtime = dmRuntime(storage, discord, pipeline);
    const first = runtime.handleDirectMessage(discord.dm("hey"));
    await until(() => pipeline.requests.length === 1, "first generation");
    await Promise.all([runtime.handleDirectMessage(discord.dm("wait")), runtime.handleDirectMessage(discord.dm("one more"))]);
    await first;
    await runtime.settleBackground();
    expect(pipeline.requests).toHaveLength(2);
    expect(discord.sent).toHaveLength(1);
    await runtime.stop();
  });

  it("forget purges the conversation's cached images without a live runtime and counts only what existed", async () => {
    for (const scope of ["conversation", "all"] as const) {
      const { root, storage } = await dmRoot(roots);
      await updateDmState(storage, { userId: USER, waifuId: "aria", botId: "aria-bot" }, (s) => ({ ...s, lastInboundMessageId: "1" }));
      const image = (key: string) => ({ key, url: `https://cdn.discordapp.com/attachments/1/2/${key}.png` });
      const entry: LedgerEntry = {
        id: "300000000000000001", seq: 1, authorId: USER, authorName: "Kevin", authorIsBot: false, at: T, kind: "default", body: "[image]",
        images: [image("att:1"), image("att:2")], state: "live", sealed: true
      };
      await storage.writeJson(`ledger:${KEY}`, conversationLedgerPath(KEY), ConversationLedgerSchema, ConversationLedgerSchema.parse(createEmptyRevisionedFile({
        conversationKey: KEY, nextSeq: 2, entries: { [entry.id]: entry }, events: []
      })));
      const dir = path.join(root, "app", "cache", "images");
      await mkdir(dir, { recursive: true });
      const cached = path.join(dir, `${createHash("sha256").update("att:1").digest("hex")}.bin`);
      await writeFile(cached, "png");
      const dry = await dmForget(storage, { userId: USER, waifuId: "aria", scope, dryRun: true });
      expect(dry.deleted.cachedImages).toBe(1);
      expect(await exists(cached)).toBe(true);
      const done = await dmForget(storage, { userId: USER, waifuId: "aria", scope });
      expect(done.deleted.cachedImages).toBe(1);
      expect(await exists(cached)).toBe(false);
      expect(await exists(path.join(root, "user", "conversations", KEY))).toBe(false);
      expect((await readDmLimit(storage, USER, "aria")).floorMessageId).toBeDefined();
    }
  });

  it("boot does not answer twice when her reply is already the newest message (crash after send)", async () => {
    const { storage } = await dmRoot(roots);
    await seedDmWorld(storage);
    const discord = new DmDiscord();
    const human = discord.dm("are you there?");
    discord.post(USER, "yes, here!", { bot: true }); // sent just before the crash
    await updateDmState(storage, { userId: USER, waifuId: "aria", botId: "aria-bot" }, (s) => ({
      ...s,
      lastInboundMessageId: human.messageId,
      lastInboundAt: new Date().toISOString(),
      pendingTriggerMessageId: human.messageId,
      pendingSince: new Date().toISOString()
    }));
    const pipeline = new ScriptedPipeline();
    const runtime = dmRuntime(storage, discord, pipeline);
    await runtime.dm.resume();
    await runtime.settleBackground();
    expect(pipeline.requests).toEqual([]);
    const state = await readDmState(storage, USER, "aria");
    expect(state?.pendingTriggerMessageId).toBeUndefined();
    expect(state?.lastRepliedMessageId).toBe(human.messageId);
    await runtime.stop();
  });
});
