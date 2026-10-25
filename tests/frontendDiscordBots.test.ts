// The interactive Discord bot guide's logic (src/frontend/utils/discord.ts, discordBots.ts): the
// intent/permission lists are pinned to what the gateway really requests, the picker, validation,
// and the save payloads (House, a waifu with a bot, a waifu without one) run against fakes. No
// network, and no token is ever asserted anywhere but in a request body.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Client, Events, IntentsBitField, PermissionFlagsBits } from "discord.js";
import type { ClientOptions } from "discord.js";
import { describe, expect, it, vi } from "vitest";

// External links read the client context; a host session renders plain anchors.
vi.mock("../src/frontend/state/clientContext.js", () => ({ useClientContext: () => ({ mode: "host" }) }));

import { DiscordJsGateway } from "../src/discord/client.js";
import type { DiscordJsGatewayOptions } from "../src/discord/client.js";
import type { DiscordBotConfig as StoredBot } from "../src/shared/schemas/domain.js";
import {
  buildInviteUrl,
  intentListFor,
  permissionBitsFor,
  permissionFlagsFor,
  permissionListFor
} from "../src/frontend/utils/discord.js";
import {
  EMPTY_DRAFT,
  buildBotsPatch,
  buildPickerEntries,
  canSave,
  changeSummary,
  checkApplicationId,
  checkToken,
  connectionFor,
  connectionLabel,
  connectionSettled,
  draftChanges,
  effectiveApplicationId,
  saveBotDraft,
  setupBadge,
  summarizeTarget,
  type BotsWriteBody,
  type SaveDeps
} from "../src/frontend/utils/discordBots.js";
import type { DiscordBotConfig, DiscordBotsFile, WaifuConfig } from "../src/frontend/api/types.js";
import { DiscordBotGuide } from "../src/frontend/components/DiscordBotGuide.js";
import type { DiscordBotSetup } from "../src/frontend/components/useDiscordBotSetup.js";
import { WaifuConfigSchema } from "../src/shared/schemas/domain.js";
import { CURRENT_SCHEMA_VERSION } from "../src/shared/schemas/common.js";

const AT = "2026-10-25T10:00:00.000Z";
const APP_ID = "123456789012345678";
const OTHER_APP_ID = "987654321098765432";
// A fake token in Discord's three-part shape, assembled at runtime so secret scanners don't flag it.
const TOKEN = [Buffer.from(APP_ID).toString("base64url"), "GabcDe", "abcdefghijklmnopqrstuvwxyz0123456789ABCD"].join(".");

function waifu(id: string, overrides: Record<string, unknown> = {}): WaifuConfig {
  return WaifuConfigSchema.parse({ schemaVersion: CURRENT_SCHEMA_VERSION, revision: 1, updatedAt: AT, id, name: id, displayName: id[0]!.toUpperCase() + id.slice(1), ...overrides }) as WaifuConfig;
}

function bot(id: string, overrides: Partial<DiscordBotConfig> = {}): DiscordBotConfig {
  return { id, displayName: id, enabled: true, tokenConfigured: false, ...overrides };
}

function botsFile(overrides: Partial<DiscordBotsFile> = {}): DiscordBotsFile {
  return { schemaVersion: CURRENT_SCHEMA_VERSION, revision: 7, updatedAt: AT, orchestrator: null, waifus: [], ...overrides };
}

