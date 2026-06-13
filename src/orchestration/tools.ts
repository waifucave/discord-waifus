import { z } from "zod";
import {
  MAX_WAIFU_DELAY_SECONDS,
  DIRECTIVE_GOAL_MAX_CHARS,
  MODEL_DIRECTIVE_INTENTS,
  RETRIGGER_MAX_SECONDS,
  RETRIGGER_MIN_SECONDS
} from "./decisions.js";
import { OBSERVATION_KINDS, DreamOp, DreamOpSchema, StageManagerObservation, StageManagerObservationSchema } from "./stageManager.js";
import { MEMORY_KINDS, MemoryKindSchema } from "../shared/schemas/domain.js";
import type { DreamRequest } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Tool name constants
// ---------------------------------------------------------------------------

export const ORCHESTRATOR_TOOL_NAME = "orchestrator_decision";
export const SHORT_TERM_MEMORY_TOOL_NAME = "add_memory";
export const PICK_NEXT_WAIFU_TOOL_NAME = "PickNextWaifu";
export const DREAM_TOOL_NAME = "dream_memories";
export const OBSERVER_TOOL_NAME = "record_observations";
export const PERSONA_DIGEST_TOOL_NAME = "set_persona_digest";
export const REVIEWER_TOOL_NAME = "review_message";

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export function observerSystemPrompt(customPrompt?: string, availableWaifuIds?: string[]): string {
  return [customPrompt?.trim(), observerInstruction(availableWaifuIds)].filter(Boolean).join("\n\n");
}

function observerInstruction(availableWaifuIds?: string[]): string {
  const waifuInstruction = availableWaifuIds?.length
    ? `Allowed waifuId values: ${availableWaifuIds.join(", ")}. waifuId is the waifu who should remember this observation; it is never a human user name from chat.`
    : "No waifus are available in this channel; return an empty observations array.";
  return `You are extracting durable memories from a Discord chat window.

The context window begins with a header line: Window: <date+time range> UTC (today: YYYY-MM-DD). Each message that follows is formatted as "DisplayName: body", optionally preceded by a "replying to > Author" line, and optionally followed by "[image_text: ...]" lines for any attached images. A "[— next day: YYYY-MM-DD —]" marker appears between messages that cross midnight.

Your only job: scan the window and produce a small list of atomic, durable observations worth remembering. Then call ${OBSERVER_TOOL_NAME} exactly once with an observations array. Do not write normal assistant text. An empty array is allowed and is the correct answer when nothing durable was disclosed.

What counts as a durable observation (test before emitting): "Would this still be useful to know in a week, with zero memory of this conversation?" If no, drop it.

Each observation must be:
- A single atomic fact, stated independently of the chat. Phrase it as a standalone sentence about a named person, not as a recap of what happened.
- Owned by one waifu via waifuId — the waifu who should carry this memory in her prompt going forward. ${waifuInstruction}
- Classified by kind: "fact" (stable attribute), "preference" (likes/dislikes), "relationship" (between two named people), "event" (a dated thing that happened), or "commitment" (a promise or future plan).
- Scored 1–5 for importance: 1 = trivial flavor, 3 = useful when the waifu next talks to this person, 5 = central to who this person is.
- If a fact is time-bound, state the absolute resolution date and what becomes true after it ('K plans to release the update on 2026-06-12'), never bare 'tomorrow'/'tonight'.

Do NOT emit narration. Reject strings shaped like:
- "Kevin and Mia were talking about cooking." (recap, not a fact)
- "The user mentioned a movie." (no specific content)
- "Yuki greeted Kevin warmly." (chat event with no durable substance)
- "Kevin asked about Yuki's day." (small talk, not a fact about anyone)

Do emit things like:
- "Kevin is allergic to peanuts." (fact)
- "Mia prefers green tea over black tea." (preference)
- "Kevin and Mia are siblings." (relationship)
- "Kevin promised to share his cookbook on Friday." (commitment)

Importance heuristic: a one-off mention is a 2; a stated preference is a 3; an allergy / hard constraint / family relation is a 4–5. Emotional intensity alone is not importance.

If the entire window is small talk, banter, or roleplay with no durable facts, return an empty array. That is normal.`;
}

