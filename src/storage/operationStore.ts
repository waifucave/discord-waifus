import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { redactSecrets } from "../backend/redaction.js";
import { resolveDataPath } from "../config/paths.js";
import {
  AuditActorV1Schema,
  COMPLETED_OPERATION_RETENTION_SECONDS,
  MAX_OPERATION_RECORDS,
  MAX_OPERATION_RESULT_BYTES,
  MAX_OPERATION_STORE_BYTES,
  OperationIdSchema,
  OperationStatusV1Schema,
  UNRESOLVED_OPERATION_RETENTION_SECONDS,
  createOperationStatusUrl,
  type AuditActorV1,
  type OperationId,
  type OperationStatusV1
} from "../shared/schemas/adminOperations.js";
import {
  Base64Url16BytesSchema,
  Base64Url32BytesSchema,
  CanonicalTargetSchema,
  HttpMethodSchema,
  Uint64DecimalSchema
} from "../shared/schemas/remoteProtocol.js";
import { atomicWriteJson } from "./atomic.js";
import { StorageService } from "./storageService.js";

const OPERATION_STORE_PATH = "app/remote-access/operations/ledger.json";
const OPERATION_LOCK = "remote-access:operations";

const RetryClassSchema = z.enum([
  "transactional",
  "reconciled",
  "non_replayable",
  "invitation_recovery"
]);

const StoredResponseSchema = z.object({
  statusCode: z.number().int().min(100).max(599),
  contentType: z.string().min(1).max(256).optional(),
  encoding: z.enum(["utf8", "base64"]),
  body: z.string()
}).strict().superRefine((value, ctx) => {
  const bytes = value.encoding === "base64"
    ? Buffer.from(value.body, "base64")
    : Buffer.from(value.body, "utf8");
  if (value.encoding === "base64" && bytes.toString("base64") !== value.body) {
    ctx.addIssue({
      code: "custom",
      path: ["body"],
      message: "Stored binary operation response is not canonical base64."
    });
  }
  if (bytes.byteLength > MAX_OPERATION_RESULT_BYTES) {
    ctx.addIssue({
      code: "custom",
      path: ["body"],
      message: "Stored operation response exceeds the result limit."
    });
  }
});

const StoredOperationSchema = z.object({
  version: z.literal(1),
  operationId: OperationIdSchema,
  lookupHash: Base64Url32BytesSchema,
  actor: AuditActorV1Schema,
  retryClass: RetryClassSchema,
  method: HttpMethodSchema,
  targetHash: Base64Url32BytesSchema,
  idempotencyKeyHash: Base64Url32BytesSchema,
  bodyHash: Base64Url32BytesSchema,
  requestId: Base64Url16BytesSchema,
  status: z.enum(["prepared", "completed", "reconciled", "outcome_unknown"]),
  createdAt: Uint64DecimalSchema,
  updatedAt: Uint64DecimalSchema,
  expiresAt: Uint64DecimalSchema,
  completedAt: Uint64DecimalSchema.optional(),
  determinedAt: Uint64DecimalSchema.optional(),
  outcome: z.enum(["succeeded", "failed"]).optional(),
  errorCode: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
  response: StoredResponseSchema.optional()
}).strict().superRefine((value, ctx) => {
  const publicStatus = publicOperationStatus(value);
  const parsed = OperationStatusV1Schema.safeParse(publicStatus);
  if (!parsed.success) {
    ctx.addIssue({
      code: "custom",
      message: "Stored operation has an invalid public status projection."
    });
  }
  if (value.status === "prepared" && (
    value.completedAt !== undefined
    || value.determinedAt !== undefined
    || value.outcome !== undefined
    || value.errorCode !== undefined
    || value.response !== undefined
  )) {
    ctx.addIssue({ code: "custom", message: "Prepared operations cannot carry terminal fields." });
  }
  if (value.status === "outcome_unknown" && value.response !== undefined) {
    ctx.addIssue({ code: "custom", message: "Unknown operations cannot carry a response." });
  }
});

type StoredOperation = z.infer<typeof StoredOperationSchema>;

