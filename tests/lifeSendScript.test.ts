// The SendMessage script parser (Living cast spec §27.1): every command, continuation lines, attach
// and reply binding, errors with line numbers, the wait cap. Pure; the tool's runs are in
// lifeSendMessage.test.ts.
import { describe, expect, it } from "vitest";
import { legacySteps, parseSendScript, sendLabel, type ScriptStep } from "../src/life/tools/sendScript.js";

const parse = (script: string, maxFiles = 4) => parseSendScript(script, { maxFiles });
const steps = (script: string, maxFiles = 4): ScriptStep[] => {
  const parsed = parse(script, maxFiles);
  if (!parsed.ok) throw new Error(`line ${parsed.line}: ${parsed.error}`);
  return parsed.steps;
};

describe("parseSendScript (§27.1)", () => {
  it("reads every command, ignores blank lines and keeps line numbers", () => {
    expect(steps("m: hi\n\nreply #k3\nm: yes\nreact #k2 👍\nwait 5\ntyping 3\nm: ok")).toEqual([
      { kind: "send", line: 1, text: "hi", files: [] },
      { kind: "send", line: 4, text: "yes", files: [], replyTo: { ref: "k3", line: 3 } },
      { kind: "react", line: 5, ref: "k2", emoji: "👍" },
      { kind: "wait", line: 6, seconds: 5 },
      { kind: "typing", line: 7, seconds: 3 },
      { kind: "send", line: 8, text: "ok", files: [] }
    ]);
  });

  it("continues a message on indented lines (a newline inside it), and reads a script indented as a whole", () => {
    expect(steps("m: roses are red\n  violets are blue\n\n  sugar is sweet\nm: next")).toEqual([
      { kind: "send", line: 1, text: "roses are red\nviolets are blue\nsugar is sweet", files: [] },
      { kind: "send", line: 5, text: "next", files: [] }
    ]);
    expect(steps("    m: one\n    m: two\n      more")).toEqual([
      { kind: "send", line: 1, text: "one", files: [] },
      { kind: "send", line: 2, text: "two\nmore", files: [] }
    ]);
    // Commands are case-insensitive; m: needs no space; wait takes an optional s.
    expect(steps("M:hey\nWAIT 2s\nReply k1\nm: x")).toMatchObject([{ text: "hey" }, { kind: "wait", seconds: 2 }, { replyTo: { ref: "k1" } }]);
  });

  it("binds attach lines right after an m: to it, others to a file-only message; reply binds to the next send (owner, 2026-10-28)", () => {
    expect(steps("attach ~/tmp/crying-cat.png\nwait 5\nreply #k2\nm: Anyone here?\nattach ~/tmp/crying-cat.png")).toEqual([
      { kind: "send", line: 1, text: "", files: [{ path: "~/tmp/crying-cat.png", line: 1 }] },
      { kind: "wait", line: 2, seconds: 5 },
      { kind: "send", line: 4, text: "Anyone here?", files: [{ path: "~/tmp/crying-cat.png", line: 5 }], replyTo: { ref: "k2", line: 3 } }
    ]);
    // Several attach lines after one m: (and its continuation), then a file-only group after a react.
    expect(steps("m: look\n  at these\nattach /tmp/a.png\n\nattach /tmp/b.png\nreact #k1 🎉\nattach /tmp/c.png\nattach /tmp/d.png")).toEqual([
      { kind: "send", line: 1, text: "look\nat these", files: [{ path: "/tmp/a.png", line: 3 }, { path: "/tmp/b.png", line: 5 }] },
      { kind: "react", line: 6, ref: "k1", emoji: "🎉" },
      { kind: "send", line: 7, text: "", files: [{ path: "/tmp/c.png", line: 7 }, { path: "/tmp/d.png", line: 8 }] }
    ]);
    // A reply before a file-only group is that message's.
    expect(steps("reply #k4\nattach /tmp/a.png\nm: and this")).toEqual([
      { kind: "send", line: 2, text: "", files: [{ path: "/tmp/a.png", line: 2 }], replyTo: { ref: "k4", line: 1 } },
      { kind: "send", line: 3, text: "and this", files: [] }
    ]);
  });

  it("refuses with the line number: unknown lines, bad numbers, missing parts, dangling replies, too many files", () => {
    expect(parse("m: hi\nhello there")).toEqual({ ok: false, line: 2, error: 'not a command: "hello there" (each line starts with m:, reply, attach, react, wait or typing)' });
    expect(parse("  hi")).toMatchObject({ ok: false, line: 1 });
    expect(parse("wait 1\n  stray")).toEqual({ ok: false, line: 2, error: "an indented line continues an m: message, and there is none above it" });
    expect(parse("m:")).toEqual({ ok: false, line: 1, error: "m: needs the text of the message" });
    expect(parse("m: a\nwait 0")).toMatchObject({ ok: false, line: 2, error: "wait takes seconds from 1 to 60, like wait 5" });
    expect(parse("m: a\nwait 61")).toMatchObject({ ok: false, line: 2 });
    expect(parse("m: a\ntyping 11")).toMatchObject({ ok: false, line: 2, error: "typing takes seconds from 1 to 10, like typing 3" });
    expect(parse("react #k1")).toMatchObject({ ok: false, line: 1, error: "react needs a ref and an emoji, like react #k3 👍" });
    expect(parse("reply\nm: a")).toMatchObject({ ok: false, line: 1, error: "reply needs a ref, like reply #k3" });
    expect(parse("m: a\nreply #k1")).toEqual({ ok: false, line: 2, error: "reply needs a message after it (an m: or attach line)" });
    expect(parse("reply #k1\nreply #k2\nm: a")).toMatchObject({ ok: false, line: 2 });
    expect(parse("m: a\nattach /tmp/1\nattach /tmp/2\nattach /tmp/3", 2)).toEqual({ ok: false, line: 4, error: "at most 2 files per message" });
    expect(parse("m: a\nattach /tmp/1", 0)).toEqual({ ok: false, line: 2, error: "files can't be attached" });
    expect(parse("m: a\nattach")).toMatchObject({ ok: false, line: 2, error: "attach needs a file path" });
    expect(parse(`m: ${"x".repeat(2001)}`)).toMatchObject({ ok: false, line: 1, error: "that message is 2001 characters; at most 2000" });
    expect(parse("wait 3\n\ntyping 2")).toMatchObject({ ok: false, line: 1, error: "there is nothing to send: write each message on an m: line" });
    expect(parse("")).toMatchObject({ ok: false });
  });

  it("caps a script's waits at 120 seconds in all", () => {
    expect(parse("m: a\nwait 60\nm: b\nwait 60\nm: c").ok).toBe(true);
    expect(parse("m: a\nwait 60\nwait 60\nwait 1\nm: b")).toEqual({ ok: false, line: 4, error: "the waits add up to 121 seconds; at most 120 in one script" });
  });

  it("reads a pre-§27 call as one message, and labels sends for results", () => {
    expect(legacySteps({ text: "hi there", reply_to: "#k3", files: ["/tmp/a.png"] })).toEqual({ ok: true, steps: [{ kind: "send", line: 1, text: "hi there", files: [{ path: "/tmp/a.png", line: 1 }], replyTo: { ref: "k3", line: 1 } }] });
    expect(legacySteps({ text: "" })).toMatchObject({ ok: false });
    expect(sendLabel({ kind: "send", line: 1, text: "one\ntwo", files: [] })).toBe("one / two");
    expect(sendLabel({ kind: "send", line: 1, text: "", files: [{ path: "/tmp/a.png", line: 1 }] })).toBe("[/tmp/a.png]");
  });
});
