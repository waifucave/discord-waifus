import {
  ApplicationSessionAuthenticationV1,
  applicationSessionFixturePublicKeys,
  createApplicationSessionProofsV1,
  deriveApprovalContextHashV1,
  deriveRemoteBrowserContextKeyV1,
  deriveRemoteBrowserContextMacV1,
  encodeRemoteBrowserContextMacInputV1,
  serializeRemoteBrowserContextV1,
  type ApplicationSessionAuthEventV1,
  type ApplicationSessionContextV1,
  type ApplicationSessionRoleV1
} from "./remoteServiceCrypto.js";
import {
  RemoteBrowserContextEnvelopeV1Schema,
  type RemoteBrowserContextEnvelopeV1
} from "./schemas/remoteProtocol.js";
import { createRemoteAccessFixtureSet } from "./schemas/remoteAccessContract.js";
import {
  serializeCanonicalContractJson,
  type ContractJson
} from "./schemas/remoteProtocolContract.js";

type ContractObject = { [key: string]: ContractJson };

const ACCEPTED_AT = 1_786_270_830n;
const GATEWAY_EXPIRES_AT = ACCEPTED_AT + 600n;

function sequence(start: number, length: number): Buffer {
  if (start < 0 || start + length > 256) {
    throw new RangeError("Fixture byte sequence exceeds one byte.");
  }
  return Buffer.from(Array.from({ length }, (_, index) => start + index));
}

function b64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mutate(value: Uint8Array, index = 0): Buffer {
  const result = Buffer.from(value);
  result[index] ^= 1;
  return result;
}

function sessionInputFixture(value: ApplicationSessionContextV1): ContractObject {
  return {
    negotiatedMinor: value.negotiatedMinor,
    pairIdB64: b64(value.pairId),
    serviceIdB64: b64(value.serviceId),
    hostNonceB64: b64(value.hostNonce),
    remoteNonceB64: b64(value.remoteNonce),
    hostInstallationBundleHashB64: b64(value.hostInstallationBundleHash),
    remoteInstallationBundleHashB64: b64(value.remoteInstallationBundleHash),
    hostTrustEpoch: value.hostTrustEpoch.toString(10),
    remoteTrustEpoch: value.remoteTrustEpoch.toString(10),
    hostTransportSessionIdB64: b64(value.hostTransportSessionId),
    remoteTransportSessionIdB64: b64(value.remoteTransportSessionId)
  };
}

function applicationSessionRejections(
  value: ApplicationSessionContextV1
): ContractJson[] {
  const variants: Array<readonly [string, ApplicationSessionContextV1]> = [
    ["wrong-protocol-minor", { ...value, negotiatedMinor: value.negotiatedMinor + 1 }],
    ["wrong-pair-id", { ...value, pairId: mutate(value.pairId) }],
    ["wrong-service-id", { ...value, serviceId: mutate(value.serviceId) }],
    ["swapped-nonces", {
      ...value,
      hostNonce: value.remoteNonce,
      remoteNonce: value.hostNonce
    }],
    ["swapped-bundle-hashes", {
      ...value,
      hostInstallationBundleHash: value.remoteInstallationBundleHash,
      remoteInstallationBundleHash: value.hostInstallationBundleHash
    }],
    ["swapped-trust-epochs", {
      ...value,
      hostTrustEpoch: value.remoteTrustEpoch,
      remoteTrustEpoch: value.hostTrustEpoch
    }],
    ["swapped-transport-session-ids", {
      ...value,
      hostTransportSessionId: value.remoteTransportSessionId,
      remoteTransportSessionId: value.hostTransportSessionId
    }],
    ["wrong-host-nonce", { ...value, hostNonce: mutate(value.hostNonce) }],
    ["wrong-remote-nonce", { ...value, remoteNonce: mutate(value.remoteNonce) }],
    ["wrong-host-bundle-hash", {
      ...value,
      hostInstallationBundleHash: mutate(value.hostInstallationBundleHash)
    }],
    ["wrong-remote-bundle-hash", {
      ...value,
      remoteInstallationBundleHash: mutate(value.remoteInstallationBundleHash)
    }],
    ["wrong-host-trust-epoch", { ...value, hostTrustEpoch: value.hostTrustEpoch + 1n }],
    ["wrong-remote-trust-epoch", { ...value, remoteTrustEpoch: value.remoteTrustEpoch - 1n }],
    ["wrong-host-transport-session-id", {
      ...value,
      hostTransportSessionId: mutate(value.hostTransportSessionId)
    }],
    ["wrong-remote-transport-session-id", {
      ...value,
      remoteTransportSessionId: mutate(value.remoteTransportSessionId)
    }]
  ];
  return variants.map(([name, inputs]) => ({
    name,
    inputs: sessionInputFixture(inputs)
  }));
}

