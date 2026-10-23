// The orchestrator (director) RoleRenderer (spec 6.4, 8.7). Same shape as every context:
//   system (A)  director rules for the six policies the runtime enforces, static casting cards,
//               the owner's custom orchestrator.prompt as <owner_policy> (model mode, B28)
//   header (B)  frozen per epoch: <conversation_summary>, <place>
//   transcript  append-only `[HH:MM #ref] Name: body` entries plus the director's own final past
//               decisions as `[decision HH:MM] …` text lines (`decision` notes)
//   tail        ephemeral: now, current availability, <runtime_notice>, the wake marker with the
//               recorded scheduling decision (B8), reply-required and directive-budget state
// The tool schema is fixed per channel config (orchestratorToolParameters(availableWaifuIds));
// reply-required and the directive budget live in the tail and are enforced in code.

import type { ToolDef } from "@waifucave/gateway";
import type { ContextState, LedgerEntry } from "../shared/schemas/context.js";
import type { WaifuAvailability, WaifuConfig } from "../shared/schemas/domain.js";
import { formatClock, formatFullDate } from "./context/timeFormat.js";
import { isGapEntry } from "./context/ledger.js";
import type { RoleRenderer } from "./context/types.js";
import type { ContextMessage } from "./contextMessages.js";
import { WAIFU_CHUNK_COALESCE_WINDOW_MS } from "./contextMessages.js";
import { MAX_WAIFU_DELAY_SECONDS, RETRIGGER_MAX_SECONDS, RETRIGGER_MIN_SECONDS } from "./decisions.js";
import { assessCastCadence, assessLoop, type LoopAssessment } from "./loopDetector.js";
import { resolveModelTarget, sharedRegistry } from "./pipeline/resolveTarget.js";
import { dailyIntervalContains } from "./timeOfDay.js";
import { ORCHESTRATOR_TOOL_NAME, orchestratorToolParameters } from "./tools.js";

export type OrchestratorMode = "model" | "deterministic" | "one-shot";

/** A human spoke within this window → the room is active (policy 2, cadence override). */
export const HUMAN_RECENT_WINDOW_MS = 15 * 60 * 1000;

/** Static casting card: changes only when the waifu or channel config changes. */
export type CastCard = {
  waifuId: string;
  displayName: string;
  /** Server nickname when it differs from the display name. */
  nickname?: string;
  seesImages: boolean;
  voice?: string;
  role?: string;
  /** Persona preview, only when there is no persona digest. */
  about?: string;
  availability: WaifuAvailability;
};

// A waifu on a vision model can look at posted images directly; the rest get OCR text only.
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

export function buildCastCards(
  waifus: readonly WaifuConfig[],
  nicknames: ReadonlyMap<string, string> = new Map(),
  seesImages: (waifu: WaifuConfig) => boolean = waifuSeesImages
): CastCard[] {
  return waifus.map((waifu) => {
    const displayName = waifu.displayName || waifu.name;
    const nickname = nicknames.get(waifu.id);
    const card: CastCard = {
      waifuId: waifu.id,
      displayName,
      ...(nickname && nickname !== displayName ? { nickname } : {}),
      seesImages: seesImages(waifu),
      availability: waifu.availability
    };
    if (waifu.personaDigest) {
      card.voice = waifu.personaDigest.voice;
      card.role = waifu.personaDigest.role;
    } else {
      // The trailing replace drops a lone high surrogate left when the cap splits an emoji pair.
      card.about = waifu.persona.trim().replace(/\s+/g, " ").slice(0, 200).replace(/[\uD800-\uDBFF]$/, "") || "(no persona configured)";
    }
    return card;
  });
}

