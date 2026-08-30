import { randomBytes } from "node:crypto";
import {
  WipcHelperAuthSession,
  WipcParentAuthSession
} from "../../src/shared/wipcAuthSession.js";

function authenticateParent() {
  const parentCapability = randomBytes(32);
  const clientNonce = randomBytes(32);
  const helperNonce = randomBytes(32);
  const helloBytes = Buffer.from(
    "{\"component\":\"discord_waifus\",\"protocol\":{\"major\":1,\"minor\":0}}",
    "utf8"
  );
  const helloAckBytes = Buffer.from(
    "{\"component\":\"ts_connect\",\"protocol\":{\"major\":1,\"minor\":0}}",
    "utf8"
  );
  const parent = new WipcParentAuthSession({ parentCapability, clientNonce, helloBytes });
  const helper = new WipcHelperAuthSession({ parentCapability });
  const parentProof = parent.beginCandidate({ helperNonce, helloAckBytes });
  const helperProof = helper.authenticateCandidate({
    clientNonce,
    helperNonce,
    helloBytes,
    helloAckBytes,
    parentProof
  });
  parent.completeCandidate(helperProof);
  return parent;
}

export class FakeTsConnect {
  #connection;
  #nextStreamId = 2n;

  constructor(bridge, connectionId = "fake-helper") {
    this.#connection = bridge.openAuthenticatedConnection(connectionId, authenticateParent());
  }

  request(requestStart, options = {}) {
    const streamId = options.streamId ?? this.#nextStreamId;
    if (options.streamId === undefined) this.#nextStreamId += 2n;
    return this.#connection.dispatch({
      streamId,
      requestStart,
      ...(options.body ? { body: options.body } : {}),
      ...(options.signal ? { signal: options.signal } : {})
    });
  }

  close(reason) {
    this.#connection.close(reason);
  }
}
