import { describe, expect, it } from "vitest";
import { CachedGuildDirectoryView } from "../src/discord/directoryView.js";
import { EMPTY_GUILD_DIRECTORY, renderDiscordMessage } from "../src/orchestration/context/messageRender.js";
import type { RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";
import { raw } from "./contextFixtures.js";

const fetchedAt = "2026-10-01T00:00:00.000Z";
const dir = new CachedGuildDirectoryView(
  {
    members: [{ userId: "111", guildDisplayName: "Kevin", bot: false, perChannelLastSeenAt: {} }],
    roles: [{ id: "555", name: "Bakers", color: 0, hoist: false, mentionable: true, managed: false, fetchedAt }],
    emojis: [
      { id: "777", name: "cookie", animated: false, available: true, roles: [], fetchedAt },
      { id: "778", name: "gone", animated: false, available: false, roles: [], fetchedAt }
    ]
  },
  (id) => (id === "900" ? "recipes" : undefined)
);

const pdf = { id: "1", url: "https://cdn.discordapp.com/attachments/200/1/menu.pdf", filename: "menu.pdf", contentType: "application/pdf", size: 1_258_291 };
const png = { id: "2", url: "https://cdn.discordapp.com/attachments/200/2/cake.png?ex=abc&is=def&hm=123", filename: "cake.png", contentType: "image/png", size: 2048, width: 640, height: 480 };
const unix = Date.parse("2026-10-24T14:02:00.000Z") / 1000;

// One row per element of the spec 9.5 rendering table (plus mentions/emoji/command rows).
const TABLE: Array<[string, Partial<RawDiscordMessage>, string | null]> = [
  ["plain text", { content: "hello there" }, "hello there"],
  ["embed", { content: "look", embeds: [{ title: "Best brownies", description: "A fudgy recipe. ".repeat(20), url: "https://www.example.com/b", providerName: "Example Eats" }] },
    `look\n[link: Best brownies — ${"A fudgy recipe. ".repeat(20).trim().slice(0, 199).trimEnd()}… (Example Eats)]`],
  ["embed without provider uses host", { embeds: [{ title: "Docs", url: "https://docs.example.org/x" }] }, "[link: Docs (docs.example.org)]"],
  ["gif embed", { embeds: [{ type: "gifv", url: "https://tenor.com/view/x", providerName: "Tenor" }] }, "[gif: Tenor]"],
  ["tenor provider with title", { embeds: [{ type: "video", title: "Happy dance", providerName: "Tenor" }] }, "[gif: Happy dance]"],
  ["sticker", { stickers: [{ name: "Wave" }] }, "[sticker: Wave]"],
  ["poll", { poll: { question: "Cake or pie?", answers: ["Cake", "Pie", "Both"] } }, '[poll: "Cake or pie?" — Cake / Pie / Both]'],
  ["poll result", { type: 46, poll: { question: "Cake or pie?", answers: ["Cake"] } }, '[poll ended: "Cake or pie?" — winner: Cake]'],
  ["forward", { snapshots: [{ content: "x".repeat(600), attachments: [pdf] }] }, `[forwarded] ${"x".repeat(499)}…\n[file: menu.pdf · 1.2 MB]`],
  ["file", { attachments: [pdf] }, "[file: menu.pdf · 1.2 MB]"],
  ["video", { attachments: [{ ...pdf, filename: "clip.mp4", contentType: "video/mp4" }] }, "[video: clip.mp4]"],
  ["voice message", { attachments: [{ ...pdf, filename: "voice-message.ogg", contentType: "audio/ogg", isVoice: true, durationSecs: 12.4 }] }, "[voice message · 0:12]"],
  ["image attachment goes to images, not body", { content: "my cake", attachments: [png] }, "my cake"],
  ["join", { type: 7 }, "[joined the server]"],
  ["pin", { type: 6 }, "[pinned a message]"],
  ["thread created", { type: 18, content: "Best brownies" }, "[started a thread: Best brownies]"],
  ["slash command use", { type: 20, commandName: "roll", content: "You rolled 4" }, "[used /roll]\nYou rolled 4"],
  ["other system messages are dropped", { type: 8 }, null],
  ["channel mention", { content: "see <#900> and <#901>" }, "see #recipes and #unknown-channel"],
  ["channel mention from message mentions", { content: "<#902>", mentions: { users: {}, roles: {}, channels: { "902": "general" } } }, "#general"],
  ["role mention", { content: "<@&555> and <@&556>" }, "@Bakers and @unknown-role"],
  ["command mention", { content: "try </bake:123> or </bake now:124>" }, "try /bake or /bake now"],
  ["timestamp tokens are absolute", { content: `at <t:${unix}:t>, <t:${unix}:R>, <t:${unix}>` }, "at 14:02, Sat 24 Oct 2026 14:02, Sat 24 Oct 2026 14:02"],
  ["user mention (frozen name)", { content: "hi <@111> <@!222> <@333>", mentions: { users: { "222": "Riko" }, roles: {}, channels: {} } }, "hi <@Kevin> <@Riko> @unknown-user"],
  ["custom emoji", { content: "<:cookie:777> <a:party:779> <:gone:778>" }, "<:cookie:> :party: :gone:"]
];

describe("renderDiscordMessage (spec 9.5 table)", () => {
  it.each(TABLE)("%s", (_name, partial, expected) => {
    const rendered = renderDiscordMessage(raw(partial), dir, "UTC");
    if (expected === null) expect(rendered).toBeNull();
    else expect(rendered?.body).toBe(expected);
  });

  it("classifies system rows as kind system and chat as default", () => {
    expect(renderDiscordMessage(raw({ type: 7 }), dir, "UTC")?.kind).toBe("system");
    expect(renderDiscordMessage(raw({ type: 20, commandName: "roll" }), dir, "UTC")?.kind).toBe("system");
    expect(renderDiscordMessage(raw({ type: 19, content: "reply" }), dir, "UTC")?.kind).toBe("default");
  });

  it("extracts image refs keyed by attachment id, ignoring the signed query", () => {
    const rendered = renderDiscordMessage(raw({ attachments: [png], snapshots: [{ content: "", attachments: [{ ...png, id: "3", url: "https://cdn.discordapp.com/attachments/200/3/f.webp", filename: "f.webp", contentType: "image/webp" }] }] }), EMPTY_GUILD_DIRECTORY, "UTC")!;
    expect(rendered.images.map((image) => image.key)).toEqual(["att:2", "att:3"]);
    expect(rendered.images[0]).toMatchObject({ attachmentId: "2", filename: "cake.png", bytes: 2048, width: 640, height: 480 });
    expect(rendered.body).toBe("[forwarded]");
  });

  it("is deterministic and matches the golden table", async () => {
    const lines = TABLE.map(([name, partial]) => {
      const rendered = renderDiscordMessage(raw({ id: "1", ...partial }), dir, "UTC");
      return `## ${name}\n${rendered === null ? "(dropped)" : `${rendered.kind}: ${rendered.body}`}`;
    });
    await expect(lines.join("\n\n") + "\n").toMatchFileSnapshot("./golden/__snapshots__/messageRender.txt");
  });
});
