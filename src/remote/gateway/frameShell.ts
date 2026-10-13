import type { FastifyReply, FastifyRequest } from "fastify";
import {
  startRemoteGateway,
  type RunningRemoteGateway
} from "./server.js";
import type { RemoteBrowserSessionStoreOptions } from "./session.js";

const DASHBOARD_FRAME_PATH = "/_waifus_remote/frame";
const KEEPALIVE_PATH = "/_waifus_remote/frame-keepalive";
const KEEPALIVE_SCRIPT_PATH = "/_waifus_remote/frame-session.js";
const KEEPALIVE_SCRIPT = `(() => {
  let pending = false;
  let expired = false;
  async function refresh() {
    if (pending || expired) return;
    pending = true;
    try {
      const response = await fetch("${KEEPALIVE_PATH}", {
        credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(10000)
      });
      if (response.status === 403) {
        expired = true;
        clearInterval(timer);
        document.body.textContent = "This browser session is no longer valid. Run waifus remote again to reopen your saved host. No new pairing is needed.";
      }
    } catch { /* Retry transient network failures on the next tick. */ }
    finally { pending = false; }
  }
  const timer = setInterval(refresh, 60000);
  window.addEventListener("pageshow", refresh);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });
})();`;
const DASHBOARD_FRAME_DOCUMENT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Waifus Remote</title>
    <script src="${KEEPALIVE_SCRIPT_PATH}" defer></script>
    <style>
      html, body, iframe { border: 0; height: 100%; margin: 0; padding: 0; width: 100%; }
      body { overflow: hidden; }
    </style>
  </head>
  <body>
    <iframe title="Waifus host dashboard" src="${DASHBOARD_FRAME_PATH}" sandbox="allow-scripts allow-forms allow-same-origin allow-downloads" referrerpolicy="no-referrer"></iframe>
  </body>
</html>`;

type DashboardFrameTarget = Readonly<{
  hostname: string;
  origin: string;
  issueBootstrapUrl: () => string;
}>;

export type StartRemoteDashboardFrameShellOptions = RemoteBrowserSessionStoreOptions & Readonly<{
  updateActivity?: import("../../backend/updates/activity.js").UpdateActivity;
  dashboard: DashboardFrameTarget;
  port?: number;
}>;

function exactDashboardBootstrap(target: DashboardFrameTarget): string {
  const raw = target.issueBootstrapUrl();
  const url = new URL(raw);
  if (
    url.origin !== target.origin
    || url.hostname !== target.hostname
    || !/^\/_waifus_remote\/bootstrap\/[A-Za-z0-9_-]{43}$/u.test(url.pathname)
    || url.search !== ""
    || url.hash !== ""
    || url.username !== ""
    || url.password !== ""
    || url.href !== raw
  ) {
    throw new Error("Dashboard gateway returned an invalid bootstrap URL.");
  }
  return raw;
}

async function handleFrameShellRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  dashboard: DashboardFrameTarget
): Promise<unknown> {
  const target = request.raw.url ?? request.url;
  // These routes run only after the gateway's cookie/origin checks and idle refresh.
  // Keep the otherwise static parent alive while its child dashboard is in use.
  if (request.method === "GET" && target === KEEPALIVE_PATH) {
    return reply.code(204).header("cache-control", "no-store").send();
  }
  if (request.method === "GET" && target === KEEPALIVE_SCRIPT_PATH) {
    return reply.header("cache-control", "no-store")
      .header("content-type", "application/javascript; charset=utf-8").send(KEEPALIVE_SCRIPT);
  }
  if ((request.method === "GET" || request.method === "HEAD") && target === "/") {
    reply.header("cache-control", "no-store");
    reply.header("content-type", "text/html; charset=utf-8");
    return request.method === "HEAD" ? reply.send() : reply.send(DASHBOARD_FRAME_DOCUMENT);
  }
  if (request.method === "GET" && target === DASHBOARD_FRAME_PATH) {
    try {
      return reply
        .code(303)
        .header("cache-control", "no-store")
        .header("location", exactDashboardBootstrap(dashboard))
        .send();
    } catch {
      return reply.code(503).send({ error: "RemoteUnavailable" });
    }
  }
  return reply.code(404).send({ error: "NotFound" });
}

export async function startRemoteDashboardFrameShell(
  options: StartRemoteDashboardFrameShellOptions
): Promise<RunningRemoteGateway> {
  return startRemoteGateway({
    updateActivity: options.updateActivity,
    hostname: options.dashboard.hostname,
    port: options.port ?? 0,
    surface: "frame_shell",
    frameChildOrigin: options.dashboard.origin,
    now: options.now,
    randomBytes: options.randomBytes,
    maxSessions: options.maxSessions,
    maxBootstrapTokens: options.maxBootstrapTokens,
    handleAuthenticatedRequest: (request, reply) => (
      handleFrameShellRequest(request, reply, options.dashboard)
    )
  });
}
