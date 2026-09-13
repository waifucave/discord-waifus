import type { Readable } from "node:stream";
import {
  compareSemVer,
  type DashboardAsset
} from "../shared/schemas/remoteAccess.js";
import {
  RemoteBrowserContextV1Schema,
  SemVerSchema,
  type ComponentHello,
  type HttpMethod,
  type ProtocolVersion,
  type RemoteBrowserContextV1
} from "../shared/schemas/remoteProtocol.js";
import {
  DASHBOARD_MANIFEST_MAX_BYTES,
  parseDashboardManifestBytes
} from "./dashboardManifest.js";
import type {
  DashboardCache,
  DashboardCacheHostKey,
  VerifiedDashboardBuild
} from "./dashboardCache.js";
import type {
  HelperRemoteRequest,
  HelperRemoteResponse
} from "./helperTypes.js";

const DASHBOARD_MANIFEST_TARGET = "/api/remote-access/dashboard-manifest";

export type DashboardRemoteClient = {
  readonly hello: Pick<ComponentHello, "componentVersion">;
  readonly negotiatedProtocol: ProtocolVersion;
  readonly negotiatedCapabilities: readonly string[];
  request: (input: HelperRemoteRequest) => Promise<HelperRemoteResponse>;
};

export type DashboardDownloaderOptions = {
  readonly cache: DashboardCache;
  readonly client: DashboardRemoteClient;
  readonly remoteGatewayVersion: string;
  readonly createBrowserContext: (
    method: HttpMethod,
    canonicalTarget: string
  ) => RemoteBrowserContextV1;
};

export type DashboardDownloaderErrorCode =
  | "dashboard_manifest_response_invalid"
  | "dashboard_asset_response_invalid"
  | "dashboard_component_incompatible";

export class DashboardDownloaderError extends Error {
  constructor(
    readonly code: DashboardDownloaderErrorCode,
    detail: string
  ) {
    super(`${code}: ${detail}`);
    this.name = "DashboardDownloaderError";
  }
}

function fail(code: DashboardDownloaderErrorCode, detail: string): never {
  throw new DashboardDownloaderError(code, detail);
}

function singleHeader(
  response: HelperRemoteResponse,
  name: string,
  code: DashboardDownloaderErrorCode
): string {
  const values = response.headers
    .filter(([headerName]) => headerName.toLowerCase() === name)
    .map(([, value]) => value);
  if (values.length !== 1) {
    return fail(code, `Host response requires one ${name} header.`);
  }
  return values[0];
}

function contentLength(
  response: HelperRemoteResponse,
  maximum: number,
  code: DashboardDownloaderErrorCode
): number {
  const value = singleHeader(response, "content-length", code);
  if (!/^[1-9][0-9]*$/u.test(value)) {
    return fail(code, "Host response content length is not canonical.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    return fail(code, "Host response content length exceeds its declared limit.");
  }
  return parsed;
}

async function readBounded(
  body: Readable,
  expectedBytes: number,
  code: DashboardDownloaderErrorCode
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of body) {
    if (!(value instanceof Uint8Array)) {
      return fail(code, "Host response body emitted a non-byte chunk.");
    }
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (total > expectedBytes) {
      return fail(code, "Host response body exceeded its declared content length.");
    }
    chunks.push(chunk);
  }
  if (total !== expectedBytes) {
    return fail(code, "Host response body length differs from its header.");
  }
  return Buffer.concat(chunks, total);
}

export class DashboardDownloader {
  readonly #cache: DashboardCache;
  readonly #client: DashboardRemoteClient;
  readonly #remoteGatewayVersion: string;
  readonly #createBrowserContext: DashboardDownloaderOptions["createBrowserContext"];

  constructor(options: DashboardDownloaderOptions) {
    this.#cache = options.cache;
    this.#client = options.client;
    this.#remoteGatewayVersion = SemVerSchema.parse(options.remoteGatewayVersion);
    this.#createBrowserContext = options.createBrowserContext;
  }

