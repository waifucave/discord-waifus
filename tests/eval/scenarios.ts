// Eval scenario definitions — all 12 scenarios from design doc 05-eval-harness.md §2.
//
// All casts are INVENTED (Yuki / Mika / Riko / Kevin). No real chat content.
// Each scenario has a compact synthetic context (4-8 messages) and an expectation record.

import type { ContextMessage } from "../../src/orchestration/context.js";

// ---------------------------------------------------------------------------
// Roster entry
// ---------------------------------------------------------------------------

export type RosterEntry = {
  id: string;
  displayName: string;
  persona: string;
  botId: string;
};

// ---------------------------------------------------------------------------
// ScenarioExpect — per-scenario assertion record for tier-2 tests
// ---------------------------------------------------------------------------

export type ScenarioExpect = {
  /** action must equal this value if specified */
  action?: "reply" | "no_reply";
  /** 1-responder scenarios */
  maxResponders?: number;
  minResponders?: number;
  /** Whether a directive is acceptable (false = no directive should be issued) */
  directiveAllowed?: boolean;
  /** directive.intent must be one of these (if a directive fires) */
  expectedIntentOptions?: string[];
  /** retriggerAfterSeconds must be ≥ this */
  minRetrigger?: number;
  /** retriggerAfterSeconds must be ≤ this */
  maxRetrigger?: number;
  /** wakePlan must be non-empty string on no_reply */
  requiresWakePlan?: boolean;
  /** generated waifu reply must not exceed this char count */
  maxReplyChars?: number;
  /** at least one responding waifu must address this waifu id */
  targetWaifuId?: string;
};

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

