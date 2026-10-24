// Pure pieces of Phase 5 wave 2: the keyed debouncer (spec 9.2) and the DM rate-limit math and
// notice rule (spec 9.1.1), plus DM eligibility (spec 9.1).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyedDebouncer } from "../src/orchestration/debounce.js";
import { DEFAULT_LIMIT_NOTICE, assessDmLimit, limitNoticeDue, renderLimitNotice } from "../src/orchestration/dm/rateLimit.js";
import { computeDmEligibility } from "../src/orchestration/dm/dmStore.js";
import { WaifuConfigSchema, type WaifuConfig } from "../src/shared/schemas/domain.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { AppConfigSchema, UpdateAppConfigBodySchema } from "../src/shared/schemas/config.js";

describe("KeyedDebouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once per burst with the last callback, re-arming on each call", () => {
    const debouncer = new KeyedDebouncer<string>(() => Date.now());
    const fired: string[] = [];
    debouncer.schedule("a", { quietMs: 100, maxWaitMs: 1000 }, () => fired.push("1"));
    vi.advanceTimersByTime(90);
    debouncer.schedule("a", { quietMs: 100, maxWaitMs: 1000 }, () => fired.push("2"));
    vi.advanceTimersByTime(90);
    expect(fired).toEqual([]);
    expect(debouncer.has("a")).toBe(true);
    vi.advanceTimersByTime(20);
    expect(fired).toEqual(["2"]);
    expect(debouncer.has("a")).toBe(false);
  });

  it("never waits longer than maxWait from the first call", () => {
    const debouncer = new KeyedDebouncer<string>(() => Date.now());
    let fired = 0;
    for (let i = 0; i < 10; i += 1) {
      debouncer.schedule("a", { quietMs: 100, maxWaitMs: 300 }, () => (fired += 1));
      vi.advanceTimersByTime(50);
    }
    // 10 calls 50 ms apart: fired at t=300 (maxWait), then a new burst from the 7th call.
    expect(fired).toBeGreaterThanOrEqual(1);
    vi.advanceTimersByTime(1000);
    expect(fired).toBe(2);
  });

  it("quietMs 0 fires synchronously and returns the result", () => {
    const debouncer = new KeyedDebouncer<string>();
    expect(debouncer.schedule("a", { quietMs: 0, maxWaitMs: 0 }, () => 42)).toBe(42);
    expect(debouncer.has("a")).toBe(false);
  });

  it("cancel, cancelAll and drain never fire", () => {
    const debouncer = new KeyedDebouncer<string>();
    let fired = 0;
    for (const key of ["a", "b", "c"]) debouncer.schedule(key, { quietMs: 10, maxWaitMs: 10 }, () => (fired += 1));
    expect(debouncer.cancel("a")).toBe(true);
    expect(debouncer.cancel("a")).toBe(false);
    expect(debouncer.drain().sort()).toEqual(["b", "c"]);
    debouncer.schedule("d", { quietMs: 10, maxWaitMs: 10 }, () => (fired += 1));
    debouncer.cancelAll();
    vi.advanceTimersByTime(100);
    expect(fired).toBe(0);
    expect(debouncer.size).toBe(0);
  });
});

describe("assessDmLimit", () => {
  const now = new Date("2026-10-24T12:00:00.000Z");
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const limit = { maxReplies: 3, windowMinutes: 60 };

  it("counts replies in (now − window, now] and prunes stale ones", () => {
    const result = assessDmLimit([ago(90), ago(60), ago(30), ago(1)], limit, now);
    expect(result).toEqual({ limited: false, used: 2, pruned: [ago(30), ago(1)] });
  });

  it("is limited at maxReplies and frees when the oldest counted reply leaves the window", () => {
    const result = assessDmLimit([ago(50), ago(20), ago(5)], limit, now);
    expect(result.limited).toBe(true);
    expect(result.used).toBe(3);
    expect(result.freesAt).toBe(new Date(Date.parse(ago(50)) + 60 * 60_000).toISOString());
    // Over the limit (a config edit lowered it): replies must drop below max.
    const over = assessDmLimit([ago(50), ago(40), ago(20), ago(5)], limit, now);
    expect(over.freesAt).toBe(new Date(Date.parse(ago(40)) + 60 * 60_000).toISOString());
  });

  it("config edits apply immediately; null is unlimited", () => {
    const ts = [ago(50), ago(20), ago(5)];
    expect(assessDmLimit(ts, { maxReplies: 10, windowMinutes: 60 }, now).limited).toBe(false);
    expect(assessDmLimit(ts, { maxReplies: 3, windowMinutes: 10 }, now)).toMatchObject({ limited: false, used: 1 });
    expect(assessDmLimit(ts, null, now)).toMatchObject({ limited: false, used: 3 });
  });

  it("ignores malformed and future timestamps", () => {
    expect(assessDmLimit(["nope", new Date(now.getTime() + 60_000).toISOString(), ago(1)], limit, now).used).toBe(1);
  });
});

