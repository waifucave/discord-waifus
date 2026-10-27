// Her simulated Bash, inside its own worker thread (Living cast spec §16.3.5, T10). This file is the
// worker's entry: it is loaded by Node directly (native type stripping in development, the
// compiled .js when installed), so it imports only npm packages and `node:` builtins, plus the
// `image` command through a computed dynamic import of its sibling file.
//
// What runs here:
// - just-bash (an interpreter written in TypeScript, no real programs) with python3 (CPython
//   compiled to WebAssembly, in just-bash's own nested worker) when allowed;
// - over an in-memory copy of her two folders: every file is a lazy entry whose bytes are asked
//   for over the message port the first time something reads them (never by host path);
// - through a guarded filesystem: only `/home/<slug>` and `/tmp` exist and are writable, links
//   are refused, `~/life/places.md` is read-only;
// - and `/transcripts` (spec §18.3), mounted lazily and read-only: listings, sizes and the rendered
//   day files are asked for over the same port when a command opens them, never copied in (the
//   store grows forever); every write, move or removal there fails with "transcripts are read-only";
// - and when the command ends, the change set (written files with their bytes, deleted paths,
//   created folders) goes back to the host, which checks and applies it all or nothing.
// The host terminates this worker when the wall-clock limit passes; nothing is saved then.

import { parentPort, workerData } from "node:worker_threads";
import path from "node:path";
import { Bash, defineCommand, InMemoryFs, unsafeBytesFromLatin1 } from "just-bash";
import type { IFileSystem } from "just-bash";

type ManifestEntry = { path: string; kind: "file" | "dir"; size: number; mtimeMs: number };

export type BashWorkerInput = {
  slug: string;
  manifest: ManifestEntry[];
  command: string;
  timeoutMs: number;
  python: boolean;
  env: Record<string, string>;
  /** Command names registered (the host's allow list). */
  commands: string[];
  /** just-bash's aggregate stdout+stderr cap, in bytes. */
  maxOutputBytes: number;
  /** In-memory filesystem cap, in bytes. */
  maxFileSystemBytes: number;
  /** Most entries a change set may carry; past it nothing is sent and the host refuses the set. */
  maxChanges: number;
  /** Mount `/transcripts` (read-only, served by the host on demand). */
  transcripts?: boolean;
};

/** A `/transcripts` entry as the host describes it. */
export type TranscriptsStat = { kind: "file" | "dir"; size: number; mtimeMs: number };

export type BashWorkerChange = { writes: Array<{ path: string; data: Uint8Array }>; deletes: string[]; dirs: string[] };

export type BashWorkerMessage =
  | { type: "read"; id: number; path: string }
  | { type: "transcripts"; id: number; op: "stat" | "list" | "read"; path: string }
  | {
      type: "done";
      stdout: string;
      stderr: string;
      exitCode: number;
      changes: BashWorkerChange;
      /** Every path the command read, listed, stat'ed, removed, moved or copied (the host's DM check). */
      touched: string[];
      /** Set instead of `changes` when the command changed more than `maxChanges` entries. */
      tooMany?: number;
    }
  | { type: "fatal"; message: string };

export type BashHostMessage =
  | { type: "read-result"; id: number; data?: Uint8Array; error?: string }
  | {
      type: "transcripts-result";
      id: number;
      stat?: TranscriptsStat;
      entries?: Array<{ name: string } & TranscriptsStat>;
      data?: Uint8Array;
      error?: string;
    };

const input = workerData as BashWorkerInput;
const port = parentPort!;
const home = `/home/${input.slug}`;
const placesFile = `${home}/life/places.md`;

// ---- reads from the host ------------------------------------------------------------------------------

