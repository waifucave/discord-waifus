import { describe, expect, it } from "vitest";
import {
  denormalizeModelContentForDiscord,
  normalizeDiscordContentForModel,
  stripLeakedContextHeader
} from "../src/discord/normalization.js";
import { DiscordJsGateway, buildOrchestratorCommandPayloads } from "../src/discord/client.js";
import { mergeConfiguredBotsIntoMembers, unresolvedMentionIds } from "../src/discord/memberCache.js";
import { GuildEmojiCacheEntry, GuildMemberCacheEntry } from "../src/shared/schemas/domain.js";

const fetchedAt = new Date("2026-05-15T12:00:00.000Z").toISOString();

const members: GuildMemberCacheEntry[] = [
  {
    userId: "100",
    username: "kevin",
    globalDisplayName: "Kevin",
    guildDisplayName: "Kevin",
    bot: false,
    perChannelLastSeenAt: {}
  },
  {
    userId: "200",
    username: "other-kevin",
    globalDisplayName: "Kevin",
    guildDisplayName: "Kevin",
    bot: false,
    perChannelLastSeenAt: {}
  },
  {
    userId: "500",
    username: "mira",
    globalDisplayName: "Mira",
    guildDisplayName: "Mira",
    bot: false,
    perChannelLastSeenAt: {}
  }
];

const emojis: GuildEmojiCacheEntry[] = [
  {
    id: "300",
    name: "cutecat",
    animated: false,
    available: true,
    roles: [],
    fetchedAt
  },
  {
    id: "400",
    name: "dance",
    animated: true,
    available: true,
    roles: [],
    fetchedAt
  }
];

describe("Discord normalization", () => {
  it("normalizes Discord user mentions and custom emojis for model context", () => {
    const result = normalizeDiscordContentForModel("hi <@!100> <:cutecat:300> <a:dance:400> <@999>", {
      members,
      emojis
    });
    expect(result.content).toBe("hi <@Kevin> <:cutecat:> <a:dance:> @unknown-user");
    expect(result.content).not.toContain("999");
    expect(result.warnings).toHaveLength(1);
  });

  it("denormalizes model-visible mentions with active-user disambiguation and safe allowed_mentions", () => {
    const result = denormalizeModelContentForDiscord("hello <@Kevin> <:cutecat:> @everyone", {
      members,
      emojis,
      activeAuthorIds: ["200"]
    });
    expect(result.content).toBe("hello <@200> <:cutecat:300> @ everyone");
    expect(result.allowedMentions.users).toEqual(["200"]);
    expect(result.allowedMentions.parse).toBeUndefined();
    expect(result.allowedMentions.repliedUser).toBe(false);
  });

  it("leaves ambiguous model mentions unpinged without guessing IDs", () => {
    const result = denormalizeModelContentForDiscord("hello <@Kevin>", {
      members,
      emojis
    });
    expect(result.content).toBe("hello @Kevin");
    expect(result.allowedMentions.users).toEqual([]);
    expect(result.allowedMentions.parse).toEqual([]);
    expect(result.warnings[0]).toContain("could not be resolved");
  });

  it("denormalizes missing-close model mentions with the normal resolver", () => {
    const result = denormalizeModelContentForDiscord("come back <@Mira", {
      members,
      emojis
    });
    expect(result.content).toBe("come back <@500>");
    expect(result.allowedMentions.users).toEqual(["500"]);
    expect(result.allowedMentions.parse).toBeUndefined();
  });

  it("denormalizes plain at-name model mentions with exact cached member matches", () => {
    const result = denormalizeModelContentForDiscord("come back @Mira", {
      members,
      emojis
    });
    expect(result.content).toBe("come back <@500>");
    expect(result.allowedMentions.users).toEqual(["500"]);
  });

  it("leaves ambiguous plain at-name model mentions unpinged", () => {
    const result = denormalizeModelContentForDiscord("come back @Kevin", {
      members,
      emojis
    });
    expect(result.content).toBe("come back @Kevin");
    expect(result.allowedMentions.users).toEqual([]);
    expect(result.allowedMentions.parse).toEqual([]);
    expect(result.warnings[0]).toContain("could not be resolved");
  });

  it("leaves unknown plain at-name text unpinged", () => {
    const result = denormalizeModelContentForDiscord("come back @Someone", {
      members,
      emojis
    });
    expect(result.content).toBe("come back @Someone");
    expect(result.allowedMentions.users).toEqual([]);
    expect(result.allowedMentions.parse).toEqual([]);
  });

  it("hides raw role mentions from model context", () => {
    const result = normalizeDiscordContentForModel("hello <@&100000000000000003>", {
      members,
      emojis
    });
    expect(result.content).toBe("hello @unknown-role");
    expect(result.content).not.toContain("100000000000000003");
  });

  it("normalizes known role mentions by visible role name", () => {
    const result = normalizeDiscordContentForModel("hello <@&100000000000000003>", {
      members,
      emojis,
      roles: [{ id: "100000000000000003", name: "Lumi" }]
    });
    expect(result.content).toBe("hello <@Lumi>");
    expect(result.content).not.toContain("100000000000000003");
  });
});

