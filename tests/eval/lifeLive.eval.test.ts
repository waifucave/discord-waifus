// Live evaluation of a life on every curated route (Living cast spec §12). OFF unless
// WAIFUS_EVAL_LIVE=1: it makes real model calls on the owner's keys and costs money, so it needs the
// owner's approval to run. Discord stays the in-memory fake and the data root a temp dir; only the
// provider calls are live.
//
//   WAIFUS_EVAL_LIVE=1 WAIFUS_EVAL_KEYS_ROOT=<a data root with user/providers.json> \
//     npx vitest run tests/eval/lifeLive.eval.test.ts
//
// WAIFUS_EVAL_KEYS_ROOT is required (there is no default data root: the eval never touches a real
// host's data). Keys are read from it per call and never printed. WAIFUS_EVAL_ROUTES (comma-separated
// `provider/model` keys) narrows the routes. A report goes to tests/eval/reports/ (git-ignored).
//
// Per route, 30 scripted wakes: direct questions in a room, off-topic room messages the detector
// handed her, new personal facts in a DM and ordinary DMs. Targets:
//   - reads before replying in ≥ 90% of answered wakes;
//   - answers ≤ 20% of off-topic pings;
//   - writes a note within the turn for ≥ 70% of "new personal fact" scenarios;
//   - the unsent-reply check fires on ≤ 10% of direct wakes;
//   - cost per answered wake is reported.

import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { curatedCatalog } from "../../src/models/catalog.js";
import { ModelClient } from "../../src/models/client.js";
import { createProviderCredentialsLookup } from "../../src/models/credentials.js";
import { createWinterRuntime } from "../../src/models/winter.js";
import { readLifeLog, readLifeState } from "../../src/life/lifeStore.js";
import { UNSENT_REPLY_NOTE } from "../../src/life/lifeLoop.js";
import { newWakeId, enqueueWake } from "../../src/life/wakeQueue.js";
import { atomicWriteJson } from "../../src/storage/atomic.js";
import type { LifeLogLine } from "../../src/shared/schemas/life.js";
import { ARIA_BOT, CHANNEL, closeWorlds, dmOf, GUILD, KEVIN, lifeWorld, MINA_USER, ROOM, ROOM_KEY, type LifeWorld } from "../lifeFixtures.js";
import { removeTempRoot } from "../testUtils.js";

const LIVE = process.env.WAIFUS_EVAL_LIVE === "1";
const KEYS_ROOT = process.env.WAIFUS_EVAL_KEYS_ROOT;

type Kind = "direct" | "offtopic" | "fact" | "dm";
type Scenario = { kind: Kind; text: string };

const SCENARIOS: Scenario[] = [
  ...[
    "are you coming to the bake sale on saturday?",
    "what's your favourite thing to bake when it's raining?",
    "can you remind me how long brownies need in the oven?",
    "do you think lemon or raspberry for the tart?",
    "hey, how was your week?",
    "which one of you made the cinnamon rolls last time?",
    "would you rather bake bread or cookies tonight?",
    "any tips for keeping a cake moist?",
    "did you see the new oven at the club?",
    "what should I name my sourdough starter?",
    "can you help me pick a theme for the bake sale?",
    "are you any good at decorating cupcakes?"
  ].map((text): Scenario => ({ kind: "direct", text })),
  ...[
    "@Sam did you pay the electricity bill yet?",
    "lol",
    "https://example.com/some-random-link",
    "Sam, your car is blocking the driveway again",
    "!roll 2d6",
    "ok"
  ].map((text): Scenario => ({ kind: "offtopic", text })),
  ...[
    "I just adopted a cat named Miso!",
    "I'm allergic to hazelnuts, just so you know",
    "my sister's wedding is on november 14th",
    "I started a new job at the library this week",
    "I'm moving to Lisbon next month",
    "my favourite cake is carrot cake, always has been"
  ].map((text): Scenario => ({ kind: "fact", text })),
  ...[
    "hey, quick question about your lemon tart recipe",
    "can't sleep, what are you up to?",
    "thanks for the advice yesterday, it worked",
    "do you want to bake together this weekend?",
    "what's the secret to a good pie crust?",
    "I burnt my cookies again lol"
  ].map((text): Scenario => ({ kind: "dm", text }))
];

type WakeResult = { kind: Kind; answered: boolean; readFirst: boolean; wroteNote: boolean; unsentCheck: boolean };

function turnCalls(lines: readonly LifeLogLine[]): string[] {
  const calls: string[] = [];
  for (const line of lines) {
    if (line.kind !== "assistant" || !line.message) continue;
    const content = (line.message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; name?: string }>) if (block.type === "tool_use" && block.name) calls.push(block.name);
  }
  return calls;
}

