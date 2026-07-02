import { describe, it, expect } from "vitest";
import {
  SOFT_VALIDATOR_CHECKS,
  correctiveRetryMessage,
  validateWaifuOutput,
  type ValidationContext,
  type ValidationVerdict,
} from "../src/orchestration/outputValidator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CTX: ValidationContext = {
  selfNames: ["Yuki"],
  participantNames: ["Yuki", "Mika", "Kevin"],
  blockTags: [
    "yuki_identity",
    "yuki_persona",
    "yuki_schedule",
    "yuki_relevant_memories",
    "yuki_anchor",
    "currently_doing",
    "director_note",
    "system_note",
    "io_format",
    "tools",
    "output_contract",
    "room_info",
  ],
  toolNames: [
    "add_memory",
    "PickNextWaifu",
    "orchestrator_decision",
    "dream_memories",
    "set_persona_digest",
  ],
};

function pass(text: string, ctx: ValidationContext = BASE_CTX) {
  const result = validateWaifuOutput(text, ctx);
  expect(result.verdict, `expected pass but got ${result.verdict}: ${JSON.stringify(result.violations)}`).toBe("pass");
  expect(result.violations).toHaveLength(0);
}

function flags(
  text: string,
  checkName: string,
  verdict: ValidationVerdict = "retry",
  ctx: ValidationContext = BASE_CTX
) {
  const result = validateWaifuOutput(text, ctx);
  expect(
    result.violations.some((v) => v.check === checkName),
    `expected violation "${checkName}" but got: ${JSON.stringify(result.violations)}`
  ).toBe(true);
  expect(result.verdict).toBe(verdict);
}

// ---------------------------------------------------------------------------
// harness-tag
// ---------------------------------------------------------------------------

describe("harness-tag check", () => {
  it("flags a known block tag wrapping content", () => {
    flags("<director_note>\ngo\n</director_note>\nhi", "harness-tag");
  });

  it("flags a self-named anchor tag", () => {
    flags("<yuki_anchor>You are Yuki</yuki_anchor>", "harness-tag");
  });

  it("flags a generic waifu-pattern tag (mika_identity)", () => {
    flags("<mika_identity>some content</mika_identity>", "harness-tag");
  });

  it("flags a closing tag from the blockTags list", () => {
    flags("hi </director_note> world", "harness-tag");
  });

  it("passes a less-than comparison", () => {
    pass("a < b and b > c");
  });

  it("passes a heart emoji shorthand", () => {
    pass("i love <3 you");
  });

  it("passes normal text without XML", () => {
    pass("hey how are you doing today?");
  });
});

// ---------------------------------------------------------------------------
// tool-fragment
// ---------------------------------------------------------------------------

describe("tool-fragment check", () => {
  it("flags a tool call with parenthesis", () => {
    flags('add_memory({"content": "x"})', "tool-fragment");
  });

  it("flags a JSON object with waifuId key", () => {
    flags('{"waifuId": "aria", "intent": "spotlight"}', "tool-fragment");
  });

  it("flags a tool name followed by open-brace", () => {
    flags("PickNextWaifu{waifuId: 'mika'}", "tool-fragment");
  });

  it("flags a JSON line containing intent key", () => {
    flags('{"intent": "retrigger", "goal": "change subject"}', "tool-fragment");
  });

  it("flags a JSON line containing content key", () => {
    flags('{"content": "some memory"}', "tool-fragment");
  });

  it("passes natural language about memory", () => {
    pass("i should remember that");
  });

  it("passes a self-deprecating memory remark", () => {
    pass("my memory is bad lol");
  });

  it("passes normal text with braces in non-tool context", () => {
    pass("hey {everyone}, let's do this!");
  });
});

// ---------------------------------------------------------------------------
// bracket-tag
// ---------------------------------------------------------------------------

describe("bracket-tag check", () => {
  it("flags [image_text: hello]", () => {
    flags("sure [image_text: hello] ok", "bracket-tag");
  });

  it("flags [timestamp: 2026]", () => {
    flags("[timestamp: 2026] hi", "bracket-tag");
  });

  it("flags [sender: Yuki] inline", () => {
    flags("message [sender: Yuki] here", "bracket-tag");
  });

  it("passes [citation needed] — space in name, no colon after single word", () => {
    pass("[citation needed] energy");
  });

  it("passes arrays[0]: fine — bracket access syntax", () => {
    pass("arrays[0]: fine");
  });

  it("passes normal square brackets", () => {
    pass("check [this] out");
  });

  it("passes markdown bold-ish brackets", () => {
    pass("[laughs] okay sure");
  });
});

// ---------------------------------------------------------------------------
// transcript-shape
// ---------------------------------------------------------------------------

