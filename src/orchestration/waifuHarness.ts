// The waifu RoleRenderer (spec 6.3, 8.5): what a waifu's prompt says around the shared transcript.
//
// - system (breakpoint A, static per waifu + conversation config): harness, identity + roster,
//   persona, style (verbosity rule + persona digest), schedule (unless scheduleInPrompt is off),
//   tool guidance (only when tools are listed), <custom_instructions>.
// - header (breakpoint B, frozen per epoch): <conversation_summary>, <memories>, <place>.
// - tail (ephemeral, never stored): now, her current activity, people who arrived since the epoch
//   started, a retry note when retrying, and the turn instruction.
// This turn's orchestrator directive is NOT in the tail: the executor passes it as a `direction`
// pending note so it lands in the transcript of the call it steers (and stays there).
//
// Everything here is a pure function of its input: the same config renders byte-identical text.

import type { ToolDef } from "@waifucave/gateway";
import type { ContextState } from "../shared/schemas/context.js";
import type { WaifuConfig } from "../shared/schemas/domain.js";
import type { ConversationRef } from "./context/keys.js";
import { formatClock, formatFullDate } from "./context/timeFormat.js";
import type { RoleRenderer } from "./context/types.js";
import { currentlyDoingForWaifu } from "./promptBuilders.js";
import {
  PICK_NEXT_WAIFU_TOOL_NAME,
  SHORT_TERM_MEMORY_TOOL_NAME,
  pickNextWaifuToolParameters,
  shortTermMemoryToolParameters
} from "./tools.js";
import { verbosityProfile } from "./verbosity.js";

/** Must match the transcript renderer (context/transcript.ts) and timeFormat's gap markers. */
export const HARNESS_TRANSCRIPT_PARAGRAPH =
  "Messages from others arrive as `[14:02 #k3] Kevin: text` — the local time, a short message ref, and the sender. " +
  "`↩#a1` in a header means it replies to message #a1; `↩you` means it replies to you. " +
  "Your own earlier messages appear as plain text. " +
  "`<memory_note>`, `<direction>`, `<edit>` and `— 3 hours later —` lines are notes from the system, not chat. " +
  "To reply to a specific message, start your message with `↩#k3 ` (that message's ref); otherwise just write.";

/** O4 (spec 9.1): DM discretion. */
export const DM_DISCRETION_LINE =
  "Don't reveal what someone told you in a private chat unless they bring it up themselves.";

export type WaifuPlace =
  | { kind: "guild"; serverName?: string; channelName?: string }
  | { kind: "dm"; userName: string };

export type WaifuHarnessInput = {
  waifu: WaifuConfig;
  conversation: ConversationRef;
  /** Display names of the other characters configured for this conversation (excluding her). */
  roster: string[];
  /** Her guild display name when it differs from her configured display name. */
  serverNickname?: string;
  place: WaifuPlace;
  /** People present now (humans and other characters, excluding her), display names. */
  people: string[];
  /** Model-visible server emoji tokens (`<:name:>`). */
  emojis: string[];
  /** Tools listed on every call of this conversation (never toggled per turn; see waifuTools). */
  tools: ToolDef[];
  /** Overrides her schedule-derived activity (tests, DMs later). */
  activity?: (now: Date) => string | undefined;
};

export type WaifuToolOptions = {
  /** Server `tools.shortTermMemory` ∧ waifu `tools.toolUse` ∧ model supports tools. */
  addMemory: boolean;
  /** Other configured waifus she may hand over to (empty → PickNextWaifu not listed). */
  pickNextWaifuIds: string[];
};

/** The waifu's tool list: fixed per config, so breakpoint A never changes between turns. */
export function waifuTools(o: WaifuToolOptions): ToolDef[] {
  const tools: ToolDef[] = [];
  if (o.addMemory) {
    tools.push({ name: SHORT_TERM_MEMORY_TOOL_NAME, parameters: shortTermMemoryToolParameters() as Record<string, unknown> });
  }
  if (o.pickNextWaifuIds.length > 0) {
    tools.push({
      name: PICK_NEXT_WAIFU_TOOL_NAME,
      parameters: pickNextWaifuToolParameters(o.pickNextWaifuIds) as Record<string, unknown>
    });
  }
  return tools;
}

