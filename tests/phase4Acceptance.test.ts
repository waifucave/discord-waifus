// Phase 4 acceptance (spec 8.11) for the two behaviours no other test covers end to end:
// - a memory learned in server A is retrieved in server B through the real ContextRuntime.prepare
//   over the storage-backed snapshot provider (and nowhere it should not be);
// - re-running every migration is a no-op: byte-identical files, with or without the ledger.
//
// (The 200-message compaction, the compaction-request-equals-reply-call check and the usage-ledger
// line per model call live in contextCompaction.test.ts, gatewayPipelineAdoption.test.ts and
// eval/cacheHit.test.ts.)

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGateway } from "@waifucave/gateway";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATION_STEPS, runMigrations } from "../src/backend/migrations.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { emaTokenCalibration, createCompactionService } from "../src/orchestration/context/compaction.js";
import { FileContextStore } from "../src/orchestration/context/contextStore.js";
import type { ConversationRef } from "../src/orchestration/context/keys.js";
import { ContextRuntime } from "../src/orchestration/context/runtime.js";
import { createStorageMemorySnapshotProvider } from "../src/orchestration/memorySnapshot.js";
import { createWaifuHarness } from "../src/orchestration/waifuHarness.js";
import { recordWaifuNotes } from "../src/orchestration/stores/memories.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/shared/schemas/compaction.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { MemoryStoreSchema, WaifuConfigSchema } from "../src/shared/schemas/domain.js";
import { StorageService } from "../src/storage/storageService.js";
import { BASE_TIME, FakeChannel, FakeImageFetcher, quietLogger } from "./contextFixtures.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

async function freshRoot(): Promise<string> {
  const root = await makeTempRoot();
  roots.push(root);
  return root;
}

// ---------------------------------------------------------------------------------------------
// Memory learned in server A is retrieved in server B

describe("cross-server memory", () => {
  const MODEL = createGateway({ credentials: { anthropic: "sk-test" }, fetchImpl: (async () => new Response("{}")) as typeof fetch }).getCapabilities(
    "anthropic",
    "claude-sonnet-4-6"
  )!;
  const GUILD_A: ConversationRef = { kind: "guild", guildId: "111111111111111111", channelId: "211111111111111111" };
  const GUILD_B: ConversationRef = { kind: "guild", guildId: "322222222222222222", channelId: "422222222222222222" };
  const DM: ConversationRef = { kind: "dm", waifuId: "yuki", userId: "kevin" };
  const KEVIN = { discordUserId: "kevin", name: "Kevin" };

  const waifu = (id: string) =>
    WaifuConfigSchema.parse({
      ...createRevisionedBase(),
      id,
      name: id,
      displayName: id,
      botId: `${id}-bot`,
      modelId: "claude-sonnet-4-6",
      persona: `${id} is a friend.`
    });

  async function prepareAs(storage: StorageService, id: string, conversation: ConversationRef, say: string): Promise<string> {
    const channel = new FakeChannel();
    channel.post({ authorId: "kevin", authorName: "Kevin", content: say }, BASE_TIME);
    const now = () => new Date(BASE_TIME + 60_000);
    const store = new FileContextStore(storage, { now, timeZone: () => "UTC" });
    const logger = quietLogger();
    const runtime = new ContextRuntime({
      store,
      snapshots: createStorageMemorySnapshotProvider(storage),
      compaction: createCompactionService({ store, logger, now }),
      messages: channel,
      images: new FakeImageFetcher(),
      settings: () => ({ ...DEFAULT_COMPACTION_SETTINGS }),
      logger,
      now,
      timeZone: () => "UTC",
      calibrate: emaTokenCalibration
    });
    const place =
      conversation.kind === "guild"
        ? ({ kind: "guild", serverName: "Other Club", channelName: "chat" } as const)
        : ({ kind: "dm", userName: "Kevin" } as const);
    const harness = createWaifuHarness({
      waifu: waifu(id),
      conversation,
      roster: [],
      place,
      people: [{ userId: "kevin", name: "Kevin" }],
      emojis: [],
      tools: [],
      activity: () => undefined
    });
    const prepared = await runtime.prepare({
      conversation,
      agent: { kind: "waifu", waifuId: id },
      model: MODEL,
      backfillCap: 20,
      selfAuthorIds: [`${id}-bot`],
      render: harness,
      renderToolTurnsAsText: true,
      participantIds: ["kevin"],
      params: {}
    });
    return JSON.stringify(prepared.prompt.messages);
  }

  it("retrieves what Yuki learned in guild A when she talks to the same person in guild B and in a DM, and only for her", async () => {
    const root = await freshRoot();
    await ensureDataLayout(root);
    const storage = new StorageService(root);

    const decisions = await recordWaifuNotes(storage, {
      waifuId: "yuki",
      entries: ["Kevin is allergic to peanuts"],
      origin: { guildId: GUILD_A.guildId, channelId: GUILD_A.channelId },
      subjects: [KEVIN]
    });
    expect(decisions).toHaveLength(1);
    const store = MemoryStoreSchema.parse(JSON.parse(await readFile(path.join(root, "user", "memories.json"), "utf8")));
    expect(store.memories).toHaveLength(1);
    expect(store.memories[0]).toMatchObject({ waifuId: "yuki", origin: { guildId: GUILD_A.guildId } });

    const inB = await prepareAs(storage, "yuki", GUILD_B, "did anyone bring peanut butter cookies?");
    expect(inB).toContain("Kevin is allergic to peanuts");
    const inDm = await prepareAs(storage, "yuki", DM, "do you remember what I told you about peanuts?");
    expect(inDm).toContain("Kevin is allergic to peanuts");

    // Memories belong to one waifu: a sibling in the same room does not inherit them.
    const sibling = await prepareAs(storage, "riko", GUILD_B, "did anyone bring peanut butter cookies?");
    expect(sibling).not.toContain("allergic to peanuts");
  });
});

