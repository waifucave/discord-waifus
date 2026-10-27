// Forget's name rules (Living cast §7.4–§7.5; second verification pass F2–F9, F13): a name someone
// else has never removes their text, weak names and names without word boundaries are only listed
// for review, someone else's entries keep their place, stroke letters fold, review lines do not
// repeat or keep the person, kept copies of broken forget records lose them, and a waifu without a
// model still finishes her scrub.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTES_SCRUB_SKIPPED, recordNeedsReview, scrubOtherState, scrubText, type ReviewLine } from "../src/life/forget.js";
import { readLifeFile, readLifeState, readMaintenanceReports, updateLifeFile, updateLifeState } from "../src/life/lifeStore.js";
import { isWeakName, namesSomeone, personMatcher } from "../src/life/text.js";
import { EventStream } from "../src/api/eventStream.js";
import { forgetCapturedTraffic, recentQueries, recordProviderQuery } from "../src/shared/queryLog.js";
import { enqueueWake, newWakeId } from "../src/life/wakeQueue.js";
import { updateDmState } from "../src/orchestration/dm/dmStore.js";
import { forgetUser } from "../src/orchestration/dm/forgetUser.js";
import { pruneForgetRecordCopies, queuePendingScrub, readPendingScrubs } from "../src/orchestration/dm/forgotten.js";
import { textTurn } from "./modelFakes.js";
import { closeWorlds, herEntries, homeOf, KEVIN, lifeWorld, MINA_USER, ROOM_KEY, script, writeHerFile } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const KEVIN_2 = "300000000000009999";
const verify = () => ({ removedLines: 0, removedSentences: 0, removedNotes: 0, needsReview: [] as ReviewLine[] });

describe("two people share a name (F2, F13)", () => {
  it("forgetting one Kevin deletes his note and link, and never touches the other Kevin's", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("nothing about him in my notes")) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await updateDmState(w.storage, { userId: KEVIN, waifuId: "ella", botId: "ella-bot" }, (state) => ({ ...state, userDisplayName: "Kevin" }));
    const notes = homeOf(w, "ella");
    const theirs = `# Kevin\n<!-- user:${KEVIN_2} -->\n\n- The other Kevin plays jazz piano.\n- Has a dog named Biscuit.\n`;
    await notes.write("people/kevin-0003.md", `# Kevin\n<!-- user:${KEVIN} -->\n\n- Studies chemistry.\n`);
    await notes.write("people/kevin-9999.md", theirs);
    await notes.write("MEMORY.md", "# Memory\n- [Kevin](people/kevin-9999.md) — The other Kevin plays jazz piano.\n- [Kevin](people/kevin-0003.md) — Studies chemistry.\n");
    await notes.write("misc.md", "# Misc\n- Kevin brought scones.\n");
    // The other Kevin's note heading makes the name shared.
    expect(await w.cast.forgetIdentity("ella", KEVIN)).toMatchObject({ names: [], sharedNames: ["Kevin"] });

    const result = await w.cast.forgetPerson(KEVIN);
    expect(await notes.read("people/kevin-0003.md")).toBeUndefined();
    expect(await notes.read("people/kevin-9999.md")).toBe(theirs);
    expect(await notes.read("MEMORY.md")).toBe("# Memory\n- [Kevin](people/kevin-9999.md) — The other Kevin plays jazz piano.\n");
    // Which Kevin brought scones is the owner's call.
    expect(await notes.read("misc.md")).toBe("# Misc\n- Kevin brought scones.\n");
    expect(result.scrubbed[0]!.needsReview).toEqual(expect.arrayContaining([{ where: "~/misc.md", line: "- Kevin brought scones." }]));
  });

  it("a unique name inside a note marked as someone else's, or its index line, is listed for review, never removed", () => {
    const identity = { userId: KEVIN, names: ["Quillon"], sharedNames: [] };
    const out = verify();
    const note = `# Mina\n<!-- user:${MINA_USER} -->\n\n- Bakes with Quillon on Sundays.\n- Friends with <@${KEVIN}>.\n`;
    // The id is proof and goes; the name is listed.
    expect(scrubText(note, identity, "notes/people/mina.md", out, { reviewOnly: true })).toBe(`# Mina\n<!-- user:${MINA_USER} -->\n\n- Bakes with Quillon on Sundays.\n`);
    expect(out.needsReview).toEqual([{ where: "notes/people/mina.md", line: "- Bakes with Quillon on Sundays." }]);
    const index = "# Memory\n- [Mina](people/mina.md) — bakes with Quillon\n- [Misc](misc.md) — Quillon's exam\n";
    const kept = scrubText(index, identity, "notes/MEMORY.md", out, { protectedLine: (line) => line.includes("](people/mina.md)") });
    expect(kept).toBe("# Memory\n- [Mina](people/mina.md) — bakes with Quillon\n");
  });
});

