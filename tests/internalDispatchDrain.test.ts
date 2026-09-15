import fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  afterInternalResponseDrained,
  dispatchInternal,
  dispatchInternalStreaming,
  getInternalDispatchContext,
  registerInternalDispatchReceiver
} from "../src/api/internalDispatch.js";
import { createRemoteRequestPrincipal } from "../src/api/requestPrincipal.js";

const apps: FastifyInstance[] = [];
const bytes16 = (value: number): string => Buffer.alloc(16, value).toString("base64url");

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("internal response-drain lifecycle", () => {
  it("propagates the outer remote drain through nested authenticated dispatch", async () => {
    const phases: string[] = [];
    const app = fastify({ logger: false });
    apps.push(app);
    registerInternalDispatchReceiver(app);
    app.post("/inner", async () => ({
      registered: afterInternalResponseDrained(() => phases.push("drained"))
    }));
    app.post("/outer", async () => {
      const principal = getInternalDispatchContext()?.principal;
      if (!principal) throw new Error("missing authenticated principal");
      const inner = await dispatchInternal(app, principal, undefined, {
        method: "POST",
        url: "/inner"
      });
      phases.push("inner-complete");
      return inner.json();
    });

    const principal = createRemoteRequestPrincipal({
      kind: "remote_device",
      stableId: "remote:travel-mac",
      deviceId: "travel-mac",
      peerFingerprint: bytes16(0x21),
      transportSessionId: bytes16(0x22),
      trustEpoch: "7"
    });
    const response = await dispatchInternalStreaming(app, principal, undefined, {
      method: "POST",
      url: "/outer"
    });

    expect(response.statusCode).toBe(200);
    expect(phases).toEqual(["inner-complete"]);
    const chunks: Buffer[] = [];
    for await (const chunk of response.stream()) chunks.push(Buffer.from(chunk));
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({ registered: true });
    expect(phases).toEqual(["inner-complete", "drained"]);
  });
});
