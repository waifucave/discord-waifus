// The settings registry (overhaul spec §10.2–§10.3 with Living cast §11.3's keys, §14.2): every
// setting the owner can change, with its group, storage, HTTP routes and help text. The schemas are
// the stored ones (never copies); types, bounds and defaults are read from them (introspect.ts). A
// test walks every group's schema and fails when a leaf has no entry here (or no HTTP route, CLI path
// or help text), so a new field cannot ship undocumented.

import { AppConfigSchema, DEFAULT_APP_CONFIG } from "../schemas/config.js";
import { createRevisionedBase } from "../schemas/common.js";
import {
  AssistantConfigSchema,
  DiscordBotConfigSchema,
  ProviderCredentialsSchema,
  ServerConfigSchema,
  WaifuConfigSchema
} from "../schemas/domain.js";
import { RemoteAccessConfigV1Schema } from "../schemas/remoteLifecycle.js";
import type { ResourceTopic, SettingGroup, SettingGroupId } from "./types.js";

const ENVELOPE = {
  schemaVersion: "File format version (set by the app).",
  revision: "Write counter (set by the app; send it back to avoid lost updates).",
  updatedAt: "Last write time (set by the app)."
};

const live = { applies: "live" } as const;
const reload = { applies: "reload" } as const;
const restart = { applies: "restart" } as const;

export const ChannelEntrySchema = ServerConfigSchema.shape.channels.unwrap().valueType;

