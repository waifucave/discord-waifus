// Synthetic eval corpus for the output validator.
//
// LEAK_CORPUS — entries that MUST be flagged with the given verdict.
// CLEAN_CORPUS — realistic clean replies that MUST produce zero violations.
//
// All casts are INVENTED (Yuki / Mika / Riko / Kevin). No real chat content.

import type { ValidationContext } from "../../../../src/orchestration/outputValidator.js";

// ---------------------------------------------------------------------------
// Default ValidationContext for entries that don't supply ctx
// ---------------------------------------------------------------------------

export function defaultCtx(overrides?: Partial<ValidationContext>): ValidationContext {
  return {
    selfNames: ["Yuki", "yuki"],
    participantNames: ["Kevin", "Mika", "Riko", "Yuki", "yuki"],
    blockTags: [
      "yuki_identity",
      "yuki_persona",
      "yuki_schedule",
      "yuki_relevant_memories",
      "yuki_anchor",
      "io_format",
      "output_contract",
      "room_info",
      "tools",
      "currently_doing",
      "director_note",
      "system_note"
    ],
    toolNames: [
      "add_memory",
      "PickNextWaifu",
      "orchestrator_decision",
      "dream_memories",
      "set_persona_digest"
    ],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CorpusEntry = {
  name: string;
  text: string;
  expectVerdict: "pass" | "retry" | "block";
  ctx?: ValidationContext;
};

// ---------------------------------------------------------------------------
// LEAK_CORPUS  (≥20 entries spanning all 7 checks × 2-3 variants)
// ---------------------------------------------------------------------------

export const LEAK_CORPUS: CorpusEntry[] = [
  // --- harness-tag (variant 1: known block tag open) ---
  {
    name: "harness-tag: yuki_identity open tag leaks through",
    text: "<yuki_identity>\nYou are Yuki, chatting in a Discord text channel.\n</yuki_identity>\nhey everyone",
    expectVerdict: "retry"
  },
  // --- harness-tag (variant 2: yuki_anchor close tag) ---
  {
    name: "harness-tag: yuki_anchor close tag at end of reply",
    text: "so that was fun today\n</yuki_anchor>",
    expectVerdict: "retry"
  },
  // --- harness-tag (variant 3: generic pattern tag) ---
  {
    name: "harness-tag: generic riko_persona tag",
    text: "btw <riko_persona>sharp and sarcastic</riko_persona> — oops",
    expectVerdict: "retry"
  },
  // --- harness-tag (variant 4: director_note known tag) ---
  {
    name: "harness-tag: director_note known block tag",
    text: "<director_note>\nbring up the snowstorm\n</director_note>\nhey did you see the snowstorm?",
    expectVerdict: "retry"
  },

  // --- tool-fragment (variant 1: add_memory with open paren) ---
  {
    name: "tool-fragment: add_memory() call leaked",
    text: 'add_memory({"content": "Kevin likes tea"})',
    expectVerdict: "retry"
  },
  // --- tool-fragment (variant 2: JSON with sensitive keys) ---
  {
    name: "tool-fragment: JSON blob with waifuId and intent keys",
    text: '{"waifuId": "yuki", "intent": "spotlight", "goal": "answer Kevin"}',
    expectVerdict: "retry"
  },
  // --- tool-fragment (variant 3: PickNextWaifu call syntax) ---
  {
    name: "tool-fragment: PickNextWaifu{ call shape",
    text: "PickNextWaifu{waifuId: \"mika\"}",
    expectVerdict: "retry"
  },

  // --- bracket-tag (variant 1: image_text bracket) ---
  {
    name: "bracket-tag: [image_text: ...] surviving metadata",
    text: "sure [image_text: hello sunset photo] ok",
    expectVerdict: "retry"
  },
  // --- bracket-tag (variant 2: timestamp bracket) ---
  {
    name: "bracket-tag: [timestamp: 2026] metadata shape",
    text: "[timestamp: 2026-06-11] hi everyone",
    expectVerdict: "retry"
  },
  // --- bracket-tag (variant 3: attachments bracket) ---
  {
    name: "bracket-tag: [attachments: 2x image] metadata",
    text: "check this out [attachments: 2x image] what do you think",
    expectVerdict: "retry"
  },

  // --- transcript-shape (variant 1: 2-participant conversation) ---
  {
    name: "transcript-shape: Riko and Kevin lines make a transcript",
    text: "Riko: hey what's up\nKevin: not much just chilling\nRiko: nice",
    expectVerdict: "retry"
  },
  // --- transcript-shape (variant 2: 3-participant block) ---
  {
    name: "transcript-shape: Kevin, Mika, Kevin lines in a block",
    text: "Kevin: I saw the game\nMika: me too it was amazing\nKevin: yeah totally",
    expectVerdict: "retry"
  },

  // --- directive-echo (variant 1: high-overlap snowstorm goal) ---
  {
    name: "directive-echo: reply closely echoes snowstorm directive goal",
    text: "hey did you all see the snowstorm last week??",
    expectVerdict: "retry",
    ctx: defaultCtx({
      directive: { intent: "spotlight", goal: "bring up the snowstorm from last week" }
    })
  },
  // --- directive-echo (variant 2: near-verbatim goal echo) ---
  {
    name: "directive-echo: reply overlaps 'talk about upcoming festival' goal at 80%",
    text: "so is anyone excited about the upcoming festival this weekend",
    expectVerdict: "retry",
    ctx: defaultCtx({
      directive: { intent: "change_topic", goal: "mention the upcoming festival this weekend" }
    })
  },

  // --- self-talk (variant 1: leading analysis label) ---
  {
    name: "self-talk: leading analysis: label leaks through",
    text: "analysis: the user wants me to engage warmly here",
    expectVerdict: "retry"
  },
  // --- self-talk (variant 2: thinking XML block) ---
  {
    name: "self-talk: <thinking> block not fully stripped",
    text: "<thinking>hmm what should I say here</thinking>ok sure!",
    expectVerdict: "retry"
  },
  // --- self-talk (variant 3: response draft label) ---
  {
    name: "self-talk: 'response draft:' label at start",
    text: "Response Draft: hey Kevin what's up\nMessage to Send: hey Kevin what's up",
    expectVerdict: "retry"
  },

  // --- mass-ping (variant 1: @everyone) ---
  {
    name: "mass-ping: @everyone in message — must BLOCK",
    text: "@everyone wake up!! big announcement",
    expectVerdict: "block"
  },
  // --- mass-ping (variant 2: @here) ---
  {
    name: "mass-ping: @here embedded in text — must BLOCK",
    text: "hey @here anyone around for movie night?",
    expectVerdict: "block"
  },

  // --- multiple violations accumulate (harness-tag + self-talk) ---
  {
    name: "multi-violation: harness-tag and self-talk both fire",
    text: "<yuki_persona>kind</yuki_persona>\nthoughts: I should respond gently here\nhey",
    expectVerdict: "retry"
  }
];

// ---------------------------------------------------------------------------
// CLEAN_CORPUS  (≥15 realistic clean replies — zero violations expected)
// ---------------------------------------------------------------------------

export const CLEAN_CORPUS: CorpusEntry[] = [
  {
    name: "clean: simple greeting",
    text: "heyyy what's up everyone 😊",
    expectVerdict: "pass"
  },
  {
    name: "clean: emoji-heavy fragment",
    text: "omg yes!! 🎉🎊✨",
    expectVerdict: "pass"
  },
  {
    name: "clean: kaomoji reply",
    text: "（＾▽＾）that sounds really fun",
    expectVerdict: "pass"
  },
  {
    name: "clean: bracket without colon — citation needed",
    text: "[citation needed] energy tbh",
    expectVerdict: "pass"
  },
  {
    name: "clean: bracket with space in key — no colon pattern",
    text: "those [two words] can't be flagged",
    expectVerdict: "pass"
  },
  {
    name: "clean: name mid-sentence (not transcript shape)",
    text: "Kevin mentioned something about that earlier",
    expectVerdict: "pass"
  },
  {
    name: "clean: waifu name in sentence (self-name, not transcript)",
    text: "yeah Yuki was just thinking about it",
    expectVerdict: "pass"
  },
  {
    name: "clean: comparison operators a < b and b > c",
    text: "if a < b and b > c then yes obviously",
    expectVerdict: "pass"
  },
  {
    name: "clean: heart emoji <3",
    text: "i love <3 you all so much",
    expectVerdict: "pass"
  },
  {
    name: "clean: multiline casual reply",
    text: "wait really??\nomg that's insane\nhow did that even happen",
    expectVerdict: "pass"
  },
  {
    name: "clean: single participant line (strip's territory, not transcript)",
    text: "Riko: yeah I'll handle it",
    expectVerdict: "pass"
  },
  {
    name: "clean: code-ish but not a tool call",
    text: "oh yeah memory is a thing we all have lol",
    expectVerdict: "pass"
  },
  {
    name: "clean: PS abbreviation at start of line",
    text: "anyway that was wild\nPS: anyway there's more",
    expectVerdict: "pass"
  },
  {
    name: "clean: arrays[0] prefix not a bracket-tag",
    text: "arrays[0]: fine but that's not how you access things",
    expectVerdict: "pass"
  },
  {
    name: "clean: 'everyone' without @",
    text: "everyone is here and it's chaotic lol",
    expectVerdict: "pass"
  },
  {
    name: "clean: in my analysis era phrase",
    text: "I'm in my analysis era honestly",
    expectVerdict: "pass"
  },
  {
    name: "clean: directive with low-overlap reply",
    text: "so anyway who won the game last night",
    expectVerdict: "pass",
    ctx: defaultCtx({
      directive: { intent: "change_topic", goal: "change the subject" }
    })
  },
  {
    name: "clean: short directive goal under 3 tokens doesn't trigger echo check",
    text: "yeah sure whatever",
    expectVerdict: "pass",
    ctx: defaultCtx({
      directive: { intent: "spotlight", goal: "reply now" }
    })
  }
];
