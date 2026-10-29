// Judged quality (spec §33.3): for runs past the gate the benchmark writes compact judge packets
// (the persona, the rubric, an anonymised transcript or a summary with its input; never the model's
// name), the developer's Claude Code session hands them to Opus subagents, each writes a grade JSON
// file, and `merge-grades` folds those grades back into summary.json and the report. Runs below the
// gate are ranked on the automatic metrics alone.

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { scenarioClock, type Scenario } from "./scenario.js";
import type { GradeSummary, RunSummary, SummaryCapture, TranscriptEvent } from "./types.js";

export const CHAT_CRITERIA = {
  in_character: "She sounds like her persona and style in every message: tastes, opinions, mood, way of writing. 5 = unmistakably her; 1 = generic assistant voice.",
  natural_short: "Messages read like a person in a Discord chat: short lines, several small messages rather than one paragraph, no assistant tidiness (no lists, no offers of more help). 5 = indistinguishable from a regular; 1 = essays or bot-speak.",
  relevant: "She answers what was actually said to her, keeps track of who said what, follows up on what she promised, and stays quiet when a message is not for her. 5 = always on point; 1 = confused, repetitive or replying to the wrong person.",
  kind_to_room: "She is good company for the whole room: warm or playful as fits, never spammy, doesn't derail or dominate, keeps private things private. 5 = everyone would want her around; 1 = annoying or hurtful."
} as const;

export const SAME_PERSONALITY_CRITERION = {
  same_personality: "Compared with the REFERENCE transcript (the shipped prompt on the same scenario), is she still the same person: same voice, humour, tastes and attitude? 5 = clearly the same person; 1 = a different character."
} as const;

export const SUMMARY_CRITERIA = {
  faithful: "Everything the summary says is supported by the input or the context. 5 = fully faithful; 1 = mostly wrong.",
  complete: "It keeps what matters to her: who people are, promises, plans and times, preferences, running jokes, open questions. 5 = nothing important lost; 1 = most of it lost.",
  nothing_invented: "No facts, events, people or promises that are in neither the input nor the context. 5 = none invented; 1 = several inventions. List each invention in `invented`.",
  keeps_voice: "It reads like her own memory in her own voice (first person, her tone), not a neutral report. 5 = clearly hers; 1 = a clinical log.",
  open_threads: "It keeps her open threads: questions she is waiting on, follow-ups she meant to do, what she was in the middle of. 5 = all kept; 1 = none kept."
} as const;

export type PacketKind = "chat" | "summary";

export type JudgePacket = {
  packet: string;
  kind: PacketKind;
  instructions: string;
  rubric: Record<string, string>;
  /** Who she is (the scenario's persona and style); the model is never named. */
  persona: { name: string; persona: string; style: string };
  scenario: { title: string; description: string };
  /** chat: the conversation as the people saw it. */
  transcript?: string;
  /** chat, variants: the baseline prompt's transcript of the same scenario. */
  reference?: string;
  /** summary: what she already knew (her notes index, her summary before, her places), what was summarised and what she wrote. */
  context?: string;
  input?: string;
  summary?: string;
  summaryKind?: string;
  /** The JSON a grader writes (one file per packet). */
  answerFormat: unknown;
};

/** What a grader writes: one object (or a list) per packet, into `<out>/grades/*.json`. */
export const GradeSchema = z.object({
  packet: z.string().regex(/^[a-z0-9-]+$/u),
  grader: z.string().max(200).optional(),
  scores: z.record(z.string(), z.number().min(1).max(5)),
  notes: z.string().max(4_000).optional(),
  /** summary packets: invented facts, one per entry. */
  invented: z.array(z.string().max(500)).default([]),
  /** Anything worth a human look (a leak, a broken character, a loop). */
  flags: z.array(z.string().max(500)).default([])
});
export type Grade = z.infer<typeof GradeSchema>;

export const GradeFileSchema = z.union([GradeSchema, z.array(GradeSchema)]);

/** packet id → which run (and summary) it is about; never given to graders. */
export type PacketIndex = Record<string, { runId: string; kind: PacketKind; summaryId?: string; criteria: string[] }>;

export function answerFormat(criteria: readonly string[], kind: PacketKind): unknown {
  return {
    packet: "<this packet's id>",
    grader: "<optional: who graded>",
    scores: Object.fromEntries(criteria.map((name) => [name, "<1-5>"])),
    notes: "<two or three sentences: why>",
    ...(kind === "summary" ? { invented: ["<each invented fact, if any>"] } : {}),
    flags: ["<anything a human should look at, if any>"]
  };
}

