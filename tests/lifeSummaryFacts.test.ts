// Spec §35 (2026-10-30): what her summaries and dream notes may write as fact, the calendar they look
// dates up in, the people the dream should make a note for, the chat rule against invented memories,
// and the life benchmark's mention repair.
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { calendarStrip } from "../src/life/clock.js";
import { COMPACTION_INSTRUCTION } from "../src/life/compaction.js";
import type { GuildDirectory } from "../src/discord/guildDirectory.js";
import { recordForgottenPerson } from "../src/orchestration/dm/forgotten.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import { DREAM_INSTRUCTION, dreamWindow, newPeopleLine, peopleSheTalkedTo, peopleWithoutNotes, type DreamChunk } from "../src/life/dream.js";
import { LIFE_TEXT } from "../src/life/lifeHarness.js";
import { hasNoteFor } from "../src/life/people.js";
import { CACHE_REST_NOTICE, REST_NOTICE, SUMMARY_FACTS, isRestNotice } from "../src/life/rest.js";
import type { TranscriptLine } from "../src/life/transcripts/store.js";
import { runBenchmark } from "../scripts/life-benchmark/bench.js";
import { FakeAttachments, FakeServer, SimClock } from "../scripts/life-benchmark/fakeServer.js";
import { renderChat } from "../scripts/life-benchmark/grading.js";
import { defineScenario, type ScenarioInput } from "../scripts/life-benchmark/scenario.js";
import tiny from "../scripts/life-benchmark/scenarios/tiny.js";
import type { TranscriptEvent } from "../scripts/life-benchmark/types.js";
import { BASELINE } from "../scripts/life-benchmark/variants.js";
import { textTurn } from "./modelFakes.js";
import { CHANNEL, ELLA_BOT, GUILD, closeWorlds, dmOf, homeOf, KEVIN, lifeWorld, MINA_USER, seedTranscript, type LifeWorld } from "./lifeFixtures.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

describe("the calendar strip (§35.2)", () => {
  it("lists last, this and next week Monday first in her zone, today marked", () => {
    // Thu 26 Nov 2026, 10:00 in London.
    expect(calendarStrip(new Date("2026-11-26T10:00:00Z"), "Europe/London")).toBe(
      "Calendar as of Thu 26 Nov (look dates up here, don't count): " +
        "last week Mon 16 Nov · Tue 17 Nov · Wed 18 Nov · Thu 19 Nov · Fri 20 Nov · Sat 21 Nov · Sun 22 Nov; " +
        "this week Mon 23 Nov · Tue 24 Nov · Wed 25 Nov · Thu 26 Nov (today) · Fri 27 Nov · Sat 28 Nov · Sun 29 Nov; " +
        "next week Mon 30 Nov · Tue 1 Dec · Wed 2 Dec · Thu 3 Dec · Fri 4 Dec · Sat 5 Dec · Sun 6 Dec."
    );
  });

  it("takes today from her zone, not UTC, and a Sunday ends its week", () => {
    // 23:30 UTC on Sat 28 Nov is already Sun 29 Nov in Tokyo.
    const tokyo = calendarStrip(new Date("2026-11-28T23:30:00Z"), "Asia/Tokyo");
    expect(tokyo).toContain("this week Mon 23 Nov · Tue 24 Nov · Wed 25 Nov · Thu 26 Nov · Fri 27 Nov · Sat 28 Nov · Sun 29 Nov (today);");
    expect(calendarStrip(new Date("2026-11-28T23:30:00Z"), "UTC")).toContain("Sat 28 Nov (today)");
    expect(tokyo.match(/\(today\)/gu)).toHaveLength(1);
    // Dated in its own first words, so a copy left in her log never reads as a later day's.
    expect(tokyo.startsWith("Calendar as of Sun 29 Nov (look dates up here, don't count): ")).toBe(true);
  });

  it("crosses a year end and a DST change without losing a day", () => {
    expect(calendarStrip(new Date("2026-12-31T12:00:00Z"), "Europe/London")).toContain("this week Mon 28 Dec · Tue 29 Dec · Wed 30 Dec · Thu 31 Dec (today) · Fri 1 Jan · Sat 2 Jan · Sun 3 Jan; next week Mon 4 Jan");
    // London's clocks went back on Sun 25 Oct 2026.
    expect(calendarStrip(new Date("2026-10-27T09:00:00Z"), "Europe/London")).toContain("last week Mon 19 Oct · Tue 20 Oct · Wed 21 Oct · Thu 22 Oct · Fri 23 Oct · Sat 24 Oct · Sun 25 Oct; this week Mon 26 Oct · Tue 27 Oct (today)");
  });
});

