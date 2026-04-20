import type {
  ChannelConfig,
  MemoryNote,
  OrchestratorDecision,
  RespondingWaifuDecision,
  RelationshipEntry,
  StageManagerConfig,
  WaifuConfig
} from "./types/index.js";
import type { ChatMessage } from "./ai-router.js";
import type { FormattedMessage } from "./message-handler.js";

export interface PromptBuildContext {
  activeWaifus: WaifuConfig[];
  knownWaifus: WaifuConfig[];
  messages: FormattedMessage[];
  channel: ChannelConfig;
  availableServerEmojis: string[];
  currentTimeUTC: string;
  consecutiveWaifuMessages: number;
  trigger: "message" | "idle" | "waifu_followup";
  lastSpeakerWaifuId?: string | null;
  stageStateByWaifuId?: Record<
    string,
    {
      relationshipsByParticipant: Record<string, RelationshipEntry>;
      memories: MemoryNote[];
    }
  >;
}

export interface StageManagerParticipantView {
  key: string;
  label: string;
  kind: "user" | "waifu";
}

export interface StageManagerPromptContext {
  activeWaifus: WaifuConfig[];
  knownWaifus: WaifuConfig[];
  channel: ChannelConfig;
  currentTimeUTC: string;
  config: StageManagerConfig;
  history: FormattedMessage[];
  newMessages: FormattedMessage[];
  checkpointMessageId: string | null;
  availableParticipants: StageManagerParticipantView[];
  stageStateByWaifuId: Record<
    string,
    {
      relationshipsByParticipant: Record<string, RelationshipEntry>;
      memories: MemoryNote[];
    }
  >;
}

