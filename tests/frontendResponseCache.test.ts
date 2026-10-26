import { describe, expect, it } from "vitest";
import { cachedValue, noteGet, noteMutation, startCaptured, storeValue } from "../src/frontend/api/responseCache";

const fetcherFor = (path: string, value: unknown) => () => {
  noteGet(path);
  return Promise.resolve(value);
};

describe("dashboard response cache", () => {
  it("shows a screen's last data when it opens again, keyed by path and fetcher", async () => {
    noteMutation();
    const fetcher = fetcherFor("/api/waifus", { waifus: ["aria"] });
    const first = startCaptured(fetcher);
    expect(cachedValue(first.key)).toBeUndefined();
    storeValue(first.key, first.generation, await first.promise);

    const again = startCaptured(fetcher);
    expect(cachedValue(again.key)).toEqual({ waifus: ["aria"] });
    // Another path, or another fetcher reshaping the same path, is a different entry.
    expect(cachedValue(startCaptured(fetcherFor("/api/servers", {})).key)).toBeUndefined();
    expect(cachedValue(startCaptured(() => fetcherFor("/api/waifus", [])().then(() => 1)).key)).toBeUndefined();
  });

  it("forgets everything after a change, including answers that started before it", async () => {
    noteMutation();
    const fetcher = fetcherFor("/api/config", { a: 1 });
    const before = startCaptured(fetcher);
    noteMutation();
    storeValue(before.key, before.generation, await before.promise);
    expect(cachedValue(startCaptured(fetcher).key)).toBeUndefined();
  });

  it("caches nothing for a fetcher that makes no request", () => {
    const started = startCaptured(() => Promise.resolve(undefined));
    expect(started.key).toBeUndefined();
  });
});
