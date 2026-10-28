# Rooms and threads

Behaviour specific to server channels and threads. General triggers are in
[triggers.md](triggers.md); the detector in [detector.md](detector.md).

## Which rooms are hers

- A channel is live when it has at least one enabled waifu in its cast (`channel.enabledWaifuIds`);
  there are no server/channel `enabled` flags. The owner sets the cast per channel in Rooms.
- **Threads and forum posts** are their own conversations (`g_<guild>_<threadId>`) that inherit the
  parent channel's cast, unless the parent's `threads` is `"off"` ("Threads stay silent"). They are
  tracked in `user/servers/<guildId>/threads.json` (never as channel entries) and dropped after 30
  days idle (`src/orchestration/stores/threads.ts`, `THREAD_RETENTION_MS`).
- Her rooms are the cast channels and live threads where she is cast; they are listed in
  `~/life/places.md` and block B's `<places>`. Outside them she cannot read, send or be woken.

## Handles

`<server-slug>/#<channel-slug>` and `<server-slug>/#<channel-slug>/<thread-slug>`; slugs are lower
case, ASCII-folded, other characters `-`, at most 40 characters (`src/life/places.ts` `slugify`).
`handles.json` per waifu: a handle is never reassigned; a rename adds the new slug as the primary
handle and keeps the old one as an alias; collisions get `-2`, `-3` in creation order. Every tool
also accepts a raw place key. Unknown: `error: unknown place; see ~/life/places.md`.

`~/life/places.md` lists each room as `- <handle> (<Server> › #<channel>) · [paused] · people today:
<names, ≤ 12> | nobody seen today · last activity <day time>` (`src/life/home/index.ts`
`placesFileText`).

## Paused servers

`server.paused` (the Rooms screen's server switch, "Off mutes every channel: messages are still
observed, but nothing replies"):

- messages there never reach intake: no wakes, no watch matches, no detector (`CastRuntime.handleDiscordMessage`);
- room wakes for that server are dropped by guard 1; catch-up skips the server;
- `SendMessage` and `React` there answer `error: you can't post there` (`place.paused`);
- active participants are still recorded; she can still read the room.

Pausing the whole app (`runtime.paused`, Settings → App → Controls) stops everything; resume catches
up from the pause start ([triggers.md](triggers.md)).

## What wakes her in a room

- From people: mention or reply to her, a role her bot holds, `@everyone`/`@here`, her name
  (≥ 3 chars, whole word, `wakeOnName`), an edit adding a mention within 2 min, a watch match, Jev.
- From other waifus: mention, reply to her, a role, a watch match; `@everyone` and `name` never apply
  to waifu messages. A waifu's lines that addressed nobody go to Jev, who decides who (if anyone)
  speaks next; the author is never a candidate.
- There is no cap on waifu-to-waifu rounds except the optional room loop guard
  (`life.maxWaifuTriggeredTurns`, default off) and daily budgets. With the guard off, two waifus that
  keep replying to each other wake each other until they stop.
- Per-user wake limit: at most 20 wakes per person per waifu per hour; the rest become one
  `+N more from <name>` line.
- Several waifus woken only by one `@everyone`/shared-role ping are staggered 0–20 s.
- A person's burst is held 1.5 s after their last message (longer while they keep typing, at most
  10 s from the first).

## Posting in a room

`SendMessage` to a room ([messages-and-refs.md](messages-and-refs.md)):

- only through her own bot (never the House bot); a waifu without one gets `error: you have no
  Discord bot of your own, so you can't post; the owner has been told` and the owner gets a notice;
- `<@Name>` mentions resolve and ping only people present in that place (authors of the last 50
  buffered messages and the room's active participants); `@everyone`, `@here` and role pings never
  ping (`allowedMentions` users only, roles `[]`, `repliedUser: false`) (`src/discord/normalization.ts`);
- Discord 50001/50013 (no access/permission) → `error: the message could not be sent: Discord says
  you can't post in this room right now; that can change, so try again later`;
- at most `life.maxSendPlacesPerTurn` (3) places and `life.maxSendsPerTurn` (15) messages per turn
  (each `m:` line of a script counts one).

Her room sends are logged with the room's handle (Activity, Life "recent sends").

## Room transcripts and access

Every message in a room with a cast is written to the shared transcript store; she sees a room's
transcript only for the times she was cast there (access intervals: a waifu added later does not see
what came before; one removed keeps what she saw) ([memory-and-dreaming.md](memory-and-dreaming.md)).

## Room-specific settings

- Cast per channel and threads on/off (Rooms screen, `PUT /api/servers/...`).
- Server pause.
- Detector override per server (Inherit / Off in this server / another target).
- Server-level compaction overrides apply only to older conversation uses, not to lives.
