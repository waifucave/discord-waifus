import { z } from "zod";
import {
  MAX_WAIFU_DELAY_SECONDS,
  DIRECTIVE_GOAL_MAX_CHARS,
  MODEL_DIRECTIVE_INTENTS,
  RETRIGGER_MAX_SECONDS,
  RETRIGGER_MIN_SECONDS,
  OrchestratorActionSchema,
  OrchestratorDecision,
  OrchestratorDecisionSchema,
  Directive
} from "./decisions.js";
import { OBSERVATION_KINDS, DreamOp, DreamOpSchema, ObserverOp, ObserverOpSchema, StageManagerObservation, StageManagerObservationSchema } from "./stageManager.js";
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
// Reviewer decision schema
// ---------------------------------------------------------------------------

export const ReviewerDecisionSchema = z.object({
  hallucination: z.boolean()
});

export type ReviewerDecision = z.infer<typeof ReviewerDecisionSchema>;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export function observerSystemPrompt(customPrompt?: string, availableWaifuIds?: string[]): string {
  return [customPrompt?.trim(), observerInstruction(availableWaifuIds)].filter(Boolean).join("\n\n");
}

function observerInstruction(availableWaifuIds?: string[]): string {
  const waifuInstruction = availableWaifuIds?.length
    ? `Allowed waifuId values: ${availableWaifuIds.join(", ")}. waifuId is the waifu who should carry the memory; it is never a human.`
    : "No waifus are available in this channel; return an empty ops array.";
  return `You maintain the long-term memories of a cast of Discord characters (waifus). Each waifu has one memory that follows her across every server and private chat.

The user message has three parts:
- Participants: everyone in this chat, as handles. Humans are p1, p2, …; waifus are w:<waifuId>.
- Existing memories: what the waifus already remember about these participants, as m1, m2, … with owner, kind and strength. Pinned memories are user-managed and read-only.
- Transcript: the messages since your last read, "[HH:MM] Name (handle): text". You never see a message twice.

Call ${OBSERVER_TOOL_NAME} exactly once with an ops array. No assistant text. An empty array is the correct answer when nothing durable was said.

Ops:
- add: a new durable memory. waifuId = the owner. ${waifuInstruction} content = one standalone sentence with names spelled out. kind = fact | preference | relationship | event | commitment. importance 1-5. subjects = handles of the people (or waifus) it is about.
- update: an existing memory (memory: "m3") is now more precise or has changed: give the full corrected sentence. Use this instead of adding a near-duplicate.
- merge: two or more existing memories of the same owner say the same thing: into = the one to keep, from = the others, content = one clean combined sentence.
- expire: an existing memory is now false or resolved (a plan that happened, a preference that changed). Give a short reason.

The durability test for add and update: "Would this still be useful to know in a week, with zero memory of this conversation?" If no, drop it.

Each memory must be a single atomic fact about named people, never a recap of the chat. If a fact is time-bound, state the absolute date ('Kevin plans to release the update on 2026-06-12'), never bare 'tomorrow' or 'tonight'.

Do NOT write narration such as:
- "Kevin and Mia were talking about cooking." (recap, not a fact)
- "The user mentioned a movie." (no specific content)
- "Yuki greeted Kevin warmly." (chat event with no durable substance)

Do write things like:
- "Kevin is allergic to peanuts." (fact, subjects [p1])
- "Mia prefers green tea over black tea." (preference)
- "Kevin and Mia are siblings." (relationship, subjects [p1, p2])
- "Kevin promised Yuki to share his cookbook on 2026-10-30." (commitment, subjects [p1, w:yuki])

Importance: a one-off mention is a 2; a stated preference is a 3; an allergy, hard constraint or family relation is a 4-5. Emotional intensity alone is not importance.

Roleplay, banter and small talk are normal; most windows produce no ops at all.`;
}