export class PromptBuilder {
  buildOrchestratorSystemPrompt(context: PromptBuildContext): string {
    const waifuBlock = context.activeWaifus
      .map(
        (waifu) => [
          `### ${waifu.name} (ID: ${waifu.id})`,
          `- Personality: ${waifu.personality.description}`,
          `- Traits: ${waifu.personality.traits.join(", ") || "none listed"}`,
          `- Speech Patterns: ${waifu.personality.speechPatterns.join(", ") || "none listed"}`,
          `- Likes: ${waifu.personality.likes.join(", ") || "none listed"}`,
          `- Dislikes: ${waifu.personality.dislikes.join(", ") || "none listed"}`,
          `- Schedule: Sleeps ${waifu.schedule.sleepTime.start}-${waifu.schedule.sleepTime.end} UTC. Busy ${waifu.schedule.busyTime.start}-${waifu.schedule.busyTime.end} UTC (${waifu.schedule.busyTime.reason}).`,
          `- Relationships: ${JSON.stringify(resolveRelationshipMap(waifu, context.knownWaifus))}`
        ].join("\n")
      )
      .join("\n\n");

    const idleSection =
      context.trigger === "idle"
        ? [
            "",
            "## IDLE TRIGGER",
            "No new messages have been sent recently. The chat has been quiet for a while.",
            "Would any waifu naturally start a new conversation right now, considering the time of day and their schedule?",
            "\"no_reply\" is completely valid if silence feels natural."
          ].join("\n")
        : "";

    const followupSection =
      context.trigger === "waifu_followup"
        ? [
            "",
            "## WAIFU FOLLOW-UP",
            `The last waifu speaker was: ${context.lastSpeakerWaifuId ?? "unknown"}.`,
            `Consecutive waifu messages so far: ${context.consecutiveWaifuMessages}.`,
            "A waifu message has already been posted to Discord.",
            "Decide what happens next from here: the same waifu may continue, another waifu may cut in, multiple waifus may chain naturally, or the room may go quiet.",
            "Continue only if the next message would add a fresh beat, escalation, interruption, joke, reaction, or emotional shift.",
            "Do not repeat the same point in slightly different words."
          ].join("\n")
        : "";

    const emojiSection = context.availableServerEmojis.length
      ? [
          "",
          "## Available Server Emojis",
          context.availableServerEmojis.join(" ")
        ].join("\n")
      : "";

    return [
      "You are the Orchestrator for a Discord group chat inhabited by AI waifus (characters).",
      "Your job is to direct the room: decide which waifu(s) should respond next, in what order, or whether nobody should respond right now.",
      "You must call the orchestrator_decision tool exactly once with your final decision.",
      "",
      "## Active Waifus",
      waifuBlock,
      "",
      "## Current Time",
      `${context.currentTimeUTC} (UTC)`,
      "",
      "## Decision Rules",
      "1. Be natural. Real group chats do not require everyone to reply every time.",
      "2. You are allowed to shape pacing, tension, comedy, interruption, silence, and escalation. Treat the room like a living scene, not a turn-taking queue.",
      "3. Mentions, quotes, relationships, reactions, timestamps, and recent momentum are all useful signals, but none of them are hard rules.",
      "4. Always pay special attention to the latest 10 messages. They are the strongest signal for what the room is currently doing, who may have been overlooked, and whether a loop is starting to form.",
      "5. Sleep time, busy time, and consecutive-message heuristics are soft preferences. Break them whenever doing so would clearly improve conversational flow, realism, or enjoyment.",
      "6. The same waifu may speak again, a different waifu may jump in, or multiple waifus may chain if it feels right.",
      "7. Avoid repetitive follow-ups that merely restate the same beat. Continue only when the next message adds something new.",
      "8. If a recent user message or direct ping went unnoticed while the room moved on, prefer steering someone to acknowledge it so the chat stays socially inclusive unless silence is clearly more natural.",
      "9. \"no_reply\" is valid. If you choose it, set retriggerAfterSeconds to a natural delay between 100 and 7200 seconds.",
      "10. Use timestamps and pacing. Slow gaps matter.",
      "11. You may suggest emoji reactions sparingly.",
      "12. delaySeconds should reflect realistic reading and typing time.",
      `13. consecutiveWaifuMessages for this context: ${context.consecutiveWaifuMessages}.`,
      "14. replyToMessageId is optional. Leave it null by default.",
      "15. Most waifu messages should be normal messages, not Discord replies.",
      "16. Do not set replyToMessageId to the immediately previous message. If a waifu is simply responding to the latest beat, send a normal message instead.",
      "17. If you are reviving, acknowledging, or directly answering an older user message or direct ping that went overlooked, you should usually set replyToMessageId to that exact message so the response stays anchored to the right person and beat.",
      "18. Use replyToMessageId only when targeting a specific older message materially improves clarity, isolates a side thread, answers an earlier question, or creates a specific social effect. If you use it, copy an exact message ID from the Recent Chat History.",
      "19. If you choose reactionEmoji, prefer an exact emoji from the Available Server Emojis list when one fits.",
      "20. Avoid repeating the same reaction emoji too often when several server emojis are available.",
      "",
      "## directInteraction",
      "directInteraction is an optional lightweight visual beat.",
      "Use it when one waifu should send exactly one server emoji as its own Discord message.",
      "This creates a large emoji message because the message contains only that one emoji.",
      "Use it sparingly. It is a rare accent, not default punctuation.",
      "If the room only needs a quick visible beat, directInteraction can be better than forcing a full text reply.",
      "It is good for punctuation, surprise, mock horror, approval, interruption, or a quick reaction the whole room should see.",
      "It is especially worth considering when the latest message is mostly emotional, visual, funny, emoji-like, or does not actually need a full sentence back.",
      "Do not ignore directInteraction just because a text reply is possible. If one visible emoji beat would satisfy the moment, that can be the better choice.",
      "At most one directInteraction is allowed per decision.",
      "You may use directInteraction alone or alongside normal respondingWaifus when it improves pacing.",
      "Copy the emoji exactly from the Available Server Emojis list.",
      "Use exactly one server emoji token such as :wtf:.",
      "Do not use Unicode emoji here.",
      "Do not put extra text, multiple emojis, or arbitrary strings in directInteraction.emoji.",
      "If action is no_reply, directInteraction should normally be null.",
      "",
      "## sceneDirection",
      "sceneDirection is an invisible director note for that waifu's next message only.",
      "Use it when the next reply needs stronger steering than replyStyle alone can provide.",
      "The latest 10 messages are a good place to spot loops early; when you notice one forming, use sceneDirection to cut it before it hardens.",
      "You may use it to break loops, force a new beat, close a scene, redirect to a new topic, create an interruption, or shift momentum by changing the next objective.",
      "This is not a personality rewrite and not a long paragraph.",
      "Keep it short, concrete, and immediately actionable. One short sentence is usually enough.",
      "When referring to a specific user inside sceneDirection, use that user's actual name from chat history. Do not write generic phrases like \"the user\" when a specific person is meant.",
      "sceneDirection does not always need to follow the current mood or flow exactly. It may deliberately start something new when that will improve the scene.",
      "Use natural bridges when pivoting when possible.",
      "If multiple waifus respond, each one may receive a different sceneDirection.",
      "If no special steering is needed, return null.",
      emojiSection,
      idleSection,
      followupSection,
    ]
      .filter(Boolean)
      .join("\n");
  }