const APP: SettingGroup = {
  id: "app",
  title: "App",
  summary: "Host-wide settings in config.toml: HTTP, Discord, OCR, compaction, models, life limits, web search, the detector, updates.",
  description:
    "The host's config.toml. GET /api/config reads it and PUT /api/config takes a partial patch (omitted keys keep their values); the host then reloads its Discord runtime unless only `updates` changed. With the host stopped, `waifus set app …` writes config.toml directly.",
  target: { kind: "singleton" },
  storage: "config.toml",
  read: { method: "GET", path: "/api/config" },
  write: { method: "PUT", path: "/api/config", revision: "none" },
  schema: AppConfigSchema,
  defaults: () => DEFAULT_APP_CONFIG,
  excluded: { schemaVersion: ENVELOPE.schemaVersion },
  keys: {
    "http.host": { help: "The interface the dashboard and API listen on. Keep it on loopback (127.0.0.1); Remote Access never needs it changed.", localOnlyWrite: true, remoteHidden: true, ...restart, example: "127.0.0.1" },
    "http.port": { help: "The dashboard and API port.", ...restart, example: "3888" },
    "runtime.autoConnectDiscord": { help: "Connect the Discord bots when the host starts.", ...reload, example: "true" },
    "runtime.paused": { help: "Pause every life: no wakes are routed and no turn starts; queues are kept and catch up on resume. `waifus set app runtime.paused true` is the same as Pause in the dashboard.", ...live, example: "false" },
    "frontend.staticDir": { help: "Serve the dashboard from this folder instead of the bundled build (development only). The dashboard on this computer uses it at once; Remote Access's copy at the next start.", localOnlyWrite: true, remoteHidden: true, nullUnset: true, ...live, example: "dist-frontend" },
    "ocr.enabled": { help: "Read text out of images for models without image input.", ...live, example: "true" },
    "ocr.engine": { help: "OCR engine: auto (Apple Vision on macOS, else the bundled Tesseract), apple-vision, bundled-tesseract or system-tesseract.", ...live, example: "auto" },
    "ocr.cacheTtlHours": { help: "How long OCR results are cached.", unit: "hours", ...live, example: "168" },
    "ocr.timeoutMs": { help: "Time limit for one image's OCR.", unit: "ms", ...live, example: "1500" },
    "ocr.maxImageBytes": { help: "Images larger than this are not read.", unit: "bytes", ...live, example: "8388608" },
    "ocr.maxImagesPerModelCall": { help: "At most this many images are read for one model call.", ...live, example: "4" },
    "ocr.maxTextCharsPerImage": { help: "OCR text kept per image.", unit: "characters", ...live, example: "1500" },
    "compaction.enabled": { help: "Summarise her life when it gets long (off: truncate at the same points, with no summary).", ...live, example: "true" },
    "compaction.triggerRatio": { help: "Compact when her prompt reaches this share of her context budget (life.maxContextTokens or the model's window).", ...live, example: "0.7" },
    "compaction.maxMessages": { help: "Kept for older conversation uses; lives use life.maxLogMessages instead.", ...live, example: "150" },
    "compaction.keepRecent": { help: "Kept for older conversation uses; lives keep their last three complete turns instead.", ...live, example: "30" },
    "compaction.waitTimeoutMs": { help: "How long a caller waits for a running compaction before moving on.", unit: "ms", ...live, example: "6000" },
    "discord.images.maxBytes": { help: "Largest Discord image downloaded.", unit: "bytes", ...live, example: "5242880" },
    "discord.images.fetchTimeoutMs": { help: "Time limit for one image download.", unit: "ms", ...live, example: "5000" },
    "discord.images.memoryCacheMb": { help: "In-memory image cache size.", unit: "MB", ...live, example: "64" },
    "discord.images.diskCacheMb": { help: "On-disk image cache size.", unit: "MB", ...live, example: "256" },
    "discord.images.diskCacheTtlHours": { help: "How long downloaded images are kept on disk (a forget cannot remove a cached guild image, or a DM image no image index recorded, before this).", unit: "hours", ...live, example: "168" },
    "discord.guildMembersIntent": { help: "Use Discord's privileged Server Members intent for full member lists. Enable it in the Developer Portal first; changing it re-logs the House bot.", ...reload, example: "false" },
    "discord.memberListRefreshHours": { help: "How often full member lists are refreshed (0 = never).", unit: "hours", ...live, example: "24" },
    "discord.debounce.serverMs": { help: "Quiet time before a burst of server messages goes to the addressee detector.", unit: "ms", ...live, example: "1200" },
    "discord.debounce.serverMaxWaitMs": { help: "A burst goes to the detector after at most this long.", unit: "ms", ...live, example: "4000" },
    "discord.debounce.dmMs": { help: "A DM wakes her this long after the person's last message (each message restarts the timer).", unit: "ms", ...live, example: "30000" },
    "discord.debounce.dmMaxWaitMs": { help: "A DM wakes her after at most this long, however often the person keeps writing.", unit: "ms", ...live, example: "180000" },
    "discord.dm.resumeWindowMinutes": { help: "At start, messages that arrived while the host was down wake her only when they are at most this old (older ones stay readable).", unit: "minutes", ...live, example: "60" },
    "models.allowed": { help: "The curated model routes waifus and the assistant may use (winter route keys such as anthropic/claude-sonnet-5-5). Routes the installed catalog lacks are hidden.", leaf: true, ...reload, example: '["anthropic/claude-haiku-5-5","openai/gpt-6-luna"]' },
    "models.maxOutputUsdPerMTok": { help: "Routes above this output price per million tokens are hidden (at most 10).", unit: "USD", ...reload, example: "10" },
    "life.maxConcurrentTurns": { help: "How many lives may run a turn at the same time on this host.", ...reload, example: "4" },
    "life.maxToolRounds": { help: "A turn ends after this many model calls.", ...reload, example: "12" },
    "life.maxTurnMs": { help: "A turn ends after this long.", unit: "ms", ...reload, example: "180000" },
    "life.maxLogMessages": { help: "Compact her life when its log reaches this many messages.", ...reload, example: "400" },
    "life.maxContextTokens": { help: "Her context budget: compaction keeps every request under this (and under the model's window), below long-context price tiers.", unit: "tokens", ...reload, example: "96000" },
    "life.maxInlineImagesPerEpoch": { help: "Images shown to her as images per epoch; later ones are described by their OCR text.", ...reload, example: "8" },
    "life.maxInlineImageBytesPerEpoch": { help: "Image bytes shown to her as images per epoch.", unit: "bytes", ...reload, example: "12582912" },
    "life.maxSendPlacesPerTurn": { help: "Distinct places she may send to in one turn.", ...reload, example: "3" },
    "life.maxSendsPerTurn": { help: "Messages she may send in one turn.", ...reload, example: "8" },
    "life.maxWakesPerUserPerHour": { help: "Direct or detector wakes one person may cause her per hour in servers; the rest are merged into one line.", ...reload, example: "20" },
    "life.maxWatchFiresPerDay": { help: "How often one of her repeating watches may fire per day.", ...reload, example: "24" },
    "life.maxWaifuTriggeredTurns": { help: "Room loop guard: after this many waifu-written messages woke someone in a place since the last human message there, further waifu messages wake nobody (0 = off).", ...reload, example: "0" },
    "life.maintenanceHourLocal": { help: "Local hour of nightly maintenance for a waifu with no sleep window (with one, it runs 30 minutes into her sleep).", unit: "hour 0–23", ...reload, example: "5" },
    "life.webFetch.model": { help: "Route for reading long web pages (\"\" = the cheapest offered route with a key; name a contributor route here to allow one).", ...reload, example: "openai/gpt-6-luna" },
    "life.webFetch.maxPerWaifuPerDay": { help: "Pages one waifu may fetch per day (0 = no WebFetch).", ...reload, example: "20" },
    "life.webFetch.maxPerTurn": { help: "Pages she may fetch in one turn (0 = no WebFetch).", ...reload, example: "3" },
    "life.webFetch.directMaxChars": { help: "A page this short is given to her as is; longer ones are read by one digest call.", unit: "characters", ...reload, example: "2000" },
    "life.webFetch.maxBytes": { help: "Largest page downloaded.", unit: "bytes", ...reload, example: "5242880" },
    "life.webFetch.timeoutMs": { help: "Time limit for one page.", unit: "ms", ...reload, example: "20000" },
    "life.webFetch.maxRedirects": { help: "Redirects followed (each hop is checked against private addresses).", ...reload, example: "5" },
    "life.webFetch.cacheMinutes": { help: "Fetched pages are cached this long.", unit: "minutes", ...reload, example: "15" },
    "life.home.maxBytes": { help: "Her home folder (her notes, reminders, watches and anything she keeps) may hold at most this much; a write past it is refused.", unit: "bytes", ...live, example: "52428800" },
    "life.home.maxFiles": { help: "Files her home folder may hold.", ...live, example: "2000" },
    "life.tmp.maxBytes": { help: "Her /tmp (downloads and scratch files) may hold at most this much; the oldest files there are deleted when a download would not fit.", unit: "bytes", ...live, example: "209715200" },
    "life.tmp.retentionDays": { help: "Files in her /tmp are deleted this many days after they were last written (her home is never touched).", unit: "days", ...live, example: "7" },
    "life.attachments.maxBytes": { help: "Largest attachment ReadMessages downloads into her /tmp (images, PDFs and text files; larger ones are only listed).", unit: "bytes", ...live, example: "10485760" },
    "life.send.maxFiles": { help: "Files she may attach to one message (0 = none).", ...reload, example: "4" },
    "life.bash.enabled": { help: "Offer her the simulated Bash (just-bash over a copy of her two folders; never a real program, no network). Off: the tool is not offered.", ...reload, example: "true" },
    "life.bash.python": { help: "Let her Bash run python3 (CPython compiled to WebAssembly, inside the same isolation).", ...reload, example: "true" },
    "life.bash.maxTimeoutMs": { help: "The longest one Bash command may run (she asks for up to this; the default is 10 seconds). The worker is terminated at the limit and nothing is saved.", unit: "ms", ...reload, example: "60000" },
    "life.bash.maxOutputChars": { help: "Bash output she sees (the rest is cut).", unit: "characters", ...live, example: "16000" },
    "search.maxPerSecond": { help: "Web searches started per second, host-wide (paced, not refused; 0 = no WebSearch).", ...reload, example: "2" },
    "search.maxPerDay": { help: "Web searches per day, host-wide (0 = no WebSearch). The optional Exa key is the `exa` provider credential, not config.", ...reload, example: "50" },
    "search.maxPerWaifuPerDay": { help: "Web searches one waifu may make per day (0 = no WebSearch).", ...reload, example: "20" },
    "detector.target": { help: "The addressee detector (who is an unaddressed message for?): a native-choice decision model such as openrouter:cloudflare/clef, openai:gpt-6-luna or laya:english; \"\" turns it off (then a first message in 10 minutes or a question wakes one waifu at random). Also GET/PUT /api/detector/config.", ...reload, example: "openrouter:cloudflare/clef" },
    "updates.enabled": { help: "Install newer patch releases automatically when every managed process is idle (global npm installs only).", localOnlyWrite: true, ...live, example: "false" },
    "updates.checkIntervalMinutes": { help: "How often npm is checked for a newer patch release.", unit: "minutes", localOnlyWrite: true, ...live, example: "60" },
    "updates.idleMinutes": { help: "How long everything must be quiet before an update installs.", unit: "minutes", localOnlyWrite: true, ...live, example: "5" }
  }
};

