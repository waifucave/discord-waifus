// The sandbox her Wakeup code runs in (Living cast spec §30.1, §30.5): QuickJS in a worker thread,
// with no host access beyond JSON in and out, and per-run CPU, memory and stack limits. Every escape
// attempt and every limit is shown here; the worker is restarted after a limit hit or a crash, and
// the host's event loop keeps turning meanwhile.

import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterAll, describe, expect, it } from "vitest";
import { EVENT_LIMITS, REGISTRATION_LIMITS, Sandbox, sandboxErrorText } from "../src/life/sandbox/index.js";
import { codeRunOf } from "../src/life/wakeups/run.js";

const sandbox = new Sandbox({ timeZone: "Europe/Berlin", now: () => new Date("2026-10-28T12:00:00.000Z") });
afterAll(() => sandbox.close({ forGood: true }));

/** Evaluates an expression and returns its JSON (or the error). */
async function value(code: string, limits = REGISTRATION_LIMITS) {
  const result = await sandbox.run([{ code: `JSON.stringify((function(){ ${code} })())`, file: "script" }], { limits });
  return result.ok ? JSON.parse(result.value) : result.error;
}

describe("sandbox: no host access", () => {
  it("has only standard built-ins: no require, process, modules, fetch, timers or console", async () => {
    const seen = await value(
      "return ['require','process','module','exports','fetch','XMLHttpRequest','WebSocket','setTimeout','setInterval','setImmediate','queueMicrotask','console','std','os','Buffer','globalThis.process','__filename','Deno','Bun','performance','navigator','importScripts','postMessage'].map(function (n) { try { return n + ':' + typeof eval(n) } catch (e) { return n + ':' + e.name } })"
    );
    for (const entry of seen as string[]) expect(entry).toMatch(/:(undefined|ReferenceError)$/u);
  });

  it("the global object holds only JavaScript's built-ins", async () => {
    const names = (await value("return Object.getOwnPropertyNames(globalThis)")) as string[];
    for (const name of names) expect(name).toMatch(/^(Error|EvalError|RangeError|ReferenceError|SyntaxError|TypeError|URIError|InternalError|AggregateError|Array|Object|Function|Iterator|parseInt|parseFloat|isNaN|isFinite|decodeURI|decodeURIComponent|encodeURI|encodeURIComponent|escape|unescape|Infinity|NaN|undefined|eval|Number|Boolean|String|Math|Reflect|Symbol|globalThis|BigInt|Date|RegExp|JSON|Proxy|Map|Set|WeakMap|WeakSet|ArrayBuffer|SharedArrayBuffer|Uint8ClampedArray|Int8Array|Uint8Array|Int16Array|Uint16Array|Int32Array|Uint32Array|BigInt64Array|BigUint64Array|Float16Array|Float32Array|Float64Array|DataView|Promise|WeakRef|FinalizationRegistry)$/u);
  });

  it("can't load a module, not even QuickJS's own std/os", async () => {
    const result = await sandbox.run([{ code: "import('os').then(function(){ globalThis.x = 1 }, function(e){ globalThis.x = String(e) }); 'ok'", file: "script" }]);
    expect(result.ok).toBe(true);
    const imported = await value("return typeof x");
    expect(imported).toBe("undefined");
    const statement = await sandbox.run([{ code: "import * as os from 'os'; 'x'", file: "script" }]);
    expect(statement.ok).toBe(false);
  });

  it("the Function constructor and eval reach only the sandbox's own global", async () => {
    expect(await value("return typeof Function('return this')().process")).toBe("undefined");
    expect(await value("return typeof (0, eval)('this').require")).toBe("undefined");
    expect(await value("return Object.getPrototypeOf(function(){}).constructor('return typeof process')()")).toBe("undefined");
  });

  it("each run is a fresh context: nothing carries over", async () => {
    await sandbox.run([{ code: "globalThis.secret = 42; Object.prototype.polluted = 1; 'x'", file: "script" }]);
    expect(await value("return [typeof secret, typeof ({}).polluted]")).toEqual(["undefined", "undefined"]);
  });

  it("only JSON comes back; a call's arguments come back as JSON after it", async () => {
    const [result] = await sandbox.call([{ source: "(msg, state) => { state.n = (state.n || 0) + 1; state.f = function(){}; return msg.text }", file: "filter", args: [JSON.stringify({ text: "hi" }), JSON.stringify({ n: 1 })] }]);
    expect(result).toEqual({ ok: true, result: "hi", args: [JSON.stringify({ text: "hi" }), JSON.stringify({ n: 2 })] });
  });

  it("anything but true or a string returns null", async () => {
    const results = await sandbox.call(
      ["() => 1", "() => ({a: 1})", "() => false", "() => true", "() => undefined", "() => [true]"].map((source) => ({ source, file: "filter", args: [] }))
    );
    expect(results.map((result) => (result.ok ? result.result : "error"))).toEqual([null, null, null, true, null, null]);
  });

  it("Date reads the app's clock in her time zone", async () => {
    expect(await value("return [Date.now(), new Date().getHours(), new Date().getTimezoneOffset(), new Date(2026, 9, 28, 13, 0).toISOString()]")).toEqual([
      Date.parse("2026-10-28T12:00:00.000Z"),
      13,
      -60,
      "2026-10-28T12:00:00.000Z"
    ]);
  });
});

