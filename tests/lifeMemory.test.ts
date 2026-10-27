// Memory (Living cast spec §7.3, §7.5, §16.8, §16.9): nightly maintenance uses only her file tools;
// pending scrubs run with it; forget end to end — summary without the person, other state (her
// reminder and watch files too), notes scrub over every text file of her home, new epoch and
// verification (needsReview for shared names), the DM rate limit and `/forget conversation`.
// Scripted winter fakes, temp data root; no live calls.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLifeFile, readLifeLog, readLifeState, readMaintenanceReports, updateLifeFile, updateLifeState } from "../src/life/lifeStore.js";
import { DREAM_INSTRUCTION, DREAM_NOTHING_NEW } from "../src/life/dream.js";
import { newWakeId, enqueueWake } from "../src/life/wakeQueue.js";
import { NOTES_SCRUB_SKIPPED, queueOwnerScrubs, readNeedsReview, waifusWithLife } from "../src/life/forget.js";
import { homeStoreFor } from "../src/life/home/index.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import { pendingScrubsPath, queuePendingScrub, readPendingScrubs } from "../src/orchestration/dm/forgotten.js";
import { GuildMembersFileSchema } from "../src/shared/schemas/domain.js";
import { SearchUsageSchema } from "../src/shared/schemas/life.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { dmForget } from "../src/orchestration/dm/dmForget.js";
import { errorTurn, textTurn } from "./modelFakes.js";
import { ELLA_BOT, CHANNEL, closeWorlds, dmOf, GUILD, herEntries, homeOf, KEVIN, lifeWorld, MINA_USER, ROOM, ROOM_KEY, script, seedTranscript, toolTurn, writeHerFile, writeWaifuConfig, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const FILE_TOOLS = ["Read", "Write", "Edit", "Bash"];

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
  const message = w.discord.post(ROOM, `<@${ELLA_BOT}> I passed my chemistry exam!`, { mentions: { [ELLA_BOT]: "Ella" } });
  await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["ella"], authorIsWaifu: false, raw: message });
  await w.cast.settle();
  // Her wake waits for the burst's quiet time (§4.2): fire it now.
  w.cast.intake.flushDetector();
  await w.cast.settle();
  await w.cast.life("ella").runNow();
}

describe("nightly dreaming (§18.4, replacing §7.3 and §16.8)", () => {
  it("is a separate session with only her file tools, purpose maintenance, and one report line", async () => {
    const w = await lifeWorld(roots, {
      scripts: script(
        toolTurn([{ name: "Read", input: { file_path: "~/MEMORY.md" } }]),
        toolTurn([{ name: "Write", input: { file_path: "~/MEMORY.md", content: "# Memory\n- [Kevin](people/kevin.md) — chemistry student\n" } }]),
        textTurn("merged two Kevin lines")
      )
    });
    const notes = homeOf(w, "ella");
    await notes.write("MEMORY.md", "# Memory\n- Kevin studies chemistry\n- Kevin is a chemistry student\n");
    await seedTranscript(w, [{ text: "chemistry exam on friday!" }]);
    // No sleep window: maintenance is due at 05:00 local; the clock says 14:00.
    await w.cast.scheduler.tick();
    const calls = w.anthropic.calls;
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.request.tools?.map((tool) => tool.name).sort()).toEqual([...FILE_TOOLS].sort());
      expect(JSON.stringify(call.request.messages)).not.toContain("<notifications>");
    }
    expect(JSON.stringify(calls[0]!.request.messages[0])).toContain(DREAM_INSTRUCTION.slice(0, 40));
    expect(JSON.stringify(calls[0]!.request.messages[0])).toContain("/transcripts/bake-club/general/2026-10-24.md (the whole file, 1 line)");
    expect(w.ledger.lines.map((line) => line.purpose)).toEqual(["maintenance", "maintenance", "maintenance"]);
    expect(await notes.read("MEMORY.md")).toBe("# Memory\n- [Kevin](people/kevin.md) — chemistry student\n");
    const reports = await readMaintenanceReports(w.storage, "ella");
    expect(reports).toMatchObject([{ kind: "maintenance", ok: true, rounds: 3, changed: ["MEMORY.md"], summary: "merged two Kevin lines" }]);
    // Her life log is untouched by maintenance; the next tick the same day does nothing.
    expect(await readLifeLog(w.storage, "ella", 1).catch(() => [])).toEqual([]);
    await w.cast.scheduler.tick();
    expect(w.anthropic.calls).toHaveLength(3);
  });
});