describe("intent and permission lists match what the gateway uses", () => {
  const PRIVILEGED = new Set(["MessageContent", "GuildMembers", "GuildPresences"]);

  async function requestedIntents(kind: "house" | "waifu", extra: Partial<DiscordJsGatewayOptions> = {}): Promise<string[]> {
    const captured: ClientOptions[] = [];
    const createClient: NonNullable<DiscordJsGatewayOptions["createClient"]> = ({ options }) => {
      captured.push(options);
      const client = new Client(options);
      (client as unknown as { login: (token?: string) => Promise<string> }).login = async (token = "") => {
        queueMicrotask(() => client.emit(Events.ClientReady, client as Client<true>));
        return token;
      };
      return client;
    };
    const stored = (id: string): StoredBot => ({ id, displayName: id, token: `${id}-token`, enabled: true });
    const gateway = new DiscordJsGateway({ house: stored("house"), waifus: [stored("aria-bot")], createClient, ...extra });
    try {
      await gateway.connect();
    } finally {
      await gateway.disconnect();
    }
    const options = captured[kind === "house" ? 0 : 1]!;
    return new IntentsBitField(options.intents).toArray().sort();
  }

  it("the House bot asks for Message Content (and Server Members only when enabled), the portal list says the same", async () => {
    const plain = await requestedIntents("house");
    expect(plain).toContain("MessageContent");
    expect(plain).not.toContain("GuildMembers");
    const withMembers = await requestedIntents("house", { guildMembersIntent: true });
    expect(withMembers).toContain("GuildMembers");

    const toggles = intentListFor("house").filter((intent) => intent.portalToggle);
    expect(toggles.map((intent) => [intent.name, intent.required])).toEqual([
      ["MESSAGE CONTENT INTENT", true],
      ["SERVER MEMBERS INTENT", false]
    ]);
    // Every privileged intent the app can request has a portal toggle in the list, and no more.
    expect(withMembers.filter((name) => PRIVILEGED.has(name)).sort()).toEqual(["GuildMembers", "MessageContent"]);
    // The automatic (non-privileged) ones are all listed too.
    const automatic = intentListFor("house").filter((intent) => !intent.portalToggle).map((intent) => intent.name);
    for (const name of plain.filter((n) => !PRIVILEGED.has(n))) {
      // discord.js' name for the Guild Expressions intent is GuildEmojisAndStickers.
      const listed = name === "GuildEmojisAndStickers" ? "guildexpressions" : name.toLowerCase();
      expect(automatic.map((n) => n.replace(/_/g, "").toLowerCase())).toContain(listed);
    }
  });

  it("a waifu bot requests no privileged intent, so the guide asks for no portal toggle", async () => {
    const plain = await requestedIntents("waifu");
    expect(plain).toEqual(["Guilds"]);
    const withDms = await requestedIntents("waifu", { dmBots: async () => [{ botId: "aria-bot", waifuId: "aria" }] });
    expect(withDms.filter((name) => PRIVILEGED.has(name))).toEqual([]);
    expect(withDms).toEqual(["DirectMessageReactions", "DirectMessageTyping", "DirectMessages", "Guilds"]);
    expect(intentListFor("waifu").filter((intent) => intent.portalToggle || intent.privileged)).toEqual([]);
  });

  it("permission bits equal discord.js' for every listed flag, including Send Messages in Threads (bit 38)", () => {
    const camel = (flag: string) => flag.toLowerCase().replace(/(^|_)([a-z])/g, (_m, _u, ch: string) => ch.toUpperCase());
    for (const kind of ["house", "waifu"] as const) {
      for (const { flag, bit } of permissionFlagsFor(kind)) {
        expect(bit, `${kind} ${flag}`).toBe((PermissionFlagsBits as Record<string, bigint>)[camel(flag)]);
      }
    }
    expect(permissionBitsFor("waifu")).toBe(
      String(
        PermissionFlagsBits.ViewChannel |
          PermissionFlagsBits.SendMessages |
          PermissionFlagsBits.SendMessagesInThreads |
          PermissionFlagsBits.ReadMessageHistory |
          PermissionFlagsBits.AddReactions |
          PermissionFlagsBits.AttachFiles |
          PermissionFlagsBits.UseExternalEmojis |
          PermissionFlagsBits.EmbedLinks |
          PermissionFlagsBits.ChangeNickname
      )
    );
    expect(permissionBitsFor("house")).toBe(String(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory));
  });

  it("the House bot is not asked for Administrator and never needs to post; a waifu can post, react and attach", () => {
    expect(permissionListFor("house")).toEqual(["View Channels", "Read Message History"]);
    expect(permissionListFor("waifu")).toEqual(
      expect.arrayContaining(["Send Messages", "Send Messages in Threads", "Add Reactions", "Attach Files", "Read Message History", "Change Nickname"])
    );
    // The House bot never sets a nickname of its own.
    expect(permissionListFor("house")).not.toContain("Change Nickname");
  });

  it("builds the invite from the typed id, with the right scopes", () => {
    const house = new URL(buildInviteUrl(` ${APP_ID} `, "house"));
    expect(house.searchParams.get("client_id")).toBe(APP_ID);
    expect(house.searchParams.get("scope")).toBe("bot applications.commands");
    const waifuUrl = new URL(buildInviteUrl(APP_ID, "waifu", "555"));
    expect(waifuUrl.searchParams.get("scope")).toBe("bot");
    expect(waifuUrl.searchParams.get("permissions")).toBe(permissionBitsFor("waifu"));
    expect(waifuUrl.searchParams.get("guild_id")).toBe("555");
  });
});