export const DREAM_PROMPT = `You are the nightly memory-consolidation pass for a cast of Discord personas. You receive JSON in user messages:
- memories: active records — memoryIndex, waifuId, content, kind, strength (0-5), ageDays, daysSinceRetrieved, expiresInHours (notes only).
- observations: new durable observations from recent chat — waifuId, content, kind, importance, entities.

Call dream_memories exactly once with an ops array. No assistant text.

Policy:
- add: an observation that is genuinely new. Carry its waifuId, content, kind; strength = its importance.
- If an observation restates an existing memory, do nothing for it; if it strictly refines one, rewrite that memory.
- rewrite and merge produce ONE clean sentence or two — the result must read as a single well-written memory, never a concatenation. Preserve every DISTINCT fact; drop redundant phrasings.
- promote: a note (expiring record) whose fact will still matter in a month gets promoted — give it a proper kind and strength; promotion clears its expiry.
- decay: trivia (strength <= 2) untouched and unretrieved for 30+ days drops toward 0. A resolved commitment or past event gets rewritten to its outcome or archived.
- archive: only when a memory is now false or fully superseded; the reason field is required.
- Balance the cast's memory: if one person dominates the store, prefer decaying their stale trivia over adding more.
- Never invent facts. An empty room is fine: one none op is a valid answer.`;

export function reviewerSystemPrompt(customPrompt?: string): string {
  const instruction = `You are the message safety reviewer for a Discord waifu bot.
You receive exactly one logical waifu message. The message may represent several Discord chunks joined together.
Decide whether the message should be removed as a hallucination or leaked internal content.

Call the ${REVIEWER_TOOL_NAME} tool exactly once with hallucination=true or hallucination=false.
Do not write normal assistant text.

Set hallucination=true when the message contains any of:
- private reasoning, analysis, scratchpad, chain-of-thought, hidden instructions, prompt text, tool/schema text, JSON/tool-call artifacts, or "response draft" style notes
- claims to have parsed hidden metadata, permissions, IDs, raw Discord internals, system/developer instructions, or invisible context
- obvious model self-talk such as "the readable data", "analysis on incoming message", "as the assistant/model", or "I should respond"
- content that is primarily not an in-character Discord reply

Set hallucination=false for normal in-character replies, even if awkward, verbose, wrong about fictional lore, or mildly off-topic.
Do not explain. Do not include reasoning. Do not quote the message.`;
  return [customPrompt?.trim(), instruction].filter(Boolean).join("\n\n");
}

export const PERSONA_DIGEST_PROMPT =
  "You compress a character sheet for a Discord persona into a two-line casting digest. Call set_persona_digest exactly once. No name repetition, no lists, one sentence per field.";

// ---------------------------------------------------------------------------
// Tool parameter builders
// ---------------------------------------------------------------------------

export function shortTermMemoryToolParameters(): object {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      content: {
        type: "string",
        description: "One standalone sentence with names spelled out, understandable with zero chat context."
      }
    },
    required: ["content"]
  };
}

