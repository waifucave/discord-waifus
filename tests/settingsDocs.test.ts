// The generated KB pages (overhaul spec §10.7) stay in sync with the settings registry and the route
// help: `npm run docs:settings:generate` rewrites them.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generatedSettingsDocs, routeTableMarkdown } from "../src/api/settingsDocs.js";
import { ROUTE_POLICY_MANIFEST } from "../src/api/routePolicyManifest.js";
import { allKeyInfos } from "../src/shared/settings/introspect.js";

const read = (relative: string) => readFile(path.join(process.cwd(), relative), "utf8");

describe("generated settings docs", () => {
  it("docs/assistant-kb/settings.md and the api.md endpoint table are up to date", async () => {
    for (const file of await generatedSettingsDocs(read)) {
      expect(await read(file.path), `${file.path} is stale: run npm run docs:settings:generate`).toBe(file.content);
    }
  });

  it("the settings page names every key, and the endpoint table every API route", async () => {
    const settings = await read("docs/assistant-kb/settings.md");
    for (const info of allKeyInfos()) expect(settings, info.id).toContain(`\`${info.path}\``);
    const table = routeTableMarkdown();
    for (const route of ROUTE_POLICY_MANIFEST.filter((entry) => entry.path.startsWith("/api/"))) expect(table, route.path).toContain(`| ${route.method} | \`${route.path}\` |`);
  });
});