describe("forget (§7.5)", () => {
  it("the owner's forget-user: summary without him, other state scrubbed, notes scrubbed, new epoch, verified", async () => {
    const w = await lifeWorld(roots, {
      scripts: script(
        // Her turn about Kevin.
        toolTurn([{ name: "ReadMessages", input: { place: "bake-club/#general" } }]),
        toolTurn([{ name: "SendMessage", input: { place: "bake-club/#general", text: "congrats Kevin!!" } }]),
        textTurn("so happy for him"),
        // Step 2: the summary (the model slips; verification catches it).
        textTurn("We celebrated in Bake Club.\nKevin passed his exam."),
        // Step 4: the notes scrub session.
        toolTurn([{ name: "Bash", input: { command: "rm ~/people/kevin.md" } }]),
        textTurn("removed his note")
      )
    });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await seedMembers(w);
    await liveATurn(w);
    expect(w.discord.sent.map((sent) => sent.content)).toEqual(["congrats Kevin!!"]);
    const notes = homeOf(w, "ella");
    await notes.write("people/kevin.md", "# Kevin\n- studies chemistry\n");
    await notes.write("MEMORY.md", "# Memory\n- [Kevin](people/kevin.md) — studies chemistry\n- [Me](me.md) — about me\n");
    await notes.write("me.md", `# Me\n- I love lemon tarts. Kevin taught me piping.\n- Sam is funny.\n- <@${KEVIN}> owes me a cake\n`);
    const now = w.clock.now().toISOString();
    await writeHerFile(w, "life/watches.json", JSON.stringify([{ timeout: "2026-10-25 14:00", once: true, note: "his results", when: [{ from: "Kevin" }] }]));
    await writeHerFile(
      w,
      "life/reminders.json",
      JSON.stringify([
        { at: "2026-10-24 16:00", note: "ask Kevin how the party went" },
        { at: "2026-10-24 16:00", note: "buy lemons" }
      ])
    );
    await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "mention", placeKey: ROOM_KEY, fromUserId: KEVIN, fromName: "Kevin", preview: "hey", at: now });
    await updateLifeState(w.storage, "ella", (state) => ({ ...state, pendingNotices: ["(Kevin deleted a message you read in bake-club/#general)"] }));

    const result = await w.cast.forgetPerson(KEVIN);
    // A bullet naming him goes whole (the piping line), so do id lines and the summary's sentence.
    expect(result.scrubbed).toEqual([
      { waifuId: "ella", removedLines: 4, removedSentences: 0, removedNotes: 0, removedFiles: 0, needsReview: [{ where: "~/me.md", line: "- Sam is funny." }] }
    ]);
    // Step 2: one summary call told to leave him out, with no kept turns, by every name (the shared one too).
    const summaryCall = w.anthropic.calls[3]!.request;
    const lastMessage = JSON.stringify(summaryCall.messages[summaryCall.messages.length - 1]);
    expect(lastMessage).toContain("Leave out everything about these people, who asked to be forgotten: Kevin, kevbaker, Sam");
    // Step 4's instruction names him the same way.
    expect(JSON.stringify(w.anthropic.calls[4]!.request.messages[0])).toContain('\\"Kevin\\", \\"kevbaker\\", \\"Sam\\"');
    // Step 4: the scrub session had only her file tools.
    expect(w.anthropic.calls[4]!.request.tools?.map((tool) => tool.name).sort()).toEqual([...FILE_TOOLS].sort());
    // Step 5: a new epoch with every old log deleted, a summary and notes without him.
    const state = await readLifeState(w.storage, "ella");
    expect(state.epoch).toBe(2);
    expect(state.pendingEpochStart).toBeFalsy();
    expect(state.summary).toBe("We celebrated in Bake Club.");
    expect(state.systemSnapshot?.memoryIndex).not.toContain("Kevin");
    await expect(readFile(path.join(w.root, "user/waifus/ella/life/log/1.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await notes.read("people/kevin.md")).toBeUndefined();
    expect(await notes.read("MEMORY.md")).toBe("# Memory\n- [Me](me.md) — about me\n");
    expect(await notes.read("me.md")).toBe("# Me\n- Sam is funny.\n");
    // Step 3: his wakes, notices and watches are gone; her reminder about him stays and loses the
    // text (review F3: her own entry is not his); others stay.
    expect((await readLifeFile(w.storage, "ella", "wakes")).immediate).toEqual([]);
    expect(state.pendingNotices).toEqual([]);
    expect(await herEntries(w, "watches.json")).toEqual([]);
    expect((await herEntries(w, "reminders.json")).map((reminder) => [reminder["id"], reminder["note"]])).toEqual([
      ["r1", "(removed)"],
      ["r2", "buy lemons"]
    ]);
    // The report keeps counts only.
    const report = (await readMaintenanceReports(w.storage, "ella")).find((line) => line.kind === "forget")!;
    expect(report).toMatchObject({ source: "owner", removedLines: 4, removedSentences: 0, needsReview: 1 });
    // The review line is kept for the owner (no id in it).
    const review = JSON.parse(await readFile(path.join(w.root, "user/waifus/ella/life/needs-review.json"), "utf8")) as { items: unknown[] };
    expect(review.items).toEqual([{ at: w.clock.now().toISOString(), source: "owner", where: "~/me.md", line: "- Sam is funny." }]);
    const raw = await readFile(path.join(w.root, "user/waifus/ella/life/maintenance.jsonl"), "utf8");
    expect(raw).not.toContain("Kevin");
    expect(raw).not.toContain(KEVIN);
    // It was queued as an owner scrub first and cleared once it ran.
    expect(await readPendingScrubs(w.storage, "ella")).toEqual([]);
  });

  it("an owner forget with no cast runtime is queued and runs when her life next starts, before any turn", async () => {
    const w = await lifeWorld(roots, {
      scripts: script(
        toolTurn([{ name: "ReadMessages", input: { place: "bake-club/#general" } }]),
        toolTurn([{ name: "SendMessage", input: { place: "bake-club/#general", text: "congrats Kevin!!" } }]),
        textTurn("so happy for him"),
        textTurn("We celebrated in Bake Club."),
        textTurn("nothing about him in my notes"),
        // Boot catch-up then runs today's missed nightly maintenance, after the scrub.
        textTurn("all tidy")
      )
    });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await liveATurn(w);
    await w.cast.stop();
    // The route's offline path: the DM part ran elsewhere; the life scrub is only queued.
    const queued = await queueOwnerScrubs(w.storage, KEVIN, w.clock.now());
    expect(queued.map((entry) => entry.waifu.id)).toEqual(["ella"]);
    expect(await readPendingScrubs(w.storage, "ella")).toEqual([{ userId: KEVIN, at: w.clock.now().toISOString(), source: "owner_forget" }]);
    // A later DM /forget never downgrades it to the nightly source.
    await queuePendingScrub(w.storage, "ella", KEVIN, new Date(w.clock.ms + 1_000));
    expect((await readPendingScrubs(w.storage, "ella"))[0]!.source).toBe("owner_forget");
    await queueOwnerScrubs(w.storage, KEVIN, w.clock.now());

    const restarted = w.restart();
    await restarted.start();
    await restarted.settle();
    const state = await readLifeState(w.storage, "ella");
    expect(state.epoch).toBe(2);
    expect(state.summary).toBe("We celebrated in Bake Club.");
    // An owner forget is not a DM forget: no rate-limit trace of him (review F6).
    expect(state.scrubbedAt[KEVIN]).toBeUndefined();
    expect(await readPendingScrubs(w.storage, "ella")).toEqual([]);
    expect((await readMaintenanceReports(w.storage, "ella")).map((report) => [report.kind, report.source ?? report.summary])).toEqual([
      ["forget", "owner"],
      ["maintenance", DREAM_NOTHING_NEW]
    ]);
    // The scrub's notes session; the dream after it found nothing new and called no model.
    expect(w.ledger.lines.map((line) => line.purpose)).toEqual(["life", "life", "life", "compaction", "maintenance"]);
  }, 30_000);

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
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    const dm = w.discord.post(dmOf("ella"), "hello ella");
    await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: dm.id, createdAt: dm.createdAt });
    w.cast.intake.flushDms();
    await w.cast.settle();
    await w.cast.life("ella").runNow();
    const first = await w.cast.forgetInLife({ waifuId: "ella", userId: KEVIN, source: "dm", scope: "everything" });
    expect(first.queued).toBeUndefined();
    w.clock.advance(60 * 60_000);
    const second = await w.cast.forgetInLife({ waifuId: "ella", userId: KEVIN, source: "dm", scope: "everything" });
    expect(second).toMatchObject({ queued: true });
    expect((await readPendingScrubs(w.storage, "ella")).map((scrub) => scrub.userId)).toEqual([KEVIN]);
    // Maintenance (05:00 local; next day) runs the pending scrub, then clears the queue.
    w.clock.ms = Date.parse("2026-10-25T05:30:00.000Z");
    await w.cast.scheduler.tick();
    expect(await readPendingScrubs(w.storage, "ella")).toEqual([]);
    expect(JSON.parse(await readFile(pendingScrubsPath(w.root, "ella"), "utf8"))).toEqual({ scrubs: [] });
    const reports = await readMaintenanceReports(w.storage, "ella");
    expect(reports.map((report) => [report.kind, report.source])).toEqual([
      ["forget", "dm"],
      ["forget", "pending"],
      ["maintenance", undefined]
    ]);
  });

  it("/forget conversation runs steps 0–2 only: the summary leaves the chat out; notes stay", async () => {
    // A direct (dm) wake that ends in text gets one unsent-reply check, then the summary.
    const w = await lifeWorld(roots, { scripts: script(textTurn("hello!"), textTurn("no need to reply"), textTurn("A quiet day.")) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    const dm = w.discord.post(dmOf("ella"), "hi");
    await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: dm.id, createdAt: dm.createdAt });
    w.cast.intake.flushDms();
    await w.cast.settle();
    await w.cast.life("ella").runNow();
    const notes = homeOf(w, "ella");
    await notes.write("people/kevin.md", "# Kevin\n- says hi\n");
    await w.cast.forgetInLife({ waifuId: "ella", userId: KEVIN, source: "dm", scope: "conversation" });
    const state = await readLifeState(w.storage, "ella");
    expect(state.summary).toBe("A quiet day.");
    // The epoch starts at once: the old log with the chat is gone now, not at her next turn.
    expect(state.pendingEpochStart).toBeFalsy();
    expect(state.epoch).toBe(2);
    await expect(readFile(path.join(w.root, "user/waifus/ella/life/log/1.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await notes.read("people/kevin.md")).toBe("# Kevin\n- says hi\n");
    expect(w.anthropic.calls).toHaveLength(3);
    expect(await readPendingScrubs(w.storage, "ella")).toEqual([]);
  });

  it("the DM rate limit holds for both scopes and comes before any abort: inside 6 hours nothing of her life is touched", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hello!"), textTurn("no need to reply"), textTurn("A quiet day.")) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    const dm = w.discord.post(dmOf("ella"), "hi");
    await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: dm.id, createdAt: dm.createdAt });
    w.cast.intake.flushDms();
    await w.cast.settle();
    await w.cast.life("ella").runNow();
    await w.cast.forgetInLife({ waifuId: "ella", userId: KEVIN, source: "dm", scope: "conversation" });
    const abort = vi.spyOn(w.cast.life("ella"), "abort");
    const callsBefore = w.anthropic.calls.length;
    w.clock.advance(30 * 60_000);
    for (const scope of ["conversation", "everything", "conversation"] as const) {
      expect(await w.cast.forgetInLife({ waifuId: "ella", userId: KEVIN, source: "dm", scope })).toMatchObject({ queued: true });
    }
    expect(abort).not.toHaveBeenCalled();
    expect(w.anthropic.calls).toHaveLength(callsBefore);
    // One queued entry, never weakened back to the conversation scope, with his names kept.
    expect(await readPendingScrubs(w.storage, "ella")).toEqual([{ userId: KEVIN, at: w.clock.now().toISOString(), source: "dm_forget_everything", names: ["Kevin"] }]);
    // Past the window it runs again.
    w.clock.advance(6 * 3_600_000);
    expect((await w.cast.forgetInLife({ waifuId: "ella", userId: KEVIN, source: "dm", scope: "conversation" })).queued).toBeUndefined();
    expect(abort).toHaveBeenCalledWith("forget");
  });

  it("identity: names are read before the DM data goes; a user-<tail> handle is no name; José and jose match both ways", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("Summary."), textTurn("done")) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    const dmKey = `dm_${KEVIN}_ella`;
    await updateLifeFile(w.storage, "ella", "handles", (file) => ({ ...file, handles: { "dm/user-4321": dmKey }, primary: { [dmKey]: "dm/user-4321" } }));
    expect(await w.cast.forgetIdentity("ella", KEVIN)).toEqual({ userId: KEVIN, names: [], sharedNames: [] });
    const notes = homeOf(w, "ella");
    await notes.write("people/mina.md", "# Mina\n- Mina is a user of the bake club app.\n- Loves lemon tarts.\n");
    await notes.write("me.md", "# Me\n- jose taught me flan.\n- I love flan.\n");
    await updateLifeFile(w.storage, "ella", "handles", (file) => ({ ...file, handles: { "dm/jose": dmKey }, primary: { [dmKey]: "dm/jose" } }));
    await w.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "José", channelId: "dm", messageId: "900000000000000123", createdAt: w.clock.now().toISOString() });
    const prepared = (await w.cast.prepareForget({ waifuId: "ella", userId: KEVIN, source: "owner", scope: "everything" }))!;
    // DM state "José" and the handle's "jose" are one name (diacritics folded); the first spelling stays.
    expect(prepared.identity.names).toEqual(["José"]);
    // The names travel with the queued scrub, so a later run (after the DM state is gone) still has them.
    expect((await readPendingScrubs(w.storage, "ella"))[0]).toMatchObject({ source: "owner_forget", names: ["José"] });
    await dmForget(w.storage, { userId: KEVIN, waifuId: "ella", scope: "all" });
    // Collected now, only the handle's slug is left: the display name went with the DM state.
    expect((await w.cast.forgetIdentity("ella", KEVIN))!.names).toEqual(["jose"]);
    await w.cast.runForget(prepared);
    expect(await notes.read("me.md")).toBe("# Me\n- I love flan.\n");
    expect(await notes.read("people/mina.md")).toBe("# Mina\n- Mina is a user of the bake club app.\n- Loves lemon tarts.\n");
  });
});