  async download(
    hostKey: DashboardCacheHostKey,
    options: { signal?: AbortSignal } = {}
  ): Promise<VerifiedDashboardBuild> {
    const manifestResponse = await this.#request(
      DASHBOARD_MANIFEST_TARGET,
      "application/json",
      options.signal
    );
    try {
      this.#requireSuccess(manifestResponse, "dashboard_manifest_response_invalid");
      if (
        singleHeader(
          manifestResponse,
          "content-type",
          "dashboard_manifest_response_invalid"
        ) !== "application/json; charset=utf-8"
      ) {
        return fail(
          "dashboard_manifest_response_invalid",
          "Host dashboard manifest has the wrong content type."
        );
      }
      const length = contentLength(
        manifestResponse,
        DASHBOARD_MANIFEST_MAX_BYTES,
        "dashboard_manifest_response_invalid"
      );
      const bytes = await readBounded(
        manifestResponse.body,
        length,
        "dashboard_manifest_response_invalid"
      );
      const manifest = parseDashboardManifestBytes(bytes);
      this.#assertCompatible(manifest);
      return await this.#cache.install(
        hostKey,
        manifest,
        (asset, signal) => this.#readAsset(manifest.buildId, asset, signal),
        options
      );
    } catch (error) {
      if (!manifestResponse.body.readableEnded) manifestResponse.cancel(error);
      throw error;
    }
  }

  async #request(
    canonicalTarget: string,
    accept: string,
    signal?: AbortSignal
  ): Promise<HelperRemoteResponse> {
    const method = "GET" as const;
    return this.#client.request({
      method,
      canonicalTarget,
      headers: [["accept", accept]],
      browserContext: RemoteBrowserContextV1Schema.parse(
        this.#createBrowserContext(method, canonicalTarget)
      ),
      ...(signal ? { signal } : {})
    });
  }

  #requireSuccess(
    response: HelperRemoteResponse,
    code: DashboardDownloaderErrorCode
  ): void {
    if (response.statusCode !== 200) {
      return fail(code, "Host dashboard request did not return HTTP 200.");
    }
  }

  #assertCompatible(manifest: VerifiedDashboardBuild["manifest"]): void {
    if (
      manifest.transportVersion.major !== this.#client.negotiatedProtocol.major
      || compareSemVer(this.#client.hello.componentVersion, manifest.minimumHelperVersion) < 0
      || compareSemVer(this.#remoteGatewayVersion, manifest.minimumRemoteGatewayVersion) < 0
      || manifest.requiredCapabilities.some(
        (capability) => !this.#client.negotiatedCapabilities.includes(capability)
      )
    ) {
      return fail(
        "dashboard_component_incompatible",
        "Host dashboard requires a newer compatible remote connector."
      );
    }
  }

  async #readAsset(
    buildId: string,
    asset: DashboardAsset,
    signal?: AbortSignal
  ): Promise<{ readonly contentType: string; readonly body: Readable }> {
    const target = `/api/remote-access/dashboard-assets/${buildId}/${asset.path}`;
    const response = await this.#request(target, "*/*", signal);
    try {
      this.#requireSuccess(response, "dashboard_asset_response_invalid");
      if (
        singleHeader(response, "content-type", "dashboard_asset_response_invalid")
        !== asset.contentType
      ) {
        return fail(
          "dashboard_asset_response_invalid",
          "Host dashboard asset has the wrong content type."
        );
      }
      if (
        contentLength(response, Number(asset.byteSize), "dashboard_asset_response_invalid")
        !== Number(asset.byteSize)
      ) {
        return fail(
          "dashboard_asset_response_invalid",
          "Host dashboard asset length differs from its manifest."
        );
      }
      return { contentType: asset.contentType, body: response.body };
    } catch (error) {
      response.cancel(error);
      throw error;
    }
  }
}
