import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWriteText } from "../storage/atomic.js";
import { ResourceLockManager } from "../storage/locks.js";
import {
  ActivationLifecycleStateSchema, ControlConnectionStateSchema, DirectConnectionStateSchema,
  HelperLifecycleStateSchema, RemoteAccessErrorCodeSchema
} from "../shared/schemas/remoteLifecycle.js";
import { HelperActivationErrorCodeSchema, HelperPairErrorCodeSchema } from "./helperTypes.js";

const events = z.enum(["lifecycle", "operation_failed", "runtime_restore_failed", "request_failed", "other"]);
const operations = z.enum([
  "activation_begin", "activation_poll", "activation_cancel", "pair_begin", "pair_poll", "pair_cancel", "pair_complete",
  "invitation_create", "pairing_requests", "pairing_approve", "pairing_reject", "device_revoke",
  "runtime_start", "runtime_status", "runtime_reconnect", "runtime_stop", "gateway_launch", "request", "status_refresh", "other"
]);
const codes = z.union([RemoteAccessErrorCodeSchema, HelperPairErrorCodeSchema, z.literal("other"), HelperActivationErrorCodeSchema]);
const entrySchema = z.object({
  time: z.string().datetime(), role: z.enum(["host", "remote"]), event: events,
  operation: operations.optional(), code: codes.optional(),
  helperState: z.union([HelperLifecycleStateSchema, z.literal("other")]).optional(),
  activationState: z.union([ActivationLifecycleStateSchema, z.literal("other")]).optional(),
  controlState: z.union([ControlConnectionStateSchema, z.literal("other")]).optional(),
  directState: z.union([DirectConnectionStateSchema, z.literal("other")]).optional(),
  responseClass: z.enum(["4xx", "5xx", "other"]).optional()
}).strict();
type Entry = z.infer<typeof entrySchema>;
export type RemoteDiagnosticOperation = z.infer<typeof operations>;
export type RemoteDiagnosticInput = Partial<Omit<Entry, "time" | "role">> & { event: z.infer<typeof events> };
const locks = new ResourceLockManager();
const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_PENDING = 64;

function allowed<T extends z.ZodType>(schema: T, value: unknown): z.output<T> | "other" {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : "other";
}

/** Read only a recognized code, never an exception's message, stack or properties. */
export function remoteDiagnosticCode(error: unknown): Entry["code"] {
  try {
    return allowed(codes, error && typeof error === "object" ? (error as { code?: unknown }).code : undefined);
  } catch { return "other"; }
}

/** Best-effort local diagnostics: closed fields, bounded queue and two private files. */
export class RemoteDiagnosticLog {
  readonly filePath: string;
  readonly #role: "host" | "remote";
  readonly #maxBytes: number;
  readonly #now: () => number;
  #pending: string[] = [];
  #tail: Promise<void> = Promise.resolve();
  #writing = false;
  #failed = false;
  #lastKey = "";
  #lastAt = 0;

  constructor(options: { dataRoot: string; role: "host" | "remote"; maxBytes?: number; now?: () => number }) {
    if (options.role !== "host" && options.role !== "remote") throw new TypeError("Invalid diagnostic role.");
    this.#role = options.role;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isInteger(this.#maxBytes) || this.#maxBytes < 512 || this.#maxBytes > DEFAULT_MAX_BYTES) throw new TypeError("Invalid diagnostic size bound.");
    this.#now = options.now ?? Date.now;
    this.filePath = path.join(path.resolve(options.dataRoot), "app", "logs", "remote-diagnostics", `${options.role}.jsonl`);
  }

  record(input: RemoteDiagnosticInput): void {
    if (this.#failed) return;
    try {
      const now = this.#now();
      const entry: Entry = { time: new Date(now).toISOString(), role: this.#role, event: allowed(events, input.event) };
      if (input.operation !== undefined) entry.operation = allowed(operations, input.operation);
      if (input.code !== undefined) entry.code = allowed(codes, input.code);
      if (input.helperState !== undefined) entry.helperState = allowed(HelperLifecycleStateSchema, input.helperState);
      if (input.activationState !== undefined) entry.activationState = allowed(ActivationLifecycleStateSchema, input.activationState);
      if (input.controlState !== undefined) entry.controlState = allowed(ControlConnectionStateSchema, input.controlState);
      if (input.directState !== undefined) entry.directState = allowed(DirectConnectionStateSchema, input.directState);
      if (input.responseClass !== undefined) entry.responseClass = input.responseClass === "4xx" || input.responseClass === "5xx" ? input.responseClass : "other";
      const key = JSON.stringify({ ...entry, time: undefined });
      if (key === this.#lastKey && now - this.#lastAt < 30_000) return;
      if (this.#pending.length >= MAX_PENDING) return;
      this.#lastKey = key;
      this.#lastAt = now;
      this.#pending.push(JSON.stringify(entry) + "\n");
      if (!this.#writing) {
        this.#writing = true;
        this.#tail = Promise.resolve().then(async () => {
          while (this.#pending.length) {
            const batch = this.#pending.splice(0);
            try { await locks.withLock(this.filePath, () => this.#append(batch)); }
            catch {
              // Do not repeatedly allocate atomic-write temps after a disk/ACL failure.
              this.#failed = true;
              this.#pending.length = 0;
            }
          }
        }).finally(() => { this.#writing = false; });
      }
    } catch { /* Diagnostic input must never affect remote authority or availability. */ }
  }

  async flush(): Promise<void> { await this.#tail; }

  async #readCurrent(): Promise<string> {
    try {
      const info = await lstat(this.filePath);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw new Error("Unsafe diagnostic file.");
      if (info.size > this.#maxBytes) return "";
      const handle = await open(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.size > this.#maxBytes) throw new Error("Diagnostic file changed.");
        const content = await handle.readFile("utf8");
        return content.split("\n").flatMap(line => {
          try { return [JSON.stringify(entrySchema.parse(JSON.parse(line))) + "\n"]; } catch { return []; }
        }).join("");
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  async #append(batch: string[]): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw new Error("Unsafe diagnostic directory.");
    let content = await this.#readCurrent();
    for (const line of batch) {
      if (Buffer.byteLength(line) > this.#maxBytes) continue;
      if (Buffer.byteLength(content) + Buffer.byteLength(line) > this.#maxBytes) {
        await atomicWriteText(`${this.filePath}.1`, content, { mode: 0o600, privateMetadata: true });
        content = "";
      }
      content += line;
    }
    await atomicWriteText(this.filePath, content, { mode: 0o600, privateMetadata: true });
  }
}