describe("Discord member cache helpers", () => {
  it("finds unresolved user and role mention IDs before model normalization", () => {
    expect(unresolvedMentionIds(["hi <@100> <@999> <@&888>"], members)).toEqual(["999", "888"]);
  });

  it("does not treat known role mentions as missing member mentions", () => {
    expect(unresolvedMentionIds(["hi <@100> <@999> <@&888>"], members, { roleIds: ["888"] }))
      .toEqual(["999"]);
  });

  it("adds configured bot application IDs to the participant cache", () => {
    const merged = mergeConfiguredBotsIntoMembers(members, {
      orchestrator: null,
      waifus: [
        {
          id: "aria",
          displayName: "Aria",
          applicationId: "100000000000000004",
          enabled: true
        }
      ]
    });
    expect(merged.some((member) => member.userId === "100000000000000004" && member.guildDisplayName === "Aria"))
      .toBe(true);
  });
});

describe("orchestrator slash command payloads", () => {
  it("keeps /run open while requiring admin permissions for other orchestrator commands", () => {
    const payloads = buildOrchestratorCommandPayloads();
    const byName = new Map(payloads.map((payload) => [payload.name, payload]));
    const run = byName.get("run");

    expect(run).toBeDefined();
    expect(run).not.toHaveProperty("defaultMemberPermissions");
    for (const name of ["review", "clear", "stop", "memories", "console"]) {
      expect(byName.get(name)?.defaultMemberPermissions).toBe(8n);
    }
    expect(byName.has("debug")).toBe(false);
  });

  it("registers /console with required set/unset/print type and optional channel_id", () => {
    const consoleCommand = buildOrchestratorCommandPayloads().find((payload) => payload.name === "console");
    expect(consoleCommand?.options).toEqual([
      expect.objectContaining({
        name: "type",
        required: true,
        choices: [
          { name: "set", value: "set" },
          { name: "unset", value: "unset" },
          { name: "print", value: "print" }
        ]
      }),
      expect.objectContaining({
        name: "channel_id",
        required: false
      })
    ]);
  });
});