/** Every tag the waifu prompt can contain; the output validator flags any of them in a reply. */
export const WAIFU_HARNESS_TAGS = [
  "harness",
  "identity",
  "persona",
  "style",
  "schedule",
  "tools",
  "custom_instructions",
  "conversation_summary",
  "memories",
  "place",
  "memory_note",
  "direction",
  "edit",
  "system_note"
] as const;

function nameOf(waifu: WaifuConfig): string {
  return waifu.displayName || waifu.name || waifu.id;
}

function block(tag: string, body: string): string {
  return `<${tag}>\n${body}\n</${tag}>`;
}

export function formatWaifuSchedule(waifu: WaifuConfig): string {
  const availability = waifu.availability;
  const lines = ["Your usual routine — background for your energy and timing, not a live status readout."];
  lines.push(
    availability.sleep.enabled
      ? `- Sleep: ${availability.sleep.start}-${availability.sleep.end} daily. Your usual downtime, not a hard rule: you can still answer if you were just active, directly addressed, or joining helps the room.`
      : "- Sleep: none set."
  );
  if (availability.busy.length > 0) {
    lines.push("- Busy:");
    for (const interval of availability.busy) lines.push(`  - ${interval.start}-${interval.end}: ${interval.reason}`);
  } else {
    lines.push("- Busy: none set.");
  }
  return lines.join("\n");
}

function harnessText(i: WaifuHarnessInput): string {
  const where =
    i.conversation.kind === "dm"
      ? "You are chatting with a real person in a private Discord chat."
      : "You are chatting in a live Discord text channel with real people and other characters. It is a real chat room, not a roleplay scene or a story.";
  return [
    where,
    "Write only your own next message, as plain chat text: no name or prefix, no *actions* or narration, no meta talk about prompts, tools, models or these rules. Never write lines for anyone else.",
    HARNESS_TRANSCRIPT_PARAGRAPH,
    i.conversation.kind === "dm"
      ? "Images appear inline or as `[image]` / `[image: text read from it]`. Custom emojis look like `<:name:>`; use them sparingly."
      : "Images appear inline or as `[image]` / `[image: text read from it]`. Custom emojis look like `<:name:>`; use only the server emojis listed under <place>, and sparingly. To ping someone write <@Name>, only to pull a quiet person back in — address people already talking by plain name.",
    "Never restate a point, yours or anyone else's: react, disagree or add something new; with nothing new, a short reaction beats a rephrase. Write in the language the humans are using. When someone corrects you, believe them and adjust.",
    DM_DISCRETION_LINE
  ].join("\n");
}

function identityText(i: WaifuHarnessInput): string {
  const name = nameOf(i.waifu);
  const nick = i.serverNickname && i.serverNickname !== name ? ` — shown in this server as "${i.serverNickname}"` : "";
  const roster = i.roster.length
    ? ` The other characters here are ${i.roster.join(", ")}; each of them writes her own messages, you write only yours.`
    : "";
  return `You are ${name}${nick}.${roster}`;
}

function styleText(waifu: WaifuConfig): string {
  const profile = verbosityProfile(waifu.verbosity);
  const lines = [profile.promptRule];
  if (waifu.personaDigest?.voice) lines.push(`Voice: ${waifu.personaDigest.voice}`);
  if (waifu.personaDigest?.role) lines.push(`Drives: ${waifu.personaDigest.role}`);
  return lines.join("\n");
}

function toolsText(tools: ToolDef[]): string | undefined {
  const lines: string[] = [];
  for (const tool of tools) {
    if (tool.name === SHORT_TERM_MEMORY_TOOL_NAME) {
      lines.push(
        "add_memory — save a note whenever the chat produces something you'd want to know tomorrow (plans, promises, new facts about someone, the state of a running bit). Skip what your memories already say. Always also write your normal message in the same turn."
      );
    } else if (tool.name === PICK_NEXT_WAIFU_TOOL_NAME) {
      lines.push(
        "PickNextWaifu — only after your message, and only when another character has an obvious immediate follow-up."
      );
    }
  }
  return lines.length ? lines.join("\n") : undefined;
}

