// `/norma <text>` from Discord (Living cast spec §36): Norma, the dashboard assistant, answers a
// Discord user that `permissions.norma` lists, whatever their roles in the server. She runs as the
// host's local principal through the same tools as the dashboard, in a conversation of her own per
// Discord user (kept while they keep talking, reset after DISCORD_NORMA_IDLE_MS), and her final
// answer is the reply. The list is read at every turn and at every tool call, so removing someone
// stops them mid-turn. Changes that need a confirmation card are refused (nobody can click one from
// Discord), and so is changing `permissions.norma` (the config route refuses an assistant write to
// it without a confirmed card).

import type { FastifyInstance } from "fastify";
import { loadAppConfig } from "../../config/appConfig.js";
import { sharedModelClient } from "../../models/client.js";
import { LOCAL_REQUEST_PRINCIPAL } from "../requestPrincipal.js";
import { AssistantActionStore, type AssistantActionSummary } from "./actions.js";
import { ConversationStore, type ConversationOwner } from "./conversations.js";
import { AssistantTurnError, runAssistantTurn, type AssistantModelClient } from "./service.js";

export type DiscordNormaRequest = { userId: string; text: string };
export type AskNorma = (request: DiscordNormaRequest) => Promise<string>;

/** A Discord user's conversation with Norma starts over after this long without a message. */
export const DISCORD_NORMA_IDLE_MS = 30 * 60_000;

export const DISCORD_NORMA_CARD_REFUSAL =
  "This change needs the owner's confirmation on a dashboard card, which can't be given from Discord. Tell the user to make it in the Discord Waifus dashboard.";

/** Every proposal is refused: a card nobody can click would only wait and expire. */
class DiscordActionStore extends AssistantActionStore {
  override create(): AssistantActionSummary {
    throw new Error(DISCORD_NORMA_CARD_REFUSAL);
  }
}

function discordOwner(userId: string): ConversationOwner {
  return Object.freeze({ kind: "local" as const, stableId: `discord:${userId}`, trustEpoch: null, browserSessionId: null });
}

/** What Norma sees before the user's words, so she knows where she is answering. */
export function discordNormaMessage(userId: string, text: string): string {
  return `[/norma in Discord from user ${userId}: only they see your final answer, as a Discord message. Confirmation cards can't be shown or clicked here.]\n\n${text}`;
}

export async function normaAllowed(dataRoot: string, userId: string): Promise<boolean> {
  const config = await loadAppConfig(dataRoot);
  return config.permissions.norma.includes(userId);
}

export function createDiscordNorma(
  app: FastifyInstance,
  options: { dataRoot: string; modelClient?: AssistantModelClient; now?: () => number }
): AskNorma {
  const store = new ConversationStore();
  const actions = new DiscordActionStore();
  const now = options.now ?? Date.now;
  const conversations = new Map<string, { id: string; lastAt: number }>();

  return async ({ userId, text }) => {
    if (!(await normaAllowed(options.dataRoot, userId))) {
      return "You can't use /norma. The owner can allow you in Discord Waifus → Settings → Permissions.";
    }
    const owner = discordOwner(userId);
    const previous = conversations.get(userId);
    const reuse = previous && now() - previous.lastAt < DISCORD_NORMA_IDLE_MS && store.get(previous.id, owner);
    if (previous && !reuse) store.delete(previous.id, owner);
    const id = reuse ? previous.id : store.create(owner).id;
    conversations.set(userId, { id, lastAt: now() });
    try {
      const answer = await runAssistantTurn(
        {
          app,
          store,
          actions,
          dataRoot: options.dataRoot,
          actor: owner,
          principal: LOCAL_REQUEST_PRINCIPAL,
          authorizationPrincipal: LOCAL_REQUEST_PRINCIPAL,
          delegation: { conversationId: id },
          authorizePrincipal: () => normaAllowed(options.dataRoot, userId),
          modelClient: options.modelClient ?? sharedModelClient(options.dataRoot)
        },
        id,
        discordNormaMessage(userId, text)
      );
      conversations.set(userId, { id, lastAt: now() });
      return answer.trim() || "Norma finished without an answer.";
    } catch (error) {
      if (error instanceof AssistantTurnError && error.statusCode === 409) return "Norma is still answering your last /norma. Try again when it's done.";
      if (error instanceof AssistantTurnError && error.statusCode === 403) return "You can't use /norma any more.";
      return `Norma couldn't answer: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
}
