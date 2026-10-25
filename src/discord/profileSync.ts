// Discord profile sync (Living cast spec §17): her own bot's username, avatar and banner
// (PATCH /users/@me), her bio as the application description (PATCH /applications/@me) and her
// per-server nicknames (PATCH /guilds/{id}/members/@me), set from her waifu config and the images
// uploaded in the dashboard. Only a waifu bot that exactly one waifu uses is ever edited; the House
// bot never. Only fields that differ are sent, an image is re-uploaded only when its bytes changed
// (or Discord shows another image), and rate limits are recorded per field with their retry time
// in `app/discord-profile-sync.json`, so a reconnect or a restart never hammers Discord.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Logger } from "../backend/logger.js";
import { atomicWriteJson } from "../storage/atomic.js";
import type { StorageService } from "../storage/storageService.js";
import { resolveDataPath } from "../config/paths.js";
import { discordUsernameProblem, DISCORD_PROFILE_FIELDS, type DiscordProfileField } from "../shared/constants/discordProfile.js";
import type { DiscordBotsFile, WaifuConfig } from "../shared/schemas/domain.js";
import {
  DiscordProfileWarningSchema,
  type DiscordProfileState,
  type DiscordProfileStatus,
  type DiscordProfileWarning
} from "../shared/schemas/api.js";
import { listWaifus, readDiscordBotsFile } from "../orchestration/stores/config.js";

// ---- images ------------------------------------------------------------------------------------

export type ProfileImageKind = "pfp" | "banner";

export const PROFILE_IMAGE_EXT_BY_MIME: Readonly<Record<string, string>> = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
});

/** Upload limit for her avatar and banner (Discord takes up to 10 MB; the API sends base64). */
export const PROFILE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** The image type the bytes really are (PNG, JPEG, GIF or WebP), from their first bytes. */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 4 && b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a")) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return undefined;
}

export type ProfileImage = { contentType: string; bytes: Buffer; hash: string };

