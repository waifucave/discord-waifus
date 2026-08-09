import { z } from "zod";
import {
  Base64Url16BytesSchema,
  Base64Url32BytesSchema,
  CanonicalTargetSchema,
  CapabilityNameListSchema,
  CapabilityNameSchema,
  CapabilitySetSchema,
  ComponentHelloSchema,
  ComponentNameSchema,
  CompatibilityResultSchema,
  ControlProfileV1Schema,
  HttpMethodSchema,
  INITIAL_REQUIRED_CAPABILITIES,
  ProtocolCapabilitiesDocumentSchema,
  ProtocolVersionSchema,
  REMOTE_PROTOCOL_VERSION,
  RemoteBrowserContextV1Schema,
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
  ["CanonicalTarget", CanonicalTargetSchema],
  ["CapabilityNameList", CapabilityNameListSchema],
  ["CapabilityName", CapabilityNameSchema],
  ["CapabilitySet", CapabilitySetSchema],
  ["ComponentHello", ComponentHelloSchema],
  ["ComponentName", ComponentNameSchema],
  ["CompatibilityResult", CompatibilityResultSchema],
  ["ControlProfileV1", ControlProfileV1Schema],
  ["HttpMethod", HttpMethodSchema],
  ["ProtocolCapabilitiesDocument", ProtocolCapabilitiesDocumentSchema],
  ["ProtocolVersion", ProtocolVersionSchema],
  ["RemoteBrowserContextV1", RemoteBrowserContextV1Schema],
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
      { $ref: "#/$defs/ProtocolCapabilitiesDocument" },
      { $ref: "#/$defs/RemoteBrowserContextV1" }
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