function castingCard(card: CastCard): string {
  const facts = [`id: ${card.waifuId}`, card.displayName];
  if (card.nickname) facts.push(`appears in this server as "${card.nickname}"`);
  if (card.seesImages) facts.push("sees images natively");
  const lines = [`<waifu>`, facts.join(" · ")];
  if (card.voice) lines.push(`Voice: ${card.voice}`);
  if (card.role) lines.push(`Cast her when: ${card.role}`);
  if (card.about) lines.push(`About: ${card.about}`);
  lines.push(`</waifu>`);
  return lines.join("\n");
}

const PAUSE_DETAIL =
  "   Roughly: 10–60s mid-flow, 100–180s after a beat lands, 240–600s for a cooling thread, 900–1800s to revive a quiet room, 3600s+ while waiting for humans. Use exact, varied numbers (110, 140, 420), back off after repeated quiet checks, and break repetitive wake rhythms.";

/**
 * Director rules (spec 8.7). Every "enforced" line is something the runtime really does
 * (ChannelRunner: waiting-human override, directive guardrail, cast-wake suppression, forced reply
 * on /run); everything else is stated as the director's judgement.
 */
export function directorRules(o: { pausePlanning: boolean }): string {
  return [
    "<director>",
    "You direct a cast of characters (waifus) in one Discord channel. Each pass, decide who speaks next, if anyone, and when to look again. Each waifu writes her own words; never script her lines. Plan one beat at a time.",
    "</director>",
    "",
    "<transcript_format>",
    "`[14:02 #k3] Kevin: text` is local time, message ref, sender. `↩#a1` replies to #a1; `↩Name` to an older message by Name. `[image: …]` is an image's text; `[image]` unreadable. `— 3 hours later —` marks gaps and days. `[decision 14:02] reply → aria · sent → #a4` lines are your own past decisions and outcomes (`#a4`: the message produced), seen by nobody else. The final block is the runtime's live status, not chat.",
    "</transcript_format>",
    "",
    "<policy>",
    "Enforced by the runtime:",
    "- A waiting human gets a voice: if the newest message is from a human who wrote in the last 15 minutes, a pause becomes a reply from an available waifu.",
    "- Directives are stripped while the status shows the budget closed; a detected loop reopens it.",
    "- A timer wake is skipped while four or more cast messages sit unanswered and no human wrote in 30 minutes.",
    "- A manual /run must reply.",
    "Your judgement:",
    "1. A human addressing or replying to a waifu should hear from her, even briefly.",
    "2. One voice is normal; a second only for a clearly different reaction.",
    "3. With no human around, the cast gets one fresh beat, then pause; never a second take on an unanswered beat.",
    "4. Pause longer the colder the room; human messages wake you anyway. With no_reply, wakePlan says what you will do at the wake; a pivot plan names its topic and is carried out with a change_topic directive.",
    ...(o.pausePlanning ? [PAUSE_DETAIL] : []),
    "5. A directive is a short goal for one message, never wording; default null. change_topic names a topic absent from recent messages.",
    '6. For new images prefer a waifu marked "sees images natively"; the others only get their text.',
    "7. Availability is a soft signal: a sleeping or busy waifu can still answer when addressed.",
    "</policy>",
    "",
    "<decision_format>",
    "- waifuIds verbatim from the cast cards; respondingWaifus in speaking order.",
    `- reply: retriggerAfterSeconds and wakePlan null. no_reply: no respondingWaifus; retriggerAfterSeconds (${RETRIGGER_MIN_SECONDS}–${RETRIGGER_MAX_SECONDS}) and wakePlan set.`,
    `- delaySeconds 0–${MAX_WAIFU_DELAY_SECONDS} (reading/typing); reasoning one short sentence.`,
    "</decision_format>"
  ].join("\n");
}