  buildOrchestratorUserPrompt(context: PromptBuildContext): string {
    const messageLines = context.messages.map((message) => {
      const replySegment = message.replyingTo
        ? ` [replying to id ${message.replyingTo.id}: "${message.replyingTo.content}" by ${message.replyingTo.author}]`
        : "";
      const mentionsSegment = message.mentions.length
        ? ` [mentions: ${message.mentions.join(", ")}]`
        : "";
      const quotesSegment = message.quotedLines.length
        ? ` [quoted text: ${message.quotedLines.join(" | ")}]`
        : "";
      const reactionsSegment = message.reactions.length
        ? ` [reactions: ${formatReactions(message)}]`
        : "";

      return `[id: ${message.id}] [${message.timestamp}] ${message.authorDisplayName}${message.isWaifu ? ` (WAIFU: ${message.waifuId})` : ""}${message.isUser ? " (USER)" : ""}: ${message.content}${replySegment}${mentionsSegment}${quotesSegment}${reactionsSegment}`;
    });

    const followupContext =
      context.trigger === "waifu_followup"
        ? [
            "",
            "A waifu message has already been posted to the chat.",
            "Decide whether the scene continues from here or settles naturally."
          ]
        : [];

    return [
      `## Recent Chat History (last ${context.messages.length} messages)`,
      "",
      ...messageLines,
      ...followupContext,
      "",
      `Active channel: ${context.channel.channelName} (${context.channel.channelId})`,
      "Based on the above conversation, who should respond next?"
    ].join("\n");
  }

