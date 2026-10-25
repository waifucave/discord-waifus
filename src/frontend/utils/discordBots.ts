// Pure logic behind the interactive Discord bot guide: which bots the picker offers, what a draft
// changes, and how Save writes it. No React and no network here; `saveBotDraft` takes the API
// calls as arguments so tests can run it against fakes. A bot token is only ever held in the
// caller's memory: nothing here logs, stores or returns one except inside the request body.
import type {
  DiscordBotConfig,
  DiscordBotConnectionStatus,
  DiscordBotsFile,
  RuntimeState,
  WaifuConfig
} from "../api/types";
import { isLikelyApplicationId, type BotKind } from "./discord";

export const HOUSE_KEY = "house";
/** The id the House bot gets when the bots file has no `orchestrator` entry yet. */
export const HOUSE_BOT_ID = "house";

/** One entry of the "Which bot?" picker. */
export type BotTarget = {
  /** `house`, or the waifu's id (waifu ids can't be `house`: the picker would clash). */
  key: string;
  kind: BotKind;
  waifuId?: string;
  /** Shown in the picker. */
  label: string;
  /** The exact name step 1 suggests for the Discord application. */
  suggestedName: string;
  /** The id of the bots-file entry that holds (or will hold) this bot. */
  botId: string;
  /** House: always. Waifu: her `botId` is set (she can post only when it is). */
  linked: boolean;
  /** The stored entry, token redacted by the server. */
  bot: DiscordBotConfig | null;
};

export type BotDraft = {
  /** Undefined = untouched (the stored value stands). */
  applicationId?: string;
  /** Write-only; never pre-filled. */
  token: string;
};

export const EMPTY_DRAFT: BotDraft = { token: "" };

export function buildPickerEntries(
  bots: DiscordBotsFile | undefined,
  waifus: readonly WaifuConfig[] | undefined,
  options: { houseOnly?: boolean } = {}
): BotTarget[] {
  const house = bots?.orchestrator ?? null;
  const entries: BotTarget[] = [
    {
      key: HOUSE_KEY,
      kind: "house",
      label: "House bot",
      suggestedName: "House",
      botId: house?.id ?? HOUSE_BOT_ID,
      linked: true,
      bot: house
    }
  ];
  if (options.houseOnly) return entries;
  for (const waifu of waifus ?? []) {
    const name = waifu.displayName || waifu.name;
    // Linked: the entry her `botId` names. Not linked yet: an entry with her own id (what
    // link-bot creates and reuses) still counts, so a half-finished setup shows its progress.
    const botId = waifu.botId ?? waifu.id;
    entries.push({
      key: waifu.id,
      kind: "waifu",
      waifuId: waifu.id,
      label: name,
      suggestedName: name,
      botId,
      linked: waifu.botId !== undefined,
      bot: (bots?.waifus ?? []).find((bot) => bot.id === botId) ?? null
    });
  }
  return entries;
}

export type SetupSummary = {
  applicationId?: string;
  tokenConfigured: boolean;
  tokenHint?: string;
  /** Everything a bot still lacks before it can log in (empty = fully set up). */
  missing: string[];
  /** One line for the picker and the Settings list. */
  text: string;
};

export function summarizeTarget(target: BotTarget): SetupSummary {
  const applicationId = target.bot?.applicationId;
  const tokenConfigured = target.bot?.tokenConfigured === true;
  const tokenHint = target.bot?.tokenHint;
  const missing: string[] = [];
  if (!target.linked) missing.push("not linked to her");
  if (!applicationId) missing.push("no app id");
  if (!tokenConfigured) missing.push("no token");
  const parts = [
    applicationId ? `app ${applicationId}` : "no app id",
    tokenConfigured ? `token set${tokenHint ? ` (${tokenHint})` : ""}` : "no token"
  ];
  const text = target.linked || target.kind === "house" ? parts.join(" · ") : `not linked · ${parts.join(" · ")}`;
  return { ...(applicationId ? { applicationId } : {}), tokenConfigured, ...(tokenHint ? { tokenHint } : {}), missing, text };
}

/** Short badge for the chip picker: "ready", or what is still missing. */
export function setupBadge(target: BotTarget): { tone: "ok" | "warn" | "neutral"; text: string } {
  const summary = summarizeTarget(target);
  if (summary.missing.length === 0) return { tone: "ok", text: "bot ready" };
  if (!target.bot && !target.linked) return { tone: "neutral", text: "no bot yet" };
  return { tone: "warn", text: summary.missing.join(", ") };
}

