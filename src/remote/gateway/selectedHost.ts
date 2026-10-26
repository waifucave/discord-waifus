import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  RemoteBrowserContextV1Schema,
  type HttpMethod,
  type RemoteBrowserContextV1
} from "../../shared/schemas/remoteProtocol.js";
import {
  DashboardCache,
  type DashboardCacheHostKey,
  type VerifiedDashboardBuild
} from "../dashboardCache.js";
import {
  DashboardDownloader,
  type DashboardRemoteClient
} from "../dashboardDownloader.js";
import { RemoteSelectedHostProxy } from "./proxy.js";
import type { RemoteGatewayHandlerSecurity } from "./server.js";
import { BROWSER_RECOVERY_SCRIPT, recoveryTag, waitingDashboard } from "./browserRecovery.js";

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

function acceptsHtml(request: FastifyRequest): boolean {
  return String(request.headers.accept ?? "")
    .split(",")
    .some((part) => part.split(";", 1)[0].trim().toLowerCase() === "text/html");
}

function isSpaRoute(pathname: string): boolean {
  const finalSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !pathname.startsWith("/assets/") && !finalSegment.includes(".");
}

export type RemoteSelectedHostGatewayOptions = {
  readonly cache: DashboardCache;
  readonly client: DashboardRemoteClient;
  readonly hostKey: DashboardCacheHostKey;
  readonly remoteGatewayVersion: string;
  readonly connectionShellOrigin: string;
  readonly localOrigin: string;
  readonly connectionState: () => "direct" | "reconnecting" | "direct_unavailable";
  readonly upstreamOrigins?: ReadonlySet<string>;
  readonly randomBytes?: (size: number) => Uint8Array;
};

export class RemoteSelectedHostGateway {
  readonly #options: RemoteSelectedHostGatewayOptions;
  readonly #proxy: RemoteSelectedHostProxy;
  readonly #randomBytes: (size: number) => Uint8Array;
  #build: VerifiedDashboardBuild | undefined;
  #buildPromise: Promise<VerifiedDashboardBuild> | undefined;

