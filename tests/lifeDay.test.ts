// Her `~/life/` folder (Living cast spec §21, §38): the markers that keep a re-run migration away
// from her home, the note that her prompt's copy of MEMORY.md is stale (§21.2), `~/life/schedule.json`
// as an ordinary file now that her day file is gone (§38), dreaming leaving `~/life/` alone (§21.6),
// and her own `<summary>` fresh start (§21.6b). Temp data roots, fake Discord and scripted models;
// no live calls.
import { afterEach, describe, expect, it, vi } from "vitest";

/** The request size the life loop sees (a stand-in for a long life). */
const estimate = vi.hoisted(() => ({ value: undefined as number | undefined }));
vi.mock("../src/life/request.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/life/request.js")>();
  return { ...real, estimateRequest: (...args: Parameters<typeof real.estimateRequest>) => estimate.value ?? real.estimateRequest(...args) };
});

import { readLifeLog, readLifeState, updateLifeState } from "../src/life/lifeStore.js";
import { scanDmContent, viewLogLine } from "../src/life/lifeView.js";
import { lifeBudget } from "../src/life/request.js";
import { REST_SUMMARY_FRAME } from "../src/life/rest.js";
import { DREAM_LIFE_REFUSED, promptCopyText } from "../src/life/tools/files.js";
import { lifeTool, offeredToolNames } from "../src/life/tools/index.js";
import type { ToolContext, ToolOutput } from "../src/life/tools/types.js";
import { selfAuthorIds } from "../src/life/people.js";
import { enqueueWake, newWakeId } from "../src/life/wakeQueue.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import { textTurn } from "./modelFakes.js";
import { closeWorlds, dmOf, homeOf, KEVIN, lifeWorld, script, writeHerFile, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";
import { addFilePatch, applyPatch, lineEditPatch, replaceFilePatch, updateFilePatch } from "./toolCalls.js";

const roots: string[] = [];
afterEach(async () => {
  estimate.value = undefined;
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

/** What an old day file held (§21.2): now just text in `~/life/` (§38). */
const plan = (date: string) => JSON.stringify({ date, mood: "slow morning", busy: [{ from: "12:00", to: "15:30", why: "studio shift" }], plans: [{ at: "21:00", what: "movie night" }] }, null, 2);

function lastText(request: { messages: Array<{ content: unknown }> }): string {
  return JSON.stringify(request.messages[request.messages.length - 1]!.content);
}

/** Her life begins (one turn), so she has a system snapshot. */
async function beginLife(w: LifeWorld): Promise<void> {
  await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "reminder", note: "hello", at: w.clock.now().toISOString() });
  await w.cast.life("ella").runNow();
}

describe("the life-folder marker (§21.6)", () => {
  it("any write the app makes to her home writes the marker first: an owner's ~/schedule.json or her profile from the dashboard are never migrated", async () => {
    const w = await lifeWorld(roots, { waifus: [{ id: "ella", name: "Ella", botId: "ella-bot" }, { id: "mina", name: "Mina", botId: "mina-bot" }] });
    const { homeStoreFor } = await import("../src/life/home/index.js");
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { migrateLivingCastLifeFolder } = await import("../src/backend/migrationSteps/livingCastLifeFolder.js");
    // Never run, never ticked: the owner writes a file at the top of her home over the API.
    const store = homeStoreFor(w.cast.deps, await readWaifu(w.storage, "ella"));
    const target = store.resolve("~/schedule.json");
    if (!target.ok) throw new Error("path");
    await store.writeText(target.path, "my shopping schedule\n", { now: w.clock.now(), timeZone: "UTC", resolvePerson: async () => undefined } as never);
    const marker = (id: string) => readFile(path.join(w.root, "user", "waifus", id, "life", "life-folder-v1.json"), "utf8").catch(() => undefined);
    expect(await marker("ella")).toBeDefined();
    expect(await migrateLivingCastLifeFolder(w.root)).toBeUndefined();
    expect(await homeOf(w).read("schedule.json")).toBe("my shopping schedule\n");
    // The dashboard's profile rewrite (a new or edited waifu) writes it too.
    expect(await marker("mina")).toBeUndefined();
    await homeStoreFor(w.cast.deps, await readWaifu(w.storage, "mina")).writeProfileFromConfig();
    expect(await marker("mina")).toBeDefined();
    expect(await migrateLivingCastLifeFolder(w.root)).toBeUndefined();
  });

  it("a life the app runs gets the markers, so a re-run of the migrations leaves her home alone", async () => {
    const w = await lifeWorld(roots);
    await w.cast.scheduler.tick();
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    for (const name of ["life-folder-v1.json", "no-schedule-v1.json"]) {
      expect(JSON.parse(await readFile(path.join(w.root, "user", "waifus", "ella", "life", name), "utf8"))).toEqual({ version: 1, state: "done" });
    }
    await writeHerFile(w, "schedule.json", JSON.stringify({ date: "2026-10-24", busy: [] }));
    // §38: a `~/life/schedule.json` she writes after the upgrade is hers; a re-run never archives it.
    await writeHerFile(w, "life/schedule.json", "my own list\n");
    const { migrateLivingCastLifeFolder } = await import("../src/backend/migrationSteps/livingCastLifeFolder.js");
    const { migrateLivingCastNoSchedule } = await import("../src/backend/migrationSteps/livingCastNoSchedule.js");
    expect(await migrateLivingCastLifeFolder(w.root)).toBeUndefined();
    expect(await migrateLivingCastNoSchedule(w.root)).toBeUndefined();
    expect(await homeOf(w).read("schedule.json")).toContain("2026-10-24");
    expect(await homeOf(w).read("life/schedule.json")).toBe("my own list\n");
  });
});

// ---- the prompt's copy and dreaming (§21.2, §21.6) ------------------------------------------------

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
const MEMORY_NOTE = promptCopyText("~/MEMORY.md");

describe("her prompt's copy of MEMORY.md (§21.2)", () => {
  it("Edit and Bash say once per turn that the copy is old; other files and unchanged writes say nothing", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    expect(text(await applyPatch(ctx, addFilePatch("~/MEMORY.md", "# Memory\n")))).toBe(`Updated: A ~/MEMORY.md\n${MEMORY_NOTE}`);
    expect(text(await applyPatch(ctx, updateFilePatch("~/MEMORY.md", ["# Memory", "# Notes"])))).toBe("Updated: M ~/MEMORY.md");
    expect(text(await applyPatch(ctx, addFilePatch("~/people/kevin.md", "# Kevin\n")))).not.toContain("system prompt");
    // A new turn: Edit and Bash say it again.
    const next = await ctxFor(w, { turn: { id: "turn-2", sentPlaces: new Set(), dmUsersSent: new Set(), fetches: 0 } });
    expect(text(await applyPatch(next, updateFilePatch("~/MEMORY.md", ["# Notes", "# My memory"])))).toBe(`Updated: M ~/MEMORY.md\n${MEMORY_NOTE}`);
    const third = await ctxFor(w, { turn: { id: "turn-3", sentPlaces: new Set(), dmUsersSent: new Set(), fetches: 0 } });
    const bash = await run("Bash", { command: "echo '- [Kevin](people/kevin.md)' >> ~/MEMORY.md" }, third);
    expect(text(bash)).toContain(MEMORY_NOTE);
    // Rewriting the same bytes changes nothing to tell.
    const same = await homeOf(w).read("people/kevin.md");
    expect(text(await applyPatch(third, replaceFilePatch("~/people/kevin.md", same!)))).toBe("No change: D ~/people/kevin.md, A ~/people/kevin.md (the files already read like that)");
  });

  it("is never said outside her life (dreaming)", async () => {
    const w = await lifeWorld(roots);
    const dream = await ctxFor(w, { mode: "session", session: "dream" });
    expect(text(await applyPatch(dream, addFilePatch("~/MEMORY.md", "# Memory\n")))).not.toContain("system prompt");
  });
});