function applicationSessionEncodingRejections(signedBytes: Buffer): ContractJson[] {
  const wrongDomain = Buffer.from(signedBytes);
  wrongDomain[4] ^= 1;
  const wrongProtocolMajor = Buffer.from(signedBytes);
  wrongProtocolMajor[30] ^= 1;
  const nonNegotiatedMinor = Buffer.from(signedBytes);
  nonNegotiatedMinor[32] ^= 1;
  const wrongPairWidth = Buffer.from(signedBytes);
  wrongPairWidth.writeUInt32BE(15, 33);
  const wrongDomainWidth = Buffer.from(signedBytes);
  wrongDomainWidth.writeUInt32BE(20, 0);
  return [
    ["truncated", signedBytes.subarray(0, signedBytes.byteLength - 1)],
    ["trailing-byte", Buffer.concat([signedBytes, Buffer.from([0])])],
    ["wrong-domain", wrongDomain],
    ["wrong-protocol-major", wrongProtocolMajor],
    ["non-negotiated-minor", nonNegotiatedMinor],
    ["wrong-pair-width", wrongPairWidth],
    ["wrong-domain-width", wrongDomainWidth]
  ].map(([name, payload]) => ({
    name: name as string,
    payloadB64: b64(payload as Buffer),
    expectedMinor: 0
  }));
}

function authTrace(
  role: ApplicationSessionRoleV1,
  events: readonly ApplicationSessionAuthEventV1[]
): ContractJson[] {
  const state = new ApplicationSessionAuthenticationV1(role);
  return events.map((event) => {
    state.transition(event);
    return {
      event,
      state: state.state,
      requestStartAllowed: state.canAcceptRequestStart
    };
  });
}

function signedBrowserEnvelope(
  key: Buffer,
  value: Omit<RemoteBrowserContextEnvelopeV1, "mac">
): RemoteBrowserContextEnvelopeV1 {
  const placeholder = RemoteBrowserContextEnvelopeV1Schema.parse({
    ...value,
    mac: Buffer.alloc(32).toString("base64url")
  });
  return RemoteBrowserContextEnvelopeV1Schema.parse({
    ...placeholder,
    mac: deriveRemoteBrowserContextMacV1(key, placeholder).toString("base64url")
  });
}

function browserContextRejections(
  value: RemoteBrowserContextEnvelopeV1
): ContractJson[] {
  const variants: Array<readonly [string, (candidate: ContractObject) => void]> = [
    ["gateway-launch-substitution", (candidate) => {
      (candidate.browserContext as ContractObject).gatewayLaunchId = b64(Buffer.alloc(32, 0x99));
    }],
    ["browser-session-substitution", (candidate) => {
      (candidate.browserContext as ContractObject).browserSessionId = b64(Buffer.alloc(32, 0x9a));
    }],
    ["request-nonce-substitution", (candidate) => {
      (candidate.browserContext as ContractObject).requestNonce = b64(Buffer.alloc(16, 0x9b));
    }],
    ["method-substitution", (candidate) => {
      (candidate.browserContext as ContractObject).method = "GET";
    }],
    ["target-substitution", (candidate) => {
      (candidate.browserContext as ContractObject).canonicalTarget = "/api/remote-access";
    }],
    ["query-order-substitution", (candidate) => {
      (candidate.browserContext as ContractObject).canonicalTarget =
        "/api/waifus?id=two&id=one&name=hello%20world";
    }],
    ["percent-encoding-substitution", (candidate) => {
      (candidate.browserContext as ContractObject).canonicalTarget =
        "/api/waifus?id=one&id=two&name=hello%2520world";
    }],
    ["pair-substitution", (candidate) => {
      candidate.pairId = b64(Buffer.alloc(16, 0x9c));
    }],
    ["device-substitution", (candidate) => {
      candidate.remoteDeviceId = "remote-device-02";
    }],
    ["bundle-substitution", (candidate) => {
      candidate.remoteInstallationBundleHash = b64(Buffer.alloc(32, 0x9d));
    }],
    ["host-epoch-substitution", (candidate) => {
      candidate.hostTrustEpoch = "9007199254740993";
    }],
    ["remote-epoch-substitution", (candidate) => {
      candidate.remoteTrustEpoch = "18446744073709551614";
    }],
    ["application-session-substitution", (candidate) => {
      candidate.applicationSessionHash = b64(Buffer.alloc(32, 0x9e));
    }],
    ["direct-request-substitution", (candidate) => {
      candidate.directRequestId = b64(Buffer.alloc(16, 0x9f));
    }],
    ["parent-stream-substitution", (candidate) => {
      candidate.remoteParentStreamId = "9007199254740995";
    }],
    ["mac-substitution", (candidate) => {
      candidate.mac = b64(Buffer.alloc(32, 0xa1));
    }]
  ];
  return variants.map(([name, apply]) => {
    const envelope = clone(value) as unknown as ContractObject;
    apply(envelope);
    return { name, envelope };
  });
}