const CHAT_INSTRUCTIONS =
  "You are grading one AI character's chat on a Discord server. Read her persona, then the transcript (the people's lines are fixed and never react to her; lines marked `(her)` are hers; DM lines are private between her and that person). Score each rubric criterion from 1 to 5 using the whole transcript, judging only what she sent. Be strict and consistent; 3 is an ordinary, acceptable result. Write only the JSON in `answerFormat`.";
const SUMMARY_INSTRUCTIONS =
  "You are grading a summary an AI character wrote (or that was written for her) of a stretch of her life, to keep as her memory. Compare SUMMARY against INPUT (the conversation and tool results she summarised) and CONTEXT when given (what she already knew as this stretch began: her notes index and her earlier summary). A fact carried over from CONTEXT is supported, not invented. Score each rubric criterion from 1 to 5, list every invented fact in `invented`, and write only the JSON in `answerFormat`.";

/** The conversation as people saw it, oldest first; her lines marked `(her)`. No model name, no tool calls. */
export function renderChat(scenario: Scenario, events: readonly TranscriptEvent[]): string {
  const her = scenario.waifu.displayName ?? scenario.waifu.name;
  const where = (place: string) => (place.startsWith("dm:") ? `DM with ${scenario.people.find((person) => `dm:${person.key}` === place)?.name ?? place.slice(3)}` : place);
  const lines: string[] = [];
  for (const event of events) {
    const at = (iso: string) => scenarioClock(scenario, Date.parse(iso));
    if (event.type === "people") lines.push(`[${at(event.at)} ${where(event.place)}] ${event.from}: ${event.text}${event.attachments?.length ? ` [attached ${event.attachments.join(", ")}]` : ""}`);
    else if (event.type === "sent") lines.push(`[${at(event.at)} ${where(event.place)}] ${her} (her): ${event.text}${event.files?.length ? ` [attached ${event.files.join(", ")}]` : ""}`);
    else if (event.type === "reaction") lines.push(`[${at(event.at)} ${where(event.place)}] ${her} (her) reacted ${event.emoji}`);
  }
  return lines.join("\n");
}

function packetId(): string {
  return randomBytes(5).toString("hex");
}

export type GateOptions = { minFirstTry: number; minProbes: number };

/** Past the gate: the run finished, its tools mostly worked first time and enough probes passed. */
export function gateOf(summary: RunSummary, gate: GateOptions): { passed: boolean; why: string } {
  if (summary.status !== "done") return { passed: false, why: `status ${summary.status}` };
  const m = summary.metrics;
  const firstTry = m.firstTrySuccess ?? 1;
  const probes = m.probesScored > 0 ? m.probesPassed / m.probesScored : 1;
  if (firstTry < gate.minFirstTry) return { passed: false, why: `first-try tool success ${(firstTry * 100).toFixed(0)}% < ${(gate.minFirstTry * 100).toFixed(0)}%` };
  if (probes < gate.minProbes) return { passed: false, why: `probes ${(probes * 100).toFixed(0)}% < ${(gate.minProbes * 100).toFixed(0)}%` };
  if (m.messages === 0) return { passed: false, why: "she sent nothing" };
  return { passed: true, why: `first-try ${(firstTry * 100).toFixed(0)}%, probes ${(probes * 100).toFixed(0)}%` };
}

const SUMMARY_INPUT_MAX = 80_000;

function capped(text: string, what: string): string {
  return text.length > SUMMARY_INPUT_MAX ? `${text.slice(0, SUMMARY_INPUT_MAX)}\n[… ${what} cut at ${SUMMARY_INPUT_MAX} characters]` : text;
}

/** Her system blocks after block A (whose rules and persona the packet has): what she knew going in. */
function summaryContext(capture: SummaryCapture): string | undefined {
  const blocks = capture.input.system ?? [];
  if (capture.kind === "dream" || blocks.length < 2) return undefined;
  const text = blocks.slice(1).join("\n\n").trim();
  return text ? capped(text, "context") : undefined;
}

/**
 * Packets for one run: the chat (with the baseline's transcript as reference for a variant) and
 * every model-made summary (her rest/self summaries, the app's compactions, the dream's changes).
 */