describe("~/life/schedule.json is an ordinary file now (§38)", () => {
  it("any text is saved without checks or notes, like any file of hers in ~/life/; it stays private and is never in her prompt", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    // Not JSON, and an old day's shape: neither is checked any more, and no note follows.
    expect(text(await applyPatch(ctx, addFilePatch("~/life/schedule.json", "busy all day, maybe\n")))).toBe("Updated: A ~/life/schedule.json");
    const day = (await homeOf(w).read("life/schedule.json"))!;
    expect(text(await applyPatch(ctx, replaceFilePatch("~/life/schedule.json", plan("2026-10-24"))))).toBe("Updated: D ~/life/schedule.json, A ~/life/schedule.json");
    expect(day).toBe("busy all day, maybe\n");
    // The retired Write replaces it like any other file of hers (no earlier Read needed for a non-special file).
    expect(text(await run("Write", { file_path: "~/life/schedule.json", content: "{ not json" }, ctx))).toMatch(/^wrote ~\/life\/schedule\.json \(/u);
    expect(await homeOf(w).read("life/schedule.json")).toBe("{ not json");
    // Everything in ~/life/ stays private: SendMessage never attaches it.
    const { homeStoreFor } = await import("../src/life/home/index.js");
    const home = homeStoreFor(w.cast.deps, await readWaifu(w.storage, "ella"));
    const resolved = home.resolve("~/life/schedule.json");
    if (!resolved.ok) throw new Error("path");
    expect(await home.isPrivateFile(resolved.path)).toBe(true);
    // Her prompt has no <schedule> any more, whatever the file says.
    await beginLife(w);
    const state = await readLifeState(w.storage, "ella");
    expect(state.systemSnapshot!.harness).not.toContain("<schedule>");
    expect(state.systemSnapshot!.harness).not.toContain("schedule.json");
  });
});

