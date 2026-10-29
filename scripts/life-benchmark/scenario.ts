// Life benchmark scenarios (spec §33.1): one server (or none), the people, the waifu under test,
// her starting home files, a start time and zone, a fixed timeline of what the people say, the
// facts a summary must keep, and probes that check outcomes (never tool names or call shapes).
//
// Times are written `d<day> HH:MM[:SS]` in the scenario's own time zone, day 1 being `start.date`.
// Places are `#channel` (the scenario's one server) or `dm:<person>`. People are referred to by key.

import { z } from "zod";

const TIME_RE = /^d(\d{1,2}) ([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/u;
const KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/u;
const SNOWFLAKE_RE = /^\d{17,20}$/u;

const Time = z.string().regex(TIME_RE, "a time is `d<day> HH:MM[:SS]`, e.g. `d1 09:15`");
const Key = z.string().regex(KEY_RE, "a key is lowercase letters, digits, - or _");
const Place = z.string().regex(/^(#[a-z0-9][a-z0-9_-]{0,63}|dm:[a-z][a-z0-9_-]{0,31})$/u, "a place is `#channel` or `dm:<person>`");

export const PersonSchema = z.object({
  key: Key,
  /** Discord user id (a snowflake); made up, stable per scenario. */
  id: z.string().regex(SNOWFLAKE_RE),
  /** The name the server shows. */
  name: z.string().min(1).max(32)
});

export const ChannelSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u),
  id: z.string().regex(SNOWFLAKE_RE),
  /** She is cast here (default). A channel she is not cast in still exists for the people. */
  cast: z.boolean().default(true)
});

export const AttachmentSchema = z.object({
  name: z.string().min(1).max(100),
  contentType: z.string().min(1),
  /** A text file's contents. */
  text: z.string().max(20_000).optional(),
  /** A generated one-colour PNG (an image people post). */
  png: z.object({ width: z.number().int().min(1).max(256), height: z.number().int().min(1).max(256), rgb: z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]) }).optional()
});

/** What the scripted addressee detector answers for a burst whose newest message is this one. */
export const DetectorPickSchema = z.enum(["her", "human", "chime", "anyone", "all", "none"]);

export const MessageEventSchema = z.object({
  kind: z.literal("message").default("message"),
  at: Time,
  /** A label for probes and replies. */
  label: Key.optional(),
  place: Place,
  from: Key,
  text: z.string().max(4_000),
  /** A Discord reply to an earlier labelled message (`her:<n>` is her n-th message, 1-based). */
  replyTo: z.string().min(1).optional(),
  /** People (keys) or `her` mentioned with `<@id>` (put `@name` in the text where it goes). */
  mentions: z.array(z.string()).default([]),
  everyone: z.boolean().default(false),
  attachments: z.array(AttachmentSchema).default([]),
  /** Overrides the scripted detector's default pick (guild messages only). */
  detector: DetectorPickSchema.optional()
});

export const JoinEventSchema = z.object({ kind: z.literal("join"), at: Time, label: Key.optional(), place: Place, who: Key });
/** Documentation only: a quiet stretch (nothing happens; the clock still runs her day). */
export const QuietEventSchema = z.object({ kind: z.literal("quiet"), at: Time, until: Time, note: z.string().optional() });

export const EventSchema = z.union([JoinEventSchema, QuietEventSchema, MessageEventSchema]);

/** A fact a summary must keep: found when any alternative's words all appear in it. */
export const FactSchema = z.object({
  id: Key,
  kind: z.enum(["who", "promise", "plan", "preference", "open_question"]),
  text: z.string().min(1),
  /** Alternatives; each is a few words that must all appear (case-insensitive). */
  match: z.array(z.string().min(1)).min(1),
  /** The label of the message that states it (summaries made before it are not scored on it). */
  from: Key.optional()
});

const words = z.array(z.string().min(1)).min(1);

