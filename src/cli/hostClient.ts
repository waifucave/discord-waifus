// The CLI's connection to the running host (overhaul spec §10.5 "Transport"): find the verified
// host process of this data root, check its identity (GET /api/runtime must name the same pid and
// data root), then talk to its loopback API. Requests carry no browser headers (no Origin, cookie or
// CSRF), so the host treats them as the local owner. No secret is ever put on the command line or in
// a URL; request bodies carry them.

import path from "node:path";
import { loadAppConfig } from "../config/appConfig.js";
import { appDataPath } from "../config/paths.js";
import { processIsAlive, readProcessState } from "./processState.js";
import { hostPidIsGenuine, RuntimeStateReadSchema } from "./hostIdentity.js";
import { processStartTime, type ProcessIdentityProbe } from "../storage/instanceLock.js";

export type HostRequest = { method: "GET" | "PUT" | "POST" | "DELETE"; path: string; body?: unknown; timeoutMs?: number };
export type HostResponse = { status: number; body: unknown; text: string };
export type HostTransport = (request: HostRequest) => Promise<HostResponse>;

/** The host is not running (exit 3), or it is not this data root's host. */
export class HostUnavailableError extends Error {
  override name = "HostUnavailableError";
}

const DEFAULT_TIMEOUT_MS = 30_000;

function loopbackHost(host: string | undefined): string {
  if (!host || host === "0.0.0.0" || host === "localhost") return "127.0.0.1";
  if (host === "::" || host === "::1") return "[::1]";
  return host.includes(":") ? `[${host}]` : host;
}

/** A transport over fetch to one base URL. */
export function fetchTransport(baseUrl: string): HostTransport {
  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}${request.path}`, {
        method: request.method,
        headers: request.body === undefined ? {} : { "content-type": "application/json" },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal
      });
      const text = await response.text();
      let body: unknown = undefined;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      return { status: response.status, body, text };
    } catch (error) {
      throw new HostUnavailableError(
        controller.signal.aborted ? "The host did not answer in time." : `The host could not be reached (${error instanceof Error ? error.message : String(error)}).`
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The running host of `dataRoot`, verified: its pid file, its process identity and its own answer
 * about who it is. Undefined when no host runs. The address is the configured `http.host` (a
 * wildcard or `localhost` reads as loopback), then 127.0.0.1, then ::1: a host bound to IPv6
 * loopback only is reached too.
 */
export async function connectHost(
  dataRoot: string,
  o: { probe?: ProcessIdentityProbe; host?: string } = {}
): Promise<HostTransport | undefined> {
  const probe = o.probe ?? { isAlive: processIsAlive, startTime: (pid: number) => processStartTime(pid) };
  const state = await readProcessState(appDataPath(dataRoot, "pid.json"), RuntimeStateReadSchema).catch(() => undefined);
  if (!state || !(await hostPidIsGenuine(dataRoot, state, probe))) return undefined;
  const configured = o.host ?? (await loadAppConfig(dataRoot).then((config) => config.http.host).catch(() => undefined));
  const addresses = [...new Set([loopbackHost(configured), "127.0.0.1", "[::1]"])];
  let unreachable: HostUnavailableError | undefined;
  for (const address of addresses) {
    const transport = fetchTransport(`http://${address}:${state.port}`);
    let runtime: HostResponse;
    try {
      runtime = await transport({ method: "GET", path: "/api/runtime", timeoutMs: 5_000 });
    } catch (error) {
      if (!(error instanceof HostUnavailableError)) throw error;
      unreachable ??= error;
      continue;
    }
    const body = runtime.body as { pid?: unknown; dataRoot?: unknown } | undefined;
    if (runtime.status !== 200 || body?.pid !== state.pid || typeof body.dataRoot !== "string" || path.resolve(body.dataRoot) !== path.resolve(dataRoot)) {
      throw new HostUnavailableError(`The process on port ${state.port} is not this data root's host; stop it or check --data-root.`);
    }
    return transport;
  }
  throw unreachable ?? new HostUnavailableError("The host could not be reached.");
}
