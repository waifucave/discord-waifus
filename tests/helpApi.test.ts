// The help API (overhaul spec §10.4, Living cast §14.2): every manifest route has a summary, every
// group, key, topic and command resolves, unknown topics suggest close ones, Markdown on request,
// and help payloads survive the API's secret redaction.
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApiServer } from "../src/api/server.js";
import { dispatchInternal } from "../src/api/internalDispatch.js";
import { createRemoteRequestPrincipal } from "../src/api/requestPrincipal.js";
import { ROUTE_HELP } from "../src/api/routeHelp.js";
import { ROUTE_POLICY_MANIFEST } from "../src/api/routePolicyManifest.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { COMMANDS } from "../src/shared/settings/commands.js";
import { allKeyInfos } from "../src/shared/settings/introspect.js";
import { RESOURCE_TOPICS, SETTING_GROUPS } from "../src/shared/settings/registry.js";
import { resolveTopic, suggestTopics, topicNames } from "../src/shared/settings/topics.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

async function makeApp(): Promise<FastifyInstance> {
  const root = await makeTempRoot("waifus-help-");
  roots.push(root);
  await ensureDataLayout(root);
  const app = await createApiServer({
    dataRoot: root,
    storage: new StorageService(root),
    runtime: createRuntimeState({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      packageVersion: "3.0.0-test",
      port: 3888,
      dataRoot: root,
      mode: "test",
      paused: false,
      discord: { connected: false, houseConnected: false, waifuBotCount: 0, warnings: [] },
      queues: { active: 0, configuredGuilds: 0 }
    }),
    remoteTrust: { isAuthorized: () => true }
  });
  apps.push(app);
  return app;
}

describe("route help", () => {
  it("has exactly one summary and a resolvable topic for every manifest route", () => {
    const inventory = ROUTE_POLICY_MANIFEST.filter((route) => !route.synthetic).map((route) => `${route.method} ${route.path}`).sort();
    expect(Object.keys(ROUTE_HELP).sort()).toEqual(inventory);
    for (const [route, help] of Object.entries(ROUTE_HELP)) {
      expect(help.summary.length, route).toBeGreaterThan(5);
      expect(resolveTopic(help.topic), `${route} → ${help.topic}`).toBeDefined();
    }
  });
});

describe("help topics", () => {
  it("resolves every group, key, part of a group, resource topic and command", () => {
    for (const group of SETTING_GROUPS) expect(resolveTopic(group.id)).toMatchObject({ kind: "group" });
    for (const info of allKeyInfos()) expect(resolveTopic(info.id), info.id).toMatchObject({ kind: "key", key: { id: info.id } });
    for (const topic of RESOURCE_TOPICS) expect(resolveTopic(topic.id)).toMatchObject({ kind: "resource" });
    for (const command of COMMANDS) expect(resolveTopic(`cli.${command.name}`)).toMatchObject({ kind: "command" });
    expect(resolveTopic("life.maxSendsPerTurn")).toMatchObject({ kind: "key", key: { id: "app.life.maxSendsPerTurn" } });
    expect(resolveTopic("app.life")).toMatchObject({ kind: "subtree" });
    expect(resolveTopic("life")).toMatchObject({ kind: "resource" });
    expect(resolveTopic("wake")).toMatchObject({ kind: "command" });
    for (const name of topicNames()) expect(resolveTopic(name), name).toBeDefined();
    expect(resolveTopic("nonsense.key")).toBeUndefined();
    expect(suggestTopics("waifu.dm.limitNotise")).toContain("waifu.dm.limitNotice");
  });
});

describe("GET /api/help", () => {
  it("lists every manifest route with a summary, the groups, topics and commands", async () => {
    const app = await makeApp();
    const index = (await app.inject({ method: "GET", url: "/api/help" })).json();
    expect(index.version).toBe(1);
    expect(index.routes).toHaveLength(ROUTE_POLICY_MANIFEST.filter((route) => !route.synthetic).length);
    for (const route of index.routes) expect(route.summary, route.path).not.toBe("");
    expect(index.groups.map((group: { id: string }) => group.id)).toEqual(SETTING_GROUPS.map((group) => group.id));
    expect(index.commands.map((command: { name: string }) => command.name)).toContain("wake");
  });

  it("answers a group with typed keys, a key, Markdown, and a 404 with suggestions", async () => {
    const app = await makeApp();
    const group = (await app.inject({ method: "GET", url: "/api/help/app" })).json();
    const sends = group.keys.find((key: { path: string }) => key.path === "life.maxSendsPerTurn");
    expect(sends).toMatchObject({ type: "integer", min: 1, max: 50, default: 15, applies: "reload" });
    expect(sends.cli).toContain("waifus set app life.maxSendsPerTurn 15");
    const provider = (await app.inject({ method: "GET", url: "/api/help/provider.apiKey" })).json();
    expect(provider).toMatchObject({ kind: "key", key: { flags: ["secret"], path: "apiKey" } });
    expect(JSON.stringify(provider)).not.toContain("[REDACTED]");
    const markdown = await app.inject({ method: "GET", url: "/api/help/waifu.dm.limitNotice?format=md" });
    expect(markdown.headers["content-type"]).toMatch(/text\/markdown/u);
    expect(markdown.body).toContain("# waifu.dm.limitNotice");
    const missing = await app.inject({ method: "GET", url: "/api/help/life.maxSendsPerTrun" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().details.suggestions).toContain("app.life.maxSendsPerTurn");
  });

  it("is readable by a paired remote device, and no help payload loses text to redaction", async () => {
    const app = await makeApp();
    const remote = createRemoteRequestPrincipal({
      kind: "remote_device",
      stableId: "remote:travel-mac",
      deviceId: "travel-mac",
      peerFingerprint: Buffer.alloc(16, 0x21).toString("base64url"),
      transportSessionId: Buffer.alloc(16, 0x22).toString("base64url"),
      trustEpoch: "9"
    });
    for (const topic of [...SETTING_GROUPS.map((group) => group.id), ...RESOURCE_TOPICS.map((entry) => entry.id), "cli.set"]) {
      const response = await dispatchInternal(app, remote, undefined, { method: "GET", url: `/api/help/${topic}` });
      expect(response.statusCode, topic).toBe(200);
      expect(response.body, topic).not.toContain("[REDACTED]");
    }
  });
});
