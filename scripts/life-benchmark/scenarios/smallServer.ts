// A day (three, in fact) in a small friends' server: greetings, a question for her, a message for
// someone else, a newcomer, a driving test to follow up on, a preference to recall days later. Her
// context is kept small so her memory is summarised within the scenario.

import { defineScenario } from "../scenario.js";

export default defineScenario({
  id: "small-server",
  title: "A few days in a small server",
  description:
    "Five friends in a small server over three days. Jonah asks her something, Max and Priya talk business, Lou joins and wants horror movie recs (no jump scares), Priya has a driving test on Thursday morning, and two days later people check what she remembers.",
  start: { date: "2026-11-10", time: "08:45", timeZone: "America/New_York" },
  end: "d3 21:30",
  server: {
    id: "811000000000000001",
    name: "Night Owls",
    channels: [
      { key: "general", id: "821000000000000001" },
      { key: "games", id: "821000000000000002" }
    ]
  },
  people: [
    { key: "jonah", id: "831000000000000001", name: "Jonah" },
    { key: "priya", id: "831000000000000002", name: "Priya" },
    { key: "max", id: "831000000000000003", name: "Max" },
    { key: "lou", id: "831000000000000004", name: "Lou" },
    { key: "sam", id: "831000000000000005", name: "Sam" }
  ],
  waifu: {
    name: "Hana",
    persona:
      "Hana is a 24-year-old freelance illustrator who lives on iced coffee and draws spooky cute stuff. She adores horror movies (the slow, creepy kind more than gore), owns a grumpy black cat called Mochi, and makes terrible puns on purpose. She is warm but teasing, a bit chaotic with deadlines, and remembers what her friends are going through.",
    style: "lowercase, short messages, sometimes two or three in a row, the odd 💀 or 🙃, never formal",
    bedTime: { start: "00:30", end: "08:30" },
    homeFiles: {
      "MEMORY.md": "- [Jonah](people/jonah.md): server owner, works night shifts at a warehouse\n- [Mochi](mochi.md): my cat\n",
      "people/jonah.md": "Jonah runs Night Owls. Night shifts at the warehouse, sleeps till noon on weekends. Owes me a coffee.\n",
      "mochi.md": "Mochi: black cat, 6, hates the vacuum and Tuesdays.\n"
    }
  },
  config: { life: { maxContextTokens: 40_000 } },
  events: [
    { at: "d1 09:02", place: "#general", from: "jonah", text: "morning gremlins" },
    { at: "d1 09:03", place: "#general", from: "priya", text: "mornin. coffee status: critical" },
    { at: "d1 09:40", label: "jonah_q", place: "#general", from: "jonah", text: "@Hana you still doing the inktober thing or did you bail lol", mentions: ["her"] },
    { at: "d1 10:15", label: "for_priya", place: "#general", from: "max", text: "@Priya did you send the invoice to the client yet", mentions: ["priya"] },
    { at: "d1 10:17", place: "#general", from: "priya", text: "yeah this morning, they said they'd pay by friday", replyTo: "for_priya" },
    { at: "d1 10:18", place: "#general", from: "max", text: "nice. if they're late again i'm charging interest", detector: "none" },
    { at: "d1 12:00", label: "lou_joins", kind: "join", place: "#general", who: "lou" },
    { at: "d1 12:02", label: "lou_hi", place: "#general", from: "lou", text: "hi! jonah sent me the invite. what's this place about?" },
    { at: "d1 12:03", place: "#general", from: "jonah", text: "mostly us complaining about work and playing bad games" },
    { at: "d1 12:03:40", place: "#general", from: "jonah", text: "welcome tho 👋" },
    { at: "d1 13:30", label: "drive", place: "#general", from: "priya", text: "@Hana btw i have my driving test thursday morning at 10. wish me luck 😬", mentions: ["her"] },
    { at: "d1 15:10", place: "#games", from: "sam", text: "patch notes are out and they nerfed my main AGAIN" },
    { at: "d1 15:12", place: "#games", from: "max", text: "skill issue" },
    { at: "d1 18:00", label: "among", place: "#games", from: "sam", text: "anyone up for among us tonight? like 9ish" },
    { at: "d1 18:05", place: "#games", from: "max", text: "maybe, after dinner" },
    { at: "d1 21:00", label: "lou_recs", place: "#general", from: "lou", text: "@Hana jonah says you're the horror person here. got any recs for the weekend?", mentions: ["her"] },
    { at: "d1 21:01:30", label: "lou_pref", place: "#general", from: "lou", text: "oh and nothing with jump scares pls, i actually hate those. slow creepy stuff is fine", detector: "her" },
    { at: "d1 23:40", place: "#general", from: "jonah", text: "shift starts in 20. pray for me" },
    { at: "d2 07:15", place: "#general", from: "jonah", text: "who ate my leftover pizza. i know it was one of you" },
    { at: "d2 07:16", place: "#general", from: "max", text: "you live alone jonah" },
    { at: "d2 11:00", label: "max_jonah", place: "#general", from: "max", text: "@Jonah you owe me 20 from the game btw", mentions: ["jonah"] },
    { at: "d2 11:20", place: "#general", from: "jonah", text: "i will pay you in exposure", replyTo: "max_jonah" },
    { at: "d2 14:00", place: "#general", from: "priya", text: "ugh the client still hasn't paid. it's not even friday yet and i'm already mad" },
    { at: "d2 16:30", label: "lou_watched", place: "#general", from: "lou", text: "@Hana ok i watched one of your recs last night. why would you do this to me", mentions: ["her"] },
    { at: "d2 16:31", place: "#general", from: "lou", text: "(it was great. i slept with the lights on)", detector: "her" },
    { at: "d2 19:45", place: "#games", from: "sam", text: "among us round 2 tonight? same time" },
    { at: "d2 19:50", place: "#games", from: "lou", text: "i'm in if someone explains the rules again" },
    { at: "d2 22:10", label: "priya_nervous", place: "#general", from: "priya", text: "can't sleep. tomorrow is THE day", detector: "chime" },
    { at: "d3 13:30", label: "passed", place: "#general", from: "priya", text: "PASSED 🎉🎉🎉 only clipped one cone", detector: "anyone" },
    { at: "d3 13:31", place: "#general", from: "jonah", text: "LETS GOOO" },
    { at: "d3 13:32", place: "#general", from: "max", text: "the roads are no longer safe" },
    { at: "d3 17:00", label: "sam_ask", place: "#general", from: "sam", text: "@Hana planning movie night for saturday. lou's coming, anything we should avoid for lou?", mentions: ["her"] },
    { at: "d3 20:30", label: "jonah_mochi", place: "#general", from: "jonah", text: "@Hana how's the cat doing, still at war with the vacuum?", mentions: ["her"] }
  ],
  facts: [
    { id: "driving_test", kind: "plan", text: "Priya's driving test is Thursday morning at 10.", match: ["driving test", "driving", "priya test"], from: "drive" },
    { id: "lou_no_jump", kind: "preference", text: "Lou hates jump scares; slow creepy horror is fine.", match: ["jump scare", "jumpscare", "jump"], from: "lou_pref" },
    { id: "lou_new", kind: "who", text: "Lou is new; Jonah invited them.", match: ["lou new", "lou joined", "lou jonah invite"], from: "lou_hi" },
    { id: "client_friday", kind: "plan", text: "Priya's client should pay by Friday.", match: ["client friday", "invoice", "client pay"], from: "for_priya" },
    { id: "jonah_owes", kind: "who", text: "Jonah owes Max 20 from the game.", match: ["owes max", "owe max", "jonah 20", "jonah owes"], from: "max_jonah" }
  ],
  probes: [
    { id: "answers_jonah", kind: "replied", place: "#general", after: "d1 09:40", by: "d1 10:10" },
    { id: "leaves_invoice_alone", kind: "not_replied", event: "for_priya", withinMinutes: 20, about: ["invoice", "client"] },
    { id: "gives_recs", kind: "replied", place: "#general", after: "d1 21:00", by: "d1 21:40" },
    { id: "notes_driving_test", kind: "note_mentions", match: ["driving test", "driving", "priya test"], by: "d1 23:00" },
    { id: "wakeup_for_test", kind: "wakeup_in_window", from: "d3 08:30", to: "d3 13:00" },
    { id: "follows_up_test", kind: "followed_up", place: "#general", from: "d3 08:30", to: "d3 13:29", mentions: ["test", "driving", "luck", "exam"] },
    { id: "recalls_lou_pref", kind: "recall_after_compaction", fact: "lou_pref", ask: "sam_ask", withinMinutes: 30, mentions: ["jump"] },
    { id: "recalls_mochi", kind: "recalls", ask: "jonah_mochi", withinMinutes: 30, mentions: ["mochi", "vacuum", "hoover"] },
    { id: "short_lines", kind: "max_line_length", max: 220 },
    { id: "no_spam", kind: "max_burst", max: 5 }
  ]
});