let nextRead = 1;
const waiting = new Map<number, { resolve: (data: Uint8Array) => void; reject: (error: Error) => void }>();
port.on("message", (message: BashHostMessage) => {
  if (message.type === "transcripts-result") {
    const asked = transcriptWaiting.get(message.id);
    if (!asked) return;
    transcriptWaiting.delete(message.id);
    if (message.error !== undefined) asked.reject(transcriptError(message.error, asked.op, asked.path));
    else asked.resolve(message);
    return;
  }
  if (message.type !== "read-result") return;
  const pending = waiting.get(message.id);
  if (!pending) return;
  waiting.delete(message.id);
  if (message.data) pending.resolve(message.data);
  else pending.reject(new Error(message.error ?? "EIO: the file could not be read"));
});

function readFromHost(virtual: string): Promise<Uint8Array> {
  const id = nextRead++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    port.postMessage({ type: "read", id, path: virtual } satisfies BashWorkerMessage);
  });
}

// ---- /transcripts from the host ----------------------------------------------------------------------------

const TRANSCRIPTS = "/transcripts";
type TranscriptsAnswer = Extract<BashHostMessage, { type: "transcripts-result" }>;
const transcriptWaiting = new Map<number, { op: string; path: string; resolve: (answer: TranscriptsAnswer) => void; reject: (error: Error) => void }>();

function transcriptError(code: string, op: string, p: string): Error {
  const text = code === "ENOTDIR" ? "not a directory" : code === "EISDIR" ? "illegal operation on a directory" : "no such file or directory";
  const error = new Error(`${code}: ${text}, ${op} '${p}'`) as Error & { code: string };
  error.code = code;
  return error;
}

function askTranscripts(op: "stat" | "list" | "read", virtual: string): Promise<TranscriptsAnswer> {
  const id = nextRead++;
  return new Promise((resolve, reject) => {
    transcriptWaiting.set(id, { op, path: virtual, resolve, reject });
    port.postMessage({ type: "transcripts", id, op, path: virtual } satisfies BashWorkerMessage);
  });
}

async function transcriptBytes(virtual: string): Promise<Uint8Array> {
  const answer = await askTranscripts("read", virtual);
  if (!answer.data) throw transcriptError("EISDIR", "read", virtual);
  return answer.data;
}

function readOnly(op: string, p: string): Error {
  const error = new Error(`EROFS: transcripts are read-only, ${op} '${p}'`) as Error & { code: string };
  error.code = "EROFS";
  return error;
}

// ---- the guarded filesystem -----------------------------------------------------------------------------

function norm(p: string): string {
  const out = path.posix.normalize(p.startsWith("/") ? p : `/${p}`);
  return out.length > 1 ? out.replace(/\/+$/u, "") : out;
}

function within(p: string, root: string): boolean {
  return p === root || p.startsWith(`${root}/`);
}

/** Paths that exist for her at all (and `/dev/null`, which redirections use). */
function visible(p: string): boolean {
  return p === "/" || p === "/home" || within(p, home) || within(p, "/tmp") || p === "/dev" || p === "/dev/null" || inTranscripts(p);
}

function inTranscripts(p: string): boolean {
  return input.transcripts === true && within(p, TRANSCRIPTS);
}

/** What `ls /` shows. */
function topLevel(): string[] {
  return input.transcripts === true ? ["home", "tmp", "transcripts"] : ["home", "tmp"];
}

/** Paths she may create, change or remove: inside her folders, never the folders themselves. */
function writable(p: string): boolean {
  return ((p.startsWith(`${home}/`) || p.startsWith("/tmp/")) && p !== placesFile) || p === "/dev/null";
}

function fsError(code: "ENOENT" | "EACCES" | "EPERM", op: string, p: string): Error {
  const text = code === "ENOENT" ? "no such file or directory" : code === "EACCES" ? "permission denied" : "operation not permitted";
  const error = new Error(`${code}: ${text}, ${op} '${p}'`) as Error & { code: string };
  error.code = code;
  return error;
}

const inner = new InMemoryFs(undefined, { maxTotalBytes: input.maxFileSystemBytes });
/** Original files not read yet (current path → where the bytes come from, size, mtime). */
const pending = new Map<string, { origin: string; size: number; mtime: Date }>();
/** Paths a command changed (the change set is computed under them). */
const dirty = new Set<string>();
/** Paths it read, listed or moved (bounded; the host checks them for private-chat files). */
const touched = new Set<string>();
const MAX_TOUCHED = 50_000;
function touch(p: string): void {
  if (touched.size < MAX_TOUCHED && (within(p, home) || within(p, "/tmp"))) touched.add(p);
}
const originals = new Map<string, ManifestEntry>();

