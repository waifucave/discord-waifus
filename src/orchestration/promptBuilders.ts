// Prompt assembly for waifus and the orchestrator: waifu prompt parts, casting cards,
// deterministic cast, default prompts.

import path from "node:path";
import { modelVisibleEmojiToken } from "../discord/normalization.js";
import { type PromptBlockContext, assembleWaifuPrompt, promptTagName, reconcileWaifuPromptLayout } from "./promptBlocks.js";
import type { DeterministicCastMember } from "./deterministicOrchestrator.js";
import { resolveModelTarget, sharedRegistry } from "./pipeline/resolveTarget.js";
import {
  ActiveChatParticipant,
  AgentConfig,
  GuildEmojisFileSchema,
  GuildMembersFileSchema,
  MemoryStoreSchema,
  ServerConfig,
  WaifuConfig,
  createEmptyRevisionedFile
} from "../shared/schemas/domain.js";
import { resolveBotAuthorIds } from "../shared/botIdentity.js";
import { retrieveMemories } from "./memoryRetrieval.js";
import { StorageService } from "../storage/storageService.js";
import type { ContextMessage } from "./context.js";
import { MAX_WAIFU_DELAY_SECONDS } from "./decisions.js";
import type { RuntimeServices } from "./runtimeShared.js";
import { readDiscordBotsFile } from "./stores/config.js";
import { emptyMemoryStore, readMemoryStore } from "./stores/memories.js";
import { readActiveChatParticipants } from "./stores/participants.js";
import { dailyIntervalContains, localTimeOfDayMinutes } from "./timeOfDay.js";

