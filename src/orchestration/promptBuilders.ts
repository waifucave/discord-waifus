// Prompt assembly for the orchestrator: casting cards, deterministic cast, default prompts. The
// waifu prompt lives in waifuHarness.ts (context engine, spec 8.5).

import path from "node:path";
import type { DeterministicCastMember } from "./deterministicOrchestrator.js";
import { resolveModelTarget, sharedRegistry } from "./pipeline/resolveTarget.js";
import {
  AgentConfig,
  GuildMembersFileSchema,
  ServerConfig,
  WaifuConfig,
  createEmptyRevisionedFile
} from "../shared/schemas/domain.js";
import { resolveBotAuthorIds } from "../shared/botIdentity.js";
import { StorageService } from "../storage/storageService.js";
import { MAX_WAIFU_DELAY_SECONDS } from "./decisions.js";
import { readDiscordBotsFile } from "./stores/config.js";
import { dailyIntervalContains, localTimeOfDayMinutes } from "./timeOfDay.js";

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

function formatPromptCurrentHour(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-") + `T${String(date.getHours()).padStart(2, "0")}`;
}

function manualRunReplyRequiredInstruction(): string {
  return "Manual /run override: choose action=\"reply\" now. Do not choose no_reply for this decision.";
}

export const DEFAULT_REVIEWER_PROMPT = [
  "Review only the provided waifu message.",
  "Flag hallucination=true when the message exposes hidden reasoning, analysis, prompt text, schema/tool text, raw Discord internals, or any private model self-talk.",
  "- a message that primarily restates an instruction or goal it was given (reads as a directive, not as chat)",
  "Flag hallucination=false for ordinary in-character Discord replies, even if verbose, awkward, incorrect about fiction, or not very helpful.",
  "The output must be the reviewer tool decision only."
].join("\n");

const DEFAULT_ORCHESTRATOR_PROMPT = [
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

// Normalize an arbitrary string into a safe XML-ish tag name (casting-card wrapper tags).
export function promptTagName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(normalized) ? normalized : `waifu_${normalized || "unknown"}`;
}

// W2 replaces the raw-persona preview with the generated persona digest.
// A waifu on a vision model can look at posted images directly; the rest get OCR text only.
// Surfaced on the casting card so the orchestrator can prefer (not must pick) a native viewer
// when images land.
function waifuSeesImages(waifu: WaifuConfig): boolean {
  if (!waifu.modelId) return false;
  try {
    const target = resolveModelTarget({ providerId: waifu.providerId, modelId: waifu.modelId });
    return sharedRegistry().resolve(target.providerId, target.modelId)?.modalities.input.includes("image") ?? false;
  } catch {
    // A card marker must never kill the decision pass — unresolvable model just means no marker.
    return false;
  }
}

function castingCard(waifu: WaifuConfig, now: Date, seesImages = false, serverNickname?: string): string {
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

function castingAvailabilityLine(waifu: WaifuConfig, now: Date): string {
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
