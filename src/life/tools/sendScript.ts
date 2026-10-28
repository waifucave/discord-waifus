// The SendMessage script (Living cast spec §27.1): one command per line.
//
//   m: <text>          one message; a following indented line continues it (a newline inside it)
//   attach <path>      right after an m: (and its continuation lines): a file of that message; on its
//                      own (at the start, or after wait/typing/react/reply): consecutive attach lines
//                      are one message with only the files
//   reply #k3          the next send (an m: or a file-only attach group) replies to #k3
//   react #k3 <emoji>  a reaction, with React's rules
//   wait <1-60>        a pause; anyone else writing there meanwhile stops the rest
//   typing <1-10>      typing there for that long, without sending
//
// Blank lines are ignored; anything else is a parse error with its line number. This module only
// parses and checks the shape (numbers, counts, binding); the tool checks places, refs, files and
// emoji before anything is sent.

export const MAX_WAIT_SECONDS = 60;
export const MAX_TYPING_SECONDS = 10;
/** A script's waits together (§27.1). */
export const MAX_WAIT_TOTAL_SECONDS = 120;
/** One message's text (Discord's limit). */
export const MAX_MESSAGE_CHARS = 2000;

export type ScriptSend = {
  kind: "send";
  /** The line it starts on (its `m:` line, or its first `attach` line for a file-only send). */
  line: number;
  /** Empty for a file-only send. */
  text: string;
  files: Array<{ path: string; line: number }>;
  replyTo?: { ref: string; line: number };
};
export type ScriptReact = { kind: "react"; line: number; ref: string; emoji: string };
export type ScriptWait = { kind: "wait"; line: number; seconds: number };
export type ScriptTyping = { kind: "typing"; line: number; seconds: number };
export type ScriptStep = ScriptSend | ScriptReact | ScriptWait | ScriptTyping;

export type ParsedScript = { ok: true; steps: ScriptStep[] } | { ok: false; line: number; error: string };

const COMMAND_RE = /^(m:|attach|reply|react|wait|typing)(?=\s|$|(?<=:))/iu;

/** The common leading whitespace of the non-blank lines (a script indented as a whole reads as written). */
function commonIndent(lines: readonly string[]): number {
  let min = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    min = Math.min(min, line.length - line.trimStart().length);
  }
  return Number.isFinite(min) ? min : 0;
}

function seconds(raw: string, max: number): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*s?$/iu.exec(raw.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 1 && value <= max ? value : undefined;
}

