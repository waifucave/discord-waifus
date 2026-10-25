// `waifus get | set | unset | list | help` (Living cast §14.2, overhaul §10.5): every writable key of
// the settings registry round-trips through the CLI and the real HTTP API (createApiServer on a temp
// data root; the CLI talks to it over app.inject). A key the registry gains without a working CLI and
// HTTP path fails here. Secrets never come from argv and never reach the output.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { HostRequest, HostTransport } from "../src/cli/hostClient.js";
import { ADAPTERS } from "../src/cli/settingsCommands.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { coerceValue, groupKeyInfos } from "../src/shared/settings/introspect.js";
import { acquireHostInstanceLock, hostInstanceState } from "../src/storage/instanceLock.js";
import type { KeyInfo } from "../src/shared/settings/types.js";
import { SETTING_GROUPS } from "../src/shared/settings/registry.js";
import { cli, injectTransport, makeCliApp } from "./cliFixtures.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const TARGETS: Record<string, string> = {
  app: "app",
  waifu: "waifu:aria",
  server: `server:${GUILD}`,
  channel: `channel:${GUILD}/${CHANNEL}`,
  assistant: "assistant",
  bot: "bot:house",
  provider: "provider:anthropic",
  "remote-access": "remote-access"
};

const roots: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

const makeApp = () => makeCliApp(roots, apps);

/** Keys whose example is their default and whose type gives no other value to try. */
const NON_DEFAULT: Record<string, string> = {
  "app.http.host": "127.0.0.2",
  "app.detector.target": "laya:english",
  "waifu.availability.sleep.start": "22:15",
  "waifu.availability.sleep.end": "06:45",
  "waifu.dm.rateLimit": '{"maxReplies":12,"windowMinutes":30}'
};

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A value for the key that is not its default (review: 65 of 92 examples were the default, so a
 * write the route dropped would still read back "right"): the example when it differs, else one the
 * key's type and bounds allow.
 */
function nonDefaultText(info: KeyInfo): string | undefined {
  const differs = (text: string | undefined) => {
    if (text === undefined) return false;
    const value = coerceValue(info, text);
    return value.ok && !sameJson(value.value, info.default);
  };
  const candidates: Array<string | undefined> = [NON_DEFAULT[info.id], info.example];
  if (info.type === "boolean") candidates.push(String(!(info.default ?? false)));
  if (info.type === "enum") candidates.push(...(info.enum ?? []));
  if (info.type === "integer" || info.type === "number") {
    const step = info.type === "integer" ? 1 : 0.5;
    const base = typeof info.default === "number" ? info.default : 0;
    for (const value of [info.max, info.min !== undefined ? info.min + step : undefined, info.min, base + step]) if (value !== undefined) candidates.push(String(value));
  }
  return candidates.find(differs);
}

/** Remote Access is helper-owned; a small in-memory stand-in with the real route's shapes. */
function remoteAccessTransport(inner: HostTransport): HostTransport {
  let config = { schemaVersion: 1, revision: "3", updatedAt: "2026-10-24T00:00:00.000Z", enabled: false, displayName: "Host" };
  return async (request) => {
    if (request.path !== "/api/remote-access") return inner(request);
    if (request.method === "GET") return { status: 200, body: { config }, text: "" };
    const body = request.body as { revision: string; enabled?: boolean; displayName?: string };
    if (body.revision !== config.revision) return { status: 409, body: { error: "Conflict", message: "stale" }, text: "" };
    config = { ...config, ...body, revision: String(Number(config.revision) + 1) };
    return body.enabled !== undefined ? { status: 202, body: { operationId: "op-1", status: "accepted", statusUrl: "/api/operations/op-1" }, text: "" } : { status: 200, body: config, text: "" };
  };
}

async function seed(app: FastifyInstance): Promise<void> {
  expect((await app.inject({ method: "POST", url: "/api/waifus", payload: { id: "aria", name: "Aria", displayName: "Aria" } })).statusCode).toBe(201);
  expect((await app.inject({ method: "PUT", url: `/api/servers/${GUILD}`, payload: { channels: { [CHANNEL]: { channelId: CHANNEL, enabled: true, enabledWaifuIds: ["aria"] } } } })).statusCode).toBe(200);
}

/**
 * The round-trip cases: each group's keys in parts of at most KEYS_PER_CASE. Each key costs two CLI
 * calls over the real API (about 25 ms alone); while the suite's WebAssembly-heavy Bash tests run in
 * other workers everything is several times slower, and the `app` group (over 100 keys since L4)
 * in one case passed its 60 s timeout.
 */