inner.mkdirSync(home, { recursive: true });
inner.mkdirSync("/tmp", { recursive: true });
for (const entry of input.manifest) {
  originals.set(entry.path, entry);
  if (entry.kind === "dir") {
    inner.mkdirSync(entry.path, { recursive: true });
    continue;
  }
  const origin = entry.path;
  const mtime = new Date(entry.mtimeMs);
  pending.set(origin, { origin, size: entry.size, mtime });
  inner.writeFileLazy(
    origin,
    async () => {
      for (const [key, value] of pending) if (value.origin === origin) pending.delete(key);
      return readFromHost(origin);
    },
    { mtime, mode: 0o644 }
  );
}

function markDirty(p: string): void {
  dirty.add(p);
}

function dropPending(p: string): void {
  for (const key of [...pending.keys()]) if (within(key, p)) pending.delete(key);
}

async function isDir(p: string): Promise<boolean> {
  if (pending.has(p)) return false;
  return inner.stat(p).then((info) => info.isDirectory, () => false);
}

class GuardedFs implements IFileSystem {
  private guardRead(op: string, p: string): string {
    const n = norm(p);
    if (!visible(n)) throw fsError("ENOENT", op, p);
    return n;
  }

  private guardWrite(op: string, p: string): string {
    const n = norm(p);
    if (inTranscripts(n)) throw readOnly(op, p);
    if (!visible(n)) throw fsError("ENOENT", op, p);
    if (!writable(n)) throw fsError("EACCES", op, p);
    return n;
  }

  async readFile(p: string, options?: Parameters<IFileSystem["readFile"]>[1]): Promise<string> {
    const n = this.guardRead("open", p);
    if (inTranscripts(n)) return new TextDecoder().decode(await transcriptBytes(n));
    touch(n);
    return inner.readFile(n, options);
  }

  async readFileBytes(p: string) {
    const n = this.guardRead("open", p);
    if (inTranscripts(n)) return unsafeBytesFromLatin1(Buffer.from(await transcriptBytes(n)).toString("latin1"));
    touch(n);
    return inner.readFileBytes(n);
  }

  async readFileBuffer(p: string): Promise<Uint8Array> {
    const n = this.guardRead("open", p);
    if (inTranscripts(n)) return transcriptBytes(n);
    touch(n);
    return inner.readFileBuffer(n);
  }

  async writeFile(p: string, content: Parameters<IFileSystem["writeFile"]>[1], options?: Parameters<IFileSystem["writeFile"]>[2]): Promise<void> {
    const n = this.guardWrite("open", p);
    if (n === "/dev/null") return;
    dropPending(n);
    markDirty(n);
    await inner.writeFile(n, content, options);
  }

  async appendFile(p: string, content: Parameters<IFileSystem["appendFile"]>[1], options?: Parameters<IFileSystem["appendFile"]>[2]): Promise<void> {
    const n = this.guardWrite("open", p);
    if (n === "/dev/null") return;
    // Appending reads the original first (the lazy entry loads), then it is hers to change.
    markDirty(n);
    await inner.appendFile(n, content, options);
    dropPending(n);
  }

  async exists(p: string): Promise<boolean> {
    const n = norm(p);
    if (!visible(n)) return false;
    if (inTranscripts(n)) return askTranscripts("stat", n).then((answer) => answer.stat !== undefined, () => false);
    if (pending.has(n)) return true;
    return inner.exists(n);
  }

