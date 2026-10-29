// Edit's `tools.apply_patch` (Living cast spec §32.2): Codex's grammar and matching (the parser, the
// four seek passes, anchors, chunks in file order, End of File, a pure-`+` chunk at the end), and
// what is safer than Codex: a chunk matching in two places is refused with its lines, the whole patch
// is saved or none of it, Add File never replaces a file, and her folder rules hold (places.md, the
// checked ~/life/ files, /transcripts read-only, 256 KB). Move and Delete; boot repair of a patch.
// Against a temp data root; no live calls.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalisePunctuation, parsePatch, seekSequence, updateContents, type PatchHunk } from "../src/life/tools/applyPatch.js";
import { offeredToolNames } from "../src/life/tools/index.js";
import type { ToolContext } from "../src/life/tools/types.js";
import { selfAuthorIds } from "../src/life/people.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import { refreshPlacesFile } from "../src/life/home/index.js";
import { readIntents } from "../src/life/lifeStore.js";
import { closeWorlds, herFile, lifeWorld, type LifeWorld } from "./lifeFixtures.js";
import { applyPatch, outputText, runScript } from "./toolCalls.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const hunks = (text: string): PatchHunk[] => {
  const parsed = parsePatch(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.hunks;
};
const update = (original: string, ...lines: string[]) => {
  const [hunk] = hunks(patch("*** Update File: f.txt", ...lines));
  if (hunk?.kind !== "update") throw new Error("not an update");
  return updateContents(original, hunk.chunks, "f.txt");
};

describe("apply_patch: the grammar (Codex's parser)", () => {
  it("parses Add, Delete and Update with Move to, anchors, the three line kinds and End of File", () => {
    expect(
      hunks(
        patch(
          "*** Add File: path/add.py",
          "+abc",
          "+def",
          "*** Delete File: path/delete.py",
          "*** Update File: path/update.py",
          "*** Move to: path/update2.py",
          "@@ def f():",
          "-    pass",
          "+    return 123",
          "*** End of File"
        )
      )
    ).toEqual([
      { kind: "add", path: "path/add.py", contents: "abc\ndef\n", line: 2 },
      { kind: "delete", path: "path/delete.py", line: 5 },
      {
        kind: "update",
        path: "path/update.py",
        movePath: "path/update2.py",
        line: 6,
        chunks: [{ context: "def f():", oldLines: ["    pass"], newLines: ["    return 123"], contextIndices: [], endOfFile: true }]
      }
    ]);
    // The first chunk needs no @@; a context line keeps its pair of indices.
    expect(hunks(patch("*** Update File: file2.py", " import foo", "+bar"))).toEqual([
      { kind: "update", path: "file2.py", line: 2, chunks: [{ oldLines: ["import foo"], newLines: ["import foo", "bar"], contextIndices: [[0, 0]], endOfFile: false }] }
    ]);
    // A heredoc around it is taken off (Codex's lenient mode), and so is space around the markers.
    expect(hunks(`<<'EOF'\n*** Begin Patch \n*** Add File: a\n+x\n *** End Patch\nEOF`)).toEqual([{ kind: "add", path: "a", contents: "x\n", line: 2 }]);
  });

  it("refuses what Codex refuses, with its messages", () => {
    const error = (text: string) => {
      const parsed = parsePatch(text);
      return parsed.ok ? undefined : parsed.error;
    };
    expect(error("bad")).toBe("invalid patch: The first line of the patch must be '*** Begin Patch'");
    expect(error("*** Begin Patch\nbad")).toBe("invalid patch: The last line of the patch must be '*** End Patch'");
    expect(error(patch("*** Update File: test.py"))).toBe("invalid hunk at line 2, Update file hunk for path 'test.py' is empty");
    expect(error(patch("*** Frobnicate File: foo"))).toBe("invalid hunk at line 2, '*** Frobnicate File: foo' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'");
    expect(error(patch("*** Update File: a", "@@", "@@ again"))).toMatch(/^invalid hunk at line 4, Unexpected line found in update hunk: '@@ again'/u);
    expect(error(patch("*** Update File: a", "-x", "bad line"))).toBe("invalid hunk at line 4, Expected update hunk to start with a @@ context marker, got: 'bad line'");
    expect(error(patch("*** Add File: a", "no plus"))).toMatch(/^invalid hunk at line 3, 'no plus' is not a valid hunk header/u);
    // An indented header inside an update is a context line, as in Codex.
    expect(hunks(patch("*** Update File: a", "@@", "  *** Add File: b", "+x"))[0]).toMatchObject({ chunks: [{ oldLines: [" *** Add File: b"] }] });
  });
});

