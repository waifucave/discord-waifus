import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ComponentHelloSchema,
  INITIAL_REQUIRED_CAPABILITIES,
  RemoteBrowserContextV1Schema,
  Uint64DecimalSchema,
  formatUint64Decimal,
  negotiateComponentCompatibility,
  parseUint64Decimal
} from "../src/shared/schemas/remoteProtocol.js";
import {
  createRemoteCapabilitiesDocument,
  createRemoteProtocolJsonSchema,
  serializeRemoteContractJson
} from "../src/shared/schemas/remoteProtocolContract.js";

const gatewayLaunchId = Buffer.alloc(32, 0x11).toString("base64url");
const browserSessionId = Buffer.alloc(32, 0x22).toString("base64url");
const requestNonce = Buffer.alloc(16, 0x33).toString("base64url");

function componentHello(overrides: Record<string, unknown> = {}) {
  return {
    protocol: { major: 1, minor: 0 },
    component: "discord_waifus",
    componentVersion: "1.5.203",
    buildId: "discord-waifus-test-build",
    nonce: Buffer.alloc(32, 0x44).toString("base64url"),
    capabilities: {
      required: [...INITIAL_REQUIRED_CAPABILITIES],
      optional: []
    },
    controlProfile: 1,
    runtimePurpose: "normal",
    ...overrides
  };
}

describe("Uint64DecimalSchema", () => {
  it.each([
    "0",
    "1",
    "9007199254740992",
    "18446744073709551615"
  ])("accepts the canonical uint64 string %s", (value) => {
    expect(Uint64DecimalSchema.parse(value)).toBe(value);
  });

  it.each([
    0,
    9_007_199_254_740_992,
    "",
    "00",
    "01",
    "+1",
    "-1",
    "1.0",
    "1e3",
    " 1",
    "1 ",
    "18446744073709551616"
  ])("rejects noncanonical or out-of-range input %j", (value) => {
    expect(Uint64DecimalSchema.safeParse(value).success).toBe(false);
  });

  it("converts through bigint without narrowing through number", () => {
    const value = Uint64DecimalSchema.parse("18446744073709551615");
    expect(parseUint64Decimal(value)).toBe(18_446_744_073_709_551_615n);
    expect(formatUint64Decimal(9_007_199_254_740_992n)).toBe("9007199254740992");
    expect(() => formatUint64Decimal(-1n)).toThrow(/uint64/i);
    expect(() => formatUint64Decimal(18_446_744_073_709_551_616n)).toThrow(/uint64/i);
  });
});