  async stat(p: string) {
    const n = this.guardRead("stat", p);
    if (inTranscripts(n)) {
      const answer = await askTranscripts("stat", n);
      if (!answer.stat) throw transcriptError("ENOENT", "stat", p);
      const dir = answer.stat.kind === "dir";
      return { isFile: !dir, isDirectory: dir, isSymbolicLink: false, mode: dir ? 0o555 : 0o444, size: answer.stat.size, mtime: new Date(answer.stat.mtimeMs) };
    }
    touch(n);
    const lazy = pending.get(n);
    // An original nobody read yet: its size and time from the host, without loading it.
    if (lazy) return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0o644, size: lazy.size, mtime: lazy.mtime };
    return inner.stat(n);
  }

  async lstat(p: string) {
    return this.stat(p);
  }

  async mkdir(p: string, options?: Parameters<IFileSystem["mkdir"]>[1]): Promise<void> {
    const n = norm(p);
    // `mkdir -p` of a folder that exists in /transcripts is fine; anything else there is refused.
    if (inTranscripts(n) && options?.recursive && (await this.exists(n))) return;
    if (visible(n) && !writable(n) && (n === home || n === "/tmp" || n === "/home" || n === "/" || n === "/dev")) {
      // The folders that exist already: `mkdir -p ~` is fine.
      if (options?.recursive) return;
    }
    this.guardWrite("mkdir", p);
    markDirty(n);
    await inner.mkdir(n, options);
  }

  async createExclusive(p: string, options: Parameters<NonNullable<IFileSystem["createExclusive"]>>[1]): Promise<void> {
    const n = this.guardWrite("open", p);
    markDirty(n);
    await inner.createExclusive(n, options);
  }

  private async transcriptEntries(n: string, p: string) {
    const answer = await askTranscripts("list", n);
    if (!answer.entries) throw transcriptError(answer.stat ? "ENOTDIR" : "ENOENT", "scandir", p);
    return answer.entries;
  }

  async readdir(p: string): Promise<string[]> {
    const n = this.guardRead("scandir", p);
    if (n === "/") return topLevel();
    if (inTranscripts(n)) return (await this.transcriptEntries(n, p)).map((entry) => entry.name);
    if (n === "/home") return [input.slug];
    const names = await inner.readdir(n);
    touch(n);
    for (const name of names) touch(path.posix.join(n, name));
    return names;
  }

  async readdirWithFileTypes(p: string) {
    const n = this.guardRead("scandir", p);
    if (n === "/") return topLevel().map((name) => ({ name, isFile: false, isDirectory: true, isSymbolicLink: false }));
    if (inTranscripts(n)) return (await this.transcriptEntries(n, p)).map((entry) => ({ name: entry.name, isFile: entry.kind === "file", isDirectory: entry.kind === "dir", isSymbolicLink: false }));
    if (n === "/home") return [{ name: input.slug, isFile: false, isDirectory: true, isSymbolicLink: false }];
    const entries = await inner.readdirWithFileTypes(n);
    touch(n);
    for (const entry of entries) touch(path.posix.join(n, entry.name));
    return entries;
  }

  async rm(p: string, options?: Parameters<IFileSystem["rm"]>[1]): Promise<void> {
    const n = this.guardWrite("rm", p);
    touch(n);
    dropPending(n);
    markDirty(n);
    await inner.rm(n, options);
  }

  async cp(src: string, dest: string, options?: Parameters<IFileSystem["cp"]>[2]): Promise<void> {
    const from = this.guardRead("cp", src);
    const to = this.guardWrite("cp", dest);
    // A copy out of /transcripts is a new file of hers (a quote she wants to keep).
    if (inTranscripts(from)) {
      await this.copyTranscripts(from, (await isDir(to)) ? path.posix.join(to, path.posix.basename(from)) : to, src, options?.recursive === true);
      return;
    }
    touch(from);
    touch(to);
    markDirty(to);
    // The copy is new content of hers: load the source first so the copy is a real file.
    if (pending.has(from)) await inner.readFileBuffer(from);
    for (const key of [...pending.keys()]) if (within(key, from)) await inner.readFileBuffer(key);
    dropPending(to);
    await inner.cp(from, to, options);
  }

  async mv(src: string, dest: string): Promise<void> {
    const from = this.guardWrite("rename", src);
    const to = this.guardWrite("rename", dest);
    touch(from);
    touch(to);
    const final = (await isDir(to)) ? path.posix.join(to, path.posix.basename(from)) : to;
    markDirty(from);
    markDirty(final);
    dropPending(final);
    // Originals not read yet move with the entry: they load from where they came from.
    for (const [key, value] of [...pending]) {
      if (!within(key, from)) continue;
      pending.delete(key);
      pending.set(final + key.slice(from.length), value);
    }
    await inner.mv(from, to);
  }

  private async copyTranscripts(from: string, to: string, src: string, recursive: boolean): Promise<void> {
    const answer = await askTranscripts("stat", from);
    if (!answer.stat) throw transcriptError("ENOENT", "cp", src);
    if (answer.stat.kind === "file") {
      const data = await transcriptBytes(from);
      dropPending(to);
      markDirty(to);
      await inner.writeFile(to, data);
      return;
    }
    if (!recursive) throw transcriptError("EISDIR", "cp", src);
    markDirty(to);
    await inner.mkdir(to, { recursive: true });
    for (const entry of await this.transcriptEntries(from, src)) await this.copyTranscripts(path.posix.join(from, entry.name), path.posix.join(to, entry.name), src, true);
  }

  resolvePath(base: string, p: string): string {
    return inner.resolvePath(base, p);
  }

  getAllPaths(): string[] {
    return inner.getAllPaths().filter((p) => visible(p) && p !== "/dev" && p !== "/dev/null");
  }

  async chmod(p: string, mode: number): Promise<void> {
    const n = this.guardWrite("chmod", p);
    await inner.chmod(n, mode);
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    throw fsError("EPERM", "symlink", linkPath);
  }

  async link(_existing: string, newPath: string): Promise<void> {
    throw fsError("EPERM", "link", newPath);
  }

  async readlink(p: string): Promise<string> {
    // Nothing here is a link.
    throw Object.assign(new Error(`EINVAL: invalid argument, readlink '${p}'`), { code: "EINVAL" });
  }

  async realpath(p: string): Promise<string> {
    const n = this.guardRead("realpath", p);
    if (inTranscripts(n)) {
      if (!(await this.exists(n))) throw fsError("ENOENT", "realpath", p);
      return n;
    }
    if (!(await this.exists(n))) throw fsError("ENOENT", "realpath", p);
    return n;
  }

  async utimes(p: string, atime: Date, mtime: Date): Promise<void> {
    const n = this.guardWrite("utime", p);
    if (pending.has(n)) await inner.readFileBuffer(n);
    await inner.utimes(n, atime, mtime);
  }
}

