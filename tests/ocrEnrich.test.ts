import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ImageOcrService } from "../src/orchestration/ocr.js";
import { OcrConfigSchema } from "../src/shared/schemas/config.js";
import { appDataPath } from "../src/config/paths.js";
import type { ContextMessage } from "../src/discord/contextBuilder.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

function quietLogger() {
  return { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
}

async function seedCache(root: string, url: string, text: string): Promise<void> {
  const dir = appDataPath(root, "cache", "ocr", "results");
  await mkdir(dir, { recursive: true });
  const key = createHash("sha256").update(url).digest("hex");
  await writeFile(
    path.join(dir, `${key}.json`),
    JSON.stringify({
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      engine: "system-tesseract",
      text
    })
  );
}

function imageMessage(id: string, url: string): ContextMessage {
  return {
    id,
    channelId: "channel-1",
    guildId: "guild-1",
    authorKind: "user",
    authorId: "u1",
    authorBot: false,
    name: "Kevin",
    displayName: "Kevin",
    content: "look",
    timestamp: "2026-07-02T12:00:00Z",
    reactions: [],
    images: [{ url, contentType: "image/png" }]
  };
}

describe("enrichMessages OCR budget", () => {
  it("spends the budget on the newest images first", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const urls = ["https://cdn.example/old.png", "https://cdn.example/mid.png", "https://cdn.example/new.png"];
    for (const url of urls) await seedCache(root, url, `text of ${url.split("/").pop()}`);

    const service = new ImageOcrService({
      dataRoot: root,
      config: OcrConfigSchema.parse({ maxImagesPerModelCall: 2 }),
      logger: quietLogger()
    });
    const messages = urls.map((url, i) => imageMessage(`m${i}`, url));
    const enriched = await service.enrichMessages(messages);
    await service.dispose();

    // Budget of 2 across 3 images: the two NEWEST get OCR text, the oldest goes without.
    expect(enriched[0].images?.[0].ocrText).toBeUndefined();
    expect(enriched[1].images?.[0].ocrText).toBe("text of mid.png");
    expect(enriched[2].images?.[0].ocrText).toBe("text of new.png");
  });
});
