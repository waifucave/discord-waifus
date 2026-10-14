import { request } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { startRemoteGateway, type RunningRemoteGateway } from "../src/remote/gateway/server.js";
import { BrowserProofStore, browserKeyId } from "../src/remote/gateway/browserProof.js";
import { browserPersistence } from "../src/remote/gateway/browserPersistence.js";
import { ensureRemoteOnlyLayout } from "../src/config/layout.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const gateways: RunningRemoteGateway[] = [];
const hostname = "waifus-" + "a".repeat(52) + ".localhost";
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(g => g.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});
async function send(g: RunningRemoteGateway, target: string, headers: Record<string, string> = {}, method = "GET", body?: unknown) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: g.port, path: target, method,
      headers: { host: new URL(g.origin).host, ...(body ? { "content-type": "application/json" } : {}), ...headers } }, res => {
      let text = ""; res.on("data", b => { text += b; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
    });
    req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function root() {
  const value = await makeTempRoot("waifus-browser-restart-"); roots.push(value);
  await ensureRemoteOnlyLayout(value); return value;
}
async function start(dataRoot: string, port = 0, scope = "host-epoch-1") {
  const g = await startRemoteGateway({ hostname, port, surface: "frame_shell",
    frameChildOrigin: "http://" + hostname + ":12345", browserPersistence: browserPersistence(dataRoot, scope),
    handleAuthenticatedRequest: (_request, _reply, context, security) => {
      security.deliverCsrf(); return { launch: context.gatewayLaunchId, browser: context.browserSessionId };
    } });
  gateways.push(g); return g;
}
function key() {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = keys.publicKey.export({ format: "jwk" });
  const publicKey = { kty: "EC" as const, crv: "P-256" as const, x: jwk.x!, y: jwk.y! };
  return { publicKey, keyId: browserKeyId(publicKey), privateKey: keys.privateKey };
}
const envelope = (g: RunningRemoteGateway) => ({ origin: g.origin, "sec-fetch-site": "same-origin" });
async function register(g: RunningRemoteGateway, keys: ReturnType<typeof key>, expected = 200) {
  const boot = await send(g, new URL(g.bootstrapUrl).pathname, { "sec-fetch-site": "none" });
  expect(boot.status).toBe(303);
  const cookie = String(boot.headers["set-cookie"]).split(";", 1)[0];
  const before = await send(g, "/api/health", { cookie, ...envelope(g) });
  expect(before.status).toBe(200);
  const csrf = String(before.headers["x-waifus-csrf"]);
  expect((await send(g, "/_waifus_remote/browser-register", { cookie, ...envelope(g) }, "POST", { publicKey: keys.publicKey })).status).toBe(403);
  const saved = await send(g, "/_waifus_remote/browser-register", { cookie, ...envelope(g), "x-waifus-csrf": csrf }, "POST", { publicKey: keys.publicKey });
  expect(saved.status).toBe(expected);
  return { cookie, csrf, before };
}
async function proof(g: RunningRemoteGateway, keys: ReturnType<typeof key>) {
  const response = await send(g, "/_waifus_remote/browser-challenge/" + keys.keyId, envelope(g));
  expect(response.status).toBe(200);
  const { challenge } = JSON.parse(response.body);
  const signature = sign("sha256", Buffer.from(challenge), { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return { keyId: keys.keyId, challenge, signature };
}
it("rejects old cookies and bootstrap links; a fresh one-use key proof restores a new session", async () => {
  const dataRoot = await root(); const keys = key(); const first = await start(dataRoot);
  const unused = new URL(first.issueBootstrapUrl()).pathname;
  const before = await register(first, keys); await first.close();
  const second = await start(dataRoot, first.port);
  expect(second.origin).toBe(first.origin); expect(second.gatewayLaunchId).not.toBe(first.gatewayLaunchId);
  expect((await send(second, "/api/health", { cookie: before.cookie, ...envelope(second) })).status).toBe(403);
  expect((await send(second, unused)).status).toBe(404);
  const signed = await proof(second, keys);
  expect((await send(second, "/_waifus_remote/browser-resume", { origin: "https://evil.invalid" }, "POST", signed)).status).toBe(403);
  const resumed = await send(second, "/_waifus_remote/browser-resume", envelope(second), "POST", signed);
  expect(resumed.status).toBe(204);
  const cookie = String(resumed.headers["set-cookie"]).split(";", 1)[0];
  const after = await send(second, "/api/health", { cookie, ...envelope(second) });
  expect(after.status).toBe(200); expect(JSON.parse(after.body).launch).toBe(second.gatewayLaunchId);
  expect(JSON.parse(after.body).browser).not.toBe(JSON.parse(before.before.body).browser);
  expect(after.headers["x-waifus-csrf"]).not.toBe(before.csrf);
  expect((await send(second, "/_waifus_remote/browser-resume", envelope(second), "POST", signed)).status).toBe(403);
  await second.invalidateBrowserSessions();
  expect((await send(second, "/api/health", { cookie, ...envelope(second) })).status).toBe(403);
  await second.close(); const third = await start(dataRoot, first.port);
  expect((await send(third, "/_waifus_remote/browser-challenge/" + keys.keyId, envelope(third))).status).toBe(403);
});
it("never migrates reconnect keys across host trust scopes", async () => {
  const dataRoot = await root(); const keys = key(); const first = await start(dataRoot);
  await register(first, keys); await first.close(); const second = await start(dataRoot, first.port, "host-epoch-2");
  expect((await send(second, "/_waifus_remote/browser-challenge/" + keys.keyId, envelope(second))).status).toBe(403);
});
it.skipIf(process.platform === "win32")("stores public keys only and rejects unsafe saved-file permissions", async () => {
  const dataRoot = await root(); const first = await start(dataRoot); const keys = key();
  const { cookie, csrf } = await register(first, keys); await first.close();
  const dir = path.join(dataRoot, "app/remote-gateway/browser-sessions");
  const names = await readdir(dir); expect(names).toHaveLength(1);
  const target = path.join(dir, names[0]); const saved = await readFile(target, "utf8");
  expect(saved).toContain(keys.publicKey.x);
  for (const secret of [cookie.split("=", 2)[1], csrf, first.gatewayLaunchId, "privateKey", '"d":']) expect(saved).not.toContain(secret);
  await chmod(target, 0o644);
  await expect(start(dataRoot, first.port)).rejects.toThrow("Untrusted browser-session state");
});
it("does not retain recovery authority if its public-key record cannot be saved", async () => {
  const g = await startRemoteGateway({ hostname, port: 0, surface: "frame_shell", frameChildOrigin: "http://" + hostname + ":12345",
    browserPersistence: { load: async () => undefined, clear: async () => {}, save: async () => { throw Error("disk failed"); } },
    handleAuthenticatedRequest: (_r, _p, _c, security) => { security.deliverCsrf(); return {}; } });
  gateways.push(g); const keys = key(); await register(g, keys, 503);
  expect((await send(g, "/_waifus_remote/browser-challenge/" + keys.keyId, envelope(g))).status).toBe(403);
});
it("rejects wrong-key, expired and replayed signatures; bounds concurrent tab challenges", () => {
  let now = 0; const store = new BrowserProofStore(() => now); const keys = key(); const other = key();
  store.register(keys.publicKey); store.register(other.publicKey);
  const signProof = (challenge: string, signer = keys) => ({ keyId: keys.keyId, challenge,
    signature: sign("sha256", Buffer.from(challenge), { key: signer.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") });
  const bad = store.challenge(keys.keyId)!; expect(store.consume(signProof(bad, other))).toBe(false);
  expect(store.consume(signProof(bad))).toBe(false);
  const expired = store.challenge(keys.keyId)!; now = 30_000; expect(store.consume(signProof(expired))).toBe(false);
  const valid = store.challenge(keys.keyId)!; expect(store.consume(signProof(valid))).toBe(true);
  expect(store.consume(signProof(valid))).toBe(false);
  const parallel = store.challenge(keys.keyId)!; store.challenge(keys.keyId); expect(store.consume(signProof(parallel))).toBe(true);
  for (let i = 0; i < 31; i++) expect(store.challenge(keys.keyId)).toBeDefined();
  expect(store.challenge(keys.keyId)).toBeUndefined();
  expect(store.challenge("a".repeat(64))).toBeUndefined();
});
