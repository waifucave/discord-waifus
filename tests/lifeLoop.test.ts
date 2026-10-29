import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { textTurn } from "./modelFakes.js";
import { ELLA_BOT, closeWorlds, dmOf, KEVIN, lifeWorld, MINA_USER, ROOM, ROOM_KEY, script, toolTurn, type LifeWorld } from "./lifeFixtures.js";
import { scanDmContent, viewLogLine } from "../src/life/lifeView.js";
import { removeTempRoot } from "./testUtils.js";
import { readLifeFile, readLifeLog, readLifeState, updateLifeState } from "../src/life/lifeStore.js";
import { repairLife } from "../src/life/repair.js";
import { UNSENT_REPLY_NOTE } from "../src/life/lifeLoop.js";
import { newWakeId, enqueueWake } from "../src/life/wakeQueue.js";
import { SEARCH_USAGE_PATH } from "../src/life/search.js";
import { SearchUsageSchema } from "../src/shared/schemas/life.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { scriptInput } from "./toolCalls.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

async function mention(world: LifeWorld, text = "ella are you coming saturday?") {
  const message = world.discord.post(ROOM, text, { mentions: { [ELLA_BOT]: "Ella" } });
  await world.cast.onGuildMessage({ guildId: ROOM.kind === "guild" ? ROOM.guildId : "", channelId: ROOM.kind === "guild" ? ROOM.channelId : "", messageId: message.id, castWaifuIds: ["ella"], authorIsWaifu: false });
  await world.cast.settle();
  // Her wake waits for the burst's quiet time (§4.2): fire it now.
  world.cast.intake.flushDetector();
  await world.cast.settle();
  return message;
}

