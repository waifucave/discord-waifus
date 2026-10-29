// Her own computer, after the L4 reviews (Living cast spec §16): every confirmed repro as a test.
// Names compare as a case-insensitive disk does (special files, private files, DM folders); a
// whole-file Write of her wakeups needs a current Read; Read's output is capped and
// never touches her life's image state outside her life; Bash's memory watchdog, entry limits and
// change summaries; her DM files touched by Bash or Write make the call a DM call; a lost fired
// list never fires twice. Temp data roots, fake Discord and models; no live calls.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeStore, homeLimitsOf } from "../src/life/home/homeStore.js";
import { homeStoreFor } from "../src/life/home/index.js";
import { readLifeFile, readLifeState } from "../src/life/lifeStore.js";
import { MAINTENANCE_LISTING_MAX, runNotesSession } from "../src/life/maintenance.js";
import { withPlaceRecord } from "../src/life/placeRecorder.js";
import { READ_MAX_OUTPUT_CHARS } from "../src/life/tools/files.js";
import { lifeTool, offeredToolNames } from "../src/life/tools/index.js";
import type { ToolContext, ToolOutput } from "../src/life/tools/types.js";
import { selfAuthorIds } from "../src/life/people.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import { AppConfigSchema } from "../src/shared/schemas/config.js";
import { textTurn } from "./modelFakes.js";
import { FakeImageFetcher } from "./contextFixtures.js";
import { CHANNEL, closeWorlds, GUILD, herEntries, herFile, homeOf, KEVIN, lifeWorld, ROOM, script, tinyPng, toolTurn, writeHerFile, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";
import { addFilePatch, applyPatch, readFile as readFile_, readMessages, replaceFilePatch, runScript, sendMessage, wakeupCalls } from "./toolCalls.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const DM_KEY = `dm_${KEVIN}_ella`;

async function ctxFor(w: LifeWorld, o: Partial<ToolContext> = {}): Promise<ToolContext> {
  const deps = w.cast.deps;
  const waifu = await readWaifu(w.storage, "ella");
  const route = deps.catalog().models.find((model) => model.providerId === waifu.model!.providerId && model.modelId === waifu.model!.modelId)!;
  return {
    deps,
    waifu,
    route,
    turn: { id: "turn-1", sentPlaces: new Set(), dmUsersSent: new Set(), fetches: 0 },
    signal: new AbortController().signal,
    toolCallId: "call_1",
    selfAuthorIds: await selfAuthorIds(w.storage, waifu),
    toolNames: offeredToolNames(deps),
    ...o
  };
}

let calls = 0;
const run = (name: string, input: unknown, ctx: ToolContext): Promise<ToolOutput> => lifeTool(name)!.run(input, { ...ctx, toolCallId: `call_${(calls += 1)}` });
const text = (output: ToolOutput) => (typeof output.content === "string" ? output.content : output.content.map((block) => ("text" in block ? block.text : "[image]")).join("\n"));
/** A file in her home, written as the owner would (no checks). */
async function put(w: LifeWorld, relative: string, data: string | Buffer): Promise<void> {
  const file = path.join(w.root, "user/waifus/ella/home", ...relative.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

const later = (w: LifeWorld, minutes: number) => {
  const at = new Date(w.clock.now().getTime() + minutes * 60_000).toISOString();
  return `${at.slice(0, 10)} ${at.slice(11, 16)}`;
};

describe("names as the disk compares them (review S1, S2)", () => {
  it("never attaches a private file by another spelling or link form, and checks special files by any spelling", async () => {
    const w = await lifeWorld(roots);
    const home = homeOf(w);
    await home.write(
      "MEMORY.md",
      [
        "# Memory",
        "- [Kevin](people/kevin.md)",
        "- [Mina](<people/mina notes.md>)",
        "- [Ref][r1]",
        "- [Dot](./people/dot.md \"a title\")",
        "- [Tilde](~/people/tilde.md)",
        "- [Abs](/home/ella/people/abs.md#top)",
        "- [Pct](people/pct%20file.md)",
        "- [Case](People/CASE.md)",
        "- [Web](https://example.com/x.md)",
        "",
        "[r1]: people/ref.md"
      ].join("\n")
    );
    for (const name of ["kevin.md", "mina notes.md", "ref.md", "dot.md", "tilde.md", "abs.md", "pct file.md", "case.md", "shared.md"]) await home.write(`people/${name}`, `# ${name}\nSECRET\n`);
    const ctx = await ctxFor(w);
    const tries = [
      "~/MEMORY.md",
      "~/memory.md",
      "~/People/Kevin.md",
      "~/people/KEVIN.md",
      "~/people/mina notes.md",
      "~/people/ref.md",
      "~/people/dot.md",
      "~/people/tilde.md",
      "~/people/abs.md",
      "~/people/pct file.md",
      "~/people/case.md",
      "/home/ella/./MEMORY.md",
      "~/people/../MEMORY.md",
      "~/Life/Schedule.json",
      "~/LIFE/WATCHES.json",
      "~/life/Places.MD",
      "~/life/Wakeups.json"
    ];
    for (const file of tries) {
      const sent = await sendMessage({ ...ctx, turn: { id: "t", sentPlaces: new Set(), dmUsersSent: new Set(), fetches: 0 } }, "bake-club/#general", [{ text: `try ${file}`, attach: file }]);
      expect(text(sent), file).toMatch(/^error: Error: tools\.send_message: messages\[0\]: can't attach .*private and can't be attached\); nothing was sent \(line 1\)$/u);
    }
    expect(w.discord.sent).toEqual([]);
    // A note MEMORY.md does not link to is hers to share.
    const shared = await sendMessage({ ...ctx, turn: { id: "t2", sentPlaces: new Set(), dmUsersSent: new Set(), fetches: 0 } }, "bake-club/#general", [{ text: "my note", attach: "~/people/shared.md" }]);
    expect(text(shared)).toMatch(/^\{"sent":\["#[0-9a-z]+"\]\}$/u);

    // A broken wakeups file written as ~/Life/Wakeups.json by Bash, or ~/LIFE/WAKEUPS.json by an Edit patch, is checked.
    expect(text(await wakeupCalls(ctx, 'at("in 1h", "legit")'))).toMatch(/^set t1 /u);
    const bash = await run("Bash", { command: `rm ~/life/wakeups.json; printf '%s' '[{"kind":"at","when":"1999-01-01 00:00","note":"old"}]' > ~/Life/Wakeups.json` }, ctx);
    expect(text(bash)).toContain("error: changes not saved: wakeups.json entry 1: 1999-01-01 00:00 is in the past");
    expect(await readdir(path.join(w.root, "user/waifus/ella/home/life"))).toContain("wakeups.json");
    expect((await herEntries(w)).map((entry) => entry["note"])).toEqual(["legit"]);
    expect(text(await applyPatch(ctx, replaceFilePatch("~/LIFE/WAKEUPS.json", '[{"kind": "watch", "places": "everywhere", "filter": [], "options": {"until": "1990-01-01 00:00"}, "note": "x"}]')))).toMatch(/apply_patch: wakeups\.json entry 1: options\.until is in the past; nothing was changed/u);
    expect(text(await applyPatch(ctx, addFilePatch("~/life/Places.md", "x")))).toMatch(/apply_patch: places\.md is kept up to date for you/u);
  });

  it("a Bash change set that would make two names differing only by case says so", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    const result = await run("Bash", { command: "echo a > ~/Note.md; echo b > ~/note.md" }, ctx);
    expect(text(result)).toMatch(/error: changes not saved: .*two names can't differ only by case/u);
    // A refused name says why, not "outside your folders".
    const device = await run("Bash", { command: "echo a > '/tmp/aux.'" }, ctx);
    expect(text(device)).toMatch(/error: changes not saved: .*(reserved name|end with a dot)/u);
    expect(text(device)).not.toContain("outside your folders");
  });
});

describe("forget across a crash (review S7)", () => {
  it("a copy a running Bash saves after the forget's first file step is deleted by the queued scrub after a restart", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    const store = homeStoreFor(w.cast.deps, await readWaifu(w.storage, "ella"));
    await store.saveDownload(store.path("tmp", ["dm", "kevin", "a1-recipe.txt"]), Buffer.from("Kevin's secret recipe\n"), {
      placeKey: DM_KEY,
      messageId: "1",
      authorId: KEVIN,
      attachmentId: "1",
      downloadedAt: w.clock.now().toISOString()
    });
    // Her command copies the file into its in-memory folder, waits, then saves a copy in her home.
    let served!: () => void;
    const firstRead = new Promise<void>((resolve) => (served = resolve));
    const { HerFiles } = await import("../src/life/home/herFiles.js");
    const readBytes = HerFiles.prototype.readBytes;
    const spy = vi.spyOn(HerFiles.prototype, "readBytes").mockImplementation(async function (this: InstanceType<typeof HerFiles>, ...args: Parameters<typeof readBytes>) {
      const data = await readBytes.apply(this, args);
      if (args[0].segments.at(-1) === "a1-recipe.txt") served();
      return data;
    });
    const ctx = await ctxFor(w);
    const bash = run("Bash", { command: "cp /tmp/dm/kevin/a1-recipe.txt /tmp/stage.txt; sleep 3; cp /tmp/stage.txt ~/kept.txt" }, ctx);
    await firstRead;
    spy.mockRestore();
    // The forget is prepared (step 1 removes the file and its provenance) while the command runs.
    const prepared = await w.cast.prepareForget({ waifuId: "ella", userId: KEVIN, source: "owner", scope: "everything" });
    expect(prepared).toBeDefined();
    expect(await herFile(w, "ella", "tmp/dm/kevin/a1-recipe.txt")).toBeUndefined();
    const scrubsFile = path.join(w.root, "user/waifus/ella/life/pending-scrubs.json");
    const queued = JSON.parse(await readFile(scrubsFile, "utf8")) as { scrubs: Array<{ userId: string; fileHashes?: string[] }> };
    expect(queued.scrubs.find((scrub) => scrub.userId === KEVIN)?.fileHashes).toHaveLength(1);
    expect((await bash).isError).toBeFalsy();
    expect(await herFile(w, "ella", "home/kept.txt")).toBe("Kevin's secret recipe\n");
    // A crash before the scrub ran under her life lock: the in-memory hashes are gone.
    await closeWorlds();
    const restarted = w.restart();
    vi.spyOn(restarted.life("ella"), "poke").mockImplementation(() => undefined);
    await restarted.start();
    await restarted.settle();
    expect(await herFile(w, "ella", "home/kept.txt")).toBeUndefined();
    expect(await herFile(w, "ella", "tmp/stage.txt")).toBeUndefined();
    // The scrub ran and is cleared, its hashes with it.
    const after = JSON.parse(await readFile(scrubsFile, "utf8")) as { scrubs: Array<{ userId: string; fileHashes?: string[] }> };
    expect(after.scrubs.some((scrub) => scrub.fileHashes !== undefined)).toBe(false);
  }, 60_000);
});

describe("DM files touched by Bash or Write are DM calls (review S5)", () => {
  it("records a listing, a read by glob, a move and a Write over a DM file", async () => {
    const w = await lifeWorld(roots);
    const store = homeStoreFor(w.cast.deps, await readWaifu(w.storage, "ella"));
    const meta = (id: string) => ({ placeKey: DM_KEY, messageId: id, authorId: KEVIN, attachmentId: `a${id}`, downloadedAt: w.clock.now().toISOString() });
    await store.saveDownload(store.path("tmp", ["dm", "kevin", "a7-results.pdf"]), Buffer.from("%PDF-1.4 fake\n"), meta("1"));
    await store.saveDownload(store.path("tmp", ["dm", "kevin", "a8-note.txt"]), Buffer.from("keep this between us\n"), meta("2"));
    const ctx = await ctxFor(w);
    const recorded = async (name: string, input: unknown) => (await withPlaceRecord(() => run(name, input, ctx))).places;
    for (const command of ["find /tmp -type f", "ls -R /tmp", "cd /tmp; ls d*/*", "cd /tmp; cat d*/*/a8*"]) {
      expect([...(await recorded("Bash", { command }))].some((place) => place.startsWith("dm_")), command).toBe(true);
    }
    expect([...(await recorded("Bash", { command: "cd /tmp; mkdir keep; mv d? keep/x" }))].some((place) => place.startsWith("dm_"))).toBe(true);
    expect([...(await recorded("Write", { file_path: "/tmp/keep/x/kevin/a8-note.txt", content: "overwritten" }))].some((place) => place.startsWith("dm_"))).toBe(true);
    // A command that touches nothing of a DM records nothing.
    expect([...(await recorded("Bash", { command: "echo hi" }))]).toEqual([]);
  });
});

describe("entry limits (review S6)", () => {
  it("refuses more /tmp files or home folders than allowed, and more than 5,000 changes at once; summaries are cut at 20", async () => {
    const w = await lifeWorld(roots, { config: (config) => ({ ...config, life: { ...config.life, tmp: { ...config.life.tmp, maxFiles: 10 }, home: { ...config.life.home, maxFolders: 10 } } }) });
    const ctx = await ctxFor(w);
    const files = await run("Bash", { command: "mkdir -p /tmp/many; for i in $(seq 1 12); do echo x > /tmp/many/f$i; done" }, ctx);
    expect(text(files)).toContain("error: changes not saved: /tmp has 10 files already; delete some first");
    const folders = await run("Bash", { command: "for i in $(seq 1 12); do mkdir -p ~/d$i; done" }, ctx);
    expect(text(folders)).toContain("error: changes not saved: your home has 10 folders already; merge or delete some first");
    const summary = await run("Bash", { command: "mkdir -p ~/n; for i in $(seq 1 25); do echo x > ~/n/f$i.md; done" }, ctx);
    expect(text(summary)).toMatch(/changed: (~\/n\/f\d+\.md, ){19}~\/n\/f\d+\.md, … and 5 more/u);
    expect(text(summary).length).toBeLessThan(2_000);
  });

  it("refuses a change set of more than 5,000 entries before anything is applied", async () => {
    const w = await lifeWorld(roots, { config: (config) => ({ ...config, life: { ...config.life, tmp: { ...config.life.tmp, maxFiles: 20_000 } } }) });
    const ctx = await ctxFor(w);
    const started = Date.now();
    const result = await run("Bash", { command: `python3 -c "\nimport os\nos.makedirs('/tmp/many')\nfor i in range(5200):\n    open('/tmp/many/f%d' % i, 'w').close()\n"`, timeout_ms: 60_000 }, ctx);
    expect(text(result)).toContain("at most 5000 can be saved at once");
    expect(result.isError).toBe(true);
    expect(await readdir(path.join(w.root, "user/waifus/ella/tmp")).catch(() => [])).not.toContain("many");
    expect(Date.now() - started).toBeLessThan(45_000);
  }, 90_000);
});

describe("Bash's memory watchdog (review C1)", () => {
  it("stops a command whose memory grows past life.bash.maxMemoryMb; nothing is saved", async () => {
    const w = await lifeWorld(roots, { config: (config) => ({ ...config, life: { ...config.life, bash: { ...config.life.bash, maxMemoryMb: 128 } } }) });
    const ctx = await ctxFor(w);
    // sqlite3 is not one of her commands. Checked first: the watchdog measures the whole process,
    // and memory the stopped command below used can take a moment to be given back.
    expect(text(await run("Bash", { command: "sqlite3 :memory: 'select 1'" }, ctx))).toMatch(/sqlite3: command not (found|available)/u);
    const result = await run("Bash", { command: `echo before > ~/kept.md; python3 -c "\nimport time\nb = b'x' * (400 * 1024 * 1024)\ntime.sleep(20)\n"`, timeout_ms: 60_000 }, ctx);
    expect(text(result)).toBe("error: the command used too much memory and was stopped; nothing was saved");
    expect(await herFile(w, "ella", "home/kept.md")).toBeUndefined();
  }, 90_000);
});

describe("her change never brings back what the app changed since she read it (review B1)", () => {
  it("refuses a stale patch after a watch matched; the matched once-watch never comes back", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    const ctx = await ctxFor(w);
    expect(text(await wakeupCalls(ctx, 'watch("bake-club/#general", {words: ["exam"]}, {for: "2h"}, "Kevin\'s answer")'))).toMatch(/^set w1 /u);
    const read = text(await readFile_(ctx, "~/life/wakeups.json"));
    expect(read).toContain("Kevin's answer");
    const stale = (await herFile(w, "ella", "home/life/wakeups.json"))!;
    const m = w.discord.post(ROOM, "the exam went fine");
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: m.id, castWaifuIds: ["ella"], authorIsWaifu: false, raw: m });
    await w.cast.settle();
    // Her wake waits for the burst's quiet time (§4.2): fire it now.
    w.cast.intake.flushDetector();
    await w.cast.settle();
    expect(await herEntries(w)).toEqual([]);
    // She patches what she read, adding a timer after the watch: refused, the watch's line is gone.
    const watchLine = stale.split("\n").find((line) => line.includes("Kevin's answer"))!;
    const tea = JSON.stringify({ kind: "at", when: later(w, 30), note: "tea" });
    const stalePatch = await applyPatch(ctx, `*** Begin Patch\n*** Update File: ~/life/wakeups.json\n@@\n ${watchLine}\n+, ${tea}\n*** End Patch`);
    expect(text(stalePatch)).toMatch(/apply_patch: Failed to find expected lines in ~\/life\/wakeups\.json/u);
    // Writing the whole file back does not make the stale entry acceptable: it fired once and is gone for good.
    const entries = JSON.parse(stale) as unknown[];
    const content = JSON.stringify([...entries, { kind: "at", when: later(w, 30), note: "tea" }]);
    expect(text(await applyPatch(ctx, replaceFilePatch("~/life/wakeups.json", content)))).toMatch(/apply_patch: wakeups\.json entry w1: it already fired once and was removed; leave it out; nothing was changed/u);
    // The retired Write (old log lines) still refuses a stale whole-file write.
    await readFile_(ctx, "~/life/wakeups.json");
    expect(text(await run("Write", { file_path: "~/life/wakeups.json", content }, ctx))).toBe("error: wakeups.json entry w1: it already fired once and was removed; leave it out");
    // And a timeout of a once-watch that already matched never wakes her.
    w.clock.ms += 3 * 3_600_000;
    await w.cast.scheduler.tick();
    expect((await readLifeFile(w.storage, "ella", "wakes")).immediate.filter((wake) => wake.reason === "watch_timeout")).toEqual([]);
  });

  it("an owner's DELETE of a wakeup sticks against her stale patch", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    await wakeupCalls(ctx, 'at("in 60m", "one")\nat("in 90m", "two")');
    const stale = (await herFile(w, "ella", "home/life/wakeups.json"))!;
    const store = homeStoreFor(w.cast.deps, ctx.waifu);
    await store.rewriteWakeups((entries, side) => ({ entries: entries.filter((entry) => entry.id !== "t1"), side }));
    // Her patch keeps the deleted line as context: it no longer matches.
    const [, one, two] = stale.split("\n");
    const result = await applyPatch(ctx, `*** Begin Patch\n*** Update File: ~/life/wakeups.json\n@@\n ${one}\n-${two}\n+${two!.replace('"two"', '"two!"')}\n*** End Patch`);
    expect(text(result)).toMatch(/apply_patch: Failed to find expected lines in ~\/life\/wakeups\.json/u);
    expect((await herEntries(w)).map((entry) => entry["id"])).toEqual(["t2"]);
  });

  it("a corrupt fired list is kept aside, the owner is told, and a wakeup due before the loss is dropped without a wake", async () => {
    const w = await lifeWorld(roots);
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    const due = later(w, -1);
    await put(w, "life/wakeups.json", `[{"id": "t1", "kind": "at", "when": "${due}", "note": "maybe fired already"}]\n`);
    const side = path.join(w.root, "user/waifus/ella/life/wakeup-ids.json");
    await mkdir(path.dirname(side), { recursive: true });
    await writeFile(side, "{ torn");
    await w.cast.scheduler.tick();
    expect((await readLifeFile(w.storage, "ella", "wakes")).immediate.filter((wake) => wake.reason === "reminder")).toEqual([]);
    expect(await herEntries(w)).toEqual([]);
    const names = await readdir(path.dirname(side));
    expect(names.some((name) => name.startsWith("wakeup-ids.json.corrupt-"))).toBe(true);
    expect(JSON.parse(await readFile(side, "utf8"))).toMatchObject({ recoveredAt: expect.any(String) });
    expect(w.cast.notices.list().some((notice) => notice.includes("wakeup-ids.json"))).toBe(true);
    // A wakeup due after the loss fires as usual.
    await put(w, "life/wakeups.json", `[{"id": "t2", "kind": "at", "when": "${later(w, 10)}", "note": "fires"}]\n`);
    w.clock.ms += 11 * 60_000;
    await w.cast.scheduler.tick();
    expect((await readLifeFile(w.storage, "ella", "wakes")).immediate.map((wake) => wake.note)).toEqual(["fires"]);
  });
});

