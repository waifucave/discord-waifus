// The tool script sandbox (Living cast spec §32.1, from §31.4's web script): her program in QuickJS in
// its own worker per call, with `tools.<fn>` host calls answered by a fake host here. Covers `text()`
// and the return-value fallback, images, the output cap, errors with lines, another tool's functions
// and old habits as readable errors, functions passed as source, and the abuse cases: host calls after
// the script ended, unawaited calls, re-entrant calls, huge arguments, a hanging host call, CPU between
// calls, a host whose event loop blocks, memory, stack, nothing of the host. No tools: fake answers.
import { describe, expect, it } from "vitest";
import { runToolScript, type ToolCall, type ToolCallAnswer, type ToolScriptOutcome } from "../src/life/sandbox/toolScript.js";

const NOW = new Date("2026-10-28T12:00:00Z");
const TZ = "Europe/Berlin";
const SURFACE = {
  functions: ["echo", "fail", "hang"],
  others: { read_file: "tools.read_file is the Read tool's; call Read" },
  legacy: { search: "search() is gone: call tools.web__run({ search_query: [{ q: \"…\" }] })" }
};

type Seen = { fn: string; arg: unknown };

function fakeHost(o: { onCall?: (seen: Seen) => void; slowMs?: number } = {}) {
  const seen: Seen[] = [];
  const call: ToolCall = async (fn, arg, signal) => {
    seen.push({ fn, arg });
    o.onCall?.({ fn, arg });
    if (fn === "hang") return new Promise<ToolCallAnswer>((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, error: "aborted" })));
    if (o.slowMs) await new Promise((resolve) => setTimeout(resolve, o.slowMs));
    if (fn === "fail") return { ok: false, name: "TypeError", error: "tools.fail: that field is wrong" };
    return { ok: true, value: arg };
  };
  return { call, seen };
}

const run = (script: string, host = fakeHost(), extra: Partial<Parameters<typeof runToolScript>[2]> = {}) => runToolScript(script, host.call, { surface: SURFACE, timeZone: TZ, now: NOW, ...extra });
/** What she was shown, as one text (images as `[image id]`). */
const shown = (outcome: ToolScriptOutcome) => outcome.shown.map((item) => (item.kind === "text" ? item.text : `[image ${item.id}]`)).join("\n");

describe("tool script sandbox: what she sees", () => {
  it("text() shows text as is and anything else as compact JSON; console.log is text()", async () => {
    const result = await run(`text("a"); text({b: 2}); console.log("c", 1); text(await tools.echo({x: [1, 2]}));`);
    expect(shown(result)).toBe('a\n{"b":2}\nc 1\n{"x":[1,2]}');
    expect(result.error).toBeUndefined();
  }, 30_000);

  it("without text() the return value is shown; nothing at all is empty", async () => {
    expect(shown(await run(`return "hello"`))).toBe("hello");
    expect(shown(await run(`return {a: 1}`))).toBe('{"a":1}');
    expect(await run(`const x = 1;`)).toMatchObject({ shown: [], empty: true });
    // Once she called text(), her return value is not shown as well.
    expect(shown(await run(`text("shown"); return "not shown"`))).toBe("shown");
  }, 30_000);

  it("an image result is shown as the picture, by text() or as the return value; anything else is JSON", async () => {
    const image = `{kind: "image", image_id: "img1", path: "~/a.png"}`;
    expect((await run(`text(${image})`)).shown).toEqual([{ kind: "image", id: "img1" }]);
    expect((await run(`return ${image}`)).shown).toEqual([{ kind: "image", id: "img1" }]);
    expect(shown(await run(`text("look", ${image})`))).toBe('look {"kind":"image","image_id":"img1","path":"~/a.png"}');
  }, 30_000);

  it("calls take one value; functions inside it go to the host as their source", async () => {
    const host = fakeHost();
    await run(`await tools.echo({ filter: (m, state) => m.text.includes("hi"), when: "fri" })`, host);
    expect(host.seen[0]!.arg).toEqual({ filter: { $function: '(m, state) => m.text.includes("hi")' }, when: "fri" });
    // Her own toString changes nothing: the source is read with Function.prototype.toString as it was.
    await run(`Function.prototype.toString = () => "(m) => true"; const f = (m) => kevin; f.toString = () => "x"; await tools.echo(f)`, host);
    expect(host.seen[1]!.arg).toEqual({ $function: "(m) => kevin" });
    expect((await run(`await tools.echo(1, 2)`)).error).toMatch(/^TypeError: tools\.echo takes one argument \(line 1\)$/u);
  }, 30_000);

  it("another tool's function and an old habit throw a readable error naming what to use", async () => {
    expect((await run(`\nawait tools.read_file({ path: "~/x" })`)).error).toBe("TypeError: tools.read_file is the Read tool's; call Read (line 2)");
    expect((await run(`await search("x")`)).error).toMatch(/^TypeError: search\(\) is gone: call tools\.web__run/u);
    expect((await run(`await tools.nope()`)).error).toMatch(/^TypeError: .*not a function/u);
  }, 30_000);
});

