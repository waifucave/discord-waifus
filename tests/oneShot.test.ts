import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { ensureDataLayout } from "../src/config/layout.js";
import { ServerConfigSchema, WaifuConfigSchema } from "../src/shared/schemas/domain.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { OneShotTargetSchema } from "../src/shared/schemas/oneShot.js";
import { OneShotCatalog } from "../src/orchestration/oneShot/catalog.js";
import { OneShotDecider, prepareOneShot, type OneShotInput } from "../src/orchestration/oneShot/decider.js";
import { decisionAnswers, decisionRequest, readDecisionJson, type ChoiceQuestions } from "../src/orchestration/oneShot/protocol.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(removeTempRoot)); });
function input(): OneShotInput {
  const waifu = WaifuConfigSchema.parse({ ...createRevisionedBase(), id: "yuki", name: "Yuki", displayName: "Yuki", availability: { sleep: { enabled: false }, busy: [] } });
  return { target: "openai:gpt-6-luna", now: new Date("2026-10-13T12:00:00Z"), waifus: [waifu],
    cast: [{ waifuId: "yuki", names: ["Yuki"], authorIds: ["bot-yuki"], availability: waifu.availability }],
    messages: [{ id: "m1", channelId: "c", authorKind: "user", authorId: "human", name: "Human", displayName: "Human", content: "Yuki, how are you?", timestamp: "2026-10-13T11:59:59Z", reactions: [] }],
    replyRequired: false, directiveBudgetOpen: true, loopSuspected: false, policy: "", signal: new AbortController().signal };
}
function payload(questions: ChoiceQuestions, choices: Record<string, string>, openai = true) {
  const rows = Object.entries(questions).map(([name, q]) => ({ name, type: "choice", choice: choices[name],
    probabilities: openai ? Object.keys(q.criteria).map((value) => ({ value, probability: Number(value === choices[name]) }))
      : Object.fromEntries(Object.keys(q.criteria).map((v) => [v, Number(v === choices[name])])) }));
  return { answers: openai ? rows : Object.fromEntries(rows.map((r) => [r.name, r])) };
}
async function root() {
  const r = await makeTempRoot(); roots.push(r); await ensureDataLayout(r);
  await writeFile(`${r}/user/providers.json`, JSON.stringify({ providers: { openai: { apiKey: "fixture-openai" }, openrouter: { apiKey: "fixture-router" } } }), { mode: 0o600 });
  return r;
}
async function decider(choices: Record<string, string>) {
  const sample = input(); const prepared = prepareOneShot(sample);
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(payload(prepared.questions, choices))));
  return { client: new OneShotDecider(await root(), fetchImpl as typeof fetch), sample, fetchImpl };
}