describe("step 3 with weak and unique names (F3)", () => {
  it("a weak name never removes or blanks anything; its matches are listed for review", async () => {
    const w = await lifeWorld(roots);
    const now = w.clock.now().toISOString();
    await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "mention", placeKey: ROOM_KEY, fromUserId: MINA_USER, fromName: "Mina", preview: "ok so are we baking saturday @Ella?", messageId: "900000000000000111", at: now });
    await writeHerFile(
      w,
      "life/reminders.json",
      JSON.stringify([
        { at: "2026-10-24 15:00", note: "check the sourdough starter is ok" },
        { at: "2026-10-24 15:00", note: "buy flour" }
      ])
    );
    const review: ReviewLine[] = [];
    const deps = (w.cast as unknown as { deps: Parameters<typeof scrubOtherState>[0] }).deps;
    const waifu = { id: "ella", name: "Ella", displayName: "Ella" } as Parameters<typeof scrubOtherState>[1];
    await scrubOtherState(deps, waifu, { userId: "300000000000000099", names: [], sharedNames: ["ok"] }, { review: (item) => review.push(item) });
    expect((await readLifeFile(w.storage, "ella", "wakes")).immediate.map((wake) => wake.preview)).toEqual(["ok so are we baking saturday @Ella?"]);
    expect((await herEntries(w, "reminders.json")).map((reminder) => reminder["note"])).toEqual(["check the sourdough starter is ok", "buy flour"]);
    expect(review).toEqual([
      { where: "wakes", line: "ok so are we baking saturday @Ella?" },
      { where: "reminders", line: "check the sourdough starter is ok" }
    ]);
  });

  it("someone else's wake naming the person keeps its place and loses its preview; her reminder loses its text", async () => {
    const w = await lifeWorld(roots);
    const now = w.clock.now().toISOString();
    await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "mention", placeKey: ROOM_KEY, fromUserId: MINA_USER, fromName: "Mina", preview: "did Quillon pass the exam @Ella?", messageId: "900000000000000111", at: now });
    await writeHerFile(w, "life/reminders.json", JSON.stringify([{ at: "2026-10-24 15:00", note: "ask Quillon about the exam" }]));
    const deps = (w.cast as unknown as { deps: Parameters<typeof scrubOtherState>[0] }).deps;
    const waifu = { id: "ella", name: "Ella", displayName: "Ella" } as Parameters<typeof scrubOtherState>[1];
    await scrubOtherState(deps, waifu, { userId: KEVIN, names: ["Quillon"], sharedNames: [] });
    const wakes = (await readLifeFile(w.storage, "ella", "wakes")).immediate;
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ fromUserId: MINA_USER, messageId: "900000000000000111" });
    expect(wakes[0]!.preview).toBeUndefined();
    expect((await herEntries(w, "reminders.json")).map((reminder) => [reminder["id"], reminder["note"]])).toEqual([["r1", "(removed)"]]);
  });
});

