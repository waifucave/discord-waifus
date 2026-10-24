// `GET /api/help` and `GET /api/help/:topic` (overhaul spec §10.4, Living cast §14.2): static help
// from the settings registry, the CLI command table and the route help. `?format=md` (or
// `Accept: text/markdown`) answers Markdown; an unknown topic is a 404 with suggestions.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readPackageVersion } from "../config/layout.js";
import { COMMANDS } from "../shared/settings/commands.js";
import { RESOURCE_TOPICS, SETTING_GROUPS } from "../shared/settings/registry.js";
import { targetExample, topicJson, topicMarkdown } from "../shared/settings/render.js";
import { resolveTopic, suggestTopics } from "../shared/settings/topics.js";
import { ApiError } from "./errors.js";
import { ROUTE_HELP, routeSummary } from "./routeHelp.js";
import { ROUTE_POLICY_MANIFEST } from "./routePolicyManifest.js";

function wantsMarkdown(query: unknown, accept: string | undefined): boolean {
  const format = (query as Record<string, unknown> | undefined)?.["format"];
  return format === "md" || format === "markdown" || (typeof accept === "string" && accept.includes("text/markdown"));
}

export function helpIndex(appVersion: string) {
  return {
    version: 1 as const,
    appVersion,
    groups: SETTING_GROUPS.map((group) => ({ id: group.id, title: group.title, summary: group.summary, target: targetExample(group), cli: `waifus help ${group.id}` })),
    resources: RESOURCE_TOPICS.map((topic) => ({ id: topic.id, title: topic.title, summary: topic.summary, cli: topic.cli })),
    routes: ROUTE_POLICY_MANIFEST.filter((route) => !route.synthetic).map((route) => {
      const help = ROUTE_HELP[`${route.method} ${route.path}`];
      return {
        method: String(route.method),
        path: route.path,
        summary: help?.summary ?? "",
        topic: help?.topic ?? "",
        remote: route.remotePolicy,
        retryClass: route.method === "GET" ? "safe" : (route.retryClass ?? "safe")
      };
    }),
    commands: COMMANDS.map((command) => ({ name: command.name, summary: command.summary, usage: command.usage }))
  };
}

export function registerHelpRoutes(app: FastifyInstance): void {
  app.get("/api/help", async (request, reply) => {
    if (wantsMarkdown(request.query, request.headers.accept)) {
      return reply.type("text/markdown; charset=utf-8").send(topicMarkdown({ kind: "index" }, routeSummary));
    }
    return helpIndex(await readPackageVersion());
  });

  app.get("/api/help/:topic", async (request, reply) => {
    const { topic } = z.object({ topic: z.string().min(1).max(200) }).parse(request.params);
    const resolved = resolveTopic(topic);
    if (!resolved) {
      throw new ApiError(404, `No help topic "${topic}". Try GET /api/help for the list.`, { suggestions: suggestTopics(topic) }, "NotFound");
    }
    if (wantsMarkdown(request.query, request.headers.accept)) {
      return reply.type("text/markdown; charset=utf-8").send(topicMarkdown(resolved, routeSummary));
    }
    if (resolved.kind === "index") return helpIndex(await readPackageVersion());
    return topicJson(resolved, routeSummary);
  });
}