export function packetsForRun(o: {
  scenario: Scenario;
  summary: RunSummary;
  events: readonly TranscriptEvent[];
  summaries: readonly SummaryCapture[];
  reference?: readonly TranscriptEvent[];
}): Array<{ packet: JudgePacket; index: PacketIndex[string] }> {
  const persona = { name: o.scenario.waifu.displayName ?? o.scenario.waifu.name, persona: o.scenario.waifu.persona, style: o.scenario.waifu.style };
  const scenarioInfo = { title: o.scenario.title, description: o.scenario.description };
  const out: Array<{ packet: JudgePacket; index: PacketIndex[string] }> = [];
  const variant = o.summary.variant !== "baseline" && o.reference !== undefined;
  const chatRubric: Record<string, string> = { ...CHAT_CRITERIA, ...(variant ? SAME_PERSONALITY_CRITERION : {}) };
  const chatId = packetId();
  out.push({
    packet: {
      packet: chatId,
      kind: "chat",
      instructions: CHAT_INSTRUCTIONS,
      rubric: chatRubric,
      persona,
      scenario: scenarioInfo,
      transcript: renderChat(o.scenario, o.events),
      ...(variant ? { reference: renderChat(o.scenario, o.reference!) } : {}),
      answerFormat: answerFormat(Object.keys(chatRubric), "chat")
    },
    index: { runId: o.summary.runId, kind: "chat", criteria: Object.keys(chatRubric) }
  });
  for (const capture of o.summaries) {
    if (capture.kind === "morning" || !capture.output.trim()) continue;
    const id = packetId();
    const context = summaryContext(capture);
    out.push({
      packet: {
        packet: id,
        kind: "summary",
        instructions: SUMMARY_INSTRUCTIONS,
        rubric: { ...SUMMARY_CRITERIA },
        persona,
        scenario: scenarioInfo,
        ...(context ? { context } : {}),
        input: capped(capture.input.text, "input"),
        summary: capture.output,
        summaryKind: capture.kind === "dream" ? "her notes changed overnight by a memory keeper" : capture.kind === "compaction" ? "the app summarised her context" : "she summarised her own context",
        answerFormat: answerFormat(Object.keys(SUMMARY_CRITERIA), "summary")
      },
      index: { runId: o.summary.runId, kind: "summary", summaryId: capture.id, criteria: Object.keys(SUMMARY_CRITERIA) }
    });
  }
  return out;
}

/** Grades folded per run: the mean of each criterion over its packets and graders. */
export function mergeGrades(index: PacketIndex, grades: readonly Grade[]): { byRun: Map<string, GradeSummary>; unknown: string[]; problems: string[] } {
  type RunGrades = { chat: Map<string, number[]>; summaries: Map<string, number[]>; graders: Set<string>; flags: string[] };
  const byRun = new Map<string, RunGrades>();
  const unknown: string[] = [];
  const problems: string[] = [];
  for (const grade of grades) {
    const entry = index[grade.packet];
    if (!entry) {
      unknown.push(grade.packet);
      continue;
    }
    const missing = entry.criteria.filter((name) => grade.scores[name] === undefined);
    if (missing.length > 0) problems.push(`${grade.packet}: no score for ${missing.join(", ")}`);
    const run: RunGrades = byRun.get(entry.runId) ?? { chat: new Map(), summaries: new Map(), graders: new Set(), flags: [] };
    byRun.set(entry.runId, run);
    run.graders.add(grade.grader ?? grade.packet);
    const target = entry.kind === "chat" ? run.chat : run.summaries;
    for (const name of entry.criteria) {
      const score = grade.scores[name];
      if (score === undefined) continue;
      target.set(name, [...(target.get(name) ?? []), score]);
    }
    for (const flag of grade.flags) run.flags.push(flag);
    for (const invented of grade.invented) run.flags.push(`invented: ${invented}`);
  }
  const mean = (values: number[]) => Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
  const out = new Map<string, GradeSummary>();
  for (const [runId, run] of byRun) {
    out.set(runId, {
      ...(run.chat.size > 0 ? { chat: Object.fromEntries([...run.chat].map(([name, values]) => [name, mean(values)])) } : {}),
      ...(run.summaries.size > 0 ? { summaries: Object.fromEntries([...run.summaries].map(([name, values]) => [name, mean(values)])) } : {}),
      graders: run.graders.size,
      flags: run.flags.slice(0, 20)
    });
  }
  return { byRun: out, unknown, problems };
}
