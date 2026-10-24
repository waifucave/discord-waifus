// Memory (Living cast spec §7.3, §7.5): nightly maintenance uses only the notes tools; pending
// scrubs run with it; forget end to end — summary without the person, other state, notes scrub, new
// epoch and verification (needsReview for shared names), the DM rate limit and `/forget conversation`.
// Scripted winter fakes, temp data root; no live calls.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLifeFile, readLifeLog, readLifeState, readMaintenanceReports, updateLifeFile, updateLifeState } from "../src/life/lifeStore.js";
import { MAINTENANCE_INSTRUCTION } from "../src/life/maintenance.js";
import { Notes } from "../src/life/notes.js";
import { newWakeId, enqueueWake } from "../src/life/wakeQueue.js";
import { queueOwnerScrubs } from "../src/life/forget.js";
import { pendingScrubsPath, queuePendingScrub, readPendingScrubs } from "../src/orchestration/dm/forgotten.js";
import { GuildMembersFileSchema } from "../src/shared/schemas/domain.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { textTurn } from "./modelFakes.js";
import { ARIA_BOT, CHANNEL, closeWorlds, dmOf, GUILD, KEVIN, lifeWorld, MINA_USER, ROOM, ROOM_KEY, script, toolTurn, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const NOTE_TOOLS = ["list_notes", "read_note", "write_note", "edit_note", "delete_note", "search_notes"];

/** Members of Bake Club: Kevin (also called Sam elsewhere) and another Sam. */
async function seedMembers(w: LifeWorld): Promise<void> {
  const at = w.clock.now().toISOString();
  await w.storage.writeJson(
    `members:${GUILD}`,
    `user/servers/${GUILD}/members.json`,
    GuildMembersFileSchema,
    GuildMembersFileSchema.parse({
      ...createRevisionedBase(),
      guildId: GUILD,
      members: [
        { userId: KEVIN, username: "kevbaker", globalDisplayName: "Sam", guildDisplayName: "Kevin", bot: false, perChannelLastSeenAt: {}, fetchedAt: at },
        { userId: MINA_USER, username: "samantha", guildDisplayName: "Sam", bot: false, perChannelLastSeenAt: {}, fetchedAt: at }
      ]
    })
  );
}

/** One real turn so she has an epoch and a log about Kevin. */
async function liveATurn(w: LifeWorld): Promise<void> {
  const message = w.discord.post(ROOM, `<@${ARIA_BOT}> I passed my chemistry exam!`, { mentions: { [ARIA_BOT]: "Aria" } });
  await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["aria"], authorIsWaifu: false, raw: message });
  await w.cast.settle();
  await w.cast.life("aria").runNow();
}

describe("nightly maintenance (§7.3)", () => {
  it("is a separate session with only the notes tools, purpose maintenance, and one report line", async () => {
    const w = await lifeWorld(roots, {
      scripts: script(
        toolTurn([{ name: "read_note", input: { path: "MEMORY.md" } }]),
        toolTurn([{ name: "write_note", input: { path: "MEMORY.md", content: "# Memory\n- [Kevin](people/kevin.md) — chemistry student\n" } }]),
        textTurn("merged two Kevin lines")
      )
    });
    const notes = new Notes(w.storage, "aria");
    await notes.write("MEMORY.md", "# Memory\n- Kevin studies chemistry\n- Kevin is a chemistry student\n");
    // No sleep window: maintenance is due at 05:00 local; the clock says 14:00.
    await w.cast.scheduler.tick();
    const calls = w.anthropic.calls;
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.request.tools?.map((tool) => tool.name).sort()).toEqual([...NOTE_TOOLS].sort());
      expect(JSON.stringify(call.request.messages)).not.toContain("<notifications>");
    }
    expect(JSON.stringify(calls[0]!.request.messages[0])).toContain(MAINTENANCE_INSTRUCTION.slice(0, 40));
    expect(w.ledger.lines.map((line) => line.purpose)).toEqual(["maintenance", "maintenance", "maintenance"]);
    expect(await notes.read("MEMORY.md")).toBe("# Memory\n- [Kevin](people/kevin.md) — chemistry student\n");
    const reports = await readMaintenanceReports(w.storage, "aria");
    expect(reports).toMatchObject([{ kind: "maintenance", ok: true, rounds: 3, changed: ["MEMORY.md"], summary: "merged two Kevin lines" }]);
    // Her life log is untouched by maintenance; the next tick the same day does nothing.
    expect(await readLifeLog(w.storage, "aria", 1).catch(() => [])).toEqual([]);
    await w.cast.scheduler.tick();
    expect(w.anthropic.calls).toHaveLength(3);
  });
});