export type FieldCheck = { state: "empty" | "valid" | "invalid"; message?: string };

/** Live check for the Application ID input: 17 to 20 digits. */
export function checkApplicationId(value: string): FieldCheck {
  const trimmed = value.trim();
  if (!trimmed) return { state: "empty" };
  if (isLikelyApplicationId(trimmed)) return { state: "valid" };
  if (/\D/.test(trimmed)) return { state: "invalid", message: "Digits only: copy the number under APPLICATION ID, not the name or the public key." };
  return { state: "invalid", message: `A Discord application ID has 17 to 20 digits (this has ${trimmed.length}).` };
}

/** Soft check for the token input: a hint, never a block (Discord may change the format). */
export function checkToken(value: string): FieldCheck {
  if (!value) return { state: "empty" };
  const trimmed = value.trim();
  if (!trimmed) return { state: "invalid", message: "That is only spaces." };
  if (isLikelyApplicationId(trimmed)) {
    return { state: "invalid", message: "That looks like an Application ID. The token comes from the Bot tab (Reset Token)." };
  }
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return { state: "invalid", message: "That looks like the Public Key from General Information. The token comes from the Bot tab (Reset Token)." };
  }
  if (/\s/.test(trimmed)) return { state: "invalid", message: "A token has no spaces or line breaks; paste only the token." };
  if (trimmed.split(".").length !== 3) {
    return { state: "valid", message: "Discord tokens usually have three parts separated by dots. Check that you copied all of it." };
  }
  return { state: "valid" };
}

export function effectiveApplicationId(target: BotTarget, draft: BotDraft): string {
  return (draft.applicationId ?? target.bot?.applicationId ?? "").trim();
}

/** What Save would change, field by field (empty when nothing). */
export function draftChanges(target: BotTarget, draft: BotDraft): { applicationId?: string; token?: string } {
  const changes: { applicationId?: string; token?: string } = {};
  const appId = draft.applicationId?.trim();
  if (appId && appId !== target.bot?.applicationId) changes.applicationId = appId;
  const token = draft.token.trim();
  if (token) changes.token = token;
  return changes;
}

export function isDirty(target: BotTarget, draft: BotDraft): boolean {
  return Object.keys(draftChanges(target, draft)).length > 0;
}

/** Save is allowed when something changed and nothing typed is known to be wrong. */
export function canSave(target: BotTarget, draft: BotDraft): boolean {
  if (draft.applicationId !== undefined && checkApplicationId(draft.applicationId).state === "invalid") return false;
  if (draft.token && checkToken(draft.token).state === "invalid") return false;
  return Object.keys(draftChanges(target, draft)).length > 0;
}

/** Names of the fields Save will write, for the save bar. */
export function changeSummary(target: BotTarget, draft: BotDraft): string[] {
  const changes = draftChanges(target, draft);
  const names: string[] = [];
  if (target.kind === "waifu" && !target.linked && Object.keys(changes).length > 0) names.push("link her bot");
  if (changes.applicationId) names.push("Application ID");
  if (changes.token) names.push("bot token");
  return names;
}

/** The write shape the server accepts (`UpdateDiscordBotsBodySchema`): clean fields only. */
export type BotWrite = { id: string; displayName: string; enabled: boolean; applicationId?: string; token?: string };
export type BotsWriteBody = { revision: number; orchestrator?: BotWrite; waifus?: BotWrite[] };

function cleanBot(bot: DiscordBotConfig): BotWrite {
  return {
    id: bot.id,
    displayName: bot.displayName,
    enabled: bot.enabled !== false,
    ...(bot.applicationId ? { applicationId: bot.applicationId } : {})
  };
}

/**
 * The `PUT /api/discord-bots` body that applies a draft to the bots file as read just now, or
 * undefined when it would change nothing. The server merges stored tokens by id when a token is
 * omitted, so only the entry being saved carries one. The House bot lives under `orchestrator`;
 * waifu bots replace the whole `waifus` array, so every other entry is sent back unchanged.
 */
