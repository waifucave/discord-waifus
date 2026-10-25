# Decision API benchmark

Status (Living cast, 2026-10-24): the director and its One shot mode are gone. The decision APIs
now serve one production question, the **addressee detector** (spec
`docs/specs/2026-10-24-living-cast-design.md` §4.3): who is the newest human message for? The
`--suite=addressee` run below measures it. Everything after that section is the earlier
director-era record, kept for its measurements; its "One shot", "orchestrator" and directive
wording describes code that no longer exists.

## Addressee detector suite (Living cast)

`scripts/decision-benchmark/addressee.ts` holds 40 hand-labelled synthetic cases over a
three-member cast, in the spec's groups: addressed by name (including a nickname and a name
shouted on its own line), reply to a waifu (a human answering her last line without naming her),
human to human (including an instruction-injection line), open question (`anyone`), whole cast
(`all`: "what can you 3 do", "you three"), follow-up (an unnamed reply or question to the waifu
who just spoke with that person, including one marked as a Discord reply), link dump (links,
a bot command, emoji only, a bare laugh after a joke), multilingual (Portuguese, Japanese, Spanish, French, German) and
ambiguous (several answers accepted). Each request is built by the production
`detectorQuestion` and answered by the production `AddresseeDetector`, so the state, the
`waifu_<i>`/`human`/`anyone`/`all`/`none` choices, the transport, the answer validation and the Laya
worker are exactly what a life's intake uses. Expected answers, case ids and groups never enter a
request (`tests/decisionAddressee.test.ts`).

```sh
npm run benchmark:decisions -- --suite=addressee                       # preview, no inference
npm run benchmark:decisions -- --live --suite=addressee --targets=openrouter:cloudflare/clef,openai:gpt-6-luna
npm run benchmark:decisions -- --live --suite=addressee --runs=3 --all-openrouter
```

Reported per target: exact-choice accuracy (failed calls count as wrong), accuracy of answered
calls, multi-class Brier score and ECE over the single-answer cases, p50/p95 latency, cost from
the usage the API reports, accuracy per group, the error codes and the missed cases. `chat:`
targets are not detector targets and are skipped; `laya:` targets need host-local
`DC_WAIFUS_LAYA_PYTHON` (as in production) and get one unscored warm-up. No private replay
dataset exists for this suite yet. No live run has been recorded for it; synthetic results would
not be a guarantee of real-room routing either.

### One shot integration verification (2026-10-13)

The production adapter returned valid native choices for all 22 available targets in a synthetic
single-speaker compatibility smoke: 18 OpenRouter routes, direct OpenAI, and three local Laya
checkpoints. This verifies transport/response compatibility, not routing quality. The catalog
excludes the three known predicate-only Span entries; their zero context-length metadata must
not invalidate the other models' catalog entries. The live catalog is cached, and failures are
reported explicitly with a bounded retry interval.

The isolated dashboard verified mode selection, all model options, setup warnings and saved
model restoration after reload. Runtime tests cover One shot without a global LLM model,
character generation through the existing gateway, safe deterministic fallback and the manual
failure path. Remote tests use the existing authorized principal, revision and idempotency-key
requirements; they cover discovery/config writes and reject executable-path targets.
Strict choice tests cover contradictory-output prevention, code-guarded directives, bounded
speaker shortlists, cancellation, credentials, probability validation, OCR text and response size.
A healthy semantic diagnosis does not force a loop break merely because the lexical heuristic
raised a notice. Assistant discovery/configuration uses the same APIs.

At the source-verification checkpoint: 1,545 tests passed, 16 skipped; backend/frontend typechecks, all builds,
route inventory and package preflight passed. The optional worker and compiled adapter are packed;
private captures/reports are not. Publication and deployment are separate checks tracked by
the release workflow; these source checks alone do not establish them. No normal saved
orchestrator mode was changed. The original benchmark results
and limitations below remain relevant.

## Blind loop detection (2026-10-13)

