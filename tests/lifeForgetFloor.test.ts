// A forgotten DM stays forgotten across a restart (Living cast §7.5, review C1). A forget deletes the
// DM state file and keeps the floor only in `limits/<waifu>.json`; boot must load floors from there,
// and `read_messages` checks the floor itself, so the person's old DMs are never readable again
// when they write after the restart. Both the DM `/forget everything` and the owner's forget-user.
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationKey } from "../src/orchestration/context/keys.js";
import { dmForget } from "../src/orchestration/dm/dmForget.js";
import { compareSnowflakes, dmFloorAt, listDmStates, readDmFloor, readDmLimit, readDmState, updateDmLimit, updateDmState } from "../src/orchestration/dm/dmStore.js";
import { forgetUser, pendingForgetJobs, resumeForgetJobs } from "../src/orchestration/dm/forgetUser.js";
import { readForgottenPeople } from "../src/orchestration/dm/forgotten.js";
import { forgetCapturedTraffic, recentQueries, recordProviderQuery } from "../src/shared/queryLog.js";
import { COMPACTION_INSTRUCTION } from "../src/life/compaction.js";
import { textTurn, type ScriptedTurn } from "./modelFakes.js";
import { closeWorlds, dmOf, KEVIN, lifeWorld, toolTurn, type LifeWorld } from "./lifeFixtures.js";
import { dmRoot } from "./dmFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const DM_KEY = conversationKey(dmOf("aria"));

