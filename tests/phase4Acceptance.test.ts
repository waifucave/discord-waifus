// Phase 4 acceptance (spec 8.11), kept through Living cast L1 for the behaviour no other test
// covers end to end: re-running every migration is a no-op (byte-identical files, with or without
// the ledger). The Phase 4 cross-server memory check left with the memory store (L1); the Living
// cast memory migration (L2) brings its own acceptance.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/backend/migrations.js";
import { ensureDataLayout } from "../src/config/layout.js";
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
    // living-cast-models-v1: gateway params are gone; Opus has no curated family (unset, warned),
    // Haiku 4.5 maps to the curated Haiku 5.5 route.
    expect(yuki).not.toHaveProperty("params");
    expect(yuki).not.toHaveProperty("model");
    const riko = JSON.parse(migrated.get("user/waifus/riko/waifu.json")!);
    expect(riko.model).toEqual({ providerId: "anthropic", modelId: "claude-haiku-5-5" });
    expect(riko).not.toHaveProperty("modelId");
    expect(JSON.parse(migrated.get("app/model-warnings.json")!).warnings).toEqual([
      expect.objectContaining({ scope: "waifu:yuki", code: "model_unmapped" })
    ]);
    expect(migrated.has("app/cache/ocr/results/abc.json")).toBe(false);
    expect(migrated.has("app/cache/ocr/results-v2/def.json")).toBe(true);
    // The Phase 4 memory steps ran first; living-cast-memories-to-notes-v1 then archived the store.
    expect(JSON.parse(migrated.get("user/.archive/living-cast/memory/dream-cursor.json")!)).not.toHaveProperty("cursors");
    for (const memory of JSON.parse(migrated.get("user/.archive/living-cast/memories.json")!).memories as Array<Record<string, unknown>>) {
      expect(memory).not.toHaveProperty("guildId");
    }
    expect(migrated.has("user/memories.json")).toBe(false);
    expect(migrated.get("user/waifus/yuki/notes/MEMORY.md")).toMatch(/^# Memory\n- \[Kev\]\(people\/kev\.md\) — Kevin is allergic to peanuts\.\n/u);
    // (The cross-guild dedupe kept the guild-b copy, where the member is called "Kev".)
    expect(migrated.get("user/waifus/yuki/notes/misc.md")).toBe("# Misc\n\n- The bake sale is on Saturday.\n");
    // living-cast-archive-director-v1 and living-cast-server-fields-v1.
    expect(migrated.has("user/orchestrator/config.json")).toBe(false);
    expect(migrated.has("user/.archive/living-cast/orchestrator/config.json")).toBe(true);
    expect(JSON.parse(migrated.get("user/servers/guild-a/server.json")!)).not.toHaveProperty("contextWindows");

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
