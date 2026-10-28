// `Web(script)`'s sandbox (Living cast spec §31.1): her program in QuickJS in its own worker per call,
// with awaited host calls answered by a fake host here. Covers the functions' shapes, prints and the
// 8,000-character cap, errors with lines, and the abuse cases: host calls after the script ended,
// unawaited calls, re-entrant calls, huge arguments, a host call that hangs, CPU and memory limits,
// a slow RegExp in find, and nothing of the host reachable. No web: the host answers are fakes.
import { describe, expect, it } from "vitest";
import { runWebScript, type WebCall, type WebCallAnswer } from "../src/life/sandbox/webScript.js";

const NOW = new Date("2026-10-28T12:00:00Z");
const TZ = "Europe/Berlin";

type Seen = { fn: string; args: unknown[] };

function fakeHost(o: { pages?: Record<string, { text: string; links?: Array<{ text: string; url: string }>; title?: string }>; hang?: boolean; onCall?: (seen: Seen) => void } = {}) {
  const seen: Seen[] = [];
  let pageN = 0;
  const call: WebCall = async (fn, args, signal) => {
    seen.push({ fn, args });
    o.onCall?.({ fn, args });
    if (o.hang) {
      return new Promise<WebCallAnswer>((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, error: "aborted" })));
    }
    if (fn === "search") {
      const query = String(args[0]);
      return { ok: true, value: [1, 2].map((n) => ({ n, title: `${query} ${n}`, url: `https://example.com/${encodeURIComponent(query)}/${n}`, snippet: `about ${query}` })) };
    }
    if (fn === "open") {
      const url = String(args[0]);
      const page = o.pages?.[url];
      if (!page) return { ok: false, error: "open: the page answered with an error (404)" };
      pageN += 1;
      const options = (args[1] ?? {}) as { line?: number };
      return { ok: true, value: { id: `p${pageN}`, url, title: page.title ?? "A page", status: 200, text: page.text, links: page.links ?? [], ...(options.line !== undefined ? { line: options.line } : {}) } };
    }
    return { ok: true, value: `answer to ${String(args[1])}` };
  };
  return { call, seen };
}

const run = (script: string, host = fakeHost(), extra: Parameters<typeof runWebScript>[2] extends infer T ? Partial<T> : never = {}) => runWebScript(script, host.call, { timeZone: TZ, now: NOW, ...extra });

describe("Web script sandbox", () => {
  it("returns text as is and objects as compact JSON, after her prints", async () => {
    expect(await run(`return "hello"`)).toMatchObject({ output: "hello", empty: false });
    expect(await run(`print("a", 1, {b: 2}); console.log("c"); return {x: [1, 2]}`)).toMatchObject({ output: 'a 1 {"b":2}\nc\n{"x":[1,2]}' });
    expect(await run(`const x = 1;`)).toMatchObject({ output: "", empty: true });
  }, 30_000);

  it("searches and opens with awaits, then reads lines, finds and follows links", async () => {
    const text = ["# Lemon tart", "", "Preheat the oven to 180C.", "See [the crust](/crust) first.", ...Array.from({ length: 200 }, (_, i) => `Step ${i}: stir ${"well ".repeat(10)}`), "Bake until golden. [Next](https://example.com/next)"].join("\n");
    const host = fakeHost({
      pages: {
        "https://example.com/lemon%20tart/1": { text, title: "Lemon tart", links: [{ text: "the crust", url: "https://example.com/crust" }, { text: "Next", url: "https://example.com/next" }] },
        "https://example.com/crust": { text: "Crust: butter and flour." }
      }
    });
    const result = await run(
      `const hits = await search("lemon tart", {n: 2});
       const page = await open(hits[0]);
       print(page.title, page.line, page.total, page.more, JSON.stringify(page.links));
       print(page.lines.split("\\n").slice(0, 3).join(" | "));
       const found = page.find("OVEN");
       print(JSON.stringify(found));
       const later = page.next();
       print(later.line, later.lines.split("\\n")[0]);
       const end = page.at(page.total - 1);
       print(end.more, JSON.stringify(end.links), end.next());
       const crust = await page.link(1);
       return crust.lines;`,
      host
    );
    expect(result.error).toBeUndefined();
    const lines = result.output.split("\n");
    expect(lines[0]).toBe('Lemon tart 0 205 true [{"n":1,"text":"the crust","url":"https://example.com/crust"}]');
    expect(lines[1]).toBe("0: # Lemon tart | 2: Preheat the oven to 180C. | 3: See [the crust](/crust) first.");
    expect(JSON.parse(lines[2]!)).toEqual([{ line: 2, text: "Preheat the oven to 180C.\nSee [the crust](/crust) first." }]);
    expect(lines[3]).toMatch(/^\d+ \d+: Step \d+: stir/u);
    expect(lines[4]).toBe('false [{"n":2,"text":"Next","url":"https://example.com/next"}] null');
    expect(lines[5]).toBe("0: Crust: butter and flour.");
    expect(host.seen.map((call) => call.fn)).toEqual(["search", "open", "open"]);
    expect(host.seen[0]!.args).toEqual(["lemon tart", { n: 2 }]);
    expect(host.seen[2]!.args).toEqual(["https://example.com/crust", null]);
  }, 30_000);
});