const OperationLedgerSchema = z.object({
  version: z.literal(1),
  records: z.array(StoredOperationSchema)
}).strict();

type OperationLedger = z.infer<typeof OperationLedgerSchema>;

export type StoredOperationResponse = z.infer<typeof StoredResponseSchema>;

type OperationIntentBase = {
  actor: AuditActorV1;
  retryClass: z.infer<typeof RetryClassSchema>;
  method: string;
  canonicalTarget: string;
  idempotencyKey: string;
  requestId?: string;
};

export type OperationIntent = OperationIntentBase & (
  | { bodyBytes: Uint8Array; bodyHash?: never }
  | { bodyHash: string; bodyBytes?: never }
);

export type OperationReservation =
  | {
      kind: "created";
      operationId: OperationId;
      requestId: string;
      idempotencyKeyHash: string;
      status: OperationStatusV1;
    }
  | {
      kind: "replay";
      operationId: OperationId;
      requestId: string;
      idempotencyKeyHash: string;
      status: OperationStatusV1;
      response: StoredOperationResponse;
    }
  | {
      kind: "pending";
      operationId: OperationId;
      requestId: string;
      idempotencyKeyHash: string;
      status: OperationStatusV1;
    };

export class OperationIdempotencyConflictError extends Error {
  constructor(readonly operationId: OperationId) {
    super("Idempotency key was already used with a different request body.");
    this.name = "OperationIdempotencyConflictError";
  }
}

export class OperationStoreCapacityError extends Error {
  constructor(message = "Operation receipt capacity is exhausted.") {
    super(message);
    this.name = "OperationStoreCapacityError";
  }
}

export type OperationStoreOptions = {
  storage?: StorageService;
  now?: () => bigint;
  randomBytes?: (size: number) => Uint8Array;
  maxRecords?: number;
  maxStoreBytes?: number;
  maxResultBytes?: number;
};

export class OperationStore {
  readonly filePath: string;
  private readonly storage: StorageService;
  private readonly now: () => bigint;
  private readonly random: (size: number) => Uint8Array;
  private readonly maxRecords: number;
  private readonly maxStoreBytes: number;
  private readonly maxResultBytes: number;
  private readonly activeOperationIds = new Set<string>();

  constructor(readonly dataRoot: string, options: OperationStoreOptions = {}) {
    this.storage = options.storage ?? new StorageService(dataRoot);
    this.now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
    this.random = options.randomBytes ?? randomBytes;
    this.maxRecords = options.maxRecords ?? MAX_OPERATION_RECORDS;
    this.maxStoreBytes = options.maxStoreBytes ?? MAX_OPERATION_STORE_BYTES;
    this.maxResultBytes = options.maxResultBytes ?? MAX_OPERATION_RESULT_BYTES;
    this.filePath = resolveDataPath(dataRoot, OPERATION_STORE_PATH);
  }

