import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { HelperRemoteRequest, HelperRemoteResponse } from "../helperTypes.js";
import { RemoteBrowserContextV1Schema } from "../../shared/schemas/remoteProtocol.js";

type DirectReadinessOptions = Readonly<{
  gatewayLaunchId: string;
  expiresAt: string;
  registerLaunch: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  isDirect: () => boolean;
  request: (input: HelperRemoteRequest) => Promise<HelperRemoteResponse>;
}>;

/** Dial through the helper before the browser waits for a direct-ready status. */
export function startDirectReadiness(options: DirectReadinessOptions): { close: () => Promise<void> } {
  const controller = new AbortController();
  const browserSessionId = randomBytes(32).toString("base64url");
  const operation = (async () => {
    while (!controller.signal.aborted) {
      // Launch lifetime is fixed; explicit reconnect allocates a new gateway.
      if (BigInt(Math.floor(Date.now() / 1000)) >= BigInt(options.expiresAt)) return;
      try {
        await options.refreshStatus();
      } catch {
        // The supervisor can be restarting; do not use its last cached state.
        await delay(2_000, undefined, { signal: controller.signal, ref: false }).catch(() => undefined);
        continue;
      }
      if (!controller.signal.aborted && !options.isDirect()) {
        let response: HelperRemoteResponse | undefined;
        try {
          // A helper restart restores its runtime, but deliberately forgets launches.
          // Re-register the exact original values without extending their authority.
          await options.registerLaunch();
          if (controller.signal.aborted) return;
          const canonicalTarget = "/api/health";
          response = await options.request({
            method: "GET",
            canonicalTarget,
            headers: [["accept", "application/json"]],
            browserContext: RemoteBrowserContextV1Schema.parse({
              version: 1,
              gatewayLaunchId: options.gatewayLaunchId,
              browserSessionId,
              requestNonce: randomBytes(16).toString("base64url"),
              method: "GET",
              canonicalTarget,
              csrfValidated: true
            }),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)])
          });
          let size = 0;
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 64 * 1024) throw new Error("Remote health response exceeds its limit.");
          }
          // Only the authenticated helper determines direct readiness, never HTTP content.
          await options.refreshStatus();
        } catch (error) {
          response?.cancel(error);
          // Ordinary offline/reconnect failures remain visible in helper status.
        }
      }
      await delay(2_000, undefined, { signal: controller.signal, ref: false }).catch(() => undefined);
    }
  })();
  return { close: async () => { controller.abort(); await operation; } };
}