const KEYS_PER_CASE = 25;
const ROUND_TRIP_CASES = SETTING_GROUPS.flatMap((group) => {
  const count = groupKeyInfos(group).length;
  const parts = Math.max(1, Math.ceil(count / KEYS_PER_CASE));
  return Array.from({ length: parts }, (_, part) => ({ groupId: group.id, part, label: part + 1, parts }));
});

describe("waifus set/get round-trip over the real API", () => {
  it.each(ROUND_TRIP_CASES)("every writable key of group $groupId (part $label of $parts) is settable and readable through the CLI and HTTP, with a value other than its default", async ({ groupId, part }) => {
    const { app, root } = await makeApp();
    await seed(app);
    const host = remoteAccessTransport(injectTransport(app));
    // A provider's label rides along with its key; the key comes from the environment, never argv.
    expect((await cli(root, host, ["set", "provider:anthropic", "apiKey", "--from-env", "ANTHROPIC_TEST_KEY"], { env: { ANTHROPIC_TEST_KEY: "sk-ant-test-0123456789abcdef" } })).code).toBe(0);
    const failures: string[] = [];
    for (const group of SETTING_GROUPS.filter((candidate) => candidate.id === groupId)) {
      const target = TARGETS[group.id];
      expect(target, group.id).toBeDefined();
      expect(ADAPTERS[group.id], group.id).toBeDefined();
      for (const info of groupKeyInfos(group).slice(part * KEYS_PER_CASE, (part + 1) * KEYS_PER_CASE)) {
        if (info.flags.readOnly || info.flags.secret) continue;
        const text = nonDefaultText(info);
        if (text === undefined) {
          failures.push(`${info.id}: no value other than its default to write (add one to NON_DEFAULT)`);
          continue;
        }
        const expected = coerceValue(info, text);
        if (!expected.ok) {
          failures.push(`${info.id}: ${text} does not coerce`);
          continue;
        }
        const env = group.id === "provider" ? { KEY: "sk-ant-test-0123456789abcdef" } : undefined;
        const set = group.id === "provider"
          ? await cli(root, host, ["set", target!, "apiKey", `${info.path}=${text}`, "--from-env", "KEY"], { env: env! })
          : await cli(root, host, ["set", target!, info.path, text]);
        if (set.code !== 0) {
          failures.push(`${info.id}: set exited ${set.code}: ${set.err || set.out}`);
          continue;
        }
        const get = await cli(root, host, ["get", target!, info.path, "--json"]);
        if (get.code !== 0) {
          failures.push(`${info.id}: get exited ${get.code}: ${get.err || get.out}`);
          continue;
        }
        const value = (JSON.parse(get.out) as { value: unknown }).value;
        try {
          expect(value).toEqual(expected.value);
        } catch {
          failures.push(`${info.id}: read back ${JSON.stringify(value)}, expected ${JSON.stringify(expected.value)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);

  it("several KEY=VALUE pairs are one write; unset clears or restores the default; --json parses", async () => {
    const { app, root } = await makeApp();
    await seed(app);
    const log: HostRequest[] = [];
    const host = injectTransport(app, log);
    const set = await cli(root, host, ["set", "waifu:aria", "wakeOnName=false", "life.dailyBudgetUsd=2.5", "--json"]);
    expect(set.code).toBe(0);
    expect(JSON.parse(set.out)).toMatchObject({ ok: true, target: "waifu:aria", changed: ["wakeOnName", "life.dailyBudgetUsd"] });
    expect(log.filter((request) => request.method === "PUT")).toHaveLength(1);
    expect((log.find((request) => request.method === "PUT")!.body as { expectedRevision?: number; revision?: number })).toMatchObject({ wakeOnName: false, life: { dailyBudgetUsd: 2.5 } });

    expect((await cli(root, host, ["unset", "waifu:aria", "life.dailyBudgetUsd"])).code).toBe(0);
    const after = JSON.parse((await cli(root, host, ["get", "waifu:aria", "--json"])).out) as { values: Record<string, unknown> };
    expect(after.values["wakeOnName"]).toBe(false);
    expect(after.values["life.dailyBudgetUsd"] ?? null).toBeNull();

    const server = await cli(root, host, ["set", `server:${GUILD}`, "detector.target", "laya:english"]);
    expect(server.code).toBe(0);
    expect((await cli(root, host, ["unset", `server:${GUILD}`, "detector.target"])).code).toBe(0);
    const detector = JSON.parse((await cli(root, host, ["get", `server:${GUILD}`, "detector.target", "--json"])).out) as { value: unknown };
    expect(detector.value).toBeNull();
    // The channel kept its cast through the server writes.
    expect(JSON.parse((await cli(root, host, ["get", `channel:${GUILD}/${CHANNEL}`, "enabledWaifuIds", "--json"])).out)).toMatchObject({ value: ["aria"] });
  });

  it("dotted shorthand for singleton groups and human output", async () => {
    const { app, root } = await makeApp();
    const host = injectTransport(app);
    const set = await cli(root, host, ["set", "app.life.maxSendsPerTurn", "7"]);
    expect(set.code).toBe(0);
    expect(set.out).toContain("updated app");
    expect(set.out).toContain("life.maxSendsPerTurn = 7");
    expect((await cli(root, host, ["get", "app.life.maxSendsPerTurn"])).out).toBe("7");
    const all = await cli(root, host, ["get", "app"]);
    expect(all.out).toContain("life.maxSendsPerTurn = 7");
    const part = await cli(root, host, ["get", "app.search"]);
    expect(part.out).toContain("search.maxPerDay = ");
    expect(part.out).not.toContain("life.");
  });

  it("refuses bad input with exit 2 and a hint, and rejected writes with exit 4", async () => {
    const { app, root } = await makeApp();
    await seed(app);
    const host = injectTransport(app);
    const unknownKey = await cli(root, host, ["set", "app", "life.maxSendsPerTrun", "5"]);
    expect(unknownKey.code).toBe(2);
    expect(unknownKey.err).toContain("life.maxSendsPerTurn");
    expect((await cli(root, host, ["set", "app", "life.maxSendsPerTurn", "500"])).code).toBe(2);
    expect((await cli(root, host, ["set", "app", "life.maxSendsPerTurn", "lots"])).code).toBe(2);
    expect((await cli(root, host, ["set", "waifu:../x", "displayName", "X"])).code).toBe(2);
    expect((await cli(root, host, ["set", "nonsense", "x", "1"])).code).toBe(2);
    expect((await cli(root, host, ["set", "app", "life.maxSendsPerTurn", "5", "--bogus"])).code).toBe(2);
    expect((await cli(root, host, ["get", "waifu:nobody"])).code).toBe(4);
    const json = await cli(root, host, ["set", "app", "nope", "1", "--json"]);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.out)).toMatchObject({ ok: false, error: { message: expect.stringContaining("nope") } });
  });

  it("secrets never come from argv and never reach the output", async () => {
    const { app, root } = await makeApp();
    const host = injectTransport(app);
    const secret = "sk-ant-test-abcdefghijklmnop0123";
    const argv = await cli(root, host, ["set", "provider:anthropic", "apiKey", secret]);
    expect(argv.code).toBe(2);
    expect(argv.err).toContain("--from-env");
    // A secret-looking value in a non-secret key is refused too.
    expect((await cli(root, host, ["set", "provider:anthropic", "label", secret])).code).toBe(2);
    const fromStdin = await cli(root, host, ["set", "provider:anthropic", "apiKey", "--stdin"], { stdin: `${secret}\n` });
    expect(fromStdin.code).toBe(0);
    const read = await cli(root, host, ["get", "provider:anthropic"]);
    expect(read.out).toContain("apiKey = (set");
    for (const run of [argv, fromStdin, read]) expect(`${run.out}\n${run.err}`).not.toContain(secret);
    const prompted = await cli(root, host, ["set", "bot:house", "token"], { ask: async (_question, o) => (o?.hidden ? "MTAx.secret-token-value" : "") });
    expect(prompted.code).toBe(0);
    expect(prompted.out).not.toContain("secret-token-value");
    const bots = JSON.parse((await app.inject({ method: "GET", url: "/api/discord-bots" })).body) as { orchestrator: { tokenConfigured: boolean } };
    expect(bots.orchestrator.tokenConfigured).toBe(true);
    // Removing a key asks first: refused without a terminal, kept on a wrong answer (review).
    const noTerminal = await cli(root, host, ["unset", "provider:anthropic", "apiKey"]);
    expect(noTerminal.code).toBe(2);
    expect(noTerminal.err).toContain("--yes");
    const declined = await cli(root, host, ["unset", "provider:anthropic", "apiKey"], { ask: async () => "no" });
    expect(declined.code).toBe(2);
    expect(declined.err).toContain("Nothing was changed.");
    expect((await cli(root, host, ["get", "provider:anthropic", "apiKey"])).out).toContain("(set");
    const confirmed = await cli(root, host, ["unset", "provider:anthropic", "apiKey"], { ask: async (question) => (question.includes("anthropic") ? "remove" : "") });
    expect(confirmed.code).toBe(0);
    expect((await cli(root, host, ["get", "provider:anthropic", "apiKey"])).out).toBe("(not set)");
    expect((await cli(root, host, ["set", "provider:anthropic", "apiKey", "--stdin"], { stdin: `${secret}\n` })).code).toBe(0);
    expect((await cli(root, host, ["unset", "provider:anthropic", "apiKey", "--yes"])).code).toBe(0);
    expect((await cli(root, host, ["get", "provider:anthropic", "apiKey"])).out).toBe("(not set)");
  });

  it("a conflicting write is re-read and retried; a persisting conflict exits 5", async () => {
    const { app, root } = await makeApp();
    await seed(app);
    const inner = injectTransport(app);
    let conflicts = 1;
    const flaky: HostTransport = async (request) => {
      if (request.method === "PUT" && conflicts > 0) {
        conflicts -= 1;
        await app.inject({ method: "PUT", url: "/api/waifus/aria", payload: { revision: ((await inner({ method: "GET", path: "/api/waifus/aria" })).body as { revision: number }).revision, displayName: "Someone else" } });
      }
      return inner(request);
    };
    expect((await cli(root, flaky, ["set", "waifu:aria", "persona", "Bright."])).code).toBe(0);
    const read = JSON.parse((await cli(root, inner, ["get", "waifu:aria", "--json"])).out) as { values: Record<string, unknown> };
    expect(read.values).toMatchObject({ persona: "Bright.", displayName: "Someone else" });
    const always: HostTransport = async (request) => (request.method === "PUT" ? { status: 409, body: { error: "Conflict", message: "revision mismatch" }, text: "" } : inner(request));
    expect((await cli(root, always, ["set", "waifu:aria", "persona", "Again."])).code).toBe(5);
  });

  it("with the host stopped: app keys read and write config.toml; everything else exits 3", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    const set = await cli(root, null, ["set", "app", "life.maxSendsPerTurn", "9"]);
    expect(set.code).toBe(0);
    const toml = await readFile(path.join(root, "config.toml"), "utf8");
    expect(toml).toMatch(/maxSendsPerTurn = 9/u);
    if (process.platform !== "win32") expect((await stat(path.join(root, "config.toml"))).mode & 0o777).toBe(0o600);
    expect((await cli(root, null, ["get", "app.life.maxSendsPerTurn"])).out).toBe("9");
    expect((await cli(root, null, ["set", "app", "updates.enabled", "true"])).code).toBe(2);
    const waifu = await cli(root, null, ["get", "waifu:aria"]);
    expect(waifu.code).toBe(3);
    expect(waifu.err).toContain("waifus start");
    expect((await cli(root, null, ["wake", "aria"])).code).toBe(3);
    // The offline write holds the host lock while it writes: never while a host holds it (review).
    expect(await hostInstanceState(root)).toEqual({ state: "absent" });
    const held = await acquireHostInstanceLock(root);
    try {
      const busy = await cli(root, null, ["set", "app", "life.maxSendsPerTurn", "4"]);
      expect(busy.code).toBe(3);
      expect(busy.err).toContain("try again");
      expect(await readFile(path.join(root, "config.toml"), "utf8")).toMatch(/maxSendsPerTurn = 9/u);
    } finally {
      await held.release();
    }
  });

  it("list shows groups and keys; help resolves topics offline and unknown ones exit 2", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const groups = await cli(root, null, ["list"]);
    expect(groups.code).toBe(0);
    for (const group of SETTING_GROUPS) expect(groups.out).toContain(group.id);
    const app = await cli(root, null, ["list", "app"]);
    expect(app.out).toContain("life.maxSendsPerTurn");
    const help = await cli(root, null, ["help", "life.maxSendsPerTurn"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("waifus set app life.maxSendsPerTurn");
    const unknown = await cli(root, null, ["help", "lif.maxSendsPerTurn"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("Did you mean");
    expect((await cli(root, null, ["frobnicate"])).code).toBe(2);
    expect((await cli(root, null, ["life", "--help"])).out).toContain("waifus life WAIFU");
  });
});

describe("CLI modules", () => {
  it("never load the host statically (help, get and set start without Fastify or Discord)", async () => {
    const { readdir } = await import("node:fs/promises");
    const dir = path.join(process.cwd(), "src", "cli");
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".ts")) continue;
      const text = await readFile(path.join(dir, file), "utf8");
      expect(text, file).not.toMatch(/^import [^;]*from "\.\.\/backend\/server\.js";/mu);
      expect(text, file).not.toMatch(/^import [^;]*from "\.\.\/api\/server\.js";/mu);
    }
  });
});