  constructor(options: RemoteSelectedHostGatewayOptions) {
    this.#options = options;
    this.#randomBytes = options.randomBytes ?? randomBytes;
    this.#proxy = new RemoteSelectedHostProxy({
      client: options.client,
      selectedHostId: options.hostKey.hostId,
      connectionShellOrigin: options.connectionShellOrigin,
      localOrigin: options.localOrigin,
      connectionState: options.connectionState,
      upstreamOrigins: options.upstreamOrigins
    });
  }

  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
    browserContext: RemoteBrowserContextV1,
    security: RemoteGatewayHandlerSecurity
  ): Promise<unknown> {
    const target = browserContext.canonicalTarget;
    if (browserContext.method === "GET" && target === "/_waifus_remote/resume-state") {
      return reply.header("cache-control", "no-store").send({ launch: browserContext.gatewayLaunchId,
        direct: this.#options.connectionState() === "direct" });
    }
    if (browserContext.method === "GET" && target === "/_waifus_remote/resume.js") {
      return reply.header("cache-control", "no-store").header("content-type", "application/javascript; charset=utf-8").send(BROWSER_RECOVERY_SCRIPT);
    }
    if (browserContext.method === "GET" && target === "/_waifus_remote/resume.css") {
      return reply.header("cache-control", "no-store").header("content-type", "text/css; charset=utf-8")
        .send('.remote-connection-banner[data-tone="ok"]{display:none}.waifus-recovery-notice{position:fixed;bottom:12px;right:12px;padding:10px;background:#fff;color:#111;border:1px solid #999;z-index:2147483647;font:14px system-ui}');
    }
    if (target === "/api" || target.startsWith("/api/") || target.startsWith("/api?")) {
      return this.#proxy.handle(request, reply, browserContext, security);
    }
    if (browserContext.method !== "GET" && browserContext.method !== "HEAD") {
      return reply.code(404).send({ error: "NotFound" });
    }
    const pathname = target.split("?", 1)[0];
    const requestedAssetPath = pathname === "/" || pathname === "/index.html"
      ? "index.html"
      : pathname.startsWith("/")
        ? pathname.slice(1)
        : "";
    if (requestedAssetPath.length === 0) return reply.code(404).send({ error: "NotFound" });

    const navigation = acceptsHtml(request) && isSpaRoute(pathname) && browserContext.method === "GET";
    if (navigation && !this.#build && this.#options.connectionState() !== "direct") {
      // Answer a page load at once: the download would wait out the direct timeout first.
      void this.#ensureBuild(browserContext).catch(() => undefined);
      return reply.header("cache-control", "no-store").header("content-type", "text/html; charset=utf-8")
        .send(waitingDashboard(browserContext.gatewayLaunchId));
    }
    let build: VerifiedDashboardBuild;
    try {
      build = await this.#ensureBuild(browserContext);
    } catch {
      if (navigation) {
        return reply.header("cache-control", "no-store").header("content-type", "text/html; charset=utf-8")
          .send(waitingDashboard(browserContext.gatewayLaunchId));
      }
      return reply.code(503).send({ error: "DirectUnavailable" });
    }
    const assetPath = build.manifest.assets.some((asset) => asset.path === requestedAssetPath)
      ? requestedAssetPath
      : acceptsHtml(request) && isSpaRoute(pathname)
        ? "index.html"
        : requestedAssetPath;
    let verified;
    try {
      verified = await this.#options.cache.readVerifiedAsset(
        this.#options.hostKey,
        build.manifest,
        assetPath
      );
    } catch {
      return reply.code(503).send({ error: "DashboardUnavailable" });
    }
    if (!verified) return reply.code(404).send({ error: "NotFound" });

    reply.header("content-type", verified.asset.contentType);
    reply.header("content-length", verified.asset.byteSize);
    if (verified.asset.path === "index.html") {
      reply.header("cache-control", "no-store");
    } else {
      reply.header("cache-control", IMMUTABLE_CACHE_CONTROL);
      reply.header("etag", `"${verified.asset.sha256}"`);
    }
    if (browserContext.method === "HEAD") return reply.send();
    if (verified.asset.path === "index.html") {
      reply.removeHeader("content-length");
      const html = verified.body.toString("utf8");
      const tag = recoveryTag(browserContext.gatewayLaunchId);
      return reply.send(/<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${tag}</head>`) : tag + html);
    }
    return reply.send(verified.body);
  }

  async #ensureBuild(seed: RemoteBrowserContextV1): Promise<VerifiedDashboardBuild> {
    if (this.#build) return this.#build;
    if (!this.#buildPromise) {
      const downloader = new DashboardDownloader({
        cache: this.#options.cache,
        client: this.#options.client,
        remoteGatewayVersion: this.#options.remoteGatewayVersion,
        createBrowserContext: (method, canonicalTarget) => this.#downloadContext(
          seed,
          method,
          canonicalTarget
        )
      });
      const operation = downloader.download(this.#options.hostKey).then((build) => {
        this.#build = build;
        return build;
      });
      this.#buildPromise = operation;
      void operation.finally(() => {
        if (this.#buildPromise === operation) this.#buildPromise = undefined;
      }).catch(() => undefined);
    }
    return this.#buildPromise;
  }

  #downloadContext(
    seed: RemoteBrowserContextV1,
    method: HttpMethod,
    canonicalTarget: string
  ): RemoteBrowserContextV1 {
    const nonceBytes = Buffer.from(this.#randomBytes(16));
    if (nonceBytes.byteLength !== 16) {
      nonceBytes.fill(0);
      throw new Error("Remote dashboard request entropy is invalid.");
    }
    const requestNonce = nonceBytes.toString("base64url");
    nonceBytes.fill(0);
    return RemoteBrowserContextV1Schema.parse({
      version: 1,
      gatewayLaunchId: seed.gatewayLaunchId,
      browserSessionId: seed.browserSessionId,
      requestNonce,
      method,
      canonicalTarget,
      csrfValidated: true
    });
  }
}