export const ProbeSchema = z.discriminatedUnion("kind", [
  /** By `by`, she sent a message in `place` (after `after`, when given) mentioning any of `mentions`. */
  z.object({ id: Key, kind: z.literal("replied"), place: Place, after: Time.optional(), by: Time, mentions: words.optional() }),
  /** She did not answer a message that was not for her: no Discord reply to it, and within `withinMinutes` no message of hers in its place (mentioning any of `about`, when given). */
  z.object({ id: Key, kind: z.literal("not_replied"), event: Key, withinMinutes: z.number().int().min(1).max(1_440).default(30), about: words.optional() }),
  /** At `by` (default the end), a text file under her home (optionally under `path`) mentions all words of one alternative. */
  z.object({ id: Key, kind: z.literal("note_mentions"), match: words, by: Time.optional(), path: z.string().optional() }),
  /** A wakeup of hers fired between `from` and `to` (`fired`), or at `checkAt` her ~/life/wakeups.json holds one due in the window (`scheduled`). */
  z.object({ id: Key, kind: z.literal("wakeup_in_window"), from: Time, to: Time, mode: z.enum(["fired", "scheduled"]).default("fired"), checkAt: Time.optional() }),
  /** Between `from` and `to` she wrote in `place` on her own (nobody wrote there in the window before her), mentioning any of `mentions`. */
  z.object({ id: Key, kind: z.literal("followed_up"), place: Place, from: Time, to: Time, mentions: words.optional() }),
  /** Within `withinMinutes` of the `ask` message she answered in its place mentioning any of `mentions`. */
  z.object({ id: Key, kind: z.literal("recalls"), ask: Key, withinMinutes: z.number().int().min(1).max(1_440).default(30), mentions: words }),
  /** D14: none of these phrases (from a DM) appears in anything she sent to a server place. */
  z.object({ id: Key, kind: z.literal("dm_never_in_server"), secrets: words }),
  /** No line of a message of hers is longer than `max` characters. */
  z.object({ id: Key, kind: z.literal("max_line_length"), max: z.number().int().min(10).max(4_000) }),
  /** She never sent more than `max` messages in a row in one place (nobody else in between). */
  z.object({ id: Key, kind: z.literal("max_burst"), max: z.number().int().min(1).max(50) }),
  /** Like `recalls`, scored only when her memory was summarised between `fact` and `ask` (otherwise n/a). */
  z.object({ id: Key, kind: z.literal("recall_after_compaction"), fact: Key, ask: Key, withinMinutes: z.number().int().min(1).max(1_440).default(30), mentions: words })
]);

/** Dry-run only (`--dry-run`, tests): what the scripted fake model does when a turn's input contains `when`. */
export const DryRuleSchema = z.object({
  when: z.string().min(1),
  send: z.object({ place: z.string().min(1), text: z.string().min(1) }).optional(),
  note: z.object({ path: z.string().min(1), text: z.string().min(1) }).optional(),
  wakeup: z.object({ when: z.string().min(1), note: z.string().min(1) }).optional(),
  /** Fire once (default) or every time. */
  once: z.boolean().default(true)
});

export const ScenarioSchema = z.object({
  id: Key,
  title: z.string().min(1),
  description: z.string().min(1),
  start: z.object({
    /** Local date of day 1, YYYY-MM-DD. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
    timeZone: z.string().min(1)
  }),
  end: Time,
  server: z.object({ id: z.string().regex(SNOWFLAKE_RE), name: z.string().min(1).max(100), channels: z.array(ChannelSchema).min(1) }).optional(),
  people: z.array(PersonSchema).min(1),
  waifu: z.object({
    name: z.string().min(1).max(32),
    displayName: z.string().min(1).max(32).optional(),
    persona: z.string().min(1),
    /** How she writes; becomes her custom instructions. */
    style: z.string().default(""),
    bedTime: z.object({ start: z.string().regex(/^\d{2}:\d{2}$/u), end: z.string().regex(/^\d{2}:\d{2}$/u) }).optional(),
    /** Discord user id of her bot. */
    botUserId: z.string().regex(SNOWFLAKE_RE).default("990000000000000001"),
    /** Her home at the start: path under ~ → text. */
    homeFiles: z.record(z.string(), z.string()).default({})
  }),
  /** App config for the run (deep-merged over the defaults): e.g. a smaller `life.maxContextTokens` so she rests within the scenario. */
  config: z.record(z.string(), z.unknown()).default({}),
  events: z.array(EventSchema).min(1),
  facts: z.array(FactSchema).default([]),
  probes: z.array(ProbeSchema).default([]),
  /** Scheduler tick in simulated minutes between events (the app ticks every 15 s). */
  tickMinutes: z.number().int().min(1).max(60).default(5),
  dryRun: z.array(DryRuleSchema).default([])
});

export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioInput = z.input<typeof ScenarioSchema>;
export type ScenarioEvent = z.infer<typeof EventSchema>;
export type MessageEvent = z.infer<typeof MessageEventSchema>;
export type Probe = z.infer<typeof ProbeSchema>;
export type Fact = z.infer<typeof FactSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type DetectorPick = z.infer<typeof DetectorPickSchema>;

/** Typed authoring with the defaults filled in and every cross-reference checked. */
export function defineScenario(input: ScenarioInput): Scenario {
  const scenario = ScenarioSchema.parse(input);
  const problems = checkScenario(scenario);
  if (problems.length > 0) throw new Error(`Scenario ${scenario.id}: ${problems.join("; ")}`);
  return scenario;
}

/** Wall-clock ms of a scenario time (`d2 19:00`) in its time zone. */
export function scenarioTimeMs(scenario: Pick<Scenario, "start">, time: string): number {
  const match = TIME_RE.exec(time);
  if (!match) throw new Error(`Bad time ${time}`);
  const [, day, hh, mm, ss] = match;
  const [y, m, d] = scenario.start.date.split("-").map(Number) as [number, number, number];
  return zonedMs(scenario.start.timeZone, y, m, d + Number(day) - 1, Number(hh), Number(mm), Number(ss ?? 0));
}

