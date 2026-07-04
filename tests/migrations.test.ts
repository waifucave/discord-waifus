import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/backend/migrations.js";
import { loadAppConfig } from "../src/config/appConfig.js";
import { RuntimeStateSchema } from "../src/backend/runtime.js";
import { CURRENT_SCHEMA_VERSION } from "../src/shared/schemas/common.js";
import type { PromptLayoutNode as LayoutNode } from "../src/shared/schemas/domain.js";
import {
  AgentConfigSchema,
  DiscordBotsFileSchema,
  MemoryStoreSchema,
  ProviderCredentialsFileSchema,
  ServerConfigSchema,
  WaifuConfigSchema,
  defaultWaifuPromptLayout
} from "../src/shared/schemas/domain.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => removeTempRoot(root)));
  roots.length = 0;
});

describe("runMigrations", () => {
  it("migrates legacy orchestrator decisions, prompt sections, and sessions", async () => {
    const root = await makeTempRoot();
    roots.push(root);

    await writeJson(root, "user/orchestrator/history.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-05-16T12:00:00.000Z",
      decisions: [
        {
          id: "reply-chain",
          guildId: "guild-1",
          channelId: "channel-1",
          steps: [
            { kind: "yuki", sceneDirection: "answer Kevin", replyToMessageId: "message-1" },
            { kind: "no_reply" }
          ],
          idleTrigger: 300,
          reasoning: "old reply chain",
          createdAt: "2026-05-16T12:05:00.000Z"
        },
        {
          id: "short-no-reply",
          guildId: "guild-1",
          channelId: "channel-1",
          steps: [{ kind: "no_reply" }],
          idleTrigger: 60,
          reasoning: "too short",
          createdAt: "2026-05-16T12:06:00.000Z"
        }
      ]
    });
    await writeJson(root, "user/orchestrator/config.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-05-16T12:00:00.000Z",
      promptSections: {
        loopBreaking: true,
        idleTriggerPacing: false,
        messageStructure: true,
        toolUse: true
      }
    });
    await writeJson(root, "user/servers/guild-1/sessions/channel-1.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-05-16T12:00:00.000Z",
      guildId: "guild-1",
      channelId: "channel-1",
      scheduledIdleTriggerAt: "2026-05-16T12:30:00.000Z",
      cachedWaifuContinuation: {
        waifuId: "yuki",
        senderBotId: "yuki-bot",
        chunks: ["later"],
        allowedUserMentionIds: ["kevin"],
        cachedAt: "2026-05-16T12:00:00.000Z",
        idleAfter: "2026-05-16T12:08:00.000Z"
      }
    });

    const result = await runMigrations(root);

    expect(result.applied).toEqual([
      "migrate-orchestrator-history-to-responding-waifus",
      "migrate-retrigger-pacing-1",
      "migrate-scheduled-retrigger-at-1",
      "stamp-schema-version-2"
    ]);
    const history = await readJson<{ decisions: Array<Record<string, unknown>> }>(
      root,
      "user/orchestrator/history.json"
    );
    expect(history.decisions[0]).toMatchObject({
      id: "reply-chain",
      action: "reply",
      respondingWaifus: [
        {
          waifuId: "yuki",
          delaySeconds: 0,
          sceneDirection: "answer Kevin",
          replyToMessageId: "message-1"
        }
      ]
    });
    expect(history.decisions[0]).not.toHaveProperty("steps");
    expect(history.decisions[0]).not.toHaveProperty("idleTrigger");
    expect(history.decisions[0]).not.toHaveProperty("retriggerAfterSeconds");
    expect(history.decisions[0]).toMatchObject({
      status: "completed",
      waifuMessageIds: [],
      responderOutcomes: []
    });
    expect(history.decisions[1]).toMatchObject({
      id: "short-no-reply",
      action: "no_reply",
      respondingWaifus: [],
      retriggerAfterSeconds: 100,
      status: "completed",
      waifuMessageIds: [],
      responderOutcomes: []
    });

    const config = await readJson<{ promptSections: Record<string, unknown> }>(
      root,
      "user/orchestrator/config.json"
    );
    expect(config.promptSections).toMatchObject({ pausePlanning: false, messageStructure: true });
    expect(config.promptSections).not.toHaveProperty("idleTriggerPacing");
    expect(config.promptSections).not.toHaveProperty("retriggerPacing");
    expect(config.promptSections).not.toHaveProperty("loopBreaking");
    expect(config.promptSections).not.toHaveProperty("toolUse");

    const session = await readJson<Record<string, unknown>>(root, "user/servers/guild-1/sessions/channel-1.json");
    expect(session.scheduledRetriggerAt).toBe("2026-05-16T12:30:00.000Z");
    expect(session).not.toHaveProperty("scheduledIdleTriggerAt");
    expect(session).not.toHaveProperty("cachedWaifuContinuation");
  });

  it("converts legacy waifu prompt-section booleans into the new default prompt layout", async () => {
    const root = await makeTempRoot();
    roots.push(root);

    await writeJson(root, "user/waifus/yuki/waifu.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-05-16T12:00:00.000Z",
      id: "yuki",
      name: "Yuki",
      displayName: "Yuki",
      persona: "kind",
      promptSections: {
        directorNotes: true,
        hardRules: false,
        mentionPolicy: true,
        replyTargeting: true,
        environmentInstructions: true,
        inputFormat: false,
        styleConstraints: true,
        personality: false
      }
    });

    const result = await runMigrations(root);
    expect(result.applied).toContain("migrate-waifu-prompt-layout-1");

    const config = await readJson<{
      promptSections?: unknown;
      promptLayout: { top: LayoutNode[]; mid: LayoutNode[]; trailing: LayoutNode[] };
    }>(root, "user/waifus/yuki/waifu.json");
    expect(config).not.toHaveProperty("promptSections");

    const enabledById = new Map<string, boolean>();
    const collect = (nodes: LayoutNode[]) => {
      for (const node of nodes) {
        if (node.kind === "block") enabledById.set(node.blockId, node.enabled);
        else for (const child of node.children) enabledById.set(child.blockId, child.enabled);
      }
    };
    collect(config.promptLayout.top);
    collect(config.promptLayout.mid);
    collect(config.promptLayout.trailing);

    // The legacy promptSections migration now produces the W2 default layout (new block IDs).
    // The old toggle booleans have no matching blocks in the new registry, so they are silently
    // ignored — the result is simply the new default with all blocks enabled.
    expect(enabledById.get("identity")).toBe(true);
    expect(enabledById.get("persona")).toBe(true);
    expect(enabledById.get("ioFormat")).toBe(true);
    expect(enabledById.get("outputContract")).toBe(true);
    expect(enabledById.get("roomInfo")).toBe(true);
    expect(enabledById.get("anchor")).toBe(true);
    expect(enabledById.get("directorNote")).toBe(true);
    // Old block IDs are not in the new layout.
    expect(enabledById.get("hardRules")).toBeUndefined();
    expect(enabledById.get("personalityReminder")).toBeUndefined();
  });

  it("resets a waifu whose promptLayout contains W1 block IDs to the W2 default", async () => {
    const root = await makeTempRoot();
    roots.push(root);

    // Seed a waifu with the old (W1) default layout — inline to avoid coupling to deleted code.
    const oldLayout = {
      top: [
        { kind: "block", blockId: "identity", enabled: true },
        {
          kind: "group",
          id: "behavior",
          tag: "{name}_behavior",
          enabled: true,
          children: [
            { kind: "block", blockId: "personality", enabled: true },
            { kind: "block", blockId: "schedule", enabled: true },
            { kind: "block", blockId: "contextStructure", enabled: true },
            { kind: "block", blockId: "environment", enabled: true },
            { kind: "block", blockId: "replyTargeting", enabled: true },
            { kind: "block", blockId: "mentionPolicy", enabled: true },
            { kind: "block", blockId: "styleConstraints", enabled: false },
            { kind: "block", blockId: "hardRules", enabled: true },
            { kind: "block", blockId: "toolUse", enabled: true }
          ]
        }
      ],
      mid: [
        { kind: "block", blockId: "directorNotes", enabled: true },
        { kind: "block", blockId: "activeParticipants", enabled: true },
        { kind: "block", blockId: "serverEmojis", enabled: true }
      ],
      trailing: [
        { kind: "block", blockId: "relevantMemories", enabled: true },
        { kind: "block", blockId: "personalityReminder", enabled: false },
        { kind: "block", blockId: "currentlyDoing", enabled: true },
        { kind: "block", blockId: "sceneDirection", enabled: true }
      ]
    };

    await writeJson(root, "user/waifus/yuki/waifu.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-05-16T12:00:00.000Z",
      id: "yuki",
      name: "Yuki",
      displayName: "Yuki",
      persona: "kind",
      promptLayout: oldLayout
    });

    const result = await runMigrations(root);
    expect(result.applied).toContain("migrate-waifu-prompt-layout-w2-1");

    const config = await readJson<{
      promptLayout: { top: LayoutNode[]; mid: LayoutNode[]; trailing: LayoutNode[] };
    }>(root, "user/waifus/yuki/waifu.json");

    const enabledById = new Map<string, boolean>();
    const collect = (nodes: LayoutNode[]) => {
      for (const node of nodes) {
        if (node.kind === "block") enabledById.set(node.blockId, node.enabled);
        else for (const child of node.children) enabledById.set(child.blockId, child.enabled);
      }
    };
    collect(config.promptLayout.top);
    collect(config.promptLayout.mid);
    collect(config.promptLayout.trailing);

    // After W2 migration the layout is the new default — new blocks enabled, old ones gone.
    expect(enabledById.get("identity")).toBe(true);
    expect(enabledById.get("persona")).toBe(true);
    expect(enabledById.get("ioFormat")).toBe(true);
    expect(enabledById.get("outputContract")).toBe(true);
    expect(enabledById.get("roomInfo")).toBe(true);
    expect(enabledById.get("anchor")).toBe(true);
    expect(enabledById.get("directorNote")).toBe(true);
    // Old IDs should no longer be present.
    expect(enabledById.get("personality")).toBeUndefined();
    expect(enabledById.get("hardRules")).toBeUndefined();
    expect(enabledById.get("sceneDirection")).toBeUndefined();
    expect(enabledById.get("directorNotes")).toBeUndefined();
  });

  it("moves a stored relevantMemories block from trailing to mid", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await writeJson(root, "user/waifus/yuki/waifu.json", {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision: 3,
      updatedAt: "2026-07-01T12:00:00.000Z",
      id: "yuki",
      name: "Yuki",
      displayName: "Yuki",
      enabled: true,
      persona: "kind",
      promptLayout: {
        top: [{ kind: "block", blockId: "identity", enabled: true }],
        mid: [{ kind: "block", blockId: "roomInfo", enabled: true }],
        trailing: [
          { kind: "block", blockId: "relevantMemories", enabled: false },
          { kind: "block", blockId: "anchor", enabled: true }
        ]
      }
    });

    const first = await runMigrations(root);
    expect(first.applied).toContain("migrate-waifu-memories-to-mid-1");

    const raw = await readJson<{
      promptLayout: { mid: LayoutNode[]; trailing: LayoutNode[] };
    }>(root, "user/waifus/yuki/waifu.json");
    expect(raw.promptLayout.mid).toEqual([
      { kind: "block", blockId: "roomInfo", enabled: true },
      { kind: "block", blockId: "relevantMemories", enabled: false }
    ]);
    expect(raw.promptLayout.trailing).toEqual([{ kind: "block", blockId: "anchor", enabled: true }]);

    // Idempotent: a second run finds nothing to move.
    const second = await runMigrations(root);
    expect(second.applied.filter((tag) => tag.startsWith("migrate-waifu-memories-to-mid"))).toEqual([]);
  });

  it("leaves relevantMemories alone when the user moved it into a custom group", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const layout = {
      top: [{ kind: "block", blockId: "identity", enabled: true }],
      mid: [{ kind: "block", blockId: "roomInfo", enabled: true }],
      trailing: [
        {
          kind: "group",
          id: "g1",
          tag: "{name}_extras",
          enabled: true,
          children: [{ kind: "block", blockId: "relevantMemories", enabled: true }]
        }
      ]
    };
    await writeJson(root, "user/waifus/yuki/waifu.json", {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision: 3,
      updatedAt: "2026-07-01T12:00:00.000Z",
      id: "yuki",
      name: "Yuki",
      displayName: "Yuki",
      enabled: true,
      persona: "kind",
      promptLayout: layout
    });

    const result = await runMigrations(root);
    expect(result.applied.filter((tag) => tag.startsWith("migrate-waifu-memories-to-mid"))).toEqual([]);
    const raw = await readJson<{
      promptLayout: { trailing: LayoutNode[] };
    }>(root, "user/waifus/yuki/waifu.json");
    expect(raw.promptLayout.trailing).toEqual(layout.trailing);
  });

  it("assigns legacy memories to guilds from stage-manager history", async () => {
    const root = await makeTempRoot();
    roots.push(root);

    await writeWaifuStub(root, "yuki");
    await writeJson(root, "user/memories.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-05-16T12:00:00.000Z",
      memories: [
        {
          id: "memory-1",
          waifuId: "yuki",
          scope: "global",
          content: "Kevin likes tea.",
          importance: 3,
          createdAt: "2026-05-16T12:00:00.000Z",
          updatedAt: "2026-05-16T12:00:00.000Z",
          sourceMessageIds: ["m1"],
          status: "active"
        },
        {
          id: "memory-2",
          waifuId: "yuki",
          scope: "user",
          content: "Ambiguous memory.",
          importance: 3,
          createdAt: "2026-05-16T12:00:00.000Z",
          updatedAt: "2026-05-16T12:00:00.000Z",
          sourceMessageIds: ["m2"],
          status: "active"
        }
      ]
    });
    await writeJson(root, "user/stage-manager/history.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-05-16T12:00:00.000Z",
      edits: [
        {
          id: "edit-1",
          guildId: "guild-2",
          channelId: "channel-1",
          tool: "add_memory",
          affectedMemoryIds: ["memory-1"],
          summary: "Kevin likes tea.",
          createdAt: "2026-05-16T12:00:00.000Z"
        }
      ]
    });
    await writeJson(root, "user/servers/guild-1/server.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-05-16T12:00:00.000Z",
      guildId: "guild-1"
    });
    await writeJson(root, "user/servers/guild-2/server.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-05-16T12:00:00.000Z",
      guildId: "guild-2"
    });

    const result = await runMigrations(root);

    expect(result.applied).toContain("migrate-memories-to-guild-scope");
    expect(result.applied).toContain("migrate-memory-store-v2");
    const store = await readJson<{ memories: Array<Record<string, unknown>> }>(root, "user/memories.json");
    // The guild-resolvable memory survives into the new unified shape.
    expect(store.memories).toHaveLength(1);
    expect(store.memories[0]).toMatchObject({
      id: "memory-1",
      guildId: "guild-2",
      waifuId: "yuki",
      source: "stage_manager",
      pinned: false,
      strength: 3,
      status: "active"
    });
    expect(store.memories[0]).not.toHaveProperty("scope");
    expect(store.memories[0]).not.toHaveProperty("importance");
    expect(store.memories[0]).not.toHaveProperty("permanent");
    // memory-2 had no resolvable guild → legacy step archived it without a guildId, so the V2
    // step drops it (the new schema requires a non-empty guildId).
    expect(store.memories.find((memory) => memory.id === "memory-2")).toBeUndefined();
  });

  it("assigns legacy memories to the only configured guild when history cannot infer one", async () => {
    const root = await makeTempRoot();
    roots.push(root);

    await writeWaifuStub(root, "yuki");
    await writeJson(root, "user/memories.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-05-16T12:00:00.000Z",
      memories: [
        {
          id: "memory-1",
          waifuId: "yuki",
          scope: "channel",
          content: "Kevin likes tea.",
          importance: 3,
          createdAt: "2026-05-16T12:00:00.000Z",
          updatedAt: "2026-05-16T12:00:00.000Z",
          sourceMessageIds: ["m1"],
          status: "active"
        }
      ]
    });
    await writeJson(root, "user/servers/guild-1/server.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-05-16T12:00:00.000Z",
      guildId: "guild-1"
    });

    await runMigrations(root);

    const store = await readJson<{ memories: Array<Record<string, unknown>> }>(root, "user/memories.json");
    expect(store.memories[0]).toMatchObject({
      guildId: "guild-1",
      waifuId: "yuki",
      source: "stage_manager",
      pinned: false,
      strength: 3,
      status: "active"
    });
    expect(store.memories[0]).not.toHaveProperty("scope");
  });

  it("archives active memories assigned to non-waifu ids", async () => {
    const root = await makeTempRoot();
    roots.push(root);

    await writeWaifuStub(root, "yuki");
    await writeJson(root, "user/memories.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-05-16T12:00:00.000Z",
      memories: [
        {
          id: "valid",
          waifuId: "yuki",
          scope: "guild",
          guildId: "guild-1",
          content: "Yuki remembers Kevin likes tea.",
          importance: 3,
          createdAt: "2026-05-16T12:00:00.000Z",
          updatedAt: "2026-05-16T12:00:00.000Z",
          sourceMessageIds: [],
          status: "active"
        },
        {
          id: "invalid-user",
          waifuId: "K",
          scope: "guild",
          guildId: "guild-1",
          content: "K is a user, not a waifu.",
          importance: 3,
          createdAt: "2026-05-16T12:00:00.000Z",
          updatedAt: "2026-05-16T12:00:00.000Z",
          sourceMessageIds: [],
          status: "active"
        }
      ]
    });

    const result = await runMigrations(root);

    expect(result.applied).toContain("archive-memories-with-unknown-waifus");
    const store = await readJson<{ memories: Array<Record<string, unknown>> }>(root, "user/memories.json");
    expect(store.memories.find((memory) => memory.id === "valid")).toMatchObject({ status: "active" });
    expect(store.memories.find((memory) => memory.id === "invalid-user")).toMatchObject({ status: "archived" });
  });

  it("migrates the two-store memory model into one unified MemoryRecord store (W3)", async () => {
    const root = await makeTempRoot();
    roots.push(root);

    await writeWaifuStub(root, "yuki");
    await writeJson(root, "user/servers/guild-1/server.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-05-16T12:00:00.000Z",
      guildId: "guild-1"
    });
    await writeJson(root, "user/memories.json", {
      schemaVersion: 1,
      revision: 4,
      updatedAt: "2026-05-16T12:00:00.000Z",
      memories: [
        {
          id: "perm-1",
          waifuId: "yuki",
          scope: "guild",
          guildId: "guild-1",
          content: "Yuki knows Kevin is allergic to peanuts.",
          importance: 5,
          permanent: true,
          createdAt: "2026-05-16T12:00:00.000Z",
          updatedAt: "2026-05-16T12:00:00.000Z",
          sourceMessageIds: ["m1"],
          status: "active"
        },
        {
          id: "lib-1",
          waifuId: "yuki",
          scope: "guild",
          guildId: "guild-1",
          content: "Kevin enjoys green tea.",
          importance: 3,
          permanent: false,
          createdAt: "2026-05-16T12:00:00.000Z",
          updatedAt: "2026-05-16T12:00:00.000Z",
          sourceMessageIds: [],
          status: "active"
        }
      ]
    });
    await writeJson(root, "user/short-term-memories.json", {
      schemaVersion: 1,
      revision: 2,
      updatedAt: "2026-05-16T12:00:00.000Z",
      entries: [
        {
          id: "note-1",
          guildId: "guild-1",
          channelId: "channel-1",
          waifuId: "yuki",
          content: "Kevin said he is leaving at 5pm.",
          createdAt: "2026-05-16T12:00:00.000Z",
          expiresAt: "2026-05-17T12:00:00.000Z"
        }
      ]
    });

    const result = await runMigrations(root);
    expect(result.applied).toContain("migrate-memory-store-v2");

    const store = await readJson<{ memories: Array<Record<string, unknown>> }>(root, "user/memories.json");
    expect(store.memories).toHaveLength(3);

    const perm = store.memories.find((memory) => memory.id === "perm-1");
    expect(perm).toMatchObject({
      pinned: true,
      strength: 5,
      source: "user",
      kind: "fact",
      status: "active"
    });
    expect(perm).not.toHaveProperty("importance");
    expect(perm).not.toHaveProperty("permanent");
    expect(perm).not.toHaveProperty("scope");
    expect(perm).not.toHaveProperty("sourceMessageIds");
    expect(Array.isArray(perm?.entities)).toBe(true);
    expect(perm?.entities).toContain("Kevin");

    const lib = store.memories.find((memory) => memory.id === "lib-1");
    expect(lib).toMatchObject({ pinned: false, strength: 3, source: "stage_manager" });

    const note = store.memories.find((memory) => memory.id === "note-1");
    expect(note).toMatchObject({
      source: "waifu_tool",
      kind: "context",
      strength: 2,
      pinned: false,
      channelId: "channel-1",
      expiresAt: "2026-05-17T12:00:00.000Z"
    });

    // Short-term file removed after merge.
    await expect(readFile(path.join(root, "user/short-term-memories.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });

    // Idempotent: a second run does not re-apply.
    const second = await runMigrations(root);
    expect(second.applied).not.toContain("migrate-memory-store-v2");
    const after = await readJson<{ memories: Array<Record<string, unknown>> }>(root, "user/memories.json");
    expect(after.memories).toHaveLength(3);
  });

  it("leaves an already-unified memory store untouched (W3 idempotency)", async () => {
    const root = await makeTempRoot();
    roots.push(root);

    await writeWaifuStub(root, "yuki");
    // Already at the current schema version — the byte-equality assertion below only holds if
    // nothing (including the schemaVersion stamp step) has a reason to touch this file.
    await writeJson(root, "user/memories.json", {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision: 7,
      updatedAt: "2026-06-12T12:00:00.000Z",
      memories: [
        {
          id: "new-1",
          guildId: "guild-1",
          waifuId: "yuki",
          content: "Kevin enjoys green tea.",
          kind: "preference",
          source: "stage_manager",
          pinned: false,
          strength: 3,
          entities: ["Kevin"],
          createdAt: "2026-06-12T12:00:00.000Z",
          updatedAt: "2026-06-12T12:00:00.000Z",
          status: "active"
        }
      ]
    });

    const before = await readFile(path.join(root, "user/memories.json"), "utf8");
    const result = await runMigrations(root);
    const afterRaw = await readFile(path.join(root, "user/memories.json"), "utf8");

    expect(result.applied).not.toContain("migrate-memory-store-v2");
    expect(afterRaw).toEqual(before);
  });

  it("removes legacy guild-wide active participant caches", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const legacyPath = "user/servers/guild-1/active-chat-participants.json";
    await writeJson(root, legacyPath, {
      schemaVersion: 1,
      revision: 2,
      updatedAt: "2026-06-07T12:00:00.000Z",
      guildId: "guild-1",
      participants: [
        {
          userId: "u1",
          displayName: "Kevin",
          lastSeenAt: "2026-06-07T12:00:00.000Z",
          expiresAt: "2026-06-14T12:00:00.000Z"
        }
      ]
    });

    const first = await runMigrations(root);
    expect(first.applied).toContain("remove-guild-wide-active-participants-1");
    await expect(readFile(path.join(root, legacyPath), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const second = await runMigrations(root);
    expect(second.applied).not.toContain("remove-guild-wide-active-participants-1");
  });

  it("leaves a waifu whose promptLayout is already the W2 default unchanged", async () => {
    const root = await makeTempRoot();
    roots.push(root);

    const layout = defaultWaifuPromptLayout();
    await writeJson(root, "user/waifus/yuki/waifu.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-05-16T12:00:00.000Z",
      id: "yuki",
      name: "Yuki",
      displayName: "Yuki",
      persona: "kind",
      promptLayout: layout
    });

    const before = await readJson<{ promptLayout: unknown }>(root, "user/waifus/yuki/waifu.json");
    const result = await runMigrations(root);
    const after = await readJson<{ promptLayout: unknown }>(root, "user/waifus/yuki/waifu.json");

    // The W2 migration must not have fired (no legacy block IDs present).
    expect(result.applied).not.toContain("migrate-waifu-prompt-layout-w2-1");
    // The stored layout must be byte-for-byte identical (deep equal).
    expect(after.promptLayout).toEqual(before.promptLayout);
  });
});