describe("component compatibility", () => {
  it("round-trips a strict authenticated component hello", () => {
    const parsed = ComponentHelloSchema.parse(componentHello());
    expect(ComponentHelloSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(ComponentHelloSchema.safeParse({ ...parsed, unexpected: true }).success).toBe(false);
  });

  it("requires sorted, unique, disjoint namespaced capability sets", () => {
    const base = componentHello();
    expect(ComponentHelloSchema.safeParse(componentHello({
      capabilities: {
        required: ["waifus.stream.cancel.v1", "waifus.http.v1"],
        optional: []
      }
    })).success).toBe(false);
    expect(ComponentHelloSchema.safeParse(componentHello({
      capabilities: {
        required: ["waifus.http.v1", "waifus.http.v1"],
        optional: []
      }
    })).success).toBe(false);
    expect(ComponentHelloSchema.safeParse(componentHello({
      capabilities: {
        required: ["waifus.http.v1"],
        optional: ["waifus.http.v1"]
      }
    })).success).toBe(false);
    expect(ComponentHelloSchema.safeParse(componentHello({
      capabilities: {
        required: ["not_namespaced"],
        optional: []
      }
    })).success).toBe(false);
    expect(ComponentHelloSchema.safeParse(base).success).toBe(true);
  });

  it("rejects staging in normal runtime and arbitrary profile values", () => {
    expect(ComponentHelloSchema.safeParse(componentHello({ controlProfile: 2 })).success).toBe(false);
    expect(ComponentHelloSchema.safeParse(componentHello({
      controlProfile: 2,
      runtimePurpose: "development"
    })).success).toBe(true);
    expect(ComponentHelloSchema.safeParse(componentHello({ controlProfile: 3 })).success).toBe(false);
  });

  it("fails closed on a protocol-major mismatch", () => {
    const result = negotiateComponentCompatibility(
      ComponentHelloSchema.parse(componentHello()),
      ComponentHelloSchema.parse(componentHello({
        component: "ts_connect",
        protocol: { major: 2, minor: 0 }
      }))
    );
    expect(result).toMatchObject({ compatible: false, code: "protocol_major_mismatch" });
  });

  it("fails closed on unknown required capabilities", () => {
    const result = negotiateComponentCompatibility(
      ComponentHelloSchema.parse(componentHello()),
      ComponentHelloSchema.parse(componentHello({
        component: "ts_connect",
        capabilities: {
          required: [...INITIAL_REQUIRED_CAPABILITIES, "waifus.unreleased.v1"].sort(),
          optional: []
        }
      }))
    );
    expect(result).toEqual({
      compatible: false,
      code: "missing_required_capability",
      message: "Local component does not provide peer-required capabilities.",
      missingCapabilities: ["waifus.unreleased.v1"]
    });
  });

  it("negotiates the lower minor and ignores unknown optional capabilities", () => {
    const local = ComponentHelloSchema.parse(componentHello({
      protocol: { major: 1, minor: 3 },
      capabilities: {
        required: [...INITIAL_REQUIRED_CAPABILITIES],
        optional: ["waifus.local-extra.v1"]
      }
    }));
    const peer = ComponentHelloSchema.parse(componentHello({
      component: "ts_connect",
      protocol: { major: 1, minor: 2 },
      capabilities: {
        required: [...INITIAL_REQUIRED_CAPABILITIES],
        optional: ["waifus.peer-extra.v1"]
      }
    }));
    expect(negotiateComponentCompatibility(local, peer)).toEqual({
      compatible: true,
      protocol: { major: 1, minor: 2 },
      capabilities: [...INITIAL_REQUIRED_CAPABILITIES]
    });
  });

  it("rejects a negotiated minor below the caller's floor", () => {
    const local = ComponentHelloSchema.parse(componentHello({ protocol: { major: 1, minor: 2 } }));
    const peer = ComponentHelloSchema.parse(componentHello({
      component: "ts_connect",
      protocol: { major: 1, minor: 1 }
    }));
    expect(negotiateComponentCompatibility(local, peer, { minimumMinor: 2 })).toMatchObject({
      compatible: false,
      code: "protocol_minor_downgrade"
    });
  });
});

describe("RemoteBrowserContextV1Schema", () => {
  const validContext = {
    version: 1,
    gatewayLaunchId,
    browserSessionId,
    requestNonce,
    method: "POST",
    canonicalTarget: "/api/waifus?id=one&id=two&name=hello%20world",
    csrfValidated: true
  };

  it("accepts only the exact strict V1 browser context", () => {
    expect(RemoteBrowserContextV1Schema.parse(validContext)).toEqual(validContext);
    expect(RemoteBrowserContextV1Schema.safeParse({ ...validContext, helperMac: "forged" }).success).toBe(false);
    expect(RemoteBrowserContextV1Schema.safeParse({ ...validContext, csrfValidated: false }).success).toBe(false);
    expect(RemoteBrowserContextV1Schema.safeParse({ ...validContext, method: "post" }).success).toBe(false);
  });

  it.each([
    "https://evil.test/api",
    "//evil.test/api",
    "/api/../secrets",
    "/api/./secrets",
    "/api/%2E%2E/secrets",
    "/api/%2Fadmin",
    "/api/%5Cadmin",
    "/api/%41",
    "/api/%2fadmin",
    "/api/%ZZ",
    "/api\\admin",
    "/api#fragment",
    "/api path",
    "/api/雪"
  ])("rejects a noncanonical concrete target %s", (canonicalTarget) => {
    expect(RemoteBrowserContextV1Schema.safeParse({ ...validContext, canonicalTarget }).success).toBe(false);
  });

  it("enforces exact byte widths and the target size ceiling", () => {
    expect(gatewayLaunchId).toHaveLength(43);
    expect(requestNonce).toHaveLength(22);
    expect(RemoteBrowserContextV1Schema.safeParse({
      ...validContext,
      gatewayLaunchId: `${gatewayLaunchId}=`
    }).success).toBe(false);
    expect(RemoteBrowserContextV1Schema.safeParse({
      ...validContext,
      requestNonce: Buffer.alloc(15).toString("base64url")
    }).success).toBe(false);
    expect(RemoteBrowserContextV1Schema.safeParse({
      ...validContext,
      canonicalTarget: `/${"a".repeat(2_048)}`
    }).success).toBe(false);
  });
});

describe("checked-in remote protocol contract", () => {
  it("is derived byte-for-byte from the TypeScript schemas", async () => {
    const contractRoot = path.join(process.cwd(), "contracts", "remote", "v1");
    const [protocolSchema, capabilities] = await Promise.all([
      readFile(path.join(contractRoot, "protocol.schema.json"), "utf8"),
      readFile(path.join(contractRoot, "capabilities.json"), "utf8")
    ]);

    expect(protocolSchema).toBe(serializeRemoteContractJson(createRemoteProtocolJsonSchema()));
    expect(capabilities).toBe(serializeRemoteContractJson(createRemoteCapabilitiesDocument()));
  });

  it("publishes the strict browser context and staging-purpose constraint", () => {
    const schema = createRemoteProtocolJsonSchema() as {
      $defs: Record<string, Record<string, unknown>>;
    };
    expect(schema.$defs.RemoteBrowserContextV1).toMatchObject({
      type: "object",
      additionalProperties: false
    });
    expect(schema.$defs.CanonicalTarget).toMatchObject({
      format: "waifus-origin-form-target-v1",
      maxLength: 2_048
    });
    expect(schema.$defs.ComponentHello).toHaveProperty("allOf");
  });
});