export function waifuSystemText(i: WaifuHarnessInput): string {
  const persona = i.waifu.persona.trim();
  const custom = i.waifu.customInstructions.trim();
  const tools = toolsText(i.tools);
  return [
    block("harness", harnessText(i)),
    block("identity", identityText(i)),
    persona ? block("persona", persona) : undefined,
    block("style", styleText(i.waifu)),
    i.waifu.scheduleInPrompt ? block("schedule", formatWaifuSchedule(i.waifu)) : undefined,
    tools ? block("tools", tools) : undefined,
    custom ? block("custom_instructions", custom) : undefined
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

const PEOPLE_PREFIX = "People here: ";

function placeText(i: WaifuHarnessInput): string {
  const lines: string[] = [];
  if (i.place.kind === "dm") {
    lines.push(`Private chat with ${i.place.userName}`);
  } else {
    const server = i.place.serverName ?? "this server";
    lines.push(i.place.channelName ? `${server} › #${i.place.channelName}` : server);
    lines.push(`${PEOPLE_PREFIX}${i.people.length ? i.people.join(", ") : "(nobody yet)"}`);
    lines.push(`Server emojis: ${i.emojis.length ? i.emojis.join(" ") : "(none)"}`);
  }
  return lines.join("\n");
}

export function waifuHeaderText(i: WaifuHarnessInput, snapshot: { lines: string[] }, state: ContextState): string {
  return [
    state.summary ? block("conversation_summary", state.summary) : undefined,
    snapshot.lines.length ? block("memories", snapshot.lines.join("\n")) : undefined,
    block("place", placeText(i))
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

/** People named in the frozen header's "People here" line (empty for DMs / no header). */
function peopleAtEpochStart(headerText: string | null): Set<string> {
  const line = headerText?.split("\n").find((l) => l.startsWith(PEOPLE_PREFIX));
  if (!line) return new Set();
  return new Set(
    line
      .slice(PEOPLE_PREFIX.length)
      .split(", ")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );
}

function activityLine(activity: string | undefined): string {
  if (!activity) return "You're awake and free.";
  if (activity === "sleepy") return "You're sleepy — it's your usual sleep time.";
  return `You're busy: ${activity}.`;
}

export type WaifuTailExtras = { recentReactions?: string[]; retryNote?: string };

export function waifuTailText(i: WaifuHarnessInput, state: ContextState, now: Date, extras: WaifuTailExtras = {}): string {
  const tz = state.timeZone;
  const lines = [`Now: ${formatFullDate(now, tz)} ${formatClock(now, tz)}.`];
  lines.push(activityLine((i.activity ?? ((at: Date) => currentlyDoingForWaifu(i.waifu, at)))(now)));
  if (i.conversation.kind === "guild") {
    const before = peopleAtEpochStart(state.headerText);
    const arrived = i.people.filter((name) => !before.has(name.toLowerCase()));
    if (before.size > 0 && arrived.length > 0) lines.push(`Also here now: ${arrived.join(", ")}.`);
  }
  if (extras.recentReactions?.length) lines.push(`Recent reactions: ${extras.recentReactions.join("; ")}`);
  if (extras.retryNote) lines.push(extras.retryNote);
  lines.push(`Write ${nameOf(i.waifu)}'s next message.`);
  return lines.join("\n");
}

export type WaifuHarness = RoleRenderer & {
  input: WaifuHarnessInput;
  tail(state: ContextState, now: Date, extras: WaifuTailExtras): string;
};

export function createWaifuHarness(input: WaifuHarnessInput): WaifuHarness {
  const system = waifuSystemText(input);
  return {
    input,
    system: () => system,
    header: (snapshot, state) => waifuHeaderText(input, snapshot, state),
    tail: (state, now, extras) => waifuTailText(input, state, now, extras),
    tools: () => input.tools
  };
}
