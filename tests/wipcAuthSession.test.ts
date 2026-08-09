import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WipcProtocolError,
  deriveWipcParentProof
} from "../src/shared/wipc.js";
import {
  WipcHelperAuthSession,
  WipcParentAuthSession
} from "../src/shared/wipcAuthSession.js";
import { createWipcAuthSessionV1Fixture } from "../src/shared/wipcContract.js";
import { serializeCanonicalContractJson } from "../src/shared/schemas/remoteProtocolContract.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const parentCapability = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const clientNonce = Buffer.from(Array.from({ length: 32 }, (_, index) => 0x20 + index));
const helperNonce = Buffer.from(Array.from({ length: 32 }, (_, index) => 0x40 + index));
const replacementHelperNonce = Buffer.from(Array.from({ length: 32 }, (_, index) => 0x60 + index));
const helloBytes = Buffer.from(
  "{\"component\":\"discord_waifus\",\"nonce\":\"client\",\"protocol\":{\"major\":1,\"minor\":0}}",
  "utf8"
);
const helloAckBytes = Buffer.from(
  "{\"component\":\"ts_connect\",\"nonce\":\"helper\",\"protocol\":{\"major\":1,\"minor\":0}}",
  "utf8"
);
const replacementHelloAckBytes = Buffer.from(
  "{\"component\":\"ts_connect\",\"nonce\":\"replacement\",\"protocol\":{\"major\":1,\"minor\":0}}",
  "utf8"
);

