# Messages and refs

`ReadMessages`, `SendMessage` and `React` (`src/life/tools/messages.ts`, query grammar in
`src/life/tools/readQuery.ts`, refs in `src/discord/refStore.ts` and `src/life/messageRefs.ts`).

## The line format

One format for `ReadMessages`, `/transcripts` and the morning summary's stamps
(`src/life/render.ts` `chatLine`):

```
[14:02 #k3] Kevin: text                 a message with its ref
[14:02 #k4] Kevin ↩#k3: text            a reply to a message with a ref
[14:02 #k5] Kevin ↩you: text            a reply to one of her messages
[14:02 #k6] Kevin ↩Mina: text           a reply to an older message by Mina (no ref)
[14:03 #k7] you: …                      her own message
[13:30] Kevin: …                        no ref (older than 30 days, or a pre-3.3.0 transcript line)
[14:04 #k8] someone: (removed)          a forgotten person's message from before their forget
[14:05 #k9] (message deleted)           a deleted message she could have seen (it had a ref)
```

Suffixes: `(edited)`; `[auto] ` in front of an automatic DM notice; attachments as paths
([her-computer.md](her-computer.md)); one indented `  reactions: 👍 2 · 🎉` line (reactions come from
gateway events, the tail only).

## ReadMessages

`ReadMessages(place, query?)`.

- **`place`**: one handle, up to **5** handles separated by commas, or `everywhere` (all her places;
  only with `people:` or `search:`). Results are grouped per place, separated by a blank line, each
  with a header `<handle> (<label>)`.
- **`query`** (optional, ≤ 2,000 chars; empty = the latest messages). Terms in any order, `key:value`
  or `key value`, case-insensitive:

