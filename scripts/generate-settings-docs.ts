// Generated docs from the settings registry and the route help (overhaul spec §10.7, Living cast
// §14.2): `docs/assistant-kb/settings.md` (every setting, topic and command) and the endpoint table in
// `docs/assistant-kb/api.md` between the `generated:routes` markers. `--write` updates them,
// `--check` fails when they are stale (a test runs the same check).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatedSettingsDocs } from "../src/api/settingsDocs.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "--write" && mode !== "--check") throw new Error("Usage: generate-settings-docs.ts --write | --check");
  const files = await generatedSettingsDocs(async (relative) => readFile(path.join(ROOT, relative), "utf8"));
  const stale: string[] = [];
  for (const file of files) {
    const current = await readFile(path.join(ROOT, file.path), "utf8").catch(() => undefined);
    if (current === file.content) continue;
    if (mode === "--write") await writeFile(path.join(ROOT, file.path), file.content);
    else stale.push(file.path);
  }
  if (stale.length > 0) throw new Error(`Generated settings docs are stale: ${stale.join(", ")}. Run npm run docs:settings:generate.`);
  process.stdout.write(`${mode === "--write" ? "generated" : "verified"} ${files.map((file) => file.path).join(", ")}\n`);
}

await main();
