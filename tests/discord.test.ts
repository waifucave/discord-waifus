import { describe, expect, it } from "vitest";
import {
  denormalizeModelContentForDiscord,
  normalizeDiscordContentForModel,
  stripLeakedContextHeader
} from "../src/discord/normalization.js";
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
});