export const DREAM_PROMPT = `You are the nightly memory-consolidation pass for a cast of Discord personas. You receive JSON in user messages:
- memories: active records — memoryIndex, waifuId, content, kind, strength (0-5), ageDays, daysSinceRetrieved, expiresInHours (notes only).
- observations: new durable observations from recent chat — waifuId, content, kind, importance, subjects (names).
Memory items also carry subjects: the names of the people each memory is about.

Call dream_memories exactly once with an ops array. No assistant text.

Policy:
- add: an observation that is genuinely new. Carry its waifuId, content, kind; strength = its importance; entities = its subjects.
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
                        "A short GOAL for this one message ('steer toward LTS's car project', 'pull Kevin back in') — never reply content, wording, or anything she would say. Name only the destination — what to move TO. Never name the topic being left behind ('pivot to weekend plans', never 'pivot away from the toast talk'): any topic this goal mentions tends to reappear in her message."
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

// Ops are a discriminated union by `op`; like the dream grammar it is presented as one flat item
// object with a required `op` enum and per-op requirements in the descriptions (no nested objects,
// so the same schema works for Gemini's ANY-mode forcing).
export function observerToolParameters(availableWaifuIds?: string[]): object {
  const waifuIds = [...new Set((availableWaifuIds ?? []).filter(Boolean))];
  const waifuIdSchema: Record<string, unknown> = {
    type: "string",
    description: waifuIds.length
      ? `Required for add. Must be one of the configured waifu ids: ${waifuIds.join(", ")}. The memory owner, never a human.`
      : "Required for add. Configured waifu id."
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
        description: "Memory operations. An empty array is valid and means nothing durable was said.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["op"],
          properties: {
            op: {
              type: "string",
              enum: ["add", "update", "merge", "expire"],
              description: "add: new memory. update: correct an existing memory. merge: combine duplicates. expire: retire a false or resolved memory."
            },
            waifuId: waifuIdSchema,
            content: {
              type: "string",
              description: "Required for add, update and merge: one atomic standalone sentence, not a recap of chat events."
            },
            kind: { type: "string", enum: [...OBSERVATION_KINDS], description: "Required for add; optional for update." },
            importance: { type: "integer", enum: [1, 2, 3, 4, 5], description: "Required for add; optional for update." },
            subjects: {
              type: "array",
              items: { type: "string" },
              description: "Participant handles (p1, w:<waifuId>) of everyone the memory is about."
            },
            memory: { type: "string", description: "Required for update and expire: the existing memory id (m1, m2, ...)." },
            into: { type: "string", description: "Required for merge: the memory id to keep." },
            from: {
              type: "array",
              items: { type: "string" },
              description: "Required for merge: the memory ids folded into `into`."
            },
            reason: { type: "string", description: "Optional for expire: why it no longer holds." }
          }
        }
      }
    },
    required: ["ops"]
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

// ---------------------------------------------------------------------------
// Pre-built parameter consts (used by pipelines.ts as re-exports)
// ---------------------------------------------------------------------------

export const ORCHESTRATOR_TOOL_PARAMETERS = orchestratorToolParameters();

// ---------------------------------------------------------------------------
// Dream message builder (shared by pipelines.ts and gatewayPipeline.ts)
// ---------------------------------------------------------------------------

// The dream pass reads two JSON user blocks: the active memory chunk and the pending observations
// (model-facing fields only: provenance and ids stay app-side).
export function dreamMessages(request: DreamRequest): Array<{ role: "user"; content: string }> {
  const observations = request.observations.map((observation) => ({
    waifuId: observation.waifuId,
    content: observation.content,
    kind: observation.kind,
    importance: observation.importance,
    subjects: (observation.subjects ?? []).map((subject) => subject.name)
  }));
  return [
    { role: "user", content: `memories: ${JSON.stringify(request.memories)}` },
    { role: "user", content: `observations: ${JSON.stringify(observations)}` }
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
const RawImportanceSchema = z.preprocess((value) => {
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
const RawDreamOpSchema = z.object({
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

// Per-op tolerant normalization over a raw ops array (parity with legacy parseDreamOps,
// legacy pipelines.ts:1416-1432): a single malformed op should not fail the whole dream
// chunk. Invalid ops are skipped and their errors collected; the chunk only fails when
// every op in it was invalid, and the thrown message matches legacy exactly.
export function normalizeDreamOps(raw: unknown[]): DreamOp[] {
  const validOps: DreamOp[] = [];
  const invalidOps: string[] = [];
  raw.forEach((op: unknown, index: number) => {
    try {
      validOps.push(normalizeDreamOp(op));
    } catch (error) {
      invalidOps.push(`#${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  if (validOps.length > 0) {
    return validOps;
  }
  throw new Error(
    invalidOps.length
      ? `No valid dream ops. Invalid ops: ${invalidOps.join("; ")}`
      : "Provider returned no dream ops."
  );
}

// Parse an array of raw observation items using the coercing Raw schema.
export function parseRawStageManagerObservations(items: unknown[]): StageManagerObservation[] {
  return items.map((item) => StageManagerObservationSchema.parse(RawStageManagerObservationSchema.parse(item)));
}