describe("forget: person notes, failures and the archive (§7.5, D-b)", () => {
  it("leaves nothing keyed by him: word watches naming him, his DM cursor, recent web queries; scrubbedAt only within 6 hours", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("done")) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await seedMembers(w);
    await homeOf(w, "ella").write("MEMORY.md", "# Memory\n");
    const now = w.clock.now().toISOString();
    await writeHerFile(
      w,
      "life/watches.json",
      JSON.stringify([
        { timeout: "2026-10-25 14:00", once: false, note: "", when: [{ place: "bake-club/#general", words: ["kevin's exam"] }] },
        { timeout: "2026-10-25 14:00", once: false, note: "", when: [{ place: "bake-club/#general", words: ["brownies"] }] }
      ])
    );
    await updateLifeFile(w.storage, "ella", "reads", (file) => ({ ...file, cursors: { [`dm_${KEVIN}_ella`]: { lastReadMessageId: "900000000000000001", at: now }, [ROOM_KEY]: { lastReadMessageId: "900000000000000002", at: now } } }));
    await updateLifeState(w.storage, "ella", (state) => ({ ...state, scrubbedAt: { "300000000000000111": new Date(w.clock.ms - 7 * 3_600_000).toISOString() } }));
    await w.storage.writeJson("search-usage", "user/search/usage.json", SearchUsageSchema, SearchUsageSchema.parse({
      ...createRevisionedBase(),
      recent: [
        { at: now, waifuId: "ella", kind: "search", query: "kevbaker chemistry results", ok: true },
        { at: now, waifuId: "ella", kind: "search", query: "lemon tart recipe", ok: true }
      ]
    }));
    await w.cast.forgetPerson(KEVIN);
    expect((await herEntries(w, "watches.json")).map((watch) => watch["id"])).toEqual(["w2"]);
    expect(Object.keys((await readLifeFile(w.storage, "ella", "reads")).cursors)).toEqual([ROOM_KEY]);
    const usage = JSON.parse(await readFile(path.join(w.root, "user/search/usage.json"), "utf8")) as { recent: Array<{ query: string }> };
    expect(usage.recent.map((entry) => entry.query)).toEqual(["lemon tart recipe"]);
    // The 7-hour-old entry is pruned, and an owner forget leaves no rate-limit trace (review F6).
    expect((await readLifeState(w.storage, "ella")).scrubbedAt).toEqual({});
  });

  it("a waifu with only queued wakes (no state yet) is scrubbed too: her life folder counts", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "ella", name: "Ella", botId: "ella-bot" }, { id: "mina", name: "Mina", botId: "mina-bot" }] });
    await enqueueWake(w.storage, "mina", { id: newWakeId(), reason: "dm", placeKey: `dm_${KEVIN}_mina`, fromUserId: KEVIN, fromName: "Kevin", at: w.clock.now().toISOString() });
    expect((await waifusWithLife(w.storage)).map((waifu) => waifu.id)).toEqual(["mina"]);
    const queued = await queueOwnerScrubs(w.storage, KEVIN, w.clock.now());
    expect(queued.map((entry) => entry.waifu.id)).toEqual(["mina"]);
  });

  it("a note marked as his is deleted whole with its index links; a people/ note headed by his unique name too; a shared heading is reviewed", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("Summary."), textTurn("nothing else")) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await seedMembers(w);
    const notes = homeOf(w, "ella");
    await notes.write("people/kevin-0003.md", `# Kev\n<!-- user:${KEVIN} -->\n\n- Allergic to peanuts.\n- Studies chemistry.\n`);
    await notes.write("people/kevin.md", "# Kevin\n\n- Is going through a divorce.\n");
    await notes.write("people/sam.md", "# Sam\n\n- Likes jazz.\n");
    await notes.write("people/mina.md", `# Mina\n<!-- user:${MINA_USER} -->\n\n- Runs the bake sale.\n`);
    await notes.write("misc.md", "# Misc\n\n## Kevin\n- the exam is on Friday\n");
    await notes.write("MEMORY.md", "# Memory\n- [Kev](people/kevin-0003.md) — peanuts\n- [Kev's other note](people/kevin.md) — divorce\n- [Mina](people/mina.md) — bake sale\n- [Sam](people/sam.md) — jazz\n");
    const result = await w.cast.forgetPerson(KEVIN);
    expect(result.scrubbed[0]).toMatchObject({ removedNotes: 2 });
    expect(await notes.read("people/kevin-0003.md")).toBeUndefined();
    expect(await notes.read("people/kevin.md")).toBeUndefined();
    expect(await notes.read("people/mina.md")).toContain("Runs the bake sale.");
    expect(await notes.read("people/sam.md")).toBe("# Sam\n\n- Likes jazz.\n");
    expect(await notes.read("MEMORY.md")).toBe("# Memory\n- [Mina](people/mina.md) — bake sale\n- [Sam](people/sam.md) — jazz\n");
    expect(await notes.read("misc.md")).toBe("# Misc\n\n- the exam is on Friday\n");
    expect(result.scrubbed[0]!.needsReview).toEqual(
      expect.arrayContaining([
        { where: "~/people/sam.md", line: '(a note headed "Sam" may be about them)' },
        { where: "~/misc.md", line: "(a heading naming them was removed; check the rest of this note)" }
      ])
    );
  });

  it("a failed notes scrub keeps the scrub queued; it runs again (and clears) at maintenance", async () => {
    const w = await lifeWorld(roots, { scripts: script(errorTurn({ code: "server", message: "overloaded", status: 500, retryable: false })) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await homeOf(w, "ella").write("me.md", "# Me\n- likes tea\n");
    const result = await w.cast.forgetPerson(KEVIN);
    expect(result.scrubbed[0]).toMatchObject({ queued: true });
    expect((await readPendingScrubs(w.storage, "ella")).map((scrub) => scrub.source)).toEqual(["owner_forget"]);
    expect((await readMaintenanceReports(w.storage, "ella")).find((report) => report.kind === "forget")).toMatchObject({ notesScrub: "pending" });
    // Her nightly maintenance runs it again; this time the notes scrub works and the queue clears.
    w.anthropic.scripts.splice(0, w.anthropic.scripts.length, ...script(textTurn("nothing about him"), textTurn("all tidy")));
    w.clock.ms = Date.parse("2026-10-25T05:30:00.000Z");
    await w.cast.scheduler.tick();
    expect(await readPendingScrubs(w.storage, "ella")).toEqual([]);
  });
});

