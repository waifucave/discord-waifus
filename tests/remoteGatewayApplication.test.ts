import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureRemoteOnlyLayout } from "../src/config/layout.js";
import {
  startRemoteGatewayApplication,
  type RunningRemoteGatewayApplication
} from "../src/remote/gateway/application.js";
import { derivePinnedHostId } from "../src/remote/gateway/originStore.js";
import {
  RememberedHostStore,
  type RememberedHostRecordV1
} from "../src/remote/rememberedHosts.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const applications: RunningRemoteGatewayApplication[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

function host(value: number): RememberedHostRecordV1 {
  const publicKey = Buffer.alloc(32, value).toString("base64url");
  return {
    version: 1,
    hostId: derivePinnedHostId(Buffer.from(publicKey, "base64url")),
    helperPairId: Buffer.alloc(16, value).toString("base64url"),
    displayName: `Host ${value}`,
    platform: { os: "darwin", arch: "arm64" },
    installationPublicKey: publicKey,
    installationFingerprint: Buffer.alloc(16, value).toString("base64url"),
    trustEpoch: "1",
    revision: "1",
    pairedAt: "1786270800",
    lastSeenAt: null,
    lastDirectAt: null,
    connectionState: "offline",
    lastErrorCode: null
  } as RememberedHostRecordV1;
}

function request(port: number, path: string, headers: Record<string, string>, body?: unknown): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method: encoded === undefined ? "GET" : "POST",
      headers: {
        ...headers,
        ...(encoded === undefined ? {} : {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(encoded))
        })
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    outgoing.once("error", reject);
    if (encoded !== undefined) outgoing.write(encoded);
    outgoing.end();
  });
}

describe("remote gateway application", () => {
  it("keeps the shell separate and closes the old selected origin on host switch", async () => {
    const root = await makeTempRoot("waifus-remote-application-");
    roots.push(root);
    await ensureRemoteOnlyLayout(root);
    const first = host(0x31);
    const second = host(0x32);
    const hosts = new RememberedHostStore(root);
    await hosts.upsert(first);
    await hosts.upsert(second);

    let directState = "inactive";
    const selectedPairs: string[] = [];
    const supervisor = {
      snapshot: () => ({
        state: "ready",
        helperVersion: "0.1.0",
        releaseSequence: "1",
        target: { os: "darwin", arch: "arm64" },
        protocol: { major: 1, minor: 0 },
        capabilities: ["waifus.http.v1"],
        runtimeStatus: {
          activationState: "active",
          controlState: "connected",
          directState,
          lastDirectAt: null,
          lastErrorCode: null
        },
        lastErrorCode: null
      }),
      startRuntime: vi.fn(async (pairId: string) => {
        selectedPairs.push(pairId);
        directState = "direct";
      }),
      stopRuntime: vi.fn(async () => { directState = "inactive"; }),
      registerGatewayLaunch: vi.fn(async () => undefined),
      request: vi.fn(async () => { throw new Error("Not expected in this test."); })
    };
    const application = await startRemoteGatewayApplication({
      dataRoot: root,
      appVersion: "1.5.203",
      deviceDisplayName: "Remote device",
      supervisor: supervisor as never
    });
    applications.push(application);
    expect(application.shell.hostname).toMatch(/^waifus-[a-z2-7]{52}\.localhost$/u);

    const shellAuthority = `${application.shell.hostname}:${application.shell.port}`;
    const bootstrap = await request(
      application.shell.port,
      new URL(application.shell.bootstrapUrl).pathname,
      { host: shellAuthority, "sec-fetch-site": "none" }
    );
    expect(bootstrap.status).toBe(303);
    const cookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0];
    const headers = {
      host: shellAuthority,
      origin: application.shell.origin,
      "sec-fetch-site": "same-origin",
      cookie
    };
    const context = await request(
      application.shell.port,
      "/_waifus_remote/v1/bootstrap",
      headers
    );
    expect(context.status).toBe(200);
    const csrf = String(context.headers["x-waifus-csrf"]);

    const connect = async (record: RememberedHostRecordV1) => request(
      application.shell.port,
      `/_waifus_remote/v1/hosts/${record.hostId}/connect`,
      { ...headers, "x-waifus-csrf": csrf },
      {}
    );
    const open = async (record: RememberedHostRecordV1) => request(
      application.shell.port,
      `/_waifus_remote/open/${record.hostId}`,
      headers
    );

    expect((await connect(first)).status).toBe(202);
    const firstOpen = await open(first);
    expect(firstOpen.status).toBe(303);
    const firstFrame = new URL(String(firstOpen.headers.location));
    expect(firstFrame.hostname).not.toBe(application.shell.hostname);
    expect(supervisor.registerGatewayLaunch).toHaveBeenCalledTimes(1);
    const simultaneousOpens = await Promise.all([open(first), open(first)]);
    expect(simultaneousOpens.map((response) => response.status)).toEqual([303, 303]);
    expect(simultaneousOpens.map((response) => new URL(String(response.headers.location)).origin))
      .toEqual([firstFrame.origin, firstFrame.origin]);
    expect(supervisor.registerGatewayLaunch).toHaveBeenCalledTimes(1);

    expect((await connect(second)).status).toBe(202);
    expect(selectedPairs).toEqual([first.helperPairId, second.helperPairId]);
    await expect(request(
      Number(firstFrame.port),
      "/_waifus_remote/session-ready",
      { host: firstFrame.host, "sec-fetch-site": "none" }
    )).rejects.toThrow();

    const secondOpen = await open(second);
    expect(secondOpen.status).toBe(303);
    const secondFrame = new URL(String(secondOpen.headers.location));
    expect(secondFrame.origin).not.toBe(firstFrame.origin);
    expect(supervisor.registerGatewayLaunch).toHaveBeenCalledTimes(2);
  });
});
