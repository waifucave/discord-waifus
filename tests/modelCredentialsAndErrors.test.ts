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
