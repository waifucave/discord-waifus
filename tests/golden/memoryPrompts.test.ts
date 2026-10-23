// Golden prompts for the stage-manager observer and the nightly dream (spec 8.0, 8.11). Fixed
// `now`, UTC. Shown to the owner before Phase 4 merges (D8).
import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "../../src/shared/schemas/context.js";
import type { MemoryRecord, PendingObservation } from "../../src/shared/schemas/domain.js";
import { buildWaifuDreamChunks } from "../../src/orchestration/dream.js";
import { existingMemoriesFor, observerParticipants, renderObserverInput } from "../../src/orchestration/observer.js";
import {
  DREAM_PROMPT,
  dreamMessages,
  dreamToolParameters,
  observerSystemPrompt,
  observerToolParameters
} from "../../src/orchestration/tools.js";

const NOW = new Date("2026-10-23T05:00:00.000Z");
const KEVIN = { discordUserId: "111", name: "Kevin" };
const MIA = { discordUserId: "222", name: "Mia" };

function entry(seq: number, at: string, authorId: string, authorName: string, body: string, bot = false): LedgerEntry {
  return { id: String(5000 + seq), seq, authorId, authorName, authorIsBot: bot, at, kind: "default", body, images: [], state: "live", sealed: false };
}

function memory(id: string, overrides: Partial<MemoryRecord>): MemoryRecord {
  return {
    id,
    waifuId: "yuki",
    content: "",
    kind: "fact",
    source: "stage_manager",
    pinned: false,
    strength: 3,
    origin: { guildId: "g1", channelId: "c1" },
    subjects: [],
    revision: 0,
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z",
    status: "active",
    ...overrides
  };
}

const STORE: MemoryRecord[] = [
  memory("m-tea", { content: "Kevin prefers green tea over coffee.", kind: "preference", subjects: [KEVIN], updatedAt: "2026-10-20T12:00:00.000Z" }),
  memory("m-trip", { content: "Kevin plans a trip to Osaka on 2026-10-22.", kind: "commitment", subjects: [KEVIN], strength: 4, updatedAt: "2026-10-15T12:00:00.000Z" }),
  memory("m-cello", { content: "Mia plays the cello in a community orchestra.", subjects: [MIA], pinned: true, strength: 5 }),
  memory("m-note", {
    content: "Kevin is baking sourdough tonight.",
    kind: "context",
    source: "waifu_tool",
    strength: 2,
    subjects: [KEVIN],
    expiresAt: "2026-10-24T20:00:00.000Z",
    createdAt: "2026-10-21T20:00:00.000Z",
    updatedAt: "2026-10-21T20:00:00.000Z",
    lastRetrievedAt: "2026-10-22T08:00:00.000Z"
  })
];

const TRANSCRIPT: LedgerEntry[] = [
  entry(41, "2026-10-22T23:55:00.000Z", "111", "Kevin", "back from Osaka!! the trip was amazing"),
  entry(42, "2026-10-22T23:56:00.000Z", "900", "Yuki", "welcome back~ did you bring me anything", true),
  entry(43, "2026-10-23T00:02:00.000Z", "222", "Mia", "Kevin we need to talk about the bake-off on 12 December, I'm in"),
  entry(44, "2026-10-23T00:03:00.000Z", "111", "Kevin", "yes! also I switched to oolong, green tea got boring")
];

describe("memory prompt goldens", () => {
  it("observer: system prompt, user input and tool schema", async () => {
    const participants = observerParticipants(TRANSCRIPT, (id) => (id === "900" ? "yuki" : undefined));
    const memories = existingMemoriesFor(STORE, { allowedWaifuIds: ["yuki", "riko"], participants, now: NOW });
    const input = renderObserverInput({ participants, memories, entries: TRANSCRIPT });
    const golden = [
      "=== system ===",
      observerSystemPrompt("Never record home addresses.", ["yuki", "riko"]),
      "",
      "=== user ===",
      input.text,
      "",
      "=== tool: record_observations ===",
      JSON.stringify(observerToolParameters(["yuki", "riko"]), null, 2),
      ""
    ].join("\n");
    await expect(golden).toMatchFileSnapshot("__snapshots__/observer.txt");
  });

  it("dream: system prompt, chunk messages and tool schema", async () => {
    const observations: PendingObservation[] = [{
      id: "o1",
      waifuId: "yuki",
      content: "Mia signed up for the bake-off on 12 December.",
      kind: "commitment",
      importance: 3,
      subjects: [MIA],
      origin: { guildId: "g1", channelId: "c1" },
      conversationKey: "g_g1_c1",
      createdAt: "2026-10-23T00:10:00.000Z"
    }];
    const [chunk] = buildWaifuDreamChunks("yuki", STORE, observations, NOW);
    const messages = dreamMessages({ modelId: "m", messages: [], memories: chunk!.inputs, observations: chunk!.observations, availableWaifuIds: ["yuki"] });
    const golden = [
      "=== system ===",
      DREAM_PROMPT,
      "",
      ...messages.flatMap((message) => ["=== user ===", message.content, ""]),
      "=== tool: dream_memories ===",
      JSON.stringify(dreamToolParameters(["yuki"]), null, 2),
      ""
    ].join("\n");
    await expect(golden).toMatchFileSnapshot("__snapshots__/dream.txt");
  });
});
