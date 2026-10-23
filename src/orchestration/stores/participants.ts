// Active chat participants: humans seen recently in a channel (7-day TTL), used for prompt
// rosters and stop sequences.

import path from "node:path";
import {
  ActiveChatParticipant,
  ActiveChatParticipantsFile,
  ActiveChatParticipantsFileSchema,
  createEmptyRevisionedFile
} from "../../shared/schemas/domain.js";
import { StorageService } from "../../storage/storageService.js";
import type { ContextMessage } from "../context.js";

const ACTIVE_CHAT_PARTICIPANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function noteActiveChatParticipant(
  storage: StorageService,
  guildId: string,
  channelId: string,
  participant: { userId: string; displayName: string }
): Promise<void> {
  await noteActiveChatParticipants(storage, guildId, channelId, [participant]);
}

export async function noteActiveChatParticipantsFromContext(
  storage: StorageService,
  guildId: string,
  channelId: string,
  messages: ContextMessage[]
): Promise<void> {
  const participants = messages
    .filter((message) => message.authorKind === "user" && !message.authorBot)
    .map((message) => ({
      userId: message.authorId,
      displayName: message.displayName
    }));
  await noteActiveChatParticipants(storage, guildId, channelId, participants);
}

export async function noteActiveChatParticipants(
  storage: StorageService,
  guildId: string,
  channelId: string,
  participants: Array<{ userId: string; displayName: string }>
): Promise<void> {
  const validParticipants = participants
    .map((participant) => ({
      userId: participant.userId.trim(),
      displayName: participant.displayName.trim()
    }))
    .filter((participant) => participant.userId.length > 0 && participant.displayName.length > 0);
  if (validParticipants.length === 0) return;

  const now = Date.now();
  const lastSeenAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ACTIVE_CHAT_PARTICIPANT_TTL_MS).toISOString();
  await storage.updateRevisionedJson({
    resourceKey: activeChatParticipantsResourceKey(guildId, channelId),
    relativePath: activeChatParticipantsRelativePath(guildId, channelId),
    schema: ActiveChatParticipantsFileSchema,
    fallback: emptyActiveChatParticipantsFile(guildId, channelId),
    transform: (current) => {
      const byUserId = new Map<string, ActiveChatParticipant>();
      for (const entry of current.participants) {
        if (Date.parse(entry.expiresAt) > now) {
          byUserId.set(entry.userId, entry);
        }
      }
      for (const participant of validParticipants) {
        byUserId.set(participant.userId, {
          userId: participant.userId,
          displayName: participant.displayName,
          lastSeenAt,
          expiresAt
        });
      }
      return {
        ...current,
        guildId,
        channelId,
        participants: sortActiveChatParticipants([...byUserId.values()])
      };
    }
  });
}

export async function readActiveChatParticipants(storage: StorageService, guildId: string, channelId: string): Promise<ActiveChatParticipant[]> {
  const now = Date.now();
  const current = await storage.readJson(
    activeChatParticipantsRelativePath(guildId, channelId),
    ActiveChatParticipantsFileSchema,
    emptyActiveChatParticipantsFile(guildId, channelId)
  );
  return sortActiveChatParticipants(
    current.participants.filter((participant) => Date.parse(participant.expiresAt) > now)
  );
}

function activeChatParticipantsResourceKey(guildId: string, channelId: string): string {
  return `active-chat-participants:${guildId}:${channelId}`;
}

function activeChatParticipantsRelativePath(guildId: string, channelId: string): string {
  return path.join("user", "servers", guildId, "active-chat-participants", `${channelId}.json`);
}

function emptyActiveChatParticipantsFile(guildId: string, channelId: string): ActiveChatParticipantsFile {
  return ActiveChatParticipantsFileSchema.parse(
    createEmptyRevisionedFile({ guildId, channelId, participants: [] })
  );
}

function sortActiveChatParticipants(participants: ActiveChatParticipant[]): ActiveChatParticipant[] {
  return [...participants].sort((a, b) => {
    const display = a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
    return display === 0 ? a.userId.localeCompare(b.userId) : display;
  });
}
