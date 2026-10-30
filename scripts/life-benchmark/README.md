# Life benchmark

A developer tool (spec §33, not shipped in the npm package) that runs one waifu's real life — the
app's own `CastRuntime`, life loop, harness, scheduler, tools, compaction, rests and nightly dream,
with her real model through winter — inside a fake Discord server on a simulated clock, from a fixed
scenario, and scores models and prompt variants on the same scenarios.

## Running it

```sh
npm run bench:life -- list                                   # scenarios, variants, curated routes with key presence
npm run bench:life -- --dry-run                              # every scenario on the scripted fake model; no network, no keys
npm run bench:life                                           # prints the plan and cost estimate, runs nothing
npm run bench:life -- --yes --max-usd=10                     # live: one route per curated family that has a key
npm run bench:life -- --yes --models=anthropic/claude-haiku-5-5,openai/gpt-6-luna#low \
  --scenarios=small-server,dm-private --variants=baseline,brief --repeat=2 --concurrency=3
```

Flags: `--scenarios=default|all|id,…` (default: the three real ones; `tiny` is the smoke one),
`--models=families|all|route[#effort],…` (families: one route per curated family, the vendor's own
when its key is there, else OpenRouter's; `all`: every keyed curated route; Muse Spark contributor
routes train on prompts and run only when named), `--variants=baseline,brief,./my-variant.json`,
`--repeat=N`, `--concurrency=N` (runs in parallel), `--max-usd=X` (no new turn once spent, across
all runs), `--web` (her Web tool and page wakeups; off by default: Exa and fetches cost),
`--dry-run`, `--yes`, `--out=DIR` (default `bench-results/life-<time>/`, gitignored),
`--data-root=PATH` (where provider keys are read; default `DC_WAIFUS_HOME` or `~/.dc-waifus`),
`--gate-first-try=0.8 --gate-probes=0.6` (the judge gate).

Before any model call it prints the plan and a rough cost estimate (assumptions in `cost.ts`) and
stops unless `--yes` is given. Keys are read from the data root's `user/providers.json` only, passed
inline per call, and never printed, logged or written into results. Each run gets a fresh temp data
root holding only the waifu under test; nothing touches the real data root or Discord.

## What a run does

- The scenario's people post their fixed lines; nobody reacts to her. Guild messages go through the
  runtime's message handler and the conversation cache (so transcripts and dreams work), DMs through
  the DM handler. A room burst is flushed after its last message, as the intake's hold would.
- The clock jumps to the next event, the next scheduler tick (`tickMinutes`, default 5) or the next
  time one of her wakeups fires; while she thinks no simulated time passes, except her own waits
  (`wait` in a send), which move the clock and deliver what people write meanwhile.
- The addressee detector is scripted (each message may say what it answers; otherwise a mention or
  reply to someone else is `human`, an open question `anyone`, the rest `none`): the detector has
  its own benchmark (`npm run benchmark:decisions`); here only her model is under test.
