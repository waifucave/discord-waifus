import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ModelPipeline } from "../../providers/types.js";
import {
  ApprovePairingInputV1Schema,
  PairInvitationV1Schema,
  PendingPairingRequestListV1Schema,
  type PendingPairingRequestV1
} from "../../shared/schemas/remoteLifecycle.js";
import { Base64Url32BytesSchema } from "../../shared/schemas/remoteProtocol.js";
import { ConversationStore, conversationOwner } from "./conversations.js";
import { AssistantTurnError, runAssistantTurn } from "./service.js";
import {
  withoutBrowserContext,
  type RequestPrincipal
} from "../requestPrincipal.js";
import { dispatchInternal } from "../internalDispatch.js";
import { ApiError, conflict, notFound } from "../errors.js";
import { redactRemoteHostDetails, redactSecrets } from "../../backend/redaction.js";
import {
  EVENT_AUTHORIZATION_HEARTBEAT_MS,
  MAX_EVENT_BYTES
} from "../../shared/schemas/adminOperations.js";
import { serializeSseEvent } from "../eventStream.js";
import {
  AssistantActionBrowserRequiredError,
  AssistantActionCapacityError,
  AssistantActionConflictError,
  AssistantActionExpiredError,
  AssistantActionNotFoundError,
  AssistantActionStore,
  AssistantActionTooLargeError,
  AssistantActionUnsafeContentError,
  assistantActionPayloadHash,
  retargetAssistantBrowserPrincipal,
  type AssistantActionLease,
  type AssistantActionReceipt
} from "./actions.js";
import type { RemoteAccessInvalidationListener } from "../../backend/remoteAccess/invalidation.js";

const MessageBodySchema = z.object({ content: z.string().min(1).max(8000) });
const ActionParamsSchema = z.object({ actionId: Base64Url32BytesSchema }).strict();
const EmptyActionBodySchema = z.object({}).strict();