export type EvalScenario = {
  key: string;
  description: string;
  messages: ContextMessage[];
  roster: RosterEntry[];
  expect: ScenarioExpect;
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const TS_BASE = "2026-06-11T14:00:00Z";

function msg(
  id: string,
  authorKind: "user" | "waifu",
  displayName: string,
  authorId: string,
  content: string,
  offsetSeconds = 0
): ContextMessage {
  const ts = new Date(Date.parse(TS_BASE) + offsetSeconds * 1000).toISOString();
  return {
    id,
    channelId: "ch-eval",
    guildId: "g-eval",
    authorKind,
    authorId,
    authorBot: authorKind === "waifu",
    name: displayName,
    displayName,
    content,
    timestamp: ts,
    reactions: []
  };
}

const YUKI: RosterEntry = { id: "yuki", displayName: "Yuki", persona: "warm and curious, uses light humor", botId: "yuki-bot" };
const MIKA: RosterEntry = { id: "mika", displayName: "Mika", persona: "dry and direct, rarely emotes", botId: "mika-bot" };
const RIKO: RosterEntry = { id: "riko", displayName: "Riko", persona: "playful trickster, short replies", botId: "riko-bot" };

// ---------------------------------------------------------------------------
// All 12 scenarios
// ---------------------------------------------------------------------------

export const EVAL_SCENARIOS: EvalScenario[] = [
  // ── 1. Human asks one waifu a direct question ──────────────────────────
  {
    key: "direct-question",
    description: "Human asks Yuki a direct question; expects exactly 1 responder (Yuki), no directive",
    roster: [YUKI, MIKA],
    messages: [
      msg("m1", "user", "Kevin", "u1", "hey Yuki, what's your favourite season?", 0),
      msg("m2", "user", "Kevin", "u1", "it's getting pretty cold out here", 10)
    ],
    expect: {
      maxResponders: 1,
      directiveAllowed: false
    }
  },

  // ── 2. Two waifus mid-banter, fresh beat ───────────────────────────────
  {
    key: "banter-beat",
    description: "Yuki and Mika are mid-banter; expects 1-2 responders, ≤1 directive",
    roster: [YUKI, MIKA],
    messages: [
      msg("m1", "waifu", "Yuki", "yuki-bot", "okay but the moon was so pretty last night", 0),
      msg("m2", "waifu", "Mika", "mika-bot", "you say that every week Yuki", 15),
      msg("m3", "user", "Kevin", "u1", "lol are you two arguing again", 30),
      msg("m4", "waifu", "Yuki", "yuki-bot", "no! we're appreciating nature", 45)
    ],
    expect: {
      minResponders: 1,
      maxResponders: 2,
      directiveAllowed: true
    }
  },

  // ── 3. Repetitive volley — loop detector fires ─────────────────────────
  {
    key: "repetitive-volley",
    description: "4 near-duplicate exchanges; loop detector should fire; expects change_topic/break_loop directive or speaker change",
    roster: [YUKI, MIKA, RIKO],
    messages: [
      msg("m1", "waifu", "Yuki", "yuki-bot", "did you finish the project?", 0),
      msg("m2", "waifu", "Mika", "mika-bot", "yeah the project is basically done", 20),
      msg("m3", "waifu", "Yuki", "yuki-bot", "oh nice, when is the project due?", 40),
      msg("m4", "waifu", "Mika", "mika-bot", "the project is due Friday", 60),
      msg("m5", "waifu", "Yuki", "yuki-bot", "right, so the project is Friday then?", 80),
      msg("m6", "waifu", "Mika", "mika-bot", "yes Friday, the project", 100)
    ],
    expect: {
      directiveAllowed: true,
      expectedIntentOptions: ["break_loop", "change_topic"]
    }
  },

  // ── 4. Beat landed, nothing to add — no_reply ──────────────────────────
  {
    key: "beat-landed",
    description: "A clear conversational beat just landed; expects no_reply with wakePlan, retrigger ≥ 600s",
    roster: [YUKI, MIKA],
    messages: [
      msg("m1", "user", "Kevin", "u1", "just wanted to say you two are really fun to talk to", 0),
      msg("m2", "waifu", "Yuki", "yuki-bot", "aww thank you Kevin! 🥺", 10),
      msg("m3", "waifu", "Mika", "mika-bot", "appreciated", 20),
      msg("m4", "user", "Kevin", "u1", "okay gtg, later!", 30)
    ],
    expect: {
      action: "no_reply",
      minRetrigger: 600,
      requiresWakePlan: true
    }
  },

  // ── 5. Dead room, humans gone for hours ───────────────────────────────
  {
    key: "dead-room",
    description: "No human activity for hours; expects no_reply with retrigger ≥ 3600s; reasoning must not say 'waiting for users is our purpose'",
    roster: [YUKI, MIKA],
    messages: [
      msg("m1", "user", "Kevin", "u1", "night everyone", 0),
      msg("m2", "waifu", "Yuki", "yuki-bot", "night Kevin 🌙", 5),
      // No more messages — simulate dead room by leaving context sparse
      msg("m3", "waifu", "Mika", "mika-bot", "quiet in here", 3600)
    ],
    expect: {
      action: "no_reply",
      minRetrigger: 3600,
      requiresWakePlan: true
    }
  },

  // ── 6. Timer-fired wake with a stated plan ─────────────────────────────
  {
    key: "timer-wake-with-plan",
    description: "Timer wake fires; model should execute the planned revival or extend backoff; must not identical re-pause",
    roster: [YUKI, MIKA, RIKO],
    messages: [
      msg("m1", "waifu", "Yuki", "yuki-bot", "gonna bring up the game later when Riko's back", 0),
      msg("m2", "waifu", "Mika", "mika-bot", "sure", 5),
      // Simulate a wake marker via message content (the real harness injects OrchestratorWakeMarker)
      msg("m3", "user", "Kevin", "u1", "[wake: plan was to discuss the game with Riko]", 1800)
    ],
    expect: {
      // Either replies (executes the plan) or extends backoff — not an identical no_reply with same seconds
      minResponders: 0
    }
  },

  // ── 7. Quiet human's message overlooked ───────────────────────────────
  {
    key: "overlooked-message",
    description: "A human's message was skipped 10 messages ago; expects spotlight/include_person directive or responder targeting them",
    roster: [YUKI, MIKA, RIKO],
    messages: [
      msg("m1", "user", "Kevin", "u1", "hey has anyone heard the new album? it's really good", 0),
      msg("m2", "waifu", "Yuki", "yuki-bot", "omg Riko that was so funny earlier", 30),
      msg("m3", "waifu", "Mika", "mika-bot", "lol what happened", 45),
      msg("m4", "waifu", "Riko", "riko-bot", "I tripped on stream and everyone saw", 60),
      msg("m5", "waifu", "Yuki", "yuki-bot", "💀💀 amazing content honestly", 75),
      msg("m6", "waifu", "Mika", "mika-bot", "peak entertainment", 90),
      msg("m7", "waifu", "Riko", "riko-bot", "thanks I hate it", 105),
      msg("m8", "waifu", "Yuki", "yuki-bot", "still iconic though", 120),
      msg("m9", "waifu", "Mika", "mika-bot", "true", 135),
      msg("m10", "waifu", "Riko", "riko-bot", "you're all terrible", 150)
    ],
    expect: {
      directiveAllowed: true,
      expectedIntentOptions: ["spotlight", "include_person"]
    }
  },

  // ── 8. Pile-on moment (big announcement) ──────────────────────────────
  {
    key: "pile-on-announcement",
    description: "Kevin drops a big announcement; ≥2 responders acceptable, 3 allowed",
    roster: [YUKI, MIKA, RIKO],
    messages: [
      msg("m1", "user", "Kevin", "u1", "OKAY SO I just got into my first choice university!!!", 0),
      msg("m2", "user", "Kevin", "u1", "I literally can't believe it I'm shaking 😭", 5)
    ],
    expect: {
      minResponders: 2,
      maxResponders: 3
    }
  },

  // ── 9. Naive long-winded persona, casual ping ─────────────────────────
  {
    key: "long-persona-length-cap",
    description: "Waifu with a very long verbose persona gets a casual ping; reply must be ≤400 chars",
    roster: [
      {
        id: "yuki",
        displayName: "Yuki",
        persona: "A deeply thoughtful and verbose character who always responds with extensive context and background information, drawing from philosophy, literature, and her own complex history, never giving a short answer when a long one is possible, always exploring every facet of a question before arriving at her conclusion.",
        botId: "yuki-bot"
      }
    ],
    messages: [
      msg("m1", "user", "Kevin", "u1", "hey Yuki what time is it", 0)
    ],
    expect: {
      maxResponders: 1,
      maxReplyChars: 400
    }
  },

  // ── 10. Memory-dependent callback ─────────────────────────────────────
  {
    key: "memory-callback",
    description: "A fact seeded in the memory store (not in context window) should be usable in a reply",
    roster: [YUKI],
    messages: [
      msg("m1", "user", "Kevin", "u1", "do you still remember what we talked about?", 0),
      msg("m2", "waifu", "Yuki", "yuki-bot", "hmm remind me?", 15),
      msg("m3", "user", "Kevin", "u1", "the thing about the tea", 30)
    ],
    expect: {
      maxResponders: 1
    }
  },

  // ── 11. Note-worthy info dropped mid-chat ─────────────────────────────
  {
    key: "add-memory-trigger",
    description: "Kevin drops a memorable fact; the stage manager should call add_memory",
    roster: [YUKI, MIKA],
    messages: [
      msg("m1", "waifu", "Yuki", "yuki-bot", "so how's your internship going?", 0),
      msg("m2", "user", "Kevin", "u1", "honestly pretty rough, I got moved to a new team", 15),
      msg("m3", "user", "Kevin", "u1", "it's a data engineering role now, not what I signed up for", 25),
      msg("m4", "waifu", "Mika", "mika-bot", "that sounds annoying", 35),
      msg("m5", "user", "Kevin", "u1", "yeah it really is, been dealing with it for 3 weeks", 45)
    ],
    expect: {
      maxResponders: 2
    }
  },

  // ── 12. Channel-switch continuity ─────────────────────────────────────
  {
    key: "channel-switch-continuity",
    description: "A fact from a previous channel should carry over via retrieval into this channel's conversation",
    roster: [YUKI, MIKA],
    messages: [
      msg("m1", "user", "Kevin", "u1", "hey so what do you think about what I said earlier?", 0),
      msg("m2", "waifu", "Yuki", "yuki-bot", "you mean about moving teams?", 10),
      msg("m3", "user", "Kevin", "u1", "yeah exactly", 20),
      msg("m4", "waifu", "Mika", "mika-bot", "still sounds rough", 30)
    ],
    expect: {
      maxResponders: 2
    }
  }
];
