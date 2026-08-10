import { createHash, randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { redactSecrets } from "../backend/redaction.js";
import {
  AdministrativeAuditRecordV1Schema,
  OperationAcceptedV1Schema,
  createOperationStatusUrl,
  type AdministrativeAuditRecordV1,
  type AuditActorV1
} from "../shared/schemas/adminOperations.js";
import {
  Base64Url16BytesSchema,
  Base64Url32BytesSchema,
  CanonicalTargetSchema,
  Uint64DecimalSchema
} from "../shared/schemas/remoteProtocol.js";
import {
  serializeCanonicalContractJson,
  type ContractJson
} from "../shared/schemas/remoteProtocolContract.js";
import type { AuditStore } from "../storage/auditStore.js";
import {
  OperationIdempotencyConflictError,
  OperationStoreCapacityError,
  type OperationReservation,
  type OperationStore,
  type StoredOperationResponse
} from "../storage/operationStore.js";
import { auditActorFromPrincipal } from "./adminOperations.js";
import { ApiError } from "./errors.js";
import { effectiveRequestPolicy, type RetryClass } from "./routePolicy.js";
import type { AssistantDelegation } from "./requestPrincipal.js";

const IDEMPOTENCY_HEADER = "idempotency-key";
const REQUEST_ID_HEADER = "x-waifus-request-id";

export type MutationRequestContext = {
  readonly operationId: string;
  readonly requestId: string;
  readonly idempotencyKeyHash: string;
  readonly retryClass: Exclude<RetryClass, "safe">;
  readonly action: string;
  readonly resource: { type: string; identifier: string };
  readonly actor: AuditActorV1;
  readonly delegation?: AssistantDelegation;
  readonly beforeRevision?: string;
  finalizationAttempted: boolean;
};

export type MutationHandlingOptions = {
  operationStore: OperationStore;
  auditStore: AuditStore;
  now?: () => bigint;
  randomBytes?: (size: number) => Uint8Array;
};

export function installMutationHandling(
  app: FastifyInstance,
  options: MutationHandlingOptions
): void {
  const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  const random = options.randomBytes ?? randomBytes;

  app.addHook("preParsing", async (request, _reply, payload) => {
    const policy = effectiveRequestPolicy(request);
    const rawMediaType = rawMutationMediaType(request);
    if (!policy || policy.retryClass === "safe" || !rawMediaType) {
      return payload;
    }
    const hash = createHash("sha256")
      .update(mutationConditionalPrefix(request))
      .update(rawMutationBodyPrefix(rawMediaType));
    const hashingStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        hashingStream.receivedEncodedLength += chunk.byteLength;
        callback(null, chunk);
      },
      flush(callback) {
        request.rawMutationBodyHash = Base64Url32BytesSchema.parse(hash.digest("base64url"));
        callback();
      }
    }) as Transform & { receivedEncodedLength: number };
    hashingStream.receivedEncodedLength = 0;
    return payload.pipe(hashingStream);
  });

  app.addHook("preHandler", async (request, reply) => {
    const policy = effectiveRequestPolicy(request);
    if (!policy || policy.retryClass === "safe") return;
    if (!policy.auditAction) {
      throw new Error(`Unsafe route ${request.method} ${request.routeOptions.url} has no audit action.`);
    }
    const retryClass = policy.retryClass;
    const actor = auditActorFromPrincipal(request.principal);
    const requestId = randomToken(16, Base64Url16BytesSchema, random);
    reply.header(REQUEST_ID_HEADER, requestId);
    const resource = auditResource(policy.auditAction, request.params);
    const delegation = request.assistantDelegation;
    const suppliedKey = request.headers[IDEMPOTENCY_HEADER];
    const key = typeof suppliedKey === "string" && suppliedKey.length > 0
      ? Base64Url32BytesSchema.safeParse(suppliedKey)
      : undefined;

    if (request.principal.kind === "remote_device" && suppliedKey === undefined) {
      await appendStandaloneAudit(options.auditStore, {
        request,
        actor,
        delegation,
        action: policy.auditAction,
        resource,
        requestId,
        outcome: "rejected",
        now,
        random
      });
      throw new ApiError(
        428,
        "Remote mutations require a canonical 32-byte Idempotency-Key.",
        undefined,
        "IdempotencyKeyRequired"
      );
    }
    if (suppliedKey !== undefined && !key?.success) {
      await appendStandaloneAudit(options.auditStore, {
        request,
        actor,
        delegation,
        action: policy.auditAction,
        resource,
        requestId,
        idempotencyKeyHash: hashBytes(Buffer.from(String(suppliedKey), "utf8")),
        outcome: "rejected",
        now,
        random
      });
      throw new ApiError(
        400,
        "Idempotency-Key must be canonical unpadded base64url for exactly 32 bytes.",
        undefined,
        "IdempotencyKeyInvalid"
      );
    }

    const idempotencyKey = key?.success
      ? key.data
      : randomToken(32, Base64Url32BytesSchema, random);
    let reservation: OperationReservation;
    try {
      const bodyIntent = request.rawMutationBodyHash && (
        Buffer.isBuffer(request.body) || request.body instanceof Uint8Array
      )
        ? { bodyHash: request.rawMutationBodyHash }
        : {
            bodyBytes: Buffer.concat([
              mutationConditionalPrefix(request),
              canonicalMutationBodyBytes(request.body)
            ])
          };
      reservation = await options.operationStore.reserve({
        actor,
        retryClass,
        method: request.method,
        canonicalTarget: canonicalMutationTarget(request.raw.url ?? request.url),
        idempotencyKey,
        ...bodyIntent,
        requestId
      });
    } catch (error) {
      const idempotencyKeyHash = hashBytes(Buffer.from(idempotencyKey, "utf8"));
      if (error instanceof OperationIdempotencyConflictError) {
        await appendStandaloneAudit(options.auditStore, {
          request,
          actor,
          delegation,
          action: policy.auditAction,
          resource,
          requestId,
          idempotencyKeyHash,
          operationId: error.operationId,
          outcome: "conflict",
          now,
          random
        });
        throw new ApiError(
          409,
          "Idempotency-Key was already used for this target with a different body.",
          undefined,
          "IdempotencyConflict"
        );
      }
      if (error instanceof OperationStoreCapacityError) {
        await appendStandaloneAudit(options.auditStore, {
          request,
          actor,
          delegation,
          action: policy.auditAction,
          resource,
          requestId,
          idempotencyKeyHash,
          outcome: "rejected",
          now,
          random
        });
        throw new ApiError(
          503,
          "Mutation receipt capacity is exhausted; no effect was started.",
          undefined,
          "OperationCapacity"
        );
      }
      await appendStandaloneAudit(options.auditStore, {
        request,
        actor,
        delegation,
        action: policy.auditAction,
        resource,
        requestId,
        idempotencyKeyHash,
        outcome: "rejected",
        now,
        random
      });
      throw new ApiError(
        503,
        "Mutation receipts are unavailable; no effect was started.",
        undefined,
        "OperationUnavailable"
      );
    }

    reply.header(REQUEST_ID_HEADER, reservation.requestId);
    if (reservation.kind === "replay") {
      sendStoredResponse(reply, reservation.response);
      return reply;
    }
    if (reservation.kind === "pending") {
      reply.status(202).send(OperationAcceptedV1Schema.parse({
        operationId: reservation.operationId,
        status: "accepted",
        statusUrl: createOperationStatusUrl(reservation.operationId)
      }));
      return reply;
    }

    try {
      await options.auditStore.append(buildAuditRecord({
        actor,
        delegation,
        action: policy.auditAction,
        resource,
        requestId: reservation.requestId,
        idempotencyKeyHash: reservation.idempotencyKeyHash,
        operationId: reservation.operationId,
        beforeRevision: requestRevision(request),
        outcome: "accepted",
        now,
        random
      }));
    } catch {
      await options.operationStore.abandonPrepared(reservation.operationId).catch(() => undefined);
      throw new ApiError(
        503,
        "Administrative audit could not be persisted; no effect was started.",
        undefined,
        "AuditUnavailable"
      );
    }

    const beforeRevision = requestRevision(request);
    request.mutationContext = {
      operationId: reservation.operationId,
      requestId: reservation.requestId,
      idempotencyKeyHash: reservation.idempotencyKeyHash,
      retryClass,
      action: policy.auditAction,
      resource,
      actor,
      ...(delegation ? { delegation } : {}),
      ...(beforeRevision ? { beforeRevision } : {}),
      finalizationAttempted: false
    };
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const context = request.mutationContext;
    if (!context || context.finalizationAttempted) return payload;
    context.finalizationAttempted = true;
    const statusCode = reply.statusCode;
    const parsedPayload = parseJsonPayload(payload);
    const auditOutcome = statusCode === 409
      ? "conflict"
      : statusCode >= 400
        ? "rejected"
        : context.retryClass === "reconciled"
          ? "reconciled"
          : "completed";
    try {
      await options.auditStore.append(buildAuditRecord({
        actor: context.actor,
        delegation: context.delegation,
        action: context.action,
        resource: context.resource,
        requestId: context.requestId,
        idempotencyKeyHash: context.idempotencyKeyHash,
        operationId: context.operationId,
        beforeRevision: context.beforeRevision,
        afterRevision: responseRevision(parsedPayload),
        outcome: auditOutcome,
        now,
        random
      }));
      const storedResponse = storedResponseInput(reply, payload);
      await options.operationStore.complete(context.operationId, {
        outcome: statusCode >= 400 ? "failed" : "succeeded",
        reconciled: context.retryClass === "reconciled",
        ...(statusCode >= 400 ? { errorCode: responseErrorCode(parsedPayload, statusCode) } : {}),
        ...(storedResponse ? { response: storedResponse } : {})
      });
    } catch {
      await options.operationStore.markUnknown(context.operationId).catch(() => undefined);
      await options.auditStore.append(buildAuditRecord({
        actor: context.actor,
        delegation: context.delegation,
        action: context.action,
        resource: context.resource,
        requestId: context.requestId,
        idempotencyKeyHash: context.idempotencyKeyHash,
        operationId: context.operationId,
        beforeRevision: context.beforeRevision,
        outcome: "unknown",
        now,
        random
      })).catch(() => undefined);
      throw new ApiError(
        503,
        "Mutation outcome could not be durably recorded; query its operation status before retrying.",
        undefined,
        "MutationDurabilityFailure"
      );
    }
    return payload;
  });
}

