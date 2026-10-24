// Shared by the CLI tests of the settings and life commands: a real API on a temp data root, the
// CLI's host transport over Fastify's inject (no browser headers: the local owner) and a runner that
// captures output.
import type { FastifyInstance } from "fastify";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import type { CliIo } from "../src/cli/cliContext.js";
import { runCommand } from "../src/cli/commands.js";
import type { HostRequest, HostTransport } from "../src/cli/hostClient.js";
import { parseCliArgs } from "../src/cli/parser.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot } from "./testUtils.js";

export async function makeCliApp(roots: string[], apps: FastifyInstance[]): Promise<{ app: FastifyInstance; root: string; storage: StorageService }> {
  const root = await makeTempRoot();
  roots.push(root);
  await ensureDataLayout(root);
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    packageVersion: "3.0.0-test",
    port: 3888,
    dataRoot: root,
    mode: "test",
    paused: false,
    discord: { connected: false, houseConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const storage = new StorageService(root);
  const app = await createApiServer({ dataRoot: root, runtime, storage });
  apps.push(app);
  return { app, root, storage };
}

function parse(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
}

export function injectTransport(app: FastifyInstance, log?: HostRequest[]): HostTransport {
  return async (request) => {
    log?.push(request);
    const response = await app.inject({ method: request.method, url: request.path, ...(request.body !== undefined ? { payload: request.body as Record<string, unknown> } : {}) });
    return { status: response.statusCode, body: parse(response.body), text: response.body };
  };
}

export type CliRun = { code: number; out: string; err: string };

export async function cli(
  root: string,
  host: HostTransport | null,
  argv: string[],
  o: { stdin?: string; env?: NodeJS.ProcessEnv; ask?: CliIo["ask"]; now?: () => Date } = {}
): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readStdin: async () => o.stdin,
    ...(o.ask ? { ask: o.ask } : {}),
    env: o.env ?? {}
  };
  const code = await runCommand(parseCliArgs([...argv, "--data-root", root]), { cliIo: io, hostTransport: host, env: {}, ...(o.now ? { now: o.now } : {}) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
