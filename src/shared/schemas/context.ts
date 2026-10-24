import { z } from "zod";
import { IsoDateStringSchema, RevisionedRecordSchema } from "./common.js";
import { ImageRefSchema } from "./discordMessage.js";

// Persisted context-engine state (spec 8.1). Resource keys: `context:<key>:<agentId>`,
// `refs:<key>`, `ledger:<key>`; files live under user/conversations/<key>/ (see
// src/orchestration/context/keys.ts). Nothing reads or writes these until the context engine
// lands (T2); the schemas are the contract.

const NoteBase = {
  id: z.string().min(1),
  // Every note is anchored to the NEWEST ledger entry at the moment it is created (never null)
  // and renders after that entry ordered by `seq`, so notes only ever append.
  anchorSeq: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative()
};

export const ContextNoteSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("memory"), ...NoteBase, memoryIds: z.array(z.string()), text: z.string() }), // text frozen
  z.object({ kind: z.literal("direction"), ...NoteBase, text: z.string() }), // directive for the turn being built
  z.object({
    kind: z.literal("tool"),
    ...NoteBase,
    callId: z.string(),
    name: z.string(),
    arguments: z.string(),
    result: z.string()
  }),
  // Orchestrator only; written once the decision is final.
  z.object({
    kind: z.literal("decision"),
    ...NoteBase,
    decisionId: z.string(),
    call: z.string(), // serialized decision args
    outcome: z.string(), // final-state outcome text
    at: IsoDateStringSchema.optional() // when the decision was made (frozen; the text fallback shows it)
  }),
  // A ledger `edit` event (Phase 5) as this context first saw it: numbered from the context's
  // noteSeq and anchored to the newest entry at that moment, so edits share the notes' single
  // append-only order. Author name frozen at conversion.
  z.object({
    kind: z.literal("edit"),
    ...NoteBase,
    eventSeq: z.number().int().nonnegative(),
    messageId: z.string().min(1),
    authorName: z.string(),
    text: z.string().max(500)
  })
]);
export type ContextNote = z.infer<typeof ContextNoteSchema>;

const BreakpointSchema = z.object({
  kind: z.enum(["entry", "note"]),
  seq: z.number().int().nonnegative()
});
export type ContextBreakpoint = z.infer<typeof BreakpointSchema>;

// Early Phase 4 builds could store a breakpoint on an `event` block, a kind that no longer exists
// (edits render as notes). Such a stored breakpoint reads as null (no previous C): the next request
// simply re-marks; new data can never carry it.
const StoredBreakpointSchema = z.preprocess(
  (value) => (typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "event" ? null : value),
  BreakpointSchema.nullable()
);

const ImageModeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("inline") }),
  // Frozen "[image]" or "[image: <ocr>]" text.
  z.object({ mode: z.literal("text"), text: z.string() })
]);
export type ImageMode = z.infer<typeof ImageModeSchema>;

export const CompactionTriggerSchema = z.enum(["tokens", "messages", "overflow", "manual"]);

// Presence changes are tail-only (never stored).
export const ContextStateSchema = RevisionedRecordSchema.extend({
  conversationKey: z.string().min(1),
  agentId: z.string().min(1),
  epoch: z.number().int().nonnegative(),
  epochStartedAt: IsoDateStringSchema,
  lastUsedAt: IsoDateStringSchema,
  cursorSeq: z.number().int().nonnegative().nullable().default(null), // transcript = ledger entries with seq > cursorSeq
  cursorMessageId: z.string().nullable().default(null), // display only
  timeZone: z.string().min(1), // IANA zone frozen per epoch (host zone at epoch start)
  lastBreakpoint: StoredBreakpointSchema.default(null), // block that carried the previous request's C
  summary: z.string().nullable().default(null),
  headerText: z.string().nullable().default(null), // rendered breakpoint-B text, frozen per epoch
  memorySnapshotIds: z.array(z.string()).default([]),
  // Discord user ids present when the epoch started (frozen with the header): the tail reports
  // arrivals by id against it. Additive (T3 review).
  epochParticipantIds: z.array(z.string()).default([]),
  memoryNoteCount: z.number().int().nonnegative().default(0),
  // Spec 9.5 (hybrid delete): ledger entries marked `deleted` that were OLD when this epoch
  // started. They render as "(message deleted)" in this epoch (the ledger text is left alone for
  // the other agents' still-cached epochs); frozen with the epoch, reset when the next one starts.
  redactedIds: z.array(z.string()).default([]),
  imageModes: z.record(z.string(), ImageModeSchema).default({}),
  inlineImageCount: z.number().int().nonnegative().default(0), // imageModes/inlineImageCount reset each epoch
  notes: z.array(ContextNoteSchema).default([]),
  noteSeq: z.number().int().nonnegative().default(0),
  tokenCalibration: z
    .record(
      z.string(), // "provider:model"
      z.object({
        ratio: z.number().positive(),
        samples: z.number().int().nonnegative(),
        updatedAt: IsoDateStringSchema
      })
    )
    .default({}),
  lastCompaction: z
    .object({
      at: IsoDateStringSchema,
      trigger: CompactionTriggerSchema,
      ok: z.boolean(),
      error: z.string().optional()
    })
    .optional()
});
export type ContextState = z.infer<typeof ContextStateSchema>;

/** First message ref is "a0" (base 36): the counter starts at 360. */
export const REF_COUNTER_START = 360;

export const ConversationRefsSchema = RevisionedRecordSchema.extend({
  conversationKey: z.string().min(1),
  counter: z.number().int().nonnegative().default(REF_COUNTER_START),
  refs: z.record(z.string(), z.string()).default({}) // messageId -> ref
});
export type ConversationRefs = z.infer<typeof ConversationRefsSchema>;

// Conversation ledger: frozen, rendered message bodies shared by every agent of the conversation.
// Author and mention names are frozen at first render, so renames never bust caches.
export const LedgerEntrySchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  authorId: z.string().min(1),
  authorName: z.string(), // frozen
  authorIsBot: z.boolean(),
  at: IsoDateStringSchema,
  editedAt: IsoDateStringSchema.optional(),
  kind: z.enum(["default", "system"]),
  body: z.string(), // frozen rendered text
  images: z.array(ImageRefSchema).default([]), // url refreshed in place when re-signed
  replyToId: z.string().optional(),
  state: z.enum(["live", "edited", "deleted"]),
  sealed: z.boolean()
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

// Populated in Phase 5 (spec 9.5).
export const ConversationEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("edit"),
    seq: z.number().int().nonnegative(),
    at: IsoDateStringSchema,
    messageId: z.string().min(1),
    anchorSeq: z.number().int().nonnegative(),
    authorId: z.string().min(1),
    text: z.string().max(500),
    sealed: z.boolean()
  }),
  // Audit only, never rendered.
  z.object({
    kind: z.literal("delete"),
    seq: z.number().int().nonnegative(),
    at: IsoDateStringSchema,
    messageId: z.string().min(1),
    anchorSeq: z.number().int().nonnegative()
  })
]);
export type ConversationEvent = z.infer<typeof ConversationEventSchema>;

export const ConversationLedgerSchema = RevisionedRecordSchema.extend({
  conversationKey: z.string().min(1),
  nextSeq: z.number().int().nonnegative().default(1),
  entries: z.record(z.string(), LedgerEntrySchema).default({}), // id -> entry
  events: z.array(ConversationEventSchema).default([]) // [] until Phase 5
});
export type ConversationLedger = z.infer<typeof ConversationLedgerSchema>;