export function canonicalMutationTarget(rawTarget: string): string {
  const parsed = new URL(rawTarget, "http://waifus.invalid");
  parsed.searchParams.sort();
  const query = parsed.searchParams.toString();
  return CanonicalTargetSchema.parse(`${parsed.pathname}${query ? `?${query}` : ""}`);
}

export function canonicalMutationBodyBytes(
  body: unknown,
  rawMediaType = "application/octet-stream"
): Uint8Array {
  if (body === undefined) return Buffer.from("none\0", "utf8");
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return Buffer.concat([rawMutationBodyPrefix(rawMediaType), Buffer.from(body)]);
  }
  if (typeof body === "string") {
    return Buffer.from(`text\0${body}`, "utf8");
  }
  return Buffer.from(
    `json\0${serializeCanonicalContractJson(body as ContractJson)}`,
    "utf8"
  );
}

function sendStoredResponse(reply: FastifyReply, response: StoredOperationResponse): void {
  if (response.contentType) reply.header("content-type", response.contentType);
  const body = response.encoding === "base64"
    ? Buffer.from(response.body, "base64")
    : response.body;
  void reply.status(response.statusCode).send(body);
}

function auditResource(action: string, params: unknown): { type: string; identifier: string } {
  const segments = action.split(".");
  const type = segments.length > 1 ? segments.slice(0, -1).join(".") : action;
  const identifiers = params && typeof params === "object"
    ? Object.entries(params as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, value]) => String(value))
    : [];
  const identifier = (identifiers.join(":") || "global")
    .replace(/[^A-Za-z0-9:._-]+/g, "_")
    .slice(0, 256);
  return { type, identifier: identifier || "global" };
}

