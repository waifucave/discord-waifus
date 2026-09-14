import { describe, expect, it } from "vitest";
import { ROUTE_POLICY_MANIFEST } from "../src/api/routePolicyManifest.js";
import {
  LogicalMutationOutcomeUnknownError,
  LogicalMutationRegistry,
  LogicalMutationTransportError
} from "../src/frontend/api/logicalMutation.js";
import { classifyMutationRetry } from "../src/frontend/api/retryPolicy.js";

function concretePath(template: string): string {
  return template
    .replace(/:([A-Za-z][A-Za-z0-9]*)/gu, "sample")
    .replace(/\*$/u, "asset.js");
}

describe("frontend mutation retry policy", () => {
  it.each([
    ["PUT", "/api/config", "reconciled"],
    ["PUT", "/api/waifus/akari", "transactional"],
    ["POST", "/api/waifus/akari/digest", "non_replayable"],
    ["POST", "/api/runtime/reload", "reconciled"],
    ["POST", "/api/runtime/trigger/orchestrator", "non_replayable"],
    ["POST", "/api/llm/v1/validate", "safe"],
    ["POST", "/api/llm/v1/chat", "non_replayable"]
  ] as const)("classifies %s %s as %s", (method, target, retryClass) => {
    expect(classifyMutationRetry(method, target)).toBe(retryClass);
  });

  it("covers every reviewed route-manifest mutation and rejects unknown routes", () => {
    for (const definition of ROUTE_POLICY_MANIFEST) {
      if (definition.synthetic || definition.method === "GET") continue;
      if (definition.method === "*") {
        for (const semantic of definition.gatewaySemanticRoutes ?? []) {
          if (semantic.method === "GET") continue;
          expect(
            classifyMutationRetry(semantic.method, concretePath(semantic.path)),
            `${semantic.method} ${semantic.path}`
          ).toBe(semantic.retryClass);
        }
        continue;
      }
      expect(
        classifyMutationRetry(definition.method, concretePath(definition.path)),
        `${definition.method} ${definition.path}`
      ).toBe(definition.retryClass);
    }
    expect(() => classifyMutationRetry("POST", "/api/unreviewed"))
      .toThrow("reviewed retry policy");
  });
});

describe("logical frontend mutations", () => {
  it("creates a canonical action identity and gives each user action a fresh key", async () => {
    let seed = 0x11;
    const registry = new LogicalMutationRegistry({
      randomBytes: (size) => new Uint8Array(size).fill(seed++)
    });

    const first = await registry.begin({
      method: "PUT",
      target: "/api/config?z=last&a=first",
      body: { runtime: { paused: false }, schemaVersion: 2 }
    });
    const sameBody = await registry.begin({
      method: "PUT",
      target: "/api/config?a=first&z=last",
      body: { schemaVersion: 2, runtime: { paused: false } }
    });

    expect(first.snapshot()).toMatchObject({
      idempotencyKey: Buffer.alloc(32, 0x11).toString("base64url"),
      method: "PUT",
      canonicalTarget: "/api/config?a=first&z=last",
      retryClass: "reconciled",
      state: "pending",
      statusUrl: null
    });
    expect(first.snapshot().bodyHash).toBe(sameBody.snapshot().bodyHash);
    expect(sameBody.snapshot().idempotencyKey)
      .toBe(Buffer.alloc(32, 0x12).toString("base64url"));
  });

  it("retries a reconciled action once with the same key and retains its operation URL", async () => {
    const registry = new LogicalMutationRegistry({
      randomBytes: (size) => new Uint8Array(size).fill(0x21)
    });
    const action = await registry.begin({
      method: "POST",
      target: "/api/runtime/reload",
      body: undefined
    });
    const keys: string[] = [];
    const statusUrl = `/api/admin/operations/${Buffer.alloc(32, 0x31).toString("base64url")}`;

    const value = await action.execute(async ({ idempotencyKey, attempt }) => {
      keys.push(idempotencyKey);
      if (attempt === 1) throw new LogicalMutationTransportError("path changed");
      return {
        value: { accepted: true },
        statusUrl
      };
    });

    expect(value).toEqual({ accepted: true });
    expect(keys).toEqual([
      Buffer.alloc(32, 0x21).toString("base64url"),
      Buffer.alloc(32, 0x21).toString("base64url")
    ]);
    expect(action.snapshot()).toMatchObject({ state: "accepted", statusUrl });
    expect(registry.get(action.snapshot().idempotencyKey)).toBe(action);
  });

  it("never replays a non-replayable action after a transport break", async () => {
    const registry = new LogicalMutationRegistry({
      randomBytes: (size) => new Uint8Array(size).fill(0x41)
    });
    const action = await registry.begin({
      method: "POST",
      target: "/api/runtime/trigger/orchestrator",
      body: { guildId: "1", channelId: "2" }
    });
    let attempts = 0;

    await expect(action.execute(async () => {
      attempts += 1;
      throw new LogicalMutationTransportError("connection moved");
    })).rejects.toBeInstanceOf(LogicalMutationOutcomeUnknownError);

    expect(attempts).toBe(1);
    expect(action.snapshot()).toMatchObject({
      retryClass: "non_replayable",
      state: "outcome_unknown",
      statusUrl: null
    });
    expect(registry.get(action.snapshot().idempotencyKey)).toBe(action);
  });
});