  buildWaifuSystemPrompt(
    waifu: WaifuConfig,
    context: PromptBuildContext,
    replyStyle: RespondingWaifuDecision["replyStyle"],
    sceneDirection: string | null,
    baseSystemPrompt?: string | null
  ): string {
    const normalizedSceneDirection = sceneDirection?.trim() ? sceneDirection.trim() : null;
    const relationshipLines = buildRenderedRelationshipLines(waifu, context);
    const memoryLines = (context.stageStateByWaifuId?.[waifu.id]?.memories ?? [])
      .slice()
      .sort((left, right) => left.slot - right.slot)
      .map((memory) => `${memory.slot}. ${memory.note}`)
      .join("\n");
    const otherWaifuLines = context.activeWaifus
      .filter((entry) => entry.id !== waifu.id)
      .map((otherWaifu) => `- ${otherWaifu.name} (waifu)`);
    const humanParticipantLines = Array.from(
      new Set(
        context.messages
          .filter((message) => !message.isWaifu && message.authorDisplayName.trim())
          .map((message) => message.authorDisplayName.trim())
      )
    ).map((participantName) => `- ${participantName} (user)`);
    const participantLines = [...otherWaifuLines, ...humanParticipantLines]
      .join("\n");

    const promptSections = [
      baseSystemPrompt?.trim() ||
        [
          `You are ${waifu.name}, a character in a Discord group chat. You are not an AI assistant.`,
          "",
          "## Your Identity",
          `- Name: ${waifu.name}`,
          `- Description: ${waifu.personality.description}`,
          `- Key traits: ${waifu.personality.traits.join(", ") || "none listed"}`,
          `- Speech patterns: ${waifu.personality.speechPatterns.join(", ") || "none listed"}`,
          `- Likes: ${waifu.personality.likes.join(", ") || "none listed"}`,
          `- Dislikes: ${waifu.personality.dislikes.join(", ") || "none listed"}`,
          `- Backstory: ${waifu.personality.backstory}`,
          `- Quirks: ${waifu.personality.quirks.join(", ") || "none listed"}`,
          "",
          "## Your Relationships",
          relationshipLines || "- No relationships configured",
          "",
          "## Memories",
          memoryLines || "- No memories saved yet.",
          "",
          "## Participants In This Chatroom",
          participantLines || "- No other participants are currently visible in this chat context.",
          "",
          "## Your Current State",
          `- Current time (UTC): ${context.currentTimeUTC}`,
          `- Your schedule: Sleep ${waifu.schedule.sleepTime.start}-${waifu.schedule.sleepTime.end}, Busy ${waifu.schedule.busyTime.start}-${waifu.schedule.busyTime.end} (${waifu.schedule.busyTime.reason})`,
          `- Reply style requested: ${replyStyle}`,
          ...(context.availableServerEmojis.length
            ? [
                "",
                "## Available Server Emojis",
                context.availableServerEmojis.join(" ")
              ]
            : []),
          "",
          "## Medium",
          "You are posting messages in a Discord group chat.",
          "Default assumption: everyone is typing remotely through chat, not physically together in the same room.",
          "Flirting, tension, jokes, and roleplay flavor can still happen in text, but do not turn chat into a literal in-person encounter unless the recent transcript explicitly and unambiguously establishes that the characters are physically together right now.",
          "Do not invent doors, beds, blankets, touching, whispering in someone's ear, changing clothes together, or other physical co-presence details unless the chat history clearly grounds them as actually happening.",
          "",
          "## Conversation Rules",
          "1. Write like a real person in Discord: casual, concise, and in character.",
          "2. Default to one short message. Most replies should be 1-2 short sentences. Use 3 only when the moment clearly needs it.",
          "3. Keep the energy of a fast-moving chat. Do not write mini-monologues, cinematic prose, or slowly expanding paragraphs.",
          "4. You may use Discord formatting and quotes.",
          "5. Do not use Unicode emoji characters.",
          "6. If you want that effect, prefer plain text first.",
          "7. Server/custom emojis are optional, but a fitting one is a good occasional accent and is allowed when it adds a clear reaction, punchline, or bit of flavor.",
          "8. If one of the available server emojis clearly fits the moment, feel free to use it instead of extra words sometimes.",
          "9. If you use a server/custom emoji, use at most one and make sure it fits the moment clearly.",
          "10. Do not keep reusing the same server/custom emoji across nearby turns unless there is a clear reason.",
          "11. If a recent message already used a given emoji, prefer a different expression instead of repeating it by default.",
          "12. Do not treat emojis as required punctuation, but they can work as occasional accents and sometimes are better than overexplaining.",
          "13. Prefer text-chat reactions, jokes, teasing, and emotional beats over narrated physical actions.",
          "14. If you use asterisks for action, keep them brief and text-friendly. Do not use long roleplay stage directions by default.",
          "15. Prefer using someone's plain name in message text instead of @mentioning them.",
          "16. Use @Name only when you are intentionally trying to pull someone back into the conversation after they have been quiet for a while, or when the ping itself adds clear social effect.",
          "17. Do not ping someone who is already active, just spoke recently, or is obviously already engaged. Do not spam pings.",
          "18. Stay in character at all times. Never mention being an AI.",
          "19. If the reply style is sleepy, write like you are tired or just woke up.",
          "20. Do not start your message with your own name.",
          "21. Unless the transcript clearly establishes real-life co-presence, treat suggestive or romantic content as chat banter, not literal physical action happening right now.",
          "22. Do not keep inflating the same beat. If the moment is already clear, reply briefly rather than adding more descriptive detail."
        ].join("\n")
    ];

    if (normalizedSceneDirection) {
      promptSections.push(
        [
          "## Scene Direction Handling",
          "Treat the scene direction as an invisible director note for this turn only.",
          "Follow it while staying fully in character.",
          "Do not mention the existence of the direction or reveal that you were instructed.",
          "If it asks for a pivot, bridge naturally from the existing conversation when possible.",
          "Do not follow it in a way that breaks your identity or creates an obviously unnatural non sequitur unless the direction deliberately calls for a hard interruption.",
          "Even when following the direction, keep the reply grounded as a Discord chat message unless the transcript clearly establishes in-person co-presence.",
          "Do not introduce Unicode emoji even if the direction implies a playful or emotional tone.",
          "",
          "## Scene Direction For This Turn",
          normalizedSceneDirection
        ].join("\n")
      );
    }

    return promptSections.join("\n\n");
  }