The separate `--suite=loops` test checks what the user means by bots being stuck: literal
repetition, paraphrased reactions, replaying the same scene setup, and circular arguments.
It also tests healthy same-topic conversations with real progress, normal brief agreement,
human-requested repetition, a loop that has already resolved, multilingual dialogue, and
instruction injection. Labels are independent manual judgments, not historical Beta decisions.
No runtime loop notices, expected answers or case names enter the model requests.

There are 15 loop cases, 15 healthy controls and two insufficient-evidence cases, frozen before
inference. The primary output is a native five-way choice: healthy, repeated beat, stalled scene,
circular topic, or insufficient. The compatible wire names `next` and `pause` are auxiliary
progress/recurrence judgments, not production speaker/timer outputs; only `steering` is scored
for this suite. All three outputs are still strictly validated. Failed/unknown calls are not
counted as correct healthy negatives. Catching a loop and identifying its precise subtype are
reported separately. Yes/no-only models remain excluded.

```sh
npm run benchmark:decisions -- --live --suite=loops --targets=openrouter:typesafe/jev-1.13 --all-openrouter
npm run benchmark:decisions -- --live --suite=loops --runs=3 --targets=openai:gpt-6-luna,openrouter:typesafe/jev-1.13,openrouter:cloudflare/clef,openrouter:perplexity/pplx-decider-v1.1-27b
```

The current catalog run completed all 18 native-choice OpenRouter routes (including aliases),
plus direct OpenAI and the Gemini chat control; all 640 requests returned valid choices.
Three local Laya checkpoints completed another 96 requests. Initial single-pass measurements
(15 positive and 15 negative examples per target):

| Target | Loops caught / 15 | False alarms / 15 |
| --- | ---: | ---: |
| OpenAI Decisions, direct and OpenRouter | 15 | 0 |
| Jev 1.13 and latest alias | 15 | 0 |
| Clef | 15 | 1 |
| Clef Flash | 15 | 1 |
| Clef Omni | 15 | 2 |
| Perplexity Decider 1.1 and latest alias | 15 | 0 |
| Microsoft Decision | 15 | 0 |
| Drex 1.5 | 15 | 0 |
| Drex 2.0 | 15 | 1 |
| Tev experimental | 15 | 0 |
| Mercury Decide, paid and free | 15 | 1 |
| Liquid d1 | 15 | 1 |
| Kev 4B | 14 | 1 |
| Solar Decide | 15 | 0 |
| Solar Decide Flash | 13 | 0 |
| Gemini 3.1 Flash Lite, chat via OpenRouter | 15 | 1 |
| Laya English, local CPU | 5 | 7 |
| Laya multilingual, local CPU | 13 | 10 |
| Laya typed-decisions, local CPU | 2 | 2 |
| Existing production lexical detector | 2 | 1 |

Three additional passes over the same frozen cases confirmed OpenAI, Jev and Perplexity each
caught 45/45 loop presentations with 0/45 false alarms; Clef caught 45/45 with 3/45 false
alarms, consistently flagging the normal two-message agreement. Median latencies in that run
were approximately 142 ms, 297 ms, 356 ms and 420 ms respectively. These are repeated
presentations of 15 unique positive/15 unique negative cases, not 90 independent examples.
Jev had one failed request on a healthy control in the repeated run; no false alarm does not
mean every healthy case returned a valid healthy answer. Failures stay visible in the report.
The production lexical baseline misses semantic/scene loops and flags human-requested repetition
because it discards the human context. This benchmark does not alter that production function.
Solar Decide also got all 32 diagnoses right in its single pass, but its median latency was
approximately 13.7 seconds; it was not included in the repeated or private-room comparison.

The harder private Beta pilot gives a materially different result. Chat-only extraction strips
all old decisions, task instructions, wake plans and runtime notices, anonymizes speakers, and
preserves message ages. Five independently labelled snapshots show the same spent joke/theme;
they are highly correlated views of one room, not five independent conversations. There are
no healthy real-room controls, so this pilot cannot measure real-world false-positive rates.