describe("life loop", () => {
  it("wake → read → send: notifications, a read, a sent message, private text never sent", async () => {
    const world = await lifeWorld(roots, {
      scripts: script(
        toolTurn([{ name: "ReadMessages", input: scriptInput.readMessages({ place: "bake-club/#general" }) }], { text: "let me look" }),
        toolTurn([{ name: "SendMessage", input: scriptInput.sendMessage("bake-club/#general", [{ text: "yes! i'll bring brownies" }]) }]),
        textTurn("that went well (private)")
      )
    });
    await mention(world);
    await world.cast.life("ella").runNow();
    expect(world.discord.sent.map((sent) => sent.content)).toEqual(["yes! i'll bring brownies"]);
    const state = await readLifeState(world.storage, "ella");
    expect(state.status).toBe("idle");
    const log = await readLifeLog(world.storage, "ella", state.epoch);
    expect(log.map((line) => line.kind)).toEqual(["notifications", "assistant", "tool_results", "assistant", "tool_results", "assistant"]);
    const first = JSON.stringify(log[0]!.message);
    expect(first).toContain("<notifications>");
    expect(first).toContain("mention · bake-club/#general · from Kevin");
    expect(first).toContain("ella are you coming saturday?");
    const read = JSON.stringify(log[2]!.message);
    expect(read).toContain("Kevin: ella are you coming saturday?");
    expect(JSON.stringify(log[4]!.message)).toMatch(/\\"sent\\":\[\\"#[0-9a-z]+\\"\]/);
    // Exactly one system prompt pair, and no role:"system" message ever.
    for (const call of world.anthropic.calls) {
      expect(call.request.messages.some((message) => message.role === "system")).toBe(false);
      expect(call.request.systemBlocks?.length).toBe(2);
    }
    expect(state.readMessageIds.length).toBeGreaterThan(0);
  });

  it("ignores a wake without sending, and the unsent-reply check fires once for a direct wake", async () => {
    const world = await lifeWorld(roots, { scripts: script(textTurn("hmm, not now"), textTurn("still no")) });
    await mention(world);
    await world.cast.life("ella").runNow();
    expect(world.discord.sent).toEqual([]);
    const state = await readLifeState(world.storage, "ella");
    const log = await readLifeLog(world.storage, "ella", state.epoch);
    const notes = log.filter((line) => line.kind === "system_note").map((line) => JSON.stringify(line.message));
    expect(notes.filter((text) => text.includes(UNSENT_REPLY_NOTE.slice(0, 30)))).toHaveLength(1);
    expect(world.anthropic.calls).toHaveLength(2);
  });

  it("a reminder wake that ends in text gets no unsent-reply check", async () => {
    const world = await lifeWorld(roots, { scripts: script(textTurn("ok, noted")) });
    await enqueueWake(world.storage, "ella", { id: newWakeId(), reason: "reminder", note: "water the plants", at: world.clock.now().toISOString() });
    await world.cast.life("ella").runNow();
    expect(world.anthropic.calls).toHaveLength(1);
  });

  it("tool errors come back with is_error", async () => {
    const world = await lifeWorld(roots, {
      scripts: script(toolTurn([{ name: "ReadMessages", input: scriptInput.readMessages({ place: "nowhere/#nothing" }) }]), textTurn("oh well"))
    });
    await enqueueWake(world.storage, "ella", { id: newWakeId(), reason: "reminder", note: "x", at: world.clock.now().toISOString() });
    await world.cast.life("ella").runNow();
    const second = world.anthropic.calls[1]!.request.messages;
    const results = JSON.stringify(second[second.length - 1]);
    expect(results).toContain("error: Error: tools.read_messages: unknown place; see ~/life/places.md (line 1)");
    expect(results).toContain("\"is_error\":true");
  });

  it("a mid-turn wake is folded into the next tool-results message", async () => {
    let world!: LifeWorld;
    world = await lifeWorld(roots, {
      scripts: [
        () => toolTurn([{ name: "Read", input: scriptInput.readFile("~/life/places.md") }]),
        (request) => {
          void request;
          return textTurn("done");
        }
      ]
    });
    await enqueueWake(world.storage, "ella", { id: newWakeId(), reason: "reminder", note: "first", at: world.clock.now().toISOString() });
    // A wake that arrives during the first call.
    world.anthropic.scripts[0] = () => {
      void enqueueWake(world.storage, "ella", { id: newWakeId(), reason: "reminder", note: "second", at: world.clock.now().toISOString() });
      return toolTurn([{ name: "Read", input: scriptInput.readFile("~/life/places.md") }]);
    };
    await world.cast.life("ella").runNow();
    const lastRequest = world.anthropic.calls[world.anthropic.calls.length - 1]!.request.messages;
    expect(JSON.stringify(lastRequest[lastRequest.length - 1])).toContain("second");
    expect(world.anthropic.calls).toHaveLength(2);
  });

  it("has no round cap, but ends a turn whose same calls fail three rounds in a row", async () => {
    const world = await lifeWorld(roots, {
      scripts: [
        ...Array.from({ length: 14 }, () => () => toolTurn([{ name: "Read", input: scriptInput.readFile("~/life/places.md") }])),
        ...Array.from({ length: 4 }, () => () => toolTurn([{ name: "SendMessage", input: { place: "bake-club/#general" } }]))
      ]
    });
    await enqueueWake(world.storage, "ella", { id: newWakeId(), reason: "reminder", note: "loop", at: world.clock.now().toISOString() });
    await world.cast.life("ella").runNow();
    // 14 working rounds go on; the empty send fails three times and the turn ends.
    expect(world.anthropic.calls).toHaveLength(17);
    const state = await readLifeState(world.storage, "ella");
    const log = await readLifeLog(world.storage, "ella", state.epoch);
    expect(JSON.stringify(log[log.length - 1]!.message)).toContain("[system] turn ended: the same call kept failing");
  });

  it("keeps the room and DM places as handles and remembers who wrote", async () => {
    const world = await lifeWorld(roots, { scripts: script(textTurn("ok")) });
    await mention(world, "hello <@ella>");
    await world.cast.life("ella").runNow();
    const handles = JSON.parse(JSON.stringify(await (await import("../src/life/lifeStore.js")).readLifeFile(world.storage, "ella", "handles")));
    expect(handles.primary[ROOM_KEY]).toBe("bake-club/#general");
    expect(KEVIN).toBeTruthy();
  });

  it("records which wakes and calls were about a DM, so the owner's views decide on what resolved (D14, §14.4)", async () => {
    const world = await lifeWorld(roots, {
      scripts: script(
        // A DM place spelled the way resolvePlace accepts it, and a web search in the same (DM) turn.
        toolTurn([{ name: "ReadMessages", input: scriptInput.readMessages({ place: " <DM/Kevin> " }) }, { name: "ReadMessages", input: scriptInput.readMessages({ place: "bake-club/#general" }) }]),
        textTurn("he needs a hug"),
        toolTurn([{ name: "ReadMessages", input: scriptInput.readMessages({ place: "bake-club/#general" }) }]),
        textTurn("cake time")
      )
    });
    const dm = world.discord.post(dmOf("ella"), "my exam went badly");
    await world.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: dm.id, createdAt: dm.createdAt });
    world.cast.intake.flushDms();
    await world.cast.settle();
    await world.cast.life("ella").runNow();
    await mention(world, "ella cake?");
    await world.cast.life("ella").runNow();
    const state = await readLifeState(world.storage, "ella");
    const log = await readLifeLog(world.storage, "ella", state.epoch);
    const notifications = log.filter((line) => line.kind === "notifications");
    expect(notifications.map((line) => line.dmWakes)).toEqual([true, false]);
    const results = log.filter((line) => line.kind === "tool_results");
    const dmCallId = (log[1]!.message!["content"] as Array<{ id: string }>)[0]!.id;
    expect(results[0]!.dmCalls).toEqual([dmCallId]);
    expect(results[1]!.dmCalls).toEqual([]);
    const scan = scanDmContent(log);
    const shown = log.map((line) => viewLogLine(line, scan, { includePrivate: false }).view);
    const text = JSON.stringify(shown);
    expect(text).not.toContain("exam");
    expect(text).not.toContain("hug");
    // The room turn after it is shown in full.
    expect(text).toContain("cake time");
    expect(text).toContain("ella cake?");
  });

  it("a Wakeup in a room turn that watches a DM is a DM call: the owner's views hide it (D14, §30.3)", async () => {
    const world = await lifeWorld(roots, {
      scripts: script(
        textTurn("(later)"),
        toolTurn([{ name: "Wakeup", input: { script: 'text(await tools.wakeup({ watch: [{ places: "dm/kevin", words: ["biopsy"], for: "1d", note: "ask how the biopsy went" }], at: [{ when: "in 1h", note: "bake" }] }))' } }]),
        textTurn("cake time")
      )
    });
    const dm = world.discord.post(dmOf("ella"), "hi");
    await world.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: dm.id, createdAt: dm.createdAt });
    world.cast.intake.flushDms();
    await world.cast.settle();
    await world.cast.life("ella").runNow();
    await mention(world, "ella cake?");
    await world.cast.life("ella").runNow();
    const state = await readLifeState(world.storage, "ella");
    const log = await readLifeLog(world.storage, "ella", state.epoch);
    const results = log.filter((line) => line.kind === "tool_results");
    expect(results.at(-1)!.dmCalls).toHaveLength(1);
    const scan = scanDmContent(log);
    const text = JSON.stringify(log.map((line) => viewLogLine(line, scan, { includePrivate: false }).view));
    expect(text).not.toContain("biopsy");
  });

  it("records a DM turn's web searches as private, also one made before the turn touched a DM (review: DM turns)", async () => {
    const backend = {
      search: async () => ({ ok: true as const, tier: "anonymous" as const, tool: "web_search_exa", rawText: "", truncated: false, results: [] }),
      fetchPage: async () => {
        throw new Error("no page fetches in this test");
      },
      close: async () => undefined
    };
    const world = await lifeWorld(roots, {
      options: { webBackend: backend as never },
      scripts: script(
        // Turn 1 (a DM wake): a search.
        toolTurn([{ name: "Web", input: scriptInput.web({ search_query: [{ q: "how to comfort a friend after a failed exam" }] }) }]),
        textTurn("ok"),
        // Turn 2 (a room mention): a search, then a DM read: the turn becomes a DM turn.
        toolTurn([{ name: "Web", input: scriptInput.web({ search_query: [{ q: "lemon cake" }] }) }]),
        toolTurn([{ name: "ReadMessages", input: scriptInput.readMessages({ place: "dm/kevin" }) }]),
        textTurn("ok"),
        // Turn 3 (a room mention): a search only.
        toolTurn([{ name: "Web", input: scriptInput.web({ search_query: [{ q: "sprinkles" }] }) }]),
        textTurn("ok")
      )
    });
    const dm = world.discord.post(dmOf("ella"), "my exam went badly");
    await world.cast.onDirectMessage({ waifuId: "ella", botId: "ella-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: dm.id, createdAt: dm.createdAt });
    world.cast.intake.flushDms();
    await world.cast.settle();
    await world.cast.life("ella").runNow();
    await mention(world, "ella cake?");
    await world.cast.life("ella").runNow();
    await mention(world, "ella sprinkles?");
    await world.cast.life("ella").runNow();
    const usage = await world.storage.readJson(SEARCH_USAGE_PATH, SearchUsageSchema, SearchUsageSchema.parse({ ...createRevisionedBase() }));
    expect(usage.recent.map((entry) => [entry.query, entry.dm === true])).toEqual([
      ["how to comfort a friend after a failed exam", true],
      ["lemon cake", true],
      ["sprinkles", false]
    ]);
  });
});