function browserContextStructuralRejections(
  value: RemoteBrowserContextEnvelopeV1
): ContractJson[] {
  const variants: Array<readonly [string, (candidate: ContractObject) => void]> = [
    ["csrf-not-validated", (candidate) => {
      (candidate.browserContext as ContractObject).csrfValidated = false;
    }],
    ["noncanonical-target", (candidate) => {
      (candidate.browserContext as ContractObject).canonicalTarget = "/api/%41";
    }],
    ["lowercase-percent-escape", (candidate) => {
      (candidate.browserContext as ContractObject).canonicalTarget = "/api/waifus?next=%2fadmin";
    }],
    ["even-parent-stream", (candidate) => {
      candidate.remoteParentStreamId = "2";
    }],
    ["wrong-direct-stream", (candidate) => {
      candidate.directStreamId = "3";
    }],
    ["extra-header-field", (candidate) => {
      candidate.forwardedHeaders = { "x-waifus-browser-context": "forged" };
    }]
  ];
  return variants.map(([name, apply]) => {
    const envelope = clone(value) as unknown as ContractObject;
    apply(envelope);
    return { name, envelope };
  });
}

function approvalReceiptVectors(): ContractJson[] {
  const fixtures = createRemoteAccessFixtureSet();
  return ["local", "remote"].map((kind) => {
    const value = fixtures.get(`fixtures/valid/approval-receipt-${kind}.json`);
    if (!value) {
      throw new Error(`Missing generated ${kind} approval receipt fixture.`);
    }
    const derived = deriveApprovalContextHashV1(value);
    return {
      kind,
      value,
      canonicalBytesB64: b64(derived.canonicalBytes),
      contextHashB64: b64(derived.contextHash)
    };
  });
}