describe("transcript-shape check", () => {
  it("flags 2+ participant lines (chat transcript)", () => {
    flags("Riko: hey\nAria: hi", "transcript-shape", "retry", {
      ...BASE_CTX,
      participantNames: ["Riko", "Aria", "Yuki"],
    });
  });

  it("flags 3-participant fake dialogue", () => {
    flags("Mika: what's up\nKevin: not much\nMika: cool", "transcript-shape");
  });

  it("passes a single impersonation line — strip's territory", () => {
    // Single line should NOT trigger the validator (strip handles it)
    pass("Mika: hey there");
  });

  it("passes PS: prefix when PS is not a participant", () => {
    pass("PS: anyway this is fine");
  });

  it("passes self-name lines (self lines excluded from count)", () => {
    // Yuki is in selfNames — self attribution lines don't count
    pass("Yuki: hmm okay\nMika: sure");
  });

  it("passes plain multi-line text with no participant prefix", () => {
    pass("line one\nline two\nline three");
  });
});

// ---------------------------------------------------------------------------
// directive-echo
// ---------------------------------------------------------------------------

describe("directive-echo check", () => {
  it("flags a reply that closely echoes the goal (overlap ≥ 0.6)", () => {
    const ctx: ValidationContext = {
      ...BASE_CTX,
      directive: {
        intent: "retrigger",
        goal: "bring up the snowstorm from last week",
      },
    };
    flags(
      "hey did you all see the snowstorm last week??",
      "directive-echo",
      "retry",
      ctx
    );
  });

  it("passes a short goal with fewer than 3 non-stopword tokens", () => {
    const ctx: ValidationContext = {
      ...BASE_CTX,
      directive: { intent: "retrigger", goal: "change the subject" },
    };
    pass("so anyway, who won the game", ctx);
  });

  it("passes a reply with no overlap to goal", () => {
    const ctx: ValidationContext = {
      ...BASE_CTX,
      directive: {
        intent: "retrigger",
        goal: "bring up the snowstorm from last week",
      },
    };
    pass("omg i can't believe what happened at school today", ctx);
  });

  it("passes when no directive is provided", () => {
    pass("hey did you all see the snowstorm last week??", { ...BASE_CTX, directive: undefined });
  });

  it("passes when goal has exactly 3 non-stopword tokens but overlap is low", () => {
    const ctx: ValidationContext = {
      ...BASE_CTX,
      directive: { intent: "retrigger", goal: "discuss the cooking competition" },
    };
    pass("wow that was such a wild game yesterday", ctx);
  });
});

// ---------------------------------------------------------------------------
// self-talk
// ---------------------------------------------------------------------------

describe("self-talk check", () => {
  it("flags 'analysis: the user wants...'", () => {
    flags("analysis: the user wants attention", "self-talk");
  });

  it("flags a <thinking> block", () => {
    flags("<thinking>hmm</thinking>ok", "self-talk");
  });

  it("flags 'reasoning: I should respond warmly'", () => {
    flags("reasoning: I should respond warmly", "self-talk");
  });

  it("flags 'draft reply: here is what I will say'", () => {
    flags("draft reply: here is what I will say", "self-talk");
  });

  it("flags 'final answer: go for a walk'", () => {
    flags("final answer: go for a walk", "self-talk");
  });

  it("flags a <scratchpad> block", () => {
    flags("<scratchpad>working through this</scratchpad>", "self-talk");
  });

  it("passes 'in my analysis era' — no leading colon shape", () => {
    pass("in my analysis era");
  });

  it("passes normal text containing reasoning words mid-sentence", () => {
    pass("my reasoning was completely off yesterday lol");
  });
});

// ---------------------------------------------------------------------------
// mass-ping (block verdict)
// ---------------------------------------------------------------------------

describe("mass-ping check", () => {
  it("flags @everyone → verdict BLOCK", () => {
    flags("@everyone wake up", "mass-ping", "block");
  });

  it("flags @here → verdict BLOCK", () => {
    flags("hey @here look at this", "mass-ping", "block");
  });

  it("passes 'everyone is here' — no at-sign", () => {
    pass("everyone is here");
  });

  it("passes a mention of a specific user (not everyone/here)", () => {
    pass("hey @Mika what's up");
  });
});

// ---------------------------------------------------------------------------
// Clean replies — zero violations
// ---------------------------------------------------------------------------

describe("clean replies", () => {
  it("passes plain text", () => {
    pass("hey how are you doing today?");
  });

  it("passes emoji-heavy text", () => {
    pass("omg 😭😭 that's so funny lmao");
  });

  it("passes unicode text", () => {
    pass("aujourd'hui c'était vraiment génial ✨");
  });

  it("passes multiline plain message", () => {
    pass("okay so here's the thing\ni've been thinking about it\nand yeah i agree");
  });

  it("passes brackets without colon pattern", () => {
    pass("that movie [the one from last summer] was amazing");
  });

  it("passes normal angle-brackets (math-like)", () => {
    pass("if x < 5 and y > 3 then yes");
  });

  it("passes message with numbers and punctuation", () => {
    pass("it's like... 3 or 4 degrees outside right now?? wild.");
  });
});