export async function buildWaifuPromptParts(
  services: Pick<RuntimeServices, "storage" | "logger">,
  guildId: string,
  waifu: WaifuConfig,
  availableWaifus: WaifuConfig[],
  options: {
    channelId: string;
    directorNote?: string;
    pickNextWaifuToolOverride?: boolean;
    shortTermMemoryToolOverride?: boolean;
    contextMessages?: ContextMessage[];
    memoryInjectionLimit: number;
  }
): Promise<{ systemPrompt: string; midSystemBlock: string; trailingSystemBlock: string; selfGuildNickname: string | undefined }> {
  const pickNextWaifuToolActive = options.pickNextWaifuToolOverride ?? false;
  const shortTermMemoryToolActive =
    options.shortTermMemoryToolOverride ?? true;
  const [store, emojis, activeChatParticipants, members, bots] = await Promise.all([
    readMemoryStore(services.storage),
    services.storage.readJson(
      path.join("user", "servers", guildId, "emojis.json"),
      GuildEmojisFileSchema,
      GuildEmojisFileSchema.parse(createEmptyRevisionedFile({ guildId, emojis: [] }))
    ),
    readActiveChatParticipants(services.storage, guildId, options.channelId),
    services.storage.readJson(
      path.join("user", "servers", guildId, "members.json"),
      GuildMembersFileSchema,
      GuildMembersFileSchema.parse(createEmptyRevisionedFile({ guildId, members: [] }))
    ),
    readDiscordBotsFile(services.storage)
  ]);
  const now = new Date();
  const retrieval = retrieveMemories({
    records: store.memories,
    window: options.contextMessages ?? [],
    guildId,
    waifuId: waifu.id,
    channelId: options.channelId,
    now,
    limit: options.memoryInjectionLimit
  });
  const memoryLines = retrieval.lines;
  // Stamp lastRetrievedAt on selected non-pinned records, best-effort, fire-and-forget.
  // Skip records stamped within the last hour to avoid noisy writes.
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const nowMs = now.getTime();
  const idsToStamp = retrieval.selected
    .filter(
      (r) =>
        !r.lastRetrievedAt ||
        nowMs - Date.parse(r.lastRetrievedAt) > ONE_HOUR_MS
    )
    .map((r) => r.id);
  if (idsToStamp.length > 0) {
    const stampNow = now.toISOString();
    const stampSet = new Set(idsToStamp);
    services.storage.updateRevisionedJson({
      resourceKey: "memories:global",
      relativePath: "user/memories.json",
      schema: MemoryStoreSchema,
      fallback: emptyMemoryStore(),
      transform: (current) => ({
        ...current,
        memories: current.memories.map((r) =>
          stampSet.has(r.id) ? { ...r, lastRetrievedAt: stampNow } : r
        )
      })
    }).catch((err: unknown) => {
      services.logger.warn("Failed to stamp lastRetrievedAt on retrieved memories", {
        guildId,
        waifuId: waifu.id,
        message: err instanceof Error ? err.message : String(err)
      });
    });
  }
  const emojiList = emojis.emojis
    .filter((emoji) => emoji.available)
    .map(modelVisibleEmojiToken)
    .join(" ");
  // Raw persona text; the identity block adds the identity sentence separately.
  const personalityContent = waifu.persona.trim();
  const scheduleContent = formatWaifuScheduleForPrompt(waifu);
  const waifuTag = promptTagName(waifu.name || waifu.id);
  const toolUseInstructions = buildWaifuToolUseInstructions(waifu, availableWaifus, {
    pickNextWaifu: pickNextWaifuToolActive,
    shortTermMemory: shortTermMemoryToolActive
  });
  const guildNameByUserId = new Map(
    members.members
      .filter((member) => member.guildDisplayName)
      .map((member) => [member.userId, member.guildDisplayName as string])
  );
  // members.json is keyed by the bot USER snowflake; waifu.botId is the bots-entry id.
  const guildNameForBotRef = (botIdRef: string | undefined) =>
    resolveBotAuthorIds(botIdRef, bots)
      .map((id) => guildNameByUserId.get(id))
      .find(Boolean);
  const serverNickname = guildNameForBotRef(waifu.botId);

  // Roster line: guild display names of other configured waifus with bot IDs (excluding self),
  // with the configured displayName in parentheses when the guild name differs.
  const rosterLine = availableWaifus
    .filter((candidate) => candidate.id !== waifu.id && candidate.botId)
    .map((candidate) => {
      const guildName = guildNameForBotRef(candidate.botId);
      const configured = candidate.displayName || candidate.name;
      return guildName && guildName !== configured ? `${guildName} (${configured})` : configured;
    })
    .join(", ");

  const blockContext: PromptBlockContext = {
    waifuTag,
    displayName: waifu.displayName || waifu.name || waifu.id,
    personalityContent,
    scheduleContent,
    toolUseInstructions,
    rosterLine,
    serverNickname: serverNickname !== waifu.displayName ? serverNickname : undefined,
    activeParticipantDisplayNames: channelParticipantDisplayNames(
      activeChatParticipants,
      waifu,
      availableWaifus
    ),
    emojiList,
    memoryLines,
    currentlyDoing: currentlyDoingForWaifu(waifu, new Date()),
    directorNote: options.directorNote?.trim() || undefined,
    personaDigest: waifu.personaDigest
      ? { voice: waifu.personaDigest.voice, role: waifu.personaDigest.role }
      : undefined
  };

  // The slot→string mapping is fixed; the composition of each slot is driven by the waifu's
  // editable prompt layout (see src/orchestration/promptBlocks.ts).
  return {
    ...assembleWaifuPrompt(reconcileWaifuPromptLayout(waifu.promptLayout), blockContext),
    selfGuildNickname: serverNickname !== waifu.displayName ? serverNickname : undefined
  };
}