/** The start time (day 1 at `start.time`). */
export function scenarioStartMs(scenario: Pick<Scenario, "start">): number {
  return scenarioTimeMs(scenario, `d1 ${scenario.start.time}`);
}

/** `ms` as `d<day> HH:MM` in the scenario's zone (reports). */
export function scenarioClock(scenario: Pick<Scenario, "start">, ms: number): string {
  const parts = localParts(scenario.start.timeZone, ms);
  const [y, m, d] = scenario.start.date.split("-").map(Number) as [number, number, number];
  const day = Math.round((Date.UTC(parts.year, parts.month - 1, parts.day) - Date.UTC(y, m - 1, d)) / 86_400_000) + 1;
  return `d${day} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function localParts(timeZone: string, ms: number) {
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
  const out: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(ms))) if (part.type !== "literal") out[part.type] = Number(part.value);
  return { year: out.year!, month: out.month!, day: out.day!, hour: out.hour!, minute: out.minute!, second: out.second! };
}

/** Local wall time in a zone → epoch ms (two passes over the zone's offset, so DST edges settle). */
function zonedMs(timeZone: string, y: number, m: number, d: number, hh: number, mm: number, ss: number): number {
  const wanted = Date.UTC(y, m - 1, d, hh, mm, ss);
  let guess = wanted;
  for (let pass = 0; pass < 3; pass += 1) {
    const p = localParts(timeZone, guess);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += wanted - shown;
  }
  return guess;
}

/** Cross-references: people, channels, labels, replies, probes, facts; times in order and inside the run. */
export function checkScenario(scenario: Scenario): string[] {
  const problems: string[] = [];
  const people = new Set(scenario.people.map((person) => person.key));
  const channels = new Set((scenario.server?.channels ?? []).map((channel) => `#${channel.key}`));
  const labels = new Map<string, ScenarioEvent>();
  const ids = new Set<string>();
  for (const person of scenario.people) {
    if (ids.has(person.id)) problems.push(`duplicate id ${person.id}`);
    ids.add(person.id);
  }
  if (people.size !== scenario.people.length) problems.push("duplicate person key");
  const startMs = scenarioStartMs(scenario);
  const endMs = scenarioTimeMs(scenario, scenario.end);
  if (endMs <= startMs) problems.push("end is before the start");
  const placeOk = (place: string) => (place.startsWith("dm:") ? people.has(place.slice(3)) : channels.has(place));
  let previous = startMs;
  for (const [index, event] of scenario.events.entries()) {
    const at = scenarioTimeMs(scenario, event.at);
    if (at < previous) problems.push(`event ${index + 1} (${event.at}) is earlier than the one before it`);
    if (at < startMs || at > endMs) problems.push(`event ${index + 1} (${event.at}) is outside the run`);
    previous = at;
    if (event.kind === "quiet") continue;
    if (event.label) {
      if (labels.has(event.label)) problems.push(`duplicate label ${event.label}`);
      labels.set(event.label, event);
    }
    if (!placeOk(event.place)) problems.push(`event ${index + 1}: unknown place ${event.place}`);
    if (event.kind === "join") {
      if (!people.has(event.who)) problems.push(`event ${index + 1}: unknown person ${event.who}`);
      continue;
    }
    if (!people.has(event.from)) problems.push(`event ${index + 1}: unknown person ${event.from}`);
    if (event.place.startsWith("dm:") && event.place.slice(3) !== event.from) problems.push(`event ${index + 1}: a DM is written by its person`);
    for (const mention of event.mentions) if (mention !== "her" && !people.has(mention)) problems.push(`event ${index + 1}: unknown mention ${mention}`);
    if (event.replyTo && !event.replyTo.startsWith("her:") && !labels.has(event.replyTo)) problems.push(`event ${index + 1}: replyTo ${event.replyTo} is not an earlier label`);
    for (const attachment of event.attachments) if (!attachment.text && !attachment.png) problems.push(`event ${index + 1}: attachment ${attachment.name} has no text or png`);
  }
  const labelled = (label: string, what: string) => {
    if (!labels.has(label)) problems.push(`${what}: no event labelled ${label}`);
  };
  for (const fact of scenario.facts) if (fact.from) labelled(fact.from, `fact ${fact.id}`);
  const probeIds = new Set<string>();
  for (const probe of scenario.probes) {
    if (probeIds.has(probe.id)) problems.push(`duplicate probe ${probe.id}`);
    probeIds.add(probe.id);
    switch (probe.kind) {
      case "replied":
      case "followed_up":
        if (!placeOk(probe.place)) problems.push(`probe ${probe.id}: unknown place ${probe.place}`);
        break;
      case "not_replied":
        labelled(probe.event, `probe ${probe.id}`);
        break;
      case "recalls":
        labelled(probe.ask, `probe ${probe.id}`);
        break;
      case "recall_after_compaction":
        labelled(probe.fact, `probe ${probe.id}`);
        labelled(probe.ask, `probe ${probe.id}`);
        break;
      default:
        break;
    }
  }
  return problems;
}
