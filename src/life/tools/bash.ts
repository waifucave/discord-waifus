// `Bash` (Living cast spec §16.3.5, T10): a simulated bash over a copy of her two folders, in its
// own worker thread (src/life/bash/). The result is the output (stdout, then stderr), cut at
// `life.bash.maxOutputChars`, then `exit <code>` and one line naming what changed (the first 20
// entries of each kind). The change set is applied all or nothing by the home store; when it is not
// empty an intent is written first and the set is journalled, so a crash mid-apply is finished at
// boot (§16.9). A command that read, listed, moved or deleted anything from a private chat, or whose
// output names such a file, is recorded as touching that chat (D14).

import { createHash } from "node:crypto";
import { z } from "zod";
import { MAX_CHANGE_ENTRIES, runBash } from "../bash/runner.js";
import { checkEnvFor } from "../home/index.js";
import { HomeError, sha256, type HomeStore } from "../home/homeStore.js";
import { isDmFolderPath, isLifeDirPath, parseVirtual, pathKey, PROFILE_FILE, specialJsonFile } from "../home/pathRules.js";
import { PROFILE_TIDY_REFUSED, profileSavedNote } from "./profileNote.js";

/** A write or delete that would change `~/life/profile.json` (a delete of `~/life` or her whole home included). */
function touchesProfile(virtual: string, slug: string): boolean {
  const p = parseVirtual(virtual, slug);
  if (!p) return false;
  return specialJsonFile(p) === "profile" || (p.root === "home" && p.segments.length === 0) || (p.segments.length === 1 && isLifeDirPath(p));
}

/** A change anywhere in `~/life/` (or of her whole home). */
function touchesLifeDir(virtual: string, slug: string): boolean {
  const p = parseVirtual(virtual, slug);
  if (!p) return false;
  return isLifeDirPath(p) || (p.root === "home" && p.segments.length === 0);
}
import { appendIntent } from "../lifeStore.js";
import { notePlace } from "../placeRecorder.js";
import { DREAM_LIFE_REFUSED, noteDmFile, promptCopyNote, storeOf, transcriptViewOf, wakeupsOrigin } from "./files.js";
import { parseInput, toolError, type LifeTool, type ToolContext, type ToolOutput } from "./types.js";

export const BASH_DEFAULT_TIMEOUT_MS = 10_000;
/** Room the in-memory copy has beyond her two folders' limits (scratch work that is deleted again). */
const WORK_ROOM_BYTES = 64 * 1024 * 1024;
/** Entries of each kind named in the change line before "… and N more". */
const SUMMARY_ENTRIES = 20;

