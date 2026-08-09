import { z } from "zod";
import {
  Base64Url16BytesSchema,
  Base64Url32BytesSchema,
  DeviceIdSchema,
  PrincipalStableIdSchema,
  Uint64DecimalSchema
} from "./remoteProtocol.js";

export const COMPLETED_OPERATION_RETENTION_SECONDS = 86_400n;
export const UNRESOLVED_OPERATION_RETENTION_SECONDS = 2_592_000n;
export const MAX_OPERATION_RECORDS = 10_000;
export const MAX_OPERATION_STORE_BYTES = 32 * 1024 * 1024;
export const MAX_OPERATION_RESULT_BYTES = 64 * 1024;
export const ADMIN_AUDIT_RETENTION_SECONDS = 7_776_000n;
export const MAX_ADMIN_AUDIT_RECORDS = 50_000;
export const MAX_ADMIN_AUDIT_STORE_BYTES = 64 * 1024 * 1024;
export const MAX_ADMIN_AUDIT_RECORD_BYTES = 64 * 1024;
export const MAX_EVENT_REPLAY_RECORDS = 2_000;
export const MAX_EVENT_REPLAY_BYTES = 8 * 1024 * 1024;
export const MAX_EVENT_BYTES = 256 * 1024;
export const EVENT_AUTHORIZATION_HEARTBEAT_MS = 15_000;

const OPERATION_STATUS_PATH_PREFIX = "/api/admin/operations/";
const OPERATION_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const AUDIT_NAME_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/;
const AUDIT_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const DELEGATION_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export const OperationIdSchema = Base64Url32BytesSchema.brand<"OperationId">();
export type OperationId = z.infer<typeof OperationIdSchema>;

export const OperationStatusUrlSchema = z
  .string()
  .length(OPERATION_STATUS_PATH_PREFIX.length + 43)
  .refine((value) => {
    if (!value.startsWith(OPERATION_STATUS_PATH_PREFIX)) {
      return false;
    }
    return OperationIdSchema.safeParse(value.slice(OPERATION_STATUS_PATH_PREFIX.length)).success;
  }, "Expected a canonical same-origin operation status path.");

export type OperationStatusUrl = z.infer<typeof OperationStatusUrlSchema>;

function statusUrlMatchesOperation(
  value: { operationId: string; statusUrl: string },
  ctx: z.RefinementCtx
): void {
  if (value.statusUrl !== `${OPERATION_STATUS_PATH_PREFIX}${value.operationId}`) {
    ctx.addIssue({
      code: "custom",
      path: ["statusUrl"],
      message: "Operation status URL must derive from operationId."
    });
  }
}

export function createOperationStatusUrl(operationId: string): OperationStatusUrl {
  const parsedOperationId = OperationIdSchema.parse(operationId);
  return OperationStatusUrlSchema.parse(`${OPERATION_STATUS_PATH_PREFIX}${parsedOperationId}`);
}

export const OperationAcceptedV1Schema = z
  .object({
    operationId: OperationIdSchema,
    status: z.literal("accepted"),
    statusUrl: OperationStatusUrlSchema
  })
  .strict()
  .superRefine(statusUrlMatchesOperation);

export type OperationAcceptedV1 = z.infer<typeof OperationAcceptedV1Schema>;

const OperationStatusBaseShape = {
  version: z.literal(1),
  operationId: OperationIdSchema,
  statusUrl: OperationStatusUrlSchema,
  createdAt: Uint64DecimalSchema,
  updatedAt: Uint64DecimalSchema,
  expiresAt: Uint64DecimalSchema
};

const PreparedOperationStatusV1Schema = z.object({
  ...OperationStatusBaseShape,
  status: z.literal("prepared")
}).strict();

const SuccessfulOperationStatusV1Schema = z.object({
  ...OperationStatusBaseShape,
  status: z.enum(["completed", "reconciled"]),
  completedAt: Uint64DecimalSchema,
  outcome: z.literal("succeeded")
}).strict();

const FailedOperationStatusV1Schema = z.object({
  ...OperationStatusBaseShape,
  status: z.enum(["completed", "reconciled"]),
  completedAt: Uint64DecimalSchema,
  outcome: z.literal("failed"),
  errorCode: z.string().min(1).max(64).regex(OPERATION_ERROR_CODE_PATTERN)
}).strict();

const UnknownOperationStatusV1Schema = z.object({
  ...OperationStatusBaseShape,
  status: z.literal("outcome_unknown"),
  determinedAt: Uint64DecimalSchema,
  errorCode: z.literal("outcome_unknown")
}).strict();