describe("DiscordJsGateway message deletion", () => {
  it("bulk deletes recent messages and individually deletes messages older than two weeks", async () => {
    const recentTimestamp = Date.now() - 60_000;
    const oldTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const pages = new Map<string, Array<{ id: string; createdTimestamp: number }>>([
      [
        "first",
        [
          { id: "recent-1", createdTimestamp: recentTimestamp },
          { id: "recent-2", createdTimestamp: recentTimestamp - 1_000 },
          { id: "old-1", createdTimestamp: oldTimestamp }
        ]
      ],
      ["old-1", [{ id: "old-2", createdTimestamp: oldTimestamp - 1_000 }]],
      ["old-2", []]
    ]);
    const fetchCalls: Array<{ limit?: number; before?: string }> = [];
    const bulkDeletes: string[][] = [];
    const singleDeletes: string[] = [];
    const channel = {
      messages: {
        async fetch(options: { limit?: number; before?: string }) {
          fetchCalls.push(options);
          const page = pages.get(options.before ?? "first") ?? [];
          return { values: () => page.values() };
        },
        async delete(messageId: string) {
          singleDeletes.push(messageId);
        }
      },
      async bulkDelete(messageIds: string[]) {
        bulkDeletes.push(messageIds);
        return { keys: () => messageIds.values() };
      }
    };
    const gateway = new DiscordJsGateway({
      orchestrator: {
        id: "orchestrator",
        displayName: "Orchestrator",
        token: "token"
      },
      logger: quietLogger()
    });
    const clients = (gateway as unknown as { clients: Map<string, unknown> }).clients;
    clients.set("orchestrator", {
      channels: {
        async fetch() {
          return channel;
        }
      }
    });

    const result = await gateway.deleteAllMessages({ guildId: "guild-1", channelId: "channel-1" });

    expect(fetchCalls).toEqual([
      { limit: 100 },
      { limit: 100, before: "old-1" },
      { limit: 100, before: "old-2" }
    ]);
    expect(bulkDeletes).toEqual([["recent-1", "recent-2"]]);
    expect(singleDeletes).toEqual(["old-1", "old-2"]);
    expect(result).toMatchObject({
      scannedMessageCount: 4,
      deletedCount: 4,
      failedCount: 0,
      failedMessageIds: []
    });
  });
});