- Probes check outcomes only (what reached the fake server, her home files at a time, the wakes that
  fired, her wakeups' next times), never tool names or argument shapes.

## Results

```
<out>/summary.json          every run's metrics, probes, gate and grades
<out>/report.md             models × variants, runs, probes, summaries re-scored, grader flags
<out>/runs/<run>/transcript.jsonl   people, her sends and reactions, wakes, model calls, tool calls and results, compactions, maintenance
<out>/runs/<run>/summaries.json     every summary with exactly what it summarised (rest, self, compaction, dream, morning) and must-keep fact coverage
<out>/runs/<run>/home.json, block-a.txt   her home at the end; her block A as her last epoch had it
<out>/judge/packets/<id>.json       judge packets (no model name); judge/index.json maps them back
<out>/grades/                       where graders write their JSON
```

A failed model call's `call` event carries `error` (the app's kind), `errorStatus` (HTTP), `errorCode`
(the provider's own code) and `errorMessage` (at most 200 characters, key-like runs masked).

Automatic metrics: tool calls, failed calls (results marked `is_error`), first-try success,
retries, loops (identical failing calls); messages, median and longest line, messages per turn,
longest burst (`longestBurst`: the most messages in a row in one place with nobody else writing there),
unanswered sends (`maxUnansweredSends`, spec §34: the most separate sends in a row in one place with
nobody else writing there, which is nagging; a `sent` event is a new send when its turn id differs from
her previous one there, or, without turn ids, when 5 minutes or more passed since it); probes passed; dollars, tokens in/out, cache-read share, seconds per turn; must-keep
facts kept by her summaries and her notes after the dream.

## Grading

Runs past the gate (finished, first-try tool success and probe pass rate over the thresholds) get
judge packets: a `chat` packet (persona, rubric, the anonymised conversation; for a variant also the
baseline's transcript of the same scenario, model and repeat as `reference`) and a `summary` packet
per model-made summary (her system blocks — rules, schedule, notes index and earlier summary — the input, and the summary; a fact carried over from that context counts as supported). `npm run bench:life -- repack --out=<out>` rebuilds a folder's summary packets in place under the same ids after a packet change; move the stale grades out of `grades/` first. Give each packet to an Opus subagent in your Claude Code
session, for example:

> Read `<out>/judge/packets/<id>.json` and follow its `instructions`. Write only the JSON its
> `answerFormat` shows to `<out>/grades/<id>.json`.

Grader JSON (`GradeSchema` in `grading.ts`; a file may hold one object or a list):

```json
{ "packet": "1be633461d", "grader": "opus", "scores": { "in_character": 4, "natural_short": 5, "relevant": 4, "kind_to_room": 5 },
  "notes": "…", "invented": [], "flags": [] }
```

Chat criteria: `in_character`, `natural_short`, `relevant`, `kind_to_room` (+ `same_personality`
for variants). Summary criteria: `faithful`, `complete`, `nothing_invented`, `keeps_voice`,
`open_threads`. All 1–5. Then fold them in:

```sh
npm run bench:life -- merge-grades --out=<out>
```

## Summaries per model

```sh
npm run bench:life -- resummarise --out=<out> --models=deepseek/deepseek-flash,openai/gpt-6-luna [--yes]
```

replays every saved compaction and rest-summary input (system blocks, messages and tools exactly as
sent) through each model, scores must-keep facts, writes `summary` judge packets and adds a section to
the report. Same estimate-then-`--yes` rule.

## Writing scenarios and variants

Scenarios are typed TypeScript modules (`scenario.ts`, `defineScenario` validates every reference);
see `scenarios/*.ts`. Times are `d<day> HH:MM[:SS]` in the scenario's zone; places `#channel` or
`dm:<person>`; `facts` are what a summary must keep (`match` alternatives, every word of one must
appear); `config` overrides the app config for the run (a small `life.maxContextTokens` makes her
rest within the scenario). `dryRun` rules only drive the scripted fake model.

A variant is JSON (or a module exporting it) with `replace`, `remove` and `add` edits
(`variants.ts`) of:

```json
{ "id": "mine", "description": "…",
  "edits": [{ "add": "…" }],
  "tools": { "SendMessage": [{ "add": "…" }], "Edit": [{ "remove": "…" }] },
  "toolSchemas": { "Bash": { "command": [{ "replace": "…", "with": "…" }] } },
  "summaries": { "rest": [{ "add": "…" }], "compaction": [], "dream": [], "dreamSystem": [] } }
```

- `edits`: block A's paragraphs (blank-line separated; section tags kept; `add` without `after`
  goes at the end of `<life>`).
- `tools`: a tool's description, by name (`ReadMessages`, `SendMessage`, `Wakeup`, `Read`, `Edit`,
  `Bash`, `Web`); `toolSchemas`: the description of one of its input fields. One paragraph is one
  line there; `add` without `after` goes at the end. A tool's edits apply wherever it is offered (her
  life and her maintenance sessions).
- `summaries`: `rest` the rest notice (also the quiet-time one; it must still start like a rest
  notice), `compaction` the compaction instruction (before any forget lines), `dream` the dream's
  instruction, `dreamSystem` the memory keeper's system block. One line is one paragraph.

Every edit must match exactly one paragraph: each variant is tried on every selected scenario's
shipped texts before the plan is printed, so a broken one stops the benchmark before any run. Prefer
`add` edits: they survive rewrites of the shipped prompt. Built-ins: `baseline`, `brief`, `calm`
(one gentle follow-up, speak when there's something to add) and `tool-examples` (a second,
differently shaped example call for ReadMessages, SendMessage, Read and Wakeup); `list` prints them.

`own-voice` (summaries and dream notes as her own first-person memory) is now the baseline: it
improved how her summaries keep her voice with no loss of facts, so its wording shipped on
2026-10-29 (block A, the rest notices, the compaction instruction and the dream's instruction; spec
§19.8). Results from runs before that compare `own-voice` against the older baseline. `calm-voice`
(calm and own-voice) went with it: it is now `calm`.

## Caveats

- Simulated hours pass in seconds, so a provider's prompt cache stays warm across what would be
  cold gaps in production: cache-read shares and dollars are lower than a real day's.
- A turn's length cap (`life.maxTurnMs`) is measured on the simulated clock, which only her own waits
  move; each model call still has its real timeout.
- The detector is scripted; a real room's routing differs.