  async reserve(intentInput: OperationIntent): Promise<OperationReservation> {
    const intent = parseIntent(intentInput);
    return this.storage.locks.withLock(OPERATION_LOCK, async () => {
      const now = this.now();
      let ledger = await this.readLedger();
      const normalized = this.normalizeLedger(ledger, now);
      ledger = normalized.ledger;

      const idempotencyKeyHash = hashBytes(Buffer.from(intent.idempotencyKey, "utf8"));
      const bodyHash = intent.bodyHash;
      const lookupHash = operationLookupHash({
        actor: intent.actor,
        method: intent.method,
        canonicalTarget: intent.canonicalTarget,
        idempotencyKeyHash
      });
      const existing = ledger.records.find((record) => record.lookupHash === lookupHash);
      if (existing) {
        if (existing.bodyHash !== bodyHash) {
          if (normalized.changed) await this.writeLedger(ledger);
          throw new OperationIdempotencyConflictError(existing.operationId);
        }
        if (normalized.changed) await this.writeLedger(ledger);
        const base = {
          operationId: existing.operationId,
          requestId: existing.requestId,
          idempotencyKeyHash: existing.idempotencyKeyHash,
          status: publicOperationStatus(existing)
        };
        return existing.response
          ? { kind: "replay", ...base, response: existing.response }
          : { kind: "pending", ...base };
      }

      const operationId = this.createUniqueOperationId(ledger.records);
      const createdAt = decimal(now);
      const record = StoredOperationSchema.parse({
        version: 1,
        operationId,
        lookupHash,
        actor: intent.actor,
        retryClass: intent.retryClass,
        method: intent.method,
        targetHash: hashBytes(Buffer.from(intent.canonicalTarget, "utf8")),
        idempotencyKeyHash,
        bodyHash,
        requestId: intent.requestId ?? this.randomToken(16, Base64Url16BytesSchema),
        status: "prepared",
        createdAt,
        updatedAt: createdAt,
        expiresAt: decimal(now + UNRESOLVED_OPERATION_RETENTION_SECONDS)
      });
      const next = OperationLedgerSchema.parse({
        version: 1,
        records: [...ledger.records, record]
      });
      this.assertCapacity(next);
      await this.writeLedger(next);
      this.activeOperationIds.add(operationId);
      return {
        kind: "created",
        operationId,
        requestId: record.requestId,
        idempotencyKeyHash,
        status: publicOperationStatus(record)
      };
    });
  }

  async complete(
    operationIdInput: string,
    input: {
      outcome: "succeeded" | "failed";
      errorCode?: string;
      reconciled?: boolean;
      response?: {
        statusCode: number;
        contentType?: string;
        body: string | Uint8Array;
      };
    }
  ): Promise<OperationStatusV1> {
    const operationId = OperationIdSchema.parse(operationIdInput);
    return this.storage.locks.withLock(OPERATION_LOCK, async () => {
      const ledger = await this.readLedger();
      const index = ledger.records.findIndex((record) => record.operationId === operationId);
      if (index === -1) throw new Error("Operation receipt disappeared before completion.");
      const current = ledger.records[index];
      if (current.status !== "prepared") {
        this.activeOperationIds.delete(operationId);
        return publicOperationStatus(current);
      }
      const now = maxBigInt(this.now(), BigInt(current.createdAt));
      const status = input.reconciled ? "reconciled" : "completed";
      const response = input.response === undefined
        ? undefined
        : this.sanitizeResponse(input.response);
      const nextRecord = StoredOperationSchema.parse({
        ...current,
        status,
        updatedAt: decimal(now),
        expiresAt: decimal(now + COMPLETED_OPERATION_RETENTION_SECONDS),
        completedAt: decimal(now),
        outcome: input.outcome,
        ...(input.outcome === "failed"
          ? { errorCode: normalizeErrorCode(input.errorCode) }
          : {}),
        ...(response ? { response } : {})
      });
      const records = [...ledger.records];
      records[index] = nextRecord;
      const next = OperationLedgerSchema.parse({ version: 1, records });
      this.assertCapacity(next);
      await this.writeLedger(next);
      this.activeOperationIds.delete(operationId);
      return publicOperationStatus(nextRecord);
    });
  }

  async markUnknown(operationIdInput: string): Promise<OperationStatusV1> {
    const operationId = OperationIdSchema.parse(operationIdInput);
    return this.storage.locks.withLock(OPERATION_LOCK, async () => {
      const ledger = await this.readLedger();
      const index = ledger.records.findIndex((record) => record.operationId === operationId);
      if (index === -1) throw new Error("Unknown operation receipt.");
      const current = ledger.records[index];
      if (current.status !== "prepared") return publicOperationStatus(current);
      const nextRecord = unknownRecord(current, this.now());
      const records = [...ledger.records];
      records[index] = nextRecord;
      const next = OperationLedgerSchema.parse({ version: 1, records });
      this.assertCapacity(next);
      await this.writeLedger(next);
      this.activeOperationIds.delete(operationId);
      return publicOperationStatus(nextRecord);
    });
  }

