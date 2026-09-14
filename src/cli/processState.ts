import { readFile, rm } from "node:fs/promises";
import type { z } from "zod";

export type ProcessState = Readonly<{ pid: number }>;

export async function readProcessState<T extends ProcessState>(
  filePath: string,
  schema: z.ZodType<T>
): Promise<T | undefined> {
  try {
    return schema.parse(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  isAlive: (pid: number) => boolean = processIsAlive
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

export type StopDaemonResult =
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "stale_removed"; pid: number }>
  | Readonly<{ state: "stopped"; pid: number; escalated: boolean }>
  | Readonly<{ state: "still_running"; pid: number }>;

export async function stopDaemonProcess<T extends ProcessState>(options: {
  readonly pidFile: string;
  readonly schema: z.ZodType<T>;
  readonly isAlive?: (pid: number) => boolean;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly waitForExit?: (pid: number, timeoutMs: number) => Promise<boolean>;
  readonly beforeTerminate?: (pid: number) => void | Promise<void>;
  readonly beforeEscalate?: (pid: number) => void | Promise<void>;
}): Promise<StopDaemonResult> {
  const processState = await readProcessState(options.pidFile, options.schema);
  if (!processState) return Object.freeze({ state: "absent" });
  const isAlive = options.isAlive ?? processIsAlive;
  if (!isAlive(processState.pid)) {
    await rm(options.pidFile, { force: true });
    return Object.freeze({ state: "stale_removed", pid: processState.pid });
  }
  const kill = options.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const wait = options.waitForExit
    ?? ((pid: number, timeoutMs: number) => waitForProcessExit(pid, timeoutMs, isAlive));
  await options.beforeTerminate?.(processState.pid);
  kill(processState.pid, "SIGTERM");
  if (await wait(processState.pid, 20_000)) {
    await rm(options.pidFile, { force: true });
    return Object.freeze({ state: "stopped", pid: processState.pid, escalated: false });
  }
  await options.beforeEscalate?.(processState.pid);
  try {
    kill(processState.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  if (await wait(processState.pid, 3_000)) {
    await rm(options.pidFile, { force: true });
    return Object.freeze({ state: "stopped", pid: processState.pid, escalated: true });
  }
  return Object.freeze({ state: "still_running", pid: processState.pid });
}
