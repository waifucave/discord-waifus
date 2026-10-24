// The generated parts of the assistant's knowledge base (overhaul spec §10.7): the settings page,
// rendered from the settings registry, and the endpoint table of `api.md`, rendered from the route
// help. `scripts/generate-settings-docs.ts` writes them; `tests/settingsDocs.test.ts` keeps them in sync.

import { ROUTE_POLICY_MANIFEST } from "./routePolicyManifest.js";
import { routeSummary, ROUTE_HELP } from "./routeHelp.js";
import { settingsKbMarkdown } from "../shared/settings/render.js";

export const SETTINGS_KB_PATH = "docs/assistant-kb/settings.md";
export const API_KB_PATH = "docs/assistant-kb/api.md";
export const ROUTES_BEGIN = "<!-- generated:routes (npm run docs:settings:generate) -->";
export const ROUTES_END = "<!-- /generated:routes -->";

/** Every route of the policy manifest with its one-line help, grouped by path. */
export function routeTableMarkdown(): string {
  const rows = ROUTE_POLICY_MANIFEST.filter((route) => route.path.startsWith("/api/"))
    .map((route) => ({ method: route.method, path: route.path, key: `${route.method} ${route.path}` }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return [
    "| Method | Path | Purpose | Help topic |",
    "|---|---|---|---|",
    ...rows.map((row) => `| ${row.method} | \`${row.path}\` | ${(routeSummary({ method: row.method as never, path: row.path }) ?? "").replace(/\|/gu, "\\|")} | \`${ROUTE_HELP[row.key]?.topic ?? ""}\` |`)
  ].join("\n");
}

/** Replaces the marked block of `api.md` (the markers must exist). */
export function withRouteTable(apiMarkdown: string): string {
  const begin = apiMarkdown.indexOf(ROUTES_BEGIN);
  const end = apiMarkdown.indexOf(ROUTES_END);
  if (begin < 0 || end < begin) throw new Error(`${API_KB_PATH} lacks the generated:routes markers.`);
  return `${apiMarkdown.slice(0, begin + ROUTES_BEGIN.length)}\n\n${routeTableMarkdown()}\n\n${apiMarkdown.slice(end)}`;
}

export async function generatedSettingsDocs(read: (relativePath: string) => Promise<string>): Promise<Array<{ path: string; content: string }>> {
  return [
    { path: SETTINGS_KB_PATH, content: `${settingsKbMarkdown(routeSummary).trimEnd()}\n` },
    { path: API_KB_PATH, content: withRouteTable(await read(API_KB_PATH)) }
  ];
}
