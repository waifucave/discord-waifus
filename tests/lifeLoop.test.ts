import { afterEach, describe, expect, it } from "vitest";
import { textTurn } from "./modelFakes.js";
import { ARIA_BOT, closeWorlds, KEVIN, lifeWorld, ROOM, ROOM_KEY, script, toolTurn, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";
import { readLifeLog, readLifeState } from "../src/life/lifeStore.js";
import { UNSENT_REPLY_NOTE } from "../src/life/lifeLoop.js";
import { newWakeId, enqueueWake } from "../src/life/wakeQueue.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

async function mention(world: LifeWorld, text = "aria are you coming saturday?") {
  const message = world.discord.post(ROOM, text, { mentions: { [ARIA_BOT]: "Aria" } });
  await world.cast.onGuildMessage({ guildId: ROOM.kind === "guild" ? ROOM.guildId : "", channelId: ROOM.kind === "guild" ? ROOM.channelId : "", messageId: message.id, castWaifuIds: ["aria"], authorIsWaifu: false });
  await world.cast.settle();
  return message;
}

describe("life loop", () => {
  it("wake → read → send: notifications, a read, a sent message, private text never sent", async () => {
    const world = await lifeWorld(roots, {
      scripts: script(
        toolTurn([{ name: "read_messages", input: { place: "bake-club/#general" } }], { text: "let me look" }),
        toolTurn([{ name: "send_message", input: { place: "bake-club/#general", text: "yes! i'll bring brownies" } }]),
        textTurn("that went well (private)")
      )
    });
    await mention(world);
    await world.cast.life("aria").runNow();
    expect(world.discord.sent.map((sent) => sent.content)).toEqual(["yes! i'll bring brownies"]);
    const state = await readLifeState(world.storage, "aria");
    expect(state.status).toBe("idle");
    const log = await readLifeLog(world.storage, "aria", state.epoch);
    expect(log.map((line) => line.kind)).toEqual(["notifications", "assistant", "tool_results", "assistant", "tool_results", "assistant"]);
    const first = JSON.stringify(log[0]!.message);
    expect(first).toContain("<notifications>");
    expect(first).toContain("mention · bake-club/#general · from Kevin");
    expect(first).toContain("aria are you coming saturday?");
    const read = JSON.stringify(log[2]!.message);
    expect(read).toContain("Kevin: aria are you coming saturday?");
    expect(JSON.stringify(log[4]!.message)).toMatch(/sent #[0-9a-z]+/);
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
    await world.cast.life("aria").runNow();
    expect(world.discord.sent).toEqual([]);
    const state = await readLifeState(world.storage, "aria");
    const log = await readLifeLog(world.storage, "aria", state.epoch);
    const notes = log.filter((line) => line.kind === "system_note").map((line) => JSON.stringify(line.message));
    expect(notes.filter((text) => text.includes(UNSENT_REPLY_NOTE.slice(0, 30)))).toHaveLength(1);
    expect(world.anthropic.calls).toHaveLength(2);
  });

  it("a reminder wake that ends in text gets no unsent-reply check", async () => {
    const world = await lifeWorld(roots, { scripts: script(textTurn("ok, noted")) });
    await enqueueWake(world.storage, "aria", { id: newWakeId(), reason: "reminder", note: "water the plants", at: world.clock.now().toISOString() });
    await world.cast.life("aria").runNow();
    expect(world.anthropic.calls).toHaveLength(1);
  });

  it("tool errors come back with is_error", async () => {
    const world = await lifeWorld(roots, {
      scripts: script(toolTurn([{ name: "read_messages", input: { place: "nowhere/#nothing" } }]), textTurn("oh well"))
    });
    await enqueueWake(world.storage, "aria", { id: newWakeId(), reason: "reminder", note: "x", at: world.clock.now().toISOString() });
    await world.cast.life("aria").runNow();
    const second = world.anthropic.calls[1]!.request.messages;
    const results = JSON.stringify(second[second.length - 1]);
    expect(results).toContain("error: unknown place; use list_places");
    expect(results).toContain("\"is_error\":true");
  });

  it("a mid-turn wake is folded into the next tool-results message", async () => {
    let world!: LifeWorld;
    world = await lifeWorld(roots, {
      scripts: [
        () => toolTurn([{ name: "list_places", input: {} }]),
        (request) => {
          void request;
          return textTurn("done");
        }
      ]
    });
    await enqueueWake(world.storage, "aria", { id: newWakeId(), reason: "reminder", note: "first", at: world.clock.now().toISOString() });
    // A wake that arrives during the first call.
    world.anthropic.scripts[0] = () => {
      void enqueueWake(world.storage, "aria", { id: newWakeId(), reason: "reminder", note: "second", at: world.clock.now().toISOString() });
      return toolTurn([{ name: "list_places", input: {} }]);
    };
    await world.cast.life("aria").runNow();
    const lastRequest = world.anthropic.calls[world.anthropic.calls.length - 1]!.request.messages;
    expect(JSON.stringify(lastRequest[lastRequest.length - 1])).toContain("second");
    expect(world.anthropic.calls).toHaveLength(2);
  });

  it("stops at the tool-round cap with a system line", async () => {
    const world = await lifeWorld(roots, {
      config: (config) => ({ ...config, life: { ...config.life, maxToolRounds: 2 } }),
      scripts: script(toolTurn([{ name: "list_places", input: {} }]))
    });
    await enqueueWake(world.storage, "aria", { id: newWakeId(), reason: "reminder", note: "loop", at: world.clock.now().toISOString() });
    await world.cast.life("aria").runNow();
    expect(world.anthropic.calls).toHaveLength(2);
    const state = await readLifeState(world.storage, "aria");
    const log = await readLifeLog(world.storage, "aria", state.epoch);
    expect(JSON.stringify(log[log.length - 1]!.message)).toContain("[system] turn ended: max tool rounds");
  });

  it("keeps the room and DM places as handles and remembers who wrote", async () => {
    const world = await lifeWorld(roots, { scripts: script(textTurn("ok")) });
    await mention(world, "hello <@aria>");
    await world.cast.life("aria").runNow();
    const handles = JSON.parse(JSON.stringify(await (await import("../src/life/lifeStore.js")).readLifeFile(world.storage, "aria", "handles")));
    expect(handles.primary[ROOM_KEY]).toBe("bake-club/#general");
    expect(KEVIN).toBeTruthy();
  });
});
