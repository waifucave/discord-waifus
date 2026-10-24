import { describe, expect, it } from "vitest";
import { mergeAppConfigPatch } from "../src/config/appConfig.js";
import { AppConfigSchema, UpdateAppConfigBodySchema } from "../src/shared/schemas/config.js";

describe("discord.deletedMessages.redactRecent (spec 9.5, O1)", () => {
  it("defaults to 20", () => {
    expect(AppConfigSchema.parse({}).discord.deletedMessages).toEqual({ redactRecent: 20 });
  });

  it("validates the range 0..200 as an integer", () => {
    const body = (redactRecent: unknown) => UpdateAppConfigBodySchema.safeParse({ discord: { deletedMessages: { redactRecent } } }).success;
    expect(body(0)).toBe(true);
    expect(body(200)).toBe(true);
    expect(body(-1)).toBe(false);
    expect(body(201)).toBe(false);
    expect(body(1.5)).toBe(false);
    expect(UpdateAppConfigBodySchema.safeParse({ discord: { deletedMessages: { other: 1 } } }).success).toBe(false);
  });

  it("merges without touching images or other sections", () => {
    const current = AppConfigSchema.parse({});
    const next = mergeAppConfigPatch(current, { discord: { deletedMessages: { redactRecent: 5 } } });
    expect(next.discord.deletedMessages).toEqual({ redactRecent: 5 });
    expect(next.discord.images).toEqual(current.discord.images);
    // A patch for another section keeps it.
    expect(mergeAppConfigPatch(next, { ocr: { enabled: false } }).discord.deletedMessages).toEqual({ redactRecent: 5 });
    expect(mergeAppConfigPatch(next, { discord: { images: { memoryCacheMb: 8 } } }).discord.deletedMessages).toEqual({ redactRecent: 5 });
  });
});