function refOf(raw: string): string | undefined {
  const ref = raw.trim().replace(/^#/u, "");
  return /^[0-9a-z]{1,12}$/iu.test(ref) ? ref.toLowerCase() : undefined;
}

/**
 * Parses a script into steps. `maxFiles` is `life.send.maxFiles` (0: attach is refused). Shape
 * errors only; the first one wins.
 */
export function parseSendScript(script: string, o: { maxFiles: number }): ParsedScript {
  const raw = script.replace(/\r\n?/gu, "\n").split("\n");
  const indent = commonIndent(raw);
  const steps: ScriptStep[] = [];
  /** The open send that indented lines continue and attach lines join (the last step, an `m:`). */
  let open: ScriptSend | undefined;
  /** Whether the open send was started by `m:` (continuation lines are only for its text). */
  let openIsText = false;
  let pendingReply: { ref: string; line: number } | undefined;
  const fail = (line: number, error: string): ParsedScript => ({ ok: false, line, error });
  for (let index = 0; index < raw.length; index += 1) {
    const number = index + 1;
    const full = raw[index]!.slice(indent).replace(/\s+$/u, "");
    if (!full.trim()) continue;
    const indented = /^\s/u.test(full);
    const body = full.trim();
    // An indented line continues the open m: message (a poem, a list).
    if (indented && open && openIsText) {
      open.text = `${open.text}\n${body}`;
      continue;
    }
    const command = COMMAND_RE.exec(body)?.[1]?.toLowerCase();
    if (!command) {
      return fail(number, indented ? "an indented line continues an m: message, and there is none above it" : `not a command: "${body.length > 40 ? `${body.slice(0, 40)}…` : body}" (each line starts with m:, reply, attach, react, wait or typing)`);
    }
    const rest = body.slice(command.length).trim();
    switch (command) {
      case "m:": {
        if (!rest) return fail(number, "m: needs the text of the message");
        const send: ScriptSend = { kind: "send", line: number, text: rest, files: [], ...(pendingReply ? { replyTo: pendingReply } : {}) };
        pendingReply = undefined;
        steps.push(send);
        open = send;
        openIsText = true;
        break;
      }
      case "attach": {
        if (!rest) return fail(number, "attach needs a file path");
        if (o.maxFiles <= 0) return fail(number, "files can't be attached");
        // Right after an m: (or more attach lines of it): that message's file. Otherwise a message
        // with only files, which the following attach lines join.
        if (!open) {
          open = { kind: "send", line: number, text: "", files: [], ...(pendingReply ? { replyTo: pendingReply } : {}) };
          pendingReply = undefined;
          openIsText = false;
          steps.push(open);
        }
        if (open.files.length >= o.maxFiles) return fail(number, `at most ${o.maxFiles} file${o.maxFiles === 1 ? "" : "s"} per message`);
        open.files.push({ path: rest, line: number });
        break;
      }
      case "reply": {
        const ref = refOf(rest);
        if (!ref) return fail(number, "reply needs a ref, like reply #k3");
        if (pendingReply) return fail(number, `line ${pendingReply.line} already says which message the next one replies to`);
        pendingReply = { ref, line: number };
        open = undefined;
        break;
      }
      case "react": {
        const [first, ...emoji] = rest.split(/\s+/u);
        const ref = first ? refOf(first) : undefined;
        if (!ref || emoji.length === 0) return fail(number, "react needs a ref and an emoji, like react #k3 👍");
        steps.push({ kind: "react", line: number, ref, emoji: emoji.join(" ") });
        open = undefined;
        break;
      }
      case "wait": {
        const value = seconds(rest, MAX_WAIT_SECONDS);
        if (value === undefined) return fail(number, `wait takes seconds from 1 to ${MAX_WAIT_SECONDS}, like wait 5`);
        steps.push({ kind: "wait", line: number, seconds: value });
        open = undefined;
        break;
      }
      case "typing": {
        const value = seconds(rest, MAX_TYPING_SECONDS);
        if (value === undefined) return fail(number, `typing takes seconds from 1 to ${MAX_TYPING_SECONDS}, like typing 3`);
        steps.push({ kind: "typing", line: number, seconds: value });
        open = undefined;
        break;
      }
    }
  }
  if (pendingReply) return fail(pendingReply.line, "reply needs a message after it (an m: or attach line)");
  if (!steps.some((step) => step.kind === "send" || step.kind === "react")) return fail(1, "there is nothing to send: write each message on an m: line");
  const waited = steps.reduce((sum, step) => sum + (step.kind === "wait" ? step.seconds : 0), 0);
  if (waited > MAX_WAIT_TOTAL_SECONDS) {
    const last = [...steps].reverse().find((step) => step.kind === "wait")!;
    return fail(last.line, `the waits add up to ${waited} seconds; at most ${MAX_WAIT_TOTAL_SECONDS} in one script`);
  }
  for (const step of steps) {
    if (step.kind === "send" && step.text.length > MAX_MESSAGE_CHARS) return fail(step.line, `that message is ${step.text.length} characters; at most ${MAX_MESSAGE_CHARS}`);
  }
  return { ok: true, steps };
}

/** The sends of a script (in order). */
export function scriptSends(steps: readonly ScriptStep[]): ScriptSend[] {
  return steps.filter((step): step is ScriptSend => step.kind === "send");
}

/**
 * The steps a pre-§27 call means (`text`, `reply_to`, `files`): one message with its files (a
 * file-only one when the text is empty). Old log lines, and a habit from a kept turn, still run.
 */
export function legacySteps(input: { text?: string | undefined; reply_to?: string | undefined; files?: readonly string[] | undefined }): ParsedScript {
  const text = (input.text ?? "").trim();
  const files = (input.files ?? []).map((path) => ({ path, line: 1 }));
  if (!text && files.length === 0) return { ok: false, line: 1, error: "there is nothing to send: write each message on an m: line" };
  if (text.length > MAX_MESSAGE_CHARS) return { ok: false, line: 1, error: `that message is ${text.length} characters; at most ${MAX_MESSAGE_CHARS}` };
  const ref = input.reply_to ? refOf(input.reply_to) : undefined;
  if (input.reply_to && !ref) return { ok: false, line: 1, error: "reply needs a ref, like reply #k3" };
  return { ok: true, steps: [{ kind: "send", line: 1, text, files, ...(ref ? { replyTo: { ref, line: 1 } } : {}) }] };
}

/** How a send reads in a result (`not sent: …`): its text on one line, or its files. */
export function sendLabel(send: ScriptSend): string {
  const text = send.text.replace(/\s*\n\s*/gu, " / ");
  if (send.files.length === 0) return text;
  const files = `[${send.files.map((file) => file.path).join(", ")}]`;
  return text ? `${text} ${files}` : files;
}