export function createRemoteServiceSessionV1Fixture(): ContractJson {
  const hostInstallationSeed = sequence(0x00, 32);
  const remoteInstallationSeed = sequence(0x20, 32);
  const pairRoot = sequence(0x40, 32);
  const sessionInput: ApplicationSessionContextV1 = {
    negotiatedMinor: 0,
    pairId: sequence(0x60, 16),
    serviceId: sequence(0x70, 16),
    hostNonce: sequence(0x80, 32),
    remoteNonce: sequence(0xa0, 32),
    hostInstallationBundleHash: sequence(0xc0, 32),
    remoteInstallationBundleHash: sequence(0xe0, 32),
    hostTrustEpoch: 9_007_199_254_740_992n,
    remoteTrustEpoch: 18_446_744_073_709_551_615n,
    hostTransportSessionId: Buffer.alloc(16, 0x11),
    remoteTransportSessionId: Buffer.alloc(16, 0x22)
  };
  const proofs = createApplicationSessionProofsV1(
    sessionInput,
    hostInstallationSeed,
    remoteInstallationSeed
  );
  const publicKeys = applicationSessionFixturePublicKeys(
    hostInstallationSeed,
    remoteInstallationSeed
  );
  const browserContextKey = deriveRemoteBrowserContextKeyV1({
    pairRoot,
    applicationSessionHash: proofs.applicationSessionHash,
    applicationSession: sessionInput
  });
  const envelope = signedBrowserEnvelope(browserContextKey, {
    version: 1,
    browserContext: {
      version: 1,
      gatewayLaunchId: b64(Buffer.alloc(32, 0x55)) as RemoteBrowserContextEnvelopeV1["browserContext"]["gatewayLaunchId"],
      browserSessionId: b64(Buffer.alloc(32, 0x66)) as RemoteBrowserContextEnvelopeV1["browserContext"]["browserSessionId"],
      requestNonce: b64(Buffer.alloc(16, 0x77)) as RemoteBrowserContextEnvelopeV1["browserContext"]["requestNonce"],
      method: "POST",
      canonicalTarget: "/api/waifus?id=one&id=two&name=hello%20world",
      csrfValidated: true
    },
    pairId: b64(sessionInput.pairId) as RemoteBrowserContextEnvelopeV1["pairId"],
    remoteDeviceId: "remote-device-01",
    remoteInstallationBundleHash: b64(sessionInput.remoteInstallationBundleHash) as RemoteBrowserContextEnvelopeV1["remoteInstallationBundleHash"],
    hostTrustEpoch: sessionInput.hostTrustEpoch.toString(10) as RemoteBrowserContextEnvelopeV1["hostTrustEpoch"],
    remoteTrustEpoch: sessionInput.remoteTrustEpoch.toString(10) as RemoteBrowserContextEnvelopeV1["remoteTrustEpoch"],
    applicationSessionHash: b64(proofs.applicationSessionHash) as RemoteBrowserContextEnvelopeV1["applicationSessionHash"],
    directRequestId: b64(Buffer.alloc(16, 0x88)) as RemoteBrowserContextEnvelopeV1["directRequestId"],
    remoteParentStreamId: "9007199254740993" as RemoteBrowserContextEnvelopeV1["remoteParentStreamId"],
    directStreamId: "1"
  });

  return {
    version: 1,
    roles: { host: 1, remote: 2 },
    applicationSession: {
      inputs: sessionInputFixture(sessionInput),
      hostInstallationSeedB64: b64(hostInstallationSeed),
      remoteInstallationSeedB64: b64(remoteInstallationSeed),
      hostInstallationPublicKeyB64: b64(publicKeys.host),
      remoteInstallationPublicKeyB64: b64(publicKeys.remote),
      signedBytesB64: b64(proofs.signedBytes),
      digestB64: b64(proofs.digest),
      hostSignatureB64: b64(proofs.hostSignature),
      remoteSignatureB64: b64(proofs.remoteSignature),
      applicationSessionHashB64: b64(proofs.applicationSessionHash),
      authSequence: {
        remote: authTrace("remote", [
          "send_hello",
          "receive_verified_hello_ack",
          "send_authenticate_peer",
          "receive_success_result"
        ]),
        host: authTrace("host", [
          "receive_hello",
          "send_hello_ack",
          "receive_verified_authenticate_peer",
          "send_success_result"
        ])
      }
    },
    remoteBrowserContext: {
      pairRootB64: b64(pairRoot),
      acceptedAt: ACCEPTED_AT.toString(10),
      gatewayExpiresAt: GATEWAY_EXPIRES_AT.toString(10),
      canonicalContextBytesB64: b64(serializeRemoteBrowserContextV1(envelope.browserContext)),
      browserContextKeyB64: b64(browserContextKey),
      macInputB64: b64(encodeRemoteBrowserContextMacInputV1(envelope)),
      envelope
    },
    approvalReceipts: approvalReceiptVectors(),
    rejections: {
      applicationSession: applicationSessionRejections(sessionInput),
      applicationSessionEncoding: applicationSessionEncodingRejections(proofs.signedBytes),
      remoteBrowserContext: browserContextRejections(envelope),
      remoteBrowserContextStructural: browserContextStructuralRejections(envelope),
      applicationSessionAuthSequence: [
        { role: "host", state: "idle", forbiddenEvent: "receive_verified_authenticate_peer" },
        { role: "remote", state: "idle", forbiddenEvent: "receive_verified_hello_ack" },
        { role: "host", state: "authenticated", forbiddenEvent: "receive_hello" },
        { role: "remote", state: "authenticated", forbiddenEvent: "send_hello" }
      ]
    }
  };
}

export function createRemoteServiceSessionFixtureSet(): ReadonlyMap<string, ContractJson> {
  return new Map([
    ["fixtures/crypto/service-session-v1.json", createRemoteServiceSessionV1Fixture()]
  ]);
}

export function serializeRemoteServiceSessionFixture(value: ContractJson): string {
  return serializeCanonicalContractJson(value);
}
