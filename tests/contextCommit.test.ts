// ContextRuntime.commit (T5 review M1/M2): note anchors are read under the ledger + context locks,
// and the stored breakpoint only ever moves forward.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileContextStore } from "../src/orchestration/context/contextStore.js";
import type { ConversationRef } from "../src/orchestration/context/keys.js";
import { breakpointAtOrAfter, ContextRuntime } from "../src/orchestration/context/runtime.js";
import { discordMessageRenderer } from "../src/orchestration/context/messageRender.js";
import { NoopCompaction } from "../src/orchestration/context/types.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/shared/schemas/compaction.js";
import type { ContextState } from "../src/shared/schemas/context.js";
import { StorageService } from "../src/storage/storageService.js";
import { BASE_TIME, FakeChannel, FakeImageFetcher, fakeModel, fakeRoleRenderer, noSnapshots, quietLogger } from "./contextFixtures.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const GUILD: ConversationRef = { kind: "guild", guildId: "100", channelId: "200" };
const DIRECTOR = { kind: "orchestrator" } as const;

async function harness() {
  const root = await makeTempRoot();
  roots.push(root);
  const clock = { now: BASE_TIME + 3_600_000 };
  const store = new FileContextStore(new StorageService(root), { now: () => new Date(clock.now), timeZone: () => "UTC" });
  const channel = new FakeChannel();
  const runtime = new ContextRuntime({
    store,
    snapshots: noSnapshots,
    compaction: NoopCompaction,
    messages: channel,
    images: new FakeImageFetcher(),
    settings: () => ({ ...DEFAULT_COMPACTION_SETTINGS }),
    logger: quietLogger(),
    now: () => new Date(clock.now),
    timeZone: () => "UTC"
  });
  const prepare = () =>
    runtime.prepare({ conversation: GUILD, agent: DIRECTOR, model: fakeModel(), backfillCap: 50, selfAuthorIds: [], render: fakeRoleRenderer("Director", []) });
  return { store, channel, runtime, prepare };
}

describe("ContextRuntime.commit", () => {
  it("anchors notes through the store's locked updateAnchored (newest ledger seq at write time)", async () => {
    const h = await harness();
    h.channel.post({ content: "one" });
    const p = await h.prepare();
    const spy = vi.spyOn(h.store, "updateAnchored");
    // Another agent reconciled a newer message between this prepare and the commit.
    await h.store.reconcileLedger(p.key, [h.channel.post({ content: "two" })], discordMessageRenderer);
    await h.runtime.commit(p, { modelKey: p.modelKey, notes: [{ kind: "direction", text: "noted" }] });
    expect(spy).toHaveBeenCalledTimes(1);
    const state = await h.store.load(p.key, DIRECTOR);
    expect(state.notes.at(-1)).toMatchObject({ kind: "direction", anchorSeq: 2 });
  });

  it("never moves the stored breakpoint backwards when an older prompt commits late", async () => {
    const h = await harness();
    h.channel.post({ content: "one" });
    const early = await h.prepare();
    h.channel.post({ content: "two" });
    const late = await h.prepare();
    await h.runtime.commit(late, { modelKey: late.modelKey });
    expect((await h.store.load(late.key, DIRECTOR)).lastBreakpoint).toEqual({ kind: "entry", seq: 2 });
    // The aborted/slow run built on the older transcript commits after the newer one.
    await h.runtime.commit(early, { modelKey: early.modelKey });
    expect((await h.store.load(late.key, DIRECTOR)).lastBreakpoint).toEqual({ kind: "entry", seq: 2 });
  });

  it("orders entry and note addresses by transcript position", () => {
    const state = { notes: [{ kind: "direction", id: "n1", seq: 1, anchorSeq: 3, text: "x" }] } as unknown as ContextState;
    expect(breakpointAtOrAfter(state, { kind: "note", seq: 1 }, { kind: "entry", seq: 3 })).toBe(true);
    expect(breakpointAtOrAfter(state, { kind: "entry", seq: 3 }, { kind: "note", seq: 1 })).toBe(false);
    expect(breakpointAtOrAfter(state, { kind: "entry", seq: 4 }, { kind: "note", seq: 1 })).toBe(true);
    expect(breakpointAtOrAfter(state, { kind: "entry", seq: 2 }, null)).toBe(true);
    expect(breakpointAtOrAfter(state, null, { kind: "entry", seq: 2 })).toBe(false);
  });
});