describe("apply_patch: matching (seek_sequence) and the updated file", () => {
  it("tries exact, then trailing whitespace, then both ends, then Unicode punctuation", () => {
    const lines = ["a  ", "  b", "c — “quoted” ‘x’ y"];
    expect(seekSequence(lines, ["a  "], 0, false)).toEqual({ found: 0 });
    expect(seekSequence(lines, ["a"], 0, false)).toEqual({ found: 0 });
    expect(seekSequence(lines, ["b"], 0, false)).toEqual({ found: 1 });
    expect(seekSequence(lines, ['c - "quoted" \'x\' y'], 0, false)).toEqual({ found: 2 });
    expect(normalisePunctuation(" ‐‑‒–—―− ")).toBe("-------");
    expect(seekSequence(lines, ["zzz"], 0, false)).toEqual({ none: true });
    // An End of File chunk is looked for only at the end.
    expect(seekSequence(["x", "y", "x"], ["x"], 0, true)).toEqual({ found: 2 });
    // In the pass that finds it, a second place is reported (ours, not Codex's).
    expect(seekSequence(["x", "y", "x"], ["x"], 0, false, { unique: true })).toEqual({ ambiguous: [0, 2] });
    // A stricter pass that finds one place wins over a looser one that would find two.
    expect(seekSequence(["x", "y", "x  "], ["x"], 0, false, { unique: true })).toEqual({ found: 0 });
  });

  it("applies chunks in file order against the original, keeping context lines and endings", () => {
    const original = "one\ntwo\nthree\nfour\nfive\n";
    expect(update(original, "@@", " one", "-two", "+TWO", "@@", " four", "-five", "+FIVE")).toEqual({ ok: true, contents: "one\nTWO\nthree\nfour\nFIVE\n" });
    // CRLF lines keep theirs; inserted lines take the file's first ending.
    expect(update("a\r\nb\r\n", "@@", " a", "+between")).toEqual({ ok: true, contents: "a\r\nbetween\r\nb\r\n" });
    // A file without a last newline gets one (Codex's historical behaviour).
    expect(update("a\nb", "@@", "-b", "+c")).toEqual({ ok: true, contents: "a\nc\n" });
    // A trailing empty old line stands for the last newline.
    expect(update("a\nb\n", "@@", " b", "-", "+")).toMatchObject({ ok: true });
  });

  it("an anchor narrows where the chunk is; a pure + chunk appends at the end of the file", () => {
    const original = "def f():\n    pass\ndef g():\n    pass\n";
    expect(update(original, "@@ def g():", "-    pass", "+    return 1")).toEqual({ ok: true, contents: "def f():\n    pass\ndef g():\n    return 1\n" });
    expect(update(original, "@@ def h():", "-    pass")).toEqual({ ok: false, error: "Failed to find context 'def h():' in f.txt" });
    expect(update("a\nb\n", "@@ a", "+added")).toEqual({ ok: true, contents: "a\nb\nadded\n" });
  });

  it("refuses a chunk whose lines match in two places, with both line numbers, and one it can't find", () => {
    const original = "title\nlikes: tea\nnotes\nlikes: tea\n";
    expect(update(original, "@@", "-likes: tea", "+likes: coffee")).toEqual({ ok: false, error: "the lines to change in f.txt match in 2 places (lines 2 and 4); add a line above or below to say which" });
    expect(update(original, "@@", " title", "-likes: tea", "+likes: coffee")).toEqual({ ok: true, contents: "title\nlikes: coffee\nnotes\nlikes: tea\n" });
    expect(update(original, "@@ notes", "-likes: tea", "+likes: coffee")).toEqual({ ok: true, contents: "title\nlikes: tea\nnotes\nlikes: coffee\n" });
    expect(update(original, "@@", "-missing", "+x")).toEqual({ ok: false, error: "Failed to find expected lines in f.txt:\nmissing" });
  });

  it("counts a chunk ambiguous only in the first pass that finds it, after the anchor and End of File (§32.3a)", () => {
    // One exact match is taken even though a copy with other spacing is elsewhere.
    expect(update("likes: tea\nlikes: tea  \n", "@@", "-likes: tea", "+likes: coffee")).toEqual({ ok: true, contents: "likes: coffee\nlikes: tea  \n" });
    // Two copies before the anchor don't count: only what follows it.
    expect(update("x\nx\n## B\nx\n", "@@ ## B", "-x", "+y")).toEqual({ ok: true, contents: "x\nx\n## B\ny\n" });
    // End of File: only the copy at the end.
    expect(update("x\nmid\nx\n", "@@", "-x", "+y", "*** End of File")).toEqual({ ok: true, contents: "x\nmid\ny\n" });
    // An anchor line that is in the file twice (after the last change) is refused like a chunk.
    expect(update("## Notes\na\n## Notes\nb\n", "@@ ## Notes", "-b", "+c")).toEqual({ ok: false, error: "the @@ line '## Notes' is in f.txt twice (lines 1 and 3); use a line that is there once" });
  });
});

