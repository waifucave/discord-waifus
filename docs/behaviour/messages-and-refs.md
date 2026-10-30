# Messages and refs

`ReadMessages` and `SendMessage` (`src/life/tools/messages.ts`, anchors in
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

`ReadMessages` takes a script (spec §32, [her-computer.md](her-computer.md#tool-scripts)) calling
`tools.read_messages({ place, around | before | after, max, people, search })`, which returns the lines
as text (at most 5 calls per script, 100,000 characters shown).

- **`place`**: one handle, a list of up to **5** (or handles separated by commas), or `"everywhere"`
  (all her places; only with `people` or `search`). Results are grouped per place, separated by a
  blank line, each with a header `<handle> (<label>)`.
- **Anchors and fields** (all optional; none = the latest messages):

| Field | Meaning |
|---|---|
| `before: <anchor>` | Messages before the anchor; a `#ref` anchor is **included** (`before: "#c1", max: 10` = #c1 and the 10 before it) |
| `after: <anchor>` | Messages after the anchor (a `#ref` included); a time includes that minute |
| `around: <anchor>` | Centred on the anchor; a day = the whole day up to `max`; can't combine with before/after |
| `before` + `after` | A range (a snapshot between two points); an empty range is refused |
| `max` | Messages per place, 1–100; default **15**, a range without `max` **50** |
| `people` | A name or a list (as shown in chat; case- and accent-insensitive; `you` = herself) |
| `search` | Words, or a list of alternatives; every word of one alternative must appear as a whole word; matches text and file names |

Anchors: `"#ref"`; `"2026-10-25 17:02"`; `"2026-10-25"` (that day `[00:00, next 00:00)`; `before` =
before it starts, `after` = from its start); `"17:02"` (today); `"yesterday 17:02"`; `"today"`,
`"yesterday"`. Times are her local time.

Errors throw in her script before anything is read: an unknown field, a bad anchor (`tools.read_messages:
around is a #ref or a time, like "#k3", …`), `max` out of range, `around` with before/after, an empty
range, a `#ref` with several places (`a #ref belongs to one place; read one place with it`), more than 5
places, `everywhere` without people/search. An unknown or pruned ref that no transcript line carries:
`message too old`. Unknown place: `unknown place; see ~/life/places.md`.

Examples:

```js
text(await tools.read_messages({ place: "bake-club/#general" }))                       // latest 15
text(await tools.read_messages({ place: "bake-club/#general", around: "#k3", max: 10 }))
text(await tools.read_messages({ place: "dm/kevin", before: "#d4", max: 30 }))
text(await tools.read_messages({ place: "bake-club/#general", after: "2026-10-20", before: "2026-10-22" }))
text(await tools.read_messages({ place: "everywhere", people: "Kevin", search: ["exam", "test"], after: "2026-10-20" }))
```

A call from before §32 (`place` and a freeform `query`, §22) still runs with the old grammar (an old
log line).

**Sources**:

- **Unfiltered pages** (latest, ref or time anchors) come from the conversation cache, and from
  Discord's channel-messages API when the buffer does not cover the page. Time anchors become
  snowflake ids, so any point in history works. Past 100 messages a second page continues.
- **`people`/`search`** read her transcripts (access intervals apply) newest days first (oldest
  first for `after` alone), plus the cache's messages newer than the place's newest transcript line.
  Per call at most **400 days per place** and **32 MiB** of transcript text; the reply then says it
  stopped (`add before or after to look further`). A filtered place says `N messages match[, M shown]
  (searched <from> – <to>)`, with `(when your transcripts begin)` when the search reaches the store's
  start. With `everywhere`, places without a match are left out, `no messages match (searched …)` when
  none matches, and a last line names places the size limit left unread or read in part. Search
  results show `[file: name]` and download nothing.

**Output details**: `— more before: before #x —` first and `— more after: after #y —` last when the
page was cut (a time is named when the edge message has no ref, with its weekday: `before Tue
2026-09-01 10:05`, which reads back as an anchor; any anchor date may carry a weekday in front, and
the date wins); `— Sat 24 Oct —` lines where each day starts when the page is not all today;
`(no messages)` when empty. A search says where it searched with weekdays too: `(searched Fri
2026-10-23 – Sat 2026-10-24)`. A page that reaches now (no `before` or `around`, nothing newer) ends
with `— you've written here 3 times since anyone answered (since Tue 21:00) —` when her unanswered
sends there are two or more (see [Unanswered sends](#unanswered-sends)).

**Effects**:

- Only a page with **no anchor** moves her read cursor (`reads.json`; cursors never move back).
- Returned ids are added to her epoch's read ids (at most 200 per call).
- Attachments are downloaded into `/tmp` (at most 10 per call).
- A DM forget floor hides everything at or below it; an unreadable floor or forget record gives
  `messages can't be read right now`.
- Every place whose messages are in the result counts as touched (a DM read makes the script private,
  also when a later call fails).

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
  transcript works in `read_messages`, a message's `reply_to` and a reaction's `to` for as long as the
  line exists.

## SendMessage

`SendMessage` takes a script (spec §27, §32; [her-computer.md](her-computer.md#tool-scripts)) calling
`tools.send_message({ place, messages: [...] })` (`sendMessageCall`, `runSend` in
`src/life/tools/messages.ts`). One call sends to one place; a script may call it for several places
(the calls run one at a time, in the order she made them, also when she starts them together with
`Promise.all`). `messages` is a list, in order; each item is exactly one of these (`{ text, wait }`
or `{}` throws):

| Item | Meaning |
|---|---|
| `{ text, reply_to?, attach? }` | One message (≤ 2,000 characters; a newline inside it is fine). `reply_to: "#k3"` makes it a Discord reply; `attach: ["~/x.png"]` (always a list) adds files (at most `life.send.maxFiles`, 4). |
| `{ attach }` | A message with only the files. |
| `{ react: "👍", to: "#k3" }` | A reaction: a unicode emoji, or `:name:` / `<:name:id>` for a server emoji (`there is no :x: emoji here` when unknown); plain text is refused (`use a unicode emoji or :server_emoji:`). |
| `{ wait: 1–60 }` | A pause. If anyone else writes in that place meanwhile (a person, another waifu or a bot; typing doesn't count), the wait ends at once and the rest of the call is not sent. |
| `{ typing: 1–10 }` | Typing there for that long, without sending. Waits and typing together: at most **120 s** per script (all its calls). |

```js
return await tools.send_message({ place: "bake-club/#general", messages: [
  { text: "wait what" },
  { text: "kevin you said saturday" },
  { wait: 5 },
  { text: "ok fine i'm in", reply_to: "#k3" },
  { react: "😂", to: "#k4" }
] })
```

- **Checked first, all or nothing per call.** Shape (an unknown field, an item that is none of the
  above, a bad number, more files than `life.send.maxFiles`, a message over 2,000 characters, waits and
  typing over **120 s** in the script, nothing to send), then the caps, every message's text, refs,
  files and emoji. Any error throws in her script naming the item and nothing of that call is sent:
  `tools.send_message: messages[2]: #k9: message too old; nothing was sent`, `tools.send_message:
  messages[1]: can't attach ~/MEMORY.md (your notes and the files in ~/life/ are private and can't be
  attached); nothing was sent`.
- A call from before §32 (`place` with a §27 script of `m:`/`reply`/`attach`/`react`/`wait`/`typing`
  lines, or `text`/`reply_to`/`files`) still runs and reports as it did (an old log line).

Checks in order:

1. `unknown place …; see ~/life/places.md` (the place first, so a refused DM call is still a DM call in
   the owner's views, D14).
2. The items' shape (above).
3. No bot of her own: `you have no Discord bot of your own, so you can't post; the owner has been
   told` (owner notice `no-bot:<id>`, cleared at her next successful send).
4. A DM she may not write in, or a paused server: `you can't post there` ([dms.md](dms.md)).
5. More than `life.maxSendPlacesPerTurn` (3) places this turn: `you've already written in 3 places this
   turn`. Every message (and every file-only send) counts one against `life.maxSendsPerTurn` (**15**):
   none left, `you've already sent 15 messages this turn; wait for replies`; a call that would go
   over, `this script sends 4 messages, and you can send 2 more this turn; nothing was sent`.
6. Per message: a leading copied `[HH:MM #ref] Name:` header is stripped; text that is only tool-call
   syntax is refused (`that looks like a tool call, not a message; write what you want to say`).
7. `reply_to` and `to` refs resolved like any ref, else `#k9: message too old`; files resolved (see
   [her-computer.md](her-computer.md)); emoji as above.

Then the items run in order. Before every message her bot types for `30 ms × chars` (0.6–4.5 s), then
the message goes through her bot. Between items without a `wait`, new messages don't stop the call.
The turn keeps running during a wait; wakes that arrive fold into the next tool results as usual. The
whole script's wall clock covers its worst case: 120 s of waits and typing, 4.5 s of typing for each
message the turn may still send, and 30 s for Discord (217.5 s at the default 15 sends). Once the
script is stopped, a call in progress stops before its next item and calls still queued never start.
Each call after the first looks at the place again first (a cast or server pause, a closed DM).

**Result**: `{ sent: ["#k9", "#ka"], reactions: ["#k2"], stopped?, note? }`. A wait someone cut
short ends that list only (her script and its other calls go on): `stopped` is `{ reason:
"new_message", next_index, incoming }`, `next_index` the first item of the list not run and
`incoming` what came in as notification lines (with refs, at most `life.notificationLinesPerPlace`):

```json
{"sent":["#k9"],"reactions":[],"stopped":{"reason":"new_message","next_index":2,"incoming":["- bake-club/#general · from Mina · #kb \"wait what\""]}}
```

A Discord error on an item stops the rest: `{ reason: "send_failed", next_index: 3, error: "the
message could not be sent" }`. An interrupted script (stop, pause, abort) sends nothing more: `{
reason: "interrupted", next_index }`. After a `wait` or a `typing` item the place is looked at again
before the next send or reaction: a server paused, the cast paused, a DM she may no longer write in
or a place no longer hers stops the rest (`send_failed`, `you can't post there`). Whatever her
script does with the result, the host adds a receipt after her output (§32.3a): `[receipt]
send_message to bake-club/#general: sent #k9; stopped (someone wrote during the wait): messages[2]
and after were not sent`; a send she never waited for is waited for, and a send that began is never
reported as not sent. A send that leaves her unanswered sends there at two or more adds, once per
place per script: `. No one has answered your last 3 here (since Tue 21:00). Let it rest: wait for
someone to write before you write here again.` (a DM: `They haven't answered … wait for them to
write …`). It never refuses or holds a send. When nothing went out it throws: one item alone gives just the reason (`tools.send_message:
they can't receive your messages right now`), a longer call `tools.send_message: messages[0]: the
message could not be sent; nothing was sent`.

Errors from Discord: DM 50007 → `they can't receive your messages right now` (DM marked undeliverable);
40005/413 with files → `the message could not be sent: the files are too large for Discord here; send
fewer or smaller ones`; 50001/50013 → `the message could not be sent: Discord says you can't post in
this room right now…`; anything else → `the message could not be sent`.

**Shorter messages (§27.2)**: when a sent message is longer than max(3 × the place's typical length,
120) characters, the result's `note` says `that line was 180 characters; people here usually write
about 25` (her longest). The typical length is the median of the newest **50** non-empty messages from
people in that place (not waifus, not bots; in a DM the other person), from the conversation cache and
then the place's transcript (its last 14 days), used only with at least **10** of them. Nothing is
refused for length.

- Mentions: `<@Name>` resolves and pings only people present; no `@everyone`, `@here` or role pings.
  In a room, `<@Name}`, `<@Name)`, `<@Name]` or an unclosed `<@Name` for a known member resolves
  the same way; with an unknown name the text is sent as written.
- After each message: the DM rate-limit counter (first send per turn per person), her read cursor,
  its ref (after the messages before it get theirs) and its own intent lines: the final content's
  digest (`line`, numbered across the script, and `contentDigest`) just before the Discord call and
  `lineDone` with the message id right after. Each call also writes its `plan` (place and messages)
  once everything is checked, before its first Discord call, and `callDone` after it, so boot repair
  knows what each call meant to send ([life-and-turns.md](life-and-turns.md)). After a script that
  sent anything: her busy "open place" / bed-time clock (`noteSend`) for each place it sent to, and the
  call's done line (every message id).
- Her bot's typing from the streaming call (from the first `place: "…"` in the script as it streams)
  stops when the script starts; the script shows typing itself (before each message and for `typing`
  items), never during a `wait`.

## React

The `React` tool (`React(place, ref, emoji)`, `reactTool`) is kept for old log lines but no longer
offered (§32): she reacts with a `{ react, to }` item of `send_message`, with the same rules.

## Unanswered sends

(2026-10-30, spec §34; `src/life/unanswered.ts`.) Per place, the number of her separate sends there
since anyone else last wrote (in a DM, the other person; in a room, anyone, other waifus included),
and when that streak began. Nothing new is stored: it is read from the conversation's latest page
(50 messages, the cache's buffer while the conversation is trusted) and, when that page holds only her
messages, from the place's transcript days, newest first, at most 14 days back.

- **A send, not a message**: her messages less than 5 minutes after her previous one there are one
  send (`UNANSWERED_SEND_GAP_MS`), so one `send_message` with three lines, or two calls in one turn,
  count once (unless they are 5 minutes or more apart).
- **Shown from 2** (`UNANSWERED_NOTICE_FROM`, not a setting): on her ended watches' notification
  lines, at the end of a ReadMessages page that reaches now, and in the SendMessage receipt. The start
  reads with its weekday: `Tue 21:00` within the last six days, else `Mon 26 Oct 23:50`.
- **Soft**: it never blocks, holds or refuses a send. A failure to read it shows nothing.

## Spec differs

- §6.2 (read cursor advances on every read, footer `pass before:"#a0"`) and §16.3's `limit`/`before`
  parameters are replaced by §22, and §22's freeform query by §32's fields; the code matches the
  §22.5 and §32.4 as-built notes.
- §6.3/§16.3.2 `SendMessage(place, text?, reply_to?, files?)` was replaced by the §27 script and that
  by §32's `tools.send_message`; choices the spec left open are in §27.4 and §32.4.
