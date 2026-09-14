import { createHash, randomBytes } from "node:crypto";
import {
  Base64Url16BytesSchema,
  Base64Url32BytesSchema,
  type HttpMethod
} from "../../shared/schemas/remoteProtocol.js";
import { redactSecrets } from "../../backend/redaction.js";
import {
  canonicalMutationBodyBytes,
  canonicalMutationTarget
} from "../mutations.js";
import {
  createLocalRequestPrincipal,
  createRemoteRequestPrincipal,
  type AssistantDelegation,
  type RequestPrincipal
} from "../requestPrincipal.js";

export const ASSISTANT_ACTION_TTL_MS = 5 * 60 * 1000;
export const MAX_ASSISTANT_ACTIONS_PER_OWNER = 16;
export const MAX_ASSISTANT_ACTIONS = 256;
export const MAX_ASSISTANT_ACTION_BYTES = 4 * 1024 * 1024;
export const MAX_ASSISTANT_ACTION_RECORD_BYTES = 32 * 1024;
export const MAX_ASSISTANT_ACTION_SUMMARY_BYTES = 8 * 1024;
export const MAX_ASSISTANT_ACTION_RECEIPT_BYTES = 8 * 1024;

const RECEIPT_RESERVATION_BYTES = MAX_ASSISTANT_ACTION_RECEIPT_BYTES + 1_024;
const CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const RESOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;

export type AssistantActionOwner = Readonly<{
  kind: RequestPrincipal["kind"];
  stableId: string;
  trustEpoch: string | null;
  browserLaunchId: string;
  browserSessionId: string;
}>;

export type AssistantExactHttpOperation = Readonly<{
  kind: "exact_http";
  method: "POST" | "PUT" | "DELETE";
  canonicalTarget: string;
  payload?: unknown;
  payloadHash: string;
  resultPolicy: "receipt" | "pair_invitation";
}>;

export type AssistantDerivedPairingApprovalOperation = Readonly<{
  kind: "derived_pairing_approval";
  method: "POST";
  canonicalTarget: string;
  requestId: string;
  payloadHash: string;
  resultPolicy: "receipt";
}>;

export type AssistantActionOperation =
  | AssistantExactHttpOperation
  | AssistantDerivedPairingApprovalOperation;

export type AssistantActionProposal = Readonly<{
  category: string;
  summary: string;
  resource: Readonly<{ type: string; identifier: string }>;
  operation:
    | Readonly<{
        kind: "exact_http";
        method: "POST" | "PUT" | "DELETE";
        canonicalTarget: string;
        payload?: unknown;
        resultPolicy?: "receipt" | "pair_invitation";
      }>
    | Readonly<{
        kind: "derived_pairing_approval";
        method: "POST";
        canonicalTarget: string;
        requestId: string;
        expectedPayload: unknown;
      }>;
}>;

export type AssistantActionSummary = Readonly<{
  version: 1;
  actionId: string;
  category: string;
  summary: string;
  expiresAt: string;
}>;

export type AssistantActionReceipt = Readonly<{
  status: "completed" | "failed";
  message: string;
  resourceId?: string;
}>;

export type AssistantActionLease = Readonly<{
  actionId: string;
  owner: AssistantActionOwner;
  category: string;
  summary: string;
  resource: Readonly<{ type: string; identifier: string }>;
  operation: AssistantActionOperation;
  delegation: AssistantDelegation;
  idempotencyKey: string;
  expiresAt: string;
}>;

type AssistantActionRecord = {
  readonly actionId: string;
  readonly owner: AssistantActionOwner;
  readonly category: string;
  readonly summary: string;
  readonly resource: Readonly<{ type: string; identifier: string }>;
  readonly operation: AssistantActionOperation;
  readonly delegation: AssistantDelegation;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly expiresAtMs: number;
  readonly accountedBytes: number;
  state: "pending" | "executing" | "completed" | "failed" | "cancelled";
  receipt?: AssistantActionReceipt;
};

type InvitationOwner = {
  readonly owner: AssistantActionOwner;
  readonly expiresAtMs: number;
};

export type AssistantActionStoreOptions = {
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
};

export class AssistantActionBrowserRequiredError extends Error {
  constructor() {
    super("A bound browser session is required for assistant actions.");
    this.name = "AssistantActionBrowserRequiredError";
  }
}

export class AssistantActionNotFoundError extends Error {
  constructor() {
    super("Assistant action was not found.");
    this.name = "AssistantActionNotFoundError";
  }
}

export class AssistantActionExpiredError extends Error {
  constructor() {
    super("Assistant action expired.");
    this.name = "AssistantActionExpiredError";
  }
}

export class AssistantActionConflictError extends Error {
  constructor(message = "Assistant action was already consumed or cancelled.") {
    super(message);
    this.name = "AssistantActionConflictError";
  }
}

