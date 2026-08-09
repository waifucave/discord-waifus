import { z } from "zod";
import {
  Base64Url16BytesSchema,
  Base64Url32BytesSchema,
  Base64Url64BytesSchema,
  CanonicalTargetSchema,
  CapabilityNameListSchema,
  CapabilityNameSchema,
  CapabilitySetSchema,
  ComponentHelloSchema,
  ComponentNameSchema,
  CompatibilityResultSchema,
  ControlProfileV1Schema,
  DeviceIdSchema,
  DeviceIdentityBundleSchema,
  DeviceRoleV1Schema,
  HttpMethodSchema,
  INITIAL_REQUIRED_CAPABILITIES,
  ProtocolCapabilitiesDocumentSchema,
  ProtocolVersionSchema,
  PrincipalStableIdSchema,
  REMOTE_PROTOCOL_VERSION,
  RemoteBrowserContextEnvelopeV1Schema,
  RemoteBrowserContextV1Schema,
  RequestPrincipalWireSchema,
  RuntimePurposeSchema,
  Uint64DecimalSchema,
  type ProtocolCapabilitiesDocument
} from "./remoteProtocol.js";

export const REMOTE_PROTOCOL_SCHEMA_ID =
  "https://waifucave.com/contracts/remote/v1/protocol.schema.json";

type JsonPrimitive = string | number | boolean | null;
export type ContractJson = JsonPrimitive | ContractJson[] | { [key: string]: ContractJson };
type ContractJsonObject = { [key: string]: ContractJson };

const registeredSchemas: ReadonlyArray<readonly [string, z.ZodType]> = [
  ["Base64Url16Bytes", Base64Url16BytesSchema],
  ["Base64Url32Bytes", Base64Url32BytesSchema],
  ["Base64Url64Bytes", Base64Url64BytesSchema],
  ["CanonicalTarget", CanonicalTargetSchema],
  ["CapabilityNameList", CapabilityNameListSchema],
  ["CapabilityName", CapabilityNameSchema],
  ["CapabilitySet", CapabilitySetSchema],
  ["ComponentHello", ComponentHelloSchema],
  ["ComponentName", ComponentNameSchema],
  ["CompatibilityResult", CompatibilityResultSchema],
  ["ControlProfileV1", ControlProfileV1Schema],
  ["DeviceId", DeviceIdSchema],
  ["DeviceIdentityBundle", DeviceIdentityBundleSchema],
  ["DeviceRoleV1", DeviceRoleV1Schema],
  ["HttpMethod", HttpMethodSchema],
  ["ProtocolCapabilitiesDocument", ProtocolCapabilitiesDocumentSchema],
  ["ProtocolVersion", ProtocolVersionSchema],
  ["PrincipalStableId", PrincipalStableIdSchema],
  ["RemoteBrowserContextEnvelopeV1", RemoteBrowserContextEnvelopeV1Schema],
  ["RemoteBrowserContextV1", RemoteBrowserContextV1Schema],
  ["RequestPrincipalWire", RequestPrincipalWireSchema],
  ["RuntimePurpose", RuntimePurposeSchema],
  ["Uint64Decimal", Uint64DecimalSchema]
];

function addNonStructuralContractConstraints(definitions: Record<string, ContractJsonObject>): void {
  const capabilitySet = definitions.CapabilitySet;
  const capabilityNameList = definitions.CapabilityNameList;
  capabilityNameList.uniqueItems = true;
  capabilityNameList["x-waifus-ascii-sorted"] = true;
  capabilitySet["x-waifus-disjoint-properties"] = ["required", "optional"];

  const canonicalTarget = definitions.CanonicalTarget;
  canonicalTarget.format = "waifus-origin-form-target-v1";
  canonicalTarget["x-waifus-canonicalization"] =
    "Exact ASCII origin-form path/query; uppercase minimal percent escapes; no authority, fragment, dot segment, encoded slash, or encoded backslash.";

  const componentHello = definitions.ComponentHello;
  componentHello.allOf = [
    {
      if: {
        properties: {
          controlProfile: { const: 2 }
        },
        required: ["controlProfile"]
      },
      then: {
        properties: {
          runtimePurpose: {
            enum: ["development", "release_validation"]
          }
        },
        required: ["runtimePurpose"]
      }
    }
  ];

  definitions.RequestPrincipalWire["x-waifus-derived-field"] = {
    stableId: "remote:<deviceId>"
  };
  definitions.RemoteBrowserContextEnvelopeV1["x-waifus-outside-forwarded-headers"] = [
    "browserContext",
    "pairId",
    "remoteDeviceId",
    "remoteInstallationBundleHash",
    "hostTrustEpoch",
    "remoteTrustEpoch",
    "applicationSessionHash",
    "directRequestId",
    "remoteParentStreamId",
    "directStreamId",
    "mac"
  ];
  definitions.RemoteBrowserContextEnvelopeV1["x-waifus-mac"] = {
    algorithm: "HMAC-SHA-256",
    context: "waifus/remote-browser-context/v1",
    keyDerivation: "waifus/browser-context-key/v1"
  };
  definitions.RemoteBrowserContextEnvelopeV1["x-waifus-positive-odd-uint64-field"] =
    "remoteParentStreamId";
}