/** Cast members + guild-nickname map for the deterministic decider and casting cards. */
export async function buildDeterministicCast(
  storage: StorageService,
  guildId: string,
  waifus: WaifuConfig[]
): Promise<{ cast: DeterministicCastMember[]; nicknames: Map<string, string> }> {
  const [bots, members] = await Promise.all([
    readDiscordBotsFile(storage),
    storage.readJson(
      path.join("user", "servers", guildId, "members.json"),
      GuildMembersFileSchema,
      GuildMembersFileSchema.parse(createEmptyRevisionedFile({ guildId, members: [] }))
    )
  ]);
  const guildNameByUserId = new Map(
    members.members
      .filter((member) => member.guildDisplayName)
      .map((member) => [member.userId, member.guildDisplayName as string])
  );
  const nicknames = new Map<string, string>();
  const cast: DeterministicCastMember[] = [];
  for (const waifu of waifus) {
    const authorIds = resolveBotAuthorIds(waifu.botId, bots);
    const nickname = authorIds.map((id) => guildNameByUserId.get(id)).find(Boolean);
    if (nickname && nickname !== waifu.displayName) nicknames.set(waifu.id, nickname);
    if (!waifu.modelId) continue; // she cannot generate a reply anyway
    const names = [...new Set([waifu.name, waifu.displayName, nickname].filter((v): v is string => Boolean(v?.trim())))];
    cast.push({ waifuId: waifu.id, names, authorIds, availability: waifu.availability });
  }
  return { cast, nicknames };
}

export function buildOrchestratorSystemPrompt(
  orchestrator: AgentConfig,
  server: ServerConfig,
  replyRequired = false
): string {
  const identity = replyRequired
    ? "You are the director of a multi-character Discord bot. This manual /run requires you to choose at least one waifu to reply now."
    : "You are the director of a multi-character Discord bot. On each pass you decide who (if anyone) speaks next and how the room is paced.";

  const rules = [
    "- Every respondingWaifus[].waifuId must be copied verbatim from the IDs in <active_waifus>.",
    replyRequired
      ? "- action must be \"reply\" for this manual /run, with at least one responding waifu and retriggerAfterSeconds null."
      : "- action \"reply\": respondingWaifus non-empty, retriggerAfterSeconds and wakePlan null. action \"no_reply\": respondingWaifus empty, retriggerAfterSeconds and wakePlan set.",
    "- Runtime pacing: when a human spoke within the last four chat messages, the first waifu starts immediately and later delays count from this decision; otherwise each delay counts after the previous waifu finishes. Any new chat message cancels the remaining chain.",
    "- Your own past orchestrator_decision tool calls appear in the conversation with their real outcomes; nobody else sees them. Lines like [12m pass] and [wake: ...] are runtime annotations, not chat messages.",
    "- Availability lines in <active_waifus> are soft signals, not rules — a sleeping waifu can still answer when the moment justifies it."
  ].join("\n");

  const messageStructure =
    "Each Discord message is its own user turn: an optional `replying to > Author: preview` line, then `DisplayName: <body>`, optionally followed by `[attachments: Nx image]` and `[image_text: ...]` lines.";

  return [
    `<orchestrator_identity>\n${identity}\n</orchestrator_identity>`,
    `<orchestrator_rules>\n${rules}\n</orchestrator_rules>`,
    orchestrator.promptSections.messageStructure
      ? `<chat_message_structure>\n${messageStructure}\n</chat_message_structure>`
      : null,
    `<discord_server_information>\n${server.name ?? server.guildId}\n</discord_server_information>`
  ].filter(Boolean).join("\n");
}