| Term | Meaning |
|---|---|
| `before <anchor>` | Messages before the anchor; a `#ref` anchor is **included** (`before #c1 max:10` = #c1 and the 10 before it) |
| `after <anchor>` | Messages after the anchor (a `#ref` included); `after <time>` includes that minute |
| `around <anchor>` | Centred on the anchor; `around <day>` = the whole day up to `max`; can't combine with before/after |
| `before … after …` | A range (a snapshot between two points); an empty range is refused |
| `max:N` | Messages per place, 1–100; default **15**, a range without `max` **50** |
| `people:Name, Name` | Only these authors (as shown in chat; case- and accent-insensitive; `you` = herself) |
| `search:words, other words` | Comma-separated alternatives; every word of one alternative must appear as a whole word; matches text and file names |

Anchors: `#ref`; `2026-10-25 17:02`; `2026-10-25` (that day `[00:00, next 00:00)`; `before` = before
it starts, `after` = from its start); `17:02` (today); `yesterday 17:02`; `today`, `yesterday`. Times
are her local time. Inside a `people:`/`search:` value a key word starts a new term only in `key:`
form or when an anchor follows it, so `search:meet before lunch` searches three words and
`people:Max 5` is a name.

Errors end with the three-line syntax summary (`QUERY_SYNTAX`): unknown terms, a term given twice, a
bad anchor, `max` out of range, `around` with before/after, an empty range, a `#ref` with several
places (`error: a #ref belongs to one place; read one place with it`), more than 5 places,
`everywhere` without people:/search:. An unknown or pruned ref that no transcript line carries:
`error: message too old`. Unknown place: `error: unknown place; see ~/life/places.md`.

Old habit: `limit` and `before` (a ref) are still read when sent and the query lacks its own
`max:`/anchor.

Examples (from the tool description):

```
ReadMessages(place: "bake-club/#general")                                   latest 15
ReadMessages(place: "bake-club/#general", query: "around #k3 max:10")
ReadMessages(place: "dm/kevin", query: "before #d4 max:30")
ReadMessages(place: "bake-club/#general", query: "after 2026-10-20 before 2026-10-22")
ReadMessages(place: "everywhere", query: "people:Kevin search:exam, test after 2026-10-20")
```

**Sources**:

- **Unfiltered pages** (latest, ref or time anchors) come from the conversation cache, and from
  Discord's channel-messages API when the buffer does not cover the page. Time anchors become
  snowflake ids, so any point in history works. Past 100 messages a second page continues.
- **`people:`/`search:`** read her transcripts (access intervals apply) newest days first (oldest
  first for `after` alone), plus the cache's messages newer than the place's newest transcript line.
  Per call at most **400 days per place** and **32 MiB** of transcript text; the reply then says it
  stopped (`add before or after to look further`). A filtered place says `N messages match[, M shown]
  (searched <from> – <to>)`, with `(when your transcripts begin)` when the search reaches the store's
  start. With `everywhere`, places without a match are left out, `no messages match (searched …)` when
  none matches, and a last line names places the size limit left unread or read in part. Search
  results show `[file: name]` and download nothing.

**Output details**: `— more before: before #x —` first and `— more after: after #y —` last when the
page was cut (a time is named when the edge message has no ref); `— Sat 24 Oct —` lines where each day
starts when the page is not all today; `(no messages)` when empty.

**Effects**:

- Only a page with **no anchor** moves her read cursor (`reads.json`; cursors never move back).
- Returned ids are added to her epoch's read ids (at most 200 per call).
- Attachments are downloaded into `/tmp` (at most 10 per call).
- A DM forget floor hides everything at or below it; an unreadable floor or forget record gives
  `error: messages can't be read right now`.
- Every place whose messages are in the result counts as touched (a DM read makes the call private).

## Refs

- **Assigned at ingest**: the transcript writer gives every line it writes its ref, in message-id
  order, one per-conversation counter shared by every waifu (base-36 from `a0` = 360; never reused).
  Pages, searches, notifications and the morning summary take `refs.json` first, then the ref stored
  on the message's transcript line, and only then assign a new one, with the messages before it, so
  refs stay in message order (`refsForMessages`).
- Her send gets a ref after the messages before it get theirs: `sent #k9`.
- **Pruning**: `refs.json` drops refs more than 10,000 behind the counter or older than 30 days, but
  only once it holds 1,000 refs past the span; a message older than 30 days gets no new ref.
- **Resolution** (`messageIdForRef`): `refs.json`, else the transcript line carrying that ref
  (`findTranscriptRef`), never a line a forget covers or at/below a DM floor. So a ref she saw in a
  transcript works in `ReadMessages`, `reply_to` and `React` for as long as the line exists.

## SendMessage

`SendMessage(place, text?, reply_to?, files?)` → `sent #k9` (`sendMessageTool`). Checks in order:

1. `error: unknown place; see ~/life/places.md`.
2. No bot of her own: `error: you have no Discord bot of your own, so you can't post; the owner has been
   told` (owner notice `no-bot:<id>`, cleared at her next successful send).
3. A DM she may not write in, or a paused server: `error: you can't post there` ([dms.md](dms.md)).
4. More than `life.maxSendPlacesPerTurn` (3) places this turn: `you've already written in 3 places this
   turn`; more than `life.maxSendsPerTurn` (8) messages: `you've already sent 8 messages this turn;
   wait for replies`.
5. A leading copied `[HH:MM #ref] Name:` header is stripped; text that is only tool-call syntax is
   refused (`that looks like a tool call, not a message; write what you want to say`).
6. Files resolved (see [her-computer.md](her-computer.md)); nothing left to send: `there is nothing to
   send…` or `nothing was sent: not attached: …`.
7. `reply_to` resolved like any ref, else `error: message too old`.
8. Typing for `30 ms × chars` (0.6–4.5 s), then the send through her bot.

Errors from Discord: DM 50007 → `they can't receive your messages right now` (DM marked undeliverable);
40005/413 with files → `…the files are too large for Discord here; send fewer or smaller ones`;
50001/50013 → `…Discord says you can't post in this room right now…`; anything else → `the message
could not be sent`.

- `text` ≤ 2,000 characters; may be empty only with a file attached.
- Mentions: `<@Name>` resolves and pings only people present; no `@everyone`, `@here` or role pings.
- On success: the DM rate-limit counter (first send per turn per person), her read cursor, her busy
  "open place" / bed-time clock (`noteSend`), the intent's done line, typing stops there.
- The result lists files not attached: `sent #k9; not attached: ~/people/kevin.md (your notes and the
  files in ~/life/ are private and can't be attached)`.

## React

`React(place, ref, emoji)` → `reacted` (`reactTool`).

- `emoji`: a unicode emoji, or `:name:` / `<:name:id>` for a server emoji (`there is no :x: emoji
  here` when unknown); plain text is refused (`use a unicode emoji or :server_emoji:`).
- A paused server: `error: you can't post there`. Needs her own bot (`you can't react right now`).
- The ref resolves like `reply_to`.

## Spec differs

- §6.2 (read cursor advances on every read, footer `pass before:"#a0"`) and §16.3's `limit`/`before`
  parameters are replaced by §22; the code matches the §22.5 as-built notes.