describe("schema v2 migration (§7.3)", () => {
  it("converts legacy reasoning/generation to gateway params, remaps retired model ids, leaves unknown ids in place, and stamps every file to schemaVersion 2", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const now = "2026-05-16T12:00:00.000Z";

    // Suppress prebuilt-waifu seeding so the only waifus in this fleet are the ones below.
    await writeJson(root, "user/waifus/.prebuilt-seed.json", {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      seededAt: now,
      waifuIds: []
    });

    await writeJson(root, "user/orchestrator/config.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: now,
      enabled: true,
      contextWindow: 20,
      prompt: "",
      reasoning: { effort: "medium" }
    });

    await writeJson(root, "user/waifus/haru/waifu.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: now,
      id: "haru",
      name: "Haru",
      displayName: "Haru",
      persona: "kind",
      generation: { temperature: 1.2 },
      reasoning: { enabled: false }
    });

    await writeJson(root, "user/waifus/sable/waifu.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: now,
      id: "sable",
      name: "Sable",
      displayName: "Sable",
      persona: "cool",
      providerId: "openai",
      modelId: "gpt-4o"
    });

    await writeJson(root, "user/waifus/quill/waifu.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: now,
      id: "quill",
      name: "Quill",
      displayName: "Quill",
      persona: "quiet",
      providerId: "openai",
      modelId: "bogus-model"
    });

    await writeJson(root, "user/providers.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: now,
      providers: {}
    });

    await writeJson(root, "user/discord-bots.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: now,
      orchestrator: null,
      waifus: []
    });

    await writeJson(root, "user/servers/guild-1/server.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: now,
      guildId: "guild-1"
    });

    await writeJson(root, "user/memories.json", {
      schemaVersion: 1,
      revision: 0,
      updatedAt: now,
      memories: [
        {
          id: "mem-1",
          guildId: "guild-1",
          waifuId: "haru",
          content: "Haru likes tea.",
          kind: "fact",
          source: "stage_manager",
          pinned: false,
          strength: 3,
          entities: [],
          createdAt: now,
          updatedAt: now,
          status: "active"
        }
      ]
    });

    const result = await runMigrations(root);
    expect(result.applied).toEqual(["migrate-configs-to-gateway-params", "stamp-schema-version-2"]);

    const orchestratorConfig = await readJson<Record<string, unknown>>(root, "user/orchestrator/config.json");
    expect(orchestratorConfig.params).toEqual({ "reasoning.effort": "medium" });
    expect(orchestratorConfig).not.toHaveProperty("reasoning");
    expect(orchestratorConfig).not.toHaveProperty("generation");
    expect(orchestratorConfig.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(() => AgentConfigSchema.parse(orchestratorConfig)).not.toThrow();

    const haru = await readJson<Record<string, unknown>>(root, "user/waifus/haru/waifu.json");
    expect(haru.params).toEqual({ temperature: 1.2, "reasoning.enabled": false });
    expect(haru).not.toHaveProperty("reasoning");
    expect(haru).not.toHaveProperty("generation");
    expect(haru.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(() => WaifuConfigSchema.parse(haru)).not.toThrow();

    const sable = await readJson<Record<string, unknown>>(root, "user/waifus/sable/waifu.json");
    expect(sable.providerId).toBe("openai");
    expect(sable.modelId).toBe("gpt-5-mini");
    expect(sable.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(() => WaifuConfigSchema.parse(sable)).not.toThrow();

    // Unknown model id: resolveModelTarget throws, so the migration must leave it untouched
    // rather than silently substituting something (waifus doctor warns about this in T5).
    const quill = await readJson<Record<string, unknown>>(root, "user/waifus/quill/waifu.json");
    expect(quill.providerId).toBe("openai");
    expect(quill.modelId).toBe("bogus-model");
    expect(quill.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(() => WaifuConfigSchema.parse(quill)).not.toThrow();

    const providers = await readJson<Record<string, unknown>>(root, "user/providers.json");
    expect(providers.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(() => ProviderCredentialsFileSchema.parse(providers)).not.toThrow();

    const discordBots = await readJson<Record<string, unknown>>(root, "user/discord-bots.json");
    expect(discordBots.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(() => DiscordBotsFileSchema.parse(discordBots)).not.toThrow();

    const server = await readJson<Record<string, unknown>>(root, "user/servers/guild-1/server.json");
    expect(server.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(() => ServerConfigSchema.parse(server)).not.toThrow();

    const memories = await readJson<Record<string, unknown>>(root, "user/memories.json");
    expect(memories.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(() => MemoryStoreSchema.parse(memories)).not.toThrow();

    const second = await runMigrations(root);
    expect(second.applied).toEqual([]);
  });

  it("migrates the root TOML app config's schemaVersion so loadAppConfig does not throw on the next boot", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await writeFile(
      path.join(root, "config.toml"),
      'schemaVersion = 1\n\n[http]\nhost = "127.0.0.1"\nport = 3888\n',
      "utf8"
    );

    const result = await runMigrations(root);
    expect(result.applied).toContain("stamp-schema-version-2");

    const raw = await readFile(path.join(root, "config.toml"), "utf8");
    expect(raw).toMatch(/schemaVersion\s*=\s*2/);

    const config = await loadAppConfig(root);
    expect(config.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(config.http.port).toBe(3888);

    const second = await runMigrations(root);
    expect(second.applied).not.toContain("stamp-schema-version-2");
  });

  it("migrates a stale app/runtime.json left over from a prior boot", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await writeJson(root, "app/runtime.json", {
      schemaVersion: 1,
      pid: 12345,
      startedAt: "2026-05-16T12:00:00.000Z",
      updatedAt: "2026-05-16T12:00:00.000Z",
      packageVersion: "1.0.0",
      port: 3888,
      dataRoot: root,
      mode: "start"
    });

    const result = await runMigrations(root);
    expect(result.applied).toContain("stamp-schema-version-2");

    const runtime = await readJson<Record<string, unknown>>(root, "app/runtime.json");
    expect(runtime.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(() => RuntimeStateSchema.parse(runtime)).not.toThrow();
  });

  it("does not crash on boot when the prebuilt-waifu seed marker predates the schema bump, and does not reseed over existing waifus", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await writeWaifuStub(root, "yuki");
    await writeJson(root, "user/waifus/.prebuilt-seed.json", {
      schemaVersion: 1,
      seededAt: "2026-05-16T12:00:00.000Z",
      waifuIds: ["lumi", "nox", "mira", "riko"]
    });

    await expect(runMigrations(root)).resolves.toMatchObject({ applied: expect.any(Array) });

    // The stale marker must still be honored as "already seeded" — prebuilt waifus must not be
    // (re)written over whatever the user already has configured.
    await expect(readFile(path.join(root, "user/waifus/lumi/waifu.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });

    const marker = await readJson<Record<string, unknown>>(root, "user/waifus/.prebuilt-seed.json");
    expect(marker.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

async function writeJson(root: string, relativePath: string, value: unknown): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeWaifuStub(root: string, id: string): Promise<void> {
  await writeJson(root, `user/waifus/${id}/waifu.json`, { id });
}

async function readJson<T>(root: string, relativePath: string): Promise<T> {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8")) as T;
}
