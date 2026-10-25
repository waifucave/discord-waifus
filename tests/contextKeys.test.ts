import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDataPath } from "../src/config/paths.js";
import {
  compareSnowflakes,
  conversationDirPath,
  conversationKey,
  conversationRefsPath,
  parseConversationKey,
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
    expect(conversationKey({ kind: "dm", userId: USER, waifuId: "ella" })).toBe(`dm_${USER}_ella`);
  });

  it("round-trips, including waifu ids that contain underscores, dots and colons", () => {
    const refs: ConversationRef[] = [
      { kind: "guild", guildId: GUILD, channelId: CHANNEL },
      { kind: "dm", userId: USER, waifuId: "ella" },
      { kind: "dm", userId: USER, waifuId: "mei_chan.v2:alt-1" }
    ];
    for (const ref of refs) {
      expect(parseConversationKey(conversationKey(ref))).toEqual(ref);
    }
  });

  it("refuses ids that would break the encoding", () => {
    expect(() => conversationKey({ kind: "guild", guildId: "a_b", channelId: CHANNEL })).toThrow();
    expect(() => conversationKey({ kind: "guild", guildId: GUILD, channelId: "../x" })).toThrow();
    expect(() => conversationKey({ kind: "dm", userId: "u_1", waifuId: "ella" })).toThrow();
    expect(() => conversationKey({ kind: "dm", userId: USER, waifuId: ".." })).toThrow();
    expect(() => conversationKey({ kind: "dm", userId: USER, waifuId: "a/b" })).toThrow();
  });

  it("parses only well-formed keys", () => {
    for (const bad of ["", "g_1", "g__2", "g_1_2_3", "x_1_2", "dm_1", "dm_1_", "dm_1_../x", "dm_1_a/b", "dm_1_.."]) {
      expect(parseConversationKey(bad), bad).toBeUndefined();
    }
  });
});

describe("conversation paths", () => {
  const key = conversationKey({ kind: "guild", guildId: GUILD, channelId: CHANNEL });
  const dmKey = conversationKey({ kind: "dm", userId: USER, waifuId: "ella" });

  it("lays out files under user/conversations/<key>/", () => {
    expect(conversationDirPath(key)).toBe(path.join("user", "conversations", key));
    expect(conversationRefsPath(key)).toBe(path.join("user", "conversations", key, "refs.json"));
    expect(conversationDirPath(dmKey)).toBe(path.join("user", "conversations", dmKey));
  });

  it("rejects forged keys that would escape the data root", () => {
    for (const forged of ["../../../etc", "g_1_2/../../x", "dm_1_../../x", ""]) {
      expect(() => conversationRefsPath(forged as ConversationKey), forged).toThrow();
      expect(() => conversationDirPath(forged as ConversationKey), forged).toThrow();
    }
  });

  it("stays inside a real data root and is usable for file IO", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const relative = conversationRefsPath(dmKey);
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
