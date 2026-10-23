#!/usr/bin/env node
// Dev-only: overlay a locally built sibling @waifucave/gateway checkout onto node_modules so the
// app can be developed against an unpublished gateway version (Phase 4 uses 0.4.0 before it is on
// npm). Copies the gateway's dist/, data/ and package.json into node_modules/@waifucave/gateway.
// package.json / package-lock.json are never touched; `npm ci` restores the pinned registry copy.
//
// Gateway lookup: $WAIFUS_GATEWAY_DIR, else walk up from this script's real path looking for a
// `discord-waifus/gateway` or sibling `gateway` directory whose package.json is @waifucave/gateway
// (git worktrees live at app/.claude/worktrees/<name>, so the sibling is several levels up).
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GATEWAY_PACKAGE = "@waifucave/gateway";
const scriptDir = path.dirname(realpathSync(fileURLToPath(import.meta.url)));
const appRoot = path.resolve(scriptDir, "..");

function isGatewayDir(dir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    return pkg.name === GATEWAY_PACKAGE;
  } catch {
    return false;
  }
}

function findGatewayDir() {
  const fromEnv = process.env.WAIFUS_GATEWAY_DIR;
  if (fromEnv) {
    const dir = path.resolve(fromEnv);
    if (!isGatewayDir(dir)) {
      throw new Error(`WAIFUS_GATEWAY_DIR=${dir} does not contain a ${GATEWAY_PACKAGE} package.json.`);
    }
    return dir;
  }
  for (let current = scriptDir; ; current = path.dirname(current)) {
    for (const candidate of [path.join(current, "discord-waifus", "gateway"), path.join(current, "gateway")]) {
      if (isGatewayDir(candidate)) return candidate;
    }
    if (path.dirname(current) === current) break;
  }
  throw new Error(
    `Could not find a ${GATEWAY_PACKAGE} checkout next to this app. Set WAIFUS_GATEWAY_DIR to its path.`
  );
}

function main() {
  const source = findGatewayDir();
  if (!existsSync(path.join(source, "dist", "index.js"))) {
    throw new Error(`${source}/dist is missing: run "npm run build" in the gateway first.`);
  }
  const target = path.join(appRoot, "node_modules", "@waifucave", "gateway");
  mkdirSync(target, { recursive: true });
  for (const entry of ["dist", "data"]) {
    rmSync(path.join(target, entry), { recursive: true, force: true });
    if (existsSync(path.join(source, entry))) {
      cpSync(path.join(source, entry), path.join(target, entry), { recursive: true });
    }
  }
  cpSync(path.join(source, "package.json"), path.join(target, "package.json"));
  const version = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8")).version;
  console.log(`Linked local ${GATEWAY_PACKAGE}@${version} from ${source}`);
  console.log("Run `npm ci` to restore the pinned registry copy before committing lock changes.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