  async abandonPrepared(operationIdInput: string): Promise<void> {
    const operationId = OperationIdSchema.parse(operationIdInput);
    await this.storage.locks.withLock(OPERATION_LOCK, async () => {
      const ledger = await this.readLedger();
      const current = ledger.records.find((record) => record.operationId === operationId);
      if (!current || current.status !== "prepared" || !this.activeOperationIds.has(operationId)) {
        return;
      }
      await this.writeLedger(OperationLedgerSchema.parse({
        version: 1,
        records: ledger.records.filter((record) => record.operationId !== operationId)
      }));
      this.activeOperationIds.delete(operationId);
    });
  }

  async getVisible(
    operationIdInput: string,
    viewer: AuditActorV1
  ): Promise<OperationStatusV1 | undefined> {
    const parsedId = OperationIdSchema.safeParse(operationIdInput);
    const parsedViewer = AuditActorV1Schema.safeParse(viewer);
    if (!parsedId.success || !parsedViewer.success) return undefined;
    return this.storage.locks.withLock(OPERATION_LOCK, async () => {
      const now = this.now();
      const normalized = this.normalizeLedger(await this.readLedger(), now);
      if (normalized.changed) await this.writeLedger(normalized.ledger);
      const record = normalized.ledger.records.find((candidate) => candidate.operationId === parsedId.data);
      if (!record || !canView(record.actor, parsedViewer.data)) return undefined;
      return publicOperationStatus(record);
    });
  }

  async count(): Promise<number> {
    return this.storage.locks.withLock(OPERATION_LOCK, async () => {
      const normalized = this.normalizeLedger(await this.readLedger(), this.now());
      if (normalized.changed) await this.writeLedger(normalized.ledger);
      return normalized.ledger.records.length;
    });
  }

  private async readLedger(): Promise<OperationLedger> {
    return this.storage.readJson(
      OPERATION_STORE_PATH,
      OperationLedgerSchema,
      { version: 1, records: [] }
    );
  }

  private async writeLedger(ledger: OperationLedger): Promise<void> {
    this.assertCapacity(ledger);
    await atomicWriteJson(this.filePath, OperationLedgerSchema.parse(ledger), { mode: 0o600 });
  }

  private normalizeLedger(ledger: OperationLedger, now: bigint): {
    ledger: OperationLedger;
    changed: boolean;
  } {
    let changed = false;
    const records: StoredOperation[] = [];
    for (const record of ledger.records) {
      if (BigInt(record.expiresAt) <= now) {
        this.activeOperationIds.delete(record.operationId);
        changed = true;
        continue;
      }
      if (record.status === "prepared" && !this.activeOperationIds.has(record.operationId)) {
        records.push(unknownRecord(record, now));
        changed = true;
      } else {
        records.push(record);
      }
    }
    return {
      ledger: changed ? OperationLedgerSchema.parse({ version: 1, records }) : ledger,
      changed
    };
  }

  private sanitizeResponse(input: {
    statusCode: number;
    contentType?: string;
    body: string | Uint8Array;
  }): StoredOperationResponse | undefined {
    if (typeof input.body !== "string") return undefined;
    let bytes = Buffer.from(input.body, "utf8");
    const text = bytes.toString("utf8");
    try {
      bytes = Buffer.from(JSON.stringify(redactSecrets(JSON.parse(text))), "utf8");
    } catch {
      bytes = Buffer.from(redactSecrets(text), "utf8");
    }
    if (bytes.byteLength > this.maxResultBytes) return undefined;
    return StoredResponseSchema.parse({
      statusCode: input.statusCode,
      ...(input.contentType ? { contentType: redactSecrets(input.contentType) } : {}),
      encoding: "utf8",
      body: bytes.toString("utf8")
    });
  }

  private assertCapacity(ledger: OperationLedger): void {
    if (ledger.records.length > this.maxRecords) {
      throw new OperationStoreCapacityError("Operation receipt count capacity is exhausted.");
    }
    if (ledgerBytes(ledger) > this.maxStoreBytes) {
      throw new OperationStoreCapacityError("Operation receipt byte capacity is exhausted.");
    }
  }