describe("sandbox: limits", () => {
  it("an endless loop is stopped at 50 ms of CPU and the worker is restarted", async () => {
    const before = sandbox.starts;
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    const started = Date.now();
    const [result] = await sandbox.call([{ source: "() => { while (true) {} }", file: "filter", args: [] }], { limits: EVENT_LIMITS });
    histogram.disable();
    expect(result).toMatchObject({ ok: false, error: { kind: "time" } });
    expect(sandboxErrorText((result as { error: never }).error, { what: "your filter" })).toBe("your filter took too long");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(histogram.percentile(99) / 1e6).toBeLessThan(50);
    expect(await value("return 1 + 1")).toBe(2);
    expect(sandbox.starts).toBeGreaterThan(before);
  });

  it("the registration run gets 500 ms", async () => {
    const started = performance.now();
    const result = await sandbox.run([{ code: "while (true) {}", file: "script" }], { limits: REGISTRATION_LIMITS });
    expect(result).toMatchObject({ ok: false, error: { kind: "time" } });
    expect(performance.now() - started).toBeGreaterThanOrEqual(450);
  });

  it("memory over 16 MiB is refused", async () => {
    const [grow] = await sandbox.call([{ source: "() => { const a = []; while (true) a.push('x'.repeat(4096) + a.length) }", file: "filter", args: [] }], { limits: EVENT_LIMITS });
    expect(grow).toMatchObject({ ok: false, error: { kind: expect.stringMatching(/memory|time/u) } });
    const [big] = await sandbox.call([{ source: "() => 'x'.repeat(32 * 1024 * 1024).length > 0", file: "filter", args: [] }], { limits: EVENT_LIMITS });
    expect(big).toMatchObject({ ok: false, error: { kind: "memory" } });
    expect(sandboxErrorText((big as { error: never }).error, { what: "your filter" })).toBe("your filter used too much memory");
    expect(await value("return 'still here'")).toBe("still here");
  });

  it("deep recursion stops at the 64 KiB stack", async () => {
    const [result] = await sandbox.call([{ source: "function f(n) { return f(n + 1) + 1 }", file: "filter", args: ["0"] }], { limits: EVENT_LIMITS });
    expect(result).toMatchObject({ ok: false, error: { kind: "stack" } });
  });

  it("her own errors come back with their line", async () => {
    const [result] = await sandbox.call([{ source: "(msg) => {\n  return msg.nothing.here\n}", file: "filter", args: ["{}"] }]);
    expect(result).toMatchObject({ ok: false, error: { kind: "error", name: "TypeError", line: 2 } });
    expect(sandboxErrorText((result as { error: never }).error)).toMatch(/^TypeError: .+ \(line 2\)$/u);
  });

  it("compile reports a syntax error with its line, and a non-function", async () => {
    const results = await sandbox.compile(["(m) => {\n  return m.text ===\n}", "42", "(m) => true"]);
    expect(results[0]).toMatchObject({ ok: false, error: { name: "SyntaxError" } });
    expect(results[1]).toMatchObject({ ok: false, error: { message: "it isn't a function" } });
    expect(results[2]).toEqual({ ok: true });
  });

  it("a state that can't be JSON (a cycle) comes back as a problem, never as text the host must parse", async () => {
    const [result] = await sandbox.call([{ source: "(m, s) => { s.self = s; return true }", file: "filter", args: ["{}", "{}"] }]);
    expect(result).toEqual({ ok: true, result: true, args: ["{}", { problem: "not-json" }] });
    expect(codeRunOf(result, "filter", {})).toEqual({ ok: false, error: "your filter's state must be plain JSON" });
  });
});

