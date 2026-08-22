import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ModelPipeline } from "../../providers/types.js";
import { ConversationStore } from "./conversations.js";
import { AssistantTurnError, runAssistantTurn } from "./service.js";
import {
  withoutBrowserContext,
  type RequestPrincipal
} from "../requestPrincipal.js";
import { redactRemoteHostDetails, redactSecrets } from "../../backend/redaction.js";
import {
  EVENT_AUTHORIZATION_HEARTBEAT_MS,
  MAX_EVENT_BYTES
} from "../../shared/schemas/adminOperations.js";
import { serializeSseEvent } from "../eventStream.js";

const MessageBodySchema = z.object({ content: z.string().min(1).max(8000) });

export function registerAssistantRoutes(
  app: FastifyInstance,
  options: {
    dataRoot: string;
    createPipeline?: (target: { providerId: string; modelId: string }) => ModelPipeline;
    authorizePrincipal: (principal: RequestPrincipal) => boolean | Promise<boolean>;
  }
): void {
  const store = new ConversationStore();

  app.post("/api/assistant/conversations", async () => {
    const { id } = store.create();
    return { conversationId: id };
  });

  app.get("/api/assistant/conversations", async () => ({ conversations: store.list() }));

  app.get("/api/assistant/conversations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = store.get(id);
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
          dataRoot: options.dataRoot,
          principal: withoutBrowserContext(request.principal),
          delegation: { conversationId: id },
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
    if (!store.delete(id)) {
      return reply.code(404).send({ error: "NotFound", message: "Unknown conversation." });
    }
    return { deleted: true };
  });

  app.get("/api/assistant/conversations/:id/stream", (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = store.get(id);
    if (!conversation) {
      reply.code(404).send({ error: "NotFound", message: "Unknown conversation." });
      return;
    }
    sendAssistantEventStream({ request, reply, id, store, options });
  });
}

function sendAssistantEventStream(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  id: string;
  store: ConversationStore;
  options: {
    dataRoot: string;
    authorizePrincipal: (principal: RequestPrincipal) => boolean | Promise<boolean>;
  };
}): void {
  const { request, reply } = input;
  const stream = input.store.eventStream(input.id);
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
    authorize: input.options.authorizePrincipal,
    project: (principal, _event, data) => redact(principal, data),
    snapshot: () => {
      const conversation = input.store.get(input.id);
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