async function ctxFor(w: LifeWorld, o: { intent?: boolean; mode?: ToolContext["mode"]; session?: ToolContext["session"] } = {}): Promise<ToolContext> {
  const deps = w.cast.deps;
  const waifu = await readWaifu(w.storage, "ella");
  const route = deps.catalog().models.find((model) => model.providerId === waifu.model!.providerId && model.modelId === waifu.model!.modelId)!;
  return {
    deps,
    waifu,
    route,
    turn: { id: "turn-1", sentPlaces: new Set(), dmUsersSent: new Set(), fetches: 0 },
    signal: new AbortController().signal,
    toolCallId: "call_p",
    selfAuthorIds: await selfAuthorIds(w.storage, waifu),
    toolNames: offeredToolNames(deps),
    ...(o.mode ? { mode: o.mode } : {}),
    ...(o.session ? { session: o.session } : {}),
    ...(o.intent ? { intent: { turnId: "turn-1", toolCallId: "call_p", tool: "Edit", argsDigest: "d" } } : {})
  };
}

const home = (w: LifeWorld, relative: string) => path.join(w.root, "user", "waifus", "ella", "home", ...relative.split("/"));
async function put(w: LifeWorld, relative: string, content: string) {
  await mkdir(path.dirname(home(w, relative)), { recursive: true });
  await writeFile(home(w, relative), content);
}

