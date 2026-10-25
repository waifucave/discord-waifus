// The durable per-conversation image index (src/discord/imageIndex.ts): a forget racing a queued
// write never recreates the index, the index cap moves old keys to a durable overflow instead of
// dropping them, and the in-memory state is bounded.
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONVERSATION_IMAGE_INDEX_FILE,
  CONVERSATION_IMAGE_OVERFLOW_FILE,
  forgetConversationImageIndex,
  MAX_INDEXED_KEYS,
  MAX_TRACKED_CONVERSATIONS,
  readConversationImageKeys,
  recordConversationImages,
  trackedConversationCount
} from "../src/discord/imageIndex.js";
import { conversationKey } from "../src/orchestration/context/keys.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

const KEY = conversationKey({ kind: "dm", userId: "500000000000000005", waifuId: "ella" });
const exists = (file: string) => access(file).then(() => true, () => false);

async function conversation(): Promise<{ root: string; dir: string }> {
  const root = await makeTempRoot("waifus-image-index-");
  roots.push(root);
  const dir = path.join(root, "user", "conversations", KEY);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "refs.json"), "{}");
  return { root, dir };
}

describe("conversation image index", () => {
  it("records keys once and reads them back", async () => {
    const { root, dir } = await conversation();
    await recordConversationImages(root, KEY, ["att:1", "att:2"]);
    await recordConversationImages(root, KEY, ["att:2", "att:3"]);
    expect(JSON.parse(await readFile(path.join(dir, CONVERSATION_IMAGE_INDEX_FILE), "utf8"))).toEqual({ keys: ["att:1", "att:2", "att:3"] });
    expect(await readConversationImageKeys(root, KEY)).toEqual(["att:1", "att:2", "att:3"]);
  });

  it("a write queued alongside a forget never recreates the forgotten conversation", async () => {
    const { root, dir } = await conversation();
    // Queued, not awaited: the forget is enqueued right behind it and removes the directory.
    const queued = recordConversationImages(root, KEY, ["att:before"]);
    const forgotten = forgetConversationImageIndex(root, KEY, () => rm(dir, { recursive: true, force: true }));
    // A write queued after the forget finds no directory and is skipped.
    const after = recordConversationImages(root, KEY, ["att:after"]);
    await Promise.all([queued, forgotten, after]);
    expect(await exists(dir)).toBe(false);
    expect(await exists(path.join(dir, CONVERSATION_IMAGE_INDEX_FILE))).toBe(false);
    expect(await readConversationImageKeys(root, KEY)).toEqual([]);

    // Once the conversation exists again, the same key is recorded afresh (not remembered as written).
    await mkdir(dir, { recursive: true });
    await recordConversationImages(root, KEY, ["att:after"]);
    expect(await readConversationImageKeys(root, KEY)).toEqual(["att:after"]);
  });

  it("past the cap, the oldest keys move to the durable overflow; none is lost", async () => {
    const { root, dir } = await conversation();
    const keys = Array.from({ length: MAX_INDEXED_KEYS + 3 }, (_, i) => `att:${i}`);
    await recordConversationImages(root, KEY, keys.slice(0, 10));
    await recordConversationImages(root, KEY, keys.slice(10));
    const index = JSON.parse(await readFile(path.join(dir, CONVERSATION_IMAGE_INDEX_FILE), "utf8")) as { keys: string[] };
    expect(index.keys).toHaveLength(MAX_INDEXED_KEYS);
    expect(index.keys[0]).toBe("att:3");
    expect((await readFile(path.join(dir, CONVERSATION_IMAGE_OVERFLOW_FILE), "utf8")).trim().split("\n")).toEqual(["att:0", "att:1", "att:2"]);
    expect(new Set(await readConversationImageKeys(root, KEY))).toEqual(new Set(keys));
  });

  it("keeps the in-memory state bounded", async () => {
    const root = await makeTempRoot("waifus-image-index-");
    roots.push(root);
    for (let i = 0; i < MAX_TRACKED_CONVERSATIONS + 20; i += 1) {
      const key = conversationKey({ kind: "guild", guildId: "100000000000000001", channelId: String(200000000000000000n + BigInt(i)) });
      // No directory: nothing is written, but the conversation is tracked.
      await recordConversationImages(root, key, ["att:x"]);
    }
    expect(trackedConversationCount()).toBeLessThanOrEqual(MAX_TRACKED_CONVERSATIONS);
  });
});
