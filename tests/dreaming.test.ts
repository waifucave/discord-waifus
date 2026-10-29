// Dreaming (Living cast spec §18.4, owner decisions T3 and T4): the window is only what was said
// since the dream cursor, the cursor moves only when a session finishes, a long window splits into
// sessions, the dreamer adds memories from the window and patches contradicted facts while an
// unmentioned note stays byte-identical, and `life.dreamModel` is used when set.
import { afterEach, describe, expect, it } from "vitest";
import { DREAM_INSTRUCTION, dreamSystem, dreamWindow, readDreamCursor, runDream } from "../src/life/dream.js";
import { readMaintenanceReports } from "../src/life/lifeStore.js";
import { settleTranscripts } from "../src/life/transcripts/store.js";
import { TranscriptView } from "../src/life/transcripts/view.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import { errorTurn, textTurn } from "./modelFakes.js";
import { closeWorlds, homeOf, lifeWorld, MINA_USER, ROOM_KEY, script, seedTranscript, toolTurn, writeWaifuConfig } from "./lifeFixtures.js";
import { queuePendingScrub, readPendingScrubs } from "../src/orchestration/dm/forgotten.js";
import { removeTempRoot } from "./testUtils.js";
import { addFilePatch, scriptInput, updateFilePatch } from "./toolCalls.js";

const roots: string[] = [];

afterEach(async () => {
  await settleTranscripts();
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

function openingText(request: { messages: Array<{ content: unknown }> }): string {
  return JSON.stringify(request.messages[0]!.content);
}

describe("the dream window (§18.4)", () => {
  it("lists only the lines after her dream cursor, and the cursor moves only when the dream finishes", async () => {
    const w = await lifeWorld(roots, {
      scripts: script(errorTurn({ code: "server", message: "overloaded", status: 500, retryable: false }), textTurn("nothing to change"))
    });
    const ids = await seedTranscript(w, [{ text: "old news", minutesAgo: 120 }, { text: "fresh news", minutesAgo: 10 }]);
    const waifu = await readWaifu(w.storage, "ella");
    // A cursor at the first line: only the second is in the window.
    const { writeFile, mkdir } = await import("node:fs/promises");
    const path = await import("node:path");
    const lifeDir = path.join(w.root, "user", "waifus", "ella", "life");
    await mkdir(lifeDir, { recursive: true });
    await writeFile(path.join(lifeDir, "dream-cursor.json"), JSON.stringify({ conversations: { [ROOM_KEY]: { at: new Date(w.clock.ms - 120 * 60_000).toISOString(), id: ids[0] } } }));
    const window = await dreamWindow(w.cast.deps, waifu);
    expect(window.chunks.map((chunk) => chunk.lines.map((line) => line.text))).toEqual([["fresh news"]]);
    expect(window.chunks[0]!.after?.text).toBe("old news");

    // A failed dream changes nothing: the next one reads the same window.
    const failed = await runDream(w.cast.deps, { waifu });
    expect(failed).toMatchObject({ ok: false, sessions: 1 });
    expect((await readDreamCursor(w.storage, "ella")).conversations[ROOM_KEY]!.id).toBe(ids[0]);
    // Where the window starts is a line number (several lines can share a minute).
    expect(openingText(w.anthropic.calls[0]!.request)).toContain("from line 3 on, after the 12:00 line");
    const rendered = (await new TranscriptView({ storage: w.storage, waifuId: "ella", timeZone: "UTC", now: w.clock.now }).read(["bake-club", "general", "2026-10-24.md"]))!;
    expect(rendered.split("\n")[2]).toContain("fresh news");

    const done = await runDream(w.cast.deps, { waifu });
    expect(done).toMatchObject({ ok: true, sessions: 1, lines: 1 });
    expect((await readDreamCursor(w.storage, "ella")).conversations[ROOM_KEY]!.id).toBe(ids[1]);
    // Nothing new since: no model call, a report line that says so.
    expect(await runDream(w.cast.deps, { waifu })).toMatchObject({ ok: true, sessions: 0, lines: 0 });
    expect(w.anthropic.calls).toHaveLength(2);
    const reports = await readMaintenanceReports(w.storage, "ella");
    expect(reports.map((report) => [report.ok, report.lines, report.sessions])).toEqual([
      [false, 1, 1],
      [true, 1, 1],
      [true, 0, 0]
    ]);
  });

  it("is a memory keeper: no life log, no persona, the instruction, her files and the window", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("ok")) });
    await seedTranscript(w, [{ text: "hi" }]);
    const waifu = await readWaifu(w.storage, "ella");
    await runDream(w.cast.deps, { waifu });
    const request = w.anthropic.calls[0]!.request;
    expect(request.system).toBe(dreamSystem(waifu));
    expect(request.system).not.toContain(waifu.persona);
    expect(request.messages).toHaveLength(1);
    expect(openingText(request)).toContain(DREAM_INSTRUCTION.slice(0, 60));
    expect(openingText(request)).toContain("/transcripts/bake-club/general/2026-10-24.md (Sat 24 Oct: the whole file, 1 line)");
    expect(request.tools?.map((tool) => tool.name)).toEqual(["Read", "Edit", "Bash"]);
  });
});