describe("sandbox: what comes back is read with built-ins she can't change (review 1)", () => {
  const hostile = [
    "(m, s) => { s.toJSON = function () { return undefined }; return true }",
    "(m, s) => { JSON.stringify = function () { return 42 }; s.a = 1; return true }",
    "(m, s) => { JSON.stringify = function () { return '[true, 7]' }; return 'x' }",
    "(m, s) => { Array.prototype.map = function () { return 5 }; s.a = 1; return true }",
    "(m, s) => { Object.prototype.toJSON = function () { return 'not an object' }; return true }",
    "(m, s) => { String.prototype.slice = function () { return { evil: 1 } }; return 'line' }",
    "(m, s) => { Object.defineProperty(s, 'x', { enumerable: true, get: function () { throw new Error('no') } }); return true }"
  ];

  it("her overrides of JSON, prototypes or toJSON never reach the host as anything but true, text, null, JSON text or a problem", async () => {
    const results = await sandbox.call(hostile.map((source) => ({ source, file: "filter", args: ["{}", "{}"] })));
    for (const result of results) {
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.result === true || result.result === null || typeof result.result === "string").toBe(true);
      for (const arg of result.args) expect(typeof arg === "string" || (typeof arg === "object" && (arg.problem === "not-json" || arg.problem === "too-large"))).toBe(true);
    }
    // Each one is a counted error of hers or a plain answer: never a throw on the host.
    const runs = results.map((result) => codeRunOf(result, "filter", {}));
    expect(runs[0]).toEqual({ ok: false, error: "your filter's state must be plain JSON" });
    expect(runs[1]).toMatchObject({ ok: true, state: { a: 1 } });
    expect(runs[2]).toMatchObject({ ok: true, fires: true, matched: "x" });
    expect(runs[3]).toMatchObject({ ok: true, state: { a: 1 } });
    expect(runs[4]).toEqual({ ok: false, error: "your filter's state must stay an object" });
    expect(runs[5]).toMatchObject({ ok: true, matched: "line" });
    expect(runs[6]).toEqual({ ok: false, error: "your filter's state must be plain JSON" });
  });

  it("codeRunOf counts anything malformed as her error instead of throwing", () => {
    const bad = [
      { ok: true, result: 5, args: ["{}", "{}"] },
      { ok: true, result: true, args: "nope" },
      { ok: true, result: true, args: ["{}", null] },
      { ok: true, result: true, args: ["{}", "{not json"] },
      { ok: true, result: true, args: ["{}", "[1]"] },
      { ok: false, error: null }
    ];
    for (const result of bad) expect(codeRunOf(result as never, "filter", {}).ok).toBe(false);
  });

  it("a crashed worker is replaced", async () => {
    await sandbox.close();
    expect(await value("return 'back'")).toBe("back");
  });
});

