// What the settings and life commands share: exit codes (overhaul spec §10.5), output in human or
// `--json` form, the host connection, and secure input for secrets (never argv).

import { createInterface } from "node:readline/promises";
import type { HostResponse, HostTransport } from "./hostClient.js";
import { HostUnavailableError } from "./hostClient.js";

export const EXIT = { ok: 0, failure: 1, usage: 2, host: 3, rejected: 4, conflict: 5 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type CliIo = {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Standard input as text (a piped secret or a note); undefined when stdin is a terminal. */
  readStdin: () => Promise<string | undefined>;
  /** A question on the terminal; undefined without one. `hidden` does not echo (secrets). */
  ask?: (question: string, o?: { hidden?: boolean }) => Promise<string>;
  env: NodeJS.ProcessEnv;
};

export type CliContext = CliIo & {
  dataRoot: string;
  json: boolean;
  /** The verified running host (memoized), or undefined when none runs. */
  host: () => Promise<HostTransport | undefined>;
};

/** A failure with its exit code and a message for people. */
export class CliFailure extends Error {
  constructor(
    readonly exitCode: ExitCode,
    message: string,
    readonly detail?: { status?: number; code?: string; issues?: unknown; hint?: string }
  ) {
    super(message);
    this.name = "CliFailure";
  }
}

export function usageError(message: string, hint?: string): CliFailure {
  return new CliFailure(EXIT.usage, message, hint ? { hint } : undefined);
}

export const HOST_NOT_RUNNING = "The host is not running; start it with `waifus start`.";

export async function requireHost(ctx: CliContext): Promise<HostTransport> {
  const host = await ctx.host();
  if (!host) throw new CliFailure(EXIT.host, HOST_NOT_RUNNING);
  return host;
}

/** An HTTP error answer as a CLI failure (400/403/404/428 → 4, 409 → 5, 5xx → 1). */
export function httpFailure(response: HostResponse, what: string): CliFailure {
  const body = (response.body && typeof response.body === "object" ? response.body : {}) as { error?: string; message?: string; issues?: unknown };
  const message = body.message ?? (typeof response.body === "string" && response.body ? response.body : `HTTP ${response.status}`);
  const exitCode = response.status === 409 ? EXIT.conflict : response.status >= 500 ? EXIT.failure : EXIT.rejected;
  return new CliFailure(exitCode, `${what}: ${message}`, { status: response.status, ...(body.error ? { code: body.error } : {}), ...(body.issues ? { issues: body.issues } : {}) });
}

/** Sends a request and returns the body of a 2xx answer (else a CliFailure). */
export async function call<T = Record<string, unknown>>(host: HostTransport, request: Parameters<HostTransport>[0], what: string): Promise<{ status: number; body: T }> {
  const response = await host(request);
  if (response.status < 200 || response.status >= 300) throw httpFailure(response, what);
  return { status: response.status, body: response.body as T };
}

/** Runs a command body: prints a failure in the requested form and returns its exit code. */
export async function runCli(ctx: CliContext, body: () => Promise<ExitCode>): Promise<ExitCode> {
  try {
    return await body();
  } catch (error) {
    const failure =
      error instanceof CliFailure
        ? error
        : error instanceof HostUnavailableError
          ? new CliFailure(EXIT.host, error.message)
          : new CliFailure(EXIT.failure, error instanceof Error ? error.message : String(error));
    if (ctx.json) {
      ctx.out(JSON.stringify({ ok: false, error: { message: failure.message, ...(failure.detail ?? {}) } }, null, 2));
    } else {
      ctx.err(failure.message);
      if (failure.detail?.hint) ctx.err(failure.detail.hint);
    }
    return failure.exitCode;
  }
}

/** Display form of a value: strings as they are, everything else as JSON. */
export function display(value: unknown): string {
  if (value === undefined) return "(unset)";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export async function readAllStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** A terminal question; a hidden one does not echo what is typed (for secrets). */
export async function askOnTerminal(question: string, o: { hidden?: boolean } = {}): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (o.hidden) {
    const internal = rl as unknown as { _writeToOutput?: (text: string) => void; output?: NodeJS.WritableStream };
    internal._writeToOutput = (text: string) => {
      if (text.includes(question)) process.stdout.write(text);
    };
  }
  try {
    return await rl.question(question);
  } finally {
    rl.close();
    if (o.hidden) process.stdout.write("\n");
  }
}

export function defaultIo(): CliIo {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    readStdin: readAllStdin,
    ...(process.stdin.isTTY && process.stdout.isTTY ? { ask: askOnTerminal } : {}),
    env: process.env
  };
}