describe("Web script sandbox: errors and the output cap", () => {
  it("shows her error with its line, keeping what she printed before it", async () => {
    const result = await run(`print("before");\nconst x = null;\nx.y = 1;`);
    expect(result.output).toBe("before");
    expect(result.error).toMatch(/^TypeError: .+ \(line 3\)$/u);
    const syntax = await run(`const a = 1;\nconst = 2;`);
    expect(syntax.error).toMatch(/^SyntaxError: .+ \(line 2\)$/u);
    const caught = await run(`try { await open("https://example.com/missing"); } catch (e) { return "caught: " + e.message; }`);
    expect(caught.output).toBe("caught: open: the page answered with an error (404)");
    // A web call that fails names the line she made it on.
    const failed = await run(`print("first");\n\nconst page = await open("https://example.com/missing");`);
    expect(failed).toMatchObject({ output: "first", error: "Error: open: the page answered with an error (404) (line 3)" });
  }, 30_000);

  it("cuts prints and the result at 8,000 characters", async () => {
    const long = await run(`return "x".repeat(20000)`);
    expect(long.output).toBe(`${"x".repeat(8_000)}… (cut)`);
    const printed = await run(`for (let i = 0; i < 50; i++) print("y".repeat(1000)); return "end";`);
    expect(printed.output.length).toBe(8_000 + "… (cut)".length);
    expect(printed.output.endsWith("… (cut)")).toBe(true);
    const huge = await run(`print("z".repeat(3000000)); return 1`);
    expect(huge.output.startsWith("zzz")).toBe(true);
    expect(huge.output.length).toBeLessThanOrEqual(8_000 + "… (cut)".length);
  }, 30_000);

  it("waits for nothing that never comes: an error, not a hang", async () => {
    const result = await run(`await new Promise(() => {}); return "never"`);
    expect(result.error).toBe("Error: your script is waiting for something that never finishes");
  }, 30_000);
});