describe("mid-turn notifications (§4.6, §5.2)", () => {
  const lifeFile = (world: LifeWorld, name: string) => path.join(world.root, "user", "waifus", "ella", "life", name);
  /** A mention from Mina in the room, queued as the router queues it once its burst fired. */
  function minaPing(world: LifeWorld, text: string) {
    const message = world.discord.post(ROOM, text, { authorId: MINA_USER, authorName: "Mina" });
    return enqueueWake(world.storage, "ella", { id: `w-${message.id}`, reason: "mention", placeKey: ROOM_KEY, fromUserId: MINA_USER, fromName: "Mina", messageId: message.id, preview: text, at: world.clock.now().toISOString() });
  }
  const reminder = (world: LifeWorld, note: string) => enqueueWake(world.storage, "ella", { id: newWakeId(), reason: "reminder", note, at: world.clock.now().toISOString() });

  it("a wake that becomes ready during a tool call is delivered right after it: after the tool results, with refs, before the time line; never inside the running call", async () => {
    let world!: LifeWorld;
    const backend = {
      search: async () => {
        // Mina pings her while the search runs.
        await minaPing(world, "ella can you bring the piping bags?");
        return { ok: true as const, tier: "anonymous" as const, tool: "web_search_exa", rawText: "", truncated: false, results: [] };
      },
      fetchPage: async () => {
        throw new Error("no page fetches in this test");
      },
      close: async () => undefined
    };
    world = await lifeWorld(roots, {
      options: { webBackend: backend as never },
      scripts: script(toolTurn([{ name: "Web", input: scriptInput.web({ search_query: [{ q: "piping bag sizes" }] }) }]), textTurn("ok"))
    });
    await reminder(world, "look up piping bags");
    await world.cast.life("ella").runNow();
    // The folded mention makes the turn direct: her plain-text end gets the unsent-reply check.
    expect(world.anthropic.calls).toHaveLength(3);
    expect(JSON.stringify(world.anthropic.calls[0]!.request.messages)).not.toContain("piping bags?");
    const messages = world.anthropic.calls[1]!.request.messages;
    const blocks = messages[messages.length - 1]!.content as Array<{ type: string; text?: string }>;
    expect(blocks.map((block) => block.type)).toEqual(["tool_result", "text", "text"]);
    expect(blocks[1]!.text).toMatch(/^<notifications>\n- mention · bake-club\/#general · from Mina · (?:\d+ unread · )?#[0-9a-z]+ "ella can you bring the piping bags\?"\n<\/notifications>$/);
    expect(blocks[2]!.text).toMatch(/^\[.*\]$/);
    // Taken exactly once: the queue is empty, and one log line shows it.
    expect((await readLifeFile(world.storage, "ella", "wakes")).immediate).toEqual([]);
    const state = await readLifeState(world.storage, "ella");
    const log = await readLifeLog(world.storage, "ella", state.epoch);
    expect(log.filter((line) => JSON.stringify(line.message).includes("piping bags?"))).toHaveLength(1);
    expect(log.map((line) => line.kind)).toEqual(["notifications", "assistant", "tool_results", "assistant", "system_note", "assistant"]);
  });

  it("a turn that ends in plain text leaves a wake that arrived during its last call for the next turn", async () => {
    let world!: LifeWorld;
    world = await lifeWorld(roots, {
      scripts: [
        async function* () {
          await minaPing(world, "ella you there?");
          yield* textTurn("ok, noted");
        },
        () => textTurn("(later)"),
        () => textTurn("(nothing to send)")
      ]
    });
    await reminder(world, "water the plants");
    await world.cast.life("ella").runNow();
    expect(JSON.stringify(world.anthropic.calls[0]!.request.messages)).not.toContain("ella you there?");
    const state = await readLifeState(world.storage, "ella");
    const log = await readLifeLog(world.storage, "ella", state.epoch);
    // The second turn opens with it.
    const opened = log.filter((line) => line.kind === "notifications").map((line) => JSON.stringify(line.message));
    expect(opened).toHaveLength(2);
    expect(opened[1]).toContain("ella you there?");
    expect(log.filter((line) => JSON.stringify(line.message).includes("ella you there?"))).toHaveLength(1);
    expect((await readLifeFile(world.storage, "ella", "wakes")).immediate).toEqual([]);
  });

  it("a crash after a fold puts every wake of the open turn back once; a crash between recording and taking a wake doubles nothing", async () => {
    let world!: LifeWorld;
    let snapshot: { state: string; wakes: string } | undefined;
    world = await lifeWorld(roots, {
      scripts: [
        async function* () {
          await minaPing(world, "ella are the tarts ready?");
          yield* toolTurn([{ name: "Read", input: scriptInput.readFile("~/life/places.md") }]);
        },
        async function* () {
          // The process dies during the call after the fold: what is on disk now is what boot sees.
          snapshot = { state: await readFile(lifeFile(world, "state.json"), "utf8"), wakes: await readFile(lifeFile(world, "wakes.json"), "utf8") };
          yield* textTurn("done");
        },
        () => textTurn("(nothing to send)")
      ]
    });
    await reminder(world, "check the oven");
    await world.cast.life("ella").runNow();
    expect(snapshot).toBeDefined();
    const atCrash = JSON.parse(snapshot!.state) as { currentTurn: { wakes: Array<{ reason: string }> } };
    expect(atCrash.currentTurn.wakes.map((wake) => wake.reason)).toEqual(["reminder", "mention"]);
    expect((JSON.parse(snapshot!.wakes) as { immediate: unknown[] }).immediate).toEqual([]);
    await writeFile(lifeFile(world, "state.json"), snapshot!.state);
    await writeFile(lifeFile(world, "wakes.json"), snapshot!.wakes);
    await repairLife(world.cast.deps, "ella");
    const queued = (await readLifeFile(world.storage, "ella", "wakes")).immediate;
    expect(queued.map((wake) => wake.reason)).toEqual(["reminder", "mention"]);
    // Recorded in her state but still in the queue (the crash came before the take): one copy each.
    await updateLifeState(world.storage, "ella", (current) => ({ ...current, status: "turn", currentTurn: { id: "t-x", startedAt: world.clock.now().toISOString(), rounds: 1, wakeIds: queued.map((wake) => wake.id), wakes: queued } }));
    await repairLife(world.cast.deps, "ella");
    expect((await readLifeFile(world.storage, "ella", "wakes")).immediate.map((wake) => wake.id)).toEqual(queued.map((wake) => wake.id));
  });

  it("a round that ends the turn (a cap) folds nothing: the wake starts the next turn", async () => {
    let world!: LifeWorld;
    world = await lifeWorld(roots, {
      scripts: [
        async function* () {
          await minaPing(world, "ella quick one");
          world.clock.advance(181_000);
          yield* toolTurn([{ name: "Read", input: scriptInput.readFile("~/life/places.md") }]);
        },
        () => textTurn("(next turn)"),
        () => textTurn("(nothing to send)")
      ]
    });
    await reminder(world, "loop");
    await world.cast.life("ella").runNow();
    const state = await readLifeState(world.storage, "ella");
    const log = await readLifeLog(world.storage, "ella", state.epoch);
    const capped = log.find((line) => line.kind === "tool_results")!;
    expect(JSON.stringify(capped.message)).toContain("[system] turn ended: max turn time");
    expect(JSON.stringify(capped.message)).not.toContain("ella quick one");
    expect(JSON.stringify(log.filter((line) => line.kind === "notifications")[1]!.message)).toContain("ella quick one");
  });
});
