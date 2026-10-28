import { constants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { loadAppConfig } from "../config/appConfig.js";
import { renameWithRetry } from "../storage/atomic.js";
import {
  discardOwnedEmptyMetadataFile,
  protectNewPrivateMetadataFile,
  validatePrivateMetadataFile
} from "../storage/privateMetadataFile.js";
import type { HelperRole } from "./helperTypes.js";

/** The helper enables its own redacted network log only when started with exactly this set to "1". */
export const HELPER_DEBUG_LOG_ENV = "TS_CONNECT_DEBUG_LOG";
export const HELPER_DEBUG_LOG_MAX_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = 256 * 1024;
const NEWLINE = 0x0a;

/**
 * The first helper that redacts its own stderr. Older helpers ignore the variable but print some
 * unfiltered lines (for example private paths), so their stderr is never stored.
 */
export const HELPER_DEBUG_LOG_MIN_VERSION = "0.1.18";

export function helperSupportsDebugLog(version: string): boolean {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)$/u.exec(value)?.slice(1).map(Number);
  const actual = parse(version);
  const minimum = parse(HELPER_DEBUG_LOG_MIN_VERSION)!;
  if (!actual) return false;
  for (let index = 0; index < 3; index++) {
    if (actual[index]! !== minimum[index]!) return actual[index]! > minimum[index]!;
  }
  return true;
}

export function helperDebugLogPath(dataRoot: string, role: HelperRole): string {
  return path.join(path.resolve(dataRoot), "app", "logs", "remote-diagnostics", `helper-${role}.log`);
}

/** `remoteAccess.helperDebugLog` from config.toml; an unreadable config keeps the log off. */
export async function helperDebugLogEnabled(dataRoot: string): Promise<boolean> {
  try {
    return (await loadAppConfig(dataRoot)).remoteAccess.helperDebugLog === true;
  } catch {
    return false;
  }
}

/**
 * The opt-in helper stderr log (`remoteAccess.helperDebugLog`): the helper already redacts its own
 * lines; this only stores them. One owner-private file per role (the private metadata writer,
 * Windows DACL included), capped at 1 MiB plus one rotated copy, appended in order through a
 * bounded queue. Never uploaded, never read back by the app, never part of diagnostics or an API
 * response. The first storage failure disables it until the process restarts.
 */
export class HelperDebugLog {
  readonly filePath: string;
  readonly #maxBytes: number;
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #droppedBytes = 0;
  #writing = false;
  #tail: Promise<void> = Promise.resolve();
  #failed = false;
  #handle: FileHandle | null = null;
  #size = 0;

  constructor(options: { dataRoot: string; role: HelperRole; maxBytes?: number }) {
    if (options.role !== "host" && options.role !== "remote") throw new TypeError("Invalid helper debug log role.");
    this.#maxBytes = options.maxBytes ?? HELPER_DEBUG_LOG_MAX_BYTES;
    if (!Number.isInteger(this.#maxBytes) || this.#maxBytes < 512 || this.#maxBytes > HELPER_DEBUG_LOG_MAX_BYTES) {
      throw new TypeError("Invalid helper debug log size bound.");
    }
    this.filePath = helperDebugLogPath(options.dataRoot, options.role);
  }

  get failed(): boolean { return this.#failed; }

  write(chunk: Buffer | string): void {
    if (this.#failed) return;
    try {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      if (bytes.byteLength === 0) return;
      if (this.#pendingBytes + bytes.byteLength > MAX_PENDING_BYTES) {
        this.#droppedBytes += bytes.byteLength;
        return;
      }
      this.#pending.push(bytes);
      this.#pendingBytes += bytes.byteLength;
      this.#schedule();
    } catch { /* The debug log must never affect the helper or Remote Access. */ }
  }

  #schedule(): void {
    if (this.#writing) return;
    this.#writing = true;
    this.#tail = this.#drain().finally(() => {
      this.#writing = false;
      // A chunk queued between the drain's last check and here still gets written.
      if (this.#pending.length > 0 && !this.#failed) this.#schedule();
    });
  }

  async flush(): Promise<void> {
    while (this.#writing) await this.#tail;
  }

  async close(): Promise<void> {
    await this.flush();
    const handle = this.#handle;
    this.#handle = null;
    await handle?.close().catch(() => undefined);
  }

  async #drain(): Promise<void> {
    while (this.#pending.length > 0 && !this.#failed) {
      const parts = this.#pending.splice(0);
      this.#pendingBytes = 0;
      if (this.#droppedBytes > 0) {
        parts.unshift(Buffer.from(`${new Date().toISOString()} discord-waifus: ${this.#droppedBytes} bytes of helper output dropped (writer behind)\n`));
        this.#droppedBytes = 0;
      }
      try {
        await this.#append(Buffer.concat(parts));
      } catch {
        // Do not retry against a disk, permission or ACL failure: off until the next start.
        this.#failed = true;
        this.#pending = [];
        this.#pendingBytes = 0;
        const handle = this.#handle;
        this.#handle = null;
        await handle?.close().catch(() => undefined);
      }
    }
  }

  async #append(data: Buffer): Promise<void> {
    let offset = 0;
    while (offset < data.byteLength) {
      if (!this.#handle) await this.#openCurrent();
      const remaining = data.subarray(offset);
      if (this.#size + remaining.byteLength <= this.#maxBytes) {
        await this.#handle!.writeFile(remaining);
        this.#size += remaining.byteLength;
        return;
      }
      // Rotate at a line boundary; a single line longer than the cap is cut.
      const room = this.#maxBytes - this.#size;
      let cut = remaining.subarray(0, room).lastIndexOf(NEWLINE) + 1;
      if (cut === 0 && this.#size === 0) cut = room;
      if (cut > 0) {
        await this.#handle!.writeFile(remaining.subarray(0, cut));
        this.#size += cut;
        offset += cut;
      }
      await this.#rotate();
    }
  }

  async #openCurrent(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
      || (process.platform !== "win32" && (directoryInfo.mode & 0o077) !== 0)) {
      throw new Error("Unsafe helper debug log directory.");
    }
    let existing;
    try {
      existing = await lstat(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.#create();
      return;
    }
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error("Unsafe helper debug log file.");
    // Reuse only a file that is already owner-private (never re-permission one silently).
    await validatePrivateMetadataFile(this.filePath, Number.MAX_SAFE_INTEGER);
    const handle = await open(this.filePath, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== existing.ino || opened.dev !== existing.dev) throw new Error("Helper debug log file changed.");
      this.#size = opened.size;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    this.#handle = handle;
    if (this.#size >= this.#maxBytes) await this.#rotate();
  }

  async #create(): Promise<void> {
    const handle = await open(this.filePath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await protectNewPrivateMetadataFile(this.filePath);
    } catch (error) {
      await discardOwnedEmptyMetadataFile(this.filePath, handle);
      await handle.close().catch(() => undefined);
      throw error;
    }
    this.#handle = handle;
    this.#size = 0;
  }

  async #rotate(): Promise<void> {
    const handle = this.#handle;
    this.#handle = null;
    await handle?.close();
    await renameWithRetry(this.filePath, `${this.filePath}.1`);
    await this.#create();
  }
}
