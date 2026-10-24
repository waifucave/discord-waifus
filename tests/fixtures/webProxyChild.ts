// Child process for tests/lifeWebBackend.test.ts: fetches through the app's web adapter with proxy
// environment variables set by the parent, so the parent can check that no request went to the proxy.
// The address policy is "allow" here only because the origin is a loopback test server.
import { createWebBackend } from "../../src/life/web/index.js";

const port = process.argv[2];
const backend = createWebBackend();
const result = await backend.fetchPage(`https://public.test:${port}/direct`, {
  privateAddressPolicy: "allow",
  resolveHost: async () => ["127.0.0.1"],
  timeoutMs: 3_000
});
process.stdout.write(`${JSON.stringify({ ok: result.ok, code: result.ok ? undefined : result.code })}\n`);
await backend.close();
process.exit(0);
