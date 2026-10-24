import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderError } from "@yanlinglabs/winter-provider-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderCredentialsLookup, inlineAuthRef } from "../src/models/credentials.js";
import { fromProviderError, isContextOverflowError, ModelCallError, modelErrorKind, toModelCallError } from "../src/models/errors.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

describe("provider credentials (inline keys from user/providers.json)", () => {
  it("reads keys live on every lookup, so a saved key applies without a restart", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const lookup = createProviderCredentialsLookup(root);
    expect(lookup("deepseek")).toBeUndefined();
    await mkdir(path.join(root, "user"), { recursive: true });
    const file = path.join(root, "user", "providers.json");
    await writeFile(file, JSON.stringify({ providers: { deepseek: { apiKey: "sk-one" }, empty: { apiKey: "" }, broken: "x" } }));
    expect(lookup("deepseek")).toBe("sk-one");
    expect(lookup("empty")).toBeUndefined();
    expect(lookup("broken")).toBeUndefined();
    expect(lookup("anthropic")).toBeUndefined();
    await writeFile(file, JSON.stringify({ providers: { deepseek: { apiKey: "sk-two" } } }));
    expect(lookup("deepseek")).toBe("sk-two");
  });

  it("degrades to no key on a malformed file instead of throwing on the call path", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await mkdir(path.join(root, "user"), { recursive: true });
    await writeFile(path.join(root, "user", "providers.json"), "{not json");
    expect(createProviderCredentialsLookup(root)("deepseek")).toBeUndefined();
    await writeFile(path.join(root, "user", "providers.json"), "null");
    expect(createProviderCredentialsLookup(root)("deepseek")).toBeUndefined();
  });

  it("passes the key to winter as an inline auth reference", () => {
    expect(inlineAuthRef("sk-x")).toEqual({ kind: "inline", value: "sk-x" });
  });
});

const error = (over: Partial<ProviderError>): ProviderError => ({ code: "server", message: "boom", retryable: false, ...over });