// ---- the change set ---------------------------------------------------------------------------------------

async function walk(root: string, out: Map<string, "file" | "dir">): Promise<void> {
  if (!(await inner.exists(root))) return;
  if (pending.has(root) || !(await isDir(root))) {
    out.set(root, "file");
    return;
  }
  out.set(root, "dir");
  for (const name of await inner.readdir(root)) await walk(path.posix.join(root, name), out);
}

async function changeSet(): Promise<BashWorkerChange | { tooMany: number }> {
  const roots = [...dirty].filter((p) => p !== "/dev/null" && (within(p, home) || within(p, "/tmp")));
  // Only the outermost changed roots.
  const outer = roots.filter((p) => !roots.some((other) => other !== p && within(p, other)));
  const final = new Map<string, "file" | "dir">();
  for (const root of outer) await walk(root, final);
  // Far more than can be saved: say so without copying anything.
  if (final.size > input.maxChanges * 2) return { tooMany: final.size };
  const changes: BashWorkerChange = { writes: [], deletes: [], dirs: [] };
  for (const [p, entry] of originals) {
    if (!outer.some((root) => within(p, root))) continue;
    const now = final.get(p);
    if (now === undefined || now !== entry.kind) changes.deletes.push(p);
  }
  for (const [p, kind] of final) {
    if (p === home || p === "/tmp") continue;
    if (kind === "dir") {
      if (originals.get(p)?.kind !== "dir") changes.dirs.push(p);
      continue;
    }
    // An original still unread at its own place did not change.
    const lazy = pending.get(p);
    if (lazy && lazy.origin === p) continue;
    // A copy with its own buffer, so it can be transferred to the host.
    // A copy in a fresh ArrayBuffer of its own: a Node Buffer may sit in the shared pool, which
    // cannot be transferred.
    changes.writes.push({ path: p, data: new Uint8Array(await inner.readFileBuffer(p)) });
  }
  // Deepest deletes are covered by their folder's; the host removes recursively.
  changes.deletes = changes.deletes.filter((p) => !changes.deletes.some((other) => other !== p && within(p, other)));
  const count = changes.writes.length + changes.deletes.length + changes.dirs.length;
  if (count > input.maxChanges) return { tooMany: count };
  return changes;
}