export function buildOrchestratorTrailingPrompt(
  orchestrator: AgentConfig,
  availableWaifus: WaifuConfig[],
  replyRequired = false,
  loopNotice?: string,
  nicknames?: Map<string, string>
): string {
  const now = new Date();
  const activeWaifusContent = availableWaifus.length
    ? availableWaifus.map((waifu) => castingCard(waifu, now, waifuSeesImages(waifu), nicknames?.get(waifu.id))).join("\n")
    : "No waifus are currently enabled for this channel.";

  const pausePlanning =
    "When you choose no_reply, retriggerAfterSeconds is a planned pause before YOU re-check the room — any new human message wakes you regardless, so long pauses cost nothing. wakePlan is one sentence on what you intend at wake; the runtime shows it back to you when the timer fires. A pivot plan should name the new topic, and when the wake comes you execute it with a change_topic directive — a plan without a directive usually dissolves into the old topic. Picking the pause: remember an ACTIVE room should rarely get here at all — if humans are engaged, the right move was a reply, not a pause. When the room genuinely cooled: 10–60s only to give a mid-flow room a short breath, 100–180s right after a beat lands (a quick check whether it caught), 240–600s for a cooling thread, 900–1800s for a planned revival of a quiet room, 3600s+ when you are mostly waiting for humans to return. Do NOT default to a round 300 — pick an exact number that matches the room's energy (e.g. 110, 140, 190, 420), and vary it so your pacing never becomes a predictable cycle. The same is true of your wake rhythm: if your last few wakes each produced the same shape (wake, two replies, pause), break the pattern — one voice instead of two, a directive instead of a reply, or a genuinely longer sleep. Repeated quiet checks must back off to longer pauses.";

  const task = replyRequired
    ? `${DEFAULT_ORCHESTRATOR_PROMPT}\n\n${manualRunReplyRequiredInstruction()}`
    : DEFAULT_ORCHESTRATOR_PROMPT;

  return [
    `<task_instructions>\n${task}\n</task_instructions>`,
    orchestrator.promptSections.pausePlanning && !replyRequired
      ? `<pause_planning>\n${pausePlanning}\n</pause_planning>`
      : null,
    `<active_waifus>\n${activeWaifusContent}\n</active_waifus>`,
    `<current_time>\n${formatPromptCurrentHour(new Date())}\n</current_time>`,
    loopNotice ? `<runtime_notice>\n${loopNotice}\n</runtime_notice>` : null
  ].filter(Boolean).join("\n");
}

// Render a directive into the single-line note fed to the waifu prompt. Manual /run directions
// pass through verbatim; model intents get a parenthetical label prefix for the waifu's benefit.
// Accepts the loose stored shape (string intent, optional goal) so both the decision pipeline and
// directed-run paths can feed it without casting.
export function directiveTextForWaifu(
  directive: { intent: string; goal?: string } | undefined
): string | undefined {
  if (!directive) return undefined;
  const goal = directive.goal ?? "";
  if (directive.intent === "manual") return goal || undefined;
  return `(${directive.intent.replace(/_/g, " ")}) ${goal}`.trim();
}

export function modelSupportsTools(waifu: WaifuConfig): boolean {
  if (!waifu.modelId) return false;
  try {
    const target = resolveModelTarget({ providerId: waifu.providerId, modelId: waifu.modelId });
    return sharedRegistry().resolve(target.providerId, target.modelId)?.features.tools.supported ?? false;
  } catch {
    return false;
  }
}

export function buildWaifuToolUseInstructions(
  waifu: WaifuConfig,
  availableWaifus: WaifuConfig[],
  activeTools: { pickNextWaifu: boolean; shortTermMemory: boolean }
): string | undefined {
  if (!waifu.tools.toolUse) return undefined;
  if (!modelSupportsTools(waifu)) return undefined;
  const candidates = availableWaifus
    .filter((candidate) => candidate.id !== waifu.id && candidate.botId && candidate.modelId)
    .map((candidate) => `${candidate.id} (${candidate.displayName || candidate.name})`);
  const sections: string[] = [];
  if (activeTools.pickNextWaifu && candidates.length > 0) {
    sections.push(
      [
        "PickNextWaifu — only after your message, only when another waifu has an obvious immediate follow-up. Available:",
        ...candidates.map((candidate) => `- ${candidate}`)
      ].join("\n")
    );
  }
  if (activeTools.shortTermMemory) {
    sections.push(
      `add_memory — save a note whenever the chat produces something you'd want to know tomorrow (plans, promises, new facts about someone, the state of a running bit). Notes are what survives when the chat history vanishes. Skip facts already shown in <${promptTagName(waifu.name || waifu.id)}_relevant_memories>. Always also write your normal message in the same turn.`
    );
  }
  if (sections.length === 0) return undefined;
  return sections.join("\n\n");
}