describe("tool script sandbox: errors and the output cap", () => {
  it("shows her error with its line, after what she showed before it", async () => {
    const result = await run(`text("before");\nconst x = null;\nx.y = 1;`);
    expect(shown(result)).toBe("before");
    expect(result.error).toMatch(/^TypeError: .+ \(line 3\)$/u);
    const syntax = await run(`const a = 1;\nconst = 2;`);
    expect(syntax.error).toMatch(/^SyntaxError: .+ \(line 2\)$/u);
    const caught = await run(`try { await tools.fail({}); } catch (e) { return e.name + ": " + e.message; }`);
    expect(shown(caught)).toBe("TypeError: tools.fail: that field is wrong");
    // A call that fails names the line she made it on.
    const failed = await run(`text("first");\n\nawait tools.fail({});`);
    expect(failed).toMatchObject({ error: "TypeError: tools.fail: that field is wrong (line 3)" });
    expect(shown(failed)).toBe("first");
  }, 30_000);

  it("cuts what she shows at the tool's cap", async () => {
    expect(shown(await run(`return "x".repeat(20000)`))).toBe(`${"x".repeat(8_000)}… (cut)`);
    const many = shown(await run(`for (let i = 0; i < 50; i++) text("y".repeat(1000));`));
    expect(many.length).toBeLessThanOrEqual(8_000 + 50 + "… (cut)".length);
    expect(many.endsWith("… (cut)")).toBe(true);
    const huge = shown(await run(`text("z".repeat(3000000)); return 1`));
    expect(huge.startsWith("zzz")).toBe(true);
    expect(huge.length).toBeLessThanOrEqual(8_000 + "… (cut)".length);
    const bigger = shown(await run(`return "w".repeat(150000)`, fakeHost(), { limits: { maxOutputChars: 100_000 } }));
    expect(bigger).toBe(`${"w".repeat(100_000)}… (cut)`);
  }, 30_000);

  it("waits for nothing that never comes: an error, not a hang", async () => {
    const result = await run(`await new Promise(() => {}); return "never"`);
    expect(result.error).toBe("Error: your script is waiting for something that never finishes");
  }, 30_000);
});