  buildWaifuTranscriptMessages(context: PromptBuildContext): ChatMessage[] {
    return context.messages.map((message) => {
      const contentLines = [message.content.trim() || "[no text content]"];
      const metadata = [`timestamp: ${message.timestamp}`];

      if (message.replyingTo) {
        metadata.push(
          `replying to ${message.replyingTo.author}: "${message.replyingTo.content}"`
        );
      }
      if (message.mentions.length) {
        metadata.push(`mentions: ${message.mentions.join(", ")}`);
      }
      if (message.quotedLines.length) {
        metadata.push(`quoted text: ${message.quotedLines.join(" | ")}`);
      }
      if (message.reactions.length) {
        metadata.push(`reactions: ${formatReactions(message)}`);
      }

      contentLines.push(`[context: ${metadata.join(" | ")}]`);

      const speakerName = toPromptMessageName(message.authorDisplayName);
      return {
        role: message.isWaifu ? "assistant" : "user",
        content: contentLines.join("\n"),
        ...(speakerName ? { name: speakerName } : {})
      };
    });
  }

  buildWaifuReplyCue(
    waifu: WaifuConfig,
    replyToMessage: Pick<FormattedMessage, "content" | "authorDisplayName"> | null = null
  ): ChatMessage {
    const replyTargetInstruction = replyToMessage
      ? ` Reply to "${replyToMessage.content}" by ${replyToMessage.authorDisplayName}.`
      : "";
    return {
      role: "user",
      content: `Continue the conversation as ${waifu.name}.${replyTargetInstruction} Write only one concise Discord message with no prefix and no Unicode emoji.`
    };
  }

  summarizeDecision(decision: OrchestratorDecision): string {
    if (
      decision.action === "no_reply" &&
      decision.respondingWaifus.length === 0 &&
      !decision.directInteraction
    ) {
      return "No reply";
    }

    const segments: string[] = [];
    if (decision.directInteraction) {
      segments.push(`${decision.directInteraction.waifuId} emoji beat`);
    }
    if (decision.respondingWaifus.length > 0) {
      segments.push(`${decision.respondingWaifus.map((entry) => entry.waifuId).join(", ")} replying`);
    }
    return segments.join("; ");
  }

  buildStageManagerSystemPrompt(context: StageManagerPromptContext): string {
    const waifuBlock = context.activeWaifus
      .map(
        (waifu) => [
          `### ${waifu.name} (ID: ${waifu.id})`,
          `- Personality: ${waifu.personality.description}`,
          `- Traits: ${waifu.personality.traits.join(", ") || "none listed"}`,
          `- Static relationships: ${JSON.stringify(resolveRelationshipMap(waifu, context.knownWaifus))}`
        ].join("\n")
      )
      .join("\n\n");

    return [
      "You are the Stage Manager for a Discord group chat inhabited by AI waifus.",
      "You do not speak in the chat.",
      "You quietly review the room after it settles and decide whether any waifu's durable relationships or memories should be updated.",
      "Use the stage_manager_update tool only if durable updates are actually warranted.",
      "",
      "Only save information that is likely to matter in future conversations.",
      "Do not direct the scene.",
      "Do not choose who replies.",
      "Do not rewrite personality.",
      "Do not store every joke.",
      "Do not store trivial emoji habits or one-off phrasing quirks as memories.",
      "Prefer no update over weak or speculative updates.",
      "Keep updates short and concrete.",
      "Relationships are unique per participant. Overwrite the same participant instead of creating duplicates.",
      "Memories should be long-term relevant, rare, and worth keeping.",
      "",
      "## Current Time",
      `${context.currentTimeUTC} (UTC)`,
      "",
      "## Active Waifus",
      waifuBlock
    ].join("\n");
  }

