# Jev, the addressee detector

When a room burst addressed nobody directly, one native-choice decision call guesses who it is for
and whether someone would chime in. It never replies itself and never sees DMs.

Code: `src/life/intake.ts` `Intake.runDetector`; question, answer and draw in
`src/life/detector/decider.ts`; targets in `src/life/detector/catalog.ts`; history schema in
`src/shared/schemas/detector.ts`.

## When it runs

- A **person's burst** in a room fires and none of its messages was direct for anyone (no mention,
  reply-to-a-waifu, role, `@everyone`, name).
- A **waifu's own burst** (her lines in one place, 1.5 s quiet) fires and none of her lines was
  direct: the detector decides who speaks next. She is never a candidate for her own burst.
- Not when the app or the server is paused, when the forget records are unreadable (fails closed),
  or when every candidate was already woken by a watch for this burst (one wake per message).
- DMs never go to the detector.

## Model and target

- One global target `detector.target`, default `openrouter:typesafe/jev-1.14` ("Jev"), plus an
  optional per-server override (`server.detector.target`; `""` = no detector in that server).
  Allowed forms: `openai:gpt-6-luna`, `openrouter:<model>[:free]` (yes/no-only models refused),
  `laya:english|multilingual|typed-decisions` (local).
- 30 s timeout per call. Each call writes one usage line with purpose `detector` (not counted in any
  waifu's daily budget). A missing key, an unlisted OpenRouter model or any failure throws and the
  fallback is used; it never retries in a loop (`AddresseeDetector.decide`).
- Its calls are captured with content in Activity (unlike life calls).

## Who it is offered (§24)

Only cast members who are **around in that place** (`src/life/busy.ts` `aroundIn`, plus
`Intake.notAroundWhy`):

| Her state | Around in this place? | `leftOut.why` |
|---|---|---|
| Awake (no busy block, outside bed time) | Yes | — |
| Busy block | Only if `busyOpen` has this place for this block (she sent here after a wake that got through) | `busy` |
| Bed time, up late or dozing | Only if she sent here in the last `life.busyEngagedMinutes` (10 min). Dozing therefore always leaves her out. | `bed time` |
| Asleep | Never | `asleep` |
| Over her daily budget | Never | `budget` |

Also left out silently: waifus with no model, the author of a waifu's burst. Everyone offered is
shown as `availability: "awake"`. When nobody is around: **no call** (and no fallback), nothing wakes
or is deferred, history choice `nobody_around`.

Direct address still reaches someone who is not around through the router as usual (mention,
reply, name, DM) — never through Jev.

## What it sees

A JSON state (`detectorQuestion`; golden `tests/golden/__snapshots__/detector-state.txt`):

- `date`, `now` (local);
- `cast`: per candidate `option` (`waifu_<i>`), `id`, `names` (her name, display name, server
  nickname; ≤ 8), `persona` cut at 300 characters, `availability`;
- `chronologicalChat`: the room's last **12** messages (`actor` user/waifu, `name`, `time`,
  `minutesAgo` whole minutes before now, `date` when not today, `messageId`, `replyTo` = the author
  name a Discord reply answers, `imageText` from the OCR cache (≤ 4 images, 400 chars each), `text`
  ≤ 1,500 chars), newest kept, at most **8,000** characters in all.
- A forgotten person's old messages appear as name `someone`, text `(removed)`.
- Candidates are capped at 6 for Laya targets, 16 otherwise (`DETECTOR_MAX_CAST`).

## Choices

**`addressee`** (always asked) — instructions in `ADDRESSEE_INSTRUCTIONS`:

| Choice | Meaning | What happens |
|---|---|---|
| `waifu_<i>` | For that cast member | She gets a `detector` wake ("maybe for you") |
| `human` | For another person who is still around | Nothing, unless a chime-in is picked |
| `anyone` | Open to the room; one answer is enough. Also a message aimed at a person whose own last message is **30+ minutes** old (they are probably away) | One waifu drawn among those around (not watched), weight `3 × (1 + ln(1 + minutes since she last spoke here / 10))`, never-spoke = 24 h (`drawAnyone`) |
| `all` | The whole cast, or several together | Every waifu around here (not watched, not the author) gets a `detector` wake with `forAll` ("for all of you"), staggered 0–20 s when several |
| `none` | Not conversational (bot command, link dump, bare emoji) | Nothing |

The 30-minute "stale address" rule and the follow-up rule ("when a cast member has just been
talking with that person, an unnamed follow-up is for her") are instructions to the model, judged
from `minutesAgo`; there is no code-side timer. For a waifu's burst: her remark to a person → that
person (`human`), a question to another cast member → that one, a goodbye → `none`.

**`chime_in`** (asked only when some candidate is around and the room's chime-in interval allows
it) — `CHIME_IN_INSTRUCTIONS`: `waifu_<i>` for a candidate who would naturally join in, or
`nobody` (favoured; private matters, plans and logistics are `nobody`).

- Used only when the addressee answer is `human`. The picked waifu gets a soft `detector` wake with
  `chimeIn` ("for someone else, you could chime in"); she may stay quiet.
- At most **one chime-in per room (channel or thread) every 10 minutes**, counted from when one was
  queued (`CHIME_IN_INTERVAL_MS`); after a restart the history file is consulted; re-checked after
  the call. A chime-in that the router does not queue (held, deferred) does not use up the interval.
- A malformed `chime_in` answer is ignored; the addressee answer stands.

## Fallback (no target, or the call failed)

- A person's burst counts as `anyone` (`fallback:anyone`) when its newest message ends with `?`,
  or it is the first person's message in that room for 10 minutes (or nothing earlier is known);
  otherwise nothing (`fallback:none`) (`fallbackIsAnyone`).
- A waifu's burst wakes nobody (`fallback:none`).
- The `anyone` draw is the same weighted draw over the waifus around.

## After the answer

Every wake it produces goes through the wake router like any other (busy holds, bed time, budget,
per-user limit, room loop guard for waifu-authored bursts). A detector wake carries every message
of the burst as lines, all labelled as the pick.

## History

`user/servers/<guildId>/detector-history.json`, the last **300** results per guild:
`{at, channelId, burstMessageIds, choice, probabilities, woke?, leftOut?: [{waifuId, why}],
authorWaifuId?, chimeIn?: {choice, probabilities, woke?}, target?, error?}`. `choice` is the model's
answer, `fallback:anyone`/`fallback:none`, or `nobody_around`. Served by
`GET /api/detector/history?guildId`; Rooms shows only the time of the last decision.

## Spec differs

- Before §24 (and in §4.3) the `anyone` draw weighted busy ×1 and asleep ×0 and `all` woke every cast
  waifu in the channel; as built only waifus around are candidates, all weighted ×3 ×
  recency, and `all` wakes only them.
