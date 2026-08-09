import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ControlNonceWindowV1,
  decodeActivationCertificateV1,
  activationCertificateRenewalStateV1,
  verifyActivationCertificateV1,
  verifyBrowserControlExceptionV1,
  verifyControlRequestEnvelopeV1,
  verifyControlResponseEnvelopeV1
} from "../src/shared/controlAuth.js";
import {
  createHttpAuthEnvelopeFixtureSet,
  serializeHttpAuthEnvelopeFixture
} from "../src/shared/controlAuthContract.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown, name = "fixture value"): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value as JsonObject;
}

function array(value: unknown, name = "fixture value"): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array.`);
  }
  return value;
}

function string(value: unknown, name = "fixture value"): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string.`);
  }
  return value;
}

function number(value: unknown, name = "fixture value"): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer.`);
  }
  return value;
}

function headers(value: unknown): Array<readonly [string, string]> {
  return array(value, "header tuples").map((entry) => {
    const tuple = array(entry, "header tuple");
    if (tuple.length !== 2) {
      throw new TypeError("header tuple must contain two values.");
    }
    return [string(tuple[0]), string(tuple[1])] as const;
  });
}

function fixture(): JsonObject {
  return object(
    createHttpAuthEnvelopeFixtureSet().values().next().value,
    "HTTP auth fixture"
  );
}

function workerKeys(value: JsonObject): ReadonlyMap<string, Buffer> {
  const worker = object(value.worker, "worker");
  return new Map([[string(worker.keyId), Buffer.from(string(worker.publicKeyB64), "base64url")]]);
}

describe("activation certificate and HTTP authentication envelope", () => {
  it("recreates the public fixture byte-for-byte", async () => {
    const fixtures = createHttpAuthEnvelopeFixtureSet();
    const expected = fixtures.get("fixtures/crypto/http-auth-envelope-v1.json");
    expect(expected).toBeDefined();
    const actual = await readFile(path.join(
      process.cwd(),
      "contracts",
      "remote",
      "v1",
      "fixtures",
      "crypto",
      "http-auth-envelope-v1.json"
    ), "utf8");
    expect(actual).toBe(serializeHttpAuthEnvelopeFixture(expected as never));
  });

  it("verifies the canonical certificate and its pinned lifetime and key", () => {
    const value = fixture();
    const certificate = object(value.certificate, "certificate");
    const encoded = Buffer.from(string(certificate.fullCborB64), "base64url");
    const decoded = decodeActivationCertificateV1(encoded);
    expect(decoded.encodedCbor).toEqual(encoded);
    expect(decoded.unsignedCbor).toEqual(
      Buffer.from(string(certificate.unsignedCborB64), "base64url")
    );
    expect(decoded.signature).toEqual(Buffer.from(string(certificate.signatureB64), "base64url"));
    expect(verifyActivationCertificateV1(encoded, {
      workerKeys: workerKeys(value),
      nowSeconds: BigInt(string(value.acceptedAt)),
      minimumCredentialEpoch: 7n
    })).toEqual(decoded);
    expect(activationCertificateRenewalStateV1(decoded, BigInt(string(value.acceptedAt)))).toBe("valid");
    expect(activationCertificateRenewalStateV1(
      decoded,
      decoded.expiresAt - 30n * 24n * 60n * 60n
    )).toBe("renewal_due");
    expect(activationCertificateRenewalStateV1(decoded, decoded.expiresAt)).toBe("expired");

    for (const raw of array(value.certificateRejections, "certificate rejections")) {
      const rejection = object(raw, "certificate rejection");
      const options = object(rejection.options, "certificate rejection options");
      expect(
        () => verifyActivationCertificateV1(
          Buffer.from(string(rejection.certificateB64), "base64url"),
          {
            workerKeys: string(options.unknownWorkerKey ?? "false") === "true"
              ? new Map()
              : workerKeys(value),
            nowSeconds: BigInt(string(options.nowSeconds)),
            minimumCredentialEpoch: BigInt(string(options.minimumCredentialEpoch)),
            revokedSerials: string(options.revokedSerialB64 ?? "")
              ? new Set([string(options.revokedSerialB64)])
              : undefined
          }
        ),
        string(rejection.name)
      ).toThrow(string(rejection.errorCode));
    }
  });

  it("keeps browser activation as the only unsigned protocol exception", () => {
    const value = fixture();
    for (const raw of array(value.browserRequests, "browser requests")) {
      const request = object(raw, "browser request");
      expect(() => verifyBrowserControlExceptionV1({
        method: string(request.method),
        pathname: string(request.pathname) as never,
        rawBody: Buffer.from(string(request.rawBodyB64), "base64url"),
        rawHeaders: headers(request.rawHeaders),
        headerBoundary: "raw"
      })).not.toThrow();
    }
    for (const raw of array(value.browserRejections, "browser rejections")) {
      const rejection = object(raw, "browser rejection");
      expect(
        () => verifyBrowserControlExceptionV1({
          method: string(rejection.method),
          pathname: string(rejection.pathname) as never,
          rawBody: Buffer.from(string(rejection.rawBodyB64), "base64url"),
          rawHeaders: headers(rejection.rawHeaders),
          headerBoundary: "raw"
        }),
        string(rejection.name)
      ).toThrow(string(rejection.errorCode));
    }
  });

  it("verifies ordinary, activation begin/poll, and WebSocket request signatures", () => {
    const value = fixture();
    const keys = workerKeys(value);
    const requests = array(value.requests, "requests").map((entry) => object(entry, "request"));
    for (const request of requests) {
      const result = verifyControlRequestEnvelopeV1({
        requestClass: string(request.requestClass) as never,
        method: string(request.method),
        pathname: string(request.pathname),
        rawBody: Buffer.from(string(request.rawBodyB64), "base64url"),
        rawHeaders: headers(request.rawHeaders),
        workerKeys: keys,
        nowSeconds: BigInt(string(value.acceptedAt)),
        headerBoundary: "raw"
      });
      expect(result.signingInput).toEqual(Buffer.from(string(request.signingInputB64), "base64url"));
      expect(result.signature).toEqual(Buffer.from(string(request.signatureB64), "base64url"));
      expect(result.requestBindingHash).toEqual(
        Buffer.from(string(request.requestBindingHashB64), "base64url")
      );
      expect(result.normalizedAuthHeaders).toEqual(object(request.normalizedAuthHeaders));
    }
  });

  it("rejects malformed headers, context substitutions, signatures, and replay", () => {
    const value = fixture();
    const keys = workerKeys(value);
    for (const raw of array(value.requestRejections, "request rejections")) {
      const rejection = object(raw, "request rejection");
      expect(
        () => verifyControlRequestEnvelopeV1({
          requestClass: string(rejection.requestClass) as never,
          method: string(rejection.method),
          pathname: string(rejection.pathname),
          rawBody: Buffer.from(string(rejection.rawBodyB64), "base64url"),
          rawHeaders: headers(rejection.rawHeaders),
          workerKeys: keys,
          nowSeconds: BigInt(string(rejection.nowSeconds)),
          headerBoundary: string(rejection.headerBoundary) as never
        }),
        string(rejection.name)
      ).toThrow(string(rejection.errorCode));
    }

    const request = object(array(value.requests)[0]);
    const replay = new ControlNonceWindowV1();
    const input = {
      requestClass: string(request.requestClass) as never,
      method: string(request.method),
      pathname: string(request.pathname),
      rawBody: Buffer.from(string(request.rawBodyB64), "base64url"),
      rawHeaders: headers(request.rawHeaders),
      workerKeys: keys,
      nowSeconds: BigInt(string(value.acceptedAt)),
      headerBoundary: "raw" as const,
      nonceWindow: replay
    };
    expect(() => verifyControlRequestEnvelopeV1(input)).not.toThrow();
    expect(() => verifyControlRequestEnvelopeV1(input)).toThrow("nonce_replay");
  });

  it("verifies signed JSON and WebSocket 101 responses before accepting bodies", () => {
    const value = fixture();
    const keys = workerKeys(value);
    for (const raw of array(value.responses, "responses")) {
      const response = object(raw, "response");
      const result = verifyControlResponseEnvelopeV1({
        pathname: string(response.pathname),
        status: number(response.status),
        rawBody: Buffer.from(string(response.rawBodyB64), "base64url"),
        rawHeaders: headers(response.rawHeaders),
        requestBindingHash: Buffer.from(string(response.requestBindingHashB64), "base64url"),
        workerKeys: keys,
        nowSeconds: BigInt(string(value.acceptedAt)),
        headerBoundary: "raw",
        expectedWebSocketKey: response.webSocketKey === undefined
          ? undefined
          : string(response.webSocketKey)
      });
      expect(result.signingInput).toEqual(Buffer.from(string(response.signingInputB64), "base64url"));
      expect(result.signature).toEqual(Buffer.from(string(response.signatureB64), "base64url"));
    }

    for (const raw of array(value.responseRejections, "response rejections")) {
      const rejection = object(raw, "response rejection");
      expect(
        () => verifyControlResponseEnvelopeV1({
          pathname: string(rejection.pathname),
          status: number(rejection.status),
          rawBody: Buffer.from(string(rejection.rawBodyB64), "base64url"),
          rawHeaders: headers(rejection.rawHeaders),
          requestBindingHash: Buffer.from(string(rejection.requestBindingHashB64), "base64url"),
          workerKeys: keys,
          nowSeconds: BigInt(string(rejection.nowSeconds)),
          headerBoundary: string(rejection.headerBoundary) as never,
          expectedWebSocketKey: rejection.webSocketKey === undefined
            ? undefined
            : string(rejection.webSocketKey)
        }),
        string(rejection.name)
      ).toThrow(string(rejection.errorCode));
    }
  });
});
