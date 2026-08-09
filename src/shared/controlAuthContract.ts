import { createHash } from "node:crypto";
import {
  createActivationCertificateV1,
  createControlRequestEnvelopeV1,
  createControlResponseEnvelopeV1,
  encodeActivationCertificateSignatureInputV1,
  type ActivationCertificateUnsignedV1,
  type ControlRequestClassV1,
  type CreatedControlRequestEnvelopeV1,
  type RawHeaderTupleV1
} from "./controlAuth.js";
import {
  decodeCanonicalCbor,
  deriveEd25519PublicKey,
  encodeCanonicalCbor,
  signEd25519,
  type CanonicalCborValue
} from "./remotePairing.js";
import {
  serializeCanonicalContractJson,
  type ContractJson
} from "./schemas/remoteProtocolContract.js";

type ContractObject = { [key: string]: ContractJson };

const ACCEPTED_AT = 1_786_270_830n;
const WORKER_KEY_ID = "waifucave-pair-certificate-2026-01";
const WORKER_SEED = sequence(0x20, 32);
const INSTALLATION_SEED = sequence(0x50, 32);

function sequence(start: number, length: number): Buffer {
  if (start < 0 || start + length > 256) {
    throw new RangeError("Fixture byte sequence exceeds one byte.");
  }
  return Buffer.from(Array.from({ length }, (_, index) => start + index));
}