async function wake(w: LifeWorld, scenario: Scenario): Promise<WakeResult> {
  const before = (await readLifeLog(w.storage, "aria", (await readLifeState(w.storage, "aria")).epoch).catch(() => [])).length;
  const epochBefore = (await readLifeState(w.storage, "aria")).epoch;
  if (scenario.kind === "direct") {
    const message = w.discord.post(ROOM, `<@${ARIA_BOT}> ${scenario.text}`, { mentions: { [ARIA_BOT]: "Aria" } });
    await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["aria"], authorIsWaifu: false, raw: message });
  } else if (scenario.kind === "offtopic") {
    const message = w.discord.post(ROOM, scenario.text, { authorId: MINA_USER, authorName: "Mina" });
    // As if the detector had chosen her ("maybe for you").
    await enqueueWake(w.storage, "aria", { id: newWakeId(), reason: "detector", placeKey: ROOM_KEY, fromUserId: MINA_USER, fromName: "Mina", messageId: message.id, preview: scenario.text.slice(0, 60), at: w.clock.now().toISOString() });
  } else {
    const message = w.discord.post(dmOf("aria"), scenario.text);
    await w.cast.onDirectMessage({ waifuId: "aria", botId: "aria-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: message.id, createdAt: message.createdAt });
    w.cast.intake.flushDms();
  }
  await w.cast.settle();
  const sentBefore = w.discord.sent.length;
  await w.cast.life("aria").runNow();
  const state = await readLifeState(w.storage, "aria");
  const lines = (await readLifeLog(w.storage, "aria", state.epoch)).slice(state.epoch === epochBefore ? before : 0);
  const calls = turnCalls(lines);
  const firstSend = calls.indexOf("send_message");
  return {
    kind: scenario.kind,
    answered: w.discord.sent.length > sentBefore,
    readFirst: firstSend >= 0 && calls.slice(0, firstSend).includes("read_messages"),
    wroteNote: calls.includes("write_note") || calls.includes("edit_note"),
    unsentCheck: lines.some((line) => line.kind === "system_note" && JSON.stringify(line.message).includes(UNSENT_REPLY_NOTE.slice(0, 30)))
  };
}

const roots: string[] = [];
const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), routes: {} };

afterAll(async () => {
  await closeWorlds();
  for (const root of roots.splice(0)) await removeTempRoot(root);
  if (LIVE) await atomicWriteJson(path.resolve("tests/eval/reports", `life-live-${Date.now()}.json`), report);
});

describe.skipIf(!LIVE)("live life evaluation (WAIFUS_EVAL_LIVE=1)", () => {
  if (LIVE && !KEYS_ROOT) throw new Error("WAIFUS_EVAL_KEYS_ROOT must name the data root whose user/providers.json holds the keys.");
  const credentials = createProviderCredentialsLookup(KEYS_ROOT ?? "");
  const wanted = (process.env.WAIFUS_EVAL_ROUTES ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const routes = curatedCatalog().models.filter((model) => !model.contributor && (wanted.length === 0 || wanted.includes(model.id)));

  for (const route of routes) {
    it(`${route.id}: 30 scripted wakes`, { timeout: 30 * 60_000 }, async () => {
      if (!credentials(route.providerId)) {
        (report.routes as Record<string, unknown>)[route.id] = { skipped: "no key" };
        return;
      }
      const w = await lifeWorld(roots, {
        waifus: [{ id: "aria", name: "Aria", botId: "aria-bot", model: { providerId: route.providerId, modelId: route.modelId }, persona: "Aria is a sunny baker in the Bake Club. She is warm, a little chaotic, and loves lemon tarts." }],
        models: ({ ledger, clock }) => new ModelClient({ winter: createWinterRuntime(), credentials, usageLedger: ledger, now: () => clock.ms })
      });
      const results: WakeResult[] = [];
      for (const scenario of SCENARIOS) {
        results.push(await wake(w, scenario));
        w.clock.advance(7 * 60_000);
      }
      const answered = results.filter((result) => result.answered && result.kind !== "offtopic");
      const direct = results.filter((result) => result.kind === "direct" || result.kind === "dm" || result.kind === "fact");
      const offtopic = results.filter((result) => result.kind === "offtopic");
      const facts = results.filter((result) => result.kind === "fact");
      const cost = w.ledger.lines.filter((line) => line.purpose === "life" || line.purpose === "compaction").reduce((sum, line) => sum + (line.costUsd ?? 0), 0);
      const metrics = {
        readsBeforeReplying: answered.length ? answered.filter((result) => result.readFirst).length / answered.length : null,
        offTopicAnswered: offtopic.filter((result) => result.answered).length / offtopic.length,
        notesForNewFacts: facts.filter((result) => result.wroteNote).length / facts.length,
        unsentReplyCheck: direct.filter((result) => result.unsentCheck).length / direct.length,
        costPerAnsweredWakeUsd: answered.length ? cost / answered.length : null,
        totalCostUsd: cost,
        calls: w.ledger.lines.length
      };
      (report.routes as Record<string, unknown>)[route.id] = { metrics, results };
      console.log(route.id, JSON.stringify(metrics));
      expect(metrics.readsBeforeReplying ?? 0).toBeGreaterThanOrEqual(0.9);
      expect(metrics.offTopicAnswered).toBeLessThanOrEqual(0.2);
      expect(metrics.notesForNewFacts).toBeGreaterThanOrEqual(0.7);
      expect(metrics.unsentReplyCheck).toBeLessThanOrEqual(0.1);
    });
  }
});