// ---------------------------------------------------------------------------------------------
// Re-running every migration is a no-op

describe("migrations re-run", () => {
  const T = "2026-10-01T12:00:00.000Z";
  const APP_VERSION = "2.200.0";

  async function writeJson(root: string, relativePath: string, value: unknown): Promise<void> {
    const file = path.join(root, relativePath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  const layoutBlock = (blockId: string) => ({ kind: "block", blockId, enabled: true });
  const legacyMemory = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    guildId: "guild-a",
    channelId: "chan-1",
    waifuId: "yuki",
    content: "Kevin is allergic to peanuts.",
    kind: "fact",
    source: "stage_manager",
    pinned: false,
    strength: 3,
    entities: ["Kevin"],
    createdAt: T,
    updatedAt: T,
    status: "active",
    ...overrides
  });

  /** A data root that exercises every shape-changing step at once. */
  async function seedLegacyRoot(root: string): Promise<void> {
    await ensureDataLayout(root);
    await writeJson(root, "user/waifus/yuki/waifu.json", {
      schemaVersion: 2, revision: 3, updatedAt: T, id: "yuki", name: "Yuki", displayName: "Yuki", persona: "kind",
      providerId: "anthropic", modelId: "claude-opus-4-7",
      params: { temperature: 0.8, topP: 0.9, maxOutputTokens: 500 },
      promptLayout: {
        top: ["identity", "persona", "schedule", "ioFormat", "tools", "outputContract"].map(layoutBlock),
        mid: ["roomInfo", "relevantMemories"].map(layoutBlock),
        trailing: ["anchor", "currentlyDoing", "directorNote"].map(layoutBlock)
      }
    });
    await writeJson(root, "user/waifus/riko/waifu.json", {
      schemaVersion: 2, revision: 1, updatedAt: T, id: "riko", name: "Riko", displayName: "Riko-chan", persona: "dry",
      providerId: "anthropic", modelId: "claude-haiku-4-5-20251001", params: { temperature: 0.8 }
    });
    await writeJson(root, "user/orchestrator/config.json", {
      providerId: "anthropic", modelId: "claude-opus-4-7", params: { temperature: 0.2 }
    });
    await writeJson(root, "user/servers/guild-a/members.json", {
      schemaVersion: 2, revision: 0, updatedAt: T, guildId: "guild-a",
      members: [{ userId: "111", username: "kev", guildDisplayName: "Kevin", bot: false }]
    });
    await writeJson(root, "user/servers/guild-b/members.json", {
      schemaVersion: 2, revision: 0, updatedAt: T, guildId: "guild-b",
      members: [{ userId: "111", username: "kev", guildDisplayName: "Kev", bot: false }]
    });
    await writeJson(root, "user/servers/guild-a/server.json", {
      guildId: "guild-a", name: "Bake Club", contextWindows: { orchestrator: 20, waifu: 50, stageManager: 120 }
    });
    await writeJson(root, "user/memories.json", {
      schemaVersion: 2, revision: 4, updatedAt: T,
      memories: [
        legacyMemory("m1"),
        legacyMemory("m2", { guildId: "guild-b", channelId: undefined, entities: ["Kev"], strength: 4 }),
        legacyMemory("m3", { content: "The bake sale is on Saturday.", kind: "event", entities: [] }),
        legacyMemory("m4", { waifuId: "deleted-waifu" })
      ]
    });
    await writeJson(root, "user/memory/pending-observations.json", {
      schemaVersion: 2, revision: 1, updatedAt: T,
      observations: [{
        id: "o1", guildId: "guild-a", channelId: "chan-1", waifuId: "yuki",
        content: "Kevin likes tea.", kind: "preference", importance: 3, entities: ["Kevin"], createdAt: T
      }]
    });
    await writeJson(root, "user/memory/dream-cursor.json", {
      schemaVersion: 2, revision: 3, updatedAt: T, cursors: { "guild-a": "yuki", "guild-b": "riko" }
    });
    await writeJson(root, "app/cache/ocr/results/abc.json", { schemaVersion: 1, text: "old" });
    await writeJson(root, "app/cache/ocr/results-v2/def.json", { schemaVersion: 1, text: "new" });
  }

  /** Every file under the root, except the ledger (it records timestamps) and logs/runtime state. */
  async function snapshot(root: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        if (relative === "app/migrations.json" || relative.startsWith("app/logs") || relative === "app/runtime.json") continue;
        if (entry.isDirectory()) await walk(absolute);
        else out.set(relative, await readFile(absolute, "utf8"));
      }
    };
    await walk(root);
    return out;
  }

  it("changes the legacy root once, then a second run and a ledger-less third run leave every file byte-identical", async () => {
    const root = await freshRoot();
    await seedLegacyRoot(root);
    const legacy = await snapshot(root);

    const first = await runMigrations(root, { appVersion: APP_VERSION });
    expect(first.applied.length).toBeGreaterThan(0);
    const migrated = await snapshot(root);
    expect(migrated).not.toEqual(legacy);
    // The shapes really moved: no legacy keys survive.
    const yuki = JSON.parse(migrated.get("user/waifus/yuki/waifu.json")!);
    expect(yuki).not.toHaveProperty("promptLayout");
    expect(yuki.params).not.toHaveProperty("temperature");
    expect(migrated.has("app/cache/ocr/results/abc.json")).toBe(false);
    expect(migrated.has("app/cache/ocr/results-v2/def.json")).toBe(true);
    expect(JSON.parse(migrated.get("user/memory/dream-cursor.json")!)).not.toHaveProperty("cursors");
    for (const memory of JSON.parse(migrated.get("user/memories.json")!).memories as Array<Record<string, unknown>>) {
      expect(memory).not.toHaveProperty("guildId");
    }

    // Same version, ledger intact: nothing runs.
    const second = await runMigrations(root, { appVersion: APP_VERSION });
    expect(second.applied).toEqual([]);
    expect(await snapshot(root)).toEqual(migrated);

    // Ledger lost: every idempotent step re-runs and still changes nothing.
    await rm(path.join(root, "app", "migrations.json"));
    await runMigrations(root, { appVersion: APP_VERSION });
    const third = await snapshot(root);
    expect([...third.keys()].sort()).toEqual([...migrated.keys()].sort());
    for (const [file, bytes] of migrated) expect(third.get(file), file).toBe(bytes);

    // A new app version re-runs the per-version steps and is still a no-op on the data.
    await runMigrations(root, { appVersion: "2.201.0" });
    const fourth = await snapshot(root);
    for (const [file, bytes] of migrated) expect(fourth.get(file), file).toBe(bytes);
  });
});