export const OperationStatusV1Schema = z
  .union([
    PreparedOperationStatusV1Schema,
    SuccessfulOperationStatusV1Schema,
    FailedOperationStatusV1Schema,
    UnknownOperationStatusV1Schema
  ])
  .superRefine((value, ctx) => {
    statusUrlMatchesOperation(value, ctx);
    const createdAt = BigInt(value.createdAt);
    const updatedAt = BigInt(value.updatedAt);
    const expiresAt = BigInt(value.expiresAt);
    if (updatedAt < createdAt || expiresAt <= updatedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "Operation timestamps must be ordered."
      });
      return;
    }

    if (value.status === "prepared") {
      if (expiresAt - createdAt > UNRESOLVED_OPERATION_RETENTION_SECONDS) {
        ctx.addIssue({
          code: "custom",
          path: ["expiresAt"],
          message: "Prepared operation retention exceeds 30 days."
        });
      }
      return;
    }

    const terminalAt = BigInt(
      value.status === "outcome_unknown" ? value.determinedAt : value.completedAt
    );
    if (terminalAt < createdAt || terminalAt > updatedAt) {
      ctx.addIssue({
        code: "custom",
        path: [value.status === "outcome_unknown" ? "determinedAt" : "completedAt"],
        message: "Terminal operation timestamp must be within the operation lifetime."
      });
      return;
    }
    const retention = value.status === "outcome_unknown"
      ? UNRESOLVED_OPERATION_RETENTION_SECONDS
      : COMPLETED_OPERATION_RETENTION_SECONDS;
    if (expiresAt - terminalAt > retention) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Operation retention exceeds its status-specific ceiling."
      });
    }
  });

export type OperationStatusV1 = z.infer<typeof OperationStatusV1Schema>;

const LocalAuditActorV1Schema = z.object({
  kind: z.literal("local"),
  stableId: z.literal("local")
}).strict();

const RemoteAuditActorV1Schema = z.object({
  kind: z.literal("remote_device"),
  stableId: PrincipalStableIdSchema,
  deviceId: DeviceIdSchema,
  trustEpoch: Uint64DecimalSchema
}).strict().refine(
  (value) => value.stableId === `remote:${value.deviceId}`,
  { path: ["stableId"], message: "Remote audit stable ID must derive from deviceId." }
);

export const AuditActorV1Schema = z.discriminatedUnion("kind", [
  LocalAuditActorV1Schema,
  RemoteAuditActorV1Schema
]);

export type AuditActorV1 = z.infer<typeof AuditActorV1Schema>;

export const AssistantDelegationV1Schema = z.object({
  conversationId: z.string().min(1).max(128).regex(DELEGATION_IDENTIFIER_PATTERN),
  toolCallId: z.string().min(1).max(128).regex(DELEGATION_IDENTIFIER_PATTERN),
  pendingActionId: z.string().min(1).max(128).regex(DELEGATION_IDENTIFIER_PATTERN).optional()
}).strict();

export type AssistantDelegationV1 = z.infer<typeof AssistantDelegationV1Schema>;

export const AdministrativeAuditRecordV1Schema = z
  .object({
    version: z.literal(1),
    eventId: Base64Url16BytesSchema,
    timestamp: Uint64DecimalSchema,
    actor: AuditActorV1Schema,
    origin: z.enum(["local", "remote"]),
    delegation: AssistantDelegationV1Schema.optional(),
    action: z.string().min(1).max(128).regex(AUDIT_NAME_PATTERN),
    resource: z.object({
      type: z.string().min(1).max(128).regex(AUDIT_NAME_PATTERN),
      identifier: z.string().min(1).max(256).regex(AUDIT_IDENTIFIER_PATTERN)
    }).strict(),
    requestId: Base64Url16BytesSchema,
    idempotencyKeyHash: Base64Url32BytesSchema.optional(),
    operationId: OperationIdSchema.optional(),
    beforeRevision: Uint64DecimalSchema.optional(),
    afterRevision: Uint64DecimalSchema.optional(),
    outcome: z.enum([
      "accepted",
      "completed",
      "rejected",
      "conflict",
      "reconciled",
      "unknown"
    ])
  })
  .strict()
  .superRefine((value, ctx) => {
    const expectedOrigin = value.actor.kind === "local" ? "local" : "remote";
    if (value.origin !== expectedOrigin) {
      ctx.addIssue({
        code: "custom",
        path: ["origin"],
        message: "Audit origin must match the initiating actor."
      });
    }
  });

export type AdministrativeAuditRecordV1 = z.infer<typeof AdministrativeAuditRecordV1Schema>;

export const EventCursorSchema = z
  .string()
  .min(27)
  .max(46)
  .superRefine((value, ctx) => {
    const parts = value.split(":");
    if (
      parts.length !== 3
      || parts[0] !== "v1"
      || !Base64Url16BytesSchema.safeParse(parts[1]).success
      || !Uint64DecimalSchema.safeParse(parts[2]).success
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Expected v1:<base64url-unpadded 16-byte epoch>:<canonical uint64 sequence>."
      });
    }
  })
  .brand<"EventCursorV1">();

export type EventCursor = z.infer<typeof EventCursorSchema>;

export const StreamSnapshotRequiredV1Schema = z.object({
  version: z.literal(1),
  type: z.literal("snapshot_required"),
  reason: z.enum(["epoch_mismatch", "cursor_gap"]),
  streamEpoch: Base64Url16BytesSchema,
  latestSequence: Uint64DecimalSchema
}).strict();

export type StreamSnapshotRequiredV1 = z.infer<typeof StreamSnapshotRequiredV1Schema>;