describe("picker entries", () => {
  const bots = botsFile({
    orchestrator: bot("house", { applicationId: APP_ID, tokenConfigured: true, tokenHint: "…abcd" }),
    waifus: [
      bot("aria", { applicationId: OTHER_APP_ID, tokenConfigured: true }),
      bot("mina") // an entry exists under her own id but she is not linked yet
    ]
  });
  const cast = [waifu("aria", { botId: "aria" }), waifu("mina"), waifu("lumi", { displayName: "Lumi" }), waifu("zed", { botId: "gone" })];

  it("lists the House bot first, then each waifu with her suggested name", () => {
    const entries = buildPickerEntries(bots, cast);
    expect(entries.map((entry) => [entry.key, entry.kind, entry.suggestedName])).toEqual([
      ["house", "house", "House"],
      ["aria", "waifu", "Aria"],
      ["mina", "waifu", "Mina"],
      ["lumi", "waifu", "Lumi"],
      ["zed", "waifu", "Zed"]
    ]);
  });

  it("matches the stored entry through botId, and shows an unlinked waifu's half-finished entry", () => {
    const [house, aria, mina, lumi, zed] = buildPickerEntries(bots, cast);
    expect(house!.bot?.applicationId).toBe(APP_ID);
    expect(aria).toMatchObject({ linked: true, botId: "aria" });
    expect(aria!.bot?.applicationId).toBe(OTHER_APP_ID);
    expect(mina).toMatchObject({ linked: false, botId: "mina" });
    expect(mina!.bot?.id).toBe("mina");
    expect(lumi).toMatchObject({ linked: false, bot: null });
    expect(zed).toMatchObject({ linked: true, botId: "gone", bot: null });
  });

  it("says what each bot lacks", () => {
    const [house, aria, mina, lumi, zed] = buildPickerEntries(bots, cast);
    expect(setupBadge(house!)).toEqual({ tone: "ok", text: "bot ready" });
    expect(summarizeTarget(house!).text).toBe(`app ${APP_ID} · token set (…abcd)`);
    expect(setupBadge(aria!)).toEqual({ tone: "ok", text: "bot ready" });
    expect(setupBadge(mina!).tone).toBe("warn");
    expect(summarizeTarget(mina!).missing).toEqual(["not linked to her", "no app id", "no token"]);
    expect(setupBadge(lumi!)).toEqual({ tone: "neutral", text: "no bot yet" });
    expect(setupBadge(zed!).tone).toBe("warn");
  });

  it("offers only the House bot in House-only mode, even before anything is loaded", () => {
    expect(buildPickerEntries(undefined, cast, { houseOnly: true }).map((entry) => entry.key)).toEqual(["house"]);
    expect(buildPickerEntries(undefined, undefined)[0]).toMatchObject({ key: "house", botId: "house", bot: null });
  });

  it("uses the stored House bot's id", () => {
    const entries = buildPickerEntries(botsFile({ orchestrator: bot("main-house") }), []);
    expect(entries[0]!.botId).toBe("main-house");
  });
});