describe("the traffic matcher and watch words (third review, minor 1 and 4)", () => {
  it("finds a name after a line break or tab in a value, an id in a key, and never a name in a key", () => {
    const match = personMatcher(KEVIN, ["Kevinator"]);
    expect(match({ prompt: "[transcript]\nKevinator: my address is 12 Elm St" })).toBe(true);
    expect(match({ text: "a\tKevinator" })).toBe(true);
    expect(match({ text: "x\r\nKevinator wrote" })).toBe(true);
    expect(match([{ nested: [{ deeper: "said Kevinator" }] }])).toBe(true);
    expect(match({ mentions: { users: { [KEVIN]: "someone" } } })).toBe(true);
    expect(match({ Kevinator: "a key is not a name" })).toBe(false);
    expect(match({ text: "Kevinators unite" })).toBe(false);
    // Raw JSON text (a torn record copy's line) keeps its escapes.
    expect(match('{"text":"hi\\nKevinator"}')).toBe(true);
  });

  it("the captured traffic and the replay lose an entry whose name follows a line break", () => {
    const stream = new EventStream<unknown>();
    stream.publish("query", { prompt: "[transcript]\nKevinator: my address is 12 Elm St" });
    stream.publish("query", { prompt: "[transcript] Kevinator: my phone is 555" });
    stream.publish("query", { prompt: "[transcript]\nMina: the bake sale is on" });
    const match = personMatcher(KEVIN, ["Kevinator"]);
    expect(stream.dropReplay((record) => match(record.data))).toBe(2);
    recordProviderQuery("assistant", { messages: [{ role: "user", content: "[transcript]\nKevinator: hi" }] });
    forgetCapturedTraffic(match);
    expect(JSON.stringify(recentQueries())).not.toContain("Kevinator");
  });

  it("a watch goes only when its word names the person; a word inside one of their names is listed", async () => {
    const w = await lifeWorld(roots);
    const watch = (word: string, note: string) => ({ timeout: "2026-10-24 15:00", once: false, note, when: [{ words: [word] }] });
    await writeHerFile(w, "life/watches.json", JSON.stringify([watch("sourdough", "Mina's sourdough question"), watch("bake sale", "the bake sale plan"), watch("kevin", "an exam"), watch("kevin from the bake sale", "him")]));
    const deps = (w.cast as unknown as { deps: Parameters<typeof scrubOtherState>[0] }).deps;
    const waifu = { id: "ella", name: "Ella", displayName: "Ella" } as Parameters<typeof scrubOtherState>[1];
    const review: ReviewLine[] = [];
    await scrubOtherState(deps, waifu, { userId: KEVIN, names: ["Kevin from the Bake Sale"], sharedNames: [] }, { review: (item) => review.push(item) });
    expect((await herEntries(w, "watches.json")).map((entry) => entry["id"])).toEqual(["w1", "w2", "w3"]);
    expect(review).toEqual(expect.arrayContaining([{ where: "watches", line: "bake sale" }, { where: "watches", line: "kevin" }]));
  });
});

describe("names that are words, and names without word boundaries (F4, F5)", () => {
  it("common chat and server words are weak", () => {
    for (const word of ["server", "nobody", "everybody", "thanks", "general", "channel", "okay", "yeah"]) expect(isWeakName(word), word).toBe(true);
    for (const name of ["Quillon", "Kevin", "さくら"]) expect(isWeakName(name), name).toBe(false);
  });

  it("a weak name given as unique, or a unique name without word boundaries, is only listed for review", () => {
    const out = verify();
    const text = "# Me\n- はなし is a story word.\n- はなび tonight!\n- The server is down. Nobody knows why.";
    expect(scrubText(text, { userId: KEVIN, names: ["はな", "server", "nobody"], sharedNames: [] }, "notes/me.md", out)).toBe(text);
    expect(out.removedLines + out.removedSentences).toBe(0);
    expect(out.needsReview.map((item) => item.line)).toEqual(["- はなし is a story word.", "- はなび tonight!", "- The server is down. Nobody knows why."]);
  });

  it("letters with strokes and ligatures fold both ways", () => {
    const pairs: Array<[string, string]> = [
      ["Søren", "soren said"],
      ["Soren", "Søren said"],
      ["Łukasz", "lukasz said"],
      ["Lukasz", "Łukasz said"],
      ["Æsa", "aesa said"],
      ["Aesa", "Æsa said"],
      ["Straße", "strasse"],
      ["Đorđe", "dorde"],
      ["Œlla", "oella"],
      ["Þóra", "thora"],
      ["José", "jose taught me"]
    ];
    for (const [name, text] of pairs) expect(namesSomeone(text, name), `${name} in ${text}`).toBe(true);
    expect(namesSomeone("sorensen said", "Søren")).toBe(false);
  });
});