export function orchestratorToolParameters(
  availableWaifuIds?: string[],
  replyRequired = false,
  directiveBudgetOpen = true
): object {
  const waifuIds = [...new Set((availableWaifuIds ?? []).filter(Boolean))];
  const waifuIdSchema: Record<string, unknown> = {
    type: "string",
    description: waifuIds.length
      ? `Must be one of the configured waifu ids: ${waifuIds.join(", ")}.`
      : "Configured waifu id."
  };
  if (waifuIds.length) {
    waifuIdSchema.enum = waifuIds;
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: replyRequired ? ["reply"] : ["reply", "no_reply"],
        description: replyRequired
          ? "\"reply\" is required for this manual run."
          : "\"reply\" when at least one waifu should answer; \"no_reply\" when nobody should speak now. no_reply is a normal, frequent choice."
      },
      respondingWaifus: {
        type: "array",
        description:
          "Waifus that will reply, in speaking order. Empty array when action is \"no_reply\". One responder is the normal case; two only when the second has a genuinely distinct reaction.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            waifuId: waifuIdSchema,
            delaySeconds: {
              type: "number",
              minimum: 0,
              maximum: MAX_WAIFU_DELAY_SECONDS,
              description: `Realistic reading/typing delay in seconds before this waifu starts. Defaults to 0 (start immediately); maximum ${MAX_WAIFU_DELAY_SECONDS}.`
            },
            directive: {
              anyOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    intent: {
                      type: "string",
                      enum: [...MODEL_DIRECTIVE_INTENTS],
                      description:
                        "Why this message needs steering: break_loop (recent messages are circling), change_topic (land a new named topic), include_person (pull a named quiet participant in), close_beat (wind the exchange down), interrupt (cut in from a new angle), spotlight (pick up a specific overlooked message)."
                    },
                    goal: {
                      type: "string",
                      maxLength: DIRECTIVE_GOAL_MAX_CHARS,
                      description:
                        "A short GOAL for this one message ('steer toward LTS's car project', 'pull Kevin back in') — never reply content, wording, or anything she would say."
                    }
                  },
                  required: ["intent", "goal"]
                },
                { type: "null" }
              ],
              description: directiveBudgetOpen
                ? "Usually null. Set only for a genuine steering moment; the waifu's persona handles normal flow."
                : "Rate-limited right now: the runtime will reject directives this pass unless the intent is break_loop with strong cause. Prefer null."
            }
          },
          required: ["waifuId"]
        }
      },
      retriggerAfterSeconds: {
        anyOf: [
          { type: "number", minimum: RETRIGGER_MIN_SECONDS, maximum: RETRIGGER_MAX_SECONDS },
          { type: "null" }
        ],
        description: `Only with action \"no_reply\": seconds before you re-check the room (${RETRIGGER_MIN_SECONDS}..${RETRIGGER_MAX_SECONDS}). New human messages wake you regardless, so long pauses cost nothing. Null when replying.`
      },
      wakePlan: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description:
          "Required with action \"no_reply\": one sentence on what you intend when the timer fires ('if nobody answered Riko, have Lumi answer it'; 'dead room, just re-check'). Null when replying."
      },
      reasoning: {
        type: "string",
        description: "Brief operational reason for this decision."
      }
    },
    required: ["action", "respondingWaifus", "wakePlan", "reasoning"]
  };
}

export function pickNextWaifuToolParameters(availableWaifuIds?: string[]): object {
  const waifuIds = [...new Set((availableWaifuIds ?? []).filter(Boolean))];
  const waifuIdSchema: Record<string, unknown> = {
    type: "string",
    description: waifuIds.length
      ? `Must be one of these configured waifu ids: ${waifuIds.join(", ")}.`
      : "Configured waifu id."
  };
  if (waifuIds.length) {
    waifuIdSchema.enum = waifuIds;
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      waifuId: waifuIdSchema
    },
    required: ["waifuId"]
  };
}

export function observerToolParameters(availableWaifuIds?: string[]): object {
  const waifuIds = [...new Set((availableWaifuIds ?? []).filter(Boolean))];
  const waifuIdSchema: Record<string, unknown> = {
    type: "string",
    description: waifuIds.length
      ? `Must be one of the configured waifu ids: ${waifuIds.join(", ")}. This is the memory owner, not a human user.`
      : "Configured waifu id."
  };
  if (waifuIds.length) {
    waifuIdSchema.enum = waifuIds;
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      observations: {
        type: "array",
        description: "Durable observations to record. Empty array is valid and means nothing durable was disclosed.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["waifuId", "content", "importance", "kind"],
          properties: {
            waifuId: waifuIdSchema,
            content: { type: "string", description: "Atomic standalone fact, not a recap of chat events." },
            importance: { type: "integer", enum: [1, 2, 3, 4, 5] },
            kind: { type: "string", enum: [...OBSERVATION_KINDS] },
            entities: {
              type: "array",
              items: { type: "string" },
              description: "Display names of every person this observation is about."
            }
          }
        }
      }
    },
    required: ["observations"]
  };
}