describe("One shot native-choice orchestration", () => {
  it("leaves existing server mode untouched and supplies missing config defaults", () => {
    const server = ServerConfigSchema.parse({ ...createRevisionedBase(), guildId: "g" });
    expect(server.orchestratorMode).toBe("model");
    expect(server.oneShot.target).toBe("openrouter:cloudflare/clef");
  });
  it("rejects predicate-only models and arbitrary endpoints or executables", () => {
    for (const t of ["openrouter:respan/span-01", "openrouter:respan/span-01-lite:free", "https://evil.test", "laya:/tmp/executable", "openai:unknown"])
      expect(OneShotTargetSchema.safeParse(t).success).toBe(false);
  });
  it("uses native OpenAI choice arrays and router choice maps", () => {
    const p = prepareOneShot(input());
    expect(decisionRequest("m", p.state, p.questions, true)).toHaveProperty("input", p.state);
    expect(decisionRequest("m", p.state, p.questions, false)).toHaveProperty("questions.turn.type", "choice");
    for (const openai of [false, true]) expect(decisionAnswers(payload(p.questions, { turn: "speaker_0", loop: "healthy", steering: "none" }, openai), p.questions, openai).turn.choice).toBe("speaker_0");
  });
  it("rejects invalid choices, malformed probabilities, refusals and missing answers", () => {
    const p = prepareOneShot(input());
    for (const mutation of [
      (r: any) => { r.answers[0].choice = "other"; },
      (r: any) => { r.answers[0].probabilities[0].probability = 0.7; },
      (r: any) => { r.answers[0].type = "refusal"; },
      (r: any) => { r.answers.pop(); },
      (r: any) => { r.answers.push(r.answers[0]); }
    ]) {
      const result = payload(p.questions, { turn: "speaker_0", loop: "healthy", steering: "none" });
      mutation(result); expect(() => decisionAnswers(result, p.questions, true)).toThrow();
    }
  });
  it("uses one inference request, existing credentials and no chat/tools fallback", async () => {
    const { client, sample, fetchImpl } = await decider({ turn: "speaker_0", loop: "healthy", steering: "none" });
    const result = await client.decide(sample);
    expect(result.decision).toMatchObject({ action: "reply", respondingWaifus: [{ waifuId: "yuki" }] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.openai.com/v1/decisions");
    client.close();
  });
  it("cannot contradict speaker selection with pause or emit steering while waiting", async () => {
    const { client, sample } = await decider({ turn: "wait_short", loop: "stalled_scene", steering: "break_loop" });
    const { decision } = await client.decide({ ...sample, timerWakeSeconds: 600 });
    expect(decision).toMatchObject({ action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 1200 });
    expect(decision.wakePlan).toBeUndefined(); client.close();
  });
  it("enforces an explicit required reply without a second inference call", async () => {
    const { client, sample, fetchImpl } = await decider({ turn: "wait_dead", loop: "healthy", steering: "none" });
    const result = await client.decide({ ...sample, replyRequired: true });
    expect(result.decision.action).toBe("reply"); expect(fetchImpl).toHaveBeenCalledTimes(1); client.close();
  });
  it("blocks ordinary directives over budget but allows a semantic loop break", async () => {
    const a = await decider({ turn: "speaker_0", loop: "healthy", steering: "change_topic" });
    expect((await a.client.decide({ ...a.sample, directiveBudgetOpen: false })).decision.respondingWaifus[0].directive).toBeUndefined(); a.client.close();
    const b = await decider({ turn: "speaker_0", loop: "stalled_scene", steering: "none" });
    const result = await b.client.decide({ ...b.sample, directiveBudgetOpen: false });
    expect(result.loopDetected).toBe(true);
    expect(result.decision.respondingWaifus[0].directive?.intent).toBe("break_loop");
    expect(result.decision.respondingWaifus[0].directive!.goal.length).toBeLessThanOrEqual(100); b.client.close();
  });
  it("does not force a loop break for a lexical false alarm when semantic diagnosis is healthy", async () => {
    const s = await decider({ turn: "speaker_0", loop: "healthy", steering: "none" });
    const result = await s.client.decide({ ...s.sample, loopSuspected: true });
    expect(result.loopDetected).toBe(false); expect(result.decision.respondingWaifus[0].directive).toBeUndefined(); s.client.close();
  });
  it("keeps timestamps, caps choices linearly and retains the directly addressed candidate", () => {
    const s = input(); s.cast = Array.from({ length: 30 }, (_, i) => ({ ...s.cast[0], waifuId: `w${i}`, names: [`Waifu${i}`], authorIds: [`bot-${i}`] }));
    s.messages[0].content = "Waifu29, how are you?";
    const p = prepareOneShot(s);
    expect(Object.keys(p.questions.turn.criteria)).toHaveLength(20);
    expect(p.candidates[0].waifuId).toBe("w29");
    expect(p.state).toContain('"ageSeconds":1');
    expect(prepareOneShot({ ...s, target: "laya:multilingual" }).candidates).toHaveLength(7);
  });
  it("does not call inference without credentials, after cancellation or with no available cast", async () => {
    const r = await root(); await writeFile(`${r}/user/providers.json`, "{}");
    const fetchImpl = vi.fn(); const client = new OneShotDecider(r, fetchImpl);
    await expect(client.decide(input())).rejects.toThrow("credential_missing");
    await expect(client.decide({ ...input(), signal: AbortSignal.abort() })).rejects.toThrow();
    expect((await client.decide({ ...input(), cast: [] })).decision.action).toBe("no_reply");
    await expect(client.decide({ ...input(), cast: [], replyRequired: true })).rejects.toThrow("no_available_speaker");
    expect(fetchImpl).not.toHaveBeenCalled(); client.close();
  });
  it("does not expose HTTP errors or retry a failed inference", async () => {
    const fetchImpl = vi.fn(async () => new Response("private provider response", { status: 400 }));
    const client = new OneShotDecider(await root(), fetchImpl);
    await expect(client.decide(input())).rejects.toThrow(/^one_shot_http_400$/);
    expect(fetchImpl).toHaveBeenCalledTimes(1); client.close();
  });
  it("discovers choice candidates without exposing chat-only or known predicate-only models, caching concurrent reads", async () => {
    const model = (id: string, output: string[]) => ({ id, context_length: id.startsWith("respan/") ? 0 : 32768, architecture: { input_modalities: ["text"], output_modalities: output } });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [model("typesafe/jev-1.13", ["decisions"]), model("respan/span-01", ["decisions"]), model("chat/model", ["text"])] })));
    const catalog = new OneShotCatalog(fetchImpl);
    const [a, b] = await Promise.all([catalog.list(), catalog.list()]);
    expect(a).toEqual(b); expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a.models.filter((m) => m.provider === "openrouter").map((m) => m.target)).toEqual(["openrouter:typesafe/jev-1.13"]);
  });
  it("preserves built-in entries and reports catalog failures explicitly", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("private network detail"); });
    const catalog = new OneShotCatalog(fetchImpl);
    const result = await catalog.list(); expect(result.unavailable).toBe(true); expect(result.models).toHaveLength(4);
    await catalog.list(); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("bounds provider responses and never forwards parse errors or response contents", async () => {
    await expect(readDecisionJson(new Response('"' + "x".repeat(100) + '"'), 50)).rejects.toThrow(/^one_shot_invalid_response$/);
    await expect(readDecisionJson(new Response("private invalid content"))).rejects.toThrow(/^one_shot_invalid_response$/);
  });
  it("preserves available OCR text without exposing image URLs to the decider", () => {
    const s = input(); s.messages[0].images = [{ url: "https://private-image.example/file", ocrText: "Museum opens at nine" }];
    const p = prepareOneShot(s);
    expect(p.state).toContain("Museum opens at nine"); expect(p.state).not.toContain("private-image.example");
  });
});
