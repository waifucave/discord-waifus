// Test safety net: the suite never reaches the internet. Any `fetch` to a host other than the
// loopback interface fails at once, so a life that wakes inside a test (a runtime built over a real
// model client, the Exa client, the detector) can never make a live model, search or Discord call.
// Tests that need HTTP use loopback servers or inject their own fetch.
//
// The one exception is the owner-approved live evaluation (tests/eval/lifeLive.eval.test.ts), which
// only runs with WAIFUS_EVAL_LIVE=1; the net is not installed then.

const realFetch = globalThis.fetch.bind(globalThis);

function loopback(input: RequestInfo | URL): boolean {
  try {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

if (process.env.WAIFUS_EVAL_LIVE !== "1") {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!loopback(input)) throw new TypeError("Network access is disabled in tests (loopback only).");
    return realFetch(input, init);
  }) as typeof fetch;
}