function expectProtocolError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(WipcProtocolError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected WIPC protocol error ${code}.`);
}

function parentSession(): WipcParentAuthSession {
  return new WipcParentAuthSession({ parentCapability, clientNonce, helloBytes });
}

function helperSession(): WipcHelperAuthSession {
  return new WipcHelperAuthSession({ parentCapability });
}

describe("WIPC one-launch mutual authentication", () => {
  it("blocks traffic until both proofs succeed, then erases both capability copies", () => {
    const parent = parentSession();
    const helper = helperSession();
    expectProtocolError(() => parent.assertTrafficAllowed(), "frame_before_authentication");
    expectProtocolError(() => helper.assertTrafficAllowed(), "frame_before_authentication");

    const parentProof = parent.beginCandidate({ helperNonce, helloAckBytes });
    const helperProof = helper.authenticateCandidate({
      clientNonce,
      helperNonce,
      helloBytes,
      helloAckBytes,
      parentProof
    });
    parent.completeCandidate(helperProof);

    expect(parent.authenticated).toBe(true);
    expect(helper.authenticated).toBe(true);
    expect(parent.capabilityAvailable).toBe(false);
    expect(helper.capabilityAvailable).toBe(false);
    expect(() => parent.assertTrafficAllowed()).not.toThrow();
    expect(() => helper.assertTrafficAllowed()).not.toThrow();
  });

  it("rejects wrong and reflected helper proofs without consuming the launch capability", () => {
    for (const mode of ["wrong", "reflected"] as const) {
      const parent = parentSession();
      const parentProof = parent.beginCandidate({ helperNonce, helloAckBytes });
      const candidate = mode === "reflected" ? parentProof : Buffer.alloc(32, 0xff);
      expectProtocolError(() => parent.completeCandidate(candidate), "invalid_helper_proof");
      expect(parent.authenticated).toBe(false);
      expect(parent.capabilityAvailable).toBe(true);

      const helper = helperSession();
      const replacementParentProof = parent.beginCandidate({
        helperNonce: replacementHelperNonce,
        helloAckBytes: replacementHelloAckBytes
      });
      const replacementHelperProof = helper.authenticateCandidate({
        clientNonce,
        helperNonce: replacementHelperNonce,
        helloBytes,
        helloAckBytes: replacementHelloAckBytes,
        parentProof: replacementParentProof
      });
      parent.completeCandidate(replacementHelperProof);
      expect(parent.authenticated).toBe(true);
    }
  });

  it("rejects a replayed parent proof on a changed HELLO transcript", () => {
    const oldParentProof = deriveWipcParentProof({
      parentCapability,
      clientNonce,
      helperNonce,
      helloBytes,
      helloAckBytes
    });
    const replayClientNonce = Buffer.from(clientNonce);
    replayClientNonce[0] ^= 1;
    const helper = helperSession();
    expectProtocolError(() => helper.authenticateCandidate({
      clientNonce: replayClientNonce,
      helperNonce,
      helloBytes: Buffer.concat([helloBytes, Buffer.from(" ")]),
      helloAckBytes,
      parentProof: oldParentProof
    }), "invalid_parent_proof");
    expect(helper.authenticated).toBe(false);
    expect(helper.capabilityAvailable).toBe(true);
  });

  it("recovers after a socket-race impersonator and refuses every second client after success", () => {
    const parent = parentSession();
    const fakeHelperNonce = Buffer.alloc(32, 0x7f);
    const fakeHelloAck = Buffer.from(
      "{\"component\":\"ts_connect\",\"nonce\":\"socket-race\",\"protocol\":{\"major\":1,\"minor\":0}}"
    );
    const exposedParentProof = parent.beginCandidate({
      helperNonce: fakeHelperNonce,
      helloAckBytes: fakeHelloAck
    });
    expectProtocolError(
      () => parent.completeCandidate(exposedParentProof),
      "invalid_helper_proof"
    );

    const helper = helperSession();
    const parentProof = parent.beginCandidate({ helperNonce, helloAckBytes });
    const helperProof = helper.authenticateCandidate({
      clientNonce,
      helperNonce,
      helloBytes,
      helloAckBytes,
      parentProof
    });
    parent.completeCandidate(helperProof);

    expectProtocolError(
      () => parent.beginCandidate({ helperNonce, helloAckBytes }),
      "auth_capability_unavailable"
    );
    expectProtocolError(() => helper.authenticateCandidate({
      clientNonce,
      helperNonce,
      helloBytes,
      helloAckBytes,
      parentProof
    }), "auth_capability_unavailable");
  });

  it("fails closed on out-of-order operations and exact-width violations", () => {
    const parent = parentSession();
    expectProtocolError(() => parent.completeCandidate(Buffer.alloc(32)), "auth_sequence_error");
    parent.beginCandidate({ helperNonce, helloAckBytes });
    expectProtocolError(
      () => parent.beginCandidate({ helperNonce, helloAckBytes }),
      "auth_sequence_error"
    );
    expectProtocolError(() => parent.completeCandidate(Buffer.alloc(31)), "invalid_auth_width");
    expect(parent.capabilityAvailable).toBe(true);
  });
});

describe("WIPC V1 public authentication-session fixture", () => {
  it("is canonical and byte-stable", async () => {
    const actual = await readFile(
      path.join(
        repositoryRoot,
        "contracts",
        "remote",
        "v1",
        "fixtures",
        "crypto",
        "wipc-auth-session-v1.json"
      ),
      "utf8"
    );
    expect(actual).toBe(serializeCanonicalContractJson(createWipcAuthSessionV1Fixture()));
  });

  it("drives the TypeScript session accept/reject behavior", async () => {
    const actual = await readFile(
      path.join(
        repositoryRoot,
        "contracts",
        "remote",
        "v1",
        "fixtures",
        "crypto",
        "wipc-auth-session-v1.json"
      ),
      "utf8"
    );
    const fixture = JSON.parse(actual) as {
      parentCapabilityB64: string;
      parent: { clientNonceB64: string; helloBytesB64: string };
      candidates: Record<string, {
        clientNonceB64?: string;
        helloBytesB64?: string;
        helperNonceB64: string;
        helloAckBytesB64: string;
        parentProofB64: string;
        helperProofB64?: string;
        expectedParentError?: string;
        expectedHelperError?: string;
        expectedCapabilityState: "retained" | "erased";
      }>;
      rules: {
        trafficBeforeAuthenticationError: string;
        secondClientError: string;
        recoveryOrder: [string, string];
      };
    };
    const decode = (value: string) => Buffer.from(value, "base64url");
    const capability = decode(fixture.parentCapabilityB64);
    const baseClientNonce = decode(fixture.parent.clientNonceB64);
    const baseHello = decode(fixture.parent.helloBytesB64);
    const candidate = (name: string) => fixture.candidates[name];

    for (const name of ["wrongHelperProof", "reflectedParentProof"] as const) {
      const vector = candidate(name);
      const parent = new WipcParentAuthSession({
        parentCapability: capability,
        clientNonce: baseClientNonce,
        helloBytes: baseHello
      });
      expect(parent.beginCandidate({
        helperNonce: decode(vector.helperNonceB64),
        helloAckBytes: decode(vector.helloAckBytesB64)
      }).toString("base64url")).toBe(vector.parentProofB64);
      expectProtocolError(
        () => parent.completeCandidate(decode(vector.helperProofB64 ?? "")),
        vector.expectedParentError ?? ""
      );
      expect(parent.capabilityAvailable).toBe(vector.expectedCapabilityState === "retained");
    }

    const replay = candidate("replayedParentProof");
    const replayHelper = new WipcHelperAuthSession({ parentCapability: capability });
    expectProtocolError(() => replayHelper.authenticateCandidate({
      clientNonce: decode(replay.clientNonceB64 ?? ""),
      helperNonce: decode(replay.helperNonceB64),
      helloBytes: decode(replay.helloBytesB64 ?? ""),
      helloAckBytes: decode(replay.helloAckBytesB64),
      parentProof: decode(replay.parentProofB64)
    }), replay.expectedHelperError ?? "");
    expect(replayHelper.capabilityAvailable).toBe(true);

    const parent = new WipcParentAuthSession({
      parentCapability: capability,
      clientNonce: baseClientNonce,
      helloBytes: baseHello
    });
    expectProtocolError(
      () => parent.assertTrafficAllowed(),
      fixture.rules.trafficBeforeAuthenticationError
    );
    const [raceName, recoveryName] = fixture.rules.recoveryOrder;
    const race = candidate(raceName);
    parent.beginCandidate({
      helperNonce: decode(race.helperNonceB64),
      helloAckBytes: decode(race.helloAckBytesB64)
    });
    expectProtocolError(
      () => parent.completeCandidate(decode(race.helperProofB64 ?? "")),
      race.expectedParentError ?? ""
    );

    const recovery = candidate(recoveryName);
    const helper = new WipcHelperAuthSession({ parentCapability: capability });
    const recoveryParentProof = parent.beginCandidate({
      helperNonce: decode(recovery.helperNonceB64),
      helloAckBytes: decode(recovery.helloAckBytesB64)
    });
    expect(recoveryParentProof.toString("base64url")).toBe(recovery.parentProofB64);
    const recoveryHelperProof = helper.authenticateCandidate({
      clientNonce: baseClientNonce,
      helperNonce: decode(recovery.helperNonceB64),
      helloBytes: baseHello,
      helloAckBytes: decode(recovery.helloAckBytesB64),
      parentProof: recoveryParentProof
    });
    expect(recoveryHelperProof.toString("base64url")).toBe(recovery.helperProofB64);
    parent.completeCandidate(recoveryHelperProof);
    expect(parent.capabilityAvailable).toBe(false);
    expect(helper.capabilityAvailable).toBe(false);
    expectProtocolError(
      () => parent.beginCandidate({ helperNonce, helloAckBytes }),
      fixture.rules.secondClientError
    );
  });
});