const BashInput = z.object({
  command: z.string().min(1).max(20_000),
  timeout_ms: z.number().int().min(1_000).optional()
});

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (output cut)` : text;
}

function listed(label: string, items: readonly string[]): string | undefined {
  if (items.length === 0) return undefined;
  const shown = items.slice(0, SUMMARY_ENTRIES).join(", ");
  return `${label}: ${shown}${items.length > SUMMARY_ENTRIES ? `, … and ${items.length - SUMMARY_ENTRIES} more` : ""}`;
}

/**
 * Records the private chats a command touched (D14): any path under `/tmp/dm/` (any spelling), any
 * file whose path or content hash the provenance index has from a DM, and output that names one.
 */
async function noteDmTouches(store: HomeStore, paths: readonly string[], text: string): Promise<void> {
  const index = await store.readIndex();
  const dmEntries = index.entries.filter((entry) => entry.placeKey.startsWith("dm_"));
  const dmPaths = new Map(dmEntries.map((entry) => [pathKey(entry.path), entry.placeKey] as const));
  const sizes = new Set(dmEntries.map((entry) => entry.size));
  const noted = new Set<string>();
  for (const virtual of paths) {
    const p = parseVirtual(virtual, store.slug);
    if (!p || p.segments.length === 0) continue;
    // Her wakeups file with a private wakeup in it (§30.3).
    const wakeups = await wakeupsOrigin(store, p);
    if (wakeups) {
      if (!noted.has(wakeups)) notePlace(wakeups);
      noted.add(wakeups);
      continue;
    }
    const byPath = dmPaths.get(pathKey(p.virtual));
    if (byPath) {
      if (!noted.has(byPath)) notePlace(byPath);
      noted.add(byPath);
      continue;
    }
    if (isDmFolderPath(p)) {
      const origin = await store.dmOrigin(p, index).catch(() => "dm_file");
      if (origin && !noted.has(origin)) notePlace(origin);
      if (origin) noted.add(origin);
      continue;
    }
    if (sizes.size === 0) continue;
    const info = await store.files.inspect(p);
    if (info.kind !== "file" || !sizes.has(info.size)) continue;
    const origin = await store.dmOrigin(p, index).catch(() => undefined);
    if (origin && !noted.has(origin)) {
      notePlace(origin);
      noted.add(origin);
    }
  }
  const lowered = pathKey(text);
  if (lowered.includes("/tmp/dm/") || lowered.includes("/transcripts/dm/") || dmEntries.some((entry) => lowered.includes(pathKey(entry.path)))) notePlace("dm_file");
}


async function bashTool(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(BashInput, input);
  if (!parsed.ok) return parsed.output;
  const { deps } = ctx;
  const life = deps.config().life;
  const timeoutMs = Math.min(parsed.value.timeout_ms ?? BASH_DEFAULT_TIMEOUT_MS, life.bash.maxTimeoutMs);
  const store = storeOf(ctx);
  // A command that names a private chat's downloads is about that chat (D14).
  if (/\/(?:tmp|transcripts)\/dm(?:\/|\b)/iu.test(parsed.value.command)) notePlace("dm_file");
  const transcripts = transcriptViewOf(ctx);
  const run = await runBash({
    store,
    command: parsed.value.command,
    timeoutMs,
    python: life.bash.python,
    timeZone: deps.timeZone,
    signal: ctx.signal,
    maxFileSystemBytes: life.home.maxBytes + life.tmp.maxBytes + WORK_ROOM_BYTES,
    maxMemoryBytes: life.bash.maxMemoryMb * 1024 * 1024,
    maxChanges: MAX_CHANGE_ENTRIES,
    transcripts
  });
  // The private chats whose transcripts it listed or read (D14): each is recorded as touched.
  for (const key of run.transcriptDms ?? []) notePlace(key);
  for (const text of run.transcriptTexts ?? []) {
    ctx.turn.transcriptTexts ??= new Map();
    ctx.turn.transcriptTexts.set(text.sha256, text);
  }
  if (run.outcome === "aborted") return toolError("interrupted; nothing was saved");
  if (run.outcome === "timeout") return toolError(`the command took longer than ${Math.round(timeoutMs / 1000)} s and was stopped; nothing was saved`);
  if (run.outcome === "memory") return toolError("the command used too much memory and was stopped; nothing was saved");
  if (run.outcome === "failed") return toolError(`${run.error ?? "the command failed"}; nothing was saved`);
  const output = [run.stdout, run.stderr].filter((part) => part.length > 0).join(run.stdout.endsWith("\n") || !run.stdout ? "" : "\n");
  const lines = [cut(output.replace(/\n$/u, ""), life.bash.maxOutputChars) || "(no output)", `exit ${run.exitCode}`];
  const changes = run.changes ?? { writes: [], deletes: [], dirs: [] };
  await noteDmTouches(store, [...run.read, ...(run.touched ?? []), ...changes.deletes], output).catch(() => undefined);
  if (run.tooMany !== undefined) {
    lines.push(`error: changes not saved: the command changed ${run.tooMany} files and folders; at most ${MAX_CHANGE_ENTRIES} can be saved at once`);
    return { content: lines.join("\n"), isError: true };
  }
  if (changes.writes.length + changes.deletes.length + changes.dirs.length === 0) return { content: lines.join("\n") };
  // Her profile is not changed while she tidies (spec §17.1).
  if (ctx.mode === "session" && [...changes.writes.map((write) => write.path), ...changes.deletes].some((virtual) => touchesProfile(virtual, store.slug))) {
    lines.push(`error: changes not saved: ${PROFILE_TIDY_REFUSED.replace(/^error:\s*/u, "")}`);
    return { content: lines.join("\n"), isError: true };
  }
  // A dream leaves `~/life/` alone (§21.6): her day, reminders, watches, profile and places.
  if (ctx.session === "dream" && [...changes.writes.map((write) => write.path), ...changes.deletes, ...changes.dirs].some((virtual) => touchesLifeDir(virtual, store.slug))) {
    lines.push(`error: changes not saved: ${DREAM_LIFE_REFUSED.replace(/^error:\s*/u, "")}`);
    return { content: lines.join("\n"), isError: true };
  }
  // A non-empty change set is a side effect (§16.9): intent first, done after.
  const argsDigest = createHash("sha256").update(JSON.stringify(input ?? {})).digest("hex").slice(0, 32);
  const intent = { turnId: ctx.turn.id, toolCallId: ctx.toolCallId, tool: "Bash", argsDigest };
  await appendIntent(deps.storage, ctx.waifu.id, { ...intent, at: deps.now().toISOString() });
  try {
    const applied = await store.applyChanges(changes, run.base, checkEnvFor(deps, ctx.waifu.id), { journalId: ctx.toolCallId });
    // A file that is a private chat's transcript day keeps its DM origin (§18.3, D14).
    if (run.transcriptTexts) {
      const served = new Map(run.transcriptTexts.map((text) => [text.sha256, text] as const));
      const copies = changes.writes.flatMap((write) => {
        const text = served.get(sha256(write.data));
        const p = parseVirtual(write.path, store.slug);
        return text && p ? [{ path: p, sha256: text.sha256, size: text.size, placeKey: text.placeKey }] : [];
      });
      await store.recordTranscriptCopies(copies, deps.now());
    }
    for (const virtual of changes.writes.map((write) => write.path)) {
      const p = parseVirtual(virtual, store.slug);
      if (p) await noteDmFile(store, p);
    }
    const summary = [listed("changed", applied.changed), listed("new folders", applied.created), listed("deleted", applied.deleted)].filter(Boolean);
    if (summary.length > 0) lines.push(summary.join("; "));
    // Her special files changed under her own hand: what she read of them is current again.
    for (const write of changes.writes) ctx.turn.readHashes?.delete(pathKey(write.path));
    if (applied.profileChanged !== undefined) lines.push(`${PROFILE_FILE}: ${await profileSavedNote(deps, ctx.waifu.id, applied.profileChanged)}`);
    // MEMORY.md changed: its copy in her system prompt is now old (§21.2).
    const touched = new Set([...applied.changed, ...applied.deleted]);
    for (const virtual of [...changes.writes.map((write) => write.path), ...changes.deletes]) {
      const p = parseVirtual(virtual, store.slug);
      if (!p) continue;
      const canonical = await store.files.canonical(p);
      if (!touched.has(canonical.display)) continue;
      const note = promptCopyNote(ctx, canonical);
      if (note) lines.push(note);
    }
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
  return `Run a bash command in your own folders: your home (~, where you start) and /tmp; /transcripts can be read and searched but not changed. Common tools work (ls, cat, grep, find, sed, awk, jq, sort, mv, cp, rm, mkdir${python ? ", python3 with its standard library" : ""}, and image to get a picture's size or crop, resize, rotate, flip or convert it; look at pictures with Read; Read gives a picture's size in pixels, and crop boxes are in those pixels, so look at an edited picture before you send it). There is no internet and nothing else outside your two folders. What the command changes is saved when it ends, all at once; if anything can't be saved, nothing is.`;
}

/** Bash's input schema; the timeout's limit as configured (`life.bash.maxTimeoutMs`). */
function bashSchema(maxTimeoutMs: number): Record<string, unknown> {
  const max = Math.max(1_000, maxTimeoutMs);
  return {
    type: "object",
    properties: {
      command: { type: "string", description: "The command (a whole script is fine)." },
      timeout_ms: { type: "integer", minimum: 1000, maximum: max, description: `How long it may run (default ${Math.min(BASH_DEFAULT_TIMEOUT_MS, max)}, at most ${max}).` }
    },
    required: ["command"],
    additionalProperties: false
  };
}

export const bashTool_: LifeTool = {
  name: "Bash",
  description: bashDescription(true),
  describe: (config) => bashDescription(config.life.bash.python),
  inputSchema: bashSchema(60_000),
  schemaFor: (config) => bashSchema(config.life.bash.maxTimeoutMs),
  // Its intent is written by the tool itself, only for a non-empty change set (§16.9).
  sideEffect: false,
  run: bashTool
};