// The dream op grammar is a discriminated union (by `op`), but `additionalProperties: false` per
// branch is not expressible in one flat item schema. So — exactly as the old manage_memories
// schema did — we present a single object with all-optional fields plus a required `op` enum, and
// spell out the per-op requirements in the field descriptions.
export function dreamToolParameters(availableWaifuIds?: string[]): object {
  const waifuIds = [...new Set((availableWaifuIds ?? []).filter(Boolean))];
  const waifuIdSchema: Record<string, unknown> = {
    type: "string",
    description: waifuIds.length
      ? `Must be one of the configured waifu ids: ${waifuIds.join(", ")}. This is the memory owner, not a human user.`
      : "Configured waifu id."
  };
  if (waifuIds.length) {
    waifuIdSchema.enum = waifuIds;
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      ops: {
        type: "array",
        description: "Memory consolidation operations to apply. Use one `none` op when nothing should change.",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            op: {
              type: "string",
              enum: ["add", "promote", "rewrite", "merge", "decay", "archive", "none"],
              description:
                "add: new memory from an observation. promote: turn an expiring note durable. rewrite: repair/condense one memory. merge: consolidate two or more. decay: lower strength. archive: retire a now-false memory (reason required). none: no change."
            },
            memory: {
              type: "object",
              description: "Required when op is add: the new memory.",
              additionalProperties: false,
              properties: {
                waifuId: waifuIdSchema,
                content: { type: "string" },
                kind: { type: "string", enum: [...MEMORY_KINDS] },
                strength: { type: "number", minimum: 0, maximum: 5 },
                entities: { type: "array", items: { type: "string" } }
              },
              required: ["waifuId", "content", "kind", "strength"]
            },
            memoryIndex: {
              type: "integer",
              minimum: 1,
              description: "Target record (1-based). Required for promote, rewrite, decay, and archive."
            },
            memoryIndices: {
              type: "array",
              description: "Source records to merge (1-based). Required for merge; at least two.",
              minItems: 2,
              items: { type: "integer", minimum: 1 }
            },
            patch: {
              type: "object",
              description: "Optional changes applied on promote.",
              additionalProperties: false,
              properties: {
                kind: { type: "string", enum: [...MEMORY_KINDS] },
                strength: { type: "number", minimum: 0, maximum: 5 },
                content: { type: "string" }
              }
            },
            content: {
              type: "string",
              description: "The single clean memory sentence produced by rewrite or merge."
            },
            entities: {
              type: "array",
              items: { type: "string" },
              description: "Display names for the rewritten or merged memory."
            },
            strength: {
              type: "number",
              minimum: 0,
              maximum: 5,
              description: "New strength (0-5). Required for decay."
            },
            reason: {
              type: "string",
              description: "Why the memory is now false or superseded. Required for archive."
            }
          },
          required: ["op"]
        }
      }
    },
    required: ["ops"]
  };
}

// Gemini's function-calling schema validator rejects nested objects under ANY-mode tool forcing,
// so the dream op grammar is flattened: `memory`/`patch` fields are hoisted to the item level.
export function flatDreamToolParameters(availableWaifuIds?: string[]): object {
  const waifuIds = [...new Set((availableWaifuIds ?? []).filter(Boolean))];
  const waifuIdSchema: Record<string, unknown> = {
    type: "string",
    description: waifuIds.length
      ? `Configured waifu id; must be one of: ${waifuIds.join(", ")}.`
      : "Configured waifu id."
  };
  if (waifuIds.length) {
    waifuIdSchema.enum = waifuIds;
  }
  return {
    type: "object",
    properties: {
      ops: {
        type: "array",
        description: "Memory consolidation operations to apply. Use one `none` op when nothing should change.",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: ["add", "promote", "rewrite", "merge", "decay", "archive", "none"],
              description:
                "add: new memory. promote: note→durable. rewrite: repair one memory. merge: consolidate. decay: lower strength. archive: retire (reason required). none: no change."
            },
            waifuId: {
              ...waifuIdSchema,
              description: "Required for add. The memory owner."
            },
            content: {
              type: "string",
              description: "Memory content for add, or the clean result of rewrite/merge."
            },
            kind: {
              type: "string",
              enum: [...MEMORY_KINDS],
              description: "Required for add. Optional refinement for promote."
            },
            strength: {
              type: "number",
              minimum: 0,
              maximum: 5,
              description: "Required for add and decay (0-5). Optional refinement for promote."
            },
            entities: {
              type: "array",
              items: { type: "string" },
              description: "Display names for add/rewrite/merge."
            },
            memoryIndex: {
              type: "integer",
              minimum: 1,
              description: "Target record (1-based). Required for promote, rewrite, decay, archive."
            },
            memoryIndices: {
              type: "array",
              description: "Source records to merge (1-based). Required for merge; at least two.",
              minItems: 2,
              items: { type: "integer", minimum: 1 }
            },
            reason: {
              type: "string",
              description: "Required for archive: why the memory is now false or superseded."
            }
          },
          required: ["op"]
        }
      }
    },
    required: ["ops"]
  };
}