describe("forget (§7.5)", () => {
  it("the owner's forget-user: summary without him, other state scrubbed, notes scrubbed, new epoch, verified", async () => {
    const w = await lifeWorld(roots, {
      scripts: script(
        // Her turn about Kevin.
        toolTurn([{ name: "read_messages", input: { place: "bake-club/#general" } }]),
        toolTurn([{ name: "send_message", input: { place: "bake-club/#general", text: "congrats Kevin!!" } }]),
        textTurn("so happy for him"),
        // Step 2: the summary (the model slips; verification catches it).
        textTurn("We celebrated in Bake Club.\nKevin passed his exam."),
        // Step 4: the notes scrub session.
        toolTurn([{ name: "delete_note", input: { path: "people/kevin.md" } }]),
        textTurn("removed his note")
      )
    });
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    await seedMembers(w);
    await liveATurn(w);
    expect(w.discord.sent.map((sent) => sent.content)).toEqual(["congrats Kevin!!"]);
    const notes = new Notes(w.storage, "aria");
    await notes.write("people/kevin.md", "# Kevin\n- studies chemistry\n");
    await notes.write("MEMORY.md", "# Memory\n- [Kevin](people/kevin.md) — studies chemistry\n- [Me](me.md) — about me\n");
    await notes.write("me.md", `# Me\n- I love lemon tarts. Kevin taught me piping.\n- Sam is funny.\n- <@${KEVIN}> owes me a cake\n`);
    const now = w.clock.now().toISOString();
    await updateLifeFile(w.storage, "aria", "watches", (file) => ({
      ...file,
      watches: [{ id: "w1", note: "his results", createdAt: now, expiresAt: new Date(w.clock.ms + 86_400_000).toISOString(), once: true, bindings: [{ fromUserId: KEVIN, fromName: "Kevin" }], fires: [] }]
    }));
    await updateLifeFile(w.storage, "aria", "schedule", (file) => ({
      ...file,
      reminders: [
        { id: "r1", note: "ask Kevin how the party went", dueAt: new Date(w.clock.ms + 3_600_000).toISOString(), createdAt: now },
        { id: "r2", note: "buy lemons", dueAt: new Date(w.clock.ms + 3_600_000).toISOString(), createdAt: now }
      ]
    }));
    await enqueueWake(w.storage, "aria", { id: newWakeId(), reason: "mention", placeKey: ROOM_KEY, fromUserId: KEVIN, fromName: "Kevin", preview: "hey", at: now });
    await updateLifeState(w.storage, "aria", (state) => ({ ...state, pendingNotices: ["(Kevin deleted a message you read in bake-club/#general)"] }));

    const result = await w.cast.forgetPerson(KEVIN);
    expect(result.scrubbed).toEqual([
      { waifuId: "aria", removedLines: 3, removedSentences: 1, needsReview: [{ where: "notes/me.md", line: "- Sam is funny." }] }
    ]);
    // Step 2: one summary call told to leave him out, with no kept turns.
    const summaryCall = w.anthropic.calls[3]!.request;
    const lastMessage = JSON.stringify(summaryCall.messages[summaryCall.messages.length - 1]);
    expect(lastMessage).toContain("Leave out everything about these people, who asked to be forgotten: Kevin");
    // Step 4: the scrub session had only the notes tools.
    expect(w.anthropic.calls[4]!.request.tools?.map((tool) => tool.name).sort()).toEqual([...NOTE_TOOLS].sort());
    // Step 5: a new epoch with every old log deleted, a summary and notes without him.
    const state = await readLifeState(w.storage, "aria");
    expect(state.epoch).toBe(2);
    expect(state.pendingEpochStart).toBeFalsy();
    expect(state.summary).toBe("We celebrated in Bake Club.");
    expect(state.systemSnapshot?.memoryIndex).not.toContain("Kevin");
    await expect(readFile(path.join(w.root, "user/waifus/aria/life/log/1.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await notes.read("people/kevin.md")).toBeUndefined();
    expect(await notes.read("MEMORY.md")).toBe("# Memory\n- [Me](me.md) — about me\n");
    expect(await notes.read("me.md")).toBe("# Me\n- I love lemon tarts.\n- Sam is funny.\n");
    // Step 3: wakes, notices, watches and reminders about him are gone; others stay.
    expect((await readLifeFile(w.storage, "aria", "wakes")).immediate).toEqual([]);
    expect(state.pendingNotices).toEqual([]);
    expect((await readLifeFile(w.storage, "aria", "watches")).watches).toEqual([]);
    expect((await readLifeFile(w.storage, "aria", "schedule")).reminders.map((reminder) => reminder.id)).toEqual(["r2"]);
    // The report keeps counts only.
    const report = (await readMaintenanceReports(w.storage, "aria")).find((line) => line.kind === "forget")!;
    expect(report).toMatchObject({ source: "owner", removedLines: 3, removedSentences: 1, needsReview: 1 });
    const raw = await readFile(path.join(w.root, "user/waifus/aria/life/maintenance.jsonl"), "utf8");
    expect(raw).not.toContain("Kevin");
    expect(raw).not.toContain(KEVIN);
    // It was queued as an owner scrub first and cleared once it ran.
    expect(await readPendingScrubs(w.storage, "aria")).toEqual([]);
  });

  it("an owner forget with no cast runtime is queued and runs when her life next starts, before any turn", async () => {
    const w = await lifeWorld(roots, {
      scripts: script(
        toolTurn([{ name: "read_messages", input: { place: "bake-club/#general" } }]),
        toolTurn([{ name: "send_message", input: { place: "bake-club/#general", text: "congrats Kevin!!" } }]),
        textTurn("so happy for him"),
        textTurn("We celebrated in Bake Club."),
        textTurn("nothing about him in my notes"),
        // Boot catch-up then runs today's missed nightly maintenance, after the scrub.
        textTurn("all tidy")
      )
    });
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    await liveATurn(w);
    await w.cast.stop();
    // The route's offline path: the DM part ran elsewhere; the life scrub is only queued.
    const queued = await queueOwnerScrubs(w.storage, KEVIN, w.clock.now());
    expect(queued.map((entry) => entry.waifu.id)).toEqual(["aria"]);
    expect(await readPendingScrubs(w.storage, "aria")).toEqual([{ userId: KEVIN, at: w.clock.now().toISOString(), source: "owner_forget" }]);
    // A later DM /forget never downgrades it to the nightly source.
    await queuePendingScrub(w.storage, "aria", KEVIN, new Date(w.clock.ms + 1_000));
    expect((await readPendingScrubs(w.storage, "aria"))[0]!.source).toBe("owner_forget");
    await queueOwnerScrubs(w.storage, KEVIN, w.clock.now());

    const restarted = w.restart();
    await restarted.start();
    await restarted.settle();
    const state = await readLifeState(w.storage, "aria");
    expect(state.epoch).toBe(2);
    expect(state.summary).toBe("We celebrated in Bake Club.");
    expect(state.scrubbedAt[KEVIN]).toBeDefined();
    expect(await readPendingScrubs(w.storage, "aria")).toEqual([]);
    expect((await readMaintenanceReports(w.storage, "aria")).map((report) => [report.kind, report.source ?? report.summary])).toEqual([
      ["forget", "owner"],
      ["maintenance", "all tidy"]
    ]);
    expect(w.ledger.lines.map((line) => line.purpose)).toEqual(["life", "life", "life", "compaction", "maintenance", "maintenance"]);
  });

  it("a DM user's /forget everything runs at most once per 6 hours; later ones queue a pending scrub for maintenance", async () => {
    const w = await lifeWorld(roots, {
      scripts: script(
        textTurn("hi kevin"),
        textTurn("no need to reply"),
        textTurn("Talked with someone in a DM."),
        textTurn("nothing to remove"),
        textTurn("Still quiet."),
        textTurn("nothing to remove")
      )
    });
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    const dm = w.discord.post(dmOf("aria"), "hello aria");
    await w.cast.onDirectMessage({ waifuId: "aria", botId: "aria-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: dm.id, createdAt: dm.createdAt });
    w.cast.intake.flushDms();
    await w.cast.settle();
    await w.cast.life("aria").runNow();
    const first = await w.cast.forgetInLife({ waifuId: "aria", userId: KEVIN, source: "dm", scope: "everything" });
    expect(first.queued).toBeUndefined();
    w.clock.advance(60 * 60_000);
    const second = await w.cast.forgetInLife({ waifuId: "aria", userId: KEVIN, source: "dm", scope: "everything" });
    expect(second).toMatchObject({ queued: true });
    expect((await readPendingScrubs(w.storage, "aria")).map((scrub) => scrub.userId)).toEqual([KEVIN]);
    // Maintenance (05:00 local; next day) runs the pending scrub, then clears the queue.
    w.clock.ms = Date.parse("2026-10-25T05:30:00.000Z");
    await w.cast.scheduler.tick();
    expect(await readPendingScrubs(w.storage, "aria")).toEqual([]);
    expect(JSON.parse(await readFile(pendingScrubsPath(w.root, "aria"), "utf8"))).toEqual({ scrubs: [] });
    const reports = await readMaintenanceReports(w.storage, "aria");
    expect(reports.map((report) => [report.kind, report.source])).toEqual([
      ["forget", "dm"],
      ["forget", "pending"],
      ["maintenance", undefined]
    ]);
  });

  it("/forget conversation runs steps 0–2 only: the summary leaves the chat out; notes stay", async () => {
    // A direct (dm) wake that ends in text gets one unsent-reply check, then the summary.
    const w = await lifeWorld(roots, { scripts: script(textTurn("hello!"), textTurn("no need to reply"), textTurn("A quiet day.")) });
    vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
    const dm = w.discord.post(dmOf("aria"), "hi");
    await w.cast.onDirectMessage({ waifuId: "aria", botId: "aria-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: dm.id, createdAt: dm.createdAt });
    w.cast.intake.flushDms();
    await w.cast.settle();
    await w.cast.life("aria").runNow();
    const notes = new Notes(w.storage, "aria");
    await notes.write("people/kevin.md", "# Kevin\n- says hi\n");
    await w.cast.forgetInLife({ waifuId: "aria", userId: KEVIN, source: "dm", scope: "conversation" });
    const state = await readLifeState(w.storage, "aria");
    expect(state.summary).toBe("A quiet day.");
    expect(state.pendingEpochStart).toBe(true);
    expect(await notes.read("people/kevin.md")).toBe("# Kevin\n- says hi\n");
    expect(w.anthropic.calls).toHaveLength(3);
  });
});