export class AssistantActionCapacityError extends Error {
  constructor(message = "Assistant action capacity is exhausted.") {
    super(message);
    this.name = "AssistantActionCapacityError";
  }
}

export class AssistantActionTooLargeError extends Error {
  constructor(message = "Assistant action exceeds its size limit.") {
    super(message);
    this.name = "AssistantActionTooLargeError";
  }
}

export class AssistantActionUnsafeContentError extends Error {
  constructor() {
    super("Assistant action summary, payload, or receipt contains forbidden secret material.");
    this.name = "AssistantActionUnsafeContentError";
  }
}

export function assistantActionOwner(principal: RequestPrincipal): AssistantActionOwner {
  if (principal.kind === "remote_device") {
    const context = principal.browserContext;
    if (!context) throw new AssistantActionBrowserRequiredError();
    return deepFreeze({
      kind: principal.kind,
      stableId: principal.stableId,
      trustEpoch: principal.trustEpoch,
      browserLaunchId: context.gatewayLaunchId,
      browserSessionId: context.browserSessionId
    });
  }
  const context = principal.browserContext;
  if (!context) throw new AssistantActionBrowserRequiredError();
  return deepFreeze({
    kind: principal.kind,
    stableId: principal.stableId,
    trustEpoch: null,
    browserLaunchId: context.hostServerLaunchId,
    browserSessionId: context.browserSessionId
  });
}

export function assistantActionPayloadHash(payload: unknown): string {
  return Base64Url32BytesSchema.parse(
    createHash("sha256").update(canonicalMutationBodyBytes(payload)).digest("base64url")
  );
}

export function retargetAssistantBrowserPrincipal(
  principal: RequestPrincipal,
  method: Extract<HttpMethod, "POST" | "PUT" | "DELETE">,
  rawTarget: string,
  random: (size: number) => Uint8Array = randomBytes
): RequestPrincipal {
  const canonicalTarget = canonicalMutationTarget(rawTarget);
  if (principal.kind === "remote_device") {
    const context = principal.browserContext;
    if (!context) throw new AssistantActionBrowserRequiredError();
    const { browserContext: _browserContext, ...wire } = principal;
    return createRemoteRequestPrincipal({
      ...wire,
      browserContext: {
        version: 1,
        verifiedBy: "host_helper",
        gatewayLaunchId: context.gatewayLaunchId,
        browserSessionId: context.browserSessionId,
        requestNonce: Base64Url16BytesSchema.parse(Buffer.from(random(16)).toString("base64url")),
        method,
        canonicalTarget,
        csrfValidated: true
      }
    });
  }
  const context = principal.browserContext;
  if (!context) throw new AssistantActionBrowserRequiredError();
  return createLocalRequestPrincipal({
    verifiedBy: "host_server",
    hostServerLaunchId: context.hostServerLaunchId,
    browserSessionId: context.browserSessionId,
    requestNonce: Base64Url16BytesSchema.parse(Buffer.from(random(16)).toString("base64url")),
    method,
    canonicalTarget,
    csrfValidated: true
  });
}

export class AssistantActionStore {
  private readonly records = new Map<string, AssistantActionRecord>();
  private readonly invitationOwners = new Map<string, InvitationOwner>();
  private readonly now: () => number;
  private readonly random: (size: number) => Uint8Array;
  private accountedBytes = 0;

  constructor(options: AssistantActionStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.randomBytes ?? randomBytes;
  }

  create(input: {
    principal: RequestPrincipal;
    delegation: AssistantDelegation;
    proposal: AssistantActionProposal;
  }): AssistantActionSummary {
    const now = this.currentTime();
    this.prune(now, true);
    const owner = assistantActionOwner(input.principal);
    const category = validatedCategory(input.proposal.category);
    const summary = boundedText(input.proposal.summary, MAX_ASSISTANT_ACTION_SUMMARY_BYTES, "summary");
    const resource = validatedResource(input.proposal.resource);
    const operation = normalizedOperation(input.proposal.operation);
    const delegation = deepFreeze(structuredClone(input.delegation));
    const ownedLiveCount = [...this.records.values()].filter((record) =>
      isLive(record) && sameActionOwner(record.owner, owner)
    ).length;
    if (ownedLiveCount >= MAX_ASSISTANT_ACTIONS_PER_OWNER) {
      throw new AssistantActionCapacityError("This browser session has too many live assistant actions.");
    }
    const liveCount = [...this.records.values()].filter(isLive).length;
    if (liveCount >= MAX_ASSISTANT_ACTIONS) throw new AssistantActionCapacityError();

    const actionId = this.newToken(32, Base64Url32BytesSchema);
    const idempotencyKey = this.newToken(32, Base64Url32BytesSchema);
    const createdAt = new Date(now).toISOString();
    const expiresAtMs = now + ASSISTANT_ACTION_TTL_MS;
    const expiresAt = new Date(expiresAtMs).toISOString();
    const recordBase = {
      actionId,
      owner,
      category,
      summary,
      resource,
      operation,
      delegation,
      idempotencyKey,
      createdAt,
      expiresAt,
      expiresAtMs,
      state: "pending" as const
    };
    const baseBytes = recordBytes(recordBase);
    const accountedBytes = baseBytes + RECEIPT_RESERVATION_BYTES;
    if (accountedBytes > MAX_ASSISTANT_ACTION_RECORD_BYTES) {
      throw new AssistantActionTooLargeError();
    }
    if (this.accountedBytes + accountedBytes > MAX_ASSISTANT_ACTION_BYTES) {
      throw new AssistantActionCapacityError("Assistant action storage capacity is exhausted.");
    }
    const record: AssistantActionRecord = {
      ...recordBase,
      accountedBytes
    };
    this.records.set(actionId, record);
    this.accountedBytes += accountedBytes;
    return publicSummary(record);
  }