  buildStageManagerUserPrompt(context: StageManagerPromptContext): string {
    const historyLines = context.history.map((message) =>
      this.formatFlattenedHistoryLine(message, context.checkpointMessageId)
    );
    const newMessageIds = new Set(context.newMessages.map((message) => message.id));
    const newHistoryLines = context.history
      .filter((message) => newMessageIds.has(message.id))
      .map((message) => this.formatFlattenedHistoryLine(message, context.checkpointMessageId));
    const participantLines = context.availableParticipants.map(
      (participant) => `- ${participant.key}: ${participant.label} (${participant.kind})`
    );
    const relationshipLines = context.activeWaifus.flatMap((waifu) => {
      const merged = collectRenderedRelationships(waifu, context.knownWaifus, context.stageStateByWaifuId?.[waifu.id]);
      const lines = Object.entries(merged).map(
        ([label, description]) => `  - ${label}: ${description}`
      );
      return [`### ${waifu.name}`, ...(lines.length > 0 ? lines : ["  - none"])];
    });
    const memoryLines = context.activeWaifus.flatMap((waifu) => {
      const entries = (context.stageStateByWaifuId?.[waifu.id]?.memories ?? [])
        .slice()
        .sort((left, right) => left.slot - right.slot)
        .map((memory) => `  - [slot ${memory.slot}] ${memory.note}`);
      return [`### ${waifu.name}`, ...(entries.length > 0 ? entries : ["  - none"])];
    });

    return [
      `## Recent Chat History (last ${context.history.length} messages)`,
      "",
      ...historyLines,
      "",
      "## Messages Since Last Stage-Manager Review",
      ...(newHistoryLines.length > 0 ? ["", ...newHistoryLines] : ["", "- none"]),
      "",
      "## Available Chat Participants",
      ...(participantLines.length > 0 ? ["", ...participantLines] : ["", "- none"]),
      "",
      "## Current Stored Relationships",
      "",
      ...relationshipLines,
      "",
      "## Current Stored Memories",
      "",
      ...memoryLines,
      "",
      "What durable relationship or memory updates, if any, should be saved?"
    ].join("\n");
  }

  private formatFlattenedHistoryLine(
    message: FormattedMessage,
    checkpointMessageId: string | null
  ): string {
    const replySegment = message.replyingTo
      ? ` [replying to id ${message.replyingTo.id}: "${message.replyingTo.content}" by ${message.replyingTo.author}]`
      : "";
    const mentionsSegment = message.mentions.length
      ? ` [mentions: ${message.mentions.join(", ")}]`
      : "";
    const quotesSegment = message.quotedLines.length
      ? ` [quoted text: ${message.quotedLines.join(" | ")}]`
      : "";
    const reactionsSegment = message.reactions.length
      ? ` [reactions: ${formatReactions(message)}]`
      : "";
    const newMarker =
      checkpointMessageId && BigInt(message.id) > BigInt(checkpointMessageId) ? " [NEW]" : "";

    return `[id: ${message.id}] [${message.timestamp}] ${message.authorDisplayName}${message.isWaifu ? ` (WAIFU: ${message.waifuId})` : ""}${message.isUser ? " (USER)" : ""}: ${message.content}${replySegment}${mentionsSegment}${quotesSegment}${reactionsSegment}${newMarker}`;
  }
}

function formatReactions(message: FormattedMessage): string {
  return message.reactions
    .map((reaction) => {
      const reactors = reaction.reactors.map((user) => user.displayName).join(", ");
      return reactors
        ? `${reaction.emoji} x${reaction.count} by ${reactors}`
        : `${reaction.emoji} x${reaction.count}`;
    })
    .join("; ");
}

function resolveRelationshipMap(
  waifu: WaifuConfig,
  knownWaifus: WaifuConfig[]
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(waifu.personality.relationshipsWithOtherWaifus).map(([waifuId, description]) => [
      resolveWaifuRelationshipLabel(waifuId, knownWaifus),
      description
    ])
  );
}

function resolveWaifuRelationshipLabel(waifuId: string, knownWaifus: WaifuConfig[]): string {
  const target = knownWaifus.find((entry) => entry.id === waifuId);
  return target?.name ?? waifuId;
}

function buildRenderedRelationshipLines(
  waifu: WaifuConfig,
  context: PromptBuildContext
): string {
  const merged = collectRenderedRelationships(
    waifu,
    context.knownWaifus,
    context.stageStateByWaifuId?.[waifu.id]
  );

  return Object.entries(merged)
    .map(([label, description]) => `- ${label}: ${description}`)
    .join("\n");
}

function collectRenderedRelationships(
  waifu: WaifuConfig,
  knownWaifus: WaifuConfig[],
  dynamicState:
    | {
        relationshipsByParticipant: Record<string, RelationshipEntry>;
      }
    | undefined
): Record<string, string> {
  const merged = resolveRelationshipMap(waifu, knownWaifus);
  for (const entry of Object.values(dynamicState?.relationshipsByParticipant ?? {})) {
    merged[entry.targetName] = entry.relationship;
  }
  return merged;
}

function toPromptMessageName(name: string): string | undefined {
  const normalized = name
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);

  return normalized || undefined;
}
