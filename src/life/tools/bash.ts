// `Bash` (Living cast spec §16.3.5, T10): a simulated bash over a copy of her two folders, in its
// own worker thread (src/life/bash/). The result is the output (stdout, then stderr), cut at
// `life.bash.maxOutputChars`, then `exit <code>` and one line naming what changed. The change set is
// applied all or nothing by the home store; when it is not empty an intent is written first and the
// set is journalled, so a crash mid-apply is finished at boot (§16.9).

import { createHash } from "node:crypto";
import { z } from "zod";
import { runBash } from "../bash/runner.js";
import { checkEnvFor } from "../home/index.js";
import { HomeError } from "../home/homeStore.js";
import { parseVirtual } from "../home/pathRules.js";
import { appendIntent } from "../lifeStore.js";
import { notePlace } from "../placeRecorder.js";
import { noteDmFile, storeOf } from "./files.js";
import { parseInput, toolError, type LifeTool, type ToolContext, type ToolOutput } from "./types.js";

export const BASH_DEFAULT_TIMEOUT_MS = 10_000;
/** Room the in-memory copy has beyond her two folders' limits (scratch work that is deleted again). */
const WORK_ROOM_BYTES = 64 * 1024 * 1024;

const BashInput = z.object({
  command: z.string().min(1).max(20_000),
  timeout_ms: z.number().int().min(1_000).optional()
});

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (output cut)` : text;
}

async function bashTool(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(BashInput, input);
  if (!parsed.ok) return parsed.output;
  const { deps } = ctx;
  const life = deps.config().life;
  const timeoutMs = Math.min(parsed.value.timeout_ms ?? BASH_DEFAULT_TIMEOUT_MS, life.bash.maxTimeoutMs);
  const store = storeOf(ctx);
  // A command that names a private chat's downloads is about that chat (D14).
  if (/\/tmp\/dm(?:\/|\b)/u.test(parsed.value.command)) notePlace("dm_file");
  const run = await runBash({
    store,
    command: parsed.value.command,
    timeoutMs,
    python: life.bash.python,
    timeZone: deps.timeZone,
    signal: ctx.signal,
    maxFileSystemBytes: life.home.maxBytes + life.tmp.maxBytes + WORK_ROOM_BYTES
  });
  for (const virtual of run.read) {
    const p = parseVirtual(virtual, store.slug);
    if (p) await noteDmFile(store, p);
  }
  if (run.outcome === "aborted") return toolError("interrupted; nothing was saved");
  if (run.outcome === "timeout") return toolError(`the command took longer than ${Math.round(timeoutMs / 1000)} s and was stopped; nothing was saved`);
  if (run.outcome === "failed") return toolError(`${run.error ?? "the command failed"}; nothing was saved`);
  const output = [run.stdout, run.stderr].filter((part) => part.length > 0).join(run.stdout.endsWith("\n") || !run.stdout ? "" : "\n");
  const lines = [cut(output.replace(/\n$/u, ""), life.bash.maxOutputChars) || "(no output)", `exit ${run.exitCode}`];
  const changes = run.changes ?? { writes: [], deletes: [], dirs: [] };
  if (changes.writes.length + changes.deletes.length + changes.dirs.length === 0) return { content: lines.join("\n") };
  // A non-empty change set is a side effect (§16.9): intent first, done after.
  const argsDigest = createHash("sha256").update(JSON.stringify(input ?? {})).digest("hex").slice(0, 32);
  const intent = { turnId: ctx.turn.id, toolCallId: ctx.toolCallId, tool: "Bash", argsDigest };
  await appendIntent(deps.storage, ctx.waifu.id, { ...intent, at: deps.now().toISOString() });
  try {
    const applied = await store.applyChanges(changes, run.base, checkEnvFor(deps, ctx.waifu.id), { journalId: ctx.toolCallId });
    for (const virtual of changes.writes.map((write) => write.path)) {
      const p = parseVirtual(virtual, store.slug);
      if (p) await noteDmFile(store, p);
    }
    const summary = [
      applied.changed.length > 0 ? `changed: ${applied.changed.join(", ")}` : undefined,
      applied.created.length > 0 ? `new folders: ${applied.created.join(", ")}` : undefined,
      applied.deleted.length > 0 ? `deleted: ${applied.deleted.join(", ")}` : undefined
    ].filter(Boolean);
    if (summary.length > 0) lines.push(summary.join("; "));
    return { content: lines.join("\n") };
  } catch (error) {
    if (!(error instanceof HomeError)) throw error;
    lines.push(`error: changes not saved: ${error.message.replace(/^error:\s*/u, "")}`);
    return { content: lines.join("\n"), isError: true };
  } finally {
    await appendIntent(deps.storage, ctx.waifu.id, { ...intent, at: deps.now().toISOString(), done: true });
  }
}

function bashDescription(python: boolean): string {
  return `Run a bash command in your own folders: your home (~, where you start) and /tmp. Common tools work (ls, cat, grep, find, sed, awk, jq, sort, mv, cp, rm, mkdir, sqlite3${python ? ", python3 with its standard library" : ""}, and image to look at, crop, resize, rotate, flip or convert pictures). There is no internet and nothing outside your two folders. What the command changes is saved when it ends, all at once; if anything can't be saved, nothing is.`;
}

export const bashTool_: LifeTool = {
  name: "Bash",
  description: bashDescription(true),
  describe: (config) => bashDescription(config.life.bash.python),
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command (a whole script is fine)." },
      timeout_ms: { type: "integer", minimum: 1000, description: "How long it may run (default 10000)." }
    },
    required: ["command"],
    additionalProperties: false
  },
  // Its intent is written by the tool itself, only for a non-empty change set (§16.9).
  sideEffect: false,
  run: bashTool
};