const WAIFU: SettingGroup = {
  id: "waifu",
  title: "Waifu",
  summary: "One character: persona, style, model, schedule, wake-on-name, daily budget and DM settings.",
  description:
    "`user/waifus/<id>/waifu.json`. Writes are partial and need the revision you read (the CLI sends it; a stale one is a 409). Changes to what her prompt contains take effect at her next turn through a compaction.",
  target: { kind: "id", idName: "waifuId", idKind: "safe-id", example: "aria" },
  storage: "user/waifus/<waifuId>/waifu.json",
  list: { method: "GET", path: "/api/waifus" },
  read: { method: "GET", path: "/api/waifus/:waifuId" },
  write: { method: "PUT", path: "/api/waifus/:waifuId", revision: "required" },
  schema: WaifuConfigSchema,
  defaults: () => WaifuConfigSchema.parse({ ...createRevisionedBase(), id: "example", name: "Example", displayName: "Example" }),
  excluded: { ...ENVELOPE },
  keys: {
    id: { help: "Her id (the folder name; fixed when she is created).", readOnly: true },
    name: { help: "Her name (also a wake word when wakeOnName is on).", example: "Aria" },
    displayName: { help: "The name shown in the dashboard and her prompt.", example: "Aria" },
    enabled: { help: "In the cast (off: she is benched and never wakes).", example: "true" },
    persona: { help: "Who she is: voice, history, quirks, relationships.", example: "Aria is a sunny baker who loves lemon tarts." },
    model: { help: "Her model: {providerId, modelId, effort?} from GET /api/models (or `provider/model[@effort]` on the command line). Contributor variants share prompts for training; pick one only on purpose.", leaf: true, nullUnset: true, example: "anthropic/claude-haiku-5-5" },
    botId: { help: "Her own Discord bot (a discord-bots entry id). Without one she cannot post or receive DMs.", nullUnset: true, example: "aria" },
    "availability.sleep.enabled": { help: "She sleeps every day in this window: every wake but the owner's waits for the morning.", example: "true" },
    "availability.sleep.start": { help: "When her sleep starts (local time).", unit: "HH:mm", example: "23:00" },
    "availability.sleep.end": { help: "When her sleep ends (local time).", unit: "HH:mm", example: "07:00" },
    "availability.busy": { help: "Daily busy blocks [{start, end, reason}] (HH:mm, local). Wakes still reach her; she knows she is busy.", leaf: true, example: '[{"start":"09:00","end":"12:00","reason":"bakery shift"}]' },
    verbosity: { help: "How long her messages are: terse, chatty or expressive.", example: "chatty" },
    customInstructions: { help: "Extra instructions added to her prompt (at most 4000 characters).", example: "Never talk about politics." },
    scheduleInPrompt: { help: "Tell her about her schedule (sleep and busy blocks) in her prompt.", example: "true" },
    wakeOnName: { help: "Her name, display name or server nickname in a message wakes her (turn off for names that are common words).", example: "true" },
    "life.dailyBudgetUsd": { help: "Her spending limit per local day in USD; when reached, wakes wait for the next day (the owner's wakes still go through). null = no budget.", nullIsValue: true, unit: "USD", example: "2.5" },
    "dm.allowDms": { help: "Accept DMs on her own bot (she must be the only enabled waifu on it and have a model).", example: "true" },
    "dm.rateLimit": { help: "Replies per person per window: {maxReplies, windowMinutes}; null = unlimited.", leaf: true, nullIsValue: true, example: '{"maxReplies":30,"windowMinutes":60}' },
    "dm.notifyWhenLimited": { help: "Send the limit notice once when a person reaches the limit.", example: "true" },
    "dm.limitNotice": { help: "The limit notice (\"\" = the built-in one; at most 300 characters).", example: "I need a little break, talk soon!" },
    "dm.sleepNotice": { help: "Sent once per sleep window when someone DMs her while she sleeps (\"\" = none; no model call).", example: "I'm asleep, I'll answer in the morning." }
  }
};