function buildAuditRecord(input: {
  actor: AuditActorV1;
  delegation?: AssistantDelegation;
  action: string;
  resource: { type: string; identifier: string };
  requestId: string;
  idempotencyKeyHash?: string;
  operationId?: string;
  beforeRevision?: string;
  afterRevision?: string;
  outcome: AdministrativeAuditRecordV1["outcome"];
  now: () => bigint;
  random: (size: number) => Uint8Array;
}): AdministrativeAuditRecordV1 {
  const delegation = input.delegation?.toolCallId
    ? {
        conversationId: input.delegation.conversationId,
        toolCallId: input.delegation.toolCallId,
        ...(input.delegation.pendingActionId
          ? { pendingActionId: input.delegation.pendingActionId }
          : {})
      }
    : undefined;
  return AdministrativeAuditRecordV1Schema.parse({
    version: 1,
    eventId: randomToken(16, Base64Url16BytesSchema, input.random),
    timestamp: Uint64DecimalSchema.parse(input.now().toString()),
    actor: input.actor,
    origin: input.actor.kind === "local" ? "local" : "remote",
    ...(delegation ? { delegation } : {}),
    action: input.action,
    resource: input.resource,
    requestId: input.requestId,
    ...(input.idempotencyKeyHash ? { idempotencyKeyHash: input.idempotencyKeyHash } : {}),
    ...(input.operationId ? { operationId: input.operationId } : {}),
    ...(input.beforeRevision ? { beforeRevision: input.beforeRevision } : {}),
    ...(input.afterRevision ? { afterRevision: input.afterRevision } : {}),
    outcome: input.outcome
  });
}

