import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/backend/migrations.js";
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
      "migrate-scheduled-retrigger-at-1"
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
          replyStyle: "normal",
          sceneDirection: "answer Kevin",
          replyToMessageId: "message-1"
        }
      ]
    });
    expect(history.decisions[0]).not.toHaveProperty("steps");
    expect(history.decisions[0]).not.toHaveProperty("idleTrigger");
    expect(history.decisions[0]).not.toHaveProperty("retriggerAfterSeconds");
    expect(history.decisions[1]).toMatchObject({
      id: "short-no-reply",
      action: "no_reply",
      respondingWaifus: [],
      retriggerAfterSeconds: 100
    });

    const config = await readJson<{ promptSections: Record<string, unknown> }>(
      root,
      "user/orchestrator/config.json"
    );
    expect(config.promptSections).toMatchObject({ retriggerPacing: false });
    expect(config.promptSections).not.toHaveProperty("idleTriggerPacing");

    const session = await readJson<Record<string, unknown>>(root, "user/servers/guild-1/sessions/channel-1.json");
    expect(session.scheduledRetriggerAt).toBe("2026-05-16T12:30:00.000Z");
    expect(session).not.toHaveProperty("scheduledIdleTriggerAt");
    expect(session).not.toHaveProperty("cachedWaifuContinuation");
  });

  it("assigns legacy memories to guilds from stage-manager history", async () => {
    const root = await makeTempRoot();
    roots.push(root);

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
    const store = await readJson<{ memories: Array<Record<string, unknown>> }>(root, "user/memories.json");
    expect(store.memories[0]).toMatchObject({
      scope: "guild",
      guildId: "guild-2",
      status: "active"
    });
    expect(store.memories[1]).toMatchObject({
      scope: "guild",
      status: "archived"
    });
    expect(store.memories[1]).not.toHaveProperty("guildId");
  });

  it("assigns legacy memories to the only configured guild when history cannot infer one", async () => {
    const root = await makeTempRoot();
    roots.push(root);

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
      scope: "guild",
      guildId: "guild-1",
      status: "active"
    });
  });
});

async function writeJson(root: string, relativePath: string, value: unknown): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T>(root: string, relativePath: string): Promise<T> {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8")) as T;
}