const SERVER: SettingGroup = {
  id: "server",
  title: "Server",
  summary: "One Discord server: its name, the pause switch and the detector override.",
  description: "`user/servers/<guildId>/server.json`. A server is live unless paused; a channel is live when it has an enabled waifu (see the channel group).",
  target: { kind: "id", idName: "guildId", idKind: "snowflake", example: "100000000000000001" },
  storage: "user/servers/<guildId>/server.json",
  list: { method: "GET", path: "/api/servers" },
  read: { method: "GET", path: "/api/servers/:guildId" },
  write: { method: "PUT", path: "/api/servers/:guildId", revision: "optional" },
  schema: ServerConfigSchema,
  defaults: () => ServerConfigSchema.parse({ ...createRevisionedBase(), guildId: "100000000000000001" }),
  excluded: { ...ENVELOPE, channels: "Edit channels with the channel group (`waifus set channel:<guild>/<channel> …`)." },
  keys: {
    guildId: { help: "The server's Discord id.", readOnly: true },
    name: { help: "The server's name (refreshed from Discord).", example: "Bake Club" },
    paused: { help: "The server's kill switch: messages are observed but wake nobody until it is switched back on.", example: "false" },
    "detector.target": { help: "This server's addressee detector target, overriding the app's detector.target (\"\" = no detector here). Unset to inherit.", nullUnset: true, example: "laya:english" }
  }
};

