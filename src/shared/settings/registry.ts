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
    "http.host": { label: "Listen address", help: "The interface the dashboard and API listen on. Keep it on loopback (127.0.0.1); Remote Access never needs it changed.", localOnlyWrite: true, remoteHidden: true, ...restart, example: "127.0.0.1" },
    "http.port": { label: "Port", help: "The dashboard and API port.", ...restart, example: "3888" },
    "runtime.autoConnectDiscord": { label: "Connect Discord at start", help: "Connect the Discord bots when the host starts.", ...reload, example: "true" },
    "runtime.paused": { label: "Paused", help: "Pause every life: no wakes are routed and no turn starts; queues are kept and catch up on resume. `waifus set app runtime.paused true` is the same as Pause in the dashboard.", ...live, example: "false" },
    "frontend.staticDir": { label: "Dashboard folder", help: "Serve the dashboard from this folder instead of the bundled build (development only). The dashboard on this computer uses it at once; Remote Access's copy at the next start.", localOnlyWrite: true, remoteHidden: true, nullUnset: true, ...live, example: "dist-frontend" },
    "ocr.enabled": { label: "Read text in images", help: "Read text out of images for models without image input.", ...live, example: "true" },
    "ocr.engine": { label: "OCR engine", help: "OCR engine: auto (Apple Vision on macOS, else the bundled Tesseract), apple-vision, bundled-tesseract or system-tesseract.", ...live, example: "auto" },
    "ocr.cacheTtlHours": { label: "Keep OCR results", help: "How long OCR results are cached.", unit: "hours", ...live, example: "168" },
    "ocr.timeoutMs": { label: "Time limit per image", help: "Time limit for one image's OCR.", unit: "ms", ...live, example: "1500" },
    "ocr.maxImageBytes": { label: "Largest image read", help: "Images larger than this are not read.", unit: "bytes", ...live, example: "8388608" },
    "ocr.maxImagesPerModelCall": { label: "Images read per model call", help: "At most this many images are read for one model call.", ...live, example: "4" },
    "ocr.maxTextCharsPerImage": { label: "Text kept per image", help: "OCR text kept per image.", unit: "characters", ...live, example: "1500" },
    "compaction.enabled": { label: "Summarise long lives", help: "Summarise her life when it gets long (off: truncate at the same points, with no summary).", ...live, example: "true" },
    "compaction.triggerRatio": { label: "Compact at share of context", help: "Compact when her prompt reaches this share of her context budget (life.maxContextTokens or the model's window).", ...live, example: "0.7" },
    "compaction.maxMessages": { label: "Messages kept (older uses)", help: "Kept for older conversation uses; lives use life.maxLogMessages instead.", ...live, example: "150" },
    "compaction.keepRecent": { label: "Recent messages kept (older uses)", help: "Kept for older conversation uses; lives keep their last three complete turns instead.", ...live, example: "30" },
    "compaction.waitTimeoutMs": { label: "Wait for a running compaction", help: "How long a caller waits for a running compaction before moving on.", unit: "ms", ...live, example: "6000" },
    "discord.images.maxBytes": { label: "Largest image downloaded", help: "Largest Discord image downloaded.", unit: "bytes", ...live, example: "5242880" },
    "discord.images.fetchTimeoutMs": { label: "Time limit per download", help: "Time limit for one image download.", unit: "ms", ...live, example: "5000" },
    "discord.images.memoryCacheMb": { label: "Image cache in memory", help: "In-memory image cache size.", unit: "MB", ...live, example: "64" },
    "discord.images.diskCacheMb": { label: "Image cache on disk", help: "On-disk image cache size.", unit: "MB", ...live, example: "256" },
    "discord.images.diskCacheTtlHours": { label: "Keep images on disk", help: "How long downloaded images are kept on disk (a forget cannot remove a cached guild image, or a DM image no image index recorded, before this).", unit: "hours", ...live, example: "168" },
    "discord.guildMembersIntent": { label: "Server Members intent", help: "Use Discord's privileged Server Members intent for full member lists. Enable it in the Developer Portal first; changing it re-logs the House bot.", ...reload, example: "false" },
    "discord.memberListRefreshHours": { label: "Refresh member lists every", help: "How often full member lists are refreshed (0 = never).", unit: "hours", ...live, example: "24" },
    "discord.debounce.serverMs": { label: "Quiet before a room wake", help: "A burst of server messages (mentions, replies, her name, and what goes to the addressee detector) wakes her this long after its last message; each message restarts the timer.", unit: "ms", ...live, example: "1500" },
    "discord.debounce.serverMaxWaitMs": { label: "Longest wait in a room", help: "A server burst wakes her after at most this long from its first message, however long people keep writing or typing.", unit: "ms", ...live, example: "10000" },
    "discord.debounce.dmMs": { label: "Quiet before a DM wake", help: "A DM wakes her this long after the person's last message (each message restarts the timer).", unit: "ms", ...live, example: "2500" },
    "discord.debounce.dmMaxWaitMs": { label: "Longest wait in a DM", help: "A DM wakes her after at most this long from its first message, however long the person keeps writing or typing.", unit: "ms", ...live, example: "60000" },
    "discord.debounce.typingHoldMs": { label: "Wait while someone types", help: "While someone whose messages are waiting is typing in that place, the wake waits: a typing event counts this long unless their next message comes first (0 = ignore typing).", unit: "ms", ...live, example: "6000" },
    "discord.dm.resumeWindowMinutes": { label: "Answer messages after a restart up to", help: "At start, messages that arrived while the host was down wake her only when they are at most this old (older ones stay readable).", unit: "minutes", ...live, example: "60" },
    "models.allowed": { label: "Allowed models", help: "The curated model routes waifus and the assistant may use (winter route keys such as anthropic/claude-sonnet-5-5). Routes the installed catalog lacks are hidden.", leaf: true, ...reload, example: '["anthropic/claude-haiku-5-5","openai/gpt-6-luna"]' },
    "models.maxOutputUsdPerMTok": { label: "Price cap per million output tokens", help: "Routes above this output price per million tokens are hidden (at most 10).", unit: "USD", ...reload, example: "10" },
    "life.maxConcurrentTurns": { label: "Turns at once", help: "How many lives may run a turn at the same time on this host.", ...reload, example: "4" },
    "life.maxTurnMs": { label: "Longest turn", help: "A turn ends after this long.", unit: "ms", ...reload, example: "180000" },
    "life.maxLogMessages": { label: "Compact after messages", help: "Compact her life when its log reaches this many messages.", ...reload, example: "400" },
    "life.maxContextTokens": { label: "Context budget", help: "Her context budget: compaction keeps every request under this (and under the model's window), below long-context price tiers.", unit: "tokens", ...reload, example: "96000" },
    "life.maxInlineImagesPerEpoch": { label: "Inline images per epoch", help: "Images shown to her as images per epoch; later ones are described by their OCR text.", ...reload, example: "8" },
    "life.maxInlineImageBytesPerEpoch": { label: "Inline image bytes per epoch", help: "Image bytes shown to her as images per epoch.", unit: "bytes", ...reload, example: "12582912" },
    "life.maxSendPlacesPerTurn": { label: "Places per turn", help: "Distinct places she may send to in one turn.", ...reload, example: "3" },
    "life.maxSendsPerTurn": { label: "Messages per turn", help: "Messages she may send in one turn.", ...reload, example: "8" },
    "life.maxWakesPerUserPerHour": { label: "Wakes per person per hour", help: "Direct or detector wakes one person may cause her per hour in servers; the rest are merged into one line.", ...reload, example: "20" },
    "life.maxWatchFiresPerDay": { label: "Watch fires per day", help: "How often one of her repeating watches may fire per day.", ...reload, example: "24" },
    "life.notificationLinesPerPlace": {
      label: "Notification lines per place",
      help: "Her notifications show one line per message; at most this many per place (the newest), the first saying how many earlier ones were left out.",
      ...reload,
      example: "8"
    },
    "life.maxWaifuTriggeredTurns": { label: "Room loop guard", help: "Room loop guard: after this many waifu-written messages woke someone in a place since the last human message there, further waifu messages wake nobody (0 = off).", ...reload, example: "0" },
    "life.maintenanceHourLocal": { label: "Maintenance hour", help: "Local hour of her nightly dream (and queued forget scrubs) for a waifu with no bed time (with one, she dreams once she has been asleep life.dreamAfterAsleepMinutes).", unit: "hour 0–23", ...reload, example: "5" },
    "life.dayStartHourLocal": { label: "Day start hour", help: "Local hour of the morning wake (she writes today's schedule in ~/life/schedule.json) for a waifu with no bed time; with one, it comes when her bed time ends.", unit: "hour 0–23", ...reload, example: "8" },
    "life.busyEngagedMinutes": { label: "Busy chat window", help: "While she is busy (a block in her ~/life/schedule.json), a place where something that gets through woke her and she then sent a message stays open this long after her latest send there: detector picks and follow-ups there reach her too. In her bed time it is also how long she counts as up late after a send (and a place she sent to stays open that long). 0 = off.", unit: "minutes", ...reload, example: "10" },
    "life.bedDozeMinutes": { label: "Dozing time", help: "In her bed time, how long she dozes (only people talking to her, her reminders and watches get through) after the bed time starts or after her last send, whichever is later, before she is asleep (only her reminders and the owner's wakes). 0 = asleep at once.", unit: "minutes", ...reload, example: "60" },
    "life.dreamAfterAsleepMinutes": { label: "Dream after asleep", help: "She dreams once she has been asleep this long in her bed time (at most once per bed time; a night she never sleeps that long has no dream, and the next dream covers both days).", unit: "minutes", ...reload, example: "15" },
    "life.restNotice": { label: "Rest before her memory fills", help: "Near the compaction trigger she gets a rest notice after her turn and writes her own summary; her new epoch starts from it alone (her files stay). Off: compaction summarises for her, as before.", ...reload, example: "true" },
    "life.restNoticeRatio": { label: "Rest notice at", help: "The rest notice comes when her last request reaches this share of the compaction trigger (compaction.triggerRatio × her budget).", ...reload, example: "0.85" },
    "life.restSummaryMinChars": { label: "Shortest rest summary", help: "A rest summary shorter than this counts as ignored: compaction summarises for her right away. Her own <summary> fresh start needs at least this many characters too.", unit: "characters", ...reload, example: "200" },
    "life.selfSummaryMinRatio": { label: "Own fresh start from", help: "She may end any turn with only <summary>…</summary> to reset her context to it; it is used only when her last request reached this share of the compaction trigger (compaction.triggerRatio × her budget).", ...reload, example: "0.3" },
    "life.selfSummaryCooldownMinutes": { label: "Own fresh start cooldown", help: "Her own <summary> fresh start is used only when at least this long has passed since her last epoch started.", unit: "minutes", ...reload, example: "120" },
    "life.dreamModel": { label: "Dream model", help: "The model of her nightly dream (the memory keeper that adds the day's memories to her notes and checks them against her transcripts): {providerId, modelId, effort?} from GET /api/models (or `provider/model[@effort]` on the command line). Unset (null): her own model. See `waifus help dreaming`.", leaf: true, nullUnset: true, ...reload, example: "anthropic/claude-haiku-5-5" },
    "life.dreamMaxRounds": { label: "Dream tool rounds", help: "At most this many tool rounds in one dream session.", ...reload, example: "60" },
    "life.dreamWindowMaxChars": { label: "Dream window per session", help: "When what was said since her last dream is longer than this, the dream runs in several sessions (oldest days first), each moving her dream cursor for what it covered.", unit: "characters", ...reload, example: "200000" },
    "life.webFetch.model": { label: "Model for long pages", help: "Route for reading long web pages (\"\" = the cheapest offered route with a key; name a contributor route here to allow one).", ...reload, example: "openai/gpt-6-luna" },
    "life.webFetch.maxPerWaifuPerDay": { label: "Pages per waifu per day", help: "Pages one waifu may fetch per day (0 = no WebFetch).", ...reload, example: "20" },
    "life.webFetch.maxPerTurn": { label: "Pages per turn", help: "Pages she may fetch in one turn (0 = no WebFetch).", ...reload, example: "3" },
    "life.webFetch.directMaxChars": { label: "Read directly up to", help: "A page this short is given to her as is; longer ones are read by one digest call.", unit: "characters", ...reload, example: "2000" },
    "life.webFetch.maxBytes": { label: "Largest page", help: "Largest page downloaded.", unit: "bytes", ...reload, example: "5242880" },
    "life.webFetch.timeoutMs": { label: "Time limit per page", help: "Time limit for one page.", unit: "ms", ...reload, example: "20000" },
    "life.webFetch.maxRedirects": { label: "Redirects followed", help: "Redirects followed (each hop is checked against private addresses).", ...reload, example: "5" },
    "life.webFetch.cacheMinutes": { label: "Keep fetched pages", help: "Fetched pages are cached this long.", unit: "minutes", ...reload, example: "15" },
    "life.home.maxBytes": { label: "Home folder size", help: "Her home folder (her notes, reminders, watches and anything she keeps) may hold at most this much; a write past it is refused.", unit: "bytes", ...live, example: "52428800" },
    "life.home.maxFiles": { label: "Files in her home", help: "Files her home folder may hold.", ...live, example: "2000" },
    "life.home.maxFolders": { label: "Folders in her home", help: "Folders her home folder may hold.", ...live, example: "500" },
    "life.tmp.maxBytes": { label: "/tmp size", help: "Her /tmp (downloads and scratch files) may hold at most this much; the oldest files there are deleted when a download would not fit.", unit: "bytes", ...live, example: "209715200" },
    "life.tmp.maxFiles": { label: "Files in /tmp", help: "Files her /tmp may hold; a Bash command or a write past it is refused, and a download deletes the oldest files first.", ...live, example: "2000" },
    "life.tmp.retentionDays": { label: "Keep /tmp files", help: "Files in her /tmp are deleted this many days after they were last written (her home is never touched).", unit: "days", ...live, example: "7" },
    "life.attachments.maxBytes": { label: "Largest attachment downloaded", help: "Largest attachment ReadMessages downloads into her /tmp (images, PDFs and text files; larger ones are only listed).", unit: "bytes", ...live, example: "10485760" },
    "life.send.maxFiles": { label: "Files per message", help: "Files she may attach to one message (0 = none).", ...reload, example: "4" },
    "life.bash.enabled": { label: "Simulated Bash", help: "Offer her the simulated Bash (just-bash over a copy of her two folders; never a real program, no network). Off: the tool is not offered.", ...reload, example: "true" },
    "life.bash.python": { label: "Python in Bash", help: "Let her Bash run python3 (CPython compiled to WebAssembly, inside the same isolation).", ...reload, example: "true" },
    "life.bash.maxTimeoutMs": { label: "Longest Bash command", help: "The longest one Bash command may run (she asks for up to this; the default is 10 seconds). The worker is terminated at the limit and nothing is saved.", unit: "ms", ...reload, example: "60000" },
    "life.bash.maxOutputChars": { label: "Bash output shown", help: "Bash output she sees (the rest is cut).", unit: "characters", ...live, example: "16000" },
    "life.bash.maxMemoryMb": { label: "Bash memory limit", help: "How much the host process may grow while one Bash command runs (its WebAssembly Python memory included). Past it the command is stopped and nothing is saved.", unit: "MiB", ...live, example: "512" },
    "search.maxPerSecond": { label: "Searches per second", help: "Web searches started per second, host-wide (paced, not refused; 0 = no WebSearch).", ...reload, example: "2" },
    "search.maxPerDay": { label: "Searches per day", help: "Web searches per day, host-wide (0 = no WebSearch). The optional Exa key is the `exa` provider credential, not config.", ...reload, example: "50" },
    "search.maxPerWaifuPerDay": { label: "Searches per waifu per day", help: "Web searches one waifu may make per day (0 = no WebSearch).", ...reload, example: "20" },
    "detector.target": { label: "Addressee detector", help: "The addressee detector (who is an unaddressed message for?): a native-choice decision model such as openrouter:typesafe/jev-1.14, openai:gpt-6-luna or laya:english; \"\" turns it off (then a first message in 10 minutes or a question wakes one waifu at random). Also GET/PUT /api/detector/config.", ...reload, example: "openrouter:typesafe/jev-1.14" },
    "updates.enabled": { label: "Automatic updates", help: "Install newer patch releases automatically when every managed process is idle (global npm installs only).", localOnlyWrite: true, ...live, example: "false" },
    "updates.checkIntervalMinutes": { label: "Check for updates every", help: "How often npm is checked for a newer patch release.", unit: "minutes", localOnlyWrite: true, ...live, example: "60" },
    "updates.idleMinutes": { label: "Quiet time before installing", help: "How long everything must be quiet before an update installs.", unit: "minutes", localOnlyWrite: true, ...live, example: "5" }
  }
};