describe("stripLeakedContextHeader", () => {
  it("strips a single bracket tag prefix", () => {
    expect(stripLeakedContextHeader("[timestamp: 2026-05-16T12:00:00Z] Bored, huh?"))
      .toBe("Bored, huh?");
  });

  it("strips a full index + timestamp + sender prefix", () => {
    expect(
      stripLeakedContextHeader(
        "[index: #5] [timestamp: 2026-05-16T12:00:00Z] [sender: Aria] Hey K!",
        { senderDisplayName: "Aria" }
      )
    ).toBe("Hey K!");
  });

  it("strips trailing reactions and replying-to suffixes", () => {
    expect(
      stripLeakedContextHeader(
        "[timestamp: 2026-05-16T12:00:00Z] [sender: Aria] Hey K! [reactions: 🔥 x1] [replying to: K: play with me]"
      )
    ).toBe("Hey K!");
  });

  it("strips multi-block leakage with intermediate body text", () => {
    const leaked = [
      "[timestamp: 2026-05-16T12:00:00Z] [sender: Aria] That didn't really answer, did it...",
      "[replying to: K: play with me]",
      "",
      "[timestamp: 2026-05-16T12:00:30Z] [sender: Aria] What kind of play?"
    ].join("\n");
    const out = stripLeakedContextHeader(leaked, { senderDisplayName: "Aria" });
    expect(out.startsWith("[")).toBe(false);
    expect(out.endsWith("]")).toBe(false);
  });

  it("still strips legacy formats for backwards compatibility", () => {
    expect(stripLeakedContextHeader("[just now] Bored, huh?")).toBe("Bored, huh?");
    expect(stripLeakedContextHeader("#5 [just now] Aria: Hey K!", { senderDisplayName: "Aria" })).toBe("Hey K!");
    expect(stripLeakedContextHeader("reply_to: #2\nactual reply")).toBe("actual reply");
  });

  it("only strips bracket tags at the very edges, never inside the message", () => {
    expect(stripLeakedContextHeader("Hey [timestamp: now] friend")).toBe("Hey [timestamp: now] friend");
    expect(stripLeakedContextHeader("see message #5 above")).toBe("see message #5 above");
  });

  it("leaves a clean reply untouched", () => {
    expect(stripLeakedContextHeader("Hey K!", { senderDisplayName: "Aria" })).toBe("Hey K!");
  });

  it("strips leaked analysis blocks and keeps the final reply", () => {
    const leaked = [
      "The readable data, parsed: internal parse details.",
      "<analysis on incoming message>: private chain of thought.",
      "Response draft: Feels like a summoning ritual went off.",
      "</analysis>Feels like a summoning ritual went off. If anyone's lurking besides me, now's a good time to materialize. <:thinknoose:>"
    ].join("\n");
    expect(stripLeakedContextHeader(leaked, { senderDisplayName: "Aria" })).toBe(
      "Feels like a summoning ritual went off. If anyone's lurking besides me, now's a good time to materialize. <:thinknoose:>"
    );
  });

  it("extracts a draft when leaked analysis has no closing tag", () => {
    expect(
      stripLeakedContextHeader(
        "Analysis: too much private detail. Response draft: Got carried away, didn't I?",
        { senderDisplayName: "Aria" }
      )
    ).toBe("Got carried away, didn't I?");
  });

  it("drops unrecoverable leaked analysis instead of sending it", () => {
    expect(stripLeakedContextHeader("Analysis: private detail only")).toBe("");
  });

  it("does not strip another speaker's name", () => {
    expect(
      stripLeakedContextHeader("Kevin: stop saying that", { senderDisplayName: "Aria" })
    ).toBe("Kevin: stop saying that");
  });

  it("strips a context-header chain that appears mid-reply after a paragraph break", () => {
    const leaked =
      "K's just salty I called him Portuguese instead of Finnish~ 😘💕\n\n[timestamp: 2026-05-18T14:38:40Z] [sender: Stupid hoe] And baby Ali, a lady never reveals all her secrets~ 👀✨";
    expect(stripLeakedContextHeader(leaked, { senderDisplayName: "Stupid hoe" })).toBe(
      "K's just salty I called him Portuguese instead of Finnish~ 😘💕\n\nAnd baby Ali, a lady never reveals all her secrets~ 👀✨"
    );
  });

  it("strips a mid-reply header even when the body is on the next line", () => {
    const leaked =
      "first line body 😘\n[timestamp: 2026-05-18T14:38:40Z] [sender: Aria]\nsecond line body";
    expect(stripLeakedContextHeader(leaked, { senderDisplayName: "Aria" })).toBe(
      "first line body 😘\n\nsecond line body"
    );
  });

  it("strips orphan replying-to and reactions lines left between hallucinated entries", () => {
    const leaked = [
      "first body line",
      "[replying to: K: hi there]",
      "[reactions: 🔥 x2]",
      "[timestamp: 2026-05-18T14:38:40Z] [sender: Aria] second body line"
    ].join("\n");
    expect(stripLeakedContextHeader(leaked, { senderDisplayName: "Aria" })).toBe(
      "first body line\n\nsecond body line"
    );
  });

  it("still preserves a legitimate inline bracket mention on the same line", () => {
    expect(stripLeakedContextHeader("Hey [timestamp: now] friend")).toBe(
      "Hey [timestamp: now] friend"
    );
  });

  it("drops a leading other-waifu impersonation line entirely", () => {
    expect(
      stripLeakedContextHeader("Riko: Bravo, you cracked the code!\nokay", {
        senderDisplayName: "Aria",
        participantDisplayNames: ["Aria", "Riko", "Stupid hoe"]
      })
    ).toBe("okay");
  });

  it("ignores a leading name not present in participantDisplayNames", () => {
    expect(
      stripLeakedContextHeader("Kevin: stop saying that", {
        senderDisplayName: "Aria",
        participantDisplayNames: ["Aria", "Riko"]
      })
    ).toBe("Kevin: stop saying that");
  });

  it("strips a leading own-name prefix case-insensitively", () => {
    expect(
      stripLeakedContextHeader("aria: hello there", {
        senderDisplayName: "Aria",
        participantDisplayNames: ["Aria"]
      })
    ).toBe("hello there");
  });

  it("drops mid-message lines that impersonate another waifu and strips own-name prefix on remaining lines", () => {
    const leaked = [
      "Riko: Bravo, you cracked the code!",
      "🔥",
      "Stupid hoe: proud of you for figuring out a basic discord feature babe",
      "Aria: He finally graduated from his own tutorial.",
      "Slow clap."
    ].join("\n");
    expect(
      stripLeakedContextHeader(leaked, {
        senderDisplayName: "Aria",
        participantDisplayNames: ["Aria", "Riko", "Stupid hoe", "Lumi"]
      })
    ).toBe("🔥\nHe finally graduated from his own tutorial.\nSlow clap.");
  });

  it("keeps a line whose name prefix is not in the participants list", () => {
    expect(
      stripLeakedContextHeader("Kevin: ok\nyeah", {
        senderDisplayName: "Aria",
        participantDisplayNames: ["Aria", "Riko"]
      })
    ).toBe("Kevin: ok\nyeah");
  });
});

function quietLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}

describe("stripLeakedContextHeader — clip audit pins", () => {
  const opts = { senderDisplayName: "Aria", participantDisplayNames: ["Aria", "Riko"] };

  it("strips a leading `#N` legacy-index prefix", () => {
    expect(stripLeakedContextHeader("#3 hot take", opts)).toBe("hot take");
  });

  it("does not strip a leading `#word` hashtag (no digit after #)", () => {
    expect(stripLeakedContextHeader("loving #anime today", opts)).toBe("loving #anime today");
  });

  it("strips a leading `[just now]` legacy timestamp", () => {
    expect(stripLeakedContextHeader("[just now] hello", opts)).toBe("hello");
  });

  it("strips a leading `[N min ago]` legacy timestamp", () => {
    expect(stripLeakedContextHeader("[3 mins ago] hello", opts)).toBe("hello");
  });

  it("does not strip the words `just now` in the body when not bracketed at start", () => {
    expect(stripLeakedContextHeader("that was just now lol", opts)).toBe("that was just now lol");
  });

  it("strips a trailing `[mood: hyped]` style bracket tag", () => {
    expect(stripLeakedContextHeader("hello", opts)).toBe("hello");
    expect(stripLeakedContextHeader("hello [mood: hyped]", opts)).toBe("hello");
  });

  it("leaves trailing punctuation/emoticons alone (no false trailing-bracket strip)", () => {
    expect(stripLeakedContextHeader("hello :)", opts)).toBe("hello :)");
  });

  it("strips a leading `<thinking>...</thinking>` block followed by the real reply", () => {
    expect(stripLeakedContextHeader("<thinking>scratch</thinking>hello", opts)).toBe("hello");
  });

  it("does not eat an inline `<3` emoticon (not a tag)", () => {
    expect(stripLeakedContextHeader("that's a <3 moment", opts)).toBe("that's a <3 moment");
  });

  it("does not treat the bare word `reasoning` as a leaked analysis marker", () => {
    expect(stripLeakedContextHeader("the reasoning was sound", opts)).toBe(
      "the reasoning was sound"
    );
  });

  it("does not strip a mid-line `Aria:` (only leading prefixes are sender-stripped)", () => {
    expect(stripLeakedContextHeader("omg Aria: did i say that?", opts)).toBe(
      "omg Aria: did i say that?"
    );
  });

  it("does not strip a mid-line `Riko:` (other-waifu drop only fires at line start)", () => {
    expect(stripLeakedContextHeader("omg Riko: was that you lol", opts)).toBe(
      "omg Riko: was that you lol"
    );
  });

  // Trade-off pin: a leading `Riko:` line — even if Aria intended it as quoted
  // dialogue, not impersonation — gets dropped. Keeping this behavior so transcript
  // impersonation is consistently caught; the runtime's retry-once compensates when
  // it would otherwise empty the entire turn.
  it("drops a standalone `Riko: …` line even if the body would have been benign", () => {
    expect(stripLeakedContextHeader("Riko: lol omg", opts)).toBe("");
  });

  it("strips a leading `reactions: …` line", () => {
    expect(stripLeakedContextHeader("reactions: 🔥 x2\nhello", opts)).toBe("hello");
  });

  it("does not eat the word `reactions` mid-sentence", () => {
    expect(stripLeakedContextHeader("got some weird reactions today", opts)).toBe(
      "got some weird reactions today"
    );
  });

  it("strips a leading `[note: hello]` bracket tag", () => {
    expect(stripLeakedContextHeader("[note: hello] body", opts)).toBe("body");
  });

  it("does not strip an inline `[vibing]` bracketed word (no colon → not a tag shape)", () => {
    expect(stripLeakedContextHeader("hello [vibing] tonight", opts)).toBe(
      "hello [vibing] tonight"
    );
  });
});