const CHANNEL: SettingGroup = {
  id: "channel",
  title: "Channel",
  summary: "One channel of a server: who is cast there, and whether its threads inherit the cast.",
  description: "Stored inside the server's server.json. Target it as `channel:<guildId>/<channelId>`.",
  target: { kind: "id", idName: "guildId/channelId", idKind: "snowflake-pair", example: "100000000000000001/200000000000000002" },
  storage: "user/servers/<guildId>/server.json (channels.<channelId>)",
  read: { method: "GET", path: "/api/servers/:guildId" },
  write: { method: "PUT", path: "/api/servers/:guildId/channels/:channelId", revision: "optional" },
  schema: ChannelEntrySchema,
  defaults: () => ChannelEntrySchema.parse({ channelId: "200000000000000002" }),
  excluded: { thread: "Runtime-only overlay for threads; never stored." },
  keys: {
    channelId: { help: "The channel's Discord id.", readOnly: true },
    name: { help: "The channel's name (refreshed from Discord).", example: "general" },
    enabledWaifuIds: { help: "The waifus cast in this channel (a JSON list of ids, or ids separated by commas). Empty = silent.", leaf: true, example: "aria,mina" },
    threads: { help: "Threads and forum posts under this channel inherit its cast (inherit) or stay silent (off).", example: "inherit" }
  }
};

const ASSISTANT: SettingGroup = {
  id: "assistant",
  title: "Assistant",
  summary: "The dashboard assistant's own model.",
  description: "`user/assistant/config.json`. Unset, the assistant borrows a waifu's model (an offered, non-contributor model whose provider has a key).",
  target: { kind: "singleton" },
  storage: "user/assistant/config.json",
  read: { method: "GET", path: "/api/assistant/config" },
  write: { method: "PUT", path: "/api/assistant/config", revision: "optional" },
  schema: AssistantConfigSchema,
  excluded: { ...ENVELOPE },
  keys: {
    model: { help: "The assistant's model: {providerId, modelId, effort?} from GET /api/models (or `provider/model[@effort]`).", leaf: true, nullUnset: true, example: "openai/gpt-6-luna" }
  }
};

const BOT: SettingGroup = {
  id: "bot",
  title: "Discord bot",
  summary: "A Discord bot: the House bot (`bot:house`) or a waifu's bot (`bot:<id>`). Tokens are write-only.",
  description:
    "`user/discord-bots.json`. The House bot reads every server message and hosts /wake and /print (stored under the `orchestrator` key); each waifu posts through her own bot. Writes merge by id and keep stored tokens; the runtime reloads to reconnect.",
  target: { kind: "id", idName: "botId", idKind: "bot", example: "house" },
  storage: "user/discord-bots.json",
  read: { method: "GET", path: "/api/discord-bots" },
  write: { method: "PUT", path: "/api/discord-bots", revision: "optional" },
  schema: DiscordBotConfigSchema,
  defaults: () => DiscordBotConfigSchema.parse({ id: "example", displayName: "Example" }),
  excluded: {},
  keys: {
    id: { help: "The bot entry's id (`house` for the House bot; a waifu's bot usually has her id).", readOnly: true },
    displayName: { help: "Name shown in the dashboard.", example: "Aria" },
    applicationId: { help: "The Discord application id (not secret; from the Developer Portal).", example: "400000000000000004" },
    token: { help: "The bot token. Never on the command line: `waifus set bot:<id> token --from-env VAR` or pipe it on stdin. Never shown again.", secret: true },
    enabled: { help: "Log this bot in (off keeps it offline).", example: "true" }
  }
};