describe("limit notice", () => {
  const now = new Date("2026-10-24T12:00:00.000Z");
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const limit = { maxReplies: 2, windowMinutes: 60 };

  it("is due once per limited period", () => {
    const a = assessDmLimit([ago(30), ago(10)], limit, now);
    expect(limitNoticeDue(a, undefined)).toBe(true);
    expect(limitNoticeDue(a, ago(5))).toBe(false); // already sent in this period
    expect(limitNoticeDue(a, ago(20))).toBe(true); // sent in an earlier period
    expect(limitNoticeDue(assessDmLimit([ago(10)], limit, now), undefined)).toBe(false);
  });

  it("renders the per-waifu template with its tokens, or the default", () => {
    const freesAt = new Date(now.getTime() + 12.5 * 60_000).toISOString();
    expect(renderLimitNotice("", { name: "Aria", user: "Kevin", freesAt, now })).toBe(DEFAULT_LIMIT_NOTICE.replace("{retryInMinutes}", "13"));
    expect(renderLimitNotice("{name} is busy, {user}. {retryInMinutes}m", { name: "Aria", user: "Kevin", freesAt, now })).toBe("Aria is busy, Kevin. 13m");
  });
});

describe("DM eligibility", () => {
  function waifu(id: string, o: Partial<WaifuConfig> & { allowDms?: boolean } = {}): WaifuConfig {
    const { allowDms, ...rest } = o;
    return WaifuConfigSchema.parse({
      ...createRevisionedBase(),
      id,
      name: id,
      displayName: id,
      enabled: true,
      model: { providerId: "openai", modelId: "gpt-6-luna" },
      botId: `${id}-bot`,
      dm: { allowDms: allowDms ?? true },
      ...rest
    });
  }
  const bots = {
    orchestrator: { id: "director", displayName: "Director", enabled: true },
    waifus: [
      { id: "aria-bot", displayName: "Aria", enabled: true },
      { id: "mina-bot", displayName: "Mina", enabled: true },
      { id: "off-bot", displayName: "Off", enabled: false }
    ]
  };

  it("needs allowDms, a model, an enabled waifu bot and exactly one enabled waifu on it", () => {
    const result = computeDmEligibility(
      [
        waifu("aria"),
        waifu("mina", { allowDms: false }),
        waifu("nomodel", { botId: "nomodel-bot", model: undefined }),
        waifu("off", { botId: "off-bot" }),
        waifu("disabled", { enabled: false, botId: "mina-bot" })
      ],
      { ...bots, waifus: [...bots.waifus, { id: "nomodel-bot", displayName: "N", enabled: true }] }
    );
    expect(result.eligible).toEqual([{ waifuId: "aria", botId: "aria-bot" }]);
    const noModel = computeDmEligibility([{ ...waifu("aria"), model: undefined } as WaifuConfig], bots);
    expect(noModel).toEqual({ eligible: [], warnings: ["dm_missing_model:aria"] });
  });

  it("warns dm_bot_shared when two enabled waifus share the bot", () => {
    const result = computeDmEligibility([waifu("aria"), waifu("mina", { botId: "aria-bot", allowDms: false })], bots);
    expect(result).toEqual({ eligible: [], warnings: ["dm_bot_shared:aria-bot"] });
  });
});

describe("Phase 5 settings", () => {
  it("defaults discord.debounce and discord.dm and accepts partial updates without defaults", () => {
    const config = AppConfigSchema.parse({});
    // Living cast §11.3: the DM quiet timer is 30 s, capped at 180 s (max 300 s).
    expect(config.discord.debounce).toEqual({ serverMs: 1200, serverMaxWaitMs: 4000, dmMs: 30000, dmMaxWaitMs: 180000 });
    expect(config.discord.dm).toEqual({ resumeWindowMinutes: 60 });
    expect(UpdateAppConfigBodySchema.parse({ discord: { debounce: { serverMs: 0 } } })).toEqual({ discord: { debounce: { serverMs: 0 } } });
    expect(() => UpdateAppConfigBodySchema.parse({ discord: { debounce: { dmMaxWaitMs: 300001 } } })).toThrow();
    expect(() => UpdateAppConfigBodySchema.parse({ discord: { debounce: { dmMs: 120001 } } })).toThrow();
    // maxConcurrentRuns moved to life.maxConcurrentTurns.
    expect(() => UpdateAppConfigBodySchema.parse({ discord: { dm: { maxConcurrentRuns: 4 } } })).toThrow();
  });
});