describe("validation", () => {
  it("accepts 17 to 20 digits and explains anything else", () => {
    expect(checkApplicationId("")).toEqual({ state: "empty" });
    expect(checkApplicationId("  ")).toEqual({ state: "empty" });
    expect(checkApplicationId(APP_ID).state).toBe("valid");
    expect(checkApplicationId(`  ${APP_ID}  `).state).toBe("valid");
    expect(checkApplicationId("1".repeat(17)).state).toBe("valid");
    expect(checkApplicationId("1".repeat(20)).state).toBe("valid");
    expect(checkApplicationId("1".repeat(16))).toMatchObject({ state: "invalid", message: expect.stringContaining("17 to 20") });
    expect(checkApplicationId("1".repeat(21)).state).toBe("invalid");
    expect(checkApplicationId("12345678901234567x")).toMatchObject({ state: "invalid", message: expect.stringContaining("Digits only") });
  });

  it("warns when the token field holds an Application ID or a public key, and never blocks a plausible token", () => {
    expect(checkToken("")).toEqual({ state: "empty" });
    expect(checkToken(TOKEN)).toEqual({ state: "valid" });
    expect(checkToken(APP_ID).state).toBe("invalid");
    expect(checkToken("a".repeat(64)).state).toBe("invalid");
    expect(checkToken("two words").state).toBe("invalid");
    expect(checkToken("   ").state).toBe("invalid");
    // An unfamiliar shape is a hint, not an error.
    expect(checkToken("x".repeat(70))).toMatchObject({ state: "valid", message: expect.stringContaining("three parts") });
  });

  it("only allows Save for a real change that is not known to be wrong", () => {
    const [house] = buildPickerEntries(botsFile({ orchestrator: bot("house", { applicationId: APP_ID }) }), []);
    expect(canSave(house!, EMPTY_DRAFT)).toBe(false);
    expect(canSave(house!, { applicationId: APP_ID, token: "" })).toBe(false); // unchanged
    expect(canSave(house!, { applicationId: "12", token: "" })).toBe(false); // invalid
    expect(canSave(house!, { applicationId: OTHER_APP_ID, token: "" })).toBe(true);
    expect(canSave(house!, { token: TOKEN })).toBe(true);
    expect(canSave(house!, { token: APP_ID })).toBe(false);
    expect(canSave(house!, { applicationId: OTHER_APP_ID, token: APP_ID })).toBe(false);
  });

  it("the invite and intents follow the typed value, falling back to the stored one", () => {
    const [house] = buildPickerEntries(botsFile({ orchestrator: bot("house", { applicationId: APP_ID }) }), []);
    expect(effectiveApplicationId(house!, EMPTY_DRAFT)).toBe(APP_ID);
    expect(effectiveApplicationId(house!, { applicationId: ` ${OTHER_APP_ID} `, token: "" })).toBe(OTHER_APP_ID);
    expect(effectiveApplicationId(house!, { applicationId: "", token: "" })).toBe("");
  });

  it("summarizes the changes for the save bar", () => {
    const [, , lumi] = buildPickerEntries(botsFile(), [waifu("aria"), waifu("lumi")]);
    expect(changeSummary(lumi!, { applicationId: APP_ID, token: TOKEN })).toEqual(["link her bot", "Application ID", "bot token"]);
    expect(changeSummary(lumi!, EMPTY_DRAFT)).toEqual([]);
    expect(draftChanges(lumi!, { token: `  ${TOKEN}\n` })).toEqual({ token: TOKEN });
  });
});