describe("a queued scrub without her model (§7.5 step 4)", () => {
  const NO_MODEL = { id: "ella", name: "Ella", botId: "ella-bot", model: undefined };
  const dmKey = `dm_${KEVIN}_ella`;

  /** Kevin in her notes, a file from his DM, a wake of his and a dm_forget_everything scrub waiting for maintenance. */
  async function seedQueuedForget(w: LifeWorld): Promise<void> {
    const notes = homeOf(w, "ella");
    await notes.write("people/kevin.md", `# Kevin\n<!-- user:${KEVIN} -->\n\n- Studies chemistry.\n`);
    await notes.write("me.md", "# Me\n- Kevin taught me to fold croissants.\n- I like rye bread.\n");
    await notes.write("MEMORY.md", "# Memory\n- [Kevin](people/kevin.md) — chemistry student\n- [Me](me.md) — about me\n");
    const store = homeStoreFor(w.cast.deps, await readWaifu(w.storage, "ella"));
    const target = store.resolve("/tmp/dm/kevin/a1-photo.txt");
    if (!target.ok) throw new Error(target.error);
    expect(await store.saveDownload(target.path, Buffer.from("kevin's photo"), { placeKey: dmKey, authorId: KEVIN, messageId: "1", attachmentId: "1", downloadedAt: w.clock.now().toISOString() })).toBe(true);
    await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "dm", placeKey: dmKey, fromUserId: KEVIN, fromName: "Kevin", preview: "are you there?", messageId: "900000000000000111", at: w.clock.now().toISOString() });
    await queuePendingScrub(w.storage, "ella", KEVIN, w.clock.now(), { source: "dm_forget_everything", names: ["Kevin"], sharedNames: [] });
  }

  async function expectScrubbedWithoutModel(w: LifeWorld): Promise<void> {
    expect(await readPendingScrubs(w.storage, "ella")).toEqual([]);
    // Files by hash, his wake, his marked note and its index line, the line naming him in prose notes.
    expect(await homeOf(w, "ella").read("people/kevin.md")).toBeUndefined();
    expect(await homeOf(w, "ella").read("me.md")).toBe("# Me\n- I like rye bread.\n");
    expect(await homeOf(w, "ella").read("MEMORY.md")).toBe("# Memory\n- [Me](me.md) — about me\n");
    await expect(readFile(path.join(w.root, "user/waifus/ella/tmp/dm/kevin/a1-photo.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readLifeFile(w.storage, "ella", "wakes")).immediate.filter((wake) => wake.fromUserId === KEVIN)).toEqual([]);
    // What happened is recorded: the skipped notes session in the review and the report.
    expect((await readNeedsReview(w.storage, "ella")).map((item) => item.line)).toContain(NOTES_SCRUB_SKIPPED);
    expect((await readMaintenanceReports(w.storage, "ella")).find((report) => report.kind === "forget")).toMatchObject({ source: "pending", notesScrub: "skipped" });
    expect(w.ledger.lines).toEqual([]);
  }

  it("nightly maintenance still runs it: everything deterministic, her notes by whole lines, and the entry clears", async () => {
    const w = await lifeWorld(roots, { waifus: [NO_MODEL] });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await seedQueuedForget(w);
    // No bed time: maintenance at 05:00 local, the next day.
    w.clock.ms = Date.parse("2026-10-25T05:30:00.000Z");
    await w.cast.scheduler.tick();
    await expectScrubbedWithoutModel(w);
  });

  it("a night she never sleeps through (§21.6c) runs it when her bed time ends, without a model", async () => {
    const w = await lifeWorld(roots, { waifus: [{ ...NO_MODEL, availability: { bedTime: { enabled: true, start: "23:00", end: "07:00" } } }] });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await seedQueuedForget(w);
    w.clock.ms = Date.parse("2026-10-25T07:01:00.000Z");
    await w.cast.scheduler.tick();
    await expectScrubbedWithoutModel(w);
  });

  it("life.dreamModel runs the notes scrub when her own model is unavailable", async () => {
    const w = await lifeWorld(roots, {
      waifus: [{ ...NO_MODEL, model: { providerId: "anthropic", modelId: "no-such-model" } }],
      scripts: script(textTurn("removed him from my notes"))
    });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    w.setConfig((config) => ({ ...config, life: { ...config.life, dreamModel: { providerId: "anthropic", modelId: "claude-haiku-5-5" } } }));
    await seedQueuedForget(w);
    w.clock.ms = Date.parse("2026-10-25T05:30:00.000Z");
    await w.cast.scheduler.tick();
    expect(await readPendingScrubs(w.storage, "ella")).toEqual([]);
    expect(w.ledger.lines[0]).toMatchObject({ purpose: "maintenance", modelId: "claude-haiku-5-5" });
    const report = (await readMaintenanceReports(w.storage, "ella")).find((line) => line.kind === "forget");
    expect(report).toMatchObject({ source: "pending", notesModel: "dream" });
    expect(report).not.toHaveProperty("notesScrub");
    expect((await readNeedsReview(w.storage, "ella")).map((item) => item.line)).not.toContain(NOTES_SCRUB_SKIPPED);
    expect(await homeOf(w, "ella").read("people/kevin.md")).toBeUndefined();
  });
});

describe("a queued forget never wipes her summary for want of a model (§7.5 step 2)", () => {
  const SUMMARY = "Kevin passed his exam. Mina baked lemon tarts.";

  /** A life with an epoch and a summary naming Kevin, then her model (and the route her epoch ran on) gone. */
  async function livedThenModelGone(w: LifeWorld): Promise<number> {
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await liveATurn(w);
    const epoch = (await updateLifeState(w.storage, "ella", (state) => ({ ...state, summary: SUMMARY, modelRoute: { providerId: "anthropic", modelId: "retired-model" } }))).epoch;
    await writeWaifuConfig(w.storage, { id: "ella", name: "Ella", botId: "ella-bot", model: { providerId: "anthropic", modelId: "no-such-model" } });
    await homeOf(w, "ella").write("me.md", "# Me\n- Kevin taught me to fold croissants.\n- I like rye bread.\n");
    await queuePendingScrub(w.storage, "ella", KEVIN, w.clock.now(), { source: "dm_forget_everything", names: ["Kevin"], sharedNames: [] });
    w.clock.ms = Date.parse("2026-10-25T05:30:00.000Z");
    return epoch;
  }

  const TURN = [toolTurn([{ name: "ReadMessages", input: { place: "bake-club/#general" } }]), toolTurn([{ name: "SendMessage", input: { place: "bake-club/#general", text: "congrats!!" } }]), textTurn("so happy")];

  it("her model missing: life.dreamModel rewrites the summary", async () => {
    const w = await lifeWorld(roots, { scripts: script(...TURN, textTurn("Mina baked lemon tarts."), textTurn("nothing else about him")) });
    await livedThenModelGone(w);
    w.setConfig((config) => ({ ...config, life: { ...config.life, dreamModel: { providerId: "anthropic", modelId: "claude-haiku-5-5" } } }));
    await w.cast.scheduler.tick();
    expect(await readPendingScrubs(w.storage, "ella")).toEqual([]);
    expect(w.ledger.lines.find((line) => line.purpose === "compaction")).toMatchObject({ modelId: "claude-haiku-5-5" });
    const state = await readLifeState(w.storage, "ella");
    expect(state.summary).toBe("Mina baked lemon tarts.");
    expect(await homeOf(w, "ella").read("me.md")).toBe("# Me\n- I like rye bread.\n");
  });

  it("no model at all: the summary and epoch stay, every other step runs, and the summary step runs once a model is back", async () => {
    const w = await lifeWorld(roots, { scripts: script(...TURN, textTurn("Mina baked lemon tarts.")) });
    const epoch = await livedThenModelGone(w);
    const callsBefore = w.anthropic.calls.length;
    await w.cast.scheduler.tick();
    let state = await readLifeState(w.storage, "ella");
    expect(state.summary).toBe(SUMMARY);
    expect(state.epoch).toBe(epoch);
    expect(state.pendingEpochStart).toBeFalsy();
    await expect(readFile(path.join(w.root, `user/waifus/ella/life/log/${epoch}.jsonl`), "utf8")).resolves.toBeTruthy();
    expect(w.anthropic.calls).toHaveLength(callsBefore);
    // The other steps ran: her notes lost the line naming him; the report says what waits.
    expect(await homeOf(w, "ella").read("me.md")).toBe("# Me\n- I like rye bread.\n");
    expect((await readMaintenanceReports(w.storage, "ella")).find((report) => report.kind === "forget")).toMatchObject({ notesScrub: "skipped", summaryScrub: "pending" });
    expect(await readPendingScrubs(w.storage, "ella")).toMatchObject([{ userId: KEVIN, summaryOnly: true }]);
    // Another night without a model: still waiting, still untouched.
    w.clock.ms = Date.parse("2026-10-26T05:30:00.000Z");
    await w.cast.scheduler.tick();
    expect((await readLifeState(w.storage, "ella")).summary).toBe(SUMMARY);
    expect(await readPendingScrubs(w.storage, "ella")).toHaveLength(1);
    // Her model is back: the summary step runs before her next turn, and only it.
    await writeWaifuConfig(w.storage, { id: "ella", name: "Ella", botId: "ella-bot" });
    await w.cast.life("ella").runNow();
    expect(await readPendingScrubs(w.storage, "ella")).toEqual([]);
    state = await readLifeState(w.storage, "ella");
    expect(state.summary).toBe("Mina baked lemon tarts.");
    expect(state.epoch).toBeGreaterThan(epoch);
    expect(w.ledger.lines.filter((line) => line.purpose === "maintenance")).toEqual([]);
    expect((await readMaintenanceReports(w.storage, "ella")).filter((report) => report.kind === "forget").at(-1)).toMatchObject({ summaryScrub: "done" });
  });
});
