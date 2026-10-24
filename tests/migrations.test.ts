import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATION_STEPS, runMigrations } from "../src/backend/migrations.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { loadAppConfig } from "../src/config/appConfig.js";
import { RuntimeStateSchema } from "../src/backend/runtime.js";
import { CURRENT_SCHEMA_VERSION } from "../src/shared/schemas/common.js";
import {
  AgentConfigSchema,
  DiscordBotsFileSchema,
  MemoryStoreSchema,
  ProviderCredentialsFileSchema,
  ServerConfigSchema,
  WaifuConfigSchema
} from "../src/shared/schemas/domain.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";
import {
  RemoteAccessInstallationStateV1Schema,
  RemoteAccessTrustIndexV1Schema
} from "../src/shared/schemas/remoteAccess.js";
import { remoteStatePaths } from "../src/remote/paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => removeTempRoot(root)));
  roots.length = 0;
});

describe("runMigrations", () => {
  it("hardens remote state idempotently without rotating identity or lowering trust epochs", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const paths = remoteStatePaths(root);
    const installationBefore = await readFile(paths.installation, "utf8");
    const pairId = Buffer.alloc(16, 0x62).toString("base64url");
    await writeFile(paths.trustIndex, `${JSON.stringify({
      version: 1,
      trustEpochHighWater: "9007199254740993",
      resetTombstone: "4",
      pairs: [{ deviceId: "travel-mac", pairId, trustEpoch: "9007199254740993" }]
    }, null, 2)}\n`, "utf8");
    for (const filePath of [paths.hostConfig, paths.installation, paths.trustIndex]) {
      await chmod(filePath, 0o644);
    }

    const first = await runMigrations(root);
    expect(first.applied).toContain("harden-remote-access-state-v1");
    expect(await readFile(paths.installation, "utf8")).toBe(installationBefore);
    expect(() => RemoteAccessInstallationStateV1Schema.parse(JSON.parse(installationBefore))).not.toThrow();
    expect(RemoteAccessTrustIndexV1Schema.parse(
      JSON.parse(await readFile(paths.trustIndex, "utf8"))
    )).toMatchObject({
      trustEpochHighWater: "9007199254740993",
      resetTombstone: "4"
    });
    for (const filePath of [paths.hostConfig, paths.installation, paths.trustIndex]) {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }

    const second = await runMigrations(root);
    expect(second.applied).not.toContain("harden-remote-access-state-v1");
    expect(await readFile(paths.installation, "utf8")).toBe(installationBefore);
  });

  it("fails closed on invalid remote state instead of replacing identity or epochs", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const paths = remoteStatePaths(root);
    const installationBefore = await readFile(paths.installation, "utf8");
    await writeFile(paths.trustIndex, `${JSON.stringify({
      version: 1,
      trustEpochHighWater: "7",
      resetTombstone: "0",
      pairs: [{
        deviceId: "travel-mac",
        pairId: Buffer.alloc(16, 0x63).toString("base64url"),
        trustEpoch: "8"
      }]
    })}\n`, "utf8");

    await expect(runMigrations(root)).rejects.toThrow(/high-water/u);
    expect(await readFile(paths.installation, "utf8")).toBe(installationBefore);
  });

  it("rejects symlinked preserved remote state without touching its external target", async () => {
    const root = await makeTempRoot();
    const outside = await makeTempRoot();
    roots.push(root, outside);
    await ensureDataLayout(root);
    const paths = remoteStatePaths(root);
    const externalTarget = path.join(outside, "external-trust.json");
    const externalBytes = "external-target-must-not-change\n";
    await writeFile(externalTarget, externalBytes, "utf8");
    await rm(paths.trustIndex);
    await symlink(externalTarget, paths.trustIndex);

    await expect(runMigrations(root)).rejects.toThrow(/owned regular file/u);
    expect(await readFile(externalTarget, "utf8")).toBe(externalBytes);
  });
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
      // floor is 10s since 1.5.189 — a legacy 60s trigger is now within range and preserved
      retriggerAfterSeconds: 60,
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

  // The legacy layout steps (waifu-prompt-sections-to-layout, waifu-prompt-layout-w2,
  // waifu-memories-to-mid) are gone (spec 8.6); waifu-drop-prompt-layout-v1 takes every legacy
  // shape straight to the final one.
  it("drops legacy flat prompt-section toggles, keeping a disabled schedule as scheduleInPrompt: false", async () => {
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
      promptSections: { directorNotes: true, hardRules: false, schedule: false, personality: false }
    });

    const result = await runMigrations(root);
    expect(result.applied).toContain("waifu-drop-prompt-layout-1");
    const raw = await readJson<Record<string, unknown>>(root, "user/waifus/yuki/waifu.json");
    expect(raw).not.toHaveProperty("promptSections");
    expect(raw).not.toHaveProperty("promptLayout");
    expect(raw.scheduleInPrompt).toBe(false);
    expect(WaifuConfigSchema.parse(raw).scheduleInPrompt).toBe(false);
  });

  it("drops a W1 layout tree; a schedule disabled inside a group survives as scheduleInPrompt: false", async () => {
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
      promptLayout: {
        top: [
          { kind: "block", blockId: "identity", enabled: true },
          {
            kind: "group",
            id: "behavior",
            tag: "{name}_behavior",
            enabled: true,
            children: [
              { kind: "block", blockId: "personality", enabled: true },
              { kind: "block", blockId: "schedule", enabled: false },
              { kind: "block", blockId: "hardRules", enabled: true }
            ]
          }
        ],
        mid: [{ kind: "block", blockId: "activeParticipants", enabled: true }],
        trailing: [{ kind: "block", blockId: "relevantMemories", enabled: true }]
      }
    });

    await runMigrations(root);
    const raw = await readJson<Record<string, unknown>>(root, "user/waifus/yuki/waifu.json");
    expect(raw).not.toHaveProperty("promptLayout");
    expect(raw.scheduleInPrompt).toBe(false);
  });

  it("drops a W2 layout with everything enabled and leaves scheduleInPrompt at its default", async () => {
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
        top: [{ kind: "block", blockId: "identity", enabled: true }, { kind: "block", blockId: "schedule", enabled: true }],
        mid: [{ kind: "block", blockId: "roomInfo", enabled: true }],
        trailing: [{ kind: "block", blockId: "relevantMemories", enabled: false }]
      }
    });

    const first = await runMigrations(root);
    expect(first.applied).toContain("waifu-drop-prompt-layout-1");
    const raw = await readJson<Record<string, unknown>>(root, "user/waifus/yuki/waifu.json");
    expect(raw).not.toHaveProperty("promptLayout");
    expect(raw).not.toHaveProperty("scheduleInPrompt");
    expect(WaifuConfigSchema.parse(raw).scheduleInPrompt).toBe(true);

    // Idempotent: a second run finds nothing to drop.
    const second = await runMigrations(root);
    expect(second.applied.filter((tag) => tag.startsWith("waifu-drop-prompt-layout"))).toEqual([]);
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
    // The guild-resolvable memory survives into the new unified (Phase 4: global) shape.
    expect(store.memories).toHaveLength(2);
    expect(store.memories[0]).toMatchObject({
      id: "memory-1",
      origin: { guildId: "guild-2" },
      waifuId: "yuki",
      source: "stage_manager",
      pinned: false,
      strength: 3,
      status: "active"
    });
    expect(store.memories[0]).not.toHaveProperty("scope");
    expect(store.memories[0]).not.toHaveProperty("importance");
    expect(store.memories[0]).not.toHaveProperty("permanent");
    // memory-2 had no resolvable guild: Phase 4 keeps it active with an empty origin (memories
    // are global; the guild was provenance only).
    expect(store.memories.find((memory) => memory.id === "memory-2")).toMatchObject({ status: "active", origin: {} });
    expect(store.memories[0]).not.toHaveProperty("guildId");
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
      origin: { guildId: "guild-1" },
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

    // A Phase 4 record of a deleted waifu is archived with a reason and a revision bump.
    const phase4 = await readJson<{ memories: Array<Record<string, unknown>> }>(root, "user/memories.json");
    phase4.memories.push({
      id: "gone", waifuId: "deleted-waifu", content: "x", kind: "fact", source: "user", pinned: false, strength: 3,
      origin: {}, subjects: [], revision: 2, createdAt: "2026-05-16T12:00:00.000Z", updatedAt: "2026-05-16T12:00:00.000Z", status: "active"
    });
    await writeJson(root, "user/memories.json", phase4);
    await runMigrations(root);
    const after = await readJson<{ memories: Array<Record<string, unknown>> }>(root, "user/memories.json");
    expect(after.memories.find((memory) => memory.id === "gone")).toMatchObject({
      status: "archived",
      archivedReason: "unknown_waifu",
      revision: 3
    });
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
    // Legacy entities became subjects only where they resolve; none of these names do.
    expect(perm).not.toHaveProperty("entities");
    expect(perm?.subjects).toEqual([]);

    const lib = store.memories.find((memory) => memory.id === "lib-1");
    expect(lib).toMatchObject({ pinned: false, strength: 3, source: "stage_manager" });

    const note = store.memories.find((memory) => memory.id === "note-1");
    expect(note).toMatchObject({
      source: "waifu_tool",
      kind: "context",
      strength: 2,
      pinned: false,
      origin: { guildId: "guild-1", channelId: "channel-1" },
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
          waifuId: "yuki",
          content: "Kevin enjoys green tea.",
          kind: "preference",
          source: "stage_manager",
          pinned: false,
          strength: 3,
          origin: { guildId: "guild-1" },
          subjects: [{ discordUserId: "111", name: "Kevin" }],
          revision: 0,
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
    expect(result.applied).toEqual([
      "migrate-configs-to-gateway-params",
      "migrate-memories-global-origin-subjects-1",
      "stamp-schema-version-2"
    ]);

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

describe("discord bot enabled upgrade", () => {
  function botsFile(orchestrator: Record<string, unknown> | null, waifus: Array<Record<string, unknown>>) {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision: 3,
      updatedAt: "2026-10-01T00:00:00.000Z",
      orchestrator,
      waifus
    };
  }

  it("defaults a bot without an enabled key to enabled", () => {
    const parsed = DiscordBotsFileSchema.parse(botsFile({ id: "orchestrator", displayName: "O", token: "t" }, []));
    expect(parsed.orchestrator?.enabled).toBe(true);
  });

  it("enables bots the old runtime logged in regardless of the flag, once", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    await writeJson(root, "user/discord-bots.json", botsFile(
      { id: "orchestrator", displayName: "O", token: "orchestrator-token", enabled: false },
      [
        { id: "aria", displayName: "Aria", token: "aria-token" },
        { id: "riko", displayName: "Riko", token: "riko-token", enabled: false },
        { id: "nox", displayName: "Nox", enabled: false }
      ]
    ));

    const first = await runMigrations(root);

    expect(first.applied).toContain("enable-discord-bots-v1");
    const migrated = await readJson<ReturnType<typeof botsFile>>(root, "user/discord-bots.json");
    expect(migrated.orchestrator).toMatchObject({ enabled: true, token: "orchestrator-token" });
    expect(migrated.waifus.map((bot) => [bot.id, bot.enabled])).toEqual([
      ["aria", true],
      ["riko", true],
      // No token: the old runtime never logged it in either, so the explicit flag stays.
      ["nox", false]
    ]);
    expect(() => DiscordBotsFileSchema.parse(migrated)).not.toThrow();

    // A later explicit disable sticks: the one-time pass does not run again.
    await writeJson(root, "user/discord-bots.json", {
      ...migrated,
      waifus: migrated.waifus.map((bot) => (bot.id === "riko" ? { ...bot, enabled: false } : bot))
    });
    const second = await runMigrations(root);

    expect(second.applied).not.toContain("enable-discord-bots-v1");
    const after = await readJson<ReturnType<typeof botsFile>>(root, "user/discord-bots.json");
    expect(after.waifus.find((bot) => bot.id === "riko")?.enabled).toBe(false);
  });

  it("still fills a missing enabled key after the one-time pass", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    await runMigrations(root);
    await writeJson(root, "user/discord-bots.json", botsFile(null, [
      { id: "aria", displayName: "Aria", token: "aria-token" },
      { id: "riko", displayName: "Riko", token: "riko-token", enabled: false }
    ]));

    await runMigrations(root);

    const after = await readJson<ReturnType<typeof botsFile>>(root, "user/discord-bots.json");
    expect(after.waifus.map((bot) => [bot.id, bot.enabled])).toEqual([["aria", true], ["riko", false]]);
  });
});