export function formatWaifuScheduleForPrompt(waifu: WaifuConfig): string {
  const availability = waifu.availability;
  const lines = [
    "- This is your configured routine. Treat it as background for your energy and timing, not as a live status readout.",
    "- It changes only when your schedule is edited."
  ];
  if (availability.sleep.enabled) {
    lines.push(
      `- Sleep: ${availability.sleep.start}-${availability.sleep.end} daily. This is your usual downtime, not a hard rule; you can still answer if you were just active, directly addressed, or joining helps the room.`
    );
  } else {
    lines.push("- Sleep: none configured.");
  }
  if (availability.busy.length > 0) {
    lines.push("- Busy:");
    for (const interval of availability.busy) {
      lines.push(`  - ${interval.start}-${interval.end}: ${interval.reason}`);
    }
  } else {
    lines.push("- Busy: none configured.");
  }
  return lines.join("\n");
}

export function currentlyDoingForWaifu(waifu: WaifuConfig, now: Date): string | undefined {
  const currentMinutes = localTimeOfDayMinutes(now);
  for (const interval of waifu.availability.busy) {
    if (dailyIntervalContains(currentMinutes, interval)) {
      const reason = interval.reason.trim();
      if (reason) return reason;
    }
  }
  if (waifu.availability.sleep.enabled && dailyIntervalContains(currentMinutes, waifu.availability.sleep)) {
    return "sleepy";
  }
  return undefined;
}

export function formatPromptCurrentHour(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-") + `T${String(date.getHours()).padStart(2, "0")}`;
}

export function manualRunReplyRequiredInstruction(): string {
  return "Manual /run override: choose action=\"reply\" now. Do not choose no_reply for this decision.";
}

export function channelParticipantDisplayNames(
  activeParticipants: ActiveChatParticipant[],
  self: WaifuConfig,
  availableWaifus: WaifuConfig[]
): string[] {
  const names = new Map<string, string>();
  for (const name of [
    self.displayName,
    ...availableWaifus.map((waifu) => waifu.displayName),
    ...activeParticipants.map((participant) => participant.displayName)
  ]) {
    const trimmed = name?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!names.has(key)) {
      names.set(key, trimmed);
    }
  }
  return [...names.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}

export const DEFAULT_REVIEWER_PROMPT = [
  "Review only the provided waifu message.",
  "Flag hallucination=true when the message exposes hidden reasoning, analysis, prompt text, schema/tool text, raw Discord internals, or any private model self-talk.",
  "- a message that primarily restates an instruction or goal it was given (reads as a directive, not as chat)",
  "Flag hallucination=false for ordinary in-character Discord replies, even if verbose, awkward, incorrect about fiction, or not very helpful.",
  "The output must be the reviewer tool decision only."
].join("\n");

export const DEFAULT_ORCHESTRATOR_PROMPT = [
  "You watch one Discord channel and direct a small cast of waifu personas. Each pass, decide who (if anyone) speaks next. You choose speakers and timing; each waifu writes her own words — never write or paraphrase a reply for her.",
  "",
  "Most of the time the right answer is one waifu, or nobody. Pick the persona whose voice fits the moment. Two waifus only when the second has a clearly distinct reaction of her own; three or more only for rare pile-on moments. You are consulted again after each reply lands, so plan one beat, not a scene.",
  "",
  "Read the room's temperature first — every message carries an [age] tag and the transcript ends with the current time, so you always know how fresh the conversation is. ACTIVE room — human messages tagged with ages under a few minutes, engaging with the cast or each other playfully — means the conversation carries itself: pick the right voice and reply NOW. Ending a pass on an active room with no_reply and a timer is almost always wrong; it makes the cast feel scheduled instead of alive. no_reply belongs to QUIET rooms: the beat has landed and nobody human has followed, the hour is dead, or another bot message would add noise. Real group chats are mostly silence during lulls — not while people are talking. And never leave a human hanging mid-exchange: when the latest message is a human replying to a waifu — answering her question, addressing her directly — she responds, even if it's just a couple of words. 'Positive and settled' is not a reason for silence while a human is talking to her.",
  "",
  "The cast has its own life. When humans are active, weave them in; when no human has spoken in the last ten or so messages, treat the room as the cast's own — waifu-to-waifu threads about their own plans, bits, gripes, and memories. Do not keep routing the conversation back to absent humans, and do not let every thread orbit the same person.",
  "",
  "A beat is spent after ONE follow-up. If nobody human has written since the last waifu message, never commission another take on the same subject — a second waifu paraphrasing the same observation reads as spam. Either open something genuinely new (a change_topic goal must name a subject that does not appear in the recent messages — 'comment on it again' is not a topic change) or choose no_reply. Your wakePlan must never promise a follow-up to a beat the cast has already followed up once.",
  "",
  "directive is a short GOAL for one waifu's next message, never content or wording. Default is null; her persona handles normal flow. But an unused directive budget helps nobody: when the chat keeps orbiting one person or one topic, spend it — change_topic with a NAMED topic is the strongest move you have. When a runtime notice says a loop is forming, that is the moment. When your own wakePlan said you would pivot, execute it with a change_topic directive rather than hoping a waifu pivots on her own.",
  "",
  `delaySeconds is a realistic reading/typing delay (0–${MAX_WAIFU_DELAY_SECONDS}); it defaults to 0.`,
  "",
  "Watch the recent speaker pattern. If the same waifu or the same pair has carried several beats, switch speakers, go quiet, or pivot with a directive — do not let two waifus volley restatements of the same mood.",
  "",
  "When the latest messages include an image, lean toward a waifu marked 'sees images natively' — she can actually look at it, the others only get extracted text. A soft preference, not a rule: if the moment clearly belongs to someone else, cast her instead."
].join("\n");

