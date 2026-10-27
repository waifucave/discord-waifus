// `waifus wake | life | forget | usage | files | schedule | watches` (Living cast §14.2, §16.11): over
// the real API on a temp data root (Discord offline, so wakes queue and forget scrubs wait for each
// life's next start). The life log and her DM files leave DM content out unless --private; forget
// confirms or needs --yes and states the scrub limits.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { HomeStore, homeLimitsOf } from "../src/life/home/homeStore.js";
import { localMinuteText } from "../src/life/home/specialFiles.js";
import { appendLifeLog, updateLifeState } from "../src/life/lifeStore.js";
import { hostTimeZone } from "../src/orchestration/context/timeFormat.js";
import { AppConfigSchema } from "../src/shared/schemas/config.js";
import { FORGET_LIMITS } from "../src/shared/constants/forget.js";
import type { LifeLogLine } from "../src/shared/schemas/life.js";
import { cli, injectTransport, makeCliApp } from "./cliFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const AT = "2026-10-24T14:00:00.000Z";
const KEVIN = "300000000000000003";
const roots: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

const line = (seq: number, kind: LifeLogLine["kind"], turnId: string, message: Record<string, unknown>): LifeLogLine => ({ seq, at: AT, kind, turnId, message });

async function world() {
  const made = await makeCliApp(roots, apps);
  expect((await made.app.inject({ method: "POST", url: "/api/waifus", payload: { id: "ella", name: "Ella", displayName: "Ella" } })).statusCode).toBe(201);
  return { ...made, host: injectTransport(made.app) };
}

describe("waifus wake / life", () => {
  it("wakes her with a note (queued while Discord is offline)", async () => {
    const { root, host } = await world();
    const run = await cli(root, host, ["wake", "ella", "check", "the", "garden"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("queued");
    const status = JSON.parse((await cli(root, host, ["life", "ella", "--json"])).out) as { status: { queue: { wakes: Array<{ reason: string; note?: string }> } } };
    expect(status.status.queue.wakes).toEqual([expect.objectContaining({ reason: "owner", note: "check the garden" })]);
    expect((await cli(root, host, ["wake", "nobody"])).code).toBe(4);
    expect((await cli(root, host, ["wake"])).code).toBe(2);
  });

  it("prints status and the log with DM content left out unless --private", async () => {
    const { root, host, storage } = await world();
    await updateLifeState(storage, "ella", (state) => ({ ...state, epoch: 1, summary: "Kevin told me about his exam in DMs." }));
    await appendLifeLog(storage, "ella", 1, [
      line(0, "notifications", "t1", { role: "user", content: [{ type: "text", text: '<notifications>\n- dm · dm/kevin · from Kevin · "my exam is tomorrow"\n</notifications>' }] }),
      line(1, "assistant", "t1", { role: "assistant", content: [{ type: "text", text: "He sounds nervous." }, { type: "tool_use", id: "c1", name: "SendMessage", input: { place: "dm/kevin", text: "you've got this" } }] }),
      line(2, "tool_results", "t1", { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "sent #a1" }] }),
      line(3, "assistant", "t2", { role: "assistant", content: [{ type: "tool_use", id: "c2", name: "SendMessage", input: { place: "bake-club/#general", text: "lemon cake!" } }] })
    ]);
    const status = await cli(root, host, ["life", "ella"]);
    expect(status.code).toBe(0);
    expect(status.out).toContain("Ella (ella)");
    expect(status.out).toContain("summary:      hidden");
    expect(status.out).not.toContain("exam");

    const log = await cli(root, host, ["life", "ella", "--log", "--limit", "10"]);
    expect(log.code).toBe(0);
    expect(log.out).toContain("lemon cake!");
    expect(log.out).toContain("SendMessage(");
    expect(log.out).toContain("[private chat redacted]");
    for (const secret of ["exam", "you've got this", "nervous"]) expect(log.out).not.toContain(secret);

    const open = await cli(root, host, ["life", "ella", "--log", "--private"]);
    expect(open.out).toContain("exam");
    expect(open.out).toContain("you've got this");

    const json = await cli(root, host, ["life", "ella", "--log", "--json"]);
    expect(JSON.parse(json.out)).toMatchObject({ ok: true, status: { waifuId: "ella" }, log: { includePrivate: false } });
    expect((await cli(root, host, ["life", "ella", "--limit", "0"])).code).toBe(2);
  });
});