// ---- run ------------------------------------------------------------------------------------------------

/** `ENOENT: no such file or directory, open '/etc/x'` → `/etc/x: No such file or directory`. */
function shellError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^(ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|EEXIST|EROFS): ([^,]+), \w+ '([^']*)'/u.exec(message);
  if (!match) return message.split("\n")[0]!.slice(0, 300);
  const text = match[2]!;
  if (match[1] === "EROFS") return `${match[3]}: ${text}`;
  return `${match[3]}: ${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** How far past the host's wall clock just-bash's own deadlines are. */
const INNER_DEADLINE_SLACK_MS = 30_000;

async function main(): Promise<void> {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const imageModule = (await import(new URL(`./imageCommand${ext}`, import.meta.url).href)) as {
    runImageCommand(args: string[], io: { readFile(p: string): Promise<Uint8Array>; writeFile(p: string, data: Uint8Array): Promise<void>; resolve(p: string): string }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  const image = defineCommand("image", async (args, ctx) =>
    imageModule.runImageCommand(args, {
      readFile: (p) => ctx.fs.readFileBuffer(p),
      writeFile: (p, data) => ctx.fs.writeFile(p, data),
      resolve: (p) => ctx.fs.resolvePath(ctx.cwd, p.startsWith("~/") ? `${home}/${p.slice(2)}` : p === "~" ? home : p)
    })
  );
  const fs = new GuardedFs();
  const bash = new Bash({
    fs,
    cwd: home,
    env: input.env,
    python: input.python,
    commands: input.commands as never,
    customCommands: [image],
    executionLimits: {
      // Past the host's wall clock, which terminates this worker first (nothing is saved then).
      maxExecutionTimeMs: input.timeoutMs + INNER_DEADLINE_SLACK_MS,
      maxPythonTimeoutMs: input.timeoutMs + INNER_DEADLINE_SLACK_MS,
      maxSqliteTimeoutMs: input.timeoutMs + INNER_DEADLINE_SLACK_MS,
      maxOutputSize: input.maxOutputBytes,
      maxFileSystemBytes: input.maxFileSystemBytes
    },
    processInfo: { pid: 1, ppid: 0, uid: 1000, gid: 1000 }
  });
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await bash.exec(input.command, { replaceEnv: true, env: input.env, cwd: home });
  } catch (error) {
    // just-bash lets a refused redirection target (`> /etc/passwd`) end the whole script with an
    // exception: it reads as the shell's error, and what the script changed before it still counts.
    result = { stdout: "", stderr: `bash: ${shellError(error)}\n`, exitCode: 1 };
  }
  const computed = await changeSet();
  const changes: BashWorkerChange = "tooMany" in computed ? { writes: [], deletes: [], dirs: [] } : computed;
  const transfer = changes.writes.map((write) => write.data.buffer).filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
  port.postMessage(
    {
      type: "done",
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      changes,
      touched: [...touched],
      ...("tooMany" in computed ? { tooMany: computed.tooMany } : {})
    } satisfies BashWorkerMessage,
    transfer
  );
}

main().catch((error: unknown) => {
  port.postMessage({ type: "fatal", message: error instanceof Error ? error.message : String(error) } satisfies BashWorkerMessage);
});