describe("the prompt rules (§35.1, §35.3, §35.4)", () => {
  it("summaries keep guesses, plans and open threads as they were", () => {
    for (const text of [REST_NOTICE, CACHE_REST_NOTICE, COMPACTION_INSTRUCTION]) expect(text.split("\n").at(-1)).toBe(SUMMARY_FACTS);
    expect(SUMMARY_FACTS).toContain("a guess stays your guess");
    expect(SUMMARY_FACTS).toContain("a plan stays a plan (with its date) until someone says it happened");
    expect(SUMMARY_FACTS).toContain("questions nobody answered, plans nobody confirmed");
    // Her own <summary> is guided by block A alone.
    expect(LIFE_TEXT).toContain(`Keep names, times and facts exact. ${SUMMARY_FACTS}\n</life>`);
    // The rest notices still open like one.
    expect(isRestNotice(REST_NOTICE) && isRestNotice(CACHE_REST_NOTICE)).toBe(true);
  });

  it("the dream writes facts as said and in her voice", () => {
    expect(DREAM_INSTRUCTION).toContain("a guess stays her guess, a plan stays a plan (with its date) until someone says it happened");
    expect(DREAM_INSTRUCTION).toContain("Keep open threads open");
    expect(DREAM_INSTRUCTION).toContain('Write like her lines in /transcripts (the "you" lines): if she writes in lowercase, so do her notes.');
  });

  it("in chat she never claims a memory she doesn't have", () => {
    expect(LIFE_TEXT).toContain("Never claim you saw, heard or remember something that isn't in what you can see, your notes or /transcripts; if you're not sure, say so or ask.");
  });
});