describe("waifus forget", () => {
  it("refuses without a terminal unless --yes, confirms on one, and states the scrub limits", async () => {
    const { root, host } = await world();
    const refused = await cli(root, host, ["forget", KEVIN]);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("--yes");

    const declined = await cli(root, host, ["forget", KEVIN], { ask: async () => "no" });
    expect(declined.code).toBe(2);
    expect(declined.err).toContain(FORGET_LIMITS[2]);
    expect(declined.err).toContain("Nothing was changed");

    const dry = await cli(root, host, ["forget", KEVIN, "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("Dry run");

    const confirmed = await cli(root, host, ["forget", KEVIN], { ask: async () => "forget" });
    expect(confirmed.code).toBe(0);
    expect(confirmed.out).toContain(`Forgot ${KEVIN}`);

    const yes = await cli(root, host, ["forget", KEVIN, "--yes", "--json"]);
    expect(yes.code).toBe(0);
    expect(JSON.parse(yes.out)).toMatchObject({ ok: true, discordUserId: KEVIN, limits: expect.stringContaining("best-effort") });
    expect((await cli(root, host, ["forget", "kevin", "--yes"])).code).toBe(2);
    expect((await cli(root, null, ["forget", KEVIN, "--yes"])).code).toBe(3);
  });
});

describe("waifus usage", () => {
  it("reads the ledger by local day, also with the host stopped", async () => {
    const { root } = await world();
    const entry = (at: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ at, purpose: "life", waifuId: "ella", providerId: "anthropic", modelId: "claude-haiku-5-5", status: "ok", usageKnown: true, inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, costUsd: 0.01, durationMs: 3, ...extra });
    await mkdir(path.join(root, "user", "usage"), { recursive: true });
    await writeFile(path.join(root, "user", "usage", "2026-10-24.jsonl"), `${[entry("2026-10-24T10:00:00.000Z"), entry("2026-10-24T11:00:00.000Z", { waifuId: "mina" })].join("\n")}\n`);
    const now = () => new Date("2026-10-24T20:00:00.000Z");
    const byDay = await cli(root, null, ["usage", "--tz", "UTC"], { now });
    expect(byDay.code).toBe(0);
    expect(byDay.out).toContain("2026-10-18 … 2026-10-24");
    expect(byDay.out).toMatch(/2026-10-24\s+2 calls\s+\$0\.0200/u);
    const json = JSON.parse((await cli(root, null, ["usage", "--tz", "UTC", "--by", "waifu", "--json"], { now })).out) as { groups: Array<{ key: string[]; calls: number }> };
    expect(json.groups.map((group) => group.key[0]).sort()).toEqual(["ella", "mina"]);
    expect((await cli(root, null, ["usage", "--by", "colour"], { now })).code).toBe(2);
    expect((await cli(root, null, ["usage", "--from", "yesterday"], { now })).code).toBe(2);
    expect((await cli(root, null, ["usage", "--tz", "Mars/Base"], { now })).code).toBe(2);
  });
});

describe("waifus files / schedule / watches", () => {
  it("lists her folders, prints a text file, and leaves a DM file unnamed unless --private", async () => {
    const { root, host, storage } = await world();
    const home = new HomeStore(storage, "ella", "ella", () => homeLimitsOf(AppConfigSchema.parse({}).life));
    await home.files.writeBytes(home.path("home", ["people", "kevin.md"]), Buffer.from("# Kevin\nlikes lemon cake\n"));
    await home.files.writeBytes(home.path("tmp", ["dm", "kevin", "a7-menu.txt"]), Buffer.from("secret brownies"));
    await home.files.writeBytes(home.path("tmp", ["bake-club", "general", "k3-cake.png"]), Buffer.from("89504e470d0a1a0a00", "hex"));

    const list = await cli(root, host, ["files", "ella"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain("~ (her home");
    expect(list.out).toContain("people/");
    const note = await cli(root, host, ["files", "ella", "people/kevin.md"]);
    expect(note.out).toBe("# Kevin\nlikes lemon cake");
    expect((await cli(root, host, ["files", "ella", "/home/ella/people"])).out).toContain("kevin.md");
    expect((await cli(root, host, ["files", "ella", "bake-club/general/k3-cake.png", "--root", "tmp"])).out).toContain("an image");

    const dm = await cli(root, host, ["files", "ella", "dm", "--root", "tmp"]);
    expect(dm.out).toContain("[private chat redacted]");
    expect(dm.out).not.toContain("kevin");
    const refused = await cli(root, host, ["files", "ella", "/tmp/dm/kevin/a7-menu.txt"]);
    expect(refused.code).toBe(4);
    expect(refused.err).not.toContain("brownies");
    expect((await cli(root, host, ["files", "ella", "/tmp/dm/kevin/a7-menu.txt", "--private"])).out).toBe("secret brownies");

    expect((await cli(root, host, ["files", "ella", "nothing.md"])).code).toBe(4);
    expect((await cli(root, host, ["files", "ella", "x", "--root", "etc"])).code).toBe(2);
    expect((await cli(root, null, ["files", "ella"])).code).toBe(3);
  });

  it("prints her reminders and watches, a DM-bound watch without its words unless --private", async () => {
    const { root, host, storage } = await world();
    const home = new HomeStore(storage, "ella", "ella", () => homeLimitsOf(AppConfigSchema.parse({}).life));
    const soon = localMinuteText(new Date(Date.now() + 2 * 3_600_000), hostTimeZone());
    expect((await cli(root, host, ["schedule", "ella"])).out).toContain("no reminders");
    await home.files.writeBytes(home.life("reminders.json"), Buffer.from(JSON.stringify([{ id: "r1", at: soon, repeat: "daily", note: "water the plants" }])));
    await home.files.writeBytes(home.life("watches.json"), Buffer.from(JSON.stringify([{ id: "w1", timeout: soon, once: true, note: "tea", when: [] }, { id: "w2", timeout: soon, once: true, note: "his exam", when: [{ place: "dm/kevin", words: ["exam"] }] }])));
    const schedule = await cli(root, host, ["schedule", "ella"]);
    expect(schedule.out).toMatch(/r1\s+.*\(daily\)\s+water the plants/u);
    const watches = await cli(root, host, ["watches", "ella"]);
    expect(watches.out).toContain("timer");
    expect(watches.out).toContain("[private chat redacted]");
    expect(watches.out).not.toContain("exam");
    expect((await cli(root, host, ["watches", "ella", "--private"])).out).toContain("his exam");
    expect(JSON.parse((await cli(root, host, ["watches", "ella", "--json"])).out)).toMatchObject({ ok: true, includePrivate: false });
  });
});
