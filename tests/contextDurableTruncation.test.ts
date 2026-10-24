// A context WITHOUT a summarizer (deterministic / one-shot director) must not grow forever: when the
// compaction service triggers, prepare truncates durably (new epoch, no summary, cursor advanced),
// so the context stops pinning ledger/refs pruning for the whole conversation (T5 review C1).
import { afterEach, describe, expect, it } from "vitest";
import { createCompactionService } from "../src/orchestration/context/compaction.js";
import { FileContextStore } from "../src/orchestration/context/contextStore.js";
import type { ConversationRef } from "../src/orchestration/context/keys.js";
import { conversationKey } from "../src/orchestration/context/keys.js";
import { ContextRuntime } from "../src/orchestration/context/runtime.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/shared/schemas/compaction.js";
import { StorageService } from "../src/storage/storageService.js";
import { BASE_TIME, FakeChannel, FakeImageFetcher, fakeModel, fakeRoleRenderer, noSnapshots, quietLogger } from "./contextFixtures.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const GUILD: ConversationRef = { kind: "guild", guildId: "100", channelId: "200" };

async function harness(settings: Partial<typeof DEFAULT_COMPACTION_SETTINGS> = {}) {
  const root = await makeTempRoot();
  roots.push(root);
  const clock = { now: BASE_TIME };
  const storage = new StorageService(root);
  const store = new FileContextStore(storage, { now: () => new Date(clock.now), timeZone: () => "UTC", pruneProtectNewest: 40 });
  const channel = new FakeChannel();
  const logger = quietLogger();
  const runtime = new ContextRuntime({
    store,
    snapshots: noSnapshots,
    compaction: createCompactionService({ store, logger, now: () => new Date(clock.now) }),
    messages: channel,
    images: new FakeImageFetcher(),
    settings: () => ({ ...DEFAULT_COMPACTION_SETTINGS, ...settings }),
    logger,
    now: () => new Date(clock.now),
    timeZone: () => "UTC"
  });
  return { store, channel, clock, runtime };
}