export function registerAssistantRoutes(
  app: FastifyInstance,
  options: {
    dataRoot: string;
    createPipeline?: (target: { providerId: string; modelId: string }) => ModelPipeline;
    authorizePrincipal: (principal: RequestPrincipal) => boolean | Promise<boolean>;
    subscribeInvalidations?: (listener: RemoteAccessInvalidationListener) => () => void;
  }
): void {
  const store = new ConversationStore();
  const actions = new AssistantActionStore();
  const unsubscribeInvalidations = options.subscribeInvalidations?.((event) => {
    store.invalidateOwner(event.stableId, event.trustEpoch);
    actions.invalidateOwner(event.stableId, event.trustEpoch);
  });
  if (unsubscribeInvalidations) {
    app.addHook("onClose", async () => unsubscribeInvalidations());
  }

  app.post("/api/assistant/conversations", async (request) => {
    const { id } = store.create(conversationOwner(request.principal));
    return { conversationId: id };
  });

  app.get("/api/assistant/conversations", async (request) => ({
    conversations: store.list(conversationOwner(request.principal))
  }));

  app.get("/api/assistant/conversations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = store.get(id, conversationOwner(request.principal));
    if (!conversation) return reply.code(404).send({ error: "NotFound", message: "Unknown conversation." });
    return { id: conversation.id, busy: conversation.busy, messages: conversation.messages };
  });

  app.post("/api/assistant/conversations/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = MessageBodySchema.parse(request.body);
    try {
      const content = await runAssistantTurn(
        {
          app,
          store,
          actions,
          dataRoot: options.dataRoot,
          actor: conversationOwner(request.principal),
          principal: withoutBrowserContext(request.principal),
          authorizationPrincipal: request.principal,
          delegation: { conversationId: id },
          authorizePrincipal: options.authorizePrincipal,
          createPipeline: options.createPipeline
        },
        id,
        body.content
      );
      return { reply: content };
    } catch (error) {
      if (error instanceof AssistantTurnError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.delete("/api/assistant/conversations/:id", (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.delete(id, conversationOwner(request.principal))) {
      return reply.code(404).send({ error: "NotFound", message: "Unknown conversation." });
    }
    return { deleted: true };
  });

  app.get("/api/assistant/conversations/:id/stream", (request, reply) => {
    const { id } = request.params as { id: string };
    const owner = conversationOwner(request.principal);
    const conversation = store.get(id, owner);
    if (!conversation) {
      reply.code(404).send({ error: "NotFound", message: "Unknown conversation." });
      return;
    }
    sendAssistantEventStream({ request, reply, id, owner, store, options });
  });

  registerAssistantActionRoutes(app, actions, options);
}

class AssistantActionExecutionError extends Error {
  constructor(readonly statusCode: number) {
    super("The confirmed assistant action could not be completed.");
    this.name = "AssistantActionExecutionError";
  }
}

function registerAssistantActionRoutes(
  app: FastifyInstance,
  actions: AssistantActionStore,
  options: {
    authorizePrincipal: (principal: RequestPrincipal) => boolean | Promise<boolean>;
  }
): void {
  app.get("/api/assistant/actions/:actionId", async (request) => {
    try {
      const { actionId } = ActionParamsSchema.parse(request.params);
      const action = actions.get(actionId, request.principal);
      const detail = await assistantActionDetail(app, actions, action, request.principal);
      if (!await options.authorizePrincipal(request.principal)) {
        throw new ApiError(
          403,
          "The assistant action owner is no longer authorized.",
          undefined,
          "AssistantActionUnauthorized"
        );
      }
      return detail;
    } catch (error) {
      return assistantActionApiError(error);
    }
  });

  app.post("/api/assistant/actions/:actionId/confirm", async (request, reply) => {
    const { actionId } = ActionParamsSchema.parse(request.params);
    EmptyActionBodySchema.parse(request.body ?? {});
    let action: AssistantActionLease | undefined;
    let completed = false;
    try {
      action = actions.beginConsume(actionId, request.principal);
      if (!await options.authorizePrincipal(request.principal)) {
        throw new ApiError(
          403,
          "The assistant action owner is no longer authorized.",
          undefined,
          "AssistantActionUnauthorized"
        );
      }
      const executed = await executeAssistantAction(
        app,
        action,
        request.principal,
        options.authorizePrincipal
      );
      actions.complete(actionId, request.principal, executed.receipt);
      completed = true;
      if (!await options.authorizePrincipal(request.principal)) {
        throw new ApiError(
          403,
          "The assistant action owner is no longer authorized.",
          undefined,
          "AssistantActionUnauthorized"
        );
      }
      const body = {
        version: 1 as const,
        actionId,
        category: action.category,
        ...executed.receipt,
        ...(executed.invitation ? { invitation: executed.invitation } : {})
      };
      if (executed.invitation) {
        actions.rememberInvitation(
          executed.invitation.invitationId,
          executed.invitation.expiresAt,
          request.principal
        );
        return reply
          .header("content-type", "application/json; charset=utf-8")
          .send(JSON.stringify(body));
      }
      return body;
    } catch (error) {
      if (action && !completed) {
        try {
          actions.complete(actionId, request.principal, {
            status: "failed",
            message: "The confirmed action failed without exposing its request or response."
          });
        } catch {
          // A concurrent consume or owner invalidation remains terminal and takes precedence.
        }
      }
      return assistantActionApiError(error);
    }
  });

  app.delete("/api/assistant/actions/:actionId", async (request, reply) => {
    try {
      const { actionId } = ActionParamsSchema.parse(request.params);
      actions.cancel(actionId, request.principal);
      return reply.status(204).send();
    } catch (error) {
      return assistantActionApiError(error);
    }
  });
}

async function assistantActionDetail(
  app: FastifyInstance,
  actions: AssistantActionStore,
  action: AssistantActionLease,
  principal: RequestPrincipal
) {
  const detail = {
    version: 1 as const,
    actionId: action.actionId,
    category: action.category,
    summary: action.summary,
    expiresAt: action.expiresAt
  };
  if (action.operation.kind !== "derived_pairing_approval") return detail;
  const request = await currentPairingRequest(app, action, principal);
  const payload = pairingApprovalPayload(request);
  if (!sameHash(action.operation.payloadHash, assistantActionPayloadHash(payload))) {
    actions.discard(action.actionId);
    throw new AssistantActionConflictError("The pairing request changed; create a new approval action.");
  }
  return {
    ...detail,
    secure: {
      kind: "pairing_request" as const,
      requestId: request.requestId,
      claimedDisplayName: request.claimedDisplayName,
      claimedPlatform: request.claimedPlatform,
      expiresAt: request.expiresAt,
      sasWords: request.sasWords,
      sasFingerprint: request.sasFingerprint
    }
  };
}

async function executeAssistantAction(
  app: FastifyInstance,
  action: AssistantActionLease,
  principal: RequestPrincipal,
  authorizePrincipal: (principal: RequestPrincipal) => boolean | Promise<boolean>
): Promise<{
  receipt: AssistantActionReceipt;
  invitation?: z.infer<typeof PairInvitationV1Schema>;
}> {
  let payload: unknown;
  if (action.operation.kind === "derived_pairing_approval") {
    const request = await currentPairingRequest(app, action, principal);
    payload = pairingApprovalPayload(request);
  } else {
    payload = action.operation.payload;
  }
  if (!sameHash(action.operation.payloadHash, assistantActionPayloadHash(payload))) {
    throw new AssistantActionConflictError("The stored assistant action no longer matches its exact payload.");
  }
  if (!await authorizePrincipal(principal)) {
    throw new ApiError(
      403,
      "The assistant action owner is no longer authorized.",
      undefined,
      "AssistantActionUnauthorized"
    );
  }
  const delegatedPrincipal = retargetAssistantBrowserPrincipal(
    principal,
    action.operation.method,
    action.operation.canonicalTarget
  );
  const response = await dispatchInternal(
    app,
    delegatedPrincipal,
    { ...action.delegation, pendingActionId: action.actionId },
    {
      method: action.operation.method,
      url: action.operation.canonicalTarget,
      headers: { "idempotency-key": action.idempotencyKey },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
    }
  );
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new AssistantActionExecutionError(response.statusCode === 404 ? 409 : response.statusCode);
  }
  if (action.operation.resultPolicy === "pair_invitation") {
    const invitation = PairInvitationV1Schema.parse(response.json());
    return {
      receipt: {
        status: "completed",
        message: "A private pairing invitation was created.",
        resourceId: invitation.invitationId
      },
      invitation
    };
  }
  return {
    receipt: {
      status: "completed",
      message: actionReceiptMessage(action.category),
      resourceId: action.resource.identifier
    }
  };
}

