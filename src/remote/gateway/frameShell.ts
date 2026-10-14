import type { FastifyReply, FastifyRequest } from "fastify";
import {
  startRemoteGateway,
  type RunningRemoteGateway
} from "./server.js";
import type { RemoteGatewayHandlerSecurity } from "./server.js";
import type { RemoteBrowserSessionStoreOptions } from "./session.js";
import type { RemoteBrowserContextV1 } from "../../shared/schemas/remoteProtocol.js";
import { browserPersistence } from "./browserPersistence.js";
import { frameEndpoint } from "./frameEndpoint.js";

const DASHBOARD_FRAME_PATH = "/_waifus_remote/frame";
const KEEPALIVE_PATH = "/_waifus_remote/frame-keepalive";
const KEEPALIVE_SCRIPT_PATH = "/_waifus_remote/frame-session.js";
const KEEPALIVE_SCRIPT = `(() => {
  let pending = false;
  let expired = false;
  let generation = document.currentScript.dataset.launch;
  let registered = false;
  let stored;
  async function keyRecord(create) {
    if (stored) return stored;
    if (!globalThis.indexedDB || !globalThis.crypto?.subtle) return;
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open("waifus-browser-recovery", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("keys");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      stored = await new Promise((resolve, reject) => {
        const tx = db.transaction("keys", "readonly");
        const get = tx.objectStore("keys").get("dashboard");
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      });
      if (!stored && create) {
        const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
        const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
        stored = { privateKey: keys.privateKey, publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
        await new Promise((resolve, reject) => {
          const tx = db.transaction("keys", "readwrite");
          tx.objectStore("keys").put(stored, "dashboard");
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      }
      return stored;
    } finally { db.close(); }
  }
  async function register(csrf) {
    if (registered || !csrf) return;
    const record = await keyRecord(true);
    if (!record) return;
    const response = await fetch("/_waifus_remote/browser-register", {
      method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { "content-type": "application/json", "x-waifus-csrf": csrf },
      body: JSON.stringify({ publicKey: record.publicKey }), signal: AbortSignal.timeout(10000)
    });
    if (response.ok) { record.keyId = (await response.json()).keyId; registered = true; }
  }
  async function resume() {
    const record = await keyRecord(false);
    if (!record) return false;
    // Derive the public identifier locally; the private key is never exported.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(record.publicKey)));
    const keyId = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    const response = await fetch("/_waifus_remote/browser-challenge/" + keyId, {
      credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) { if (response.status === 403) return false; throw Error("Unavailable"); }
    const challenge = (await response.json()).challenge;
    const bytes = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, record.privateKey, new TextEncoder().encode(challenge));
    const signature = btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
    const result = await fetch("/_waifus_remote/browser-resume", {
      method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ keyId, challenge, signature }),
      signal: AbortSignal.timeout(10000)
    });
    if (!result.ok && result.status !== 403) throw Error("Unavailable");
    return result.ok;
  }
  async function refresh() {
    if (pending || expired) return;
    pending = true;
    try {
      let recovered = false;
      let response = await fetch("${KEEPALIVE_PATH}", {
        credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(10000)
      });
      if (response.status === 403) {
        if (await resume()) {
          recovered = true;
          response = await fetch("${KEEPALIVE_PATH}", { credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000) });
        }
      }
      if (response.status === 403) {
        expired = true;
        clearInterval(timer);
        document.body.textContent = "This browser session is no longer valid. Run waifus remote again to reopen your saved host. No new pairing is needed.";
      }
      if (response.ok) await register(response.headers.get("x-waifus-csrf"));
      if (response.ok && response.headers.get("x-waifus-direct") === "1") {
        const current = response.headers.get("x-waifus-instance");
        if (current && (current !== generation || recovered)) {
          generation = current;
          document.querySelector("iframe").src = "${DASHBOARD_FRAME_PATH}";
        }
      }
    } catch { /* Retry transient network failures on the next tick. */ }
    finally { pending = false; }
  }
  const timer = setInterval(refresh, 2000);
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
    <script src="${KEEPALIVE_SCRIPT_PATH}" data-launch="__LAUNCH__" defer></script>
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
  dataRoot?: string;
  isDirect?: () => boolean;
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
  dashboard: DashboardFrameTarget,
  context: RemoteBrowserContextV1,
  isDirect: () => boolean,
  security: RemoteGatewayHandlerSecurity
): Promise<unknown> {
  const target = request.raw.url ?? request.url;
  // These routes run only after the gateway's cookie/origin checks and idle refresh.
  // Keep the otherwise static parent alive while its child dashboard is in use.
  if (request.method === "GET" && target === KEEPALIVE_PATH) {
    security.deliverCsrf();
    return reply.code(204).header("cache-control", "no-store")
      .header("x-waifus-instance", context.gatewayLaunchId).header("x-waifus-direct", isDirect() ? "1" : "0").send();
  }
  if (request.method === "GET" && target === KEEPALIVE_SCRIPT_PATH) {
    return reply.header("cache-control", "no-store")
      .header("content-type", "application/javascript; charset=utf-8").send(KEEPALIVE_SCRIPT);
  }
  if ((request.method === "GET" || request.method === "HEAD") && target === "/") {
    reply.header("cache-control", "no-store");
    reply.header("content-type", "text/html; charset=utf-8");
    return request.method === "HEAD" ? reply.send() : reply.send(DASHBOARD_FRAME_DOCUMENT.replace("__LAUNCH__", context.gatewayLaunchId));
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
  const endpoint = options.dataRoot ? frameEndpoint(options.dataRoot, options.dashboard.origin) : undefined;
  const savedPort = await endpoint?.load();
  // Public static UI lets a freshly reloaded tab prove its key before acquiring a new cookie.
  // No host content, bootstrap token, session, or CSRF secret is included here.
  const publicFrame = options.dataRoot ? (target: string) => target === "/"
    ? { type: "text/html; charset=utf-8", body: DASHBOARD_FRAME_DOCUMENT.replace("__LAUNCH__", "") }
    : { type: "application/javascript; charset=utf-8", body: KEEPALIVE_SCRIPT } : undefined;
  const gateway = await startRemoteGateway({
    updateActivity: options.updateActivity,
    hostname: options.dashboard.hostname,
    port: options.port ?? savedPort ?? 0,
    surface: "frame_shell",
    frameChildOrigin: options.dashboard.origin,
    now: options.now,
    randomBytes: options.randomBytes,
    maxSessions: options.maxSessions,
    maxBootstrapTokens: options.maxBootstrapTokens,
    browserPersistence: options.dataRoot ? browserPersistence(options.dataRoot, `frame:${options.dashboard.origin}`) : undefined,
    handlePublicFrameRequest: publicFrame,
    handleAuthenticatedRequest: (request, reply, context, security) => (
      handleFrameShellRequest(request, reply, options.dashboard, context, options.isDirect ?? (() => true), security)
    )
  });
  try { await endpoint?.save(gateway.port); }
  catch (error) { await gateway.close(); throw error; }
  return gateway;
}