export function orchestratorSystemPrompt(i: {
  cast: readonly CastCard[];
  pausePlanning: boolean;
  /** The owner's custom orchestrator.prompt; rendered in model mode only (B28). */
  ownerPolicy?: string;
}): string {
  const cards = i.cast.length ? i.cast.map(castingCard).join("\n") : "No waifus are enabled for this channel.";
  const policy = i.ownerPolicy?.trim();
  return [
    directorRules({ pausePlanning: i.pausePlanning }),
    "",
    `<cast>\n${cards}\n</cast>`,
    ...(policy ? ["", `<owner_policy>\n${policy}\n</owner_policy>`] : [])
  ].join("\n");
}

function minutesInZone(at: Date, timeZone: string): number {
  const [hours = "0", minutes = "0"] = formatClock(at, timeZone).split(":");
  return Number(hours) * 60 + Number(minutes);
}

/** "awake" / "likely asleep (sleep 23:00–07:00)" / "awake · busy: work", in the context's zone. */
export function availabilityLine(availability: WaifuAvailability, at: Date, timeZone: string): string {
  const minutes = minutesInZone(at, timeZone);
  const parts: string[] = [];
  const sleep = availability.sleep;
  if (sleep.enabled && dailyIntervalContains(minutes, sleep)) parts.push(`likely asleep (sleep ${sleep.start}–${sleep.end})`);
  else parts.push("awake");
  for (const interval of availability.busy) {
    if (dailyIntervalContains(minutes, interval)) parts.push(`busy: ${interval.reason}`);
  }
  return parts.join(" · ");
}

function rosterLines(cast: readonly CastCard[], at: Date, timeZone: string): string[] {
  return cast.map((card) => `- ${card.waifuId} (${card.displayName}): ${availabilityLine(card.availability, at, timeZone)}`);
}

/**
 * Epoch header (B): frozen at epoch start, re-rendered after a compaction. Availability is NOT
 * here: it changes mid-epoch (and with the cast), so it lives only in the tail.
 */
export function orchestratorHeader(i: { place: string }, state: ContextState): string {
  const sections: string[] = [];
  if (state.summary?.trim()) sections.push(`<conversation_summary>\n${state.summary.trim()}\n</conversation_summary>`);
  sections.push(`<place>${i.place}</place>`);
  return sections.join("\n");
}

/** "Bake Club › #general". */
export function orchestratorPlace(serverName: string | undefined, channelName: string | undefined, channelId: string): string {
  return `${serverName?.trim() || "Discord server"} › #${channelName?.trim() || channelId}`;
}

export function orchestratorTools(availableWaifuIds: readonly string[]): ToolDef[] {
  return [
    {
      name: ORCHESTRATOR_TOOL_NAME,
      description: "Record who (if anyone) speaks next in the channel, or pause until the next check.",
      parameters: orchestratorToolParameters([...availableWaifuIds]) as Record<string, unknown>
    }
  ];
}

// ---------------------------------------------------------------------------
// Transcript → heuristics. The cursor-bounded ledger transcript is the only context source: the
// deterministic decider, one-shot state, loop/cadence detectors and cast-wake suppression read it
// through this adapter (one ContextMessage per logical message: a waifu's quick consecutive
// chunks are joined, as the old Discord fetch did).
// ---------------------------------------------------------------------------

/** Waifu authorship for ledger entries: known bot author ids, or a bot whose name is a cast name. */
export function waifuAuthorMatcher(o: { authorIds: Iterable<string>; names: Iterable<string> }): (entry: LedgerEntry) => boolean {
  const ids = new Set(o.authorIds);
  const names = new Set([...o.names].map((name) => name.trim().toLowerCase()).filter(Boolean));
  return (entry) => ids.has(entry.authorId) || (entry.authorIsBot && names.has(entry.authorName.trim().toLowerCase()));
}