describe("Read's output and images (review B2, B3)", () => {
  it("cuts a long text at about 100,000 characters and says how to read on", async () => {
    const w = await lifeWorld(roots);
    const line = "x".repeat(1_900);
    await put(w, "long.md", `${Array.from({ length: 200 }, () => line).join("\n")}\n`);
    const result = text(await readFile_(await ctxFor(w), "~/long.md"));
    expect(result.length).toBeLessThan(READ_MAX_OUTPUT_CHARS + 200);
    expect(result).toMatch(/\n\(cut at [\d,]+ characters; pass offset and limit to read on\)$/u);
    // A script's reads share the 100,000 characters: past them a read_file throws.
    const twice = text(await runScript("Read", 'for (let i = 0; i < 3; i++) text(await tools.read_file({ path: "~/long.md" }))', await ctxFor(w)));
    expect(twice.length).toBeLessThan(READ_MAX_OUTPUT_CHARS + 400);
    expect(twice).toMatch(/error: RangeError: tools\.read_file: this script has shown 100,000 characters of files already/u);
  });

  it("outside her life (maintenance, a scrub) an image is its text and her life's image state is untouched", async () => {
    const fetcher = new FakeImageFetcher();
    const w = await lifeWorld(roots, { options: { images: fetcher, ocr: { cachedText: async () => "a lemon tart" } } });
    await put(w, "cake.png", tinyPng());
    const before = await readLifeState(w.storage, "ella");
    const session = await ctxFor(w, { mode: "session" });
    const result = await readFile_(session, "~/cake.png");
    expect(JSON.stringify(result.content)).toContain("[image: a lemon tart]");
    const after = await readLifeState(w.storage, "ella");
    expect(after.shownImageKeys).toEqual(before.shownImageKeys);
    expect(after.inlineImageCount).toBe(before.inlineImageCount);
  });

  it("a maintenance session lists at most 200 files, pictures included, and its Read never changes her life's image state", async () => {
    const fetcher = new FakeImageFetcher();
    const w = await lifeWorld(roots, {
      options: { images: fetcher, ocr: { cachedText: async () => "a lemon tart" } },
      scripts: script(toolTurn([{ name: "Read", input: { script: 'return await tools.read_file({ path: "~/cake.png" })' } }]), textTurn("tidied"))
    });
    for (let index = 0; index < MAINTENANCE_LISTING_MAX + 5; index += 1) await homeOf(w).write(`notes/n${String(index).padStart(3, "0")}.md`, "x\n");
    await put(w, "cake.png", tinyPng());
    const waifu = await readWaifu(w.storage, "ella");
    const model = w.cast.deps.catalog().models.find((entry) => entry.providerId === waifu.model!.providerId && entry.modelId === waifu.model!.modelId)!;
    const before = await readLifeState(w.storage, "ella");
    const outcome = await runNotesSession(w.cast.deps, { waifu, model, instruction: "[system] tidy", kind: "maintenance" });
    expect(outcome.ok).toBe(true);
    const first = JSON.stringify(w.anthropic.calls[0]!.request.messages[0]);
    expect(first).toContain("~/cake.png");
    expect(first).toContain("… and 6 more; use `ls -R`");
    const second = JSON.stringify(w.anthropic.calls[1]!.request.messages);
    expect(second).toContain("[image: a lemon tart]");
    const after = await readLifeState(w.storage, "ella");
    expect(after.shownImageKeys).toEqual(before.shownImageKeys);
  });
});