describe("what the dream does to her notes (T4)", () => {
  it("adds a memory from the window, patches a contradicted fact, and leaves an unmentioned note byte-identical", async () => {
    const w = await lifeWorld(roots, {
      scripts: script(
        toolTurn([{ name: "Read", input: scriptInput.readFile("/transcripts/bake-club/general/2026-10-24.md") }]),
        toolTurn([{ name: "Edit", input: scriptInput.applyPatch(updateFilePatch("~/me.md", ["- favourite food: sushi", "- favourite food: lasagna"])) }]),
        toolTurn([{ name: "Edit", input: scriptInput.applyPatch(addFilePatch("~/people/lianne.md", "# Lianne\n- in kingdom-16062's #secret-room\n")) }]),
        toolTurn([{ name: "Edit", input: scriptInput.applyPatch(updateFilePatch("~/MEMORY.md", ["- [Me](me.md)", "- [Me](me.md)\n- [Lianne](people/lianne.md) — in kingdom-16062's #secret-room"])) }]),
        textTurn("lasagna now; met Lianne")
      )
    });
    const notes = homeOf(w, "ella");
    await notes.write("MEMORY.md", "# Memory\n- [Kevin](people/kevin.md)\n- [Me](me.md)\n");
    const kevin = "# Kevin\n- allergic to peanuts\n- exam on Friday\n";
    await notes.write("people/kevin.md", kevin);
    await notes.write("me.md", "# Me\n- favourite food: sushi\n");
    await seedTranscript(w, [
      { text: "my favourite food is lasagna now, sushi is over", author: "Ella", waifu: "ella" },
      { text: "Lianne is in kingdom-16062's #secret-room", author: "Mina" }
    ]);
    const waifu = await readWaifu(w.storage, "ella");
    const outcome = await runDream(w.cast.deps, { waifu });
    expect(outcome).toMatchObject({ ok: true, changed: ["MEMORY.md", "me.md", "people/lianne.md"] });
    expect(await notes.read("me.md")).toBe("# Me\n- favourite food: lasagna\n");
    expect(await notes.read("people/lianne.md")).toContain("kingdom-16062");
    // Nothing about Kevin was said: his note is untouched, byte for byte.
    expect(await notes.read("people/kevin.md")).toBe(kevin);
    // The dreamer read the transcript, with her own line as "you".
    const read = JSON.stringify(w.anthropic.calls[1]!.request.messages);
    expect(read).toContain("you: my favourite food is lasagna now");
  });
});