| Target | Beta snapshots flagged, across three passes / 15 |
| --- | ---: |
| Clef | 15 |
| OpenAI Decisions direct | 3 |
| Jev 1.13 | 0 |
| Perplexity Decider 1.1 | 0 |
| Gemini 3.1 Flash Lite via OpenRouter | 3 |
| Production lexical detector, one pass / 5 | 0 |

Laya multilingual flagged 2/5 timed snapshots in a single pass, but its 10/15 synthetic healthy
false alarms make that unsuitable evidence for deployment. A preliminary extraction without
message ages produced different answers for OpenAI, Perplexity, Gemini and Laya; its report is
retained separately, not substituted for the timing-preserving result. None of these private
inputs was clipped. Subtle topic stagnation is a judgment call: a fresh joke variation can look
like healthy banter to a classifier even when the user considers the scene spent.

Conclusion: these models can detect clear semantic/scene loops, but synthetic success does not
establish reliable detection of subtler live-room stagnation. Clef is the most promising of the
tested real-room candidates, with a demonstrated brief-agreement false positive. More independently
labelled rooms and healthy real-chat controls are needed before relying on it automatically.
Detection alone also does not generate a useful new scene or guarantee that waifu replies follow
an intervention. No production orchestrator, saved settings or model gateway was switched.

Private reports remain ignored under `tests/eval/reports/`: `decisions-loops-round1.json`,
`decisions-loops-laya.json`, `decisions-loops-repeat.json`, `decisions-loops-beta.json`,
`decisions-loops-beta-timed.json`, and `decisions-loops-beta-timed-repeat.json`. Synthetic cases,
rubrics and dataset hashes are included in reports for reproducibility; private replay cases
must not be committed or published.

Verification: 1,523 tests passed, 16 skipped; backend/frontend typechecks and the separate strict
TypeScript check for the benchmark scripts passed. This is tooling verification, not evidence
that a production loop-breaking integration has been implemented.

## What is being compared

This is a bounded-judgment benchmark: 32 synthetic, hand-labelled Discord cases ask which
speakers should take the next beat, which pause bucket applies, and whether steering is needed.
The test includes direct questions, settled silence, multi-speaker moments, unavailable cast
members, instruction injection, multilingual input, and long transcripts. Cases with legitimate
alternative speakers list acceptable answers rather than forcing an arbitrary one.

Every target receives the same state, instructions and options. Expected labels are never sent.
Three runs per case measure repeatability; they are repetitions of 32 cases, not 96 independent
examples. Questions and labels are frozen before running; do not adjust them to improve a
particular model's score. Add separately labelled cases for subsequent validation.

The chat control uses the same judgments with a JSON-schema response. It is a model comparison,
not a replay of the full production runtime prompt, tools, memory and guardrails. Decision models
cannot generate arbitrary directive goals, reasoning, or wake-plan prose. A high score here alone
does not establish that a model can replace the whole orchestrator. The speaker-subset choice
also grows exponentially with cast size; production integration needs a different strategy for
large casts, with its own evaluation.

## Verified APIs and candidates (2026-10-12)

- [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions):
  `POST https://api.openai.com/v1/decisions`, model `gpt-6-luna`. Uses `input` and a question
  array; choice distributions are arrays of typed values/probabilities. Base input price is
  $0.10 per million tokens; output and cache token charges are zero. Regional/long-context
  premiums can change that base estimate.
