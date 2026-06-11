import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderCredentialsLookup } from "../src/api/llmGatewayCredentials.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

async function makeRoot(): Promise<string> {
  const root = await makeTempRoot();
  roots.push(root);
  return root;
}

async function writeProvidersFile(root: string, contents: string): Promise<void> {
  await mkdir(path.join(root, "user"), { recursive: true });
  await writeFile(path.join(root, "user", "providers.json"), contents, "utf8");
}

describe("createProviderCredentialsLookup", () => {
  it("returns undefined when the providers file does not exist yet", async () => {
    const lookup = createProviderCredentialsLookup(await makeRoot());
    expect(lookup("deepseek")).toBeUndefined();
  });

  it("returns the stored key and undefined for providers without one", async () => {
    const root = await makeRoot();
    const lookup = createProviderCredentialsLookup(root);
    await writeProvidersFile(
      root,
      JSON.stringify({
        schemaVersion: 1,
        revision: 3,
        updatedAt: "2026-06-11T00:00:00.000Z",
        providers: {
          deepseek: {
            providerId: "deepseek",
            apiKey: "sk-deep",
            createdAt: "2026-06-11T00:00:00.000Z",
            updatedAt: "2026-06-11T00:00:00.000Z"
          }
        }
      })
    );
    expect(lookup("deepseek")).toBe("sk-deep");
    expect(lookup("openrouter")).toBeUndefined();
  });

  it("re-reads the file on every call so key updates apply without a restart", async () => {
    const root = await makeRoot();
    const lookup = createProviderCredentialsLookup(root);
    expect(lookup("deepseek")).toBeUndefined();
    await writeProvidersFile(root, JSON.stringify({ providers: { deepseek: { apiKey: "sk-1" } } }));
    expect(lookup("deepseek")).toBe("sk-1");
    await writeProvidersFile(root, JSON.stringify({ providers: { deepseek: { apiKey: "sk-2" } } }));
    expect(lookup("deepseek")).toBe("sk-2");
  });

  it("never throws: corrupt JSON, wrong shapes, and empty keys all yield undefined", async () => {
    const root = await makeRoot();
    const lookup = createProviderCredentialsLookup(root);
    await writeProvidersFile(root, "{not json");
    expect(lookup("deepseek")).toBeUndefined();
    await writeProvidersFile(root, JSON.stringify([1, 2]));
    expect(lookup("deepseek")).toBeUndefined();
    await writeProvidersFile(root, JSON.stringify({ providers: { deepseek: { apiKey: "" } } }));
    expect(lookup("deepseek")).toBeUndefined();
    await writeProvidersFile(root, JSON.stringify({ providers: { deepseek: "nope" } }));
    expect(lookup("deepseek")).toBeUndefined();
  });

  it("does not resolve prototype-chain properties as credentials", async () => {
    const root = await makeRoot();
    const lookup = createProviderCredentialsLookup(root);
    await writeProvidersFile(root, JSON.stringify({ providers: { deepseek: { apiKey: "sk-deep" } } }));
    expect(lookup("__proto__")).toBeUndefined();
    expect(lookup("constructor")).toBeUndefined();
    expect(lookup("toString")).toBeUndefined();
  });
});