describe("save payloads", () => {
  it("House: writes the orchestrator entry only, keeps its stored fields, carries the new token", () => {
    const current = botsFile({
      orchestrator: bot("house", { displayName: "House", applicationId: APP_ID, tokenConfigured: true, tokenHint: "…zz", enabled: false }),
      waifus: [bot("aria", { applicationId: OTHER_APP_ID, tokenConfigured: true })]
    });
    const [house] = buildPickerEntries(current, []);
    const body = buildBotsPatch(house!, { token: TOKEN }, current)!;
    expect(body).toEqual({ revision: 7, orchestrator: { id: "house", displayName: "House", enabled: false, applicationId: APP_ID, token: TOKEN } });
    expect(Object.keys(body)).not.toContain("waifus");
    // Only the clean write fields: no tokenConfigured / tokenHint echo.
    expect(Object.keys(body.orchestrator!).sort()).toEqual(["applicationId", "displayName", "enabled", "id", "token"]);
  });

  it("House: creates the entry on a fresh install", () => {
    const current = botsFile();
    const [house] = buildPickerEntries(current, []);
    expect(buildBotsPatch(house!, { applicationId: ` ${APP_ID} `, token: "" }, current)).toEqual({
      revision: 7,
      orchestrator: { id: "house", displayName: "House", enabled: true, applicationId: APP_ID }
    });
  });

  it("existing waifu bot: replaces her entry in waifus[] and sends every other entry back unchanged, without tokens", () => {
    const current = botsFile({
      waifus: [
        bot("mina", { applicationId: OTHER_APP_ID, tokenConfigured: true, tokenHint: "…mm" }),
        bot("aria", { applicationId: OTHER_APP_ID })
      ]
    });
    const cast = [waifu("aria", { botId: "aria" }), waifu("mina", { botId: "mina" })];
    const aria = buildPickerEntries(current, cast).find((entry) => entry.key === "aria")!;
    const body = buildBotsPatch(aria, { applicationId: APP_ID, token: TOKEN }, current)!;
    expect(body.waifus).toEqual([
      { id: "mina", displayName: "mina", enabled: true, applicationId: OTHER_APP_ID },
      { id: "aria", displayName: "aria", enabled: true, applicationId: APP_ID, token: TOKEN }
    ]);
    expect(body.orchestrator).toBeUndefined();
    expect(JSON.stringify(body.waifus![0])).not.toContain("token");
  });

  it("a linked waifu whose bot entry is missing gets one created under her botId", () => {
    const current = botsFile();
    const zed = buildPickerEntries(current, [waifu("zed", { botId: "custom-bot", displayName: "Zed" })]).find((entry) => entry.key === "zed")!;
    expect(buildBotsPatch(zed, { token: TOKEN }, current)!.waifus).toEqual([
      { id: "custom-bot", displayName: "Zed", enabled: true, token: TOKEN }
    ]);
  });

  it("writes nothing when nothing changed", () => {
    const current = botsFile({ orchestrator: bot("house", { applicationId: APP_ID }) });
    const [house] = buildPickerEntries(current, []);
    expect(buildBotsPatch(house!, { applicationId: APP_ID, token: "" }, current)).toBeUndefined();
  });

  function fakeDeps(initial: DiscordBotsFile) {
    let file = initial;
    const calls: string[] = [];
    const bodies: BotsWriteBody[] = [];
    const links: Array<{ waifuId: string; body: { applicationId?: string } }> = [];
    const deps: SaveDeps = {
      getBots: async () => {
        calls.push("get");
        return file;
      },
      linkWaifuBot: async (waifuId, body) => {
        calls.push("link");
        links.push({ waifuId, body });
        // What POST /api/waifus/:id/link-bot does: ensure the entry (id = her id) with the app id.
        file = { ...file, revision: file.revision + 1, waifus: [...file.waifus, bot(waifuId, { ...(body.applicationId ? { applicationId: body.applicationId } : {}) })] };
        return { botId: waifuId };
      },
      putBots: async (body) => {
        calls.push("put");
        bodies.push(body);
      },
      reload: async () => {
        calls.push("reload");
      }
    };
    return { deps, calls, bodies, links };
  }

  it("saveBotDraft, House: reads the file fresh, writes, then reloads", async () => {
    const { deps, calls, bodies, links } = fakeDeps(botsFile({ orchestrator: bot("house", { applicationId: APP_ID }) }));
    const [house] = buildPickerEntries(botsFile({ orchestrator: bot("house", { applicationId: APP_ID }) }), []);
    const outcome = await saveBotDraft(deps, house!, { token: TOKEN });
    expect(calls).toEqual(["get", "put", "reload"]);
    expect(links).toEqual([]);
    expect(bodies[0]!.orchestrator).toMatchObject({ id: "house", applicationId: APP_ID, token: TOKEN });
    expect(outcome).toEqual({ botId: "house", linked: false, wrote: true });
  });

  it("saveBotDraft, new waifu bot: links her first (with the Application ID), then stores the token", async () => {
    const { deps, calls, bodies, links } = fakeDeps(botsFile({ waifus: [bot("mina", { tokenConfigured: true })] }));
    const lumi = buildPickerEntries(botsFile(), [waifu("lumi", { displayName: "Lumi" })])[1]!;
    const outcome = await saveBotDraft(deps, lumi, { applicationId: APP_ID, token: TOKEN });
    expect(calls).toEqual(["link", "get", "put", "reload"]);
    expect(links).toEqual([{ waifuId: "lumi", body: { applicationId: APP_ID } }]);
    // The link already stored the app id; the write carries the token, her entry and everyone else's.
    expect(bodies[0]!.waifus).toEqual([
      { id: "mina", displayName: "mina", enabled: true },
      { id: "lumi", displayName: "lumi", enabled: true, applicationId: APP_ID, token: TOKEN }
    ]);
    expect(bodies[0]!.revision).toBe(8);
    expect(outcome).toEqual({ botId: "lumi", linked: true, wrote: true });
  });

  it("saveBotDraft, new waifu bot with only an Application ID: the link is the whole write", async () => {
    const { deps, calls, bodies } = fakeDeps(botsFile());
    const lumi = buildPickerEntries(botsFile(), [waifu("lumi")])[1]!;
    const outcome = await saveBotDraft(deps, lumi, { applicationId: APP_ID, token: "" });
    expect(calls).toEqual(["link", "get", "reload"]);
    expect(bodies).toEqual([]);
    expect(outcome).toMatchObject({ linked: true, wrote: false });
  });

  it("saveBotDraft, existing waifu bot: no link call", async () => {
    const start = botsFile({ waifus: [bot("aria", { applicationId: APP_ID })] });
    const { deps, calls, links } = fakeDeps(start);
    const aria = buildPickerEntries(start, [waifu("aria", { botId: "aria" })])[1]!;
    await saveBotDraft(deps, aria, { token: TOKEN });
    expect(links).toEqual([]);
    expect(calls).toEqual(["get", "put", "reload"]);
  });

  it("saveBotDraft refuses an empty or invalid draft and does not reload on a failed write", async () => {
    const { deps, calls } = fakeDeps(botsFile());
    const [house] = buildPickerEntries(botsFile(), []);
    await expect(saveBotDraft(deps, house!, EMPTY_DRAFT)).rejects.toThrow(/nothing valid/);
    await expect(saveBotDraft(deps, house!, { applicationId: "123", token: "" })).rejects.toThrow(/nothing valid/);
    expect(calls).toEqual([]);

    const failing: SaveDeps = { ...deps, putBots: async () => { throw new Error("Record has changed since it was read."); } };
    await expect(saveBotDraft(failing, house!, { token: TOKEN })).rejects.toThrow("Record has changed since it was read.");
    expect(calls).toEqual(["get"]);
  });
});