describe("migration ledger", () => {
  const LEDGER = "app/migrations.json";
  const LEGACY_PARTICIPANTS = "user/servers/guild-1/active-chat-participants.json";

  type Ledger = { ledgerVersion: number; appVersion: string; steps: Record<string, { appVersion: string }> };

  async function writeLegacyParticipants(root: string): Promise<void> {
    await writeJson(root, LEGACY_PARTICIPANTS, { schemaVersion: CURRENT_SCHEMA_VERSION, guildId: "guild-1" });
  }

  async function exists(root: string, relativePath: string): Promise<boolean> {
    return stat(path.join(root, relativePath)).then(() => true, () => false);
  }

  async function freshRoot(): Promise<string> {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    return root;
  }

  it("records completed steps with the app version and skips them on later boots", async () => {
    const root = await freshRoot();
    await runMigrations(root, { appVersion: "2.200.0" });

    const ledger = await readJson<Ledger>(root, LEDGER);
    expect(ledger).toMatchObject({ ledgerVersion: 1, appVersion: "2.200.0" });
    expect(Object.keys(ledger.steps)).toEqual(expect.arrayContaining([
      "remove-guild-wide-active-participants",
      "memory-store-v2",
      "configs-to-gateway-params",
      `stamp-schema-version-${CURRENT_SCHEMA_VERSION}`
    ]));
    // Every-boot checks/housekeeping are never recorded.
    expect(ledger.steps["harden-remote-access-state-v1"]).toBeUndefined();
    expect(ledger.steps["archive-memories-with-unknown-waifus"]).toBeUndefined();
    expect(ledger.steps["enable-discord-bots-v1"]).toBeUndefined();

    // Legacy data that appears after the step was recorded is no longer scanned for.
    await writeLegacyParticipants(root);
    const second = await runMigrations(root, { appVersion: "2.200.0" });
    expect(second.applied).toEqual([]);
    expect(await exists(root, LEGACY_PARTICIPANTS)).toBe(true);
  });

  it("keeps ids of removed steps (the legacy prompt-layout steps) as history and boots normally", async () => {
    const root = await freshRoot();
    const removed = ["waifu-prompt-sections-to-layout", "waifu-prompt-layout-w2", "waifu-memories-to-mid"];
    await writeJson(root, LEDGER, {
      ledgerVersion: 1,
      appVersion: "2.200.0",
      updatedAt: "2026-10-01T00:00:00.000Z",
      steps: Object.fromEntries(removed.map((id) => [id, { appliedAt: "2026-10-01T00:00:00.000Z", appVersion: "2.200.0" }]))
    });
    expect(MIGRATION_STEPS.some((step) => removed.includes(step.id))).toBe(false);

    await runMigrations(root, { appVersion: "2.200.0" });
    const ledger = await readJson<Ledger>(root, LEDGER);
    for (const id of removed) expect(ledger.steps[id], id).toBeDefined();
    expect(ledger.steps["waifu-drop-prompt-layout-v1"]).toBeDefined();
    // Re-running every migration is a no-op.
    expect((await runMigrations(root, { appVersion: "2.200.0" })).applied).toEqual([]);
  });

  it("keeps running every-boot steps when the ledger is complete", async () => {
    const root = await freshRoot();
    await runMigrations(root, { appVersion: "2.200.0" });
    await writeJson(root, "user/memories.json", {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision: 0,
      updatedAt: "2026-10-01T00:00:00.000Z",
      memories: [{ id: "orphan", waifuId: "deleted-waifu", status: "active" }]
    });

    const result = await runMigrations(root, { appVersion: "2.200.0" });

    expect(result.applied).toEqual(["archive-memories-with-unknown-waifus"]);
    const store = await readJson<{ memories: Array<Record<string, unknown>> }>(root, "user/memories.json");
    expect(store.memories[0]).toMatchObject({ status: "archived" });
  });

  describe("Phase 4 steps", () => {
    // `waifu-params-gateway-040-v1` is checked in tests/waifuParamsGateway040.test.ts.
    const PHASE4_STEP_IDS = [
      "waifu-drop-prompt-layout-v1",
      "server-context-windows-explicit-v1",
      "memories-global-origin-subjects-v1",
      "memories-cross-guild-dedupe-v1",
      "pending-observations-global-v1",
      "dream-cursor-global-v1",
      "ocr-cache-url-keys-cleanup-v1",
      "ocr-cache-ttl-168-v1"
    ];

    it("registers the Phase 4 steps in spec order, before the schema-version stamp", () => {
      const ids = MIGRATION_STEPS.map((step) => step.id);
      const positions = PHASE4_STEP_IDS.map((id) => ids.indexOf(id));
      expect(positions.every((index) => index >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(positions[0]).toBeGreaterThan(ids.indexOf("waifu-params-gateway-040-v1"));
      expect(ids.indexOf("waifu-params-gateway-040-v1")).toBe(ids.indexOf("configs-to-gateway-params") + 1);
      expect(positions[positions.length - 1]).toBeLessThan(ids.indexOf(`stamp-schema-version-${CURRENT_SCHEMA_VERSION}`));
      expect(ids.at(-1)).toBe(`stamp-schema-version-${CURRENT_SCHEMA_VERSION}`);
      for (const id of PHASE4_STEP_IDS) expect(MIGRATION_STEPS.find((step) => step.id === id)!.frequency, id).toBe("once");
      expect(MIGRATION_STEPS.find((step) => step.id === "waifu-params-gateway-040-v1")!.frequency).toBe(
        "once-per-app-version"
      );
    });

    it("the real boot runs and records every Phase 4 step", async () => {
      const root = await freshRoot();
      await expect(runMigrations(root, { appVersion: "2.200.0" })).resolves.toBeDefined();
      const ledger = await readJson<Ledger>(root, LEDGER);
      for (const id of PHASE4_STEP_IDS) expect(ledger.steps[id], id).toBeDefined();
      expect(ledger.steps["configs-to-gateway-params"]).toBeDefined();
      expect(ledger.steps[`stamp-schema-version-${CURRENT_SCHEMA_VERSION}`]).toBeDefined();
    });
  });

  describe("server-context-windows-explicit-v1", () => {
    const step = () => MIGRATION_STEPS.find((candidate) => candidate.id === "server-context-windows-explicit-v1")!;

    it("drops keys equal to the old defaults and keeps explicit overrides", async () => {
      const root = await freshRoot();
      await writeJson(root, "user/servers/111/server.json", {
        guildId: "111",
        contextWindows: { orchestrator: 20, waifu: 50, stageManager: 80 }
      });
      await writeJson(root, "user/servers/222/server.json", {
        guildId: "222",
        name: "Bake Club",
        contextWindows: { orchestrator: 35, waifu: 50, stageManager: 120 }
      });
      await writeJson(root, "user/servers/333/server.json", { guildId: "333", contextWindows: { waifu: 64 } });

      expect(await step().run(root)).toBe("server-context-windows-explicit-2");

      expect((await readJson<Record<string, unknown>>(root, "user/servers/111/server.json")).contextWindows).toEqual({});
      expect(await readJson<Record<string, unknown>>(root, "user/servers/222/server.json")).toEqual({
        guildId: "222",
        name: "Bake Club",
        contextWindows: { orchestrator: 35, stageManager: 120 }
      });
      expect((await readJson<Record<string, unknown>>(root, "user/servers/333/server.json")).contextWindows).toEqual({ waifu: 64 });
    });

    it("is idempotent and tolerates missing roots, missing keys and unparsable files", async () => {
      const empty = await freshRoot();
      expect(await step().run(empty)).toBeUndefined();

      const root = await freshRoot();
      await writeJson(root, "user/servers/111/server.json", { guildId: "111", contextWindows: { orchestrator: 20, waifu: 7 } });
      await writeJson(root, "user/servers/222/server.json", { guildId: "222" });
      await mkdir(path.join(root, "user/servers/333"), { recursive: true });
      await writeFile(path.join(root, "user/servers/333/server.json"), "{ not json", "utf8");

      expect(await step().run(root)).toBe("server-context-windows-explicit-1");
      const once = await readFile(path.join(root, "user/servers/111/server.json"), "utf8");
      expect(JSON.parse(once).contextWindows).toEqual({ waifu: 7 });

      expect(await step().run(root)).toBeUndefined();
      expect(await readFile(path.join(root, "user/servers/111/server.json"), "utf8")).toBe(once);
      expect(await readJson<Record<string, unknown>>(root, "user/servers/222/server.json")).toEqual({ guildId: "222" });
      expect(await readFile(path.join(root, "user/servers/333/server.json"), "utf8")).toBe("{ not json");
    });
  });

  it("ocr-cache-url-keys-cleanup-v1 removes the URL-keyed OCR results and keeps results-v2", async () => {
    const root = await freshRoot();
    await writeJson(root, "app/cache/ocr/results/abc.json", { schemaVersion: 1, text: "old" });
    await writeJson(root, "app/cache/ocr/results-v2/def.json", { schemaVersion: 1, text: "new" });
    const step = MIGRATION_STEPS.find((candidate) => candidate.id === "ocr-cache-url-keys-cleanup-v1")!;

    expect(await step.run(root)).toBe("ocr-cache-url-keys-cleanup-v1");
    expect(await exists(root, "app/cache/ocr/results")).toBe(false);
    expect(await exists(root, "app/cache/ocr/results-v2/def.json")).toBe(true);
    // Idempotent: nothing left to remove.
    expect(await step.run(root)).toBeUndefined();
  });

  // Acceptance M5: saved configs spell out the old 24h OCR cache TTL, so the new 168h default never
  // applied to them.
  describe("ocr-cache-ttl-168-v1", () => {
    const step = () => MIGRATION_STEPS.find((candidate) => candidate.id === "ocr-cache-ttl-168-v1")!;
    const writeConfig = (root: string, ttl: number) =>
      writeFile(
        path.join(root, "config.toml"),
        `schemaVersion = 2\n\n[http]\nhost = "127.0.0.1"\nport = 3999\n\n[ocr]\nenabled = true\ncacheTtlHours = ${ttl}\ntimeoutMs = 2000\n`,
        "utf8"
      );

    it("is a once step registered before the schema-version stamp", () => {
      const ids = MIGRATION_STEPS.map((candidate) => candidate.id);
      expect(step().frequency).toBe("once");
      expect(ids.indexOf("ocr-cache-ttl-168-v1")).toBeLessThan(ids.indexOf(`stamp-schema-version-${CURRENT_SCHEMA_VERSION}`));
    });

    it("rewrites exactly 24 to 168, keeps the rest of the config, and is idempotent", async () => {
      const root = await freshRoot();
      await writeConfig(root, 24);
      expect(await step().run(root)).toBe("ocr-cache-ttl-168-v1");
      const config = await loadAppConfig(root);
      expect(config.ocr).toMatchObject({ cacheTtlHours: 168, timeoutMs: 2000, enabled: true });
      expect(config.http.port).toBe(3999);
      const once = await readFile(path.join(root, "config.toml"), "utf8");
      expect(await step().run(root)).toBeUndefined();
      expect(await readFile(path.join(root, "config.toml"), "utf8")).toBe(once);
    });

    it.each([12, 48, 168])("leaves an owner-chosen %ih alone", async (ttl) => {
      const root = await freshRoot();
      await writeConfig(root, ttl);
      const before = await readFile(path.join(root, "config.toml"), "utf8");
      expect(await step().run(root)).toBeUndefined();
      expect(await readFile(path.join(root, "config.toml"), "utf8")).toBe(before);
    });

    it("tolerates a missing config, a config without [ocr] and an unparsable config", async () => {
      const root = await freshRoot();
      await rm(path.join(root, "config.toml"));
      expect(await step().run(root)).toBeUndefined();
      await writeFile(path.join(root, "config.toml"), "schemaVersion = 2\n", "utf8");
      expect(await step().run(root)).toBeUndefined();
      await writeFile(path.join(root, "config.toml"), "[ocr\ncacheTtlHours = 24", "utf8");
      expect(await step().run(root)).toBeUndefined();
    });

    it("runs on boot", async () => {
      const root = await freshRoot();
      await writeConfig(root, 24);
      expect((await runMigrations(root, { appVersion: "2.200.0" })).applied).toContain("ocr-cache-ttl-168-v1");
      expect((await loadAppConfig(root)).ocr.cacheTtlHours).toBe(168);
    });
  });

  it("runs a step missing from the ledger and records it, leaving recorded steps skipped", async () => {
    const root = await freshRoot();
    await runMigrations(root, { appVersion: "2.200.0" });
    const ledger = await readJson<Ledger>(root, LEDGER);
    delete ledger.steps["remove-guild-wide-active-participants"];
    await writeJson(root, LEDGER, ledger);
    await writeLegacyParticipants(root);
    // A legacy session file belongs to a step that is still recorded, so it must stay untouched.
    const sessionPath = "user/servers/guild-1/sessions/channel-1.json";
    await writeJson(root, sessionPath, { scheduledIdleTriggerAt: "2026-10-01T00:00:00.000Z" });

    const result = await runMigrations(root, { appVersion: "2.200.0" });

    expect(result.applied).toEqual(["remove-guild-wide-active-participants-1"]);
    expect(await exists(root, LEGACY_PARTICIPANTS)).toBe(false);
    expect(await readJson<Record<string, unknown>>(root, sessionPath)).toHaveProperty("scheduledIdleTriggerAt");
    expect((await readJson<Ledger>(root, LEDGER)).steps["remove-guild-wide-active-participants"]).toMatchObject({
      appVersion: "2.200.0"
    });
  });

  it.each([
    ["unparseable JSON", "{not json"],
    ["an unknown shape", JSON.stringify({ ledgerVersion: 99, steps: [] })]
  ])("re-runs every step when the ledger is %s", async (_label, contents) => {
    const root = await freshRoot();
    await runMigrations(root, { appVersion: "2.200.0" });
    await writeFile(path.join(root, LEDGER), contents, "utf8");
    await writeLegacyParticipants(root);

    const result = await runMigrations(root, { appVersion: "2.200.0" });

    expect(result.applied).toContain("remove-guild-wide-active-participants-1");
    expect(await exists(root, LEGACY_PARTICIPANTS)).toBe(false);
    expect(await readJson<Ledger>(root, LEDGER)).toMatchObject({ ledgerVersion: 1, appVersion: "2.200.0" });
  });

  it("re-runs every step when a different app version ran the host after the ledger was written", async () => {
    const root = await freshRoot();
    await runMigrations(root, { appVersion: "2.200.0" });
    // A ledger-unaware older build booted in between (it rewrites app/runtime.json, not the ledger).
    await writeJson(root, "app/runtime.json", { schemaVersion: CURRENT_SCHEMA_VERSION, packageVersion: "2.111.2" });
    await writeLegacyParticipants(root);

    const result = await runMigrations(root, { appVersion: "2.200.0" });

    expect(result.applied).toContain("remove-guild-wide-active-participants-1");
    expect(await exists(root, LEGACY_PARTICIPANTS)).toBe(false);
  });

  it("re-runs once-per-app-version steps only after the app version changes", async () => {
    const root = await freshRoot();
    await runMigrations(root, { appVersion: "2.200.0" });
    const legacyWaifu = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision: 0,
      updatedAt: "2026-10-01T00:00:00.000Z",
      id: "haru",
      generation: { temperature: 1.2 }
    };
    await writeJson(root, "user/waifus/haru/waifu.json", legacyWaifu);

    const sameVersion = await runMigrations(root, { appVersion: "2.200.0" });
    expect(sameVersion.applied).not.toContain("migrate-configs-to-gateway-params");
    expect(await readJson<Record<string, unknown>>(root, "user/waifus/haru/waifu.json")).toHaveProperty("generation");

    const upgraded = await runMigrations(root, { appVersion: "2.200.1" });
    expect(upgraded.applied).toEqual(["migrate-configs-to-gateway-params"]);
    const waifu = await readJson<Record<string, unknown>>(root, "user/waifus/haru/waifu.json");
    expect(waifu).not.toHaveProperty("generation");
    expect(waifu.params).toMatchObject({ temperature: 1.2 });
    const ledger = await readJson<Ledger>(root, LEDGER);
    expect(ledger.appVersion).toBe("2.200.1");
    expect(ledger.steps["configs-to-gateway-params"].appVersion).toBe("2.200.1");
    // Once-only steps keep their original record.
    expect(ledger.steps["memory-store-v2"].appVersion).toBe("2.200.0");
  });

  it("records the steps that finished before a failing step", async () => {
    const root = await freshRoot();
    // An invalid trust index fails the first (every-boot) step closed; nothing else may run.
    await writeFile(remoteStatePaths(root).trustIndex, "{}", "utf8");
    await expect(runMigrations(root, { appVersion: "2.200.0" })).rejects.toThrow();
    const ledger = await readJson<Ledger>(root, LEDGER);
    expect(ledger.steps).toEqual({});
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