describe("durable truncation without a summarizer", () => {
  it("keeps a deterministic director bounded across 400 messages and lets pruning advance", { timeout: 60_000 }, async () => {
    const h = await harness();
    const key = conversationKey(GUILD);
    const counts: number[] = [];
    const cursors: Array<number | null> = [];
    for (let i = 0; i < 400; i += 1) {
      h.channel.post({ content: `message ${i}` }, BASE_TIME + i * 60_000);
      if (i % 10 !== 9) continue;
      h.clock.now = BASE_TIME + i * 60_000 + 30_000;
      const p = await h.runtime.prepare({
        conversation: GUILD,
        agent: { kind: "orchestrator" },
        model: fakeModel({ images: false }),
        backfillCap: 20,
        selfAuthorIds: [],
        render: fakeRoleRenderer("Director", [])
        // no summarize: deterministic / one-shot
      });
      counts.push(p.prompt.transcriptCount);
      cursors.push(p.state.cursorSeq);
      await h.runtime.commit(p, { modelKey: p.modelKey });
    }
    // Never more than the message limit (plus one batch) in a prompt.
    expect(Math.max(...counts)).toBeLessThanOrEqual(DEFAULT_COMPACTION_SETTINGS.maxMessages + 10);
    // It truncated several times, each time back to the effective keepRecent.
    expect(counts.filter((count) => count === DEFAULT_COMPACTION_SETTINGS.keepRecent).length).toBeGreaterThanOrEqual(2);
    // The cursor only moves forward, and well past the start.
    for (let i = 1; i < cursors.length; i += 1) expect(cursors[i]! >= (cursors[i - 1] ?? -1)).toBe(true);
    expect(cursors[cursors.length - 1]!).toBeGreaterThan(250);
    const state = await h.store.load(key, { kind: "orchestrator" });
    expect(state.summary).toBeNull();
    expect(state.epoch).toBeGreaterThanOrEqual(2);
    expect(state.lastCompaction).toMatchObject({ ok: true, trigger: "messages" });
    // Pruning advanced with the cursor: the ledger holds the live window, not all 400 entries.
    const ledger = await h.store.loadLedger(key);
    expect(Object.keys(ledger.entries).length).toBeLessThan(DEFAULT_COMPACTION_SETTINGS.maxMessages + 20);
    expect(Math.min(...Object.values(ledger.entries).map((entry) => entry.seq))).toBeGreaterThan(state.cursorSeq! - 1 - 40);
  });

  it("honours a smaller truncateKeep (one-shot keeps its old window)", async () => {
    const h = await harness();
    for (let i = 0; i < 160; i += 1) h.channel.post({ content: `message ${i}` }, BASE_TIME + i * 60_000);
    h.clock.now = BASE_TIME + 160 * 60_000;
    const input = {
      conversation: GUILD,
      agent: { kind: "orchestrator" } as const,
      model: fakeModel({ images: false }),
      backfillCap: 200,
      selfAuthorIds: [],
      render: fakeRoleRenderer("Director", []),
      truncateKeep: 20
    };
    const p = await h.runtime.prepare(input);
    expect(p.prompt.transcriptCount).toBe(20);
    expect(p.transcript[0]!.body).toBe("message 140");
    expect(p.state.summary).toBeNull();
    // Persisted: the next prepare starts from the advanced cursor.
    const again = await h.runtime.prepare(input);
    expect(again.state.cursorSeq).toBe(p.state.cursorSeq);
    expect(again.prompt.transcriptCount).toBe(20);
  });

  it("never truncates a context that can summarize (compaction does that job)", async () => {
    const h = await harness();
    for (let i = 0; i < 160; i += 1) h.channel.post({ content: `message ${i}` }, BASE_TIME + i * 60_000);
    h.clock.now = BASE_TIME + 160 * 60_000;
    const p = await h.runtime.prepare({
      conversation: GUILD,
      agent: { kind: "orchestrator" },
      model: fakeModel({ images: false }),
      backfillCap: 200,
      selfAuthorIds: [],
      render: fakeRoleRenderer("Director", []),
      summarize: async () => "the room so far"
    });
    expect(p.state.summary).toBe("the room so far");
  });

  // Acceptance M4: compaction.enabled: false used to skip the check entirely, so prompts grew
  // without bound. It now only turns off summaries; the limits still truncate durably.
  it("compaction.enabled: false truncates durably instead of growing (and never summarizes)", async () => {
    const h = await harness({ enabled: false });
    for (let i = 0; i < 160; i += 1) h.channel.post({ content: `message ${i}` }, BASE_TIME + i * 60_000);
    h.clock.now = BASE_TIME + 160 * 60_000;
    let summarized = 0;
    const input = {
      conversation: GUILD,
      agent: { kind: "waifu", waifuId: "aria" } as const,
      model: fakeModel({ images: false }),
      backfillCap: 200,
      selfAuthorIds: [],
      render: fakeRoleRenderer("Aria", []),
      summarize: async () => {
        summarized += 1;
        return "should not run";
      }
    };
    const p = await h.runtime.prepare(input);
    expect(p.prompt.transcriptCount).toBe(DEFAULT_COMPACTION_SETTINGS.keepRecent);
    expect(p.transcript[0]!.body).toBe(`message ${160 - DEFAULT_COMPACTION_SETTINGS.keepRecent}`);
    expect(p.state.summary).toBeNull();
    expect(p.state.epoch).toBe(1);
    expect(summarized).toBe(0);
    await h.runtime.commit(p, { modelKey: p.modelKey });
    const again = await h.runtime.prepare(input);
    expect(again.state.cursorSeq).toBe(p.state.cursorSeq);
    expect(again.prompt.transcriptCount).toBe(DEFAULT_COMPACTION_SETTINGS.keepRecent);
    expect(summarized).toBe(0);
  });
});
