// A forgotten DM stays forgotten across a restart (Living cast §7.5, review C1). A forget deletes the
// DM state file and keeps the floor only in `limits/<waifu>.json`; boot must load floors from there,
// and `read_messages` checks the floor itself, so the person's old DMs are never readable again
// when they write after the restart. Both the DM `/forget everything` and the owner's forget-user.
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationKey } from "../src/orchestration/context/keys.js";
import { dmForget } from "../src/orchestration/dm/dmForget.js";
import { listDmStates, readDmFloor } from "../src/orchestration/dm/dmStore.js";
import { forgetUser } from "../src/orchestration/dm/forgetUser.js";
import { COMPACTION_INSTRUCTION } from "../src/life/compaction.js";
import { textTurn, type ScriptedTurn } from "./modelFakes.js";
import { closeWorlds, dmOf, KEVIN, lifeWorld, toolTurn, type LifeWorld } from "./lifeFixtures.js";
import { removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

const DM_KEY = conversationKey(dmOf("aria"));

async function dm(w: LifeWorld, cast: LifeWorld["cast"], text: string): Promise<void> {
  const message = w.discord.post(dmOf("aria"), text);
  await cast.onDirectMessage({ waifuId: "aria", botId: "aria-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: message.id, createdAt: message.createdAt });
}

/** She reads the DM whenever a notification arrives; compactions and checks get plain text. */
const reader: ScriptedTurn = (request) => {
  const last = JSON.stringify(request.messages.at(-1));
  if (last.includes(COMPACTION_INSTRUCTION.slice(0, 40))) return textTurn("A quiet DM.");
  if (last.includes("<notifications>")) return toolTurn([{ name: "read_messages", input: { place: DM_KEY } }]);
  return textTurn("(nothing to send)");
};

describe("a forgotten DM after a restart", () => {
  for (const how of ["DM /forget everything", "owner forget-user"] as const) {
    it(`${how}: the old messages are not readable when the person writes again`, async () => {
      const w = await lifeWorld(roots, { scripts: [reader] });
      vi.spyOn(w.cast.life("aria"), "poke").mockImplementation(() => undefined);
      await dm(w, w.cast, "my secret recipe uses cardamom");
      await dm(w, w.cast, "don't tell anyone");
      w.cast.intake.flushDms();
      await w.cast.settle();
      await w.cast.life("aria").runNow();
      expect(JSON.stringify(w.anthropic.calls[1]!.request.messages)).toContain("cardamom");

      w.clock.advance(60_000);
      if (how === "DM /forget everything") await dmForget(w.storage, { userId: KEVIN, waifuId: "aria", scope: "all" }, { now: w.clock.now });
      else await forgetUser(w.storage, { discordUserId: KEVIN }, { now: w.clock.now });
      expect(await listDmStates(w.storage)).toEqual([]);
      expect(await readDmFloor(w.storage, KEVIN, "aria")).toBeDefined();

      // A restart: a fresh cast and cache over the same data root and Discord history.
      await w.cast.stop();
      w.clock.advance(60_000);
      const again = w.restart();
      vi.spyOn(again.life("aria"), "poke").mockImplementation(() => undefined);
      await again.start();
      await dm(w, again, "hi again, it's me");
      again.intake.flushDms();
      await again.settle();
      await again.life("aria").runNow();
      // The newest read_messages result in her last request is the one after the restart.
      const results = w.anthropic.calls.at(-1)!.request.messages.flatMap((message) =>
        Array.isArray(message.content) ? (message.content as Array<{ type: string }>).filter((block) => block.type === "tool_result") : []
      );
      const seen = JSON.stringify(results.at(-1));
      expect(seen).toContain("hi again, it's me");
      expect(seen).not.toContain("cardamom");
      expect(seen).not.toContain("don't tell anyone");
      expect(seen).not.toContain("older messages available");
      // Not even as removed lines: below the floor nothing is served at all.
      expect(seen).not.toContain("(removed)");
    });
  }
});
