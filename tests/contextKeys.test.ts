import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDataPath } from "../src/config/paths.js";
import {
  compareSnowflakes,
  contextAgentId,
  contextStatePath,
  conversationKey,
  conversationLedgerPath,
  conversationRefsPath,
  parseConversationKey,
  promptCacheKey,
  type ConversationKey,
  type ConversationRef
} from "../src/orchestration/context/keys.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const GUILD = "323456789012345678";
const CHANNEL = "423456789012345678";
const USER = "523456789012345678";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots.length = 0;
});

describe("conversation keys", () => {
  it("encodes guild and DM conversations", () => {
    expect(conversationKey({ kind: "guild", guildId: GUILD, channelId: CHANNEL })).toBe(`g_${GUILD}_${CHANNEL}`);
    expect(conversationKey({ kind: "dm", userId: USER, waifuId: "aria" })).toBe(`dm_${USER}_aria`);
  });

  it("round-trips, including waifu ids that contain underscores, dots and colons", () => {
    const refs: ConversationRef[] = [
      { kind: "guild", guildId: GUILD, channelId: CHANNEL },
      { kind: "dm", userId: USER, waifuId: "aria" },
      { kind: "dm", userId: USER, waifuId: "mei_chan.v2:alt-1" }
    ];
    for (const ref of refs) {
      expect(parseConversationKey(conversationKey(ref))).toEqual(ref);
    }
  });

  it("refuses ids that would break the encoding", () => {
    expect(() => conversationKey({ kind: "guild", guildId: "a_b", channelId: CHANNEL })).toThrow();
    expect(() => conversationKey({ kind: "guild", guildId: GUILD, channelId: "../x" })).toThrow();
    expect(() => conversationKey({ kind: "dm", userId: "u_1", waifuId: "aria" })).toThrow();
    expect(() => conversationKey({ kind: "dm", userId: USER, waifuId: ".." })).toThrow();
    expect(() => conversationKey({ kind: "dm", userId: USER, waifuId: "a/b" })).toThrow();
  });

  it("parses only well-formed keys", () => {
    for (const bad of ["", "g_1", "g__2", "g_1_2_3", "x_1_2", "dm_1", "dm_1_", "dm_1_../x", "dm_1_a/b", "dm_1_.."]) {
      expect(parseConversationKey(bad), bad).toBeUndefined();
    }
  });
});

describe("context agents and cache keys", () => {
  const key = conversationKey({ kind: "guild", guildId: GUILD, channelId: CHANNEL });

  it("names agents", () => {
    expect(contextAgentId({ kind: "waifu", waifuId: "aria" })).toBe("waifu-aria");
    expect(contextAgentId({ kind: "orchestrator" })).toBe("orchestrator");
    expect(contextAgentId({ kind: "stage-manager" })).toBe("stage-manager");
    expect(() => contextAgentId({ kind: "waifu", waifuId: "../evil" })).toThrow();
  });

  it("builds prompt cache keys", () => {
    expect(promptCacheKey(key, { kind: "waifu", waifuId: "aria" })).toBe(`waifu:aria:${key}`);
    expect(promptCacheKey(key, { kind: "orchestrator" })).toBe(`orchestrator:${key}`);
    expect(promptCacheKey(key, { kind: "stage-manager" })).toBe(`stage-manager:${key}`);
  });
});

describe("conversation paths", () => {
  const key = conversationKey({ kind: "guild", guildId: GUILD, channelId: CHANNEL });
  const dmKey = conversationKey({ kind: "dm", userId: USER, waifuId: "aria" });

  it("lays out files under user/conversations/<key>/", () => {
    const base = path.join("user", "conversations", key);
    expect(contextStatePath(key, { kind: "waifu", waifuId: "aria" })).toBe(
      path.join(base, "contexts", "waifu-aria.json")
    );
    expect(contextStatePath(key, { kind: "orchestrator" })).toBe(path.join(base, "contexts", "orchestrator.json"));
    expect(conversationRefsPath(key)).toBe(path.join(base, "refs.json"));
    expect(conversationLedgerPath(dmKey)).toBe(path.join("user", "conversations", dmKey, "ledger.json"));
  });

  it("rejects forged keys and agents that would escape the data root", () => {
    for (const forged of ["../../../etc", "g_1_2/../../x", "dm_1_../../x", ""]) {
      expect(() => conversationRefsPath(forged as ConversationKey), forged).toThrow();
      expect(() => conversationLedgerPath(forged as ConversationKey), forged).toThrow();
      expect(() => contextStatePath(forged as ConversationKey, { kind: "orchestrator" }), forged).toThrow();
      expect(() => promptCacheKey(forged as ConversationKey, { kind: "orchestrator" }), forged).toThrow();
    }
    expect(() => contextStatePath(key, { kind: "waifu", waifuId: "../../x" })).toThrow();
  });

  it("stays inside a real data root and is usable for file IO", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const relative = contextStatePath(dmKey, { kind: "waifu", waifuId: "aria" });
    const absolute = resolveDataPath(root, relative);
    expect(path.relative(root, absolute).startsWith("..")).toBe(false);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, "{}", "utf8");
    expect(await readFile(absolute, "utf8")).toBe("{}");
  });
});

describe("compareSnowflakes", () => {
  it("compares numerically, not lexically", () => {
    expect(compareSnowflakes("9", "10")).toBeLessThan(0);
    expect(compareSnowflakes("10", "9")).toBeGreaterThan(0);
    expect(compareSnowflakes("123", "123")).toBe(0);
  });

  it("is exact beyond Number.MAX_SAFE_INTEGER", () => {
    expect(compareSnowflakes("1100000000000000001", "1100000000000000000")).toBeGreaterThan(0);
    expect(compareSnowflakes("1100000000000000000", "1100000000000000001")).toBeLessThan(0);
    expect(compareSnowflakes("900000000000000000", "1000000000000000000")).toBeLessThan(0);
  });

  it("sorts message ids in order of creation", () => {
    const ids = ["1300000000000000002", "999999999999999999", "1300000000000000001"];
    expect([...ids].sort(compareSnowflakes)).toEqual([
      "999999999999999999",
      "1300000000000000001",
      "1300000000000000002"
    ]);
  });

  it("rejects non-numeric input instead of guessing", () => {
    expect(() => compareSnowflakes("abc", "1")).toThrow(TypeError);
    expect(() => compareSnowflakes("1", "")).toThrow(TypeError);
  });
});
