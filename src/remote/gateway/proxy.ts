import type { OutgoingHttpHeaders } from "node:http";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  ClientContextV1Schema,
  type ClientContextV1
} from "../../shared/schemas/remoteLifecycle.js";
import type { RemoteBrowserContextV1 } from "../../shared/schemas/remoteProtocol.js";
import type { DashboardRemoteClient } from "../dashboardDownloader.js";
import type { HelperRemoteResponse } from "../helperTypes.js";
import {
  RemoteGatewayHeaderError,
  sanitizeGatewayRequestHeaders,
  sanitizeGatewayResponseHeaders
} from "./headerPolicy.js";
import type { RemoteGatewayHandlerSecurity } from "./server.js";

export type RemoteSelectedHostProxyOptions = {
  readonly client: DashboardRemoteClient;
  readonly selectedHostId: string;
  readonly connectionShellOrigin: string;
  readonly localOrigin: string;
  readonly connectionState: () => "direct" | "reconnecting" | "direct_unavailable";
  readonly upstreamOrigins?: ReadonlySet<string>;
};

export class RemoteSelectedHostProxy {
  readonly #options: RemoteSelectedHostProxyOptions;

  constructor(options: RemoteSelectedHostProxyOptions) {
    this.#options = options;
  }

  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
    browserContext: RemoteBrowserContextV1,
    security: RemoteGatewayHandlerSecurity
  ): Promise<unknown> {
    if (browserContext.canonicalTarget === "/api/client-context" && request.method === "GET") {
      security.deliverCsrf();
      reply.header("cache-control", "no-store");
      return ClientContextV1Schema.parse({
        mode: "remote",
        selectedHostId: this.#options.selectedHostId,
        connectionState: this.#options.connectionState(),
        connectionShellOrigin: this.#options.connectionShellOrigin
      }) satisfies ClientContextV1;
    }
    if (
      browserContext.canonicalTarget !== "/api"
      && !browserContext.canonicalTarget.startsWith("/api/")
      && !browserContext.canonicalTarget.startsWith("/api?")
    ) {
      return reply.code(404).send({ error: "NotFound" });
    }

    let requestHeaders;
    try {
      requestHeaders = sanitizeGatewayRequestHeaders(request.headers);
    } catch (error) {
      if (error instanceof RemoteGatewayHeaderError) {
        return reply.code(400).send({ error: "InvalidRequest" });
      }
      throw error;
    }

    const controller = new AbortController();
    const abort = () => controller.abort(new Error("Remote browser request disconnected."));
    request.raw.once("aborted", abort);
    const body = request.body instanceof Readable ? request.body : undefined;
    let response: HelperRemoteResponse | undefined;
    let responseCancelled = false;
    const cancelResponse = (reason: unknown) => {
      if (!response || responseCancelled || response.body.readableEnded) return;
      responseCancelled = true;
      response.cancel(reason);
    };
    try {
      const remoteResponse = await this.#options.client.request({
        method: browserContext.method,
        canonicalTarget: browserContext.canonicalTarget,
        headers: requestHeaders,
        browserContext,
        ...(body ? { body } : {}),
        signal: controller.signal
      });
      response = remoteResponse;
      const headers = sanitizeGatewayResponseHeaders(remoteResponse.headers, {
        localOrigin: this.#options.localOrigin,
        upstreamOrigins: this.#options.upstreamOrigins
      });
      headers["cache-control"] = "no-store";
      for (const [name, value] of Object.entries(security.responseSecurityHeaders)) {
        headers[name] = value;
      }
      const sessionCookie = reply.getHeader("set-cookie");
      if (sessionCookie !== undefined) {
        headers["set-cookie"] = Array.isArray(sessionCookie)
          ? sessionCookie.map(String)
          : String(sessionCookie);
      }
      reply.hijack();
      reply.raw.writeHead(
        remoteResponse.statusCode,
        remoteResponse.statusMessage,
        headers as OutgoingHttpHeaders
      );
      let completed = false;
      remoteResponse.body.once("end", () => { completed = true; });
      const cancel = () => {
        if (!completed) cancelResponse(new Error("Remote browser response disconnected."));
      };
      reply.raw.once("close", cancel);
      try {
        if (request.method === "HEAD") {
          remoteResponse.body.resume();
          await new Promise<void>((resolve, reject) => {
            remoteResponse.body.once("end", resolve);
            remoteResponse.body.once("error", reject);
          });
          reply.raw.end();
        } else {
          await pipeline(remoteResponse.body, reply.raw);
        }
        completed = true;
      } finally {
        reply.raw.removeListener("close", cancel);
      }
      return;
    } catch (error) {
      cancelResponse(error);
      if (reply.sent || reply.raw.headersSent) {
        reply.raw.destroy();
        return;
      }
      return reply.code(503).send({ error: "DirectUnavailable" });
    } finally {
      request.raw.removeListener("aborted", abort);
    }
  }
}