describe("people with no note yet (§35.3)", () => {
  const notes = new Map([
    ["MEMORY.md", "- [Kevin](people/kevin.md)\n- Aiko is new"],
    ["people/kevin.md", "Kevin plays football."],
    ["friends/jade-lee.md", "she's lovely"],
    ["omar.md", "# Omar\nlikes dance games"],
    ["notes.md", "Rosa: duo partner"],
    ["places/bake-club.md", "Tom brought scones"],
    ["mine.md", "<!-- user:999 -->\nthat one"],
    ["life/schedule.json", "{\"aiko\": 1}"]
  ]);
  const has = (names: string[], userId = "1") => hasNoteFor(notes, { userId, names });

  it("a note is a file named, headed or titled after them, or marked as theirs", () => {
    expect(has(["Kevin"])).toBe(true);
    expect(has(["Jade"])).toBe(true);
    expect(has(["Jade Lee"])).toBe(true);
    expect(has(["omar"])).toBe(true);
    expect(has(["Rosa"])).toBe(true);
    expect(has(["Someone"], "999")).toBe(true);
    // Unicode stylings fold to the plain name.
    expect(has(["𝐊𝐞𝐯𝐢𝐧"])).toBe(true);
  });

  it("being mentioned elsewhere, MEMORY.md and ~/life/ are not a note", () => {
    expect(has(["Aiko"])).toBe(false);
    expect(has(["Tom"])).toBe(false);
  });

  it("any name they go by finds the note (a nickname note found for DMs under their global name)", () => {
    const home = new Map([["people/kev.md", "kev from #general, owes me a coffee"]]);
    expect(hasNoteFor(home, { userId: "1", names: ["Kevin"] })).toBe(false);
    expect(hasNoteFor(home, { userId: "1", names: ["Kevin", "Kev", "kevin_99"] })).toBe(true);
  });

  it("a heading of any level inside a shared file is a note for them", () => {
    const home = new Map([["friends.md", "# my people\n\n## Aiko\nnew in bake club\n\n### Tom\nscones guy\n"]]);
    for (const name of ["Aiko", "Tom", "Aiko Tanaka"]) expect(hasNoteFor(home, { userId: "1", names: [name] }), name).toBe(true);
    expect(hasNoteFor(home, { userId: "1", names: ["Jade"] })).toBe(false);
  });

  it("a title about something of theirs, or about several people, is not their note", () => {
    const home = new Map([
      ["tom-and-lou-movie-night.md", "we watched a thing"],
      ["notes/birthdays.md", "## Tom's birthday\nnovember"],
      ["people/jade-kim.md", "jade k"],
      ["kevin.md", "# Kevin (bake club)\nfootball"]
    ]);
    expect(hasNoteFor(home, { userId: "1", names: ["Tom"] })).toBe(false);
    expect(hasNoteFor(home, { userId: "1", names: ["Lou"] })).toBe(false);
    // A two-word name never matches by a note's first word alone…
    expect(hasNoteFor(home, { userId: "1", names: ["Jade Lee"] })).toBe(false);
    // …but a one-word name does when the rest is not a possessive or "and".
    expect(hasNoteFor(home, { userId: "1", names: ["Jade"] })).toBe(true);
    expect(hasNoteFor(home, { userId: "1", names: ["Kevin"] })).toBe(true);
  });

  const line = (o: Partial<TranscriptLine> & { authorId: string; author: string }): TranscriptLine => ({ id: String(Math.random()).slice(2), at: "2026-11-26T18:00:00.000Z", text: "hi", ...o });
  const chunk = (dm: boolean, lines: TranscriptLine[]): DreamChunk => ({ folder: { key: dm ? "dm_1_ella" : "g_1_2", segments: [], dm, handle: dm ? "dm/aiko" : "s/#general" }, day: "2026-11-26", path: "/transcripts/x.md", lines, chars: 10 });
  const her = line({ authorId: ELLA_BOT, author: "Ella", waifu: "ella" });

  it("she talked to everyone else in a room's day where she wrote, and to the person of a DM", () => {
    const people = peopleSheTalkedTo(
      [
        chunk(false, [line({ authorId: "a", author: "Aiko" }), her, line({ authorId: "t", author: "Tom" }), line({ authorId: "a", author: "aiko ✿" }), line({ authorId: "m", author: "Mina", waifu: "mina" })]),
        chunk(false, [line({ authorId: "x", author: "Xavier" })]),
        chunk(true, [line({ authorId: "j", author: "Jade" })])
      ],
      { waifuId: "ella", counts: (entry) => entry.authorId !== "t" }
    );
    // The other waifu, the room where she said nothing and the person who doesn't count are not there; the latest name first.
    expect(people).toEqual([
      { userId: "a", names: ["aiko ✿", "Aiko"] },
      { userId: "j", names: ["Jade"] }
    ]);
  });

  it("the line names them and asks for a note each", () => {
    expect(newPeopleLine([{ name: "Aiko", userId: "123" }, { name: "Tom", userId: "456" }])).toBe(
      "People she talked to in this window who have no note yet: Aiko (user:123), Tom (user:456). Make a note for each (what the window says about them, in her voice) with their mark as its first line, like <!-- user:123 --> for Aiko, and add it to MEMORY.md."
    );
  });

  const ELLA = { id: "ella", name: "Ella", botId: "ella-bot", persona: "Ella bakes." };
  /** The guild directory learns a member (as the message cache teaches it from messages). */
  const knowMember = async (w: LifeWorld, userId: string, name: string, bot = false) => {
    const directory = w.cast.deps.directory as GuildDirectory;
    await directory.ensureLoaded(GUILD);
    directory.observeMessages(GUILD, [
      { id: "1", channelId: CHANNEL, guildId: GUILD, authorId: userId, authorName: name, authorIsBot: bot, createdAt: w.clock.now().toISOString(), type: 0, content: "", attachments: [], embeds: [], stickers: [], snapshots: [], mentions: { users: {}, roles: {}, channels: {} } } as never
    ]);
  };
  const dreamOpening = async (people: Array<{ author: string; authorId: string }>): Promise<string> => {
    const w = await lifeWorld(roots, { waifus: [ELLA], scripts: [() => textTurn("done")] });
    await homeOf(w, "ella").write("people/kevin.md", "kevin, exam on friday\n");
    for (const person of people) await knowMember(w, person.authorId, person.author);
    await seedTranscript(w, [
      { text: "my exam got moved", minutesAgo: 30 },
      { text: "noooo", author: "Ella", authorId: ELLA_BOT, waifu: "ella", minutesAgo: 29 },
      ...people.map((person, index) => ({ text: "hello", ...person, minutesAgo: 28 - index }))
    ]);
    await w.cast.scheduler.tick();
    const dream = w.anthropic.calls.find((call) => JSON.stringify(call.request).includes("You keep Ella's memory"));
    expect(dream).toBeDefined();
    return JSON.stringify(dream!.request.messages[0]);
  };

  it("the dream's opening names the people without a note, after the window, with the calendar", { timeout: 60_000 }, async () => {
    const opening = await dreamOpening([{ author: "Mina", authorId: MINA_USER }]);
    expect(opening).toContain(`People she talked to in this window who have no note yet: Mina (user:${MINA_USER}). Make a note for each`);
    expect(opening).not.toMatch(/no note yet: [^.]*Kevin/u);
    expect(opening).toContain("Calendar as of ");
    expect(opening.indexOf("The dream window starts")).toBeLessThan(opening.indexOf("People she talked to"));
  });

  it("adds nothing when everyone she talked to has a note", { timeout: 60_000 }, async () => {
    const opening = await dreamOpening([]);
    expect(opening).not.toContain("no note yet");
    expect(opening).toContain("Calendar as of ");
  });

  it("the real leave-outs: her own ids, bots, webhooks and forgotten people; a DM's person by any name she knows", { timeout: 60_000 }, async () => {
    const w = await lifeWorld(roots, { waifus: [ELLA], scripts: [() => textTurn("done")] });
    await homeOf(w, "ella").write("people/kev.md", "kev from #general\n");
    await knowMember(w, MINA_USER, "Mina");
    await knowMember(w, "300000000000000010", "GitHub", true);
    await knowMember(w, "300000000000000011", "Noor");
    // Her own bot's id, known to the directory as if a person: still never a "new person".
    await knowMember(w, ELLA_BOT, "Ella");
    // The directory knows Kevin as "Kev" in the server; tonight he only DMs, as "Kevin".
    await knowMember(w, KEVIN, "Kev");
    await recordForgottenPerson(w.storage, "300000000000000011", w.clock.now());
    await seedTranscript(w, [
      { text: "noooo", author: "Ella", authorId: ELLA_BOT, waifu: "ella", minutesAgo: 30 },
      { text: "hi", author: "Mina", authorId: MINA_USER, minutesAgo: 29 },
      { text: "new commit", author: "GitHub", authorId: "300000000000000010", minutesAgo: 28 },
      { text: "hook", author: "Hooky", authorId: "300000000000000012", minutesAgo: 27 },
      { text: "old me", author: "Ella", authorId: ELLA_BOT, minutesAgo: 26 },
      { text: "forget me", author: "Noor", authorId: "300000000000000011", minutesAgo: 25 }
    ]);
    await seedTranscript(w, [{ text: "it's kevin, you there?", author: "Kevin", authorId: KEVIN, minutesAgo: 20 }], { conversation: dmOf("ella", KEVIN) });
    const waifu = await readWaifu(w.storage, "ella");
    const window = await dreamWindow(w.cast.deps, waifu);
    expect(window.chunks).toHaveLength(2);
    expect(await peopleWithoutNotes(w.cast.deps, waifu, window.chunks)).toEqual([{ userId: MINA_USER, name: "Mina" }]);
    // Without the note under his nickname, Kevin of the DM is listed, by the name he wrote under.
    await rm(path.join(w.root, "user", "waifus", "ella", "home", "people", "kev.md"));
    expect(await peopleWithoutNotes(w.cast.deps, waifu, window.chunks)).toEqual([
      { userId: MINA_USER, name: "Mina" },
      { userId: KEVIN, name: "Kevin" }
    ]);
  });
});