describe("review lines and records (F7, F9)", () => {
  it("a review line already listed is not repeated", async () => {
    const w = await lifeWorld(roots);
    const line = { where: "notes/me.md", line: "- Sam is funny." };
    await recordNeedsReview(w.storage, "ella", w.clock.now(), "owner", [line, line]);
    w.clock.advance(60_000);
    await recordNeedsReview(w.storage, "ella", w.clock.now(), "owner", [line, { where: "summary", line: "Sam came by." }]);
    const file = JSON.parse(await readFile(path.join(w.root, "user/waifus/ella/life/needs-review.json"), "utf8")) as { items: Array<{ at: string; line: string }> };
    expect(file.items.map((item) => [item.line, item.at])).toEqual([
      ["- Sam is funny.", w.clock.now().toISOString()],
      ["Sam came by.", w.clock.now().toISOString()]
    ]);
  });

  it("a forget drops earlier review lines that carry the person", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("nothing about him in my notes")) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await updateDmState(w.storage, { userId: KEVIN, waifuId: "ella", botId: "ella-bot" }, (state) => ({ ...state, userDisplayName: "Quillon" }));
    await recordNeedsReview(w.storage, "ella", w.clock.now(), "owner", [
      { where: "notes/misc.md", line: "- Quillon and Sam baked scones." },
      { where: "notes/misc.md", line: "- Sam is funny." }
    ]);
    await w.cast.forgetPerson(KEVIN);
    const raw = await readFile(path.join(w.root, "user/waifus/ella/life/needs-review.json"), "utf8");
    expect(raw).not.toContain("Quillon");
    expect(raw).toContain("Sam is funny");
  });

  it("kept copies of unreadable forget records lose the person, and go after 7 days", async () => {
    const w = await lifeWorld(roots);
    const people = path.join(w.root, "user/people");
    const life = path.join(w.root, "user/waifus/ella/life");
    await mkdir(people, { recursive: true });
    await mkdir(life, { recursive: true });
    const recent = new Date().toISOString().replace(/[:.]/gu, "-");
    await writeFile(path.join(people, `forgotten.json.corrupt-${recent}`), JSON.stringify({ forgotten: [{ userId: KEVIN, at: "2026-10-01T00:00:00.000Z" }, { userId: MINA_USER, at: "2026-10-01T00:00:00.000Z" }] }));
    await writeFile(path.join(life, `pending-scrubs.json.corrupt-${recent}`), `{"scrubs":[\n{"userId":"${KEVIN}","names":["Quillon"]},\n{"userId":"${MINA_USER}"\n`);
    await writeFile(path.join(people, "forgotten.json.corrupt-2026-09-01T00-00-00-000Z"), JSON.stringify({ forgotten: [{ userId: MINA_USER, at: "2026-08-01T00:00:00.000Z" }] }));
    await forgetUser(w.storage, { discordUserId: KEVIN, names: ["Quillon"] });
    const copies = (await readdir(people)).filter((name) => name.includes(".corrupt-"));
    expect(copies).toEqual([`forgotten.json.corrupt-${recent}`]);
    const forgottenCopy = await readFile(path.join(people, copies[0]!), "utf8");
    expect(forgottenCopy).not.toContain(KEVIN);
    expect(forgottenCopy).toContain(MINA_USER);
    const scrubsCopy = await readFile(path.join(life, `pending-scrubs.json.corrupt-${recent}`), "utf8");
    expect(scrubsCopy).not.toContain(KEVIN);
    expect(scrubsCopy).not.toContain("Quillon");
    expect(scrubsCopy).toContain(MINA_USER);
  });

  it("a DM user's forget scrubs her own kept pending-scrubs copies; a copy is named by the time it was made", async () => {
    const w = await lifeWorld(roots);
    const life = path.join(w.root, "user/waifus/ella/life");
    await mkdir(life, { recursive: true });
    const recent = new Date().toISOString().replace(/[:.]/gu, "-");
    await writeFile(path.join(life, `pending-scrubs.json.corrupt-${recent}`), `{"scrubs":[\n{"userId":"${KEVIN}","names":["Quillon"]},\n{"userId":"${MINA_USER}"\n`);
    const deps = (w.cast as unknown as { deps: Parameters<typeof scrubOtherState>[0] }).deps;
    const waifu = { id: "ella", name: "Ella", displayName: "Ella" } as Parameters<typeof scrubOtherState>[1];
    await scrubOtherState(deps, waifu, { userId: KEVIN, names: ["Quillon"], sharedNames: [] });
    const copy = await readFile(path.join(life, `pending-scrubs.json.corrupt-${recent}`), "utf8");
    expect(copy).not.toContain(KEVIN);
    expect(copy).toContain(MINA_USER);
    // A torn file found by a forget dated long ago: its copy carries today's time, so the 7-day
    // pruning keeps it.
    await writeFile(path.join(life, "pending-scrubs.json"), '{"scrubs":[{"userId":"3000');
    await queuePendingScrub(w.storage, "ella", KEVIN, new Date("2026-01-01T00:00:00.000Z"));
    await pruneForgetRecordCopies(w.storage, new Date());
    const copies = (await readdir(life)).filter((name) => name.startsWith("pending-scrubs.json.corrupt-") && name !== `pending-scrubs.json.corrupt-${recent}`);
    expect(copies).toHaveLength(1);
    const [, day, hh, mm, ss, ms] = /corrupt-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/u.exec(copies[0]!)!;
    expect(Math.abs(Date.now() - Date.parse(`${day}T${hh}:${mm}:${ss}.${ms}Z`))).toBeLessThan(60_000);
  });

  it("a waifu without a model finishes the owner's scrub: the notes session is recorded as skipped, once", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "ella", name: "Ella", botId: "ella-bot", model: undefined }] });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await homeOf(w, "ella").write("me.md", "# Me\n- Kevin taught me to fold croissants.\n");
    const first = await w.cast.forgetPerson(KEVIN);
    expect(first.scrubbed[0]).not.toHaveProperty("queued");
    expect(first.scrubbed[0]!.needsReview[0]).toEqual({ where: "notes", line: NOTES_SCRUB_SKIPPED });
    expect(await readPendingScrubs(w.storage, "ella")).toEqual([]);
    expect((await readMaintenanceReports(w.storage, "ella")).find((report) => report.kind === "forget")).toMatchObject({ notesScrub: "skipped" });
    // A second forget lists the skipped session once, not twice.
    await w.cast.forgetPerson(KEVIN);
    const file = JSON.parse(await readFile(path.join(w.root, "user/waifus/ella/life/needs-review.json"), "utf8")) as { items: Array<{ line: string }> };
    expect(file.items.filter((item) => item.line === NOTES_SCRUB_SKIPPED)).toHaveLength(1);
  });
});

describe("scrubbedAt (F6)", () => {
  it("an entry past the 6-hour window is pruned at boot", async () => {
    const w = await lifeWorld(roots);
    await updateLifeState(w.storage, "ella", (state) => ({
      ...state,
      scrubbedAt: { [KEVIN]: new Date(w.clock.ms - 7 * 3_600_000).toISOString(), [MINA_USER]: new Date(w.clock.ms - 3_600_000).toISOString() }
    }));
    await w.cast.stop();
    const again = w.restart();
    await again.start();
    expect(Object.keys((await readLifeState(w.storage, "ella")).scrubbedAt)).toEqual([MINA_USER]);
  });
});
