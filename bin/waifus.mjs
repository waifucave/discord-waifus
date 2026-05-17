#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiled = path.join(root, "dist", "cli", "main.js");
const source = path.join(root, "src", "cli", "main.ts");

if (existsSync(compiled)) {
  await import(pathToFileURL(compiled).href);
} else if (existsSync(source)) {
  const tsxBin = path.join(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx"
  );

  if (!existsSync(tsxBin)) {
    console.error(
      "waifus is not built yet and local tsx is missing. Run `npm install`, then `npm run build` or retry the command."
    );
    process.exit(1);
  }

  const result = spawnSync(tsxBin, [source, ...process.argv.slice(2)], {
    cwd: root,
    stdio: "inherit"
  });
  process.exit(result.status ?? 1);
} else {
  console.error("waifus CLI entrypoint is missing. Reinstall @starlight-ai/discord-waifus.");
  process.exit(1);
}