async function dm(w: LifeWorld, cast: LifeWorld["cast"], text: string): Promise<void> {
  const message = w.discord.post(dmOf("aria"), text);
  await cast.onDirectMessage({ waifuId: "aria", botId: "aria-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: message.id, createdAt: message.createdAt });
}

/** She reads the DM whenever a notification arrives; compactions and checks get plain text. */
const reader: ScriptedTurn = (request) => {
  const last = JSON.stringify(request.messages.at(-1));
  if (last.includes(COMPACTION_INSTRUCTION.slice(0, 40))) return textTurn("A quiet DM.");
  if (last.includes("<notifications>")) return toolTurn([{ name: "read_messages", input: { place: DM_KEY } }]);
  return textTurn("(nothing to send)");
};

const SEQUENCES = [
  "DM /forget everything",
  "owner forget-user",
  // Review F1: the owner's forget used to delete the limits file a DM forget had left (the floor's
  // only copy), and a second owner forget deleted the floor the first one wrote.
  "DM /forget everything, then owner forget-user",
  "owner forget-user twice"
] as const;

async function forgetBy(w: LifeWorld, how: (typeof SEQUENCES)[number]): Promise<void> {
  if (how.startsWith("DM")) await dmForget(w.storage, { userId: KEVIN, waifuId: "aria", scope: "all" }, { now: w.clock.now });
  if (how === "DM /forget everything") return;
  if (how.startsWith("DM")) w.clock.advance(60_000);
  await forgetUser(w.storage, { discordUserId: KEVIN }, { now: w.clock.now });
  if (how !== "owner forget-user twice") return;
  w.clock.advance(60_000);
  const floor = await readDmFloor(w.storage, KEVIN, "aria");
  await forgetUser(w.storage, { discordUserId: KEVIN }, { now: w.clock.now });
  // Raised, never lost.
  expect(compareSnowflakes((await readDmFloor(w.storage, KEVIN, "aria"))!, floor!)).toBeGreaterThan(0);
}

describe("a forgotten DM after a restart", () => {
  for (const how of SEQUENCES) {
    it(`${how}: the old messages are not readable when the person writes again`, async () => {
      const w = await lifeWorld(roots, { scripts: [reader] });
      vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
      await dm(w, w.cast, "my secret recipe uses cardamom");
      await dm(w, w.cast, "don't tell anyone");
      w.cast.intake.flushDms();
      await w.cast.settle();
      await w.cast.life("aria").runNow();
      expect(JSON.stringify(w.anthropic.calls[1]!.request.messages)).toContain("cardamom");

      w.clock.advance(60_000);
      await forgetBy(w, how);
      expect(await listDmStates(w.storage)).toEqual([]);
      expect(await readDmFloor(w.storage, KEVIN, "aria")).toBeDefined();

      // A restart: a fresh cast and cache over the same data root and Discord history.
      await w.cast.stop();
      w.clock.advance(60_000);
      const again = w.restart();
      vi.spyOn(again.life("aria"), "poke").mockImplementation(() => undefined);
      await again.start();
      await dm(w, again, "hi again, it's me");
      again.intake.flushDms();
      await again.settle();
      await again.life("aria").runNow();
      // The newest read_messages result in her last request is the one after the restart.
      const results = w.anthropic.calls.at(-1)!.request.messages.flatMap((message) =>
        Array.isArray(message.content) ? (message.content as Array<{ type: string }>).filter((block) => block.type === "tool_result") : []
      );
      const seen = JSON.stringify(results.at(-1));
      expect(seen).toContain("hi again, it's me");
      expect(seen).not.toContain("cardamom");
      expect(seen).not.toContain("don't tell anyone");
      expect(seen).not.toContain("older messages available");
      // Not even as removed lines: below the floor nothing is served at all.
      expect(seen).not.toContain("(removed)");
    });
  }
});

describe("an unfinished owner forget (review F1, F8)", () => {
  const PERSON = "300000000000000077";
  const OTHER = "300000000000000088";

  async function seeded() {
    const { root, storage } = await dmRoot(roots);
    // Counters from before the forgets below (their times are fixed in October 2026).
    const before = "2026-10-19T00:00:00.000Z";
    await updateDmState(storage, { userId: PERSON, waifuId: "aria", botId: "aria-bot" }, (current) => ({ ...current, userDisplayName: "Quillon" }));
    await updateDmLimit(storage, PERSON, "aria", (current) => ({ ...current, replyTimestamps: [before], limitNoticeSentAt: before, autoMessageIds: ["1300000000000000009"] }));
    await mkdir(path.join(root, "user", "conversations", conversationKey({ kind: "dm", waifuId: "aria", userId: PERSON })), { recursive: true });
    return { root, storage };
  }

  it("a failing part is reported pending and recorded; the rest runs, the traffic goes, and the next boot runs only that part", async () => {
    const { root, storage } = await seeded();
    const conversation = path.join(root, "user", "conversations", conversationKey({ kind: "dm", waifuId: "aria", userId: PERSON }));
    recordProviderQuery("assistant", { messages: [{ role: "user", content: `about <@${PERSON}>: hi` }] });
    recordProviderQuery("assistant", { messages: [{ role: "user", content: `about <@${OTHER}>: hello` }] });
    const at = new Date("2026-10-20T10:00:00.000Z");
    const result = await forgetUser(storage, { discordUserId: PERSON, names: ["Quillon"] }, {
      now: () => at,
      beforeDelete: async () => {
        throw new Error("disk went away");
      }
    });
    // Recorded by its code only: no message, no path.
    expect(result.pending).toEqual([{ part: "dms", error: "Error", failures: 1, retried: true }]);
    // The floor and the record were written before the failure; the DM conversation is still there.
    expect(await readDmFloor(storage, PERSON, "aria")).toBe(dmFloorAt(at));
    expect((await readForgottenPeople(storage)).map((entry) => entry.userId)).toEqual([PERSON]);
    expect(await readdir(conversation)).toEqual([]);
    expect(await pendingForgetJobs(storage)).toEqual([
      {
        userId: PERSON,
        at: at.toISOString(),
        names: ["Quillon"],
        done: ["record", "floors", "dm-directory", "member-lists", "archive", "record-copies"],
        failures: { dms: { count: 1, error: "Error", at: at.toISOString() } }
      }
    ]);
    // Whatever failed, the captured traffic lost the person (and only the person).
    const captured = JSON.stringify(recentQueries());
    expect(captured).not.toContain(PERSON);
    expect(captured).toContain(OTHER);

    // The next boot runs the unfinished part.
    expect(await resumeForgetJobs(storage)).toBe(1);
    expect(await readDmState(storage, PERSON, "aria")).toBeUndefined();
    await expect(readdir(conversation)).rejects.toMatchObject({ code: "ENOENT" });
    const limits = await readDmLimit(storage, PERSON, "aria");
    expect(limits).toMatchObject({ replyTimestamps: [], autoMessageIds: [], floorMessageId: dmFloorAt(at) });
    expect(limits.limitNoticeSentAt).toBeUndefined();
    expect(await pendingForgetJobs(storage)).toEqual([]);
    forgetCapturedTraffic((entry) => JSON.stringify(entry).includes(OTHER));
  });

  it("a crash after the job was written: the boot resume runs every part, with the job's time", async () => {
    const { root, storage } = await seeded();
    const at = "2026-10-21T08:30:00.000Z";
    await mkdir(path.join(root, "user", "people"), { recursive: true });
    await writeFile(path.join(root, "user", "people", "forget-jobs.json"), JSON.stringify({ jobs: [{ userId: PERSON, at }] }));
    expect(await resumeForgetJobs(storage)).toBe(1);
    expect(await readDmState(storage, PERSON, "aria")).toBeUndefined();
    expect(await readDmFloor(storage, PERSON, "aria")).toBe(dmFloorAt(new Date(at)));
    expect(await readForgottenPeople(storage)).toEqual([{ userId: PERSON, at }]);
    expect(await readdir(path.join(root, "user", "dms", PERSON))).toEqual(["limits"]);
    expect(await pendingForgetJobs(storage)).toEqual([]);
  });

  it("a resumed DM part keeps a chat the person started after the forget", async () => {
    const { root, storage } = await seeded();
    const at = new Date("2026-10-21T08:30:00.000Z");
    // A crash after the record and the floors; days later the person writes again.
    await mkdir(path.join(root, "user", "people"), { recursive: true });
    await writeFile(path.join(root, "user", "people", "forget-jobs.json"), JSON.stringify({ jobs: [{ userId: PERSON, at: at.toISOString(), done: ["record", "floors"] }] }));
    await updateDmLimit(storage, PERSON, "aria", (current) => ({ ...current, floorMessageId: dmFloorAt(at) }));
    const newer = (BigInt(dmFloorAt(new Date("2026-10-23T09:00:00.000Z"))) + 1n).toString();
    const key = conversationKey({ kind: "dm", waifuId: "aria", userId: PERSON });
    await updateDmState(storage, { userId: PERSON, waifuId: "aria", botId: "aria-bot" }, (current) => ({ ...current, lastInboundMessageId: newer }));
    await writeFile(
      path.join(root, "user", "conversations", key, "refs.json"),
      JSON.stringify({ schemaVersion: 2, revision: 1, updatedAt: "2026-10-23T09:00:00.000Z", conversationKey: key, counter: 361, refs: { [newer]: "a0" } })
    );
    const stamp = "2026-10-23T09:00:01.000Z";
    await updateDmLimit(storage, PERSON, "aria", (current) => ({ ...current, replyTimestamps: [...current.replyTimestamps, stamp] }));
    expect(await resumeForgetJobs(storage)).toBe(1);
    // The new chat stays whole; only what was at or before the forget went.
    expect((await readDmState(storage, PERSON, "aria"))?.lastInboundMessageId).toBe(newer);
    expect(await readdir(path.join(root, "user", "conversations", key))).toEqual(["refs.json"]);
    const limits = await readDmLimit(storage, PERSON, "aria");
    expect(limits.replyTimestamps).toEqual([stamp]);
    expect(limits.limitNoticeSentAt).toBeUndefined();
    expect(limits.floorMessageId).toBe(dmFloorAt(at));
    expect(await pendingForgetJobs(storage)).toEqual([]);
  });

  it("a resumed older job never lowers a later floor", async () => {
    const { root, storage } = await seeded();
    const later = dmFloorAt(new Date("2026-10-22T00:00:00.000Z"));
    await updateDmLimit(storage, PERSON, "aria", (current) => ({ ...current, floorMessageId: later }));
    await mkdir(path.join(root, "user", "people"), { recursive: true });
    await writeFile(path.join(root, "user", "people", "forget-jobs.json"), JSON.stringify({ jobs: [{ userId: PERSON, at: "2026-10-21T08:30:00.000Z" }] }));
    await resumeForgetJobs(storage);
    expect(await readDmFloor(storage, PERSON, "aria")).toBe(later);
  });
});
