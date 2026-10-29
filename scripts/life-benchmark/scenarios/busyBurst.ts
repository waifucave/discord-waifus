// A busy group: a game-night server where bursts of eight to fifteen messages land within a minute
// or two, a few aimed at her, most at each other, one @everyone. Tests addressing (who is talking to
// whom), short lines and no spam, and memory across several busy evenings with a small context.

import { defineScenario } from "../scenario.js";

export default defineScenario({
  id: "busy-burst",
  title: "A busy group burst",
  description:
    "Six friends in a game-night server talk over each other in fast bursts on three evenings: a tournament bracket, a lost bet, a birthday plan. A few lines are for her, most are not, one is @everyone. Tests addressing, short lines and no spam.",
  start: { date: "2026-11-23", time: "18:00", timeZone: "Europe/Berlin" },
  end: "d3 23:00",
  server: {
    id: "813000000000000001",
    name: "Couch Co-op",
    channels: [
      { key: "lobby", id: "823000000000000001" },
      { key: "clips", id: "823000000000000002" }
    ]
  },
  people: [
    { key: "felix", id: "833000000000000001", name: "Felix" },
    { key: "jade", id: "833000000000000002", name: "Jade" },
    { key: "omar", id: "833000000000000003", name: "Omar" },
    { key: "lena", id: "833000000000000004", name: "Lena" },
    { key: "kai", id: "833000000000000005", name: "Kai" },
    { key: "rosa", id: "833000000000000006", name: "Rosa" }
  ],
  waifu: {
    name: "Yuki",
    persona:
      "Yuki is a 22-year-old physics student who is unreasonably good at fighting games and pretends she isn't. Competitive, playful, quick with a comeback, secretly sentimental about her friends. She hates spoilers and pineapple pizza with equal passion.",
    style: "short punchy lines, lowercase, lots of 'lmao' and 'nah', one emoji at most, never more than a couple of messages at once",
    bedTime: { start: "01:00", end: "09:00" },
    homeFiles: {
      "MEMORY.md": "- [Felix](people/felix.md): runs the bracket every month\n- [Rosa](people/rosa.md): my duo partner, plays zoners\n",
      "people/felix.md": "Felix organises the monthly bracket. Takes it very seriously. Uses a spreadsheet.\n",
      "people/rosa.md": "Rosa: duo partner, zoner main, birthday in late november (ask the group).\n"
    }
  },
  config: { life: { maxContextTokens: 32_000 } },
  events: [
    // Evening 1: the bracket.
    { at: "d1 20:00:00", place: "#lobby", from: "felix", text: "bracket's up for saturday. 8 people, double elim" },
    { at: "d1 20:00:20", place: "#lobby", from: "jade", text: "who's seed 1" },
    { at: "d1 20:00:35", place: "#lobby", from: "omar", text: "not me clearly" },
    { at: "d1 20:00:50", place: "#lobby", from: "felix", text: "@Yuki is seed 1 obviously", mentions: ["her"] },
    { at: "d1 20:01:05", place: "#lobby", from: "lena", text: "rigged" },
    { at: "d1 20:01:15", place: "#lobby", from: "kai", text: "rigged x2" },
    { at: "d1 20:01:30", label: "omar_jade", place: "#lobby", from: "omar", text: "@Jade you still have my controller from last week?", mentions: ["jade"] },
    { at: "d1 20:01:45", place: "#lobby", from: "jade", text: "it's in my bag i swear", replyTo: "omar_jade" },
    { at: "d1 20:02:00", label: "yuki_q", place: "#lobby", from: "rosa", text: "@Yuki we still teaming for doubles or are you abandoning me", mentions: ["her"] },
    { at: "d1 20:02:10", place: "#lobby", from: "felix", text: "doubles is sunday btw not saturday" },
    { at: "d1 20:02:30", place: "#lobby", from: "lena", text: "wait which game is doubles" },
    { at: "d1 20:02:40", place: "#lobby", from: "felix", text: "same game lena 💀" },
    { at: "d1 21:30", place: "#clips", from: "kai", text: "clip of omar getting perfected", attachments: [{ name: "perfect.png", contentType: "image/png", png: { width: 48, height: 27, rgb: [200, 40, 60] } }] },
    { at: "d1 21:30:30", place: "#clips", from: "omar", text: "delete this" },
    { at: "d1 21:30:50", place: "#clips", from: "jade", text: "framing it" },
    // Evening 2: the bet and a birthday plan.
    { at: "d2 19:15:00", label: "bet", place: "#lobby", from: "kai", text: "ok so @Omar lost the bet. he has to play with a dance pad on saturday", mentions: ["omar"] },
    { at: "d2 19:15:15", place: "#lobby", from: "omar", text: "i didn't agree to the dance pad part" },
    { at: "d2 19:15:30", place: "#lobby", from: "jade", text: "you did. it's in the chat logs" },
    { at: "d2 19:15:45", place: "#lobby", from: "lena", text: "i'll bring the dance pad" },
    { at: "d2 19:16:00", place: "#lobby", from: "felix", text: "adding a dance pad rule to the spreadsheet" },
    { at: "d2 19:16:20", label: "kai_yuki", place: "#lobby", from: "kai", text: "@Yuki you were the witness, back me up", mentions: ["her"] },
    { at: "d2 19:16:40", place: "#lobby", from: "omar", text: "yuki is biased" },
    { at: "d2 19:17:00", place: "#lobby", from: "rosa", text: "lmao" },
    { at: "d2 21:00:00", label: "bday", place: "#lobby", from: "jade", text: "@everyone rosa's birthday is next friday (the 4th). cake + games at mine, don't tell her", everyone: true },
    { at: "d2 21:00:30", place: "#lobby", from: "felix", text: "jade she is IN this channel" },
    { at: "d2 21:00:45", place: "#lobby", from: "jade", text: "oh no" },
    { at: "d2 21:01:00", place: "#lobby", from: "rosa", text: "i saw nothing 🙈" },
    { at: "d2 21:01:20", place: "#lobby", from: "lena", text: "smooth" },
    { at: "d2 21:01:40", label: "rosa_cake", place: "#lobby", from: "rosa", text: "@Yuki if there's cake it better not be pineapple flavoured. you know my rules", mentions: ["her"] },
    // Evening 3: the recall and another burst.
    { at: "d3 19:30:00", place: "#lobby", from: "felix", text: "final reminder: bracket saturday 3pm, doubles sunday 2pm" },
    { at: "d3 19:30:15", place: "#lobby", from: "omar", text: "i'm practicing on the dance pad. it's going badly" },
    { at: "d3 19:30:30", place: "#lobby", from: "kai", text: "post a clip" },
    { at: "d3 19:30:40", place: "#lobby", from: "omar", text: "absolutely not" },
    { at: "d3 19:31:00", label: "lena_q", place: "#lobby", from: "lena", text: "@Yuki wait what did omar lose the bet to? i missed it", mentions: ["her"] },
    { at: "d3 19:31:15", place: "#lobby", from: "jade", text: "lena it was literally yesterday" },
    { at: "d3 19:31:30", label: "jade_felix", place: "#lobby", from: "jade", text: "@Felix can i bring my cousin saturday? he's decent", mentions: ["felix"] },
    { at: "d3 19:31:50", place: "#lobby", from: "felix", text: "if he signs the spreadsheet", replyTo: "jade_felix" },
    { at: "d3 21:00:00", label: "date_q", place: "#lobby", from: "kai", text: "@Yuki when's rosa's thing again? friday the 4th or the 5th? i forgot already", mentions: ["her"] },
    { at: "d3 21:00:20", place: "#lobby", from: "rosa", text: "what thing. i know of no thing" }
  ],
  facts: [
    { id: "seed1", kind: "who", text: "She is seed 1 in Saturday's bracket.", match: ["seed 1", "seed one", "top seed"] },
    { id: "doubles_rosa", kind: "promise", text: "Rosa asked her to team up for doubles on Sunday.", match: ["doubles rosa", "doubles sunday", "teaming rosa"], from: "yuki_q" },
    { id: "bet", kind: "who", text: "Omar lost a bet with Kai and must play with a dance pad on Saturday.", match: ["dance pad"], from: "bet" },
    { id: "rosa_bday", kind: "plan", text: "Rosa's birthday is next Friday the 4th, cake and games at Jade's; a (failed) surprise.", match: ["rosa birthday", "rosa bday", "friday 4", "4th"], from: "bday" },
    { id: "no_pineapple", kind: "preference", text: "No pineapple flavoured cake for Rosa.", match: ["pineapple"], from: "rosa_cake" }
  ],
  probes: [
    { id: "answers_rosa", kind: "replied", place: "#lobby", after: "d1 20:02", by: "d1 20:15", mentions: ["doubles", "team", "duo", "yes", "obviously", "never", "course", "abandon"] },
    { id: "leaves_controller_alone", kind: "not_replied", event: "omar_jade", withinMinutes: 10, about: ["controller", "bag"] },
    { id: "leaves_cousin_alone", kind: "not_replied", event: "jade_felix", withinMinutes: 10, about: ["cousin"] },
    { id: "backs_kai", kind: "replied", place: "#lobby", after: "d2 19:16", by: "d2 19:30" },
    { id: "recalls_bet", kind: "recall_after_compaction", fact: "bet", ask: "lena_q", withinMinutes: 15, mentions: ["dance pad", "dance"] },
    { id: "recalls_bet_any", kind: "recalls", ask: "lena_q", withinMinutes: 15, mentions: ["dance pad", "dance"] },
    { id: "recalls_date", kind: "recalls", ask: "date_q", withinMinutes: 15, mentions: ["4th", "4", "friday"] },
    { id: "notes_birthday", kind: "note_mentions", match: ["rosa birthday", "rosa bday", "birthday 4", "birthday friday"], by: "d2 23:30" },
    { id: "short_lines", kind: "max_line_length", max: 160 },
    { id: "no_spam", kind: "max_burst", max: 3 }
  ]
});