export function ledgerToContextMessages(
  entries: readonly LedgerEntry[],
  o: { guildId?: string; channelId: string; isWaifu: (entry: LedgerEntry) => boolean }
): ContextMessage[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const out: ContextMessage[] = [];
  let previous: { entry: LedgerEntry; message: ContextMessage } | undefined;
  for (const entry of entries) {
    if (isGapEntry(entry) || entry.state === "deleted") continue;
    const waifu = o.isWaifu(entry);
    const target = entry.replyToId ? byId.get(entry.replyToId) : undefined;
    if (
      previous &&
      waifu &&
      previous.message.authorKind === "waifu" &&
      previous.entry.authorId === entry.authorId &&
      !entry.replyToId &&
      Date.parse(entry.at) - Date.parse(previous.entry.at) <= WAIFU_CHUNK_COALESCE_WINDOW_MS
    ) {
      previous.message.content = [previous.message.content, entry.body].filter(Boolean).join("\n");
      previous.message.sourceMessageIds = [...(previous.message.sourceMessageIds ?? [previous.entry.id]), entry.id];
      if (entry.images.length) {
        previous.message.images = [...(previous.message.images ?? []), ...entry.images.map((image) => ({ url: image.url, ...(image.contentType ? { contentType: image.contentType } : {}) }))];
      }
      previous = { entry, message: previous.message };
      continue;
    }
    const message: ContextMessage = {
      id: entry.id,
      channelId: o.channelId,
      ...(o.guildId ? { guildId: o.guildId } : {}),
      authorKind: waifu ? "waifu" : "user",
      authorId: entry.authorId,
      ...(entry.authorIsBot ? { authorBot: true } : {}),
      name: entry.authorName,
      displayName: entry.authorName,
      content: entry.body,
      timestamp: entry.at,
      ...(entry.images.length
        ? { images: entry.images.map((image) => ({ url: image.url, ...(image.contentType ? { contentType: image.contentType } : {}) })) }
        : {}),
      ...(entry.replyToId
        ? {
            replyTo: {
              messageId: entry.replyToId,
              ...(target ? { authorName: target.authorName, contentPreview: target.body.slice(0, 120) } : {})
            }
          }
        : {}),
      reactions: []
    };
    out.push(message);
    previous = { entry, message };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-pass state (tail) and its assessment
// ---------------------------------------------------------------------------

export type OrchestratorTurn = {
  /** Manual /run: at least one waifu must reply (enforced in code). */
  replyRequired: boolean;
  /** Decisions since a directive was last honoured, and the cooldown that reopens the budget. */
  directiveCount: number;
  directiveCooldown: number;
  /** Completed decisions for the channel, newest first (cast-cadence detector). */
  pastDecisions: ReadonlyArray<{ action: string }>;
  /** This pass is the timer wake a no_reply decision scheduled (B8: the recorded decision). */
  wake?: { scheduledSeconds: number; wakePlan?: string; decidedAt: string };
};

export type OrchestratorAssessment = {
  messages: ContextMessage[];
  loop: LoopAssessment;
  cadence: LoopAssessment;
  humanActiveNow: boolean;
  newestHumanAt?: string;
  /** What the runtime guardrail enforces this pass: a detected loop or an elapsed cooldown. */
  directiveBudgetOpen: boolean;
  runtimeNotice?: string;
};

export function assessOrchestratorTurn(
  messages: ContextMessage[],
  turn: Pick<OrchestratorTurn, "directiveCount" | "directiveCooldown" | "pastDecisions">,
  now: Date
): OrchestratorAssessment {
  const loop = assessLoop(messages);
  const newestHumanAt = messages.reduce<string | undefined>(
    (acc, message) =>
      message.authorKind === "user" && message.authorBot !== true && (!acc || message.timestamp > acc) ? message.timestamp : acc,
    undefined
  );
  const humanActiveNow = newestHumanAt !== undefined && now.getTime() - Date.parse(newestHumanAt) < HUMAN_RECENT_WINDOW_MS;
  // Only nag about early cast retirement while humans are actually around — in a dead room the
  // reply→pause rhythm is correct behavior, not a rut.
  const cadence = humanActiveNow ? assessCastCadence([...turn.pastDecisions]) : { suspected: false as const };
  const runtimeNotice = [loop.notice, cadence.notice].filter(Boolean).join("\n") || undefined;
  return {
    messages,
    loop,
    cadence,
    humanActiveNow,
    ...(newestHumanAt ? { newestHumanAt } : {}),
    directiveBudgetOpen: loop.suspected || turn.directiveCount >= turn.directiveCooldown,
    ...(runtimeNotice ? { runtimeNotice } : {})
  };
}

export function orchestratorTail(i: {
  cast: readonly CastCard[];
  turn: OrchestratorTurn;
  assessment: OrchestratorAssessment;
  now: Date;
  timeZone: string;
}): string {
  const { turn, assessment, now, timeZone } = i;
  const lines = [`Now: ${formatFullDate(now, timeZone)} ${formatClock(now, timeZone)}.`];
  if (i.cast.length) {
    lines.push("Cast right now:", ...rosterLines(i.cast, now, timeZone));
  }
  if (assessment.runtimeNotice) lines.push(`<runtime_notice>\n${assessment.runtimeNotice}\n</runtime_notice>`);
  if (turn.wake) {
    const plan = turn.wake.wakePlan ? ` Your plan was: "${turn.wake.wakePlan}".` : "";
    lines.push(
      `<wake>This pass is the wake you scheduled at ${formatClock(turn.wake.decidedAt, timeZone)}: the ${turn.wake.scheduledSeconds}s pause has elapsed with no new human message.${plan} Execute the plan now, or decide fresh if the room changed. Do not schedule another identical pause; act, or back off with a longer one.</wake>`
    );
  }
  lines.push(
    turn.replyRequired
      ? 'Reply required: yes. This is a manual /run: choose action "reply" with at least one waifu.'
      : "Reply required: no."
  );
  if (assessment.directiveBudgetOpen) {
    lines.push(
      assessment.loop.suspected
        ? "Directive budget: open (a loop is forming; a directive with a concrete new goal is the strongest move)."
        : "Directive budget: open."
    );
  } else {
    const remaining = Math.max(1, turn.directiveCooldown - turn.directiveCount);
    lines.push(`Directive budget: closed for ${remaining} more decision${remaining === 1 ? "" : "s"}; directives are stripped, so leave directive null.`);
  }
  return `<status>\n${lines.join("\n")}\n</status>\nCall ${ORCHESTRATOR_TOOL_NAME}.`;
}

export type OrchestratorRenderer = RoleRenderer & {
  /** The assessment behind the most recent tail (same transcript the prompt renders). */
  assessment(): OrchestratorAssessment | undefined;
};

export function createOrchestratorRenderer(i: {
  mode: OrchestratorMode;
  cast: readonly CastCard[];
  availableWaifuIds: readonly string[];
  place: string;
  pausePlanning: boolean;
  ownerPolicy?: string;
  turn: OrchestratorTurn;
  conversation: { guildId?: string; channelId: string };
  isWaifu: (entry: LedgerEntry) => boolean;
}): OrchestratorRenderer {
  const system = orchestratorSystemPrompt({
    cast: i.cast,
    pausePlanning: i.pausePlanning,
    ...(i.mode === "model" && i.ownerPolicy ? { ownerPolicy: i.ownerPolicy } : {})
  });
  const tools = orchestratorTools(i.availableWaifuIds);
  let last: OrchestratorAssessment | undefined;
  return {
    system: () => system,
    header: (_snapshot, state) => orchestratorHeader({ place: i.place }, state),
    tail: (state, now, extras) => {
      const messages = ledgerToContextMessages(extras.transcript ?? [], { ...i.conversation, isWaifu: i.isWaifu });
      last = assessOrchestratorTurn(messages, i.turn, now);
      return orchestratorTail({ cast: i.cast, turn: i.turn, assessment: last, now, timeZone: state.timeZone });
    },
    tools: () => tools,
    assessment: () => last
  };
}
