import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ModelPipeline } from "../../providers/types.js";
import { ConversationStore } from "./conversations.js";
import { AssistantTurnError, runAssistantTurn } from "./service.js";

const MessageBodySchema = z.object({ content: z.string().min(1).max(8000) });

export function registerAssistantRoutes(
  app: FastifyInstance,
  options: {
    dataRoot: string;
    createPipeline?: (target: { providerId: string; modelId: string }) => ModelPipeline;
  }
): void {
  const store = new ConversationStore();

  app.post("/api/assistant/conversations", async () => {
    const { id } = store.create();
    return { conversationId: id };
  });

  app.get("/api/assistant/conversations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = store.get(id);
    if (!conversation) return reply.code(404).send({ error: "unknown conversation" });
    return { id: conversation.id, busy: conversation.busy, messages: conversation.messages };
  });

  app.post("/api/assistant/conversations/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = MessageBodySchema.parse(request.body);
    try {
      const content = await runAssistantTurn(
        { app, store, dataRoot: options.dataRoot, createPipeline: options.createPipeline },
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

  app.get("/api/assistant/conversations/:id/stream", (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = store.get(id);
    if (!conversation) {
      reply.code(404).send({ error: "unknown conversation" });
      return;
    }
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    // Replay recorded events so a reopened panel catches up, then stream live.
    for (const message of conversation.messages) {
      if (message.role === "event") {
        reply.raw.write(`event: assistant\ndata: ${JSON.stringify(message.event)}\n\n`);
      }
    }
    const unsubscribe = store.subscribe(id, (event) => {
      reply.raw.write(`event: assistant\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => {
      reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
    }, 30_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    });
  });
}