describe("a Bash journal across a rename (review minors)", () => {
  it("finishes a journal written under her old slug in her current home", async () => {
    const w = await lifeWorld(roots);
    const store = new HomeStore(w.storage, "ella", "ella", () => homeLimitsOf(AppConfigSchema.parse({}).life));
    const dir = path.join(w.root, "user/waifus/ella/life/pending-changes");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "call_9.json"), JSON.stringify({ writes: [{ path: "/home/arya/renamed.md", data: Buffer.from("kept\n").toString("base64") }], deletes: [], dirs: [] }));
    expect(await store.recoverPendingChanges()).toEqual(["call_9"]);
    expect(await herFile(w, "ella", "home/renamed.md")).toBe("kept\n");
  });
});

const attachment = (id: string, filename: string, contentType: string, size: number) => ({
  id,
  url: `https://cdn.discordapp.com/attachments/${CHANNEL}/${id}/${filename}`,
  filename,
  contentType,
  size
});

describe("ReadMessages and SendMessage files (review minors)", () => {
  it("gives the 10 downloads to the newest messages first and names videos as videos", async () => {
    const fetcher = new FakeImageFetcher();
    const w = await lifeWorld(roots, { options: { images: fetcher } });
    w.discord.post(ROOM, "older", { attachments: Array.from({ length: 8 }, (_, index) => attachment(String(7000 + index), `old${index}.txt`, "text/plain", 5)) });
    w.discord.post(ROOM, "newer", { attachments: [...Array.from({ length: 5 }, (_, index) => attachment(String(7100 + index), `new${index}.txt`, "text/plain", 5)), attachment("7200", "clip.mp4", "video/mp4", 2_000_000)] });
    const body = text(await readMessages(await ctxFor(w), { place: "bake-club/#general" }));
    const fetched = fetcher.fileCalls.map((ref) => ref.attachmentId);
    expect(fetched).toHaveLength(10);
    for (let index = 0; index < 5; index += 1) expect(fetched).toContain(String(7100 + index));
    expect(body.match(/not downloaded \(too many in one read; read fewer\)\]/gu)).toHaveLength(3);
    expect(body).toMatch(/\[video: clip\.mp4 · 1\.9 MB · not downloaded\]/u);
  });

  it("keeps a message's files within Discord's limit together, and maps 40005 to a clear error", async () => {
    const w = await lifeWorld(roots);
    await put(w, "a.bin", Buffer.alloc(6 * 1024 * 1024, 1));
    await put(w, "b.bin", Buffer.alloc(6 * 1024 * 1024, 2));
    const ctx = await ctxFor(w);
    const sent = text(await sendMessage(ctx, "bake-club/#general", [{ text: "files", attach: ["~/a.bin", "~/b.bin"] }]));
    expect(sent).toBe("error: Error: tools.send_message: messages[0]: can't attach ~/b.bin (the files together would be over 10 MB, Discord's limit for one message); nothing was sent (line 1)");
    // In two messages they go.
    expect(text(await sendMessage(ctx, "bake-club/#general", [{ text: "files", attach: "~/a.bin" }, { text: "and", attach: "~/b.bin" }]))).toMatch(/^\{"sent":\["#\w+","#\w+"\]\}$/u);
    w.discord.sendErrors.push(Object.assign(new Error("Request entity too large"), { code: 40005 }));
    const refused = await sendMessage({ ...ctx, turn: { id: "t2", sentPlaces: new Set(), dmUsersSent: new Set(), fetches: 0 } }, "bake-club/#general", [{ text: "again", attach: "~/a.bin" }]);
    expect(refused).toEqual({ content: "error: Error: tools.send_message: the message could not be sent: the files are too large for Discord here; send fewer or smaller ones (line 1)", isError: true });
  });

  it("states configured limits in the tool text: /tmp retention, SendMessage's files (none at 0), Bash's timeout", async () => {
    const config = AppConfigSchema.parse({});
    const tuned = { ...config, life: { ...config.life, tmp: { ...config.life.tmp, retentionDays: 3 }, send: { maxFiles: 0 }, bash: { ...config.life.bash, maxTimeoutMs: 30_000 } } };
    const { modelTools } = await import("../src/life/tools/index.js");
    const tools = Object.fromEntries(modelTools(["ReadMessages", "SendMessage", "Bash"], tuned).map((tool) => [tool.name, tool]));
    expect(tools["ReadMessages"]!.description).toContain("saved in /tmp for 3 days");
    expect(tools["SendMessage"]!.description).not.toContain("attach");
    expect(JSON.stringify(tools["Bash"]!.inputSchema)).toContain("(default 10000, at most 30000)");
    const defaults = Object.fromEntries(modelTools(["SendMessage"], config).map((tool) => [tool.name, tool]));
    expect(defaults["SendMessage"]!.description).toContain("attach: [paths] — files from your folders with a message (at most 4)");
    expect(defaults["SendMessage"]!.description).toContain("MEMORY.md, the notes it links to and the files in ~/life/ can't be attached.");
  });

  it("a watch matches a message posted before its timeout even when catch-up handles it later", async () => {
    const w = await lifeWorld(roots);
    const store = homeStoreFor(w.cast.deps, await readWaifu(w.storage, "ella"));
    await writeHerFile(w, "life/wakeups.json", JSON.stringify([{ kind: "watch", places: "everywhere", filter: { words: ["exam"] }, options: { until: later(w, 30) }, note: "his answer" }]));
    const { fireWakeupWatches } = await import("../src/life/wakeups/run.js");
    const { sharedSandbox } = await import("../src/life/sandbox/index.js");
    const posted = new Date(w.clock.now().getTime() + 20 * 60_000).toISOString();
    const handledLate = new Date(w.clock.now().getTime() + 60 * 60_000);
    const message = { placeKey: "x", handle: async () => "x", authorId: KEVIN, fromName: "Kevin", isWaifu: false, text: "the exam", mentionsMe: false, repliesToMe: false, own: false, createdAt: posted };
    const { fired } = await fireWakeupWatches({ store, sandbox: sharedSandbox(), now: handledLate, timeZone: "UTC" }, message, { maxFiresPerDay: 5 });
    expect(fired.map((hit) => hit.id)).toEqual(["w1"]);
  });
});
