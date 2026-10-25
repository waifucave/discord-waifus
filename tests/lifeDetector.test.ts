// The addressee detector's pure parts (Living cast spec §4.3): the question and its JSON state (cast
// caps, 12 messages, 8,000 characters, newest kept), the weighted `anyone` draw and the fallback.
// The mapping, history and failure path run through intake in lifeWakes.test.ts.
import { describe, expect, it } from "vitest";
import { DETECTOR_MAX_CHAT_CHARS, detectorQuestion, drawAnyone, fallbackIsAnyone, type DetectorCastMember, type DetectorMessage } from "../src/life/detector/decider.js";

const NOW = new Date("2026-10-24T14:00:00.000Z");
const member = (index: number): DetectorCastMember => ({ waifuId: `w${index}`, names: [`Name${index}`], persona: "p".repeat(400) });
const message = (index: number, text = `message ${index}`): DetectorMessage => ({ id: String(1000 + index), authorKind: index % 2 ? "waifu" : "user", name: `Author${index}`, at: new Date(NOW.getTime() - (30 - index) * 60_000).toISOString(), text });

describe("detector question (§4.3)", () => {
  it("offers waifu_<i> per cast member (at most 6 for Laya, 16 otherwise) plus human, anyone, all and none: at most 10 / 20 options", () => {
    const cast = Array.from({ length: 20 }, (_, index) => member(index));
    const laya = detectorQuestion({ target: "laya:english", now: NOW, timeZone: "UTC", cast, messages: [message(1)] });
    const api = detectorQuestion({ target: "openai:gpt-6-luna", now: NOW, timeZone: "UTC", cast, messages: [message(1)] });
    expect(Object.keys(laya.questions["addressee"]!.criteria)).toEqual([...Array.from({ length: 6 }, (_, index) => `waifu_${index}`), "human", "anyone", "all", "none"]);
    expect(Object.keys(api.questions["addressee"]!.criteria)).toHaveLength(20);
    expect(laya.candidates.map((candidate) => candidate.waifuId)).toEqual(["w0", "w1", "w2", "w3", "w4", "w5"]);
    const state = JSON.parse(laya.state) as { date: string; now: string; cast: Array<{ option: string; id: string; persona: string }> };
    expect(state).toMatchObject({ date: "2026-10-24", now: "14:00" });
    expect(state.cast[0]).toMatchObject({ option: "waifu_0", id: "w0" });
    expect(state.cast[0]!.persona).toHaveLength(300);
  });

  it("marks a Discord reply with the name of the author it answers, and nothing else", () => {
    const messages: DetectorMessage[] = [message(1), { ...message(2), replyTo: "Mira" }];
    const chat = JSON.parse(detectorQuestion({ target: "openai:gpt-6-luna", now: NOW, timeZone: "UTC", cast: [member(0)], messages }).state).chronologicalChat as Array<Record<string, unknown>>;
    expect(chat[0]).not.toHaveProperty("replyTo");
    expect(chat[1]).toMatchObject({ replyTo: "Mira" });
  });

  it("keeps the last 12 messages within 8,000 characters, newest kept, in chronological order", () => {
    const many = Array.from({ length: 20 }, (_, index) => message(index));
    const twelve = JSON.parse(detectorQuestion({ target: "openai:gpt-6-luna", now: NOW, timeZone: "UTC", cast: [member(0)], messages: many }).state).chronologicalChat as Array<{ text: string; actor: string }>;
    expect(twelve.map((line) => line.text)).toEqual(many.slice(-12).map((entry) => entry.text));
    expect(twelve[0]!.actor).toBe("user");
    const long = Array.from({ length: 12 }, (_, index) => message(index, `${index} ${"x".repeat(1_400)}`));
    const state = detectorQuestion({ target: "openai:gpt-6-luna", now: NOW, timeZone: "UTC", cast: [member(0)], messages: long }).state;
    const chat = JSON.parse(state).chronologicalChat as Array<{ text: string }>;
    expect(chat.length).toBeLessThan(12);
    expect(chat[chat.length - 1]!.text.startsWith("11 ")).toBe(true);
    expect(JSON.stringify(chat).length).toBeLessThanOrEqual(DETECTOR_MAX_CHAT_CHARS + 2_000);
  });
});

describe("the anyone draw and the fallback (§4.3)", () => {
  it("weights awake ×3, busy ×1, asleep or over budget ×0, and longer since she spoke is likelier", () => {
    const members = [
      { waifuId: "asleep", availability: "unavailable" as const },
      { waifuId: "busy", availability: "busy" as const, minutesSinceSpoke: 600 },
      { waifuId: "awake", availability: "awake" as const, minutesSinceSpoke: 600 }
    ];
    const counts = new Map<string, number>();
    for (let index = 0; index < 400; index += 1) {
      const chosen = drawAnyone(members, () => (index + 0.5) / 400)!;
      counts.set(chosen, (counts.get(chosen) ?? 0) + 1);
    }
    expect(counts.get("asleep")).toBeUndefined();
    expect(counts.get("awake")! / counts.get("busy")!).toBeCloseTo(3, 0);
    // Recency: equally available, the one silent longer wins most draws.
    const recency = [
      { waifuId: "just-spoke", availability: "awake" as const, minutesSinceSpoke: 0 },
      { waifuId: "quiet", availability: "awake" as const, minutesSinceSpoke: 300 }
    ];
    let quiet = 0;
    for (let index = 0; index < 100; index += 1) if (drawAnyone(recency, () => (index + 0.5) / 100) === "quiet") quiet += 1;
    expect(quiet).toBeGreaterThan(70);
    expect(drawAnyone([{ waifuId: "x", availability: "unavailable" }], () => 0.5)).toBeUndefined();
  });

  it("falls back to anyone only for a question or the first human message in 10 minutes", () => {
    expect(fallbackIsAnyone({ burstText: "anyone know a good recipe?", previousHumanAt: NOW.toISOString(), now: NOW })).toBe(true);
    expect(fallbackIsAnyone({ burstText: "nice", now: NOW })).toBe(true);
    expect(fallbackIsAnyone({ burstText: "nice", previousHumanAt: new Date(NOW.getTime() - 11 * 60_000).toISOString(), now: NOW })).toBe(true);
    expect(fallbackIsAnyone({ burstText: "nice", previousHumanAt: new Date(NOW.getTime() - 9 * 60_000).toISOString(), now: NOW })).toBe(false);
  });
});
