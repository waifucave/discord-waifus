import { describe, expect, it, vi } from "vitest";
import { createGateway } from "@waifucave/gateway";
import { buildWaifuMessages } from "../src/orchestration/pipeline/messages.js";
import {
  ContextMessage,
  formatSelfWaifuContent,
  formatWaifuContextBlock,
} from "../src/orchestration/context.js";

const gateway = createGateway({});

const msg = (over: Partial<ContextMessage>): ContextMessage => ({
  id: "m1",
  channelId: "c",
  authorKind: "user",
  authorId: "u1",
  name: "ann",
  displayName: "Ann",
  content: "hello",
  timestamp: "2026-06-12T10:00:00.000Z",
  reactions: [],
  ...over,
});

const base = {
  systemPrompt: "SYSTEM",
  midSystemBlock: "MID",
  trailingSystemBlock: "TRAIL",
  retryUserMessage: undefined as string | undefined,
  selfAuthorIds: ["bot-1"],
  messages: [
    msg({ id: "m1", content: "hi" }),
    msg({
      id: "m2",
      authorKind: "waifu",
      authorId: "bot-1",
      name: "yuki",
      displayName: "Yuki",
      content: "yo",
    }),
    msg({ id: "m3", content: "second" }),
    msg({ id: "m4", content: "third" }),
  ],
};

describe("buildWaifuMessages", () => {
  it("maps self messages to assistant raw bodies and others to formatted user turns", async () => {
    // deepseek-v4-flash: multipleSystemMessages=false, input=text only
    const model = gateway.getCapabilities("deepseek", "deepseek-v4-flash")!;
    const out = await buildWaifuMessages(model, base);
    const selfTurn = out.find((m) => m.role === "assistant");
    expect(selfTurn?.content).toBe(formatSelfWaifuContent(base.messages[1]!));
    const firstUser = out.find((m) => m.role === "user");
    expect(
      typeof firstUser?.content === "string" ? firstUser.content : ""
    ).toContain(
      (formatWaifuContextBlock(base.messages[0]!) as string).slice(0, 12)
    );
  });

  it("uses real system turns for multipleSystemMessages models and <system_note> user turns otherwise", async () => {
    // xai grok-4.3: multipleSystemMessages=true, input=[text, image]
    // anthropic claude-haiku-4-5-20251001: multipleSystemMessages=false, input=[text, image]
    const openaiStyle = gateway.getCapabilities("xai", "grok-4.3")!;
    const anthropicStyle = gateway.getCapabilities(
      "anthropic",
      "claude-haiku-4-5-20251001"
    )!;
    const a = await buildWaifuMessages(openaiStyle, base);
    const b = await buildWaifuMessages(anthropicStyle, base);

    expect(a[0]).toEqual({ role: "system", content: "SYSTEM" });
    expect(b[0]).toEqual({ role: "system", content: "SYSTEM" });

    const aMid = a.filter((m) => m.role === "system");
    expect(aMid.length).toBeGreaterThanOrEqual(3); // SYSTEM + MID + TRAIL as real system turns
    const bNotes = b.filter(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.startsWith("<system_note>")
    );
    expect(bNotes).toHaveLength(2);
    expect(bNotes[0]!.content).toBe("<system_note>\nMID\n</system_note>");
  });

  it("injects the mid block at context length - 2 and retryUserMessage last", async () => {
    // deepseek-v4-flash: multipleSystemMessages=false, input=text only
    const model = gateway.getCapabilities("deepseek", "deepseek-v4-flash")!;
    const out = await buildWaifuMessages(model, {
      ...base,
      retryUserMessage: "Yuki:",
    });
    const last = out[out.length - 1]!;
    expect(last).toEqual({ role: "user", content: "Yuki:" });
    const midIndex = out.findIndex(
      (m) =>
        typeof m.content === "string" && m.content.includes("MID")
    );
    const m3Index = out.findIndex(
      (m) =>
        typeof m.content === "string" &&
        (m.content as string).includes("second")
    );
    expect(midIndex).toBeGreaterThan(0);
    expect(midIndex).toBeLessThan(m3Index);
  });

  it("inlines images as base64 ImageBlocks and falls back to text on fetch failure", async () => {
    // claude-haiku-4-5-20251001: multipleSystemMessages=false, input=[text, image]
    const model = gateway.getCapabilities(
      "anthropic",
      "claude-haiku-4-5-20251001"
    )!;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fetchImpl = vi.fn(
      async () =>
        new Response(png, {
          status: 200,
          headers: { "content-type": "image/png" },
        })
    );
    const withImage = {
      ...base,
      messages: [
        msg({
          id: "m1",
          content: "look",
          images: [
            { url: "https://cdn.test/a.png", contentType: "image/png" },
          ],
        }),
      ],
    };
    const out = await buildWaifuMessages(model, withImage, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const userTurn = out.find(
      (m) => m.role === "user" && Array.isArray(m.content)
    );
    const image = (userTurn!.content as Array<{ type: string }>).find(
      (b) => b.type === "image"
    ) as {
      type: string;
      mimeType: string;
      data: string;
    };
    expect(image.mimeType).toBe("image/png");
    expect(image.data).toBe(png.toString("base64"));

    const failing = vi.fn(
      async () => new Response("nope", { status: 404 })
    );
    const fallback = await buildWaifuMessages(model, withImage, {
      fetchImpl: failing as unknown as typeof fetch,
    });
    expect(
      fallback.some(
        (m) =>
          Array.isArray(m.content) &&
          (m.content as Array<{ type: string }>).some((b) => b.type === "image")
      )
    ).toBe(false);
  });
});