async function currentPairingRequest(
  app: FastifyInstance,
  action: AssistantActionLease,
  principal: RequestPrincipal
): Promise<PendingPairingRequestV1> {
  if (action.operation.kind !== "derived_pairing_approval") {
    throw new TypeError("Expected a derived pairing approval action.");
  }
  const requestId = action.operation.requestId;
  const response = await dispatchInternal(
    app,
    withoutBrowserContext(principal),
    { ...action.delegation, pendingActionId: action.actionId },
    { method: "GET", url: "/api/remote-access/pairing-requests" }
  );
  if (response.statusCode !== 200) throw new AssistantActionExecutionError(response.statusCode);
  const requests = PendingPairingRequestListV1Schema.parse(response.json()).requests;
  const request = requests.find((candidate) => candidate.requestId === requestId);
  if (!request) throw new AssistantActionConflictError("The pairing request is no longer pending.");
  return request;
}

function pairingApprovalPayload(request: PendingPairingRequestV1) {
  return ApprovePairingInputV1Schema.parse({
    invitationGeneration: request.invitationGeneration,
    remoteIdentityBundleHash: request.remoteIdentityBundleHash,
    transcriptHash: request.transcriptHash,
    channelBinding: request.channelBinding,
    sasIndices: request.sasIndices,
    sasFingerprint: request.sasFingerprint
  });
}

function sameHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "base64url");
  const rightBytes = Buffer.from(right, "base64url");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function actionReceiptMessage(category: string): string {
  if (category === "remote_access_enable") return "Remote Access was enabled.";
  if (category === "remote_access_disable") return "Remote Access was disabled.";
  if (category === "remote_pairing_approval") return "The pairing request was approved.";
  if (category === "remote_invitation_cancel") return "The pairing invitation was cancelled.";
  if (category === "remote_device_revoke") return "The trusted remote device was revoked.";
  return "The confirmed assistant action completed.";
}