const WAIFU: SettingGroup = {
  id: "waifu",
  title: "Waifu",
  summary: "One character: persona, style, model, schedule, wake-on-name, daily budget, DM settings and her bot's Discord profile.",
  description:
    "`user/waifus/<id>/waifu.json`. Writes are partial and need the revision you read (the CLI sends it; a stale one is a 409). Changes to what her prompt contains take effect at her next turn through a compaction. Her Discord profile (username, bio, nicknames, and the avatar and banner uploaded with POST /api/waifus/:waifuId/assets/pfp|banner) is synced to her own bot when it connects and after every change; GET /api/waifus/:waifuId/discord-profile shows the sync status.",
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
    username: { help: "Her bot's Discord username, set on her own bot by the app (2–32 characters, no @ # : ``` and not containing \"discord\" or \"clyde\"; Discord allows about 2 changes an hour). Unset leaves her bot's current Discord username alone. Her name stays what she is called in prompts and wake words. null unsets it.", nullUnset: true, example: "Aria" },
    bio: { help: "Her bot's About Me: synced to the Discord application's description (at most 400 characters; some Discord views show only about the first 190). Unset: the app leaves the description alone. null unsets it.", nullUnset: true, example: "Sunny baker. Ask me about lemon tarts." },
    nicknames: { help: "Per-server nickname overrides for her bot: a JSON object of server (guild) id → nickname (1–32 characters), replaced whole on write. Needs the Change Nickname permission in that server (else a warning). Removing an entry clears the nickname the app set. null removes all.", leaf: true, nullUnset: true, example: '{"123456789012345678":"Ari"}' },
    "availability.bedTime.enabled": { label: "Bed time", help: "Her bed time every day, a soft one: in it she is up late while she keeps chatting (life.busyEngagedMinutes after her last send), then dozing (only people talking to her, her reminders and watches get through) and, life.bedDozeMinutes after her last send or the bed time's start, asleep (only her reminders and the owner's wakes get through). The rest waits for the morning at its end, when she writes her day in ~/life/schedule.json (her busy times come from there).", example: "true" },
    "availability.bedTime.start": { label: "Bed time start", help: "When her bed time starts (local time).", unit: "HH:mm", example: "23:00" },
    "availability.bedTime.end": { label: "Bed time end", help: "When her bed time ends and her day starts (local time).", unit: "HH:mm", example: "07:00" },
    customInstructions: { help: "Extra instructions added to her prompt (at most 4000 characters).", example: "Never talk about politics." },
    scheduleInPrompt: { help: "Show her schedule in her prompt: her bed time and today's plan from her ~/life/schedule.json (the file works either way).", example: "true" },
    wakeOnName: { help: "Her name, display name or server nickname in a message wakes her (turn off for names that are common words).", example: "true" },
    "life.dailyBudgetUsd": { help: "Her spending limit per local day in USD; when reached, wakes wait for the next day (the owner's wakes still go through). null = no budget.", nullIsValue: true, unit: "USD", example: "2.5" },
    "dm.allowDms": { help: "Accept DMs on her own bot (she must be the only enabled waifu on it and have a model).", example: "true" },
    "dm.rateLimit": { help: "Replies per person per window: {maxReplies, windowMinutes}; null = unlimited.", leaf: true, nullIsValue: true, example: '{"maxReplies":30,"windowMinutes":60}' },
    "dm.notifyWhenLimited": { help: "Send the limit notice once when a person reaches the limit.", example: "true" },
    "dm.limitNotice": { help: "The limit notice (\"\" = the built-in one; at most 300 characters).", example: "I need a little break, talk soon!" },
    "dm.sleepNotice": { help: "Sent once per bed time when someone DMs her while she is asleep (\"\" = none; no model call).", example: "I'm asleep, I'll answer in the morning." }
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
      "Each waifu is an autonomous agent with one continuous life: wakes arrive as notifications, she decides what to do with her tools, and only her sends reach people. The life log hides DM content unless a local request reveals it (includePrivate=1; never over Remote Access). Compact summarises her life now; reset starts a fresh epoch with no summary (her files and queued wakes stay). Each waifu has her own computer: her home /home/<name> (her notes in any layout and MEMORY.md her index; life/ with schedule.json her day, which she writes every morning: busy blocks with why, phone checks, mood, plans; reminders.json, watches.json, profile.json and places.md kept by the app), /tmp (files people sent, deleted 7 days after the last write) and the read-only /transcripts (everything said where she is, one file per room per day, kept forever; see `waifus help dreaming`). The files routes list, read, write and delete them under the same checks as her Write tool (life/places.md refused, the JSON files in life/ checked with line and column; revision by content hash, expectedHash). While she is busy (a block of her day), DMs, mentions, replies, her name, the owner, her reminders and watches reach her at once; detector picks, @everyone and role mentions wait for her next phone check (or the block's end), except in a place where she is chatting (life.busyEngagedMinutes after her last send there). Her bed time (availability.bedTime, the owner's) is soft: up late while she keeps sending, then dozing (like busy, but the rest waits for the morning), then asleep after life.bedDozeMinutes (only her reminders and the owner's wakes get through; DMs get the sleep notice). A file from a private chat is listed as [private chat redacted] and opens only with a local includePrivate=1; a watch bound to a DM is redacted the same way.",
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
    cli: ["waifus life <waifu> [--log] [--private]", "waifus wake <waifu> [note]", "waifus files <waifu> [path] [--root tmp|transcripts] [--private]", "waifus schedule <waifu>", "waifus watches <waifu> [--private]"]
  },
  {
    id: "dreaming",
    title: "Transcripts and dreaming",
    summary: "Her read-only transcripts of what was said where she is, and the nightly dream that keeps her notes true to them (spec §18).",
    description:
      "Transcripts: the app writes every message in a room where a waifu is cast, and in her DMs, to one shared store (user/transcripts/), kept forever: only a forget and Discord deletes remove lines. She reads her part as /transcripts/<server>/<room>/<YYYY-MM-DD>.md (threads below their room, her DMs under /transcripts/dm/<name>/) with Read and Bash (grep, cat, python); nothing can write there and SendMessage can't attach it. A waifu added to a room later sees only what was said after she arrived; one removed keeps what she saw. DM transcripts are private (D14): GET /api/waifus/:waifuId/files?root=transcripts lists them as [private chat redacted] and opens them only with a local includePrivate=1. Dreaming: once she has been asleep life.dreamAfterAsleepMinutes in her bed time, at most once per bed time and not at all on a night she never sleeps that long (else at life.maintenanceHourLocal), a separate memory keeper with no life log and no persona (life.dreamModel, else her model) reads the dream window, everything said since her last dream (her dream cursor moves only when a dream finishes), adds memories from that window only, and checks every note against it: a note the window contradicts is patched (the newest wins); a note the window does not mention is never changed or deleted for lack of evidence. A long window runs in several sessions (life.dreamWindowMaxChars), oldest days first; each session has at most life.dreamMaxRounds tool rounds. One report line per dream goes to her maintenance.jsonl.",
    routes: [
      { method: "GET", path: "/api/waifus/:waifuId/files" },
      { method: "GET", path: "/api/waifus/:waifuId/files/*" },
      { method: "GET", path: "/api/config" },
      { method: "PUT", path: "/api/config" }
    ],
    cli: ["waifus files <waifu> /transcripts [--private]", "waifus set app life.dreamModel anthropic/claude-haiku-5-5", "waifus unset app life.dreamModel"]
  },
  {
    id: "forget",
    title: "Forget a person",
    summary: "The owner's best-effort scrub of one Discord user (spec §7.5).",
    description:
      "POST /api/people/:userId/forget {confirm: true, dryRun?} deletes the person's DMs with every waifu, removes them from member lists and the archive, removes their lines (and the lines naming them) from every transcript and their DM transcripts whole, and scrubs every life (her summary, queued wakes, her reminders and watches, and every text file in her home, then a verification pass; her downloads of the person's files and copies of them are deleted). A part that fails answers 202 with `pending` and runs again at the next start (given up after 3 tries, with an owner notice). Review lines (names someone else shares) are kept per waifu for the owner.",
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