describe("the life benchmark sends through the client's mention repair (§35.5)", () => {
  const server = () =>
    new FakeServer({
      clock: new SimClock(Date.parse("2026-11-02T18:00:00Z")),
      waifuId: "ella",
      botConfigId: "ella-bot",
      botUserId: "840000000000000001",
      botName: "Ella",
      houseUserId: "840000000000000009",
      guild: { id: "810000000000000001", name: "Tea Room", channels: [{ id: "820000000000000001", name: "general" }] },
      people: [
        { id: "830000000000000001", name: "Priya" },
        { id: "830000000000000002", name: "Lou" }
      ],
      attachments: new FakeAttachments()
    });

  it("repairs malformed mentions as Discord would receive them, keeping her model's text", async () => {
    const fake = server();
    let final = "";
    await fake.sendWaifuMessage({ guildId: "810000000000000001", channelId: "820000000000000001", content: "<@Priya} you in? <@lou> too", allowedUserMentionIds: ["830000000000000001"], onFinalContent: (content) => void (final = content) });
    const record = fake.sent[0]!;
    expect(record.content).toBe("<@830000000000000001> you in? <@830000000000000002> too");
    expect(final).toBe(record.content);
    expect(record.modelContent).toBe("<@Priya} you in? <@lou> too");
    expect(record.shown).toBe("@Priya you in? @Lou too");
    // The message in the fake channel is what Discord holds, with its mention map.
    const message = fake.messages(fake.guildRef("820000000000000001")).at(-1)!;
    expect(message.content).toBe(record.content);
    expect(message.mentions.users).toEqual({ "830000000000000001": "Priya", "830000000000000002": "Lou" });
  });

  it("leaves a clean message alone", async () => {
    const fake = server();
    await fake.sendWaifuMessage({ guildId: "810000000000000001", channelId: "820000000000000001", content: "cinnamon buns all week", allowedUserMentionIds: [] });
    expect(fake.sent[0]).toMatchObject({ content: "cinnamon buns all week" });
    expect(fake.sent[0]!.modelContent).toBeUndefined();
    expect(fake.sent[0]!.shown).toBeUndefined();
  });

  it("a run's transcript and chat packet show the repaired message, with the raw text kept", async () => {
    const outDir = await makeTempRoot("life-bench-mentions-");
    roots.push(outDir);
    const scenario = defineScenario({
      ...tiny,
      id: "mentions",
      end: "d1 19:00",
      events: tiny.events.slice(0, 2),
      facts: [],
      probes: [],
      dryRun: [{ when: "what are you baking", send: { place: "tea-room/#general", text: "<@Kevin} cinnamon buns all week, <@mina> too" } }]
    } as ScenarioInput);
    const summary = await runBenchmark({ scenarios: [scenario], models: [{ providerId: "anthropic", modelId: "claude-haiku-5-5" }], variants: [BASELINE], repeat: 1, concurrency: 1, web: false, dryRun: true, outDir, gate: { minFirstTry: 0.8, minProbes: 0.6 }, tempBase: outDir });
    const run = summary.runs[0]!;
    expect(run.status, run.error).toBe("done");
    const events = (await readFile(path.join(outDir, "runs", run.runId, "transcript.jsonl"), "utf8")).trim().split("\n").map((entry) => JSON.parse(entry) as TranscriptEvent);
    const sent = events.filter((event): event is Extract<TranscriptEvent, { type: "sent" }> => event.type === "sent");
    expect(sent.map((event) => [event.text, event.raw])).toEqual([["@Kevin cinnamon buns all week, @Mina too", "<@Kevin} cinnamon buns all week, <@mina> too"]]);
    expect(renderChat(scenario, sent)).toContain("Ella (her): @Kevin cinnamon buns all week, @Mina too");
  });
});