describe("connection status", () => {
  const status = (overrides: Record<string, unknown>) => ({ botId: "x", displayName: "x", kind: "waifu" as const, state: "connected" as const, updatedAt: AT, ...overrides });
  const runtime = (bots: ReturnType<typeof status>[]) => ({ discord: { connected: true, houseConnected: true, waifuBotCount: 1, warnings: [], bots } });

  it("finds the House bot by kind and a waifu bot by its entry id", () => {
    const entries = buildPickerEntries(botsFile({ orchestrator: bot("house") }), [waifu("aria", { botId: "aria-bot" })]);
    const state = runtime([status({ botId: "house", kind: "house" }), status({ botId: "aria-bot", state: "error", errorCode: "invalid_token" })]);
    expect(connectionFor(entries[0]!, state)?.state).toBe("connected");
    expect(connectionFor(entries[1]!, state)?.errorCode).toBe("invalid_token");
    expect(connectionFor(entries[1]!, undefined)).toBeUndefined();
    expect(connectionFor(entries[1]!, runtime([]))).toBeUndefined();
  });

  it("labels states and knows when a save has settled", () => {
    expect(connectionLabel(undefined)).toEqual({ tone: "neutral", text: "not running" });
    expect(connectionLabel(status({}))).toEqual({ tone: "ok", text: "connected" });
    expect(connectionLabel(status({ state: "error", errorCode: "disallowed_intents" }))).toEqual({ tone: "err", text: "error: disallowed intents" });
    expect(connectionSettled(status({ state: "connecting" }))).toBe(false);
    expect(connectionSettled(status({ state: "error" }))).toBe(true);
    expect(connectionSettled(undefined)).toBe(false);
  });
});