describe("dreaming leaves ~/life/ alone (§21.6)", () => {
  it("Edit and Bash refuse to change anything there; notes and MEMORY.md are fine", async () => {
    const w = await lifeWorld(roots);
    await writeHerFile(w, "life/schedule.json", plan("2026-10-24"));
    await writeHerFile(w, "life/wakeups.json", JSON.stringify([{ kind: "at", when: "2026-10-24 18:00", note: "flyer" }]));
    const dream = await ctxFor(w, { mode: "session", session: "dream" });
    const refused = { content: `error: Error: tools.apply_patch: ${DREAM_LIFE_REFUSED.replace(/^error:\s*/u, "")}; nothing was changed (line 1)`, isError: true };
    expect(await applyPatch(dream, replaceFilePatch("~/life/schedule.json", plan("2026-10-25")))).toEqual(refused);
    const wakeups = (await homeOf(w).read("life/wakeups.json"))!;
    expect(await applyPatch(dream, lineEditPatch("~/Life/Wakeups.json", wakeups, "flyer", "poster"))).toEqual(refused);
    expect(await applyPatch(dream, addFilePatch("~/life/new-note.md", "x"))).toEqual(refused);
    // The same patch adding a note outside ~/life/ too: all or nothing.
    expect(await applyPatch(dream, `${addFilePatch("~/ok.md", "fine").replace("\n*** End Patch", "")}\n*** Add File: ~/life/x.md\n+x\n*** End Patch`)).toEqual(refused);
    expect(await homeOf(w).read("ok.md")).toBeUndefined();
    // The retired Write still refuses too.
    expect(await run("Write", { file_path: "~/life/schedule.json", content: plan("2026-10-25") }, dream)).toEqual({ content: DREAM_LIFE_REFUSED, isError: true });
    const bash = await run("Bash", { command: "rm ~/life/wakeups.json" }, dream);
    expect(text(bash)).toContain(`error: changes not saved: ${DREAM_LIFE_REFUSED.replace(/^error:\s*/u, "")}`);
    expect(await homeOf(w).read("life/wakeups.json")).toContain("flyer");
    expect(text(await applyPatch(dream, addFilePatch("~/MEMORY.md", "# Memory\n")))).toBe("Updated: A ~/MEMORY.md");
    // A forget's notes scrub (another session) may still tidy her wakeups.
    const scrub = await ctxFor(w, { mode: "session", session: "scrub" });
    expect(text(await applyPatch(scrub, lineEditPatch("~/life/wakeups.json", (await homeOf(w).read("life/wakeups.json"))!, "flyer", "poster")))).toBe("Updated: M ~/life/wakeups.json");
  });
});

// ---- her own fresh start (§21.6b) -----------------------------------------------------------------

const SUMMARY = `Bake Club #general: Kevin is coming Saturday and I promised lemon tarts. ${"Mina and I joked about the menace cat and planned a bake-off for next week. ".repeat(3)}`;

/** 0.5 × her compaction trigger: past selfSummaryMinRatio (0.3), short of the rest notice. */
function halfFull(w: LifeWorld): number {
  const model = w.cast.deps.catalog().models.find((entry) => entry.modelId === "claude-haiku-5-5")!;
  return Math.round(0.5 * w.config.compaction.triggerRatio * lifeBudget(model, w.config.life.maxContextTokens));
}