function assistantActionApiError(error: unknown): never {
  if (error instanceof AssistantActionBrowserRequiredError) {
    throw new ApiError(403, error.message, undefined, "AssistantBrowserRequired");
  }
  if (error instanceof AssistantActionNotFoundError) throw notFound("Assistant action was not found.");
  if (error instanceof AssistantActionExpiredError) {
    throw new ApiError(410, error.message, undefined, "AssistantActionExpired");
  }
  if (error instanceof AssistantActionConflictError) throw conflict(error.message);
  if (error instanceof AssistantActionCapacityError) {
    throw new ApiError(503, error.message, undefined, "AssistantActionCapacity");
  }
  if (error instanceof AssistantActionTooLargeError) {
    throw new ApiError(413, error.message, undefined, "AssistantActionTooLarge");
  }
  if (error instanceof AssistantActionUnsafeContentError) {
    throw new ApiError(400, error.message, undefined, "AssistantActionUnsafeContent");
  }
  if (error instanceof AssistantActionExecutionError) {
    throw new ApiError(
      error.statusCode,
      error.message,
      undefined,
      "AssistantActionExecutionFailed"
    );
  }
  throw error;
}

function sendAssistantEventStream(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  id: string;
  owner: ReturnType<typeof conversationOwner>;
  store: ConversationStore;
  options: {
    dataRoot: string;
    authorizePrincipal: (principal: RequestPrincipal) => boolean | Promise<boolean>;
  };
}): void {
  const { request, reply } = input;
  const stream = input.store.eventStream(input.id, input.owner);
  if (!stream) return;
  const writeEvent = (event: string, value: unknown, cursor?: string): void => {
    if (reply.raw.destroyed || reply.raw.writableEnded) throw new Error("SSE connection is closed.");
    reply.raw.write(serializeSseEvent({ event, data: value, ...(cursor ? { cursor } : {}) }));
  };
  const redact = (principal: RequestPrincipal, value: unknown): unknown =>
    principal.kind === "remote_device"
      ? redactRemoteHostDetails(value, [input.options.dataRoot])
      : redactSecrets(value);
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive"
  });
  const suppliedCursor = request.headers["last-event-id"];
  const subscription = stream.subscribeAuthorized({
    principal: request.principal,
    ...(typeof suppliedCursor === "string" && suppliedCursor
      ? { lastEventId: suppliedCursor }
      : {}),
    authorize: async (principal) =>
      input.store.isOwner(input.id, conversationOwner(principal))
      && await input.options.authorizePrincipal(principal),
    project: (principal, _event, data) => redact(principal, data),
    snapshot: () => {
      const conversation = input.store.get(input.id, input.owner);
      return conversation
        ? {
            version: 1 as const,
            id: conversation.id,
            busy: conversation.busy,
            messages: conversation.messages
          }
        : { version: 1 as const, id: input.id, busy: false, messages: [] };
    },
    projectSnapshot: (principal, snapshot) => boundAssistantSnapshot(redact(principal, snapshot)),
    onReset: (reset) => writeEvent("snapshot_required", reset),
    onSnapshot: (snapshot, cursor) => writeEvent("snapshot", snapshot, cursor),
    onEvent: (event, data, cursor) => writeEvent(event, data, cursor),
    onUnauthorized: () => endAssistantSse(reply),
    onClose: () => endAssistantSse(reply),
    onError: () => endAssistantSse(reply)
  });
  const heartbeat = setInterval(() => {
    void subscription.heartbeat(() => {
      writeEvent("heartbeat", { time: new Date().toISOString() });
    });
  }, EVENT_AUTHORIZATION_HEARTBEAT_MS);
  const cleanup = (): void => {
    clearInterval(heartbeat);
    subscription.close();
  };
  request.raw.once("close", cleanup);
  reply.raw.once("error", cleanup);
  void subscription.ready;
}

function boundAssistantSnapshot(value: unknown): unknown {
  const snapshot = structuredClone(value) as { messages?: unknown[] };
  const targetBytes = MAX_EVENT_BYTES - 512;
  while (
    Array.isArray(snapshot.messages)
    && snapshot.messages.length > 0
    && Buffer.byteLength(JSON.stringify(snapshot), "utf8") > targetBytes
  ) {
    snapshot.messages.shift();
  }
  return snapshot;
}

function endAssistantSse(reply: FastifyReply): void {
  if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
}
