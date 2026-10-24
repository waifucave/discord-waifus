import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DiscordGatewayFacade,
  DiscordMessageDeleteEvent,
  DiscordMessageEditEvent,
  DiscordThreadEvent,
  DiscordThreadInfo
} from "../src/discord/client.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { RuntimeOrchestrator } from "../src/orchestration/runtime.js";
import { observeThread, readThreads } from "../src/orchestration/stores/threads.js";
import { ensureServer } from "../src/orchestration/stores/config.js";
import { runKey } from "../src/orchestration/runtimeShared.js";
import type { ContextRuntime } from "../src/orchestration/context/runtime.js";
import { ConversationLedgerSchema, type ConversationLedger } from "../src/shared/schemas/context.js";
import { createEmptyRevisionedFile, DiscordBotsFileSchema, ServerConfigSchema } from "../src/shared/schemas/domain.js";
import type { RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";
import { StorageService } from "../src/storage/storageService.js";
import { quietLogger, raw } from "./contextFixtures.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

// Building a RuntimeOrchestrator takes about a second; leave headroom for a loaded machine.
vi.setConfig({ testTimeout: 30_000 });

const GUILD = "123456789012345678";
const PARENT = "223456789012345678";
const THREAD = "323456789012345678";
const WAIFU_BOT = "423456789012345678";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

const THREAD_INFO: DiscordThreadInfo = { parentId: PARENT, name: "Best brownies", kind: "public_thread", archived: false, locked: false };

function fakeContexts(ledger?: ConversationLedger) {
  const calls = {
    edits: [] as Array<{ conversation: unknown; message: RawDiscordMessage }>,
    deletes: [] as Array<{ conversation: unknown; ids: string[]; redactRecent: number | undefined }>,
    deleted: [] as unknown[]
  };
  const contexts = {
    recordMessageEdit: async (conversation: unknown, message: RawDiscordMessage) => {
      calls.edits.push({ conversation, message });
      return "event";
    },
    recordMessageDeletes: async (conversation: unknown, ids: string[], o: { redactRecent?: number } = {}) => {
      calls.deletes.push({ conversation, ids, redactRecent: o.redactRecent });
      return { redacted: [], marked: [], unknown: [], purgedImages: [] };
    },
    peekLedger: async () => ledger ?? ConversationLedgerSchema.parse({ schemaVersion: 2, revision: 0, updatedAt: "2026-10-24T00:00:00.000Z", conversationKey: "g" }),
    deleteConversation: async (conversation: unknown) => {
      calls.deleted.push(conversation);
    }
  };
  return { contexts: contexts as unknown as ContextRuntime, calls };
}

async function setup(o: { ledger?: ConversationLedger; parentThreads?: "inherit" | "off"; paused?: boolean } = {}) {
  const root = await makeTempRoot();
  roots.push(root);
  await ensureDataLayout(root);
  const storage = new StorageService(root);
  await storage.updateRevisionedJson({
    resourceKey: `server:${GUILD}`,
    relativePath: `user/servers/${GUILD}/server.json`,
    schema: ServerConfigSchema,
    fallback: ServerConfigSchema.parse({ ...createEmptyRevisionedFile({}), guildId: GUILD }),
    transform: (current) => ({
      ...current,
      enabled: true,
      channels: {
        [PARENT]: { channelId: PARENT, name: "recipes", enabled: true, enabledWaifuIds: ["aria"], ...(o.parentThreads ? { threads: o.parentThreads } : {}) }
      }
    })
  });
  await storage.writeJson(
    "discord-bots",
    "user/discord-bots.json",
    DiscordBotsFileSchema,
    DiscordBotsFileSchema.parse(
      createEmptyRevisionedFile({ orchestrator: null, waifus: [{ id: WAIFU_BOT, displayName: "Aria", enabled: true }] })
    )
  );
  const { contexts, calls } = fakeContexts(o.ledger);
  const joined: string[] = [];
  const discord = {
    async connect() {
      return { connected: true, orchestratorConnected: true, waifuBotCount: 1, warnings: [] };
    },
    async disconnect() {},
    async joinThread(input: { threadId: string }) {
      joined.push(input.threadId);
    },
    async deleteAllMessages() {
      return { scannedMessageCount: 3, deletedCount: 3, failedCount: 0, failedMessageIds: [] };
    }
  } as unknown as DiscordGatewayFacade;
  const runtime = new RuntimeOrchestrator({
    storage,
    discord,
    logger: quietLogger(),
    contexts,
    isPaused: () => o.paused !== false,
    sleep: async () => undefined,
    deletedMessages: { redactRecent: 7 }
  });
  return { runtime, storage, calls, joined };
}

const editEvent = (message: RawDiscordMessage, o: Partial<DiscordMessageEditEvent> = {}): DiscordMessageEditEvent => ({
  guildId: GUILD,
  channelId: PARENT,
  messageId: message.id,
  authorId: message.authorId,
  authorBot: false,
  message,
  ...o
});

function ledgerWithNewestHuman(id: string, body: string): ConversationLedger {
  return ConversationLedgerSchema.parse({
    schemaVersion: 2,
    revision: 1,
    updatedAt: "2026-10-24T00:00:00.000Z",
    conversationKey: "g",
    nextSeq: 2,
    entries: {
      [id]: { id, seq: 1, authorId: "kevin", authorName: "Kevin", authorIsBot: false, at: new Date().toISOString(), kind: "default", body, images: [], state: "live", sealed: true }
    }
  });
}

describe("RuntimeOrchestrator edits (spec 9.5)", () => {
  it("records an edit in the ledger and never starts a run", async () => {
    const { runtime, calls } = await setup();
    const spy = vi.spyOn(runtime, "handleDiscordMessage");
    const message = raw({ id: "900000000000000001", channelId: PARENT, guildId: GUILD, content: "fixed typo", editedAt: new Date().toISOString() });
    await runtime.handleDiscordMessageEdit(editEvent(message));
    expect(calls.edits).toHaveLength(1);
    expect(calls.edits[0]!.conversation).toEqual({ kind: "guild", guildId: GUILD, channelId: PARENT });
    expect(spy).not.toHaveBeenCalled();
  });

  it("an edit that adds a waifu mention to the newest human message within 2 minutes counts as a new message", async () => {
    const id = "900000000000000002";
    const { runtime } = await setup({ ledger: ledgerWithNewestHuman(id, "hey there") });
    const spy = vi.spyOn(runtime, "handleDiscordMessage").mockResolvedValue(undefined as never);
    const now = Date.now();
    const message = raw({
      id,
      channelId: PARENT,
      guildId: GUILD,
      content: `hey there <@${WAIFU_BOT}>`,
      createdAt: new Date(now - 30_000).toISOString(),
      editedAt: new Date(now).toISOString(),
      mentions: { users: { [WAIFU_BOT]: "Aria" }, roles: {}, channels: {} }
    });
    await runtime.handleDiscordMessageEdit(editEvent(message, { previousMentionIds: [] }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ guildId: GUILD, channelId: PARENT, messageId: id, authorBot: false });
  });

  it("does not re-trigger when the mention was already there, the edit is late, or it is not the newest human message", async () => {
    const id = "900000000000000003";
    const { runtime } = await setup({ ledger: ledgerWithNewestHuman(id, "hey <@Aria>") });
    const spy = vi.spyOn(runtime, "handleDiscordMessage").mockResolvedValue(undefined as never);
    const now = Date.now();
    const base = {
      id,
      channelId: PARENT,
      guildId: GUILD,
      content: `hey <@${WAIFU_BOT}>`,
      mentions: { users: { [WAIFU_BOT]: "Aria" }, roles: {}, channels: {} }
    };
    // Already mentioned before the edit.
    await runtime.handleDiscordMessageEdit(
      editEvent(raw({ ...base, createdAt: new Date(now - 10_000).toISOString(), editedAt: new Date(now).toISOString() }), { previousMentionIds: [WAIFU_BOT] })
    );
    // Edited more than 2 minutes after posting.
    await runtime.handleDiscordMessageEdit(
      editEvent(raw({ ...base, createdAt: new Date(now - 5 * 60_000).toISOString(), editedAt: new Date(now).toISOString() }), { previousMentionIds: [] })
    );
    // Not the newest human message in the ledger.
    await runtime.handleDiscordMessageEdit(
      editEvent(raw({ ...base, id: "900000000000000099", createdAt: new Date(now - 10_000).toISOString(), editedAt: new Date(now).toISOString() }), { previousMentionIds: [] })
    );
    // A bot's own edit.
    await runtime.handleDiscordMessageEdit(
      editEvent(raw({ ...base, authorIsBot: true, createdAt: new Date(now - 10_000).toISOString(), editedAt: new Date(now).toISOString() }), { previousMentionIds: [], authorBot: true })
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("RuntimeOrchestrator deletes (spec 9.5)", () => {
  it("records deletes with the configured redactRecent and never starts a run", async () => {
    const { runtime, calls } = await setup();
    const spy = vi.spyOn(runtime, "handleDiscordMessage");
    const event: DiscordMessageDeleteEvent = { guildId: GUILD, channelId: PARENT, messageIds: ["1", "2"], bulk: true };
    await runtime.handleDiscordMessageDelete(event);
    expect(calls.deletes).toEqual([{ conversation: { kind: "guild", guildId: GUILD, channelId: PARENT }, ids: ["1", "2"], redactRecent: 7 }]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("deleting the message that triggered a run that has not sent anything aborts it with trigger_deleted", async () => {
    const { runtime } = await setup();
    const runner = (runtime as unknown as { runner: { activeRuns: Map<string, unknown> } }).runner;
    const controller = new AbortController();
    runner.activeRuns.set(runKey(GUILD), {
      guildId: GUILD,
      channelId: PARENT,
      controller,
      promise: new Promise(() => undefined),
      triggerMessageId: "900000000000000010",
      startedAt: Date.now() - 1_000
    });
    // Another message: untouched.
    await runtime.handleDiscordMessageDelete({ guildId: GUILD, channelId: PARENT, messageIds: ["900000000000000011"], bulk: false });
    expect(controller.signal.aborted).toBe(false);
    await runtime.handleDiscordMessageDelete({ guildId: GUILD, channelId: PARENT, messageIds: ["900000000000000010"], bulk: false });
    expect(controller.signal.aborted).toBe(true);
    expect((controller.signal.reason as Error).message).toBe("trigger_deleted");
  });

  it("a run that already sent a reply is not aborted", async () => {
    const { runtime } = await setup();
    const internals = runtime as unknown as {
      runner: { activeRuns: Map<string, unknown> };
      executor: { hasSentSince: (channelId: string, since: number) => boolean };
    };
    vi.spyOn(internals.executor, "hasSentSince").mockReturnValue(true);
    const controller = new AbortController();
    internals.runner.activeRuns.set(runKey(GUILD), {
      guildId: GUILD,
      channelId: PARENT,
      controller,
      promise: new Promise(() => undefined),
      triggerMessageId: "900000000000000010",
      startedAt: Date.now() - 1_000
    });
    await runtime.handleDiscordMessageDelete({ guildId: GUILD, channelId: PARENT, messageIds: ["900000000000000010"], bulk: false });
    expect(controller.signal.aborted).toBe(false);
  });
});

describe("RuntimeOrchestrator threads (spec 9.5, O2)", () => {
  const threadEvent = (change: DiscordThreadEvent["change"], thread: Partial<DiscordThreadInfo> = {}, previous?: DiscordThreadEvent["previous"]): DiscordThreadEvent => ({
    change,
    guildId: GUILD,
    threadId: THREAD,
    thread: { ...THREAD_INFO, ...thread },
    ...(previous ? { previous } : {})
  });

  it("a new thread under a parent with a cast is tracked, joined and inherits the cast", async () => {
    const { runtime, storage, joined } = await setup();
    await runtime.handleDiscordThreadChange(threadEvent("create"));
    expect((await readThreads(storage, GUILD)).threads[THREAD]).toMatchObject({ parentId: PARENT, name: "Best brownies", archived: false });
    expect(joined).toEqual([THREAD]);
    const server = await ensureServer(storage, GUILD);
    expect(server.channels[THREAD]).toMatchObject({ enabledWaifuIds: ["aria"], thread: { parentId: PARENT } });
  });

  it("threads under a parent with threads off are not tracked (inherit/off)", async () => {
    const { runtime, storage, joined } = await setup({ parentThreads: "off" });
    await runtime.handleDiscordThreadChange(threadEvent("create"));
    expect((await readThreads(storage, GUILD)).threads).toEqual({});
    expect(joined).toEqual([]);
  });

  it("archiving silences the thread and clears its run; unarchiving resumes and rejoins", async () => {
    const { runtime, storage, joined } = await setup();
    await runtime.handleDiscordThreadChange(threadEvent("create"));
    const runner = (runtime as unknown as { runner: { activeRuns: Map<string, { controller: AbortController }> } }).runner;
    const controller = new AbortController();
    runner.activeRuns.set(runKey(GUILD), { guildId: GUILD, channelId: THREAD, controller, promise: new Promise(() => undefined), startedAt: Date.now() } as never);

    await runtime.handleDiscordThreadChange(threadEvent("update", { archived: true }, { archived: false, locked: false, name: "Best brownies" }));
    expect(controller.signal.aborted).toBe(true);
    expect((await ensureServer(storage, GUILD)).channels[THREAD]).toBeUndefined();

    joined.length = 0;
    await runtime.handleDiscordThreadChange(threadEvent("update", { archived: false }, { archived: true, locked: false, name: "Best brownies" }));
    expect((await ensureServer(storage, GUILD)).channels[THREAD]).toBeDefined();
    expect(joined).toEqual([THREAD]);
  });

  it("a locked thread is silent", async () => {
    const { runtime, storage } = await setup();
    await runtime.handleDiscordThreadChange(threadEvent("create"));
    await runtime.handleDiscordThreadChange(threadEvent("update", { locked: true }));
    expect((await ensureServer(storage, GUILD)).channels[THREAD]).toBeUndefined();
  });

  it("deleting a thread forgets it and deletes its conversation", async () => {
    const { runtime, storage, calls } = await setup();
    await runtime.handleDiscordThreadChange(threadEvent("create"));
    await runtime.handleDiscordThreadChange(threadEvent("delete"));
    expect((await readThreads(storage, GUILD)).threads).toEqual({});
    expect(calls.deleted).toEqual([{ kind: "guild", guildId: GUILD, channelId: THREAD }]);
  });

  it("a message in an archived (stale) thread marks it open again and starts a run (Discord unarchives on send)", async () => {
    const { runtime, storage } = await setup({ paused: false });
    const start = vi
      .spyOn((runtime as unknown as { runner: { startChannelRun: (...a: unknown[]) => Promise<void> } }).runner, "startChannelRun")
      .mockResolvedValue(undefined);
    await observeThread(storage, GUILD, { threadId: THREAD, parentId: PARENT, name: "Best brownies", archived: true });
    await runtime.handleDiscordMessage({
      guildId: GUILD,
      channelId: THREAD,
      messageId: "900000000000000020",
      authorId: "kevin",
      authorBot: false,
      thread: THREAD_INFO
    });
    expect((await readThreads(storage, GUILD)).threads[THREAD]).toMatchObject({ archived: false });
    expect(start).toHaveBeenCalledWith(GUILD, THREAD, "message:900000000000000020", { trigger: "message" });
  });

  it("a message in a thread whose parent has threads off, or in a locked thread, starts nothing", async () => {
    const off = await setup({ paused: false, parentThreads: "off" });
    const offStart = vi
      .spyOn((off.runtime as unknown as { runner: { startChannelRun: (...a: unknown[]) => Promise<void> } }).runner, "startChannelRun")
      .mockResolvedValue(undefined);
    await off.runtime.handleDiscordMessage({ guildId: GUILD, channelId: THREAD, messageId: "900000000000000021", authorId: "kevin", authorBot: false, thread: THREAD_INFO });
    expect(offStart).not.toHaveBeenCalled();
    expect((await readThreads(off.storage, GUILD)).threads).toEqual({});

    const locked = await setup({ paused: false });
    const lockedStart = vi
      .spyOn((locked.runtime as unknown as { runner: { startChannelRun: (...a: unknown[]) => Promise<void> } }).runner, "startChannelRun")
      .mockResolvedValue(undefined);
    await locked.runtime.handleDiscordMessage({ guildId: GUILD, channelId: THREAD, messageId: "900000000000000022", authorId: "kevin", authorBot: false, thread: { ...THREAD_INFO, locked: true } });
    expect(lockedStart).not.toHaveBeenCalled();
  });
});

describe("/clear everything (spec 9.5)", () => {
  it("replies, then deletes the channel's conversation (ledger, refs and contexts)", async () => {
    const { runtime, calls } = await setup();
    const responses: string[] = [];
    await (runtime as unknown as { commands: { handleClearCommand: (e: unknown) => Promise<void> } }).commands.handleClearCommand({
      guildId: GUILD,
      channelId: PARENT,
      userId: "moderator",
      type: "everything",
      respond: async (content: string) => {
        responses.push(content);
        expect(calls.deleted).toEqual([]); // the reply goes out first
      }
    });
    expect(responses).toEqual(["Cleared 3 messages."]);
    expect(calls.deleted).toEqual([{ kind: "guild", guildId: GUILD, channelId: PARENT }]);
  });

  it("a count-based clear keeps the conversation", async () => {
    const { runtime, calls } = await setup();
    await (runtime as unknown as { commands: { handleClearCommand: (e: unknown) => Promise<void> } }).commands.handleClearCommand({
      guildId: GUILD,
      channelId: PARENT,
      userId: "moderator",
      type: "users",
      respond: async () => undefined
    });
    expect(calls.deleted).toEqual([]);
  });
});

describe("RuntimeOrchestrator.applyMessageEvent (the one adapter for conversation-cache style events)", () => {
  const conversation = { kind: "guild" as const, guildId: GUILD, channelId: PARENT };

  it("handles update with a cached previous version, and never re-triggers a catch-up edit", async () => {
    const id = "900000000000000002";
    const { runtime, calls } = await setup({ ledger: ledgerWithNewestHuman(id, "hey there") });
    const spy = vi.spyOn(runtime, "handleDiscordMessage").mockResolvedValue(undefined as never);
    const now = Date.now();
    const message = raw({
      id,
      channelId: PARENT,
      guildId: GUILD,
      content: `hey there <@${WAIFU_BOT}>`,
      createdAt: new Date(now - 30_000).toISOString(),
      editedAt: new Date(now).toISOString(),
      mentions: { users: { [WAIFU_BOT]: "Aria" }, roles: {}, channels: {} }
    });
    const previous = raw({ id, channelId: PARENT, guildId: GUILD, content: "hey there", createdAt: message.createdAt });
    await runtime.applyMessageEvent({ type: "update", conversation, message, previous, source: "catchup" });
    expect(calls.edits).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
    await runtime.applyMessageEvent({ type: "update", conversation, message, previous, source: "gateway" }, { thread: THREAD_INFO });
    expect(calls.edits).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ messageId: id, thread: THREAD_INFO });
  });

  it("handles delete and deleteBulk the same way, and ignores DM conversations", async () => {
    const { runtime, calls } = await setup();
    await runtime.applyMessageEvent({ type: "delete", conversation, messageId: "1", source: "gateway" });
    await runtime.applyMessageEvent({ type: "deleteBulk", conversation, messageIds: ["2", "3"] });
    await runtime.applyMessageEvent({ type: "delete", conversation: { kind: "dm", botId: "b", userId: "u" } as never, messageId: "4" });
    expect(calls.deletes.map((d) => d.ids)).toEqual([["1"], ["2", "3"]]);
    expect(calls.deletes.every((d) => d.redactRecent === 7)).toBe(true);
  });
});