describe("tool script sandbox: abuse of the async host functions", () => {
  it("makes no call once her program has ended (later jobs and her return value's toJSON)", async () => {
    const host = fakeHost();
    const late = await run(`Promise.resolve().then(() => Promise.resolve()).then(() => tools.echo("late")); return "done"`, host);
    expect(shown(late)).toBe("done");
    const returned = await run(`return { toJSON() { tools.echo("after"); return 1; } }`, host);
    expect(returned.error).toMatch(/the script has ended/u);
    expect(host.seen).toEqual([]);
  }, 30_000);

  it("an unawaited call ends with the script: its answer is not waited for and its signal is aborted", async () => {
    const signals: AbortSignal[] = [];
    const call: ToolCall = (_fn, _arg, signal) => {
      signals.push(signal);
      return new Promise(() => undefined);
    };
    const started = Date.now();
    const result = await runToolScript(`tools.echo("a"); tools.hang("b"); return "ok"`, call, { surface: SURFACE, timeZone: TZ, now: NOW });
    expect(shown(result)).toBe("ok");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  }, 30_000);

  it("a call made while another one's argument is read (re-entrant) is just another call", async () => {
    const host = fakeHost();
    const result = await run(`const r = await tools.echo({ toJSON() { tools.echo("inner"); return "outer"; } }); return r`, host);
    expect(shown(result)).toBe("outer");
    expect(host.seen.map((call) => call.arg)).toEqual(["inner", "outer"]);
    const both = await run(`const [a, b] = await Promise.all([tools.echo("a"), tools.echo("b")]); return a + b`, host);
    expect(shown(both)).toBe("ab");
  }, 30_000);

  it("refuses huge arguments before they reach the host, and too many calls", async () => {
    const host = fakeHost();
    const huge = await run(`await tools.echo("x".repeat(100000))`, host);
    expect(huge.error).toMatch(/^RangeError: what you gave tools\.echo\(\) can't be sent/u);
    const many = await run(`for (let i = 0; i < 30; i++) tools.echo("q" + i); return "x"`, host);
    expect(many.error).toMatch(/at most 24 tool calls/u);
    expect(host.seen).toHaveLength(24);
    // A tool may allow longer arguments (apply_patch).
    const long = await run(`return (await tools.echo("y".repeat(50000))).length`, fakeHost(), { limits: { maxArgChars: 64 * 1024 } });
    expect(shown(long)).toBe("50000");
  }, 30_000);

  it("a host call that hangs ends at the wall clock, keeping what she showed; an abort ends it at once", async () => {
    const result = await run(`text("waiting"); await tools.hang("x"); return "never"`, fakeHost(), { wallMs: 400 });
    expect(result).toMatchObject({ stop: "wall", error: "your script ran for 0 seconds and was stopped" });
    expect(shown(result)).toBe("waiting");
    const wall = await run(`await tools.hang("x")`, fakeHost(), { wallMs: 1_500 });
    expect(wall.error).toBe("your script ran for 2 seconds and was stopped");
    const controller = new AbortController();
    const pending = run(`await tools.hang("y")`, fakeHost(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    expect(await pending).toMatchObject({ stop: "aborted" });
  }, 30_000);

  it("her own computing is limited between host calls; waiting for the host is not counted", async () => {
    expect(await run(`while (true) {}`, fakeHost(), { limits: { cpuMs: 100 } })).toMatchObject({ stop: "time" });
    const waits = await run(`await tools.echo("a"); await tools.echo("b"); return "fine"`, fakeHost({ slowMs: 300 }), { limits: { cpuMs: 100 } });
    expect(shown(waits)).toBe("fine");
    const split = await run(`const spin = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} };\nspin(70); await tools.echo("a"); spin(70); return "late"`, fakeHost(), { limits: { cpuMs: 100 } });
    expect(split).toMatchObject({ stop: "time" });
    // Her own backtracking RegExp runs in QuickJS, under the same limit.
    const regex = await run(`return /(a+)+$/.test("a".repeat(40) + "!")`, fakeHost(), { limits: { cpuMs: 100 } });
    expect(regex).toMatchObject({ stop: "time" });
  }, 30_000);

  it("a host whose own event loop is blocked never counts against her time (busy time from the worker's stamps)", async () => {
    // The host blocks its event loop for 1.5 s while answering (her budget is 1 s): the worker's idle
    // message waits behind it, but her busy time comes from the worker's own stamps.
    const blocking: ToolCall = async () => {
      const end = Date.now() + 1_500;
      while (Date.now() < end) {
        // the host is busy with something else
      }
      return { ok: true, value: [] };
    };
    const twice = await runToolScript(`await tools.echo("a"); await tools.echo("b"); return "fine"`, blocking, { surface: SURFACE, timeZone: TZ, now: NOW });
    expect(shown(twice)).toBe("fine");
    expect(twice.error).toBeUndefined();
    const spinning = await runToolScript(`await tools.echo("a"); const end = Date.now() + 1500; while (Date.now() < end) {} return "late"`, blocking, { surface: SURFACE, timeZone: TZ, now: NOW });
    expect(spinning).toMatchObject({ stop: "time" });
  }, 30_000);

  it("memory and stack limits are hers", async () => {
    expect(await run(`return "x".repeat(32 * 1024 * 1024).length`)).toMatchObject({ stop: "memory", error: "your script used too much memory" });
    expect(await run(`const a = []; while (true) a.push(new Array(10000).fill(a.length));`)).toMatchObject({ stop: expect.stringMatching(/^(memory|time)$/u) });
    expect(await run(`const f = () => f(); f();`)).toMatchObject({ stop: "stack" });
  }, 30_000);

  it("reaches nothing of the host; Date is the app's clock in her zone", async () => {
    const result = await run(`return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof host, typeof out, typeof outImage, typeof globalThis.__host, new Date().getHours()].join(",")`);
    expect(shown(result)).toBe("undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,13");
  }, 30_000);
});
