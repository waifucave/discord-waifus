import { randomBytes as cryptoRandomBytes } from "node:crypto";
import {
  RemoteBrowserContextV1Schema,
  type RemoteBrowserContextV1
} from "../../shared/schemas/remoteProtocol.js";
import type { ValidatedRemoteBrowserRequest } from "./security.js";
import type { RemoteBrowserSession } from "./session.js";

export type RemoteBrowserContextOptions = {
  readonly randomBytes?: (size: number) => Uint8Array;
};

export function createRemoteBrowserContext(
  session: RemoteBrowserSession,
  request: ValidatedRemoteBrowserRequest,
  options: RemoteBrowserContextOptions = {}
): RemoteBrowserContextV1 {
  const random = options.randomBytes ?? cryptoRandomBytes;
  const nonce = Buffer.from(random(16));
  if (nonce.byteLength !== 16) {
    throw new TypeError("Remote browser request nonce source must return exactly 16 bytes.");
  }
  return Object.freeze(RemoteBrowserContextV1Schema.parse({
    version: 1,
    gatewayLaunchId: session.gatewayLaunchId,
    browserSessionId: session.browserSessionId,
    requestNonce: nonce.toString("base64url"),
    method: request.method,
    canonicalTarget: request.canonicalTarget,
    csrfValidated: request.csrfValidated
  }));
}