describe("sandbox: native calls QuickJS can't interrupt (review 2)", () => {
  it("a long string search is a time limit hit even when it finishes, stopped per run; the next run is unharmed", async () => {
    const before = sandbox.starts;
    const started = performance.now();
    const results = await sandbox.call(
      [
        "() => 'a'.repeat(2e5).includes('a'.repeat(1e5) + 'b')",
        "() => 'a'.repeat(2e5).indexOf('a'.repeat(1e5) + 'b') >= 0",
        "() => 'a'.repeat(2e5).lastIndexOf('a'.repeat(1e5) + 'b') >= 0",
        "(m) => m.text === 'hi'"
      ].map((source) => ({ source, file: "filter", args: [JSON.stringify({ text: "hi" })] })),
      { limits: EVENT_LIMITS }
    );
    const elapsed = performance.now() - started;
    expect(results.slice(0, 3)).toEqual([0, 1, 2].map(() => expect.objectContaining({ ok: false, error: expect.objectContaining({ kind: "time" }) })));
    expect(results[3]).toEqual({ ok: true, result: true, args: [JSON.stringify({ text: "hi" })] });
    // Each stopped within its budget and the watchdog's grace (plus a fresh worker), never seconds each.
    expect(elapsed).toBeLessThan(4_000);
    expect(sandbox.starts).toBeGreaterThan(before);
  }, 30_000);

  it("a run that finished but took longer than its budget counts as too long", async () => {
    const [result] = await sandbox.call([{ source: "() => { const t = Date.now(); while (Date.now() - t < 5) {} ; return 'a'.repeat(1e5).includes('a'.repeat(4e4) + 'b') }", file: "filter", args: [] }], { limits: { ...EVENT_LIMITS, timeMs: 1 } });
    expect(result).toMatchObject({ ok: false, error: { kind: "time" } });
  });
});

describe("sandbox: only short text leaves it (review 3)", () => {
  it("errors, string answers and state are cut inside the worker", async () => {
    const [thrown, answer, wide, state] = await sandbox.call(
      [
        "() => { throw new Error('x'.repeat(3e6)) }",
        "() => 'y'.repeat(3e6)",
        "() => '一 '.repeat(2.5e6)",
        "(m, s) => { s.big = 'z'.repeat(1e6); return true }"
      ].map((source) => ({ source, file: "filter", args: ["{}", "{}"] })),
      // The size caps are the point here; a slow runner may need more than 50 ms to build 3 MB.
      { limits: { ...EVENT_LIMITS, timeMs: 2_000 } }
    );
    expect(thrown).toMatchObject({ ok: false, error: { kind: "error" } });
    expect((thrown as { error: { message: string } }).error.message.length).toBeLessThanOrEqual(300);
    expect(answer!.ok && typeof answer.result === "string" && answer.result.length).toBe(402);
    expect(wide!.ok && typeof wide.result === "string" && wide.result.length).toBeLessThanOrEqual(402);
    expect(codeRunOf(wide, "filter", {})).toMatchObject({ ok: true, fires: true, matched: expect.stringMatching(/^(一 ){99}一…$/u) });
    expect(state).toMatchObject({ ok: true, args: ["{}", { problem: "too-large" }] });
    expect(codeRunOf(state, "filter", {})).toEqual({ ok: false, error: "your filter's state is over 4 KiB; keep less in it" });
    const run = await sandbox.run([{ code: "throw new Error('w'.repeat(3e6))", file: "script" }]);
    expect(run.ok === false && run.error.message.length).toBeLessThanOrEqual(300);
    const big = await sandbox.run([{ code: "'v'.repeat(1e6)", file: "script" }]);
    expect(big).toMatchObject({ ok: false, error: { message: "what the run gave back is too large" } });
  }, 30_000);
});