  get(actionIdValue: string, principal: RequestPrincipal): AssistantActionLease {
    const actionId = Base64Url32BytesSchema.parse(actionIdValue);
    const owner = assistantActionOwner(principal);
    const record = this.records.get(actionId);
    if (!record || !sameActionOwner(record.owner, owner)) throw new AssistantActionNotFoundError();
    if (this.currentTime() >= record.expiresAtMs) {
      this.remove(record);
      throw new AssistantActionExpiredError();
    }
    if (record.state !== "pending") throw new AssistantActionConflictError();
    return lease(record);
  }

  beginConsume(actionIdValue: string, principal: RequestPrincipal): AssistantActionLease {
    const action = this.get(actionIdValue, principal);
    const record = this.records.get(action.actionId);
    if (!record || record.state !== "pending") throw new AssistantActionConflictError();
    record.state = "executing";
    return action;
  }

  complete(
    actionIdValue: string,
    principal: RequestPrincipal,
    receiptValue: AssistantActionReceipt
  ): void {
    const actionId = Base64Url32BytesSchema.parse(actionIdValue);
    const owner = assistantActionOwner(principal);
    const record = this.records.get(actionId);
    if (!record || !sameActionOwner(record.owner, owner)) throw new AssistantActionNotFoundError();
    if (record.state !== "executing") throw new AssistantActionConflictError();
    const receipt = validatedReceipt(receiptValue);
    const completed = {
      ...record,
      state: receipt.status,
      receipt
    };
    if (recordBytes(completed) > MAX_ASSISTANT_ACTION_RECORD_BYTES) {
      throw new AssistantActionTooLargeError("Assistant action receipt exceeds its record limit.");
    }
    record.state = receipt.status;
    record.receipt = receipt;
  }

  cancel(actionIdValue: string, principal: RequestPrincipal): void {
    const action = this.get(actionIdValue, principal);
    const record = this.records.get(action.actionId);
    if (!record || record.state !== "pending") throw new AssistantActionConflictError();
    record.state = "cancelled";
  }

  discard(actionIdValue: string): void {
    const parsed = Base64Url32BytesSchema.safeParse(actionIdValue);
    if (!parsed.success) return;
    const record = this.records.get(parsed.data);
    if (record) this.remove(record);
  }

  rememberInvitation(
    invitationIdValue: string,
    expiresAtSecondsValue: string,
    principal: RequestPrincipal
  ): void {
    const invitationId = Base64Url16BytesSchema.parse(invitationIdValue);
    const owner = assistantActionOwner(principal);
    const seconds = BigInt(expiresAtSecondsValue);
    const maxSeconds = BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000));
    const expiresAtMs = seconds > maxSeconds ? Number.MAX_SAFE_INTEGER : Number(seconds) * 1000;
    this.pruneInvitationOwners(this.currentTime());
    if (this.invitationOwners.size >= MAX_ASSISTANT_ACTIONS && !this.invitationOwners.has(invitationId)) {
      return;
    }
    this.invitationOwners.set(invitationId, { owner, expiresAtMs });
  }

  ownsInvitation(invitationIdValue: string, principal: RequestPrincipal): boolean {
    const parsed = Base64Url16BytesSchema.safeParse(invitationIdValue);
    if (!parsed.success) return false;
    const owner = assistantActionOwner(principal);
    this.pruneInvitationOwners(this.currentTime());
    const invitation = this.invitationOwners.get(parsed.data);
    return invitation !== undefined && sameActionOwner(invitation.owner, owner);
  }

  forgetInvitation(invitationIdValue: string): void {
    const parsed = Base64Url16BytesSchema.safeParse(invitationIdValue);
    if (parsed.success) this.invitationOwners.delete(parsed.data);
  }

  stats(): Readonly<{ records: number; live: number; accountedBytes: number }> {
    const now = this.currentTime();
    this.prune(now, false);
    return Object.freeze({
      records: this.records.size,
      live: [...this.records.values()].filter(isLive).length,
      accountedBytes: this.accountedBytes
    });
  }

  private prune(now: number, removeTerminal: boolean): void {
    for (const record of [...this.records.values()]) {
      if (now >= record.expiresAtMs || (removeTerminal && !isLive(record))) this.remove(record);
    }
    this.pruneInvitationOwners(now);
  }

  private pruneInvitationOwners(now: number): void {
    for (const [invitationId, invitation] of this.invitationOwners) {
      if (now >= invitation.expiresAtMs) this.invitationOwners.delete(invitationId);
    }
  }

  private remove(record: AssistantActionRecord): void {
    if (!this.records.delete(record.actionId)) return;
    this.accountedBytes -= record.accountedBytes;
  }

  private newToken<T extends string>(
    size: number,
    schema: { parse(value: unknown): T }
  ): T {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = schema.parse(Buffer.from(this.random(size)).toString("base64url"));
      if (!this.records.has(token)) return token;
    }
    throw new AssistantActionCapacityError("Could not allocate a unique assistant action ID.");
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) throw new RangeError("Assistant action clock is invalid.");
    return value;
  }
}

