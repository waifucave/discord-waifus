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
    ["winter's billing code (0.0.57)", error({ code: "billing", status: 400, providerCode: "billing_error" }), undefined, "billing"],
    ["HTTP 402", error({ code: "bad_request", status: 402 }), undefined, "billing"],
    ["OpenRouter's in-flight budget 402 with Retry-After stays a rate limit", error({ code: "rate_limit", status: 402, retryable: true }), undefined, "rate_limit"],
    ["insufficient credits phrase", error({ code: "bad_request", status: 400, message: "HTTP 400 — Insufficient credits for this request" }), undefined, "billing"],
    ["insufficient balance phrase (DeepSeek)", error({ code: "bad_request", status: 400, message: "HTTP 400 — Insufficient Balance" }), undefined, "billing"],
    ["insufficient funds phrase", error({ code: "server", status: 500, message: "HTTP 500 — insufficient funds" }), undefined, "billing"],
    ["requires more credits phrase (OpenRouter)", error({ code: "bad_request", status: 400, message: "HTTP 400 — This request requires more credits, or fewer max_tokens." }), undefined, "billing"],
    ["insufficient_credits code on a 429", error({ code: "rate_limit", status: 429, providerCode: "insufficient_credits" }), undefined, "billing"],
    ["a billing phrase on an auth failure stays auth", error({ code: "auth", status: 401, message: "HTTP 401 — insufficient credits" }), undefined, "auth"],
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

  // winter 0.0.57 classifies the account-cannot-pay answers itself (`code: "billing"`); these run real
  // provider bodies through winter's own normalizer, then the app mapping.
  it.each<[string, number, unknown, string]>([
    ["Anthropic credit balance too low (400)", 400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } }, "billing"],
    ["Anthropic billing_error", 400, { type: "error", error: { type: "billing_error", message: "billing" } }, "billing"],
    ["DeepSeek 402 Insufficient Balance", 402, { error: { message: "Insufficient Balance", type: "unknown_error" } }, "billing"],
    ["OpenAI insufficient_quota stays the app's quota", 429, { error: { code: "insufficient_quota", message: "You exceeded your current quota", type: "insufficient_quota" } }, "quota"],
    ["OpenAI billing_hard_limit_reached", 429, { error: { code: "billing_hard_limit_reached", message: "Billing hard limit has been reached" } }, "billing"],
    ["OpenAI billing_not_active", 400, { error: { code: "billing_not_active", message: "billing not active" } }, "billing"],
    // Not covered by winter: the app fallback keeps these.
    ["insufficient_credits code on a 400 (fallback)", 400, { error: { code: "insufficient_credits", message: "x" } }, "billing"],
    ["insufficient balance phrase on a 400 (fallback)", 400, { error: { message: "Insufficient Balance" } }, "billing"],
    ["requires more credits phrase on a 400 (fallback)", 400, { error: { message: "This request requires more credits, or fewer max_tokens." } }, "billing"],
    ["a plain bad request stays other", 400, { error: { message: "messages: field required" } }, "other"]
  ])("%s, through winter's normalizer", async (_name, status, body, kind) => {
    const { normalizeHttpError } = await import("@yanlinglabs/winter-provider-runtime");
    expect(modelErrorKind(normalizeHttpError(status, new Headers(), JSON.stringify(body)))).toBe(kind);
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