export function createRemoteProtocolJsonSchema(): ContractJsonObject {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of registeredSchemas) {
    schema.register(registry, { id });
  }

  const generated = z.toJSONSchema(registry, {
    uri: (id) => `#/$defs/${id}`
  }) as { schemas: Record<string, Record<string, unknown>> };
  const definitions: Record<string, ContractJsonObject> = {};
  for (const [id, schema] of Object.entries(generated.schemas)) {
    const definition = { ...schema } as Record<string, unknown>;
    delete definition.$schema;
    delete definition.$id;
    definitions[id] = definition as ContractJsonObject;
  }
  addNonStructuralContractConstraints(definitions);

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: REMOTE_PROTOCOL_SCHEMA_ID,
    title: "Waifus Remote Protocol V1",
    description:
      "Public JSON-facing protocol primitives. Runtime parsers and conformance fixtures enforce the named custom canonical formats.",
    oneOf: [
      { $ref: "#/$defs/ComponentHello" },
      { $ref: "#/$defs/CompatibilityResult" },
      { $ref: "#/$defs/DeviceIdentityBundle" },
      { $ref: "#/$defs/ProtocolCapabilitiesDocument" },
      { $ref: "#/$defs/RemoteBrowserContextEnvelopeV1" },
      { $ref: "#/$defs/RemoteBrowserContextV1" },
      { $ref: "#/$defs/RequestPrincipalWire" }
    ],
    $defs: definitions
  };
}

export function createRemoteCapabilitiesDocument(): ProtocolCapabilitiesDocument {
  return ProtocolCapabilitiesDocumentSchema.parse({
    schemaVersion: 1,
    protocol: REMOTE_PROTOCOL_VERSION,
    capabilities: {
      required: [...INITIAL_REQUIRED_CAPABILITIES],
      optional: []
    }
  });
}

function protocolFixtureBytes(size: number, value: number): string {
  return Buffer.alloc(size, value).toString("base64url");
}

function deviceIdentityFixture(role: 1 | 2): ContractJson {
  return {
    version: 1,
    deviceId: role === 1 ? "host-device-01h" : "remote-device-01h",
    role,
    trustEpoch: role === 1 ? "1" : "2",
    installationPublicKey: protocolFixtureBytes(32, role === 1 ? 0x51 : 0x61),
    nodePublicKey: protocolFixtureBytes(32, role === 1 ? 0x52 : 0x62),
    discoveryPublicKey: protocolFixtureBytes(32, role === 1 ? 0x53 : 0x63),
    keySequence: 1,
    protocol: { major: 1, minor: 0 },
    capabilities: {
      required: [...INITIAL_REQUIRED_CAPABILITIES],
      optional: []
    },
    signature: protocolFixtureBytes(64, role === 1 ? 0x54 : 0x64)
  };
}

function requestPrincipalFixture(withBrowser: boolean): ContractJson {
  return {
    kind: "remote_device",
    stableId: "remote:remote-device-01h",
    deviceId: "remote-device-01h",
    peerFingerprint: protocolFixtureBytes(16, 0x65),
    transportSessionId: protocolFixtureBytes(16, 0x66),
    trustEpoch: "2",
    ...(withBrowser
      ? {
          browserContext: {
            version: 1,
            gatewayLaunchId: protocolFixtureBytes(32, 0x67),
            browserSessionId: protocolFixtureBytes(32, 0x68),
            requestNonce: protocolFixtureBytes(16, 0x69),
            method: "GET",
            canonicalTarget: "/api/remote-access",
            csrfValidated: true
          }
        }
      : {})
  };
}

function cloneProtocolFixture(value: ContractJson): ContractJson {
  return JSON.parse(JSON.stringify(value)) as ContractJson;
}

export function createRemoteProtocolFixtureSet(): ReadonlyMap<string, ContractJson> {
  const fixtures = new Map<string, ContractJson>();
  fixtures.set("fixtures/valid/device-identity-host.json", deviceIdentityFixture(1));
  fixtures.set("fixtures/valid/device-identity-remote.json", deviceIdentityFixture(2));
  fixtures.set("fixtures/valid/request-principal-browser.json", requestPrincipalFixture(true));
  fixtures.set("fixtures/valid/request-principal-service.json", requestPrincipalFixture(false));

  const wrongSequence = cloneProtocolFixture(deviceIdentityFixture(2)) as Record<string, ContractJson>;
  wrongSequence.keySequence = 2;
  fixtures.set("fixtures/invalid/device-identity-key-sequence.json", wrongSequence);

  const secretField = cloneProtocolFixture(deviceIdentityFixture(2)) as Record<string, ContractJson>;
  secretField.privateKey = "must-never-appear";
  fixtures.set("fixtures/invalid/device-identity-secret-field.json", secretField);

  const wrongStableId = cloneProtocolFixture(requestPrincipalFixture(true)) as Record<string, ContractJson>;
  wrongStableId.stableId = "remote:another-device";
  fixtures.set("fixtures/invalid/request-principal-stable-id.json", wrongStableId);

  const wrongSessionWidth = cloneProtocolFixture(requestPrincipalFixture(true)) as Record<string, ContractJson>;
  wrongSessionWidth.transportSessionId = protocolFixtureBytes(32, 0x66);
  fixtures.set("fixtures/invalid/request-principal-transport-width.json", wrongSessionWidth);

  return fixtures;
}

function sortContractJson(value: ContractJson): ContractJson {
  if (Array.isArray(value)) {
    return value.map(sortContractJson);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Canonical JSON does not permit non-finite numbers.");
  }
  if (typeof value === "string") {
    assertWellFormedUnicode(value);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => {
        assertWellFormedUnicode(key);
        return [key, sortContractJson(child)];
      })
  );
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || following < 0xdc00 || following > 0xdfff) {
        throw new TypeError("Canonical JSON requires well-formed Unicode strings.");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("Canonical JSON requires well-formed Unicode strings.");
    }
  }
}

export function serializeRemoteContractJson(value: ContractJson): string {
  return `${JSON.stringify(sortContractJson(value), null, 2)}\n`;
}

export function serializeCanonicalContractJson(value: ContractJson): string {
  return JSON.stringify(sortContractJson(value));
}