- [OpenRouter decision models](https://openrouter.ai/models?categories=decisions):
  `POST https://openrouter.ai/api/alpha/decisions`. Uses `state` and a named question map.
  The runner discovers candidates through `/api/v1/models?output_modalities=decisions` and
  retains that catalog's price/context snapshot. The official
  [SDK reference](https://openrouter.ai/docs/client-sdks/typescript/sdks/decisions/README.md)
  documents this contract.
- [TypeSafe Jev](https://docs.typesafe.ai/api): direct endpoint is `/v1/systemone`.
  The initial runner benchmarks the pinned `typesafe/jev-1.13` through OpenRouter; that is
  not a direct TypeSafe latency measurement.
- [Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef/):
  Clef, Clef Flash and Clef Omni appear in OpenRouter's decision catalog. Initial comparisons
  use OpenRouter, so these measurements include that routing hop.
- [Local Laya](https://huggingface.co/convaiinnovations/laya): English, multilingual and
  typed-decisions checkpoints. The runner pins the downloaded Hub revision and records runtime,
  device and loading time. English and specialist checkpoints have short contexts; multilingual
  is explicitly configured for 8,192 tokens. Context clipping is detected and reported rather
  than silently compared as complete input.

The live OpenRouter catalog also contains Liquid d1, Inception Mercury Decide, Upstage Solar
Decide/Flash, Perplexity Decider, Microsoft Decision, Nace Drex, Together Tev, Respan Span and
Kev. Discovery is not verification of access, accuracy or availability. The default run includes
every text-capable decision model from the live OpenRouter catalog, alongside the direct/local
controls. Explicit `--targets=...` restricts a run; adding `--all-openrouter` includes the entire
catalog again. New compatible models are picked up automatically; failures remain visible.
Yes/no-only models are excluded: Respan Span entries reject native choice questions and are
not eligible orchestrator candidates. Do not emulate choices by ranking independent yes/no
answers. Known entries are filtered even when explicitly requested, and a new model that
declares choice unsupported is excluded after its compatibility probe.

## Running the comparison

From the repository root, preview without making inference calls:

```sh
npm run benchmark:decisions -- --limit=2
```

Use existing Waifus provider settings. To save an OpenRouter key interactively, start the normal
local host, then use the hidden prompt. The runner writes through that host's API; it does not
overwrite credential JSON while the host is running.

```sh
waifus start --no-open
npm run benchmark:decisions -- --save-openrouter-key
```

This targets the local `DC_WAIFUS_HOME` installation, not the paired remote host. For a custom
root, pass `--data-root=/absolute/path` to the benchmark and use that root for the local host too.
Never put keys in arguments, shell history, Git, or reports. Missing credentials skip a target.

Smoke-test a candidate before a larger paid run:

```sh
npm run benchmark:decisions -- --live --limit=2 --targets=openrouter:typesafe/jev-1.13
npm run benchmark:decisions -- --live --runs=3 --targets=openrouter:typesafe/jev-1.13,openrouter:cloudflare/clef-flash,openrouter:openai/gpt-6-luna-decisions
```

To compare every current OpenRouter decision model without repeating the direct/local controls:

```sh
npm run benchmark:decisions -- --live --runs=3 --targets=openrouter:typesafe/jev-1.13 --all-openrouter
```

Direct OpenAI and the Grok chat control use their existing saved provider keys:

```sh
npm run benchmark:decisions -- --live --runs=3 --targets=openai:gpt-6-luna,chat:xai:grok-4.3
```

Local Laya uses an isolated Python environment. This downloads public model weights on first
use and requires enough disk/RAM. The application does not gain a Python dependency.

```sh
uv venv --python 3.12 /tmp/waifus-decisions-benchmark-env
uv pip install --python /tmp/waifus-decisions-benchmark-env/bin/python 'laya==0.3.20'
npm run benchmark:decisions -- --live --runs=3 --targets=laya:english,laya:multilingual,laya:typed-decisions --python=/tmp/waifus-decisions-benchmark-env/bin/python
```

The default local device is CPU with four Torch threads. `--device=mps` requests Apple GPU
inference; report the actual device and compare it as a separate run. Loading/downloading and
one warm-up forward are separate from measured warm inference requests. Local request latency
includes IPC and context-clipping instrumentation; cloud latency includes network round trips.

## Metrics and interpretation

Reports are private files in ignored `tests/eval/reports/` (override with `--report=PATH`). They
include synthetic cases, predictions, distributions, usage, timings and sanitized error codes.
They contain no real conversations, credentials, data-root paths or raw provider errors.

- Per-question accuracy and whole-case accuracy count request failures as incorrect.
- p50/p95 latency describe successful requests; failure counts are shown separately.
- Contradictions count a speaker choice inconsistent with the pause. These must be resolved
  by production policy rather than treated as a structurally valid response being correct.
- Brier score and ten-bin ECE use returned probabilities, excluding ambiguous labels from
  calibration. Chat controls have no probability calibration score; no probabilities are invented.
- Coverage/accuracy at 0.8 use a predeclared maximum-option-probability threshold. This is
  not the vendors' differently defined confidence field and is not a production-tuned threshold.
- Provider-reported costs are kept apart from price-times-token estimates. Missing cost is
  unknown, not zero. Local inference has no API bill but still uses machine resources.
- Scores broken out by scenario group and truncation flags reveal weaknesses hidden by averages.

Before implementation, evaluate a larger held-out corpus, realistic cast sizes, actual runtime
prompts and multi-turn traces. Preserve hard availability/reply-required/revocation rules in code;
never let a classifier probability override authorization or runtime invariants.

## Results

Initial measurements completed on 2026-10-12 on Delta (Apple M4 Pro, 24 GiB RAM).
Each main target made 96 scored requests: the same 32 cases, repeated three times. A separate
32-request Apple GPU run checks Laya multilingual performance. No production default changed.

| Target | Individual judgments correct | All three correct | Median request | p95 request | Contradictions |
| --- | ---: | ---: | ---: | ---: | ---: |
| OpenAI GPT-6 Luna Decisions, direct | 94.8% | 84.4% | 243 ms | 333 ms | 6/96 |
| Grok 4.3 chat control, direct | 97.6% | 93.8% | 5,283 ms | 9,244 ms | 0/96 |
| Laya English, CPU | 38.5% | 0.0% | 282 ms | 674 ms | 87/96 |
| Laya multilingual, CPU | 53.1% | 12.5% | 110 ms | 1,711 ms | 57/96 |
| Laya typed-decisions, CPU | 36.5% | 3.1% | 284 ms | 1,551 ms | 45/96 |
| Laya multilingual, Apple GPU (one run) | 53.1% | 12.5% | 59 ms | 593 ms | 19/32 |

All requests above returned structurally valid answers; these accuracy differences are judgment
errors, not transport failures. English and specialist Laya clipped both long cases on every
run (6/96 requests per target); multilingual at 8,192 tokens did not clip them. All three local
checkpoints used Hub revision `7b928d828b7b0e022f929d9bd2e44165aa270148`, Laya 0.3.20,
Torch 2.14.1 and Transformers 5.19.0. A separate documented billing-choice sanity check correctly
selected billing, so the local adapter also worked on a basic task outside these room judgments.
The package emitted a temperature warning for an 11-or-more-option calibration entry; this test
uses at most eight options and does not measure the vendor's confidence field.

OpenAI's 96 requests consumed 74,664 reported input tokens: an estimated **$0.00747** at the
published Decisions base rate. Grok's measured input/output usage gives an **uncached estimate
of $0.10576**, using [$1.25/M input and $2.50/M output](https://docs.x.ai/developers/models/grok-4.3).
These are calculated estimates, not invoices; the first reports were created before automatic
cost estimation was added to the runner. Cached discounts can lower Grok's actual bill, and
account-specific premiums can affect estimates. The current runner records cached usage and
available catalog prices explicitly. Local Laya incurs no provider API bill; power and machine
time are not priced here.

OpenAI was about 22 times faster at the median on this test, with lower whole-case correctness.
Its failing cases included settled thanks, an hours-dead room, a spent joke, a loop intervention,
and a quoted injection. Six answers disagreed internally about speakers versus pausing. Grok's
whole-case accuracy was higher, although it also made mistakes. The probability-at-0.8 slice for
OpenAI covered 91.5% of unambiguous judgments at 97.7% accuracy; this small synthetic result is
not sufficient to select a production threshold.

Recommendation from this first pass: continue evaluating OpenAI Decisions as an optional bounded
selector or alongside the existing model. Do not switch the default or treat it as a complete
replacement. Zero-shot Laya is not adequate for this room-policy contract in its tested form;
domain-specific training or a simpler question decomposition needs independent held-out testing.

The subsequent OpenRouter round below uses Delta's saved key. Initial live-catalog discovery
alone was not an accuracy/latency result.

Local evidence (ignored, private; do not commit credential data or real conversations):

- `tests/eval/reports/decisions-cloud-initial.json`
- `tests/eval/reports/decisions-laya-initial.json`
- `tests/eval/reports/decisions-laya-mps.json`

Verification after the catalog filtering and replay work: the full suite passed 1,518 tests
with 16 skipped; the focused benchmark/capture/replay suites passed 13 tests. App type checks
and separate strict checks of the benchmark/capture scripts
passed. These checks validate measurement code, not the models' production fitness.

## OpenRouter native-choice round

The saved key authenticated successfully. On 2026-10-12, all 17 eligible catalog entries
completed the same 32 synthetic cases once (544 successful requests). The three Respan Span
entries are excluded because they support only yes/no. Their exploratory smoke results are
not eligible rankings, and the attempted predicate-ranking adapter was removed.

| OpenRouter model | All three correct | Median | p95 | Reported cost for 32 |
| --- | ---: | ---: | ---: | ---: |
| TypeSafe Jev 1.13 | 93.8% | 292 ms | 345 ms | $0.00129 |
| Cloudflare Clef | 93.8% | 419 ms | 7,346 ms | $0.00648 |
| TypeSafe Jev latest alias | 93.8% | 319 ms | 422 ms | $0.00129 |
| Inception Mercury Decide | 90.6% | 446 ms | 631 ms | $0.00024 |
| Inception Mercury Decide free | 90.6% | 414 ms | 975 ms | $0 |
| Liquid d1 | 87.5% | 299 ms | 425 ms | $0.00115 |
| Perplexity Decider 27B | 87.5% | 334 ms | 525 ms | $0.00071 |
| OpenAI GPT-6 Luna Decisions | 84.4% | 316 ms | 635 ms | $0.00249 |
| Cloudflare Clef Flash | 78.1% | 435 ms | 1,831 ms | $0.00103 |
| Cloudflare Clef Omni | 78.1% | 212 ms | 273 ms | $0.00404 |
| Nace Drex v2.0 | 78.1% | 320 ms | 610 ms | $0.00106 |
| Microsoft Decision 1 | 75.0% | 357 ms | 408 ms | $0.00075 |
| Kev 4B | 65.6% | 545 ms | 664 ms | $0.00074 |
| Together Tev1 experimental | 59.4% | 315 ms | 379 ms | $0.00158 |
| Nace Drex v1.5 | 56.2% | 311 ms | 1,022 ms | $0.00071 |
| Upstage Solar Decide | 56.2% | 14,217 ms | 20,084 ms | $0.00300 |
| Upstage Solar Decide Flash | 6.2% | 693 ms | 1,018 ms | $0.00300 |

Total OpenRouter-reported cost for this round: **$0.02953**, excluding smoke tests and later
replays. Costs come from each response's usage field; they are not extrapolated from catalog
prices. Free variants and moving aliases are separate routes, not independent architectures.
These models had one scored pass, unlike the initial three-pass direct OpenAI/Grok controls;
do not infer statistical superiority from a one-case difference on this small set.

An additional Gemini 3.1 Flash Lite chat control via OpenRouter completed 32/32 requests,
scoring 93.8% whole-case correctness at an 822 ms median (1,252 ms p95). Its estimated cost
was $0.00703. Delta's direct Google credential rejected authentication with HTTP 401, so that
route has no quality result. The OpenRouter Gemini measurement includes its routing hop and
must not be described as Beta's direct-provider latency.

## Real host replay corpus

On 2026-10-12, a read-only SSH check of Beta found 200 saved orchestrator decisions. Its normal
orchestrator uses `google-ai-studio:gemini-3.1-flash-lite`; the earlier synthetic Grok control was
Delta's configuration, not Beta's. The host's event snapshot supplied five paired orchestrator
requests/responses, each with five available characters. These are saved privately in the
ignored `tests/eval/fixtures/live/beta-orchestrator.json`. The sanitized inputs were subsequently
replayed to the benchmark providers. The snapshot bounds its retained history by dropping older entries, so this is a
five-request pilot, not a reconstruction of all 200 decisions or all Discord chat history.

Capture another host without restarting it or modifying its data:

```sh
npx tsx scripts/decision-benchmark/capture.ts --ssh-host=user@host --ssh-key=/absolute/path/to/ssh-key
```

The capture command only reads the host's loopback event snapshot and orchestration metadata.
It never exports credential files, sends Discord messages, or changes host configuration.
Embedded media is excluded, known secrets are redacted, and the output is written with private
file permissions. Remaining dialogue is still private: this is not a fully anonymized public
dataset. Never commit it or print it in release notes/logs. Capture failures suppress raw
provider/snapshot exception text.

The runner now ingests a capture with independently supplied policy labels:

```sh
npm run benchmark:decisions -- --live --dataset=tests/eval/fixtures/live/beta-orchestrator.json --labels=tests/eval/fixtures/live/beta-labels.json --targets=openrouter:typesafe/jev-1.13 --all-openrouter
```

Historical response bodies and historical model tool-call turns are excluded from inference
inputs. The actual dialogue, instructions, cast cards and wake annotations are retained.
Labels were independently authored after inspecting those inputs, without using Beta's
responses as correct answers. They are assistant-reviewed policy constraints, not validated
human consensus labels. Each case permits silence with an appropriate re-check or a single
awake speaker with a genuine-pivot intent; a timer wake must extend the prior short pause if
not acting. Merely repeating the same beat, or contradictory speaker/pause/steering selections,
fails the joint constraint. Written directive goals are not evaluated.

This is a **five-case correlated spent-beat pilot**, not a representative real-chat accuracy
benchmark. A constant `nobody/600-second pause/none` baseline already passes all five; therefore
the pilot's numbers cannot choose the best conversational orchestrator. It is useful for
revealing invalid combinations and handling larger cast choices. Independent-question APIs
need conditional sequencing or code-enforced consistency in a production adapter; the current
benchmark intentionally reports raw combinations rather than repairing them.

| Target | Joint-policy passes | Contradictions | Successful replies |
| --- | ---: | ---: | ---: |
| Nace Drex v1.5 | 4/5 | 1/5 | 5/5 |
| Perplexity Decider | 3/5 | 0/5 | 5/5 |
| Cloudflare Clef | 2/5 | 0/5 | 5/5 |
| Direct OpenAI Decisions | 1/5 | 4/5 | 5/5 |
| OpenAI Decisions via OpenRouter | 1/5 | 4/5 | 5/5 |
| Gemini 3.1 Flash Lite chat via OpenRouter | 1/5 | 0/5 | 5/5 |
| Jev 1.13 / latest alias | 0/5 each | 5/5 each | 5/5 each |
| Other successful native-choice entries | 0/5 | varies | 5/5 |

Together Tev1 returned HTTP 400 on all five larger-choice requests; both Solar variants returned
HTTP 422. These are compatibility/validation failures, not evidence that their judgments were
wrong. A targeted diagnostic confirmed Tev1 permits 2–20 options per question, whereas the
five-character subset choice contains 32. Solar's validation also rejects that larger choice
set. Their smaller synthetic choices succeeded. A production adapter must avoid exponential
speaker-subset choices and obey each backend's option limits. No yes/no workaround is used. The direct
Google route had HTTP 401 and no usable inference results; it was replaced for comparison by
the explicitly labelled OpenRouter Gemini route.

Evidence remains private and ignored:

- `tests/eval/reports/decisions-openrouter-round1.json`
- `tests/eval/reports/decisions-gemini-round1.json`
- `tests/eval/reports/decisions-beta-pilot.json`
- `tests/eval/reports/decisions-beta-gemini.json`

Jev and Clef are strong synthetic candidates, but none is established as a full orchestrator
replacement. Integration must validate available speakers and dependent fields, handle limited
choice sets and failures, and preserve generated-goal/wake-plan behavior explicitly. A larger,
varied, independently labelled real corpus remains necessary before choosing a default.