  private createUniqueOperationId(records: readonly StoredOperation[]): OperationId {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = OperationIdSchema.parse(
        Buffer.from(this.random(32)).toString("base64url")
      );
      if (!records.some((record) => record.operationId === candidate)) return candidate;
    }
    throw new Error("Could not allocate a unique operation ID.");
  }

  private randomToken<T extends string>(size: number, schema: z.ZodType<T>): T {
    return schema.parse(Buffer.from(this.random(size)).toString("base64url"));
  }
}

function parseIntent(input: OperationIntent) {
  const hasBodyHash = input.bodyHash !== undefined;
  const hasBodyBytes = input.bodyBytes !== undefined;
  if (hasBodyHash === hasBodyBytes) {
    throw new TypeError("Operation intent requires exactly one body hash source.");
  }
  return {
    actor: AuditActorV1Schema.parse(input.actor),
    retryClass: RetryClassSchema.parse(input.retryClass),
    method: HttpMethodSchema.parse(input.method.toUpperCase()),
    canonicalTarget: CanonicalTargetSchema.parse(input.canonicalTarget),
    idempotencyKey: Base64Url32BytesSchema.parse(input.idempotencyKey),
    bodyHash: !hasBodyHash
      ? hashBytes(Buffer.from(input.bodyBytes!))
      : Base64Url32BytesSchema.parse(input.bodyHash),
    ...(input.requestId ? { requestId: Base64Url16BytesSchema.parse(input.requestId) } : {})
  };
}

function publicOperationStatus(record: {
  operationId: string;
  status: "prepared" | "completed" | "reconciled" | "outcome_unknown";
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  completedAt?: string;
  determinedAt?: string;
  outcome?: "succeeded" | "failed";
  errorCode?: string;
}): OperationStatusV1 {
  return OperationStatusV1Schema.parse({
    version: 1,
    operationId: record.operationId,
    statusUrl: createOperationStatusUrl(record.operationId),
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.determinedAt ? { determinedAt: record.determinedAt } : {}),
    ...(record.outcome ? { outcome: record.outcome } : {}),
    ...(record.errorCode ? { errorCode: record.errorCode } : {})
  });
}

function unknownRecord(record: StoredOperation, nowInput: bigint): StoredOperation {
  const now = maxBigInt(nowInput, BigInt(record.createdAt));
  return StoredOperationSchema.parse({
    version: record.version,
    operationId: record.operationId,
    lookupHash: record.lookupHash,
    actor: record.actor,
    retryClass: record.retryClass,
    method: record.method,
    targetHash: record.targetHash,
    idempotencyKeyHash: record.idempotencyKeyHash,
    bodyHash: record.bodyHash,
    requestId: record.requestId,
    status: "outcome_unknown",
    createdAt: record.createdAt,
    updatedAt: decimal(now),
    expiresAt: decimal(now + UNRESOLVED_OPERATION_RETENTION_SECONDS),
    determinedAt: decimal(now),
    errorCode: "outcome_unknown"
  });
}

function canView(owner: AuditActorV1, viewer: AuditActorV1): boolean {
  if (viewer.kind === "local") return true;
  return owner.kind === "remote_device"
    && owner.stableId === viewer.stableId
    && owner.deviceId === viewer.deviceId
    && owner.trustEpoch === viewer.trustEpoch;
}

function operationLookupHash(input: {
  actor: AuditActorV1;
  method: string;
  canonicalTarget: string;
  idempotencyKeyHash: string;
}): string {
  return hashBytes(Buffer.from(JSON.stringify({
    version: 1,
    actor: input.actor,
    method: input.method,
    canonicalTarget: input.canonicalTarget,
    idempotencyKeyHash: input.idempotencyKeyHash
  }), "utf8"));
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

function decimal(value: bigint): string {
  return Uint64DecimalSchema.parse(value.toString());
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function normalizeErrorCode(value: string | undefined): string {
  const raw = value ?? "operation_failed";
  if (redactSecrets(raw) !== raw) return "operation_failed";
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return /^[a-z][a-z0-9_]{0,63}$/.test(normalized) ? normalized : "operation_failed";
}

function ledgerBytes(ledger: OperationLedger): number {
  return Buffer.byteLength(`${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}