// W2 replaces the raw-persona preview with the generated persona digest.
// A waifu on a vision model can look at posted images directly; the rest get OCR text only.
// Surfaced on the casting card so the orchestrator can prefer (not must pick) a native viewer
// when images land.
export function waifuSeesImages(waifu: WaifuConfig): boolean {
  if (!waifu.modelId) return false;
  try {
    const target = resolveModelTarget({ providerId: waifu.providerId, modelId: waifu.modelId });
    return sharedRegistry().resolve(target.providerId, target.modelId)?.modalities.input.includes("image") ?? false;
  } catch {
    // A card marker must never kill the decision pass — unresolvable model just means no marker.
    return false;
  }
}

export function castingCard(waifu: WaifuConfig, now: Date, seesImages = false, serverNickname?: string): string {
  const tagName = promptTagName(waifu.name || waifu.id);
  const displayName = waifu.displayName || waifu.name;
  const nicknamePart = serverNickname && serverNickname !== displayName ? ` · appears in this server as "${serverNickname}"` : "";
  const lines: string[] = [
    `<${tagName}>`,
    `ID: ${waifu.id} · ${displayName}${nicknamePart}${seesImages ? " · sees images natively" : ""}`
  ];
  if (waifu.personaDigest) {
    lines.push(`Voice: ${waifu.personaDigest.voice}`);
    lines.push(`Cast her when: ${waifu.personaDigest.role}`);
  } else {
    // The trailing replace drops a lone high surrogate left when the cap splits an emoji pair.
    const preview = waifu.persona.trim().replace(/\s+/g, " ").slice(0, 200).replace(/[\uD800-\uDBFF]$/, "");
    lines.push(`About: ${preview || "(no persona configured)"}`);
  }
  lines.push(`Now: ${castingAvailabilityLine(waifu, now)}`);
  lines.push(`</${tagName}>`);
  return lines.join("\n");
}

export function castingAvailabilityLine(waifu: WaifuConfig, now: Date): string {
  const minutes = localTimeOfDayMinutes(now);
  const parts: string[] = [];
  const sleep = waifu.availability.sleep;
  if (sleep.enabled && dailyIntervalContains(minutes, sleep)) {
    parts.push(`likely asleep (sleep ${sleep.start}–${sleep.end})`);
  } else {
    parts.push("awake");
  }
  for (const interval of waifu.availability.busy) {
    if (dailyIntervalContains(minutes, interval)) {
      parts.push(`busy: ${interval.reason}`);
    }
  }
  return parts.join(" · ");
}
