// Probe evaluation (spec §33.1): every check is on an outcome — what reached the fake server, her
// home files at a time, the wakes that fired, her wakeups' next firings — never on tool names or
// call shapes, so probes hold across tool rewrites. `passed: null` is "not applicable" (e.g. no
// summary happened between a fact and the question about it).

import { mentionsAny, longestBurst, messageLines } from "./metrics.js";
import { scenarioClock, scenarioStartMs, scenarioTimeMs, type Probe, type Scenario } from "./scenario.js";
import type { ProbeResult, SummaryCapture, TranscriptEvent } from "./types.js";

export type ProbeInput = {
  events: readonly TranscriptEvent[];
  summaries: readonly SummaryCapture[];
  home: Record<string, string>;
  checkpoints: ReadonlyArray<{ at: string; label: string; home: Record<string, string>; wakeupsDue: string[] }>;
};

type Sent = Extract<TranscriptEvent, { type: "sent" }>;
type People = Extract<TranscriptEvent, { type: "people" }>;

/** Her own wakeups: a reminder (at/every), a watch that matched or ended, a plan with a time. */
const OWN_WAKEUP_REASONS = new Set(["reminder", "watch", "watch_timeout", "plan"]);

function clip(text: string, max = 80): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function evaluateProbes(scenario: Scenario, input: ProbeInput): ProbeResult[] {
  const sent = input.events.filter((event): event is Sent => event.type === "sent");
  const people = input.events.filter((event): event is People => event.type === "people");
  const ms = (time: string) => scenarioTimeMs(scenario, time);
  const at = (event: { at: string }) => Date.parse(event.at);
  const when = (value: number) => scenarioClock(scenario, value);
  const labelled = (label: string) => people.find((event) => event.label === label);
  const compactedBetween = (fromMs: number, toMs: number) =>
    input.events.some((event) => event.type === "compaction" && (event.summarized || ["rest", "cache_rest", "self"].includes(event.reason)) && at(event) > fromMs && at(event) <= toMs);
  const homeAt = (time: string | undefined) => (time ? input.checkpoints.find((checkpoint) => checkpoint.label === time)?.home : input.home);

  const answered = (place: string, fromMs: number, toMs: number, phrases: readonly string[] | undefined): { ok: boolean; detail: string } => {
    const inPlace = sent.filter((message) => message.place === place && at(message) > fromMs && at(message) <= toMs);
    if (inPlace.length === 0) return { ok: false, detail: `nothing from her in ${place} between ${when(fromMs)} and ${when(toMs)}` };
    if (!phrases) return { ok: true, detail: `"${clip(inPlace[0]!.text)}" at ${when(at(inPlace[0]!))}` };
    for (const message of inPlace) {
      const hit = mentionsAny(message.text, phrases);
      if (hit) return { ok: true, detail: `"${clip(message.text)}" (${hit}) at ${when(at(message))}` };
    }
    return { ok: false, detail: `${inPlace.length} message(s) there, none mentioning ${phrases.join(" / ")}; first: "${clip(inPlace[0]!.text)}"` };
  };

  const one = (probe: Probe): Omit<ProbeResult, "id" | "kind"> => {
    switch (probe.kind) {
      case "replied": {
        const result = answered(probe.place, probe.after ? ms(probe.after) : scenarioStartMs(scenario) - 1, ms(probe.by), probe.mentions);
        return { passed: result.ok, detail: result.detail };
      }
      case "not_replied": {
        const target = labelled(probe.event);
        if (!target) return { passed: null, detail: `${probe.event} was never posted` };
        const replies = sent.filter((message) => message.replyTo === target.messageId);
        if (replies.length > 0) return { passed: false, detail: `she replied to it: "${clip(replies[0]!.text)}"` };
        const toMs = at(target) + probe.withinMinutes * 60_000;
        const nearby = sent.filter((message) => message.place === target.place && at(message) >= at(target) && at(message) <= toMs);
        const offending = probe.about ? nearby.filter((message) => mentionsAny(message.text, probe.about!) !== undefined) : nearby;
        return offending.length > 0
          ? { passed: false, detail: `"${clip(offending[0]!.text)}" at ${when(at(offending[0]!))}` }
          : { passed: true, detail: nearby.length > 0 ? `${nearby.length} unrelated message(s) nearby` : "quiet there" };
      }
      case "note_mentions": {
        const home = homeAt(probe.by);
        if (!home) return { passed: null, detail: `no snapshot at ${probe.by}` };
        const files = Object.entries(home).filter(([file]) => file !== "life/places.md" && (!probe.path || file.startsWith(probe.path.replace(/^~\//u, ""))));
        for (const [file, text] of files) {
          const hit = mentionsAny(text, probe.match);
          if (hit) return { passed: true, detail: `~/${file} (${hit})` };
        }
        return { passed: false, detail: `none of ${files.length} file(s) mention ${probe.match.join(" / ")}` };
      }
      case "wakeup_in_window": {
        const fromMs = ms(probe.from);
        const toMs = ms(probe.to);
        if (probe.mode === "scheduled") {
          const checkpoint = input.checkpoints.find((entry) => entry.label === (probe.checkAt ?? probe.from));
          if (!checkpoint) return { passed: null, detail: "no snapshot" };
          const hit = checkpoint.wakeupsDue.find((due) => Date.parse(due) >= fromMs && Date.parse(due) <= toMs);
          return hit ? { passed: true, detail: `one due ${when(Date.parse(hit))}` } : { passed: false, detail: `${checkpoint.wakeupsDue.length} wakeup(s), none due in the window` };
        }
        const fired = input.events.filter((event) => event.type === "wake" && OWN_WAKEUP_REASONS.has(event.reason) && event.outcome !== "dropped" && at(event) >= fromMs && at(event) <= toMs);
        return fired.length > 0
          ? { passed: true, detail: fired.map((event) => (event.type === "wake" ? `${event.reason} at ${when(at(event))}${event.note ? ` "${clip(event.note, 40)}"` : ""}` : "")).join("; ") }
          : { passed: false, detail: "no wakeup of hers fired in the window" };
      }
      case "followed_up": {
        const fromMs = ms(probe.from);
        const toMs = ms(probe.to);
        const candidates = sent.filter((message) => message.place === probe.place && at(message) >= fromMs && at(message) <= toMs);
        for (const message of candidates) {
          const prompted = people.some((event) => event.place === probe.place && at(event) >= fromMs && at(event) <= at(message));
          if (prompted) continue;
          if (probe.mentions && !mentionsAny(message.text, probe.mentions)) continue;
          return { passed: true, detail: `"${clip(message.text)}" at ${when(at(message))}` };
        }
        return { passed: false, detail: candidates.length > 0 ? `${candidates.length} message(s), none on her own${probe.mentions ? ` about ${probe.mentions.join(" / ")}` : ""}` : `nothing from her in ${probe.place} in the window` };
      }
      case "recalls": {
        const ask = labelled(probe.ask);
        if (!ask) return { passed: null, detail: `${probe.ask} was never posted` };
        const result = answered(ask.place, at(ask) - 1, at(ask) + probe.withinMinutes * 60_000, probe.mentions);
        return { passed: result.ok, detail: result.detail };
      }
      case "recall_after_compaction": {
        const fact = labelled(probe.fact);
        const ask = labelled(probe.ask);
        if (!fact || !ask) return { passed: null, detail: "fact or question never posted" };
        if (!compactedBetween(at(fact), at(ask))) return { passed: null, detail: "no summary between the fact and the question (n/a)" };
        const result = answered(ask.place, at(ask) - 1, at(ask) + probe.withinMinutes * 60_000, probe.mentions);
        return { passed: result.ok, detail: result.detail };
      }
      case "dm_never_in_server": {
        for (const message of sent) {
          if (message.dm) continue;
          const leaked = probe.secrets.find((secret) => message.text.toLowerCase().includes(secret.toLowerCase()));
          if (leaked) return { passed: false, detail: `"${leaked}" in ${message.place} at ${when(at(message))}: "${clip(message.text)}"` };
        }
        return { passed: true, detail: `${sent.filter((message) => !message.dm).length} server message(s) checked` };
      }
      case "max_line_length": {
        const lines = messageLines(input.events);
        const over = lines.filter((line) => [...line].length > probe.max);
        return over.length > 0 ? { passed: false, detail: `${over.length} of ${lines.length} line(s) over ${probe.max}; longest ${Math.max(...over.map((line) => [...line].length))}` } : { passed: true, detail: `${lines.length} line(s)` };
      }
      case "max_burst": {
        const longest = longestBurst(input.events);
        return { passed: longest <= probe.max, detail: `longest run ${longest}` };
      }
    }
  };

  return scenario.probes.map((probe) => {
    try {
      return { id: probe.id, kind: probe.kind, ...one(probe) };
    } catch (error) {
      return { id: probe.id, kind: probe.kind, passed: null, detail: `could not evaluate: ${error instanceof Error ? error.message : String(error)}` };
    }
  });
}