export function buildBotsPatch(target: BotTarget, draft: BotDraft, current: DiscordBotsFile): BotsWriteBody | undefined {
  const changes = draftChanges(target, draft);
  if (!changes.applicationId && !changes.token) return undefined;
  const existing = target.kind === "house" ? current.orchestrator : current.waifus.find((bot) => bot.id === target.botId) ?? null;
  const id = existing?.id ?? target.botId;
  const applicationId = changes.applicationId ?? existing?.applicationId;
  const entry: BotWrite = {
    id,
    displayName: existing?.displayName ?? target.suggestedName,
    enabled: existing ? existing.enabled !== false : true,
    ...(applicationId ? { applicationId } : {}),
    ...(changes.token ? { token: changes.token } : {})
  };
  if (target.kind === "house") return { revision: current.revision, orchestrator: entry };
  const replaced = current.waifus.some((bot) => bot.id === id);
  const waifus = replaced
    ? current.waifus.map((bot) => (bot.id === id ? entry : cleanBot(bot)))
    : [...current.waifus.map(cleanBot), entry];
  return { revision: current.revision, waifus };
}

export type SaveDeps = {
  getBots: () => Promise<DiscordBotsFile>;
  linkWaifuBot: (waifuId: string, body: { applicationId?: string }) => Promise<{ botId: string }>;
  putBots: (body: BotsWriteBody) => Promise<unknown>;
  reload: () => Promise<unknown>;
};

export type SaveOutcome = { botId: string; linked: boolean; wrote: boolean };

/**
 * Saves a draft the way the guide's Save button does:
 *  1. a waifu with no bot yet is linked first (`POST /api/waifus/:id/link-bot` ensures her entry,
 *     sets its Application ID and sets her `botId`);
 *  2. the bots file is read again (so the write carries the latest revision and the entry the link
 *     created) and the token and any remaining change are written with `PUT /api/discord-bots`;
 *  3. Discord is reloaded.
 * A failure throws and leaves the caller's draft alone, so the user can retry.
 */
export async function saveBotDraft(deps: SaveDeps, target: BotTarget, draft: BotDraft): Promise<SaveOutcome> {
  if (!canSave(target, draft)) throw new Error("There is nothing valid to save yet.");
  let linked = false;
  let resolved = target;
  if (target.kind === "waifu" && !target.linked) {
    const changes = draftChanges(target, draft);
    const result = await deps.linkWaifuBot(target.waifuId!, changes.applicationId ? { applicationId: changes.applicationId } : {});
    linked = true;
    resolved = { ...target, linked: true, botId: result.botId };
  }
  const current = await deps.getBots();
  // The target's snapshot may predate the link or another tab's save: compare against the file.
  const stored = resolved.kind === "house" ? current.orchestrator : current.waifus.find((bot) => bot.id === resolved.botId) ?? null;
  const body = buildBotsPatch({ ...resolved, bot: stored }, draft, current);
  if (body) await deps.putBots(body);
  await deps.reload();
  return { botId: resolved.botId, linked, wrote: body !== undefined };
}

/** The runtime's connection status for a target, when the runtime reports it. */
export function connectionFor(target: BotTarget, runtime: Pick<RuntimeState, "discord"> | undefined): DiscordBotConnectionStatus | undefined {
  const bots = runtime?.discord.bots;
  if (!bots) return undefined;
  return target.kind === "house" ? bots.find((bot) => bot.kind === "house") : bots.find((bot) => bot.kind === "waifu" && bot.botId === target.botId);
}

export function connectionLabel(status: DiscordBotConnectionStatus | undefined): { tone: "ok" | "warn" | "err" | "neutral"; text: string } {
  if (!status) return { tone: "neutral", text: "not running" };
  switch (status.state) {
    case "connected":
      return { tone: "ok", text: "connected" };
    case "connecting":
      return { tone: "warn", text: "connecting" };
    case "missing_token":
      return { tone: "warn", text: "no token" };
    case "disabled":
      return { tone: "neutral", text: "disabled" };
    case "error":
      return { tone: "err", text: status.errorCode ? `error: ${status.errorCode.replace(/_/g, " ")}` : "error" };
  }
}

/** True once a freshly saved bot has settled (connected, or failed), so polling can stop. */
export function connectionSettled(status: DiscordBotConnectionStatus | undefined): boolean {
  return status !== undefined && (status.state === "connected" || status.state === "error" || status.state === "disabled");
}