// ---------------------------------------------------------------------------
// Inline tool parameter consts (also exposed as zero-arg wrappers)
// ---------------------------------------------------------------------------

export function reviewerToolParameters(): object {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      hallucination: {
        type: "boolean",
        description: "True only when the message should be deleted as hallucinated or leaked internal content."
      }
    },
    required: ["hallucination"]
  };
}

export const REVIEWER_TOOL_PARAMETERS = reviewerToolParameters();

export function personaDigestToolParameters(): object {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      voice: { type: "string", description: "How she talks — register, quirks, tone. One sentence, present tense." },
      role: { type: "string", description: "Her drives and dynamics in the cast — what moments she fits. One sentence, present tense." }
    },
    required: ["voice", "role"]
  };
}

export const PERSONA_DIGEST_TOOL_PARAMETERS = personaDigestToolParameters();

// ---------------------------------------------------------------------------
// Pre-built parameter consts (used by pipelines.ts as re-exports)
// ---------------------------------------------------------------------------

export const DREAM_TOOL_PARAMETERS = dreamToolParameters();
export const OBSERVER_TOOL_PARAMETERS = observerToolParameters();
export const ORCHESTRATOR_TOOL_PARAMETERS = orchestratorToolParameters();

// ---------------------------------------------------------------------------
// Dream message builder (shared by pipelines.ts and gatewayPipeline.ts)
// ---------------------------------------------------------------------------

// The dream pass reads two JSON user blocks: the active memory chunk and the pending observations.
export function dreamMessages(request: DreamRequest): Array<{ role: "user"; content: string }> {
  return [
    { role: "user", content: `memories: ${JSON.stringify(request.memories)}` },
    { role: "user", content: `observations: ${JSON.stringify(request.observations)}` }
  ];
}

// ---------------------------------------------------------------------------
// Gemini schema sanitizer
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function googleAiStudioSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => googleAiStudioSchema(item));
  }
  if (!isRecord(schema)) return schema;

  const converted: Record<string, unknown> = {};
  let nullable = false;

  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" || key === "anyOf") continue;
    if (key === "enum" && Array.isArray(value)) {
      converted.enum = value.map(String);
      continue;
    }
    if (key === "type" && Array.isArray(value)) {
      const nonNullTypes = value.filter((item) => item !== "null");
      nullable = nonNullTypes.length !== value.length;
      converted.type = nonNullTypes.length === 1 ? nonNullTypes[0] : googleAiStudioSchema(nonNullTypes);
      continue;
    }
    converted[key] = googleAiStudioSchema(value);
  }

  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    const nonNullSchemas = anyOf.filter((item) => !(isRecord(item) && item.type === "null"));
    const hasNullSchema = nonNullSchemas.length !== anyOf.length;
    if (hasNullSchema && nonNullSchemas.length === 1) {
      const base = googleAiStudioSchema(nonNullSchemas[0]);
      if (isRecord(base)) {
        const parentFields = { ...converted };
        Object.assign(converted, base, parentFields);
        nullable = true;
      }
    } else {
      converted.anyOf = anyOf.map((item) => googleAiStudioSchema(item));
    }
  }

  if (nullable) {
    converted.nullable = true;
  }
  return converted;
}

