// Her special JSON files' shared pieces (Living cast spec §16.14, T9, §30.3): the strict JSON reader
// every check uses, so a broken file is refused with its line and column on every Node version:
//
//   error: wakeups.json line 7, column 3: expected "," or "]"
//
// The files' own checks live beside their files (wakeups: ../wakeups/file.ts; her profile:
// profileFile.ts). The reminder and watch files before §30 are read
// only by the migrations (src/backend/migrationSteps/legacySchemas.ts).

import { localParts } from "../clock.js";

// ---- a strict JSON reader with line and column ---------------------------------------------------

export type JsonPosition = { line: number; column: number };
export class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: JsonPosition
  ) {
    super(message);
  }
}

/** Parses strict JSON (RFC 8259); errors carry the line and column of the problem. */
export function parseStrictJson(text: string): unknown {
  let index = 0;
  const position = (at: number): JsonPosition => {
    let line = 1;
    let column = 1;
    for (let i = 0; i < at && i < text.length; i += 1) {
      if (text[i] === "\n") {
        line += 1;
        column = 1;
      } else column += 1;
    }
    return { line, column };
  };
  const fail = (message: string, at = index): never => {
    throw new JsonSyntaxError(message, position(at));
  };
  const skip = () => {
    while (index < text.length && (text[index] === " " || text[index] === "\t" || text[index] === "\n" || text[index] === "\r")) index += 1;
  };
  const describe = (at: number) => (at >= text.length ? "the end of the file" : JSON.stringify(text[at]));
  const value = (depth: number): unknown => {
    if (depth > 64) fail("nested too deeply");
    skip();
    if (index >= text.length) fail("unexpected end of the file: expected a value");
    const char = text[index]!;
    if (char === "{") return object(depth);
    if (char === "[") return array(depth);
    if (char === '"') return string();
    if (char === "-" || (char >= "0" && char <= "9")) return number();
    for (const [word, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, index)) {
        index += word.length;
        return result;
      }
    }
    if (char === "'") fail("strings use double quotes (\")");
    return fail(`expected a value, found ${describe(index)}`);
  };
  const string = (): string => {
    const start = index;
    index += 1;
    let out = "";
    for (;;) {
      if (index >= text.length) fail("unterminated string", start);
      const char = text[index]!;
      if (char === '"') {
        index += 1;
        return out;
      }
      if (char === "\n" || char === "\r") fail("line break inside a string (write \\n instead)");
      if (char.charCodeAt(0) < 0x20) fail("control character inside a string");
      if (char === "\\") {
        const next = text[index + 1];
        const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (next !== undefined && simple[next] !== undefined) {
          out += simple[next];
          index += 2;
          continue;
        }
        if (next === "u") {
          const hex = text.slice(index + 2, index + 6);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) fail("invalid \\u escape");
          out += String.fromCharCode(Number.parseInt(hex, 16));
          index += 6;
          continue;
        }
        fail("invalid escape in a string");
      }
      out += char;
      index += 1;
    }
  };
  const number = (): number => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(index));
    if (!match) return fail("invalid number");
    index += match[0].length;
    return Number(match[0]);
  };
  const array = (depth: number): unknown[] => {
    index += 1;
    const out: unknown[] = [];
    skip();
    if (text[index] === "]") {
      index += 1;
      return out;
    }
    for (;;) {
      out.push(value(depth + 1));
      skip();
      if (text[index] === ",") {
        index += 1;
        skip();
        if (text[index] === "]") fail('expected a value after ",", found "]" (a comma left behind?)');
        continue;
      }
      if (text[index] === "]") {
        index += 1;
        return out;
      }
      fail(index >= text.length ? 'unexpected end of the file: expected "," or "]"' : 'expected "," or "]"');
    }
  };
  const object = (depth: number): Record<string, unknown> => {
    index += 1;
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    skip();
    if (text[index] === "}") {
      index += 1;
      return out;
    }
    for (;;) {
      skip();
      if (text[index] !== '"') fail(index >= text.length ? "unexpected end of the file: expected a field name" : 'expected a field name in double quotes');
      const keyAt = index;
      const key = string();
      if (Object.prototype.hasOwnProperty.call(out, key)) fail(`the field "${key}" appears twice`, keyAt);
      skip();
      if (text[index] !== ":") fail('expected ":"');
      index += 1;
      out[key] = value(depth + 1);
      skip();
      if (text[index] === ",") {
        index += 1;
        skip();
        if (text[index] === "}") fail('expected a field after ",", found "}" (a comma left behind?)');
        continue;
      }
      if (text[index] === "}") {
        index += 1;
        return out;
      }
      fail(index >= text.length ? 'unexpected end of the file: expected "," or "}"' : 'expected "," or "}"');
    }
  };
  // A byte-order mark is fine; anything after the value is not.
  if (text.charCodeAt(0) === 0xfeff) index = 1;
  const result = value(0);
  skip();
  if (index < text.length) fail(`unexpected ${describe(index)} after the end of the value`);
  return result;
}

// ---- shared ----------------------------------------------------------------------------------------

export type CheckFailure = { ok: false; error: string };

export function syntaxProblem(file: string, text: string): CheckFailure | { ok: true; value: unknown } {
  try {
    return { ok: true, value: parseStrictJson(text) };
  } catch (error) {
    if (error instanceof JsonSyntaxError) return { ok: false, error: `error: ${file} line ${error.position.line}, column ${error.position.column}: ${error.message}` };
    throw error;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A local minute as her files write it: `2026-10-25 18:00`. */
export function localMinuteText(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** A watch filter's person (a name or `<@id>`) resolved: one person, or why not. */
export type PersonResolution = { ok: true; userId: string; name: string } | { ok: false; error: string };