describe("big windows and the dream model", () => {
  it("splits a window over life.dreamWindowMaxChars into sessions, oldest days first, each moving the cursor", async () => {
    const w = await lifeWorld(roots, {
      config: (config) => ({ ...config, life: { ...config.life, dreamWindowMaxChars: 20_000 } }),
      scripts: script(textTurn("first day done"), errorTurn({ code: "server", message: "overloaded", status: 500, retryable: false }))
    });
    const long = "x".repeat(400);
    // Two days of ~60 lines × 420 characters each (yesterday and today).
    const yesterday = Array.from({ length: 60 }, (_, i) => ({ text: `${long} y${i}`, minutesAgo: 24 * 60 - i }));
    const today = Array.from({ length: 60 }, (_, i) => ({ text: `${long} t${i}`, minutesAgo: 120 - i }));
    const ids = await seedTranscript(w, [...yesterday, ...today]);
    const waifu = await readWaifu(w.storage, "ella");
    const outcome = await runDream(w.cast.deps, { waifu });
    expect(outcome).toMatchObject({ ok: false, sessions: 2, lines: 120 });
    expect(openingText(w.anthropic.calls[0]!.request)).toContain("2026-10-23.md");
    expect(openingText(w.anthropic.calls[0]!.request)).not.toContain("2026-10-24.md");
    expect(openingText(w.anthropic.calls[0]!.request)).toContain("later session");
    expect(openingText(w.anthropic.calls[1]!.request)).toContain("2026-10-24.md");
    // The first session finished: its day is covered; the failed second one is read again next time.
    expect((await readDreamCursor(w.storage, "ella")).conversations[ROOM_KEY]!.id).toBe(ids[59]);
  });

  it("with her own model unavailable, she still dreams with life.dreamModel, after a waiting forget scrub it also serves", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("nothing about Mina here"), textTurn("ok")) });
    await seedTranscript(w, [{ text: "hello" }]);
    w.setConfig((config) => ({ ...config, life: { ...config.life, dreamModel: { providerId: "anthropic", modelId: "claude-haiku-5-5" } } }));
    await writeWaifuConfig(w.storage, { id: "ella", name: "Ella", botId: "ella-bot", model: { providerId: "anthropic", modelId: "no-such-model" } });
    const waifu = await readWaifu(w.storage, "ella");
    const maintain = (signal: AbortSignal) => (w.cast as unknown as { maintain(waifu: unknown, signal: AbortSignal): Promise<void> }).maintain(waifu, signal);
    // A forget scrub waiting for her: it runs first (its notes session on the dream model), then the dream.
    await queuePendingScrub(w.storage, "ella", MINA_USER, w.clock.now(), { source: "owner_forget", names: ["Mina"], sharedNames: [] });
    await maintain(new AbortController().signal);
    expect(await readPendingScrubs(w.storage, "ella")).toEqual([]);
    expect(w.ledger.lines.map((line) => [line.purpose, line.modelId])).toEqual([
      ["maintenance", "claude-haiku-5-5"],
      ["maintenance", "claude-haiku-5-5"]
    ]);
    expect(JSON.stringify(w.anthropic.calls[1]!.request.messages[0])).toContain(DREAM_INSTRUCTION.slice(0, 40));
  });

  it("uses life.dreamModel when it is set, else her own model", async () => {
    const w = await lifeWorld(roots, { scripts: script(textTurn("ok"), textTurn("ok")) });
    await seedTranscript(w, [{ text: "hello" }]);
    const waifu = await readWaifu(w.storage, "ella");
    const other = w.cast.deps.catalog().models.find((model) => model.providerId !== waifu.model!.providerId)!;
    expect(other).toBeDefined();
    w.setConfig((config) => ({ ...config, life: { ...config.life, dreamModel: { providerId: other.providerId, modelId: other.modelId } } }));
    await runDream(w.cast.deps, { waifu });
    expect(w.ledger.lines.at(-1)).toMatchObject({ purpose: "maintenance", providerId: other.providerId, modelId: other.modelId });
    await seedTranscript(w, [{ text: "again", minutesAgo: 0 }]);
    w.setConfig((config) => {
      const { dreamModel: _dropped, ...life } = config.life;
      return { ...config, life: life as typeof config.life };
    });
    await runDream(w.cast.deps, { waifu });
    expect(w.ledger.lines.at(-1)).toMatchObject({ purpose: "maintenance", providerId: waifu.model!.providerId, modelId: waifu.model!.modelId });
  });
});