async function appendStandaloneAudit(
  auditStore: AuditStore,
  input: {
    request: FastifyRequest;
    actor: AuditActorV1;
    delegation?: AssistantDelegation;
    action: string;
    resource: { type: string; identifier: string };
    requestId: string;
    idempotencyKeyHash?: string;
    operationId?: string;
    outcome: AdministrativeAuditRecordV1["outcome"];
    now: () => bigint;
    random: (size: number) => Uint8Array;
  }
): Promise<void> {
  try {
    await auditStore.append(buildAuditRecord({
      actor: input.actor,
      delegation: input.delegation,
      action: input.action,
      resource: input.resource,
      requestId: input.requestId,
      idempotencyKeyHash: input.idempotencyKeyHash,
      operationId: input.operationId,
      beforeRevision: requestRevision(input.request),
      outcome: input.outcome,
      now: input.now,
      random: input.random
    }));
  } catch {
    throw new ApiError(
      503,
      "Administrative audit could not be persisted; no effect was started.",
      undefined,
      "AuditUnavailable"
    );
  }
}

function requestRevision(request: FastifyRequest): string | undefined {
  const body = request.body;
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
    const revision = (body as Record<string, unknown>).revision;
    if (typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0) {
      return Uint64DecimalSchema.parse(revision.toString());
    }
  }
  const ifMatch = request.headers["if-match"];
  if (typeof ifMatch !== "string") return undefined;
  const normalized = ifMatch.replace(/^W\//u, "").replace(/^"|"$/gu, "");
  if (!/^(0|[1-9]\d*)$/u.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? Uint64DecimalSchema.parse(normalized) : undefined;
}

function responseRevision(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const candidate = body as Record<string, unknown>;
  const revision = candidate.revision ?? (
    candidate.latest && typeof candidate.latest === "object"
      ? (candidate.latest as Record<string, unknown>).revision
      : undefined
  );
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0
    ? Uint64DecimalSchema.parse(revision.toString())
    : undefined;
}

function responseErrorCode(body: unknown, statusCode: number): string {
  const candidate = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).error
    : undefined;
  const raw = typeof candidate === "string" ? candidate : `http_${statusCode}`;
  if (redactSecrets(raw) !== raw) return `http_${statusCode}`;
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return /^[a-z][a-z0-9_]{0,63}$/.test(normalized) ? normalized : `http_${statusCode}`;
}

function parseJsonPayload(payload: unknown): unknown {
  if (typeof payload !== "string" && !Buffer.isBuffer(payload)) return undefined;
  try {
    return JSON.parse(typeof payload === "string" ? payload : payload.toString("utf8"));
  } catch {
    return undefined;
  }
}

function storedResponseInput(
  reply: FastifyReply,
  payload: unknown
): { statusCode: number; contentType?: string; body: string | Uint8Array } | undefined {
  if (payload !== undefined && payload !== null && typeof payload !== "string") return undefined;
  const contentTypeHeader = reply.getHeader("content-type");
  const contentType = typeof contentTypeHeader === "string" ? contentTypeHeader : undefined;
  return {
    statusCode: reply.statusCode,
    ...(contentType ? { contentType } : {}),
    body: typeof payload === "string" ? redactSecrets(payload) : ""
  };
}

function randomToken<T extends string>(
  size: number,
  schema: { parse: (value: unknown) => T },
  random: (size: number) => Uint8Array
): T {
  return schema.parse(Buffer.from(random(size)).toString("base64url"));
}

function hashBytes(bytes: Uint8Array): string {
  return Base64Url32BytesSchema.parse(createHash("sha256").update(bytes).digest("base64url"));
}

function rawMutationMediaType(request: FastifyRequest): string | undefined {
  const value = request.headers["content-type"];
  if (typeof value !== "string") return undefined;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/octet-stream" || mediaType?.startsWith("image/") === true
    ? mediaType
    : undefined;
}

function rawMutationBodyPrefix(mediaType: string): Buffer {
  return Buffer.from(`binary\0${mediaType.toLowerCase()}\0`, "utf8");
}

function mutationConditionalPrefix(request: FastifyRequest): Buffer {
  const value = request.headers["if-match"];
  if (typeof value !== "string") return Buffer.alloc(0);
  const normalized = value.replace(/^W\//u, "").replace(/^"|"$/gu, "");
  const canonical = /^(0|[1-9]\d*)$/u.test(normalized)
    ? normalized
    : value.trim();
  return Buffer.from(`if-match\0${canonical}\0`, "utf8");
}
