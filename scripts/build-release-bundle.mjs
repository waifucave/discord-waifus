#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const APP_RELEASE_ASSET_NAME = "discord-waifus-app.tar.gz";
const APP_RELEASE_CHECKSUM_ASSET_NAME = "discord-waifus-app.sha256";

async function main() {
  const rootDir = process.cwd();
  const options = parseArgs(process.argv.slice(2));
  if (!options.version) {
    throw new Error("Missing required flag: --version <app-version>");
  }

  const outDir = path.resolve(rootDir, options.outDir);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "discord-waifus-release-"));
  const bundleRoot = path.join(tempRoot, "Discord-Waifus");

  try {
    await run("pnpm", ["--filter", "backend", "build"], rootDir);
    await run("pnpm", ["--filter", "dashboard", "build"], rootDir);
    await fs.mkdir(bundleRoot, { recursive: true });

    const rootPackage = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
    const backendPackage = JSON.parse(await fs.readFile(path.join(rootDir, "packages", "backend", "package.json"), "utf8"));
    const dashboardPackage = JSON.parse(await fs.readFile(path.join(rootDir, "packages", "dashboard", "package.json"), "utf8"));

    await writeJson(path.join(bundleRoot, "package.json"), {
      name: rootPackage.name,
      private: true,
      packageManager: rootPackage.packageManager,
      repository: rootPackage.repository,
      homepage: rootPackage.homepage,
      bugs: rootPackage.bugs
    });
    await fs.writeFile(
      path.join(bundleRoot, "pnpm-workspace.yaml"),
      "packages:\n  - packages/backend\n  - packages/dashboard\n"
    );
    await fs.copyFile(path.join(rootDir, "README.md"), path.join(bundleRoot, "README.md"));
    await writeJson(path.join(bundleRoot, ".waifus-release.json"), {
      formatVersion: 1,
      bundleVersion: options.version,
      sourceCommit: await resolveGitCommit(rootDir),
      generatedAt: new Date().toISOString(),
      repository: extractRepositoryUrl(rootPackage.repository),
      assetName: APP_RELEASE_ASSET_NAME
    });

    await fs.cp(path.join(rootDir, "defaults"), path.join(bundleRoot, "defaults"), { recursive: true });
    await fs.mkdir(path.join(bundleRoot, "packages", "backend"), { recursive: true });
    await fs.mkdir(path.join(bundleRoot, "packages", "dashboard"), { recursive: true });

    await writeJson(path.join(bundleRoot, "packages", "backend", "package.json"), {
      name: backendPackage.name,
      private: true,
      type: backendPackage.type,
      scripts: {
        start: backendPackage.scripts.start
      },
      dependencies: backendPackage.dependencies
    });
    await fs.cp(
      path.join(rootDir, "packages", "backend", "dist"),
      path.join(bundleRoot, "packages", "backend", "dist"),
      { recursive: true }
    );

    await writeJson(path.join(bundleRoot, "packages", "dashboard", "package.json"), {
      name: dashboardPackage.name,
      private: true,
      scripts: {
        start: dashboardPackage.scripts.start
      },
      dependencies: dashboardPackage.dependencies
    });
    await fs.copyFile(
      path.join(rootDir, "packages", "dashboard", "next.config.js"),
      path.join(bundleRoot, "packages", "dashboard", "next.config.js")
    );
    await fs.cp(
      path.join(rootDir, "packages", "dashboard", ".next"),
      path.join(bundleRoot, "packages", "dashboard", ".next"),
      { recursive: true }
    );

    await run("pnpm", ["install", "--prod", "--lockfile-only", "--ignore-scripts"], bundleRoot);

    await fs.mkdir(outDir, { recursive: true });
    const tarballPath = path.join(outDir, APP_RELEASE_ASSET_NAME);
    const checksumPath = path.join(outDir, APP_RELEASE_CHECKSUM_ASSET_NAME);

    await fs.rm(tarballPath, { force: true });
    await fs.rm(checksumPath, { force: true });
    await run("tar", ["-czf", tarballPath, "-C", tempRoot, "Discord-Waifus"], rootDir);

    const checksum = await sha256(tarballPath);
    await fs.writeFile(checksumPath, `${checksum}  ${APP_RELEASE_ASSET_NAME}\n`);

    console.log(`Release bundle written: ${tarballPath}`);
    console.log(`Checksum written: ${checksumPath}`);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = {
    version: "",
    outDir: "artifacts"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--version") {
      options.version = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (argument === "--out-dir") {
      options.outDir = argv[index + 1] ?? options.outDir;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

async function resolveGitCommit(cwd) {
  try {
    return (await capture("git", ["rev-parse", "HEAD"], cwd)).trim();
  } catch {
    return null;
  }
}

function extractRepositoryUrl(repository) {
  if (typeof repository === "string") {
    return repository;
  }
  if (repository && typeof repository === "object" && typeof repository.url === "string") {
    return repository.url;
  }
  return null;
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function sha256(filePath) {
  const buffer = await fs.readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited due to signal ${signal}`));
        return;
      }
      if (code && code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function capture(command, args, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited due to signal ${signal}`));
        return;
      }
      if (code && code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