function b64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function hash(value: Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function lp(value: Uint8Array): Buffer {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

function rawHeaders(value: CreatedControlRequestEnvelopeV1): ContractJson {
  return value.rawHeaders.map(([name, headerValue]) => [name, headerValue]);
}

function body(value: ContractObject): Buffer {
  return Buffer.from(serializeCanonicalContractJson(value), "utf8");
}

function requestVector(
  name: string,
  requestClass: ControlRequestClassV1,
  method: string,
  pathname: string,
  rawBody: Buffer,
  requestNonce: Buffer,
  certificateBytes: Buffer,
  webSocketKey?: string
): ContractObject & { _created: CreatedControlRequestEnvelopeV1 } {
  const created = createControlRequestEnvelopeV1({
    requestClass,
    method,
    pathname,
    rawBody,
    timestamp: ACCEPTED_AT,
    requestNonce,
    installationPrivateKeySeed: INSTALLATION_SEED,
    certificateBytes: requestClass === "certificate" || requestClass === "websocket"
      ? certificateBytes
      : undefined,
    webSocketKey
  });
  return {
    name,
    requestClass,
    method,
    pathname,
    rawBodyB64: b64(rawBody),
    rawHeaders: rawHeaders(created),
    normalizedAuthHeaders: created.normalizedAuthHeaders,
    signingInputB64: b64(created.signingInput),
    signatureB64: b64(created.signature),
    requestBindingHashB64: b64(created.requestBindingHash),
    ...(webSocketKey ? { webSocketKey } : {}),
    _created: created as never
  };
}

function publicRequest(value: ContractObject & { _created: CreatedControlRequestEnvelopeV1 }): ContractObject {
  const { _created: _created, ...result } = value;
  return result;
}

function requestRejection(
  name: string,
  source: ContractObject,
  errorCode: string,
  apply: (value: ContractObject) => void = () => undefined
): ContractObject {
  const result = clone(source);
  apply(result);
  return {
    name,
    requestClass: result.requestClass,
    method: result.method,
    pathname: result.pathname,
    rawBodyB64: result.rawBodyB64,
    rawHeaders: result.rawHeaders,
    nowSeconds: result.nowSeconds ?? ACCEPTED_AT.toString(10),
    headerBoundary: result.headerBoundary ?? "raw",
    errorCode
  };
}

function headerIndex(value: ContractObject, name: string): number {
  const tuples = value.rawHeaders as unknown as string[][];
  const index = tuples.findIndex(([candidate]) => candidate.toLowerCase() === name);
  if (index < 0) {
    throw new TypeError(`Fixture header ${name} is missing.`);
  }
  return index;
}

function setHeader(value: ContractObject, name: string, headerValue: string): void {
  const tuples = value.rawHeaders as unknown as string[][];
  tuples[headerIndex(value, name)][1] = headerValue;
}

function removeHeader(value: ContractObject, name: string): void {
  const tuples = value.rawHeaders as unknown as string[][];
  tuples.splice(headerIndex(value, name), 1);
}

function appendHeader(value: ContractObject, name: string, headerValue: string): void {
  (value.rawHeaders as unknown as string[][]).push([name, headerValue]);
}

function mutateB64(value: string): string {
  const bytes = Buffer.from(value, "base64url");
  bytes[0] ^= 1;
  return b64(bytes);
}

function signedCertificateMap(encoded: Buffer): Map<CanonicalCborValue, CanonicalCborValue> {
  const value = decodeCanonicalCbor(encoded, 384);
  if (!(value instanceof Map)) {
    throw new TypeError("Fixture certificate is not a CBOR map.");
  }
  return new Map(value);
}

function certificateRejection(
  name: string,
  certificate: Buffer,
  errorCode: string,
  options: Partial<{
    nowSeconds: bigint;
    minimumCredentialEpoch: bigint;
    unknownWorkerKey: boolean;
    revokedSerialB64: string;
  }> = {}
): ContractObject {
  return {
    name,
    certificateB64: b64(certificate),
    options: {
      nowSeconds: (options.nowSeconds ?? ACCEPTED_AT).toString(10),
      minimumCredentialEpoch: (options.minimumCredentialEpoch ?? 7n).toString(10),
      unknownWorkerKey: options.unknownWorkerKey ? "true" : "false",
      revokedSerialB64: options.revokedSerialB64 ?? ""
    },
    errorCode
  };
}

function responseVector(
  name: string,
  request: ContractObject & { _created: CreatedControlRequestEnvelopeV1 },
  status: number,
  rawBody: Buffer,
  responseNonce: Buffer,
  webSocketKey?: string
): ContractObject {
  const created = createControlResponseEnvelopeV1({
    pathname: request.pathname as string,
    status,
    rawBody,
    protocolMajor: 1,
    protocolMinor: 0,
    workerSigningKeyId: WORKER_KEY_ID,
    timestamp: ACCEPTED_AT,
    responseNonce,
    requestBindingHash: request._created.requestBindingHash,
    workerPrivateKeySeed: WORKER_SEED,
    webSocketKey
  });
  return {
    name,
    pathname: request.pathname,
    status,
    rawBodyB64: b64(rawBody),
    rawHeaders: created.rawHeaders.map(([headerName, headerValue]) => [headerName, headerValue]),
    normalizedAuthHeaders: created.normalizedAuthHeaders,
    requestBindingHashB64: b64(request._created.requestBindingHash),
    signingInputB64: b64(created.signingInput),
    signatureB64: b64(created.signature),
    ...(webSocketKey ? { webSocketKey } : {})
  };
}

function responseRejection(
  name: string,
  source: ContractObject,
  errorCode: string,
  apply: (value: ContractObject) => void = () => undefined
): ContractObject {
  const result = clone(source);
  apply(result);
  return {
    ...result,
    name,
    nowSeconds: result.nowSeconds ?? ACCEPTED_AT.toString(10),
    headerBoundary: result.headerBoundary ?? "raw",
    errorCode
  };
}

export function createHttpAuthEnvelopeV1Fixture(): ContractJson {
  const workerPublicKey = deriveEd25519PublicKey(WORKER_SEED);
  const installationPublicKey = deriveEd25519PublicKey(INSTALLATION_SEED);
  const certificateValue: ActivationCertificateUnsignedV1 = {
    version: 1,
    serial: sequence(0x10, 16),
    installationPublicKey,
    issuedAt: ACCEPTED_AT - 86_400n,
    expiresAt: ACCEPTED_AT - 86_400n + 365n * 24n * 60n * 60n,
    credentialEpoch: 7n,
    coordinationMajor: 1,
    coordinationMinor: 0,
    quotaTier: 1,
    workerSigningKeyId: WORKER_KEY_ID
  };
  const certificate = createActivationCertificateV1(WORKER_SEED, certificateValue);
  const invitationId = b64(sequence(0x80, 16));
  const pairId = b64(sequence(0x90, 16));
  const activationId = b64(sequence(0xa0, 32));
  const helperNonce = b64(sequence(0xc0, 32));
  const webSocketKey = sequence(0xe0, 16).toString("base64");

  const ordinary = requestVector(
    "certificate-request",
    "certificate",
    "POST",
    `/v1/invitations/${invitationId}/claim`,
    body({
      identityCommitment: b64(hash(Buffer.from("remote-identity", "ascii"))),
      protocolMajor: 1,
      protocolMinor: 0
    }),
    sequence(0x01, 16),
    certificate.encodedCbor
  );
  const begin = requestVector(
    "activation-begin",
    "activation_begin",
    "POST",
    "/v1/activation/challenges",
    body({ activationId, helperNonce }),
    sequence(0x02, 16),
    certificate.encodedCbor
  );
  const poll = requestVector(
    "activation-poll",
    "activation_poll",
    "POST",
    "/v1/activation/poll",
    body({ activationId, helperNonce }),
    sequence(0x03, 16),
    certificate.encodedCbor
  );
  const websocket = requestVector(
    "websocket-upgrade",
    "websocket",
    "GET",
    `/v1/pairs/${pairId}/control`,
    Buffer.alloc(0),
    sequence(0x04, 16),
    certificate.encodedCbor,
    webSocketKey
  );
  const requestSources = [ordinary, begin, poll, websocket];
  const requests = requestSources.map(publicRequest);

  const successResponse = responseVector(
    "signed-success",
    ordinary,
    201,
    body({ invitationGeneration: "1", pairId }),
    sequence(0x31, 16)
  );
  const errorResponse = responseVector(
    "signed-safe-error",
    begin,
    409,
    body({ error: "challenge_exists", message: "Activation challenge already exists." }),
    sequence(0x41, 16)
  );
  const websocketResponse = responseVector(
    "signed-websocket-101",
    websocket,
    101,
    Buffer.alloc(0),
    sequence(0x51, 16),
    webSocketKey
  );
  const responses = [successResponse, errorResponse, websocketResponse];
  const browserCompletionBody = body({
    activationId,
    browserNonce: b64(sequence(0x70, 32)),
    turnstileToken: "turnstile-fixture-token"
  });
  const browserRequests: ContractObject[] = [
    {
      name: "activation-document",
      method: "GET",
      pathname: "/activate",
      rawBodyB64: "",
      rawHeaders: [["accept", "text/html"]]
    },
    {
      name: "activation-completion",
      method: "POST",
      pathname: "/v1/activation/complete",
      rawBodyB64: b64(browserCompletionBody),
      rawHeaders: [["content-type", "application/json"]]
    }
  ];
  const browserRejections: ContractObject[] = [
    {
      ...browserRequests[0],
      name: "activation-document-auth-header",
      rawHeaders: [["x-waifus-protocol", "1.0"]],
      errorCode: "forbidden_header"
    },
    {
      ...browserRequests[1],
      name: "activation-completion-auth-header",
      rawHeaders: [
        ["content-type", "application/json"],
        ["x-waifus-protocol", "1.0"]
      ],
      errorCode: "forbidden_header"
    },
    {
      ...browserRequests[0],
      name: "activation-document-body",
      rawBodyB64: b64(Buffer.from("{}")),
      errorCode: "invalid_request"
    },
    {
      ...browserRequests[1],
      name: "activation-completion-content-type",
      rawHeaders: [["content-type", "text/plain"]],
      errorCode: "invalid_request"
    },
    {
      ...browserRequests[1],
      name: "activation-completion-over-limit",
      rawBodyB64: b64(Buffer.alloc(4_097, 0x61)),
      errorCode: "invalid_request"
    },
    {
      ...browserRequests[1],
      name: "activation-completion-wrong-route",
      pathname: "/v1/activation/challenges",
      errorCode: "invalid_request"
    }
  ];

  const wrongSignatureMap = signedCertificateMap(certificate.encodedCbor);
  const wrongSignature = Buffer.from(wrongSignatureMap.get(11n) as Buffer);
  wrongSignature[0] ^= 1;
  wrongSignatureMap.set(11n, wrongSignature);
  const wrongWidthMap = signedCertificateMap(certificate.encodedCbor);
  wrongWidthMap.set(2n, sequence(0x10, 15));
  const wrongLifetimeMap = signedCertificateMap(certificate.encodedCbor);
  wrongLifetimeMap.set(5n, certificateValue.expiresAt + 1n);
  const unknownFieldMap = signedCertificateMap(certificate.encodedCbor);
  unknownFieldMap.set(12n, 1n);
  const versionMap = signedCertificateMap(certificate.encodedCbor);
  versionMap.set(1n, 2n);
  const serialSubstitutionMap = signedCertificateMap(certificate.encodedCbor);
  serialSubstitutionMap.set(2n, sequence(0x11, 16));
  const installationSubstitutionMap = signedCertificateMap(certificate.encodedCbor);
  installationSubstitutionMap.set(3n, sequence(0x51, 32));
  const timeSubstitutionMap = signedCertificateMap(certificate.encodedCbor);
  timeSubstitutionMap.set(4n, certificateValue.issuedAt + 1n);
  timeSubstitutionMap.set(5n, certificateValue.expiresAt + 1n);
  const epochSubstitutionMap = signedCertificateMap(certificate.encodedCbor);
  epochSubstitutionMap.set(6n, 8n);
  const majorSubstitutionMap = signedCertificateMap(certificate.encodedCbor);
  majorSubstitutionMap.set(7n, 2n);
  const minorSubstitutionMap = signedCertificateMap(certificate.encodedCbor);
  minorSubstitutionMap.set(8n, 1n);
  const quotaSubstitutionMap = signedCertificateMap(certificate.encodedCbor);
  quotaSubstitutionMap.set(9n, 2n);
  const keyIdSubstitutionMap = signedCertificateMap(certificate.encodedCbor);
  keyIdSubstitutionMap.set(10n, "waifucave-pair-staging-certificate-2026-01");
  const certificateRejections = [
    certificateRejection(
      "trailing-cbor-byte",
      Buffer.concat([certificate.encodedCbor, Buffer.from([0])]),
      "invalid_certificate"
    ),
    certificateRejection(
      "wrong-certificate-signature",
      encodeCanonicalCbor(wrongSignatureMap),
      "invalid_certificate_signature"
    ),
    certificateRejection(
      "wrong-serial-width",
      encodeCanonicalCbor(wrongWidthMap),
      "invalid_certificate"
    ),
    certificateRejection(
      "wrong-certificate-lifetime",
      encodeCanonicalCbor(wrongLifetimeMap),
      "certificate_lifetime"
    ),
    certificateRejection(
      "unknown-certificate-field",
      encodeCanonicalCbor(unknownFieldMap),
      "invalid_certificate"
    ),
    certificateRejection(
      "certificate-version-substitution",
      encodeCanonicalCbor(versionMap),
      "invalid_certificate"
    ),
    certificateRejection(
      "certificate-serial-substitution",
      encodeCanonicalCbor(serialSubstitutionMap),
      "invalid_certificate_signature"
    ),
    certificateRejection(
      "certificate-installation-key-substitution",
      encodeCanonicalCbor(installationSubstitutionMap),
      "invalid_certificate_signature"
    ),
    certificateRejection(
      "certificate-time-substitution",
      encodeCanonicalCbor(timeSubstitutionMap),
      "invalid_certificate_signature"
    ),
    certificateRejection(
      "certificate-epoch-substitution",
      encodeCanonicalCbor(epochSubstitutionMap),
      "invalid_certificate_signature"
    ),
    certificateRejection(
      "certificate-major-substitution",
      encodeCanonicalCbor(majorSubstitutionMap),
      "invalid_certificate"
    ),
    certificateRejection(
      "certificate-minor-substitution",
      encodeCanonicalCbor(minorSubstitutionMap),
      "invalid_certificate"
    ),
    certificateRejection(
      "certificate-quota-substitution",
      encodeCanonicalCbor(quotaSubstitutionMap),
      "invalid_certificate"
    ),
    certificateRejection(
      "certificate-key-id-substitution",
      encodeCanonicalCbor(keyIdSubstitutionMap),
      "unknown_worker_key"
    ),
    certificateRejection(
      "unknown-worker-key",
      certificate.encodedCbor,
      "unknown_worker_key",
      { unknownWorkerKey: true }
    ),
    certificateRejection(
      "certificate-not-yet-valid",
      certificate.encodedCbor,
      "certificate_not_yet_valid",
      { nowSeconds: certificateValue.issuedAt - 1n }
    ),
    certificateRejection(
      "certificate-expired",
      certificate.encodedCbor,
      "certificate_expired",
      { nowSeconds: certificateValue.expiresAt }
    ),
    certificateRejection(
      "credential-epoch-rollback",
      certificate.encodedCbor,
      "credential_epoch_rollback",
      { minimumCredentialEpoch: 8n }
    ),
    certificateRejection(
      "revoked-serial",
      certificate.encodedCbor,
      "certificate_revoked",
      { revokedSerialB64: b64(certificate.serial) }
    )
  ];

  const ordinarySource = publicRequest(ordinary);
  const beginSource = publicRequest(begin);
  const websocketSource = publicRequest(websocket);
  const requestRejections = [
    requestRejection("method-substitution", ordinarySource, "invalid_signature", (value) => {
      value.method = "PUT";
    }),
    requestRejection("concrete-path-substitution", ordinarySource, "invalid_signature", (value) => {
      value.pathname = `/v1/invitations/${b64(sequence(0x81, 16))}/claim`;
    }),
    requestRejection("route-template-replay", ordinarySource, "invalid_signature", (value) => {
      value.pathname = "/v1/invitations/:invitationId/claim";
    }),
    requestRejection("query-bearing-path", ordinarySource, "invalid_request", (value) => {
      value.pathname = `${value.pathname}?invitationId=alias`;
    }),
    requestRejection("percent-encoded-alias", ordinarySource, "invalid_request", (value) => {
      value.pathname = "/v1/invitations/%67/claim";
    }),
    requestRejection("body-byte-substitution", ordinarySource, "invalid_signature", (value) => {
      value.rawBodyB64 = b64(Buffer.concat([Buffer.from(value.rawBodyB64 as string, "base64url"), Buffer.from(" ")]));
    }),
    requestRejection("protocol-substitution", ordinarySource, "invalid_header_value", (value) => {
      setHeader(value, PROTOCOL_HEADER, "1.1");
    }),
    requestRejection("missing-request-signature", ordinarySource, "missing_header", (value) => {
      removeHeader(value, "x-waifus-request-signature");
    }),
    requestRejection("unknown-auth-header", ordinarySource, "unknown_auth_header", (value) => {
      appendHeader(value, "x-waifus-extra", "value");
    }),
    requestRejection("raw-uppercase-application-name", ordinarySource, "invalid_header_name", (value) => {
      (value.rawHeaders as unknown as string[][])[0][0] = "X-Waifus-Protocol";
    }),
    requestRejection("exact-duplicate", ordinarySource, "duplicate_header", (value) => {
      appendHeader(value, "x-waifus-protocol", "1.0");
    }),
    requestRejection("mixed-case-duplicate", ordinarySource, "duplicate_header", (value) => {
      appendHeader(value, "X-Waifus-Protocol", "1.0");
    }),
    requestRejection("platform-comma-coalescing", ordinarySource, "invalid_header_value", (value) => {
      setHeader(value, "x-waifus-protocol", "1.0,1.0");
    }),
    requestRejection("leading-header-whitespace", ordinarySource, "invalid_header_value", (value) => {
      setHeader(value, "x-waifus-protocol", " 1.0");
    }),
    requestRejection("header-tab", ordinarySource, "invalid_header_value", (value) => {
      setHeader(value, "x-waifus-protocol", "1.0\t");
    }),
    requestRejection("padded-request-nonce", ordinarySource, "invalid_header_value", (value) => {
      setHeader(value, "x-waifus-request-nonce", `${(value.rawHeaders as unknown as string[][])[headerIndex(value, "x-waifus-request-nonce")][1]}=`);
    }),
    requestRejection("wrong-request-nonce-width", ordinarySource, "invalid_header_value", (value) => {
      setHeader(value, "x-waifus-request-nonce", b64(Buffer.alloc(15, 1)));
    }),
    requestRejection("leading-zero-timestamp", ordinarySource, "invalid_header_value", (value) => {
      setHeader(value, "x-waifus-timestamp", `0${ACCEPTED_AT}`);
    }),
    requestRejection("overflow-timestamp", ordinarySource, "invalid_header_value", (value) => {
      setHeader(value, "x-waifus-timestamp", "18446744073709551616");
    }),
    requestRejection("request-timestamp-substitution", ordinarySource, "invalid_signature", (value) => {
      setHeader(value, "x-waifus-timestamp", (ACCEPTED_AT + 1n).toString(10));
    }),
    requestRejection("request-nonce-substitution", ordinarySource, "invalid_signature", (value) => {
      const index = headerIndex(value, "x-waifus-request-nonce");
      setHeader(value, "x-waifus-request-nonce", mutateB64((value.rawHeaders as unknown as string[][])[index][1]));
    }),
    requestRejection("aggregate-auth-header-limit", ordinarySource, "header_limit", (value) => {
      setHeader(value, "x-waifus-certificate", "A".repeat(904));
    }),
    requestRejection("response-header-on-request", ordinarySource, "forbidden_header", (value) => {
      appendHeader(value, "x-waifus-worker-key-id", WORKER_KEY_ID);
    }),
    requestRejection("installation-header-on-certificate-request", ordinarySource, "forbidden_header", (value) => {
      appendHeader(value, "x-waifus-installation-key", b64(installationPublicKey));
    }),
    requestRejection("certificate-header-on-precertificate-request", beginSource, "forbidden_header", (value) => {
      appendHeader(value, "x-waifus-certificate", b64(certificate.encodedCbor));
    }),
    requestRejection("stale-request-timestamp", ordinarySource, "timestamp_out_of_window", (value) => {
      value.nowSeconds = (ACCEPTED_AT + 61n).toString(10);
    }),
    requestRejection("future-request-timestamp", ordinarySource, "timestamp_out_of_window", (value) => {
      value.nowSeconds = (ACCEPTED_AT - 61n).toString(10);
    }),
    requestRejection("wrong-request-signature", ordinarySource, "invalid_signature", (value) => {
      const index = headerIndex(value, "x-waifus-request-signature");
      setHeader(value, "x-waifus-request-signature", mutateB64((value.rawHeaders as unknown as string[][])[index][1]));
    }),
    requestRejection("websocket-body", websocketSource, "invalid_websocket", (value) => {
      value.rawBodyB64 = b64(Buffer.from("{}"));
    }),
    requestRejection("websocket-extension", websocketSource, "invalid_websocket", (value) => {
      appendHeader(value, "sec-websocket-extensions", "permessage-deflate");
    }),
    requestRejection("websocket-subprotocol", websocketSource, "invalid_websocket", (value) => {
      setHeader(value, "sec-websocket-protocol", "other");
    }),
    requestRejection("websocket-content-type", websocketSource, "invalid_websocket", (value) => {
      appendHeader(value, "content-type", "application/json");
    }),
    requestRejection("websocket-key-width", websocketSource, "invalid_websocket", (value) => {
      setHeader(value, "sec-websocket-key", Buffer.alloc(15).toString("base64"));
    }),
    requestRejection("request-body-over-limit", ordinarySource, "invalid_request", (value) => {
      value.rawBodyB64 = b64(Buffer.alloc(2_049, 0x61));
    })
  ];

  const responseRejections = [
    responseRejection("response-path-substitution", successResponse, "invalid_signature", (value) => {
      value.pathname = `/v1/invitations/${b64(sequence(0x81, 16))}/claim`;
    }),
    responseRejection("response-status-substitution", successResponse, "invalid_signature", (value) => {
      value.status = 200;
    }),
    responseRejection("response-body-substitution", successResponse, "invalid_signature", (value) => {
      value.rawBodyB64 = b64(Buffer.concat([Buffer.from(value.rawBodyB64 as string, "base64url"), Buffer.from(" ")]));
    }),
    responseRejection("response-request-binding-substitution", successResponse, "invalid_signature", (value) => {
      value.requestBindingHashB64 = mutateB64(value.requestBindingHashB64 as string);
    }),
    responseRejection("response-protocol-substitution", successResponse, "invalid_header_value", (value) => {
      setHeader(value, "x-waifus-protocol", "1.1");
    }),
    responseRejection("unknown-response-worker-key", successResponse, "unknown_worker_key", (value) => {
      setHeader(value, "x-waifus-worker-key-id", "waifucave-pair-certificate-2099-01");
    }),
    responseRejection("stale-response", successResponse, "timestamp_out_of_window", (value) => {
      value.nowSeconds = (ACCEPTED_AT + 61n).toString(10);
    }),
    responseRejection("wrong-response-nonce-width", successResponse, "invalid_header_value", (value) => {
      setHeader(value, "x-waifus-response-nonce", b64(Buffer.alloc(15, 1)));
    }),
    responseRejection("response-timestamp-substitution", successResponse, "invalid_signature", (value) => {
      setHeader(value, "x-waifus-timestamp", (ACCEPTED_AT + 1n).toString(10));
    }),
    responseRejection("response-nonce-substitution", successResponse, "invalid_signature", (value) => {
      const index = headerIndex(value, "x-waifus-response-nonce");
      setHeader(value, "x-waifus-response-nonce", mutateB64((value.rawHeaders as unknown as string[][])[index][1]));
    }),
    responseRejection("wrong-response-signature", successResponse, "invalid_signature", (value) => {
      const index = headerIndex(value, "x-waifus-response-signature");
      setHeader(value, "x-waifus-response-signature", mutateB64((value.rawHeaders as unknown as string[][])[index][1]));
    }),
    responseRejection("missing-response-signature", successResponse, "missing_header", (value) => {
      removeHeader(value, "x-waifus-response-signature");
    }),
    responseRejection("request-header-on-response", successResponse, "forbidden_header", (value) => {
      appendHeader(value, "x-waifus-request-nonce", b64(sequence(0x01, 16)));
    }),
    responseRejection("response-content-type-drift", successResponse, "invalid_response", (value) => {
      setHeader(value, "content-type", "application/json; charset=utf-8");
    }),
    responseRejection("raw-uppercase-response-name", successResponse, "invalid_header_name", (value) => {
      (value.rawHeaders as unknown as string[][])[0][0] = "X-Waifus-Protocol";
    }),
    responseRejection("duplicate-response-header", successResponse, "duplicate_header", (value) => {
      appendHeader(value, "x-waifus-protocol", "1.0");
    }),
    responseRejection("websocket-accept-substitution", websocketResponse, "invalid_websocket", (value) => {
      setHeader(value, "sec-websocket-accept", Buffer.alloc(20, 1).toString("base64"));
    }),
    responseRejection("websocket-response-subprotocol", websocketResponse, "invalid_websocket", (value) => {
      setHeader(value, "sec-websocket-protocol", "other");
    }),
    responseRejection("websocket-response-extension", websocketResponse, "invalid_websocket", (value) => {
      appendHeader(value, "sec-websocket-extensions", "permessage-deflate");
    }),
    responseRejection("websocket-response-body", websocketResponse, "invalid_websocket", (value) => {
      value.rawBodyB64 = b64(Buffer.from("{}"));
    }),
    responseRejection("response-body-over-limit", successResponse, "invalid_response", (value) => {
      value.rawBodyB64 = b64(Buffer.alloc(2_049, 0x61));
    })
  ];

  const certificateSignatureInput = encodeActivationCertificateSignatureInputV1(certificateValue);
  const independentlySigned = signEd25519(WORKER_SEED, certificateSignatureInput);
  if (!independentlySigned.equals(certificate.signature)) {
    throw new Error("Fixture certificate signature input diverged.");
  }
  const invalidLifetimeUnsigned = signedCertificateMap(certificate.encodedCbor);
  invalidLifetimeUnsigned.delete(11n);
  invalidLifetimeUnsigned.set(5n, certificateValue.expiresAt + 1n);
  const invalidLifetimeCbor = encodeCanonicalCbor(invalidLifetimeUnsigned);
  const invalidLifetimeInput = Buffer.concat([
    lp(Buffer.from("waifus/activation-certificate/v1", "ascii")),
    lp(invalidLifetimeCbor)
  ]);

  return {
    version: 1,
    acceptedAt: ACCEPTED_AT.toString(10),
    protocol: { major: 1, minor: 0 },
    worker: {
      keyId: WORKER_KEY_ID,
      privateSeedB64: b64(WORKER_SEED),
      publicKeyB64: b64(workerPublicKey)
    },
    installation: {
      privateSeedB64: b64(INSTALLATION_SEED),
      publicKeyB64: b64(installationPublicKey)
    },
    certificate: {
      value: {
        version: 1,
        serialB64: b64(certificate.serial),
        installationPublicKeyB64: b64(certificate.installationPublicKey),
        issuedAt: certificate.issuedAt.toString(10),
        expiresAt: certificate.expiresAt.toString(10),
        credentialEpoch: certificate.credentialEpoch.toString(10),
        coordinationMajor: certificate.coordinationMajor,
        coordinationMinor: certificate.coordinationMinor,
        quotaTier: certificate.quotaTier,
        workerSigningKeyId: certificate.workerSigningKeyId
      },
      unsignedCborB64: b64(certificate.unsignedCbor),
      signatureInputB64: b64(certificateSignatureInput),
      signatureB64: b64(certificate.signature),
      fullCborB64: b64(certificate.encodedCbor),
      certificateSha256B64: b64(hash(certificate.encodedCbor)),
      invalidLifetimeSigningInputB64: b64(invalidLifetimeInput)
    },
    requests,
    responses,
    browserRequests,
    browserRejections,
    certificateRejections,
    requestRejections,
    responseRejections,
    limits: {
      certificateDecodedBytes: 384,
      certificateHeaderCharacters: 512,
      aggregateAuthHeaderValueBytes: 1_024,
      rawBodyBytes: 2_048,
      turnstileCompletionRawBodyBytes: 4_096,
      timestampSkewSeconds: "60",
      nonceRetentionSeconds: "600",
      nonceEntries: 1_024
    }
  };
}

const PROTOCOL_HEADER = "x-waifus-protocol";

export function createHttpAuthEnvelopeFixtureSet(): Map<string, ContractJson> {
  return new Map([[
    "fixtures/crypto/http-auth-envelope-v1.json",
    createHttpAuthEnvelopeV1Fixture()
  ]]);
}

export function serializeHttpAuthEnvelopeFixture(value: ContractJson): string {
  return serializeCanonicalContractJson(value);
}