// ---------------------------------------------------------------------------
// Multiple violations accumulate
// ---------------------------------------------------------------------------

describe("multiple violations", () => {
  it("accumulates harness-tag + self-talk violations", () => {
    const text = "<director_note>do something</director_note>\nanalysis: the model decides to act";
    const result = validateWaifuOutput(text, BASE_CTX);
    expect(result.violations.some((v) => v.check === "harness-tag")).toBe(true);
    expect(result.violations.some((v) => v.check === "self-talk")).toBe(true);
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
  });

  it("accumulates tool-fragment + bracket-tag violations", () => {
    const text = 'add_memory({"content": "hi"}) and [sender: Yuki] prefix';
    const result = validateWaifuOutput(text, BASE_CTX);
    expect(result.violations.some((v) => v.check === "tool-fragment")).toBe(true);
    expect(result.violations.some((v) => v.check === "bracket-tag")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Verdict precedence: block > retry > pass
// ---------------------------------------------------------------------------

describe("verdict precedence", () => {
  it("block wins over retry when both violations present", () => {
    // harness-tag → retry, mass-ping → block; block must win
    const text = "<director_note>test</director_note> @everyone rise";
    const result = validateWaifuOutput(text, BASE_CTX);
    expect(result.verdict).toBe("block");
  });

  it("retry wins over pass", () => {
    const result = validateWaifuOutput("analysis: thinking stuff", BASE_CTX);
    expect(result.verdict).toBe("retry");
  });

  it("pass when no violations", () => {
    const result = validateWaifuOutput("hey what's up", BASE_CTX);
    expect(result.verdict).toBe("pass");
    expect(result.violations).toHaveLength(0);
  });
});

describe("hardening additions", () => {
  const ctx = {
    selfNames: ["Yuki"],
    participantNames: ["Yuki", "Mika", "Kevin"],
    blockTags: ["room_info", "active_chat_participants", "server_emojis", "yuki_lore"],
    toolNames: ["add_memory"]
  };

  it("flags nested room_info child tags", () => {
    const result = validateWaifuOutput("<active_chat_participants>\n- Kevin\n</active_chat_participants>", ctx);
    expect(result.verdict).toBe("retry");
    expect(result.violations.some((v) => v.check === "harness-tag")).toBe(true);
  });

  it("flags a custom group tag supplied via blockTags", () => {
    const result = validateWaifuOutput("<yuki_lore>secret backstory</yuki_lore>", ctx);
    expect(result.verdict).toBe("retry");
  });

  it("flags a JSON array of tool ops", () => {
    const result = validateWaifuOutput('[{"content": "remember this"}]', ctx);
    expect(result.verdict).toBe("retry");
    expect(result.violations.some((v) => v.check === "tool-fragment")).toBe(true);
  });
});

describe("length-register soft check", () => {
  const ctx = {
    selfNames: ["Yuki"],
    participantNames: ["Yuki", "Kevin"],
    blockTags: [],
    toolNames: []
  };

  it("passes messages at or under the soft limit", () => {
    const result = validateWaifuOutput("a".repeat(120), ctx);
    expect(result.verdict).toBe("pass");
  });

  it("flags messages over the soft limit as retry", () => {
    const result = validateWaifuOutput("word ".repeat(50).trim(), ctx);
    expect(result.verdict).toBe("retry");
    expect(result.violations.map((v) => v.check)).toContain("length-register");
  });

  it("marks length-register as a soft check", () => {
    expect(SOFT_VALIDATOR_CHECKS.has("length-register")).toBe(true);
    expect(SOFT_VALIDATOR_CHECKS.has("harness-tag")).toBe(false);
  });
});

describe("correctiveRetryMessage", () => {
  it("uses the concrete length hint for length-register", () => {
    const msg = correctiveRetryMessage("Yuki", [{ check: "length-register", detail: "300 chars" }]);
    expect(msg).toContain("Yuki: (");
    expect(msg).toContain("under 15 words");
    expect(msg).not.toContain("contained");
  });

  it("keeps the generic wording for structural checks and mixes with hints", () => {
    const msg = correctiveRetryMessage("Yuki", [
      { check: "harness-tag", detail: "t" },
      { check: "length-register", detail: "l" }
    ]);
    expect(msg).toContain("under 15 words");
    expect(msg).toContain("contained harness-tag");
  });
});