function normalizedOperation(proposal: AssistantActionProposal["operation"]): AssistantActionOperation {
  const canonicalTarget = canonicalMutationTarget(proposal.canonicalTarget);
  if (proposal.kind === "derived_pairing_approval") {
    return deepFreeze({
      kind: proposal.kind,
      method: proposal.method,
      canonicalTarget,
      requestId: Base64Url16BytesSchema.parse(proposal.requestId),
      payloadHash: assistantActionPayloadHash(proposal.expectedPayload),
      resultPolicy: "receipt" as const
    });
  }
  const payload = proposal.payload === undefined
    ? undefined
    : deepFreeze(structuredClone(proposal.payload));
  assertAssistantSafe(payload);
  return deepFreeze({
    kind: proposal.kind,
    method: proposal.method,
    canonicalTarget,
    ...(payload === undefined ? {} : { payload }),
    payloadHash: assistantActionPayloadHash(payload),
    resultPolicy: proposal.resultPolicy ?? "receipt"
  });
}

function validatedCategory(value: string): string {
  if (!CATEGORY_PATTERN.test(value)) throw new TypeError("Invalid assistant action category.");
  return value;
}

function validatedResource(
  value: AssistantActionProposal["resource"]
): Readonly<{ type: string; identifier: string }> {
  if (!RESOURCE_TYPE_PATTERN.test(value.type)) throw new TypeError("Invalid assistant action resource type.");
  const identifier = boundedText(value.identifier, 256, "resource identifier");
  return deepFreeze({ type: value.type, identifier });
}

function validatedReceipt(value: AssistantActionReceipt): AssistantActionReceipt {
  assertAssistantSafe(value);
  const message = boundedText(value.message, MAX_ASSISTANT_ACTION_RECEIPT_BYTES, "receipt");
  const resourceId = value.resourceId === undefined
    ? undefined
    : boundedText(value.resourceId, 256, "receipt resource ID");
  return deepFreeze({
    status: value.status,
    message,
    ...(resourceId ? { resourceId } : {})
  });
}

function boundedText(value: string, maxBytes: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new AssistantActionTooLargeError(`Assistant action ${label} is empty or too large.`);
  }
  assertAssistantSafe(value);
  return value;
}

function assertAssistantSafe(value: unknown): void {
  if (JSON.stringify(redactSecrets(value)) !== JSON.stringify(value)) {
    throw new AssistantActionUnsafeContentError();
  }
}

function sameActionOwner(left: AssistantActionOwner, right: AssistantActionOwner): boolean {
  return left.kind === right.kind
    && left.stableId === right.stableId
    && left.trustEpoch === right.trustEpoch
    && left.browserLaunchId === right.browserLaunchId
    && left.browserSessionId === right.browserSessionId;
}

function isLive(record: AssistantActionRecord): boolean {
  return record.state === "pending" || record.state === "executing";
}

function publicSummary(record: AssistantActionRecord): AssistantActionSummary {
  return deepFreeze({
    version: 1 as const,
    actionId: record.actionId,
    category: record.category,
    summary: record.summary,
    expiresAt: record.expiresAt
  });
}

function lease(record: AssistantActionRecord): AssistantActionLease {
  return deepFreeze({
    actionId: record.actionId,
    owner: structuredClone(record.owner),
    category: record.category,
    summary: record.summary,
    resource: structuredClone(record.resource),
    operation: structuredClone(record.operation),
    delegation: structuredClone(record.delegation),
    idempotencyKey: record.idempotencyKey,
    expiresAt: record.expiresAt
  });
}

function recordBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