describe("a fresh start when she wants one (§21.6b)", () => {
  async function selfWorld(reply: string, o: { oldEpoch?: boolean } = {}) {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi"), textTurn(reply), textTurn("hello again")) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await beginLife(w);
    if (o.oldEpoch !== false) w.clock.advance(3 * 3_600_000);
    estimate.value = halfFull(w);
    await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "reminder", note: "go", at: w.clock.now().toISOString() });
    await w.cast.life("ella").runNow();
    return w;
  }

  it("a reply that is only <summary>…</summary> starts a new epoch from it alone; queued wakes wait for it; the owner sees it only locally", async () => {
    const w = await selfWorld(`\n  <summary>\n${SUMMARY}\n</summary>  \n`);
    const state = await readLifeState(w.storage, "ella");
    expect(state.epoch).toBe(2);
    expect(state.summary).toBe(`${REST_SUMMARY_FRAME}\n${SUMMARY.trim()}`);
    expect(state.lastCompaction).toMatchObject({ reason: "self", summarized: true, fromEpoch: 1 });
    expect((await readLifeLog(w.storage, "ella", 2))[0]).toMatchObject({ kind: "compaction_boundary", boundary: { reason: "self", keptTurns: 0 } });
    expect(w.ledger.lines.map((line) => line.purpose)).not.toContain("compaction");
    // Private like the rest turn's summary.
    const lines = await readLifeLog(w.storage, "ella", 1);
    const scan = scanDmContent(lines);
    const views = lines.map((line) => viewLogLine(line, scan, { includePrivate: false }).view);
    expect(JSON.stringify(views)).not.toContain("lemon tarts");
    expect(JSON.stringify(lines.map((line) => viewLogLine(line, scan, { includePrivate: true }).view))).toContain("lemon tarts");
    // Her next turn is in the new epoch.
    estimate.value = undefined;
    await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "reminder", note: "next", at: w.clock.now().toISOString() });
    await w.cast.life("ella").runNow();
    const last = w.anthropic.calls[w.anthropic.calls.length - 1]!.request;
    expect(last.system).toContain(REST_SUMMARY_FRAME);
    expect(last.messages).toHaveLength(1);
  });

  it("text outside the tag is an ordinary reply: nothing resets", async () => {
    const w = await selfWorld(`ok then <summary>${SUMMARY}</summary>`);
    expect((await readLifeState(w.storage, "ella")).epoch).toBe(1);
    expect((await readLifeState(w.storage, "ella")).selfSummaryRefused).toBeUndefined();
  });

  it.each([
    ["too short", "<summary>short</summary>", {}, "it is shorter than 200 characters"],
    ["memory far from full", `<summary>${SUMMARY}</summary>`, { small: true }, "your memory is still far from full"],
    ["too soon after her last epoch start", `<summary>${SUMMARY}</summary>`, { oldEpoch: false }, "your last fresh start was less than 120 minutes ago"]
  ])("a failed guard (%s) resets nothing and her next time line says why, once", async (_name, reply, o: { small?: boolean; oldEpoch?: boolean }, reason) => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi"), textTurn(reply), textTurn("hm"), textTurn("hm")) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await beginLife(w);
    if (o.oldEpoch !== false) w.clock.advance(3 * 3_600_000);
    estimate.value = o.small ? 10 : halfFull(w);
    await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "reminder", note: "go", at: w.clock.now().toISOString() });
    await w.cast.life("ella").runNow();
    expect((await readLifeState(w.storage, "ella")).epoch).toBe(1);
    expect((await readLifeState(w.storage, "ella")).selfSummaryRefused).toBe(reason);
    for (const note of ["one", "two"]) {
      await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "reminder", note, at: w.clock.now().toISOString() });
      await w.cast.life("ella").runNow();
    }
    const [third, fourth] = w.anthropic.calls.slice(2).map((call) => lastText(call.request));
    expect(third).toContain(`(your summary was not used: ${reason})`);
    expect(fourth).not.toContain("your summary was not used");
  });

  it("a refused summary in a DM turn still gets the unsent-reply nudge, which says why it was not used", async () => {
    const { UNSENT_REPLY_NOTE } = await import("../src/life/lifeLoop.js");
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi"), textTurn("<summary>short</summary>"), textTurn("(nothing to add)")) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await beginLife(w);
    const dm = w.discord.post(dmOf("ella"), "are you there?");
    await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "dm", placeKey: `dm_${KEVIN}_ella`, fromUserId: KEVIN, fromName: "Kevin", messageId: dm.id, preview: "are you there?", at: w.clock.now().toISOString() });
    await w.cast.life("ella").runNow();
    const nudge = lastText(w.anthropic.calls[2]!.request);
    expect(nudge).toContain(UNSENT_REPLY_NOTE.slice(0, 40));
    expect(nudge).toContain("(your summary was not used: it is shorter than 200 characters)");
    expect((await readLifeState(w.storage, "ella")).epoch).toBe(1);
  });

  it("the cooldown counts from her last epoch start, across a restart", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("hi"), textTurn(`<summary>${SUMMARY}</summary>`)) });
    vi.spyOn(w.cast.life("ella"), "poke").mockImplementation(() => undefined);
    await beginLife(w);
    await updateLifeState(w.storage, "ella", (state) => ({ ...state, epochStartedAt: new Date(w.clock.ms - 60 * 60_000).toISOString() }));
    await w.cast.stop();
    const after = w.restart();
    vi.spyOn(after.life("ella"), "poke").mockImplementation(() => undefined);
    estimate.value = halfFull(w);
    await enqueueWake(w.storage, "ella", { id: newWakeId(), reason: "reminder", note: "go", at: w.clock.now().toISOString() });
    await after.life("ella").runNow();
    expect((await readLifeState(w.storage, "ella")).selfSummaryRefused).toBe("your last fresh start was less than 120 minutes ago");
  });
});