describe("Web script sandbox: abuse of the async host functions", () => {
  it("makes no web call once her program has ended (later jobs and her return value's toJSON)", async () => {
    const host = fakeHost();
    const late = await run(`Promise.resolve().then(() => Promise.resolve()).then(() => search("late")); return "done"`, host);
    expect(late.output).toBe("done");
    const shown = await run(`return { toJSON() { search("after"); return 1; } }`, host);
    expect(shown.error).toMatch(/the script has ended/u);
    expect(host.seen).toEqual([]);
  }, 30_000);

  it("an unawaited call ends with the script: its answer is not waited for and its signal is aborted", async () => {
    const signals: AbortSignal[] = [];
    const call: WebCall = (_fn, _args, signal) => {
      signals.push(signal);
      return new Promise(() => undefined);
    };
    const started = Date.now();
    const result = await runWebScript(`search("a"); open("https://example.com"); return "ok"`, call, { timeZone: TZ, now: NOW });
    expect(result.output).toBe("ok");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  }, 30_000);

  it("a call made while another one's arguments are read (re-entrant) is just another call", async () => {
    const host = fakeHost();
    const result = await run(`const hits = await search({ toJSON() { search("inner"); return "outer"; } }); return hits[0].title`, host);
    expect(result.output).toBe("outer 1");
    expect(host.seen.map((call) => call.args[0])).toEqual(["inner", "outer"]);
    const both = await run(`const [a, b] = await Promise.all([search("a"), search("b")]); return a[0].title + b[0].title`, host);
    expect(both.output).toBe("a 1b 1");
  }, 30_000);

  it("refuses huge arguments before they reach the host, and too many calls", async () => {
    const host = fakeHost();
    const huge = await run(`await search("x".repeat(100000))`, host);
    expect(huge.error).toMatch(/^RangeError: what you gave search\(\) can't be sent/u);
    const many = await run(`for (let i = 0; i < 30; i++) search("q" + i); return "x"`, host);
    expect(many.error).toMatch(/at most 24 web calls/u);
    expect(host.seen).toHaveLength(24);
  }, 30_000);

  it("a host call that hangs ends at the wall clock, keeping her prints; an abort ends it at once", async () => {
    const host = fakeHost({ hang: true });
    const result = await run(`print("waiting"); await search("x"); return "never"`, host, { wallMs: 400 });
    expect(result).toMatchObject({ output: "waiting", stop: "wall", error: "your script ran for 60 seconds and was stopped" });
    const controller = new AbortController();
    const pending = run(`await search("y")`, fakeHost({ hang: true }), { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    expect(await pending).toMatchObject({ stop: "aborted" });
  }, 30_000);

  it("her own computing is limited between host calls; waiting for the host is not counted", async () => {
    const spin = await run(`while (true) {}`, fakeHost(), { limits: { cpuMs: 100 } });
    expect(spin).toMatchObject({ stop: "time" });
    const slow: WebCall = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, value: [] }), 300));
    const waits = await runWebScript(`await search("a"); await search("b"); return "fine"`, slow, { timeZone: TZ, now: NOW, limits: { cpuMs: 100 } });
    expect(waits.output).toBe("fine");
    const split = await run(`const spin = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} };\nspin(70); await search("a"); spin(70); return "late"`, fakeHost(), { limits: { cpuMs: 100 } });
    expect(split).toMatchObject({ stop: "time" });
  }, 30_000);

  it("a RegExp that backtracks forever in find is stopped by the watchdog", async () => {
    const host = fakeHost({ pages: { "https://example.com/a": { text: `${"a".repeat(40)}!` } } });
    const started = Date.now();
    const result = await run(`const page = await open("https://example.com/a"); return page.find(/(a+)+$/)`, host, { limits: { cpuMs: 100 } });
    expect(result).toMatchObject({ stop: "time" });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it("memory and stack limits are hers", async () => {
    expect(await run(`return "x".repeat(32 * 1024 * 1024).length`)).toMatchObject({ stop: "memory", error: "your script used too much memory" });
    expect(await run(`const a = []; while (true) a.push(new Array(10000).fill(a.length));`)).toMatchObject({ stop: expect.stringMatching(/^(memory|time)$/u) });
    expect(await run(`const f = () => f(); f();`)).toMatchObject({ stop: "stack" });
  }, 30_000);

  it("reaches nothing of the host; Date is the app's clock in her zone", async () => {
    const result = await run(`return [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof host, typeof pageOp, typeof out, typeof globalThis.__host, new Date().getHours()].join(",")`);
    expect(result.output).toBe("undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,13");
  }, 30_000);

  it("a page's methods only work on pages she opened, and give readable errors", async () => {
    const host = fakeHost({ pages: { "https://example.com/a": { text: "one\ntwo" } } });
    const result = await run(
      `const page = await open("https://example.com/a");
       const errors = [];
       for (const f of [() => page.at(99), () => page.at("x"), () => page.link(1), () => page.find(42), () => page.find("")]) {
         try { f(); } catch (e) { errors.push(e.name + ": " + e.message); }
       }
       return errors.join("\\n")`,
      host
    );
    expect(result.output.split("\n")).toEqual([
      "RangeError: the page has lines 0 to 1",
      "TypeError: at takes a line number, like page.at(120)",
      "RangeError: this page has no links",
      "TypeError: find takes text or a RegExp",
      "TypeError: find needs something to look for"
    ]);
  }, 30_000);
});
