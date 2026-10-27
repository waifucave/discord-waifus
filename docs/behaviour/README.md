# How the waifus behave

This folder is the one place that says exactly how the waifus of Discord Waifus behave: what wakes
them, what they see, what they can do, what they remember, what the owner can see and change. It
describes the code, not the plans. Where the living-cast spec
(`docs/specs/2026-10-24-living-cast-design.md`) and the code differ, the code is what is written here
and the difference is noted ("Spec differs: …").

**Describes:** the code on `main` at `8895610` (package version 3.3.0; the commits after `a3304a9`
change only the spec). Behaviour merged after the 3.3.0 release commit (`2b10731`) is marked
**unreleased (on main)**: the richer morning summary (§23) and "Jev only sees who is around" (§24).

**Pending** (specified on `main`, being built on other branches; marked "pending (spec §25/§26)"
where they will change a rule, and to be finalised here when they merge):

- §25 rest before the prompt cache goes cold (a rest turn about 50 minutes after her last request on
  Anthropic-family routes when her context is large);
- §26 the rest notice at `compaction.triggerRatio` and auto-compaction only at a new
  `compaction.emergencyRatio`, with `life.restNoticeRatio` removed and new rest/compaction wording;
- Remote Access helper 0.1.17 (NAT public address pool).

**Rule:** any change to waifu behaviour (triggers, routing, prompts, tools, files and folders,
schedules, dreaming, privacy, remote behaviour) updates these files in the same commit. When these
files and the code disagree, the code is right and the files are fixed.

## How to read it

| File | What it covers |
|---|---|
| [life-and-turns.md](life-and-turns.md) | One life per waifu: queue, turns, locks, the system prompt, notifications, typing, caps, epochs, compaction, rest and self-reset |
| [triggers.md](triggers.md) | Every way she is woken, the intake holds, merging, and the wake router's guards in order |
| [detector.md](detector.md) | Jev, the addressee detector: what it sees, what it can answer, chime-ins, who is offered |
| [day-and-bed-time.md](day-and-bed-time.md) | Her daily `~/life/schedule.json`, busy holds, the morning wake, bed time states |
| [rooms.md](rooms.md) | Behaviour specific to server channels and threads |
| [dms.md](dms.md) | Behaviour specific to private chats |
| [her-computer.md](her-computer.md) | Her folders, every pre-set file, the eleven tools, the Bash sandbox |
| [memory-and-dreaming.md](memory-and-dreaming.md) | MEMORY.md and notes, transcripts, the nightly dream |
| [messages-and-refs.md](messages-and-refs.md) | ReadMessages grammar, refs, SendMessage, React |
| [privacy-and-forget.md](privacy-and-forget.md) | DM privacy (D14) everywhere, every forget path |
| [remote-access.md](remote-access.md) | How Remote Access behaves for the owner |
| [owner-controls.md](owner-controls.md) | Dashboard, CLI, HTTP, the assistant, slash commands, behaviour-shaping settings |

Each rule cites the code that implements it, as `file` + symbol (line numbers only where a symbol
is not enough). Paths are relative to the repository root. Numbers are defaults; most are settings
(see [owner-controls.md](owner-controls.md) and the generated `docs/assistant-kb/settings.md`).

## Glossary

| Term | Meaning |
|---|---|
| **Cast** | The waifus enabled in a channel (`channel.enabledWaifuIds`); a thread inherits its parent's cast unless the parent's `threads` is `"off"`. "Cast in a server" = cast in any channel or thread of it. |
| **House bot** | The one Discord bot that reads guild messages (Message Content intent) and hosts `/wake` and `/print`. Key `orchestrator` in `discord-bots.json`. It never posts as a waifu. |
| **Waifu bot** | A waifu's own bot. She posts, reacts, types and receives DMs only through it. A waifu without one (`botId` unset) is never woken and cannot post (`src/life/intake.ts` `castWaifus`, `src/life/wakeRouter.ts` guard 1). |
| **Life** | One continuous existence per waifu: her wake queue, her life log split into epochs, her state, her home folder. There is no director; she decides for herself. |
| **Wake** | One reason to look at her phone: a mention, a DM, a reminder, a detector pick, etc. Wakes go through the router into her persistent queue (`wakes.json`). |
| **Turn** | One run of her agent loop: a notifications message, then model call → tools → results rounds until she stops or a cap ends it. One turn at a time per waifu. |
| **Epoch** | A stretch of her life with a fixed system prompt (blocks A and B) and an append-only log (`log/<epoch>.jsonl`). A new epoch starts after compaction, a rest summary, a self-reset, a reset or a forget. |
| **Place / handle** | A channel, thread or DM she can use. Tools name it by handle: `bake-club/#general`, `bake-club/#general/thread-name`, `dm/kevin` (`src/life/places.ts`). Internally a place key: `g_<guild>_<channel>` / `dm_<user>_<waifu>`. |
| **Ref** | A short per-conversation message id like `#k3`, shared by every waifu, assigned in message order and never reused (`src/discord/refStore.ts`). |
| **Jev / detector** | The addressee detector: one native-choice decision call that guesses who a burst nobody named is for. Default target `openrouter:typesafe/jev-1.14` ("Jev", `src/shared/schemas/detector.ts` `DEFAULT_DETECTOR_TARGET`). |
| **Burst** | Messages in one place held together by the typing-aware timer and routed as one unit (`src/life/intakeHold.ts`). |
| **Bed time** | The owner's `availability.bedTime` window. Soft: she is up late, dozing or asleep inside it (`src/life/clock.ts` `bedPhaseAt`). |
| **Busy block** | A `busy` entry of her own `~/life/schedule.json` for today. |
| **D14** | The owner decision that DM content is hidden from every owner view unless revealed by a request on the host itself (`includePrivate=1`, `--private`, `private:true`). See [privacy-and-forget.md](privacy-and-forget.md). |
| **Owner** | For Discord slash commands: the House bot application's owner or its team members. For the dashboard/CLI/API: whoever runs the host. |