const PROVIDER: SettingGroup = {
  id: "provider",
  title: "Provider key",
  summary: "An API key for a model provider (anthropic, openai, openrouter, …) or `exa` for web search.",
  description: "`user/providers.json`. Keys are write-only: reads show a hint of the last characters. Saving a key clears a quota or billing cooldown for that provider.",
  target: { kind: "id", idName: "providerId", idKind: "provider", example: "anthropic" },
  storage: "user/providers.json",
  read: { method: "GET", path: "/api/providers" },
  write: { method: "PUT", path: "/api/providers/:providerId/credentials", revision: "optional" },
  schema: ProviderCredentialsSchema,
  excluded: { providerId: "The target id.", createdAt: "Set by the app.", updatedAt: "Set by the app." },
  keys: {
    apiKey: { help: "The API key. Never on the command line: `waifus set provider:<id> apiKey --from-env VAR` or pipe it on stdin. `waifus unset provider:<id> apiKey` removes it.", secret: true },
    label: { help: "A label for the key. Setting it re-sends the key, so give the key too (--from-env or stdin).", example: "personal" }
  }
};

const REMOTE_ACCESS: SettingGroup = {
  id: "remote-access",
  title: "Remote Access",
  summary: "Remote Access on this host: on/off and the name other devices see.",
  description: "Managed by the Remote Access helper. Enabling needs an activated installation (428 ActivationRequired until then); pairing and devices are in Settings → Remote Access.",
  target: { kind: "singleton" },
  storage: "app/remote-access/ (helper-owned)",
  read: { method: "GET", path: "/api/remote-access" },
  write: { method: "PUT", path: "/api/remote-access", revision: "uint64-string" },
  schema: RemoteAccessConfigV1Schema,
  excluded: { revision: ENVELOPE.revision, updatedAt: ENVELOPE.updatedAt },
  keys: {
    enabled: { help: "Remote Access on this host (direct connections only; never relayed).", example: "false" },
    displayName: { help: "The name paired devices see (1–80 characters).", example: "Living room Mac" }
  }
};

export const SETTING_GROUPS: readonly SettingGroup[] = Object.freeze([APP, WAIFU, SERVER, CHANNEL, ASSISTANT, BOT, PROVIDER, REMOTE_ACCESS]);

export function settingGroup(id: string): SettingGroup | undefined {
  return SETTING_GROUPS.find((group) => group.id === id);
}

export function requireGroup(id: SettingGroupId): SettingGroup {
  return settingGroup(id)!;
}