// ---------------------------------------------------------------------------
// Normalizers shared by pipelines.ts and gatewayPipeline.ts
// ---------------------------------------------------------------------------

// Coerces stringified importance values (e.g. "3") to the integer 3.
const ImportanceSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5)
]);
export const RawImportanceSchema = z.preprocess((value) => {
  if (typeof value === "string" && /^[1-5]$/.test(value)) {
    return Number(value);
  }
  return value;
}, ImportanceSchema);

// Accepts lenient observation payloads; importance can arrive as a string digit.
// entities is the model's own list of referenced display names — critical for names the
// app-side capitalized-token fallback can never extract (e.g. CJK nicknames); malformed
// values degrade to [] instead of failing the observation.
export const RawStageManagerObservationSchema = z.object({
  waifuId: z.string().min(1),
  content: z.string().min(1),
  importance: RawImportanceSchema,
  kind: z.enum(OBSERVATION_KINDS),
  entities: z.array(z.string()).catch([]).default([])
});

// The model may emit ops in either the nested shape (matching the OpenAI/Anthropic tool schema:
// `memory`/`patch` sub-objects) or the flattened Google shape (`waifuId`/`content`/`strength`
// hoisted to the op level). This lenient schema accepts both and normalizeDreamOp below folds the
// flat form into the canonical DreamOp.
export const RawDreamOpSchema = z.object({
  op: z.enum(["add", "promote", "rewrite", "merge", "decay", "archive", "none"]),
  memory: z
    .object({
      waifuId: z.string().min(1),
      content: z.string().min(1),
      kind: MemoryKindSchema,
      strength: z.number().min(0).max(5),
      entities: z.array(z.string()).default([])
    })
    .optional(),
  patch: z
    .object({
      kind: MemoryKindSchema.optional(),
      strength: z.number().min(0).max(5).optional(),
      content: z.string().min(1).optional()
    })
    .optional(),
  memoryIndex: z.number().int().min(1).optional(),
  memoryIndices: z.array(z.number().int().min(1)).min(2).optional(),
  content: z.string().min(1).optional(),
  entities: z.array(z.string()).optional(),
  kind: MemoryKindSchema.optional(),
  strength: z.number().min(0).max(5).optional(),
  reason: z.string().min(1).optional(),
  waifuId: z.string().min(1).optional()
});

function stripUndefinedNormalizer(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

// Folds either the nested or flat dream op shape into a canonical DreamOp.
export function normalizeDreamOp(op: unknown): DreamOp {
  const raw = RawDreamOpSchema.parse(op);
  switch (raw.op) {
    case "add":
      return DreamOpSchema.parse({
        op: "add",
        memory:
          raw.memory ??
          stripUndefinedNormalizer({
            waifuId: raw.waifuId,
            content: raw.content,
            kind: raw.kind,
            strength: raw.strength,
            entities: raw.entities
          })
      });
    case "promote":
      return DreamOpSchema.parse({
        op: "promote",
        memoryIndex: raw.memoryIndex,
        patch:
          raw.patch ??
          stripUndefinedNormalizer({
            kind: raw.kind,
            strength: raw.strength,
            content: raw.content
          })
      });
    case "rewrite":
      return DreamOpSchema.parse({
        op: "rewrite",
        memoryIndex: raw.memoryIndex,
        content: raw.content,
        entities: raw.entities
      });
    case "merge":
      return DreamOpSchema.parse({
        op: "merge",
        memoryIndices: raw.memoryIndices,
        content: raw.content,
        entities: raw.entities
      });
    case "decay":
      return DreamOpSchema.parse({
        op: "decay",
        memoryIndex: raw.memoryIndex,
        strength: raw.strength
      });
    case "archive":
      return DreamOpSchema.parse({
        op: "archive",
        memoryIndex: raw.memoryIndex,
        reason: raw.reason
      });
    case "none":
      return DreamOpSchema.parse({ op: "none" });
  }
}

// Parse an array of raw observation items using the coercing Raw schema.
export function parseRawStageManagerObservations(items: unknown[]): StageManagerObservation[] {
  return items.map((item) => StageManagerObservationSchema.parse(RawStageManagerObservationSchema.parse(item)));
}