const RawObserverOpSchema = z.object({
  op: z.enum(["add", "update", "merge", "expire"]),
  waifuId: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  kind: z.enum(OBSERVATION_KINDS).optional(),
  importance: RawImportanceSchema.optional(),
  subjects: z.array(z.string()).optional().catch(undefined),
  memory: z.string().min(1).optional(),
  into: z.string().min(1).optional(),
  from: z.array(z.string()).optional(),
  reason: z.string().optional()
});

/** One observer op from the wire; a legacy observation (no `op`) becomes an add. */
export function normalizeObserverOp(item: unknown): ObserverOp {
  if (isRecord(item) && item.op === undefined && typeof item.content === "string") {
    const legacy = RawStageManagerObservationSchema.parse(item);
    return ObserverOpSchema.parse({
      op: "add",
      waifuId: legacy.waifuId,
      content: legacy.content,
      kind: legacy.kind,
      importance: legacy.importance,
      subjects: legacy.entities
    });
  }
  const raw = RawObserverOpSchema.parse(item);
  return ObserverOpSchema.parse(stripUndefinedNormalizer({ ...raw }));
}

/** Per-op tolerant parse: malformed ops are dropped instead of failing the whole run. */
export function parseRawObserverOps(items: unknown[]): ObserverOp[] {
  const ops: ObserverOp[] = [];
  for (const item of items) {
    try {
      ops.push(normalizeObserverOp(item));
    } catch {
      // A single malformed op never discards the rest.
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Orchestrator decision — lenient Raw layer
//
// Models forced into the orchestrator_decision tool call sometimes emit values
// the strict OrchestratorDecisionSchema doesn't accept directly — e.g. an explicit
// `retriggerAfterSeconds: null` on a reply decision (the tool schema's own
// description tells the model "Null when replying"), or a `directive` shaped
// entry that fails validation. RawOrchestratorDecisionSchema accepts the wider
// shape actually emitted on the wire; normalizeOrchestratorDecision then maps it
// onto the strict OrchestratorDecisionSchema the rest of the runtime expects.
// ---------------------------------------------------------------------------

const RawDirectiveSchema = z.object({
  intent: z.string().min(1),
  goal: z.string().min(1)
});

const RawRespondingWaifuSchema = z.object({
  waifuId: z.string().min(1),
  delaySeconds: z.number().min(0).nullish(),
  directive: RawDirectiveSchema.nullish().catch(null)
});

export const RawOrchestratorDecisionSchema = z.object({
  action: OrchestratorActionSchema,
  respondingWaifus: z.array(RawRespondingWaifuSchema).default([]),
  retriggerAfterSeconds: z
    .union([z.number().min(RETRIGGER_MIN_SECONDS).max(RETRIGGER_MAX_SECONDS), z.null()])
    .optional(),
  wakePlan: z.union([z.string(), z.null()]).optional(),
  reasoning: z.string().min(1)
});

export function normalizeRawDirective(
  directive: { intent: string; goal: string } | null | undefined
): Directive | undefined {
  if (!directive) return undefined;
  if (!(MODEL_DIRECTIVE_INTENTS as readonly string[]).includes(directive.intent)) return undefined;
  const goal = directive.goal.trim();
  if (!goal) return undefined;
  return { intent: directive.intent as Directive["intent"], goal };
}

// Legacy parseDecision's post-JSON-parse sequence: lenient Raw parse, the
// replyRequired gate, then the strict OrchestratorDecisionSchema mapping.
// Callers that already have the raw tool-call arguments as `unknown` (the
// gateway pipeline) call this directly instead of re-parsing JSON text.
export function normalizeOrchestratorDecision(raw: unknown, replyRequired = false): OrchestratorDecision {
  const parsedRaw = RawOrchestratorDecisionSchema.parse(raw);
  if (replyRequired && parsedRaw.action !== "reply") {
    throw new Error("Manual /run requires action=reply.");
  }
  return OrchestratorDecisionSchema.parse({
    action: parsedRaw.action,
    respondingWaifus: parsedRaw.respondingWaifus.map((entry) => ({
      waifuId: entry.waifuId,
      delaySeconds: entry.delaySeconds ?? 0,
      directive: normalizeRawDirective(entry.directive)
    })),
    retriggerAfterSeconds: parsedRaw.retriggerAfterSeconds === null ? undefined : parsedRaw.retriggerAfterSeconds,
    wakePlan: parsedRaw.wakePlan ?? undefined,
    reasoning: parsedRaw.reasoning
  });
}