/** Her uploaded avatar (`pfp`) or banner, if any: `user/waifus/<id>/<kind>.<ext>`. */
export async function readWaifuProfileImage(dataRoot: string, waifuId: string, kind: ProfileImageKind): Promise<ProfileImage | undefined> {
  for (const [contentType, ext] of Object.entries(PROFILE_IMAGE_EXT_BY_MIME)) {
    let bytes: Buffer;
    try {
      bytes = await readFile(resolveDataPath(dataRoot, "user", "waifus", waifuId, `${kind}.${ext}`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    return { contentType, bytes, hash: createHash("sha256").update(bytes).digest("hex") };
  }
  return undefined;
}

export function imageDataUri(image: ProfileImage): string {
  return `data:${image.contentType};base64,${image.bytes.toString("base64")}`;
}

// ---- the bot, as the sync sees it ----------------------------------------------------------------

/** Her bot's account. `banner` undefined: Discord did not say (not fetched). */
export type BotProfileUser = { id: string; username: string; avatar: string | null; banner?: string | null };
export type BotProfileGuild = { guildId: string; nickname: string | null; canChangeNickname: boolean };

/** One connected waifu bot's profile operations (the gateway builds it over discord.js). */
export interface BotProfileHandle {
  user(): BotProfileUser;
  /** PATCH /users/@me with only the given fields; images are data URIs. */
  editUser(patch: { username?: string; avatar?: string; banner?: string }): Promise<BotProfileUser>;
  fetchApplicationDescription(): Promise<string>;
  /** PATCH /applications/@me { description }. */
  editApplicationDescription(description: string): Promise<void>;
  guilds(): BotProfileGuild[];
  /** PATCH /guilds/{id}/members/@me { nick } (null clears it). */
  setNickname(guildId: string, nick: string | null): Promise<void>;
}

// ---- persisted record ----------------------------------------------------------------------------

export const PROFILE_SYNC_PATH = ["app", "discord-profile-sync.json"] as const;

const ProfileFieldSchema = z.enum(DISCORD_PROFILE_FIELDS);
const SyncedImageSchema = z.object({ contentHash: z.string(), discordHash: z.string().nullable() });

const BotProfileRecordSchema = z.object({
  waifuId: z.string(),
  /** The Discord user the record is about: another account behind the same entry starts over. */
  discordUserId: z.string().optional(),
  avatar: SyncedImageSchema.optional(),
  banner: SyncedImageSchema.optional(),
  /** The description last set or seen. */
  bio: z.string().optional(),
  /** Nicknames the app set, per guild (so removing an override clears only what the app set). */
  nicknames: z.record(z.string(), z.string()).default({}),
  lastSyncedAt: z.string().optional(),
  lastAttemptAt: z.string().optional(),
  pendingFields: z.array(ProfileFieldSchema).default([]),
  retryAfter: z.record(z.string(), z.string()).default({}),
  lastError: z.string().optional(),
  warnings: z.array(DiscordProfileWarningSchema).default([])
});
export type BotProfileRecord = z.infer<typeof BotProfileRecordSchema>;

const ProfileSyncFileSchema = z.object({ bots: z.record(z.string(), BotProfileRecordSchema).default({}) });
type ProfileSyncFile = z.infer<typeof ProfileSyncFileSchema>;

function emptyRecord(waifuId: string, discordUserId?: string): BotProfileRecord {
  return {
    waifuId,
    ...(discordUserId ? { discordUserId } : {}),
    nicknames: {},
    pendingFields: [],
    retryAfter: {},
    warnings: []
  };
}

async function readSyncFile(dataRoot: string): Promise<ProfileSyncFile> {
  try {
    return ProfileSyncFileSchema.parse(JSON.parse(await readFile(resolveDataPath(dataRoot, ...PROFILE_SYNC_PATH), "utf8")));
  } catch {
    // Missing or unreadable: nothing synced yet (the next sync compares against Discord again).
    return { bots: {} };
  }
}

// ---- desired profile -----------------------------------------------------------------------------

export type DesiredUsername = {
  value: string | null;
  source: "username" | "displayName" | "name" | null;
  warning?: DiscordProfileWarning;
};

/** Her `username`, else her displayName, else her name (the first that Discord would accept). */
export function desiredUsername(waifu: Pick<WaifuConfig, "username" | "displayName" | "name">): DesiredUsername {
  if (waifu.username) return { value: waifu.username.trim(), source: "username" };
  for (const source of ["displayName", "name"] as const) {
    const candidate = waifu[source]?.trim();
    if (candidate && !discordUsernameProblem(candidate)) return { value: candidate, source };
  }
  return {
    value: null,
    source: null,
    warning: {
      code: "username_fallback_invalid",
      message: "Her display name and name are not valid Discord usernames, so her bot's username is left alone. Set a username."
    }
  };
}

export type DesiredProfile = {
  username: string | null;
  /** Undefined: the app does not manage her application description. */
  bio?: string;
  nicknames: Record<string, string>;
  avatarHash?: string;
  bannerHash?: string;
};

export type ProfilePlan = {
  /** Fields of PATCH /users/@me to send now. */
  user: { username?: string; avatar?: true; banner?: true };
  bio?: string;
  nicknames: Array<{ guildId: string; nick: string | null }>;
  /** Fields that differ from Discord (sent now or waiting for a rate limit). */
  pending: DiscordProfileField[];
  /** Pending fields held back until their retry time. */
  waiting: DiscordProfileField[];
  warnings: DiscordProfileWarning[];
};

function imageInSync(hash: string, synced: BotProfileRecord["avatar"], currentDiscordHash: string | null | undefined): boolean {
  if (!synced || synced.contentHash !== hash) return false;
  // Discord shows another image (someone changed it elsewhere): ours goes up again.
  return currentDiscordHash === undefined || synced.discordHash === currentDiscordHash;
}

/**
 * What to send (pure). `currentBio` undefined means "not fetched": the record's last known
 * description stands in for it.
 */
export function planProfileSync(input: {
  desired: DesiredProfile;
  user: BotProfileUser;
  guilds: BotProfileGuild[];
  currentBio?: string;
  record: BotProfileRecord;
  now: number;
}): ProfilePlan {
  const { desired, user, record, now } = input;
  const plan: ProfilePlan = { user: {}, nicknames: [], pending: [], waiting: [], warnings: [] };
  const waitingFor = (field: DiscordProfileField) => {
    const until = record.retryAfter[field];
    return until !== undefined && Date.parse(until) > now;
  };
  const want = (field: DiscordProfileField, apply: () => void) => {
    plan.pending.push(field);
    if (waitingFor(field)) plan.waiting.push(field);
    else apply();
  };
  if (desired.username !== null && desired.username !== user.username) want("username", () => (plan.user.username = desired.username!));
  if (desired.avatarHash && !imageInSync(desired.avatarHash, record.avatar, user.avatar)) want("avatar", () => (plan.user.avatar = true));
  if (desired.bannerHash && !imageInSync(desired.bannerHash, record.banner, user.banner)) want("banner", () => (plan.user.banner = true));
  if (desired.bio !== undefined && (input.currentBio ?? record.bio) !== desired.bio) want("bio", () => (plan.bio = desired.bio));

  const nicknameChanges: Array<{ guildId: string; nick: string | null }> = [];
  const joined = new Set(input.guilds.map((guild) => guild.guildId));
  for (const guild of input.guilds) {
    const wanted = desired.nicknames[guild.guildId];
    const setByApp = record.nicknames[guild.guildId];
    let nick: string | null | undefined;
    if (wanted !== undefined) nick = guild.nickname === wanted ? undefined : wanted;
    else if (setByApp !== undefined && guild.nickname === setByApp) nick = null; // override removed: clear ours
    if (nick === undefined) continue;
    if (!guild.canChangeNickname) {
      plan.warnings.push({
        code: "missing_permission",
        guildId: guild.guildId,
        message: "Her bot lacks the Change Nickname permission in this server, so her nickname there is left alone."
      });
      continue;
    }
    nicknameChanges.push({ guildId: guild.guildId, nick });
  }
  for (const guildId of Object.keys(desired.nicknames)) {
    if (!joined.has(guildId)) {
      plan.warnings.push({ code: "not_in_server", guildId, message: "Her bot is not in this server; the nickname applies once it joins." });
    }
  }
  if (nicknameChanges.length > 0) want("nickname", () => plan.nicknames.push(...nicknameChanges));
  return plan;
}

// ---- errors ----------------------------------------------------------------------------------------

/** Discord does not say when a username rate limit ends; wait this long before trying again. */
export const USERNAME_RATE_LIMIT_FALLBACK_MS = 60 * 60 * 1000;

export type ProfileErrorKind =
  | { kind: "rate_limited"; retryAfterMs: number; usernameOnly: boolean }
  | { kind: "missing_permission" }
  | { kind: "error"; message: string };

/** discord.js RateLimitError (rejectOnRateLimit), a 429, Discord's username rate limit (50035), 50013. */
export function classifyProfileError(error: unknown): ProfileErrorKind {
  const e = (error ?? {}) as {
    name?: string;
    message?: string;
    status?: number;
    code?: number | string;
    retryAfter?: number;
    rawError?: { retry_after?: number; errors?: unknown; message?: string };
  };
  if (e.name === "RateLimitError" || (typeof e.retryAfter === "number" && e.status === undefined)) {
    return { kind: "rate_limited", retryAfterMs: Math.max(0, e.retryAfter ?? 0), usernameOnly: false };
  }
  if (e.status === 429) {
    const seconds = typeof e.rawError?.retry_after === "number" ? e.rawError.retry_after : 60;
    return { kind: "rate_limited", retryAfterMs: Math.ceil(seconds * 1000), usernameOnly: false };
  }
  if (Number(e.code) === 50035) {
    const detail = JSON.stringify(e.rawError?.errors ?? {});
    if (/USERNAME_RATE_LIMIT|USERNAME_TOO_MANY_USERS|too fast/iu.test(`${detail} ${e.message ?? ""}`)) {
      return { kind: "rate_limited", retryAfterMs: USERNAME_RATE_LIMIT_FALLBACK_MS, usernameOnly: true };
    }
  }
  if (Number(e.code) === 50013) return { kind: "missing_permission" };
  return { kind: "error", message: e.message ? String(e.message).slice(0, 500) : String(error).slice(0, 500) };
}

// ---- who may be edited -----------------------------------------------------------------------------

export type ProfileTarget =
  | { ok: true; waifu: WaifuConfig; botId: string }
  | { ok: false; waifu?: WaifuConfig; botId: string | null; reason: "no_bot" | "bot_missing" | "shared_bot" };

/** Her bot, if the app may edit it: a waifu-bot entry (never the House bot) that only she uses. */
export function profileTargetOf(waifu: WaifuConfig, waifus: WaifuConfig[], bots: DiscordBotsFile): ProfileTarget {
  const botId = waifu.botId;
  if (!botId) return { ok: false, waifu, botId: null, reason: "no_bot" };
  const entry = bots.waifus.find((bot) => bot.id === botId);
  if (!entry || botId === bots.orchestrator?.id) return { ok: false, waifu, botId, reason: "bot_missing" };
  if (waifus.filter((other) => other.botId === botId).length > 1) return { ok: false, waifu, botId, reason: "shared_bot" };
  return { ok: true, waifu, botId };
}

// ---- the service ------------------------------------------------------------------------------------

export type ProfileSyncDiscord = {
  /** The connected waifu bot's profile handle; undefined for the House bot or an offline bot. */
  waifuBotProfile?(botId: string): BotProfileHandle | undefined;
  /** Ids of the waifu bots connected now. */
  connectedWaifuBotIds?(): string[];
};

export type DiscordProfileSyncOptions = {
  storage: StorageService;
  discord: () => ProfileSyncDiscord | undefined;
  logger?: Logger;
  now?: () => number;
};

const RETRY_SLACK_MS = 1_000;

export class DiscordProfileSync {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private fileLock: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: DiscordProfileSyncOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private get dataRoot(): string {
    return this.options.storage.dataRoot;
  }

  /** Every connected waifu bot (after a connect). */
  async syncAll(): Promise<void> {
    const ids = this.options.discord()?.connectedWaifuBotIds?.() ?? [];
    await Promise.all(ids.map((botId) => this.syncBot(botId)));
  }

  /** Her bot, after a change to her profile fields, her images or her bot link. */
  async syncWaifu(waifuId: string): Promise<void> {
    const waifus = await listWaifus(this.options.storage);
    const botId = waifus.find((waifu) => waifu.id === waifuId)?.botId;
    if (botId) await this.syncBot(botId);
  }

  /** One bot; runs after any sync of the same bot already in flight. */
  syncBot(botId: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const next = (this.chains.get(botId) ?? Promise.resolve())
      .then(() => (this.stopped ? undefined : this.run(botId)))
      .catch((error: unknown) => {
        this.options.logger?.warn("Discord profile sync failed", { botId, message: error instanceof Error ? error.message : String(error) });
      });
    this.chains.set(botId, next);
    void next.finally(() => {
      if (this.chains.get(botId) === next) this.chains.delete(botId);
    });
    return next;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all([...this.chains.values()]);
  }

  /** The dashboard's view of her profile sync (also without a runtime: `discord` gives nothing). */
  async status(waifuId: string): Promise<DiscordProfileStatus | undefined> {
    return discordProfileStatus({
      storage: this.options.storage,
      waifuId,
      handleFor: (botId) => this.options.discord()?.waifuBotProfile?.(botId),
      now: this.now()
    });
  }

  private async run(botId: string): Promise<void> {
    const [waifus, bots] = await Promise.all([listWaifus(this.options.storage), readDiscordBotsFile(this.options.storage)]);
    const users = waifus.filter((waifu) => waifu.botId === botId);
    if (users.length !== 1) return; // unlinked or shared: never touched
    const target = profileTargetOf(users[0]!, waifus, bots);
    if (!target.ok) return;
    const handle = this.options.discord()?.waifuBotProfile?.(botId);
    if (!handle) return;
    const waifu = target.waifu;
    const user = handle.user();
    const now = this.now();
    const nowIso = new Date(now).toISOString();

    const stored = (await readSyncFile(this.dataRoot)).bots[botId];
    const record: BotProfileRecord =
      stored && stored.waifuId === waifu.id && (!stored.discordUserId || stored.discordUserId === user.id)
        ? structuredClone(stored)
        : emptyRecord(waifu.id, user.id);
    record.discordUserId = user.id;
    for (const [field, until] of Object.entries(record.retryAfter)) {
      if (Date.parse(until) <= now) delete record.retryAfter[field];
    }

    const [avatar, banner] = await Promise.all([
      readWaifuProfileImage(this.dataRoot, waifu.id, "pfp"),
      readWaifuProfileImage(this.dataRoot, waifu.id, "banner")
    ]);
    const username = desiredUsername(waifu);
    const desired: DesiredProfile = {
      username: username.value,
      ...(waifu.bio !== undefined ? { bio: waifu.bio } : {}),
      nicknames: waifu.nicknames ?? {},
      ...(avatar ? { avatarHash: avatar.hash } : {}),
      ...(banner ? { bannerHash: banner.hash } : {})
    };

    const errors: string[] = [];
    const done = new Set<DiscordProfileField>();
    const failed = new Set<DiscordProfileField>();
    const runtimeWarnings: DiscordProfileWarning[] = [];
    const onError = (fields: DiscordProfileField[], error: unknown): ProfileErrorKind => {
      const kind = classifyProfileError(error);
      if (kind.kind === "rate_limited") {
        const until = new Date(now + kind.retryAfterMs + RETRY_SLACK_MS).toISOString();
        for (const field of kind.usernameOnly ? (["username"] as const) : fields) record.retryAfter[field] = until;
      } else if (kind.kind === "error") {
        errors.push(kind.message);
        for (const field of fields) failed.add(field);
      }
      return kind;
    };

    let currentBio: string | undefined;
    if (desired.bio !== undefined && !(record.retryAfter.bio && Date.parse(record.retryAfter.bio) > now)) {
      try {
        currentBio = await handle.fetchApplicationDescription();
      } catch (error) {
        onError(["bio"], error);
      }
    }

    const plan = planProfileSync({ desired, user, guilds: handle.guilds(), ...(currentBio !== undefined ? { currentBio } : {}), record, now });

    // PATCH /users/@me: username, avatar, banner in one request.
    const sendUser = async (fields: Array<"username" | "avatar" | "banner">): Promise<void> => {
      if (fields.length === 0) return;
      const patch: { username?: string; avatar?: string; banner?: string } = {};
      if (fields.includes("username")) patch.username = plan.user.username!;
      if (fields.includes("avatar") && avatar) patch.avatar = imageDataUri(avatar);
      if (fields.includes("banner") && banner) patch.banner = imageDataUri(banner);
      try {
        const after = await handle.editUser(patch);
        if (avatar && patch.avatar) record.avatar = { contentHash: avatar.hash, discordHash: after.avatar };
        if (banner && patch.banner) record.banner = { contentHash: banner.hash, discordHash: after.banner ?? null };
        for (const field of fields) {
          done.add(field);
          delete record.retryAfter[field];
        }
      } catch (error) {
        const kind = onError(fields, error);
        // Discord's username limit fails the whole request: the images go up on their own.
        if (kind.kind === "rate_limited" && kind.usernameOnly && fields.length > 1) {
          await sendUser(fields.filter((field) => field !== "username"));
        }
      }
    };
    await sendUser((["username", "avatar", "banner"] as const).filter((field) => plan.user[field] !== undefined));

    if (plan.bio !== undefined) {
      try {
        await handle.editApplicationDescription(plan.bio);
        record.bio = plan.bio;
        done.add("bio");
      } catch (error) {
        onError(["bio"], error);
      }
    } else if (currentBio !== undefined) {
      record.bio = currentBio;
    }

    for (const change of plan.nicknames) {
      try {
        await handle.setNickname(change.guildId, change.nick);
        if (change.nick === null) delete record.nicknames[change.guildId];
        else record.nicknames[change.guildId] = change.nick;
      } catch (error) {
        const kind = onError(["nickname"], error);
        if (kind.kind === "missing_permission") {
          runtimeWarnings.push({
            code: "missing_permission",
            guildId: change.guildId,
            message: "Discord refused her nickname change in this server (missing Change Nickname permission)."
          });
        }
      }
    }
    if (plan.nicknames.length > 0 && !failed.has("nickname") && !record.retryAfter.nickname) done.add("nickname");
    // Forget nicknames the app set where Discord now shows another one (someone renamed her there).
    for (const guild of handle.guilds()) {
      const setByApp = record.nicknames[guild.guildId];
      if (setByApp !== undefined && guild.nickname !== setByApp && desired.nicknames[guild.guildId] === undefined) {
        delete record.nicknames[guild.guildId];
      }
    }

    record.pendingFields = plan.pending.filter((field) => !done.has(field));
    record.warnings = [...(username.warning ? [username.warning] : []), ...plan.warnings, ...runtimeWarnings];
    record.lastAttemptAt = nowIso;
    if (errors.length > 0) record.lastError = errors.join("; ");
    else delete record.lastError;
    if (record.pendingFields.length === 0 && errors.length === 0) record.lastSyncedAt = nowIso;
    if (done.size > 0) {
      this.options.logger?.info("Discord profile synced", { botId, waifuId: waifu.id, fields: [...done] });
    }
    await this.saveRecord(botId, record);
    this.scheduleRetry(botId, record);
  }

  private async saveRecord(botId: string, record: BotProfileRecord): Promise<void> {
    const write = this.fileLock.then(async () => {
      const file = await readSyncFile(this.dataRoot);
      file.bots[botId] = record;
      await atomicWriteJson(resolveDataPath(this.dataRoot, ...PROFILE_SYNC_PATH), file);
    });
    this.fileLock = write.catch(() => undefined);
    await write;
  }

  private scheduleRetry(botId: string, record: BotProfileRecord): void {
    const existing = this.timers.get(botId);
    if (existing) clearTimeout(existing);
    this.timers.delete(botId);
    const times = record.pendingFields
      .map((field) => record.retryAfter[field])
      .filter((until): until is string => until !== undefined)
      .map((until) => Date.parse(until));
    if (times.length === 0 || this.stopped) return;
    const delay = Math.max(RETRY_SLACK_MS, Math.min(...times) - this.now());
    const timer = setTimeout(() => {
      this.timers.delete(botId);
      void this.syncBot(botId);
    }, delay);
    timer.unref?.();
    this.timers.set(botId, timer);
  }
}

/** Her profile sync status; `handleFor` gives her live bot (none: offline). */
export async function discordProfileStatus(input: {
  storage: StorageService;
  waifuId: string;
  handleFor?: (botId: string) => BotProfileHandle | undefined;
  now?: number;
}): Promise<DiscordProfileStatus | undefined> {
  const now = input.now ?? Date.now();
  const [waifus, bots, file] = await Promise.all([
    listWaifus(input.storage),
    readDiscordBotsFile(input.storage),
    readSyncFile(input.storage.dataRoot)
  ]);
  const waifu = waifus.find((candidate) => candidate.id === input.waifuId);
  if (!waifu) return undefined;
  const target = profileTargetOf(waifu, waifus, bots);
  const username = desiredUsername(waifu);
  const [avatar, banner] = await Promise.all([
    readWaifuProfileImage(input.storage.dataRoot, waifu.id, "pfp"),
    readWaifuProfileImage(input.storage.dataRoot, waifu.id, "banner")
  ]);
  const stored = target.botId ? file.bots[target.botId] : undefined;
  const record = stored && stored.waifuId === waifu.id ? stored : undefined;
  const handle = target.ok ? input.handleFor?.(target.botId) : undefined;
  const user = handle?.user();
  const usable = record && (!record.discordUserId || !user || record.discordUserId === user.id) ? record : undefined;

  const retryAfterByField = Object.fromEntries(
    Object.entries(usable?.retryAfter ?? {}).filter(([, until]) => Date.parse(until) > now)
  );
  let pendingFields: DiscordProfileField[] = usable?.pendingFields ?? [];
  let warnings: DiscordProfileWarning[] = usable?.warnings ?? (username.warning ? [username.warning] : []);
  if (handle && user) {
    const plan = planProfileSync({
      desired: {
        username: username.value,
        ...(waifu.bio !== undefined ? { bio: waifu.bio } : {}),
        nicknames: waifu.nicknames ?? {},
        ...(avatar ? { avatarHash: avatar.hash } : {}),
        ...(banner ? { bannerHash: banner.hash } : {})
      },
      user,
      guilds: handle.guilds(),
      record: usable ?? emptyRecord(waifu.id, user.id),
      now
    });
    pendingFields = plan.pending;
    warnings = [...(username.warning ? [username.warning] : []), ...plan.warnings];
  }
  const image = (img: ProfileImage | undefined, synced: BotProfileRecord["avatar"], discordHash: string | null | undefined) =>
    img ? { contentType: img.contentType, bytes: img.bytes.byteLength, synced: imageInSync(img.hash, synced, discordHash) } : null;

  let state: DiscordProfileState;
  if (!target.ok) state = target.reason;
  else if (!handle) state = "offline";
  else if (pendingFields.length === 0) state = "synced";
  else if (usable?.lastError) state = "error";
  else if (pendingFields.some((field) => retryAfterByField[field])) state = "rate_limited";
  else state = "pending";
  const retryTimes = pendingFields.map((field) => retryAfterByField[field]).filter((until): until is string => until !== undefined).sort();

  return {
    waifuId: waifu.id,
    botId: target.botId,
    state,
    username: { value: username.value, source: username.source },
    bio: waifu.bio ?? null,
    nicknames: waifu.nicknames ?? {},
    images: {
      avatar: image(avatar, usable?.avatar, user ? user.avatar : undefined),
      banner: image(banner, usable?.banner, user ? user.banner : undefined)
    },
    ...(user ? { current: { username: user.username, avatarSet: user.avatar !== null, bannerSet: user.banner === undefined ? null : user.banner !== null } } : {}),
    pendingFields,
    ...(usable?.lastSyncedAt ? { lastSyncedAt: usable.lastSyncedAt } : {}),
    ...(usable?.lastAttemptAt ? { lastAttemptAt: usable.lastAttemptAt } : {}),
    ...(retryTimes[0] ? { retryAfter: retryTimes[0] } : {}),
    retryAfterByField,
    ...(usable?.lastError && pendingFields.length > 0 ? { lastError: usable.lastError } : {}),
    warnings
  };
}