describe("apply_patch: the tool (her files, all or nothing)", () => {
  it("adds, updates, moves and deletes in one patch, and says what it did", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w, { intent: true });
    await put(w, "MEMORY.md", "# Memory\n- [Kevin](people/kevin.md)\n");
    await put(w, "old.md", "move me\n");
    await put(w, "gone.md", "bye\n");
    const result = await applyPatch(
      ctx,
      patch(
        "*** Update File: ~/MEMORY.md",
        "@@",
        " - [Kevin](people/kevin.md)",
        "+- [Mina](people/mina.md)",
        "*** Add File: ~/people/mina.md",
        "+# Mina",
        "+likes brownies",
        "*** Update File: ~/old.md",
        "*** Move to: ~/archive/new.md",
        "@@",
        "-move me",
        "+moved",
        "*** Delete File: ~/gone.md"
      )
    );
    expect(result.isError).toBeUndefined();
    expect(outputText(result).split("\n")[0]).toBe("Updated: M ~/MEMORY.md, A ~/people/mina.md, M ~/archive/new.md (from ~/old.md), D ~/gone.md");
    expect(await herFile(w, "ella", "home/MEMORY.md")).toBe("# Memory\n- [Kevin](people/kevin.md)\n- [Mina](people/mina.md)\n");
    expect(await herFile(w, "ella", "home/people/mina.md")).toBe("# Mina\nlikes brownies\n");
    expect(await herFile(w, "ella", "home/archive/new.md")).toBe("moved\n");
    expect(await herFile(w, "ella", "home/old.md")).toBeUndefined();
    expect(await herFile(w, "ella", "home/gone.md")).toBeUndefined();
    // Its intent lines: the patch before its change set, its line done after (boot repair).
    const intents = (await readIntents(w.storage, "ella")).filter((intent) => intent.toolCallId === "call_p");
    expect(intents.map((intent) => [intent.contentDigest, intent.lineDone])).toEqual([["patch:1", undefined], [undefined, true]]);
  });

  it("saves nothing when any part of the patch fails: a missing chunk, a duplicate, Add File on an existing file", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    await put(w, "a.md", "one\ntwo\n");
    await put(w, "b.md", "x\nsame\ny\nsame\n");
    const before = async () => [await herFile(w, "ella", "home/a.md"), await herFile(w, "ella", "home/b.md"), await herFile(w, "ella", "home/c.md")];
    const start = await before();
    const missing = await applyPatch(ctx, patch("*** Update File: ~/a.md", "@@", "-one", "+ONE", "*** Update File: ~/b.md", "@@", "-nothere", "+z"));
    expect(missing.isError).toBe(true);
    expect(outputText(missing)).toBe("error: Error: tools.apply_patch: Failed to find expected lines in ~/b.md:\nnothere; nothing was changed (line 1)");
    const duplicate = await applyPatch(ctx, patch("*** Add File: ~/c.md", "+new", "*** Update File: ~/b.md", "@@", "-same", "+other"));
    expect(outputText(duplicate)).toMatch(/the lines to change in ~\/b\.md match in 2 places \(lines 2 and 4\); add a line above or below to say which; nothing was changed/u);
    const exists = await applyPatch(ctx, patch("*** Update File: ~/a.md", "@@", "-one", "+ONE", "*** Add File: ~/b.md", "+replaced"));
    expect(outputText(exists)).toMatch(/Add File: ~\/b\.md already exists; change it with \*\*\* Update File; nothing was changed/u);
    const updateMissing = await applyPatch(ctx, patch("*** Update File: ~/nope.md", "@@", "+x"));
    expect(outputText(updateMissing)).toMatch(/Update File: ~\/nope\.md doesn't exist/u);
    const deleteMissing = await applyPatch(ctx, patch("*** Delete File: ~/nope.md"));
    expect(outputText(deleteMissing)).toMatch(/Delete File: ~\/nope\.md doesn't exist/u);
    // One Update per file in a patch; Move onto an existing file. (Chunks are found in file order, each
    // after the one before, so two can't overlap; updateContents still refuses it if they ever did.)
    const twice = await applyPatch(ctx, patch("*** Update File: ~/a.md", "@@", "-one", "+ONE", "*** Update File: ~/a.md", "@@", "-two", "+TWO"));
    expect(outputText(twice)).toMatch(/tools\.apply_patch: ~\/a\.md is updated twice in this patch; put all its changes under one \*\*\* Update File, in file order; nothing was changed/u);
    const onto = await applyPatch(ctx, patch("*** Update File: ~/a.md", "*** Move to: ~/b.md", "@@", "-one", "+ONE"));
    expect(outputText(onto)).toMatch(/Move to: ~\/b\.md already exists; nothing was changed/u);
    expect(await before()).toEqual(start);
  });

  it("takes the patch as a list of lines joined, so backticks, quotes and ${…} in her notes stay as they are", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    const script = 'return await tools.apply_patch(["*** Begin Patch", "*** Add File: ~/code.md", "+use `npm test` and \\"${HOME}\\"", "*** End Patch"].join("\\n"))';
    const output = await runScript("Edit", script, ctx);
    expect(outputText(output)).toBe("Updated: A ~/code.md\n[receipt] apply_patch 1: saved A ~/code.md");
    expect(await readFile(home(w, "code.md"), "utf8")).toBe('use `npm test` and "${HOME}"\n');
  });

  it("checks, matches and saves under her home lock: patches at once each see the ones saved before it (§32.3a)", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    await put(w, "n.md", "notes\n");
    // Each appends a line: with the read and the save under one hold, none is lost or refused.
    const append = (n: number) => `tools.apply_patch(["*** Begin Patch", "*** Update File: ~/n.md", "@@", "+line ${n}", "*** End Patch"].join("\\n"))`;
    const output = await runScript("Edit", `const r = await Promise.allSettled([${append(1)}, ${append(2)}, ${append(3)}]); return r.map((x) => x.status === "fulfilled" ? "fulfilled" : x.reason.message)`, ctx);
    expect(outputText(output).split("\n")[0]).toBe('["fulfilled","fulfilled","fulfilled"]');
    const lines = (await readFile(home(w, "n.md"), "utf8")).split("\n");
    expect(lines[0]).toBe("notes");
    expect(lines.slice(1, 4).sort()).toEqual(["line 1", "line 2", "line 3"]);
  });

  it("holds her folder rules: places.md, the checked ~/life/ files, /transcripts, 256 KB, a parse error", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    const places = await applyPatch(ctx, patch("*** Delete File: ~/life/places.md"));
    expect(outputText(places)).toMatch(/places\.md is kept up to date for you and can't be changed; nothing was changed/u);
    const wakeups = await applyPatch(ctx, patch("*** Add File: ~/life/wakeups.json", "+[ {\"kind\": \"at\" ]"));
    expect(outputText(wakeups)).toMatch(/wakeups\.json/u);
    expect(outputText(wakeups)).toMatch(/nothing was changed/u);
    expect(await herFile(w, "ella", "home/life/wakeups.json")).toBeUndefined();
    const transcripts = await applyPatch(ctx, patch("*** Add File: /transcripts/x.md", "+no"));
    expect(outputText(transcripts)).toMatch(/transcripts are read-only; nothing was changed/u);
    // A Move from or to a protected path is refused (§32.3a).
    await refreshPlacesFile(w.cast.deps, await readWaifu(w.storage, "ella"));
    const fromPlaces = await applyPatch(ctx, patch("*** Update File: ~/life/places.md", "*** Move to: ~/places-copy.md", "@@", "+more"));
    expect(outputText(fromPlaces)).toMatch(/places\.md is kept up to date for you and can't be changed; nothing was changed/u);
    await put(w, "note.md", "x\n");
    const toPlaces = await applyPatch(ctx, patch("*** Update File: ~/note.md", "*** Move to: ~/life/places.md", "@@", "-x", "+y"));
    expect(outputText(toPlaces)).toMatch(/nothing was changed/u);
    expect(await herFile(w, "ella", "home/note.md")).toBe("x\n");
    const big = await runScript("Edit", `text(await tools.apply_patch("*** Begin Patch\\n*** Add File: ~/big.md\\n" + ("+" + "x".repeat(1000) + "\\n").repeat(300) + "*** End Patch"))`, ctx);
    expect(outputText(big)).toMatch(/a file can be at most 256 KB/u);
    expect(await herFile(w, "ella", "home/big.md")).toBeUndefined();
    const parse = await applyPatch(ctx, "*** Update File: ~/x.md");
    expect(outputText(parse)).toMatch(/apply_patch: invalid patch: The first line of the patch must be '\*\*\* Begin Patch'; nothing was changed/u);
    const notText = await runScript("Edit", `await tools.apply_patch({ patch: "x" })`, ctx);
    expect(outputText(notText)).toMatch(/^error: TypeError: tools\.apply_patch takes the patch as one string/u);
    // A valid special file goes through the same checks and is saved (with its ids added).
    const ok = await applyPatch(ctx, patch("*** Add File: ~/life/wakeups.json", '+[{"kind": "at", "when": "in 2h", "note": "tea"}]'));
    expect(outputText(ok)).toMatch(/^Updated: A ~\/life\/wakeups\.json/u);
    expect(await herFile(w, "ella", "home/life/wakeups.json")).toMatch(/"id": "t1"/u);
  });

  it("a dream leaves ~/life/ alone and a tidy session never changes her profile", async () => {
    const w = await lifeWorld(roots);
    const dream = await applyPatch(await ctxFor(w, { mode: "session", session: "dream" }), patch("*** Add File: ~/life/notes.txt", "+x"));
    expect(outputText(dream)).toMatch(/isn't changed while dreaming/u);
    const tidy = await applyPatch(await ctxFor(w, { mode: "session", session: "maintenance" }), patch("*** Delete File: ~/life/profile.json"));
    expect(tidy.isError).toBe(true);
  });

  it("refuses a file changed under her between her read and the save", async () => {
    const w = await lifeWorld(roots);
    const ctx = await ctxFor(w);
    await put(w, "a.md", "one\n");
    // The script patches twice: the second patch reads the file the first one wrote.
    const twice = await runScript(
      "Edit",
      `text(await tools.apply_patch("*** Begin Patch\\n*** Update File: ~/a.md\\n@@\\n-one\\n+two\\n*** End Patch"));
       text(await tools.apply_patch("*** Begin Patch\\n*** Update File: ~/a.md\\n@@\\n-two\\n+three\\n*** End Patch"));`,
      ctx
    );
    expect(outputText(twice)).toBe("Updated: M ~/a.md\nUpdated: M ~/a.md\n[receipt] apply_patch 1: saved M ~/a.md\n[receipt] apply_patch 2: saved M ~/a.md");
    expect(await readFile(home(w, "a.md"), "utf8")).toBe("three\n");
    const five = await runScript("Edit", `for (let i = 0; i < 5; i++) await tools.apply_patch("*** Begin Patch\\n*** Add File: ~/n" + i + ".md\\n+x\\n*** End Patch")`, ctx);
    expect(outputText(five)).toMatch(/tools\.apply_patch: at most 4 calls in one script/u);
  });
});