/** Topics that are not settings: what they are, their routes and their CLI commands. */
export const RESOURCE_TOPICS: readonly ResourceTopic[] = Object.freeze([
  {
    id: "life",
    title: "A waifu's life",
    summary: "Status, the life log, owner wakes, a manual compaction and a reset; her files, reminders and watches.",
    description:
      "Each waifu is an autonomous agent with one continuous life: wakes arrive as notifications, she decides what to do with her tools, and only her sends reach people. The life log hides DM content unless a local request reveals it (includePrivate=1; never over Remote Access). Compact summarises her life now; reset starts a fresh epoch with no summary (her files and queued wakes stay). Each waifu has her own computer: her home /home/<name> (her notes in any layout, MEMORY.md her index, schedule.json her reminders, watches.json her watches, places.md kept by the app) and /tmp (files people sent, deleted 7 days after the last write). The files routes list, read, write and delete them under the same checks as her Write tool (places.md refused, the JSON files checked with line and column; revision by content hash, expectedHash). A file from a private chat is listed as [private chat redacted] and opens only with a local includePrivate=1; a watch bound to a DM is redacted the same way.",
    routes: [
      { method: "GET", path: "/api/waifus/:waifuId/life" },
      { method: "GET", path: "/api/waifus/:waifuId/life/log" },
      { method: "POST", path: "/api/waifus/:waifuId/wake" },
      { method: "POST", path: "/api/waifus/:waifuId/life/compact" },
      { method: "POST", path: "/api/waifus/:waifuId/life/reset" },
      { method: "GET", path: "/api/waifus/:waifuId/life/needs-review" },
      { method: "DELETE", path: "/api/waifus/:waifuId/life/needs-review/:itemId" },
      { method: "GET", path: "/api/waifus/:waifuId/files" },
      { method: "GET", path: "/api/waifus/:waifuId/files/*" },
      { method: "PUT", path: "/api/waifus/:waifuId/files/*" },
      { method: "DELETE", path: "/api/waifus/:waifuId/files/*" },
      { method: "GET", path: "/api/waifus/:waifuId/schedule" },
      { method: "DELETE", path: "/api/waifus/:waifuId/schedule/:reminderId" },
      { method: "GET", path: "/api/waifus/:waifuId/watches" },
      { method: "DELETE", path: "/api/waifus/:waifuId/watches/:watchId" }
    ],
    cli: ["waifus life <waifu> [--log] [--private]", "waifus wake <waifu> [note]", "waifus files <waifu> [path] [--root tmp] [--private]", "waifus schedule <waifu>", "waifus watches <waifu> [--private]"]
  },
  {
    id: "forget",
    title: "Forget a person",
    summary: "The owner's best-effort scrub of one Discord user (spec §7.5).",
    description:
      "POST /api/people/:userId/forget {confirm: true, dryRun?} deletes the person's DMs with every waifu, removes them from member lists and the archive, and scrubs every life (her summary, queued wakes, her reminders and watches, and every text file in her home, then a verification pass; her downloads of the person's files and copies of them are deleted). A part that fails answers 202 with `pending` and runs again at the next start (given up after 3 tries, with an owner notice). Review lines (names someone else shares) are kept per waifu for the owner.",
    routes: [
      { method: "POST", path: "/api/people/:userId/forget" },
      { method: "GET", path: "/api/people/forget-jobs" },
      { method: "GET", path: "/api/owner-notices" }
    ],
    cli: ["waifus forget <userId> [--yes] [--dry-run]"]
  },
  {
    id: "usage",
    title: "Usage and cost",
    summary: "Model calls and cost from the usage ledger, by local day, waifu, purpose, model, turn or place.",
    description: "GET /api/usage?from&to&groupBy&tz reads user/usage/*.jsonl (one line per model call) with local-day boundaries; GET /api/search/usage shows today's web searches and the newest queries.",
    routes: [
      { method: "GET", path: "/api/usage" },
      { method: "GET", path: "/api/search/usage" }
    ],
    cli: ["waifus usage [--from DAY] [--to DAY] [--by KEY[,KEY]] [--waifu ID] [--tz ZONE]"]
  },
  {
    id: "detector",
    title: "Addressee detector",
    summary: "Who is a message nobody addressed for? The detector's target, models and history.",
    description: "GET/PUT /api/detector/config is the app's detector.target; GET /api/detector/models lists the decision models; GET /api/detector/history?guildId shows a server's last 300 results. A server may override the target (server group, detector.target).",
    routes: [
      { method: "GET", path: "/api/detector/config" },
      { method: "PUT", path: "/api/detector/config" },
      { method: "GET", path: "/api/detector/models" },
      { method: "GET", path: "/api/detector/history" }
    ],
    cli: ["waifus get app detector.target", "waifus set app detector.target <target>"]
  },
  {
    id: "runtime",
    title: "Runtime",
    summary: "Status, pause and resume, reload, owner notices and diagnostics.",
    description: "GET /api/runtime is the live status (bots, queues, warnings, model notices); pause stops every life without losing queues; reload rebuilds the Discord runtime.",
    routes: [
      { method: "GET", path: "/api/runtime" },
      { method: "POST", path: "/api/runtime/pause" },
      { method: "POST", path: "/api/runtime/resume" },
      { method: "POST", path: "/api/runtime/reload" },
      { method: "GET", path: "/api/owner-notices" },
      { method: "GET", path: "/api/diagnostics/bundle" }
    ],
    cli: ["waifus status", "waifus doctor", "waifus set app runtime.paused true"]
  },
  {
    id: "environment",
    title: "Environment variables",
    summary: "Settings that live in the environment, not in config.toml.",
    description:
      "DC_WAIFUS_HOME overrides the data root (default ~/.dc-waifus). DC_WAIFUS_LAYA_PYTHON points the local Laya detector at a Python with its packages (host only; never accepted through the API).",
    routes: [],
    cli: ["DC_WAIFUS_HOME=PATH waifus start"]
  }
]);