describe("the guide's markup", () => {
  function render(options: { houseOnly?: boolean; draft?: { applicationId?: string; token: string }; selectedKey?: string; tokenConfigured?: boolean }) {
    const bots = botsFile({
      orchestrator: bot("house", { applicationId: APP_ID, tokenConfigured: options.tokenConfigured ?? true, tokenHint: "…wxyz" })
    });
    const targets = buildPickerEntries(bots, [waifu("lumi", { displayName: "Lumi" })], { houseOnly: options.houseOnly });
    const selected = targets.find((target) => target.key === (options.selectedKey ?? "house"))!;
    const noop = () => undefined;
    const setup = {
      bots: { data: bots },
      runtime: { data: undefined },
      targets,
      selected,
      select: noop,
      draft: options.draft ?? EMPTY_DRAFT,
      setApplicationId: noop,
      setToken: noop,
      dirty: false,
      saveable: false,
      saving: false,
      save: async () => false,
      result: undefined,
      clearResult: noop,
      status: undefined,
      watching: false,
      loading: false,
      error: undefined
    } as unknown as DiscordBotSetup;
    return renderToStaticMarkup(createElement(DiscordBotGuide, { setup, onOpenRooms: noop }));
  }

  it("ties every input to a label and keeps the token field write-only", () => {
    const html = render({ draft: { token: "" } });
    const token = /<input[^>]*type="password"[^>]*>/.exec(html)![0];
    const tokenId = /id="([^"]+)"/.exec(token)![1]!;
    expect(html).toContain(`for="${tokenId}"`);
    expect(token).toMatch(/autocomplete="off"/i);
    expect(token).not.toMatch(/value="[^"]/);
    expect(html).toContain("A token is already stored (…wxyz)");
    expect(html).toMatch(/<label[^>]*for="[^"]*-app-id"/);
  });

  it("suggests the exact name and the test-copy note, and builds the invite from what is typed", () => {
    const house = render({ draft: { applicationId: OTHER_APP_ID, token: "" } });
    expect(house).toContain("<code>House</code>");
    expect(house).toContain("<code>House Test</code>");
    expect(house).toContain(`client_id=${OTHER_APP_ID}`);
    expect(house).not.toContain(`client_id=${APP_ID}`);
    const waifuHtml = render({ selectedKey: "lumi", draft: { applicationId: APP_ID, token: "" } });
    expect(waifuHtml).toContain("<code>Lumi</code>");
    expect(waifuHtml).toContain("<code>Lumi Test</code>");
    expect(waifuHtml).toContain("no privileged intents");
    expect(waifuHtml).toContain("Open Rooms");
  });

  it("shows a keyboard-usable radio picker with a legend, and none in House-only mode", () => {
    const html = render({});
    expect(html).toContain("<legend");
    expect(html).toContain("Which bot?");
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    const only = render({ houseOnly: true });
    expect(only).not.toContain('type="radio"');
    expect(only).not.toContain("Which bot?");
  });

  it("flags an invalid Application ID as it is typed", () => {
    const html = render({ draft: { applicationId: "12345", token: "" } });
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("17 to 20 digits");
  });
});