describe("winter error → app error kind (spec §9.1)", () => {
  it.each<[string, ProviderError, { subscriptionQuota?: boolean } | undefined, string]>([
    ["context overflow verdict", error({ code: "bad_request", contextOverflow: true }), undefined, "context_overflow"],
    ["caller abort", error({ code: "aborted" }), undefined, "aborted"],
    ["insufficient_quota on a 429", error({ code: "rate_limit", status: 429, providerCode: "insufficient_quota" }), undefined, "quota"],
    ["usage window code", error({ code: "rate_limit", status: 429, providerCode: "usage_limit_reached" }), undefined, "quota"],
    ["429 after a subscription-quota event", error({ code: "rate_limit", status: 429 }), { subscriptionQuota: true }, "quota"],
    ["billing provider code", error({ code: "bad_request", status: 400, providerCode: "billing_error" }), undefined, "billing"],
    ["HTTP 402", error({ code: "bad_request", status: 402 }), undefined, "billing"],
    // Anthropic's "credit balance is too low" is an HTTP 400 invalid_request_error (review I7).
    [
      "Anthropic credit balance too low (400)",
      error({ code: "bad_request", status: 400, providerCode: "invalid_request_error", message: "HTTP 400 — Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." }),
      undefined,
      "billing"
    ],
    [
      "credit balance too low in a stream error frame",
      error({ code: "bad_request", providerCode: "invalid_request_error", message: "the provider ended the stream with an error frame (invalid_request_error): Your credit balance is too low" }),
      undefined,
      "billing"
    ],
    ["insufficient credits phrase", error({ code: "bad_request", status: 400, message: "HTTP 400 — Insufficient credits for this request" }), undefined, "billing"],
    ["insufficient balance phrase (DeepSeek)", error({ code: "bad_request", status: 400, message: "HTTP 400 — Insufficient Balance" }), undefined, "billing"],
    ["insufficient funds phrase", error({ code: "server", status: 500, message: "HTTP 500 — insufficient funds" }), undefined, "billing"],
    ["requires more credits phrase (OpenRouter)", error({ code: "bad_request", status: 400, message: "HTTP 400 — This request requires more credits, or fewer max_tokens." }), undefined, "billing"],
    ["billing_hard_limit_reached code", error({ code: "bad_request", status: 400, providerCode: "billing_hard_limit_reached" }), undefined, "billing"],
    ["billing_not_active code", error({ code: "bad_request", status: 400, providerCode: "billing_not_active" }), undefined, "billing"],
    ["credit_balance_too_low code", error({ code: "bad_request", status: 400, providerCode: "credit_balance_too_low" }), undefined, "billing"],
    ["insufficient_credits code on a 429", error({ code: "rate_limit", status: 429, providerCode: "insufficient_credits" }), undefined, "billing"],
    ["a billing phrase on an auth failure stays auth", error({ code: "auth", status: 401, message: "HTTP 401 — credit balance is too low" }), undefined, "auth"],
    ["quota code on a 429 (gateway rule)", error({ code: "rate_limit", status: 429, providerCode: "monthly_quota_exceeded" }), undefined, "quota"],
    ["usage_limit_* code on a 429", error({ code: "rate_limit", status: 429, providerCode: "usage_limit_hit" }), undefined, "quota"],
    ["a quota-looking code on a 400 is not a quota", error({ code: "bad_request", status: 400, providerCode: "quota_project_missing" }), undefined, "other"],
    ["plain 429", error({ code: "rate_limit", status: 429 }), undefined, "rate_limit"],
    ["bad key", error({ code: "auth", status: 401 }), undefined, "auth"],
    ["server", error({ code: "server", status: 503 }), undefined, "other"],
    ["stall", error({ code: "stall" }), undefined, "other"],
    ["capability refusal", error({ code: "capability" }), undefined, "other"]
  ])("%s", (_label, providerError, options, kind) => {
    expect(modelErrorKind(providerError, options)).toBe(kind);
  });

  it("keeps winter's code, status and provider code, and bounds the message", () => {
    const mapped = fromProviderError(error({ code: "rate_limit", status: 429, providerCode: "rate_limit_exceeded", retryable: true, retryAfterMs: 1500, message: "x".repeat(1000) }));
    expect(mapped).toBeInstanceOf(ModelCallError);
    expect(mapped).toMatchObject({ kind: "rate_limit", code: "rate_limit", status: 429, providerCode: "rate_limit_exceeded", retryable: true, retryAfterMs: 1500 });
    expect(mapped.message.length).toBeLessThanOrEqual(403);
  });

  it("is never retryable once the stream committed, and never for quota or billing", () => {
    const retryable = error({ code: "server", status: 503, retryable: true });
    expect(fromProviderError(retryable)).toMatchObject({ retryable: true, committed: false });
    expect(fromProviderError(retryable, { committed: true })).toMatchObject({ retryable: false, committed: true });
    expect(fromProviderError(error({ code: "rate_limit", status: 429, providerCode: "insufficient_quota", retryable: true }))).toMatchObject({ kind: "quota", retryable: false });
    expect(new ModelCallError("other", "timed out", { retryable: true, committed: true }).retryable).toBe(false);
  });

  it("carries winter's image refusal", () => {
    const refused = fromProviderError(error({ code: "bad_request", status: 400, imageOverflow: true, message: "HTTP 400 — too many images" }));
    expect(refused).toMatchObject({ kind: "other", imageOverflow: true });
    expect(fromProviderError(error({ code: "bad_request", status: 400 })).imageOverflow).toBe(false);
  });

  it("normalizes anything thrown, and passes ModelCallErrors through", () => {
    const existing = new ModelCallError("auth", "no key", { code: "missing_credentials" });
    expect(toModelCallError(existing)).toBe(existing);
    expect(toModelCallError(new Error("ECONNRESET"))).toBeInstanceOf(ModelCallError);
  });

  it("recognizes a context overflow, also as a cause", () => {
    const overflow = new ModelCallError("context_overflow", "too long");
    expect(isContextOverflowError(overflow)).toBe(true);
    expect(isContextOverflowError(new Error("wrapped", { cause: overflow }))).toBe(true);
    expect(isContextOverflowError(new ModelCallError("other", "nope"))).toBe(false);
  });
});
