#!/usr/bin/env node

import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawnSync } from "node:child_process";

const repo = "HeavenllyDemon/Discord-Waifus";
const rootPackage = "@starlight-ai/discord-waifus";
const npmCache = "/tmp/codex-npm-cache";
const ocrPackages = [
  "@starlight-ai/discord-waifus-ocr-darwin-arm64",
  "@starlight-ai/discord-waifus-ocr-darwin-x64",
  "@starlight-ai/discord-waifus-ocr-linux-x64-gnu",
  "@starlight-ai/discord-waifus-ocr-win32-x64",
];
const ocrPackageDirs = [
  "packages/ocr-darwin-arm64",
  "packages/ocr-darwin-x64",
  "packages/ocr-linux-x64-gnu",
  "packages/ocr-win32-x64",
];

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(`\nrelease failed: ${error.message}`);
  process.exit(1);
});

async function main() {
  if (args.help) {
    printUsage();
    return;
  }

  const version = args.version;
  if (!version || !isSemver(version)) {
    printUsage();
    throw new Error("Pass a valid SemVer version, for example 1.5.121.");
  }

  const tag = `v${version}`;
  const root = process.cwd();
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (pkg.name !== rootPackage) {
    throw new Error(`Run this from the Discord Waifus repo root; found package ${pkg.name}.`);
  }

  const branch = capture("git", ["branch", "--show-current"]).trim();
  if (branch !== "main") {
    throw new Error(`Release must run from main; current branch is ${branch || "(detached)"}.`);
  }

  const status = capture("git", ["status", "--short"]).trim();
  if (status) {
    console.log("Pending changes that will be included if validation passes:");
    console.log(status);
    console.log("");
  }

  const head = capture("git", ["rev-parse", "HEAD"]).trim();
  const remoteMain = capture("git", ["ls-remote", "origin", "refs/heads/main"]).trim().split(/\s+/)[0] ?? "";
  if (remoteMain !== head) {
    throw new Error(`Local HEAD ${head} does not match origin/main ${remoteMain}. Fetch/rebase before releasing.`);
  }

  ensureNoRemoteTag(tag);
  ensureNoRelease(tag);
  ensurePackageVersionMissing(rootPackage, version);
  for (const name of ocrPackages) {
    ensurePackageVersionMissing(name, version);
  }

  if (args.dryRun) {
    console.log(`Dry run passed. ${tag} can be released from ${head}.`);
    return;
  }

  bumpVersions(version);
  validateAndPack(version);

  await confirmOrExit(
    `Validation passed. Push main, create ${tag}, and publish npm packages?`,
    args.yes,
  );

  run("git", ["add", "."]);
  const staged = captureAllowFail("git", ["diff", "--cached", "--stat"]).stdout.trim();
  if (!staged) {
    throw new Error("Nothing staged after version bump and release preparation.");
  }
  console.log(staged);

  const commitMessage = args.message ?? `Release ${version}`;
  run("git", ["commit", "-m", commitMessage]);
  const releaseSha = capture("git", ["rev-parse", "HEAD"]).trim();
  run("git", ["push", "origin", "main"]);
  const pushedSha = capture("git", ["ls-remote", "origin", "refs/heads/main"]).trim().split(/\s+/)[0] ?? "";
  if (pushedSha !== releaseSha) {
    throw new Error(`Push verification failed; origin/main is ${pushedSha}, expected ${releaseSha}.`);
  }

  const tarball = `starlight-ai-discord-waifus-${version}.tgz`;
  run("gh", [
    "release",
    "create",
    tag,
    tarball,
    "--repo",
    repo,
    "--target",
    releaseSha,
    "--title",
    tag,
    "--notes",
    args.message ? `${args.message}\n\nRelease ${version}.` : `Release ${version}.`,
  ]);

  const ocrRunId = waitForWorkflowRun("OCR Packages", {
    headBranch: tag,
    event: "release",
  });
  run("gh", ["run", "watch", String(ocrRunId), "--repo", repo, "--exit-status"]);

  const rootWorkflowStartedAt = new Date();
  const workflowRun = run("gh", [
    "workflow",
    "run",
    "Root npm Package",
    "--repo",
    repo,
    "--ref",
    "main",
    "-f",
    `release_tag=${tag}`,
  ], { capture: true });
  const rootRunId =
    workflowRun.stdout.match(/actions\/runs\/(\d+)/)?.[1] ??
    waitForWorkflowRun("Root npm Package", {
      headBranch: "main",
      event: "workflow_dispatch",
      createdAfter: rootWorkflowStartedAt,
    });
  run("gh", ["run", "watch", String(rootRunId), "--repo", repo, "--exit-status"]);

  verifyRegistry(version);
  verifyRelease(tag, version, releaseSha);
  freshInstall(version);

  run("git", ["fetch", "origin", "main"]);
  const finalStatus = capture("git", ["status", "--short"]).trim();
  if (finalStatus) {
    throw new Error(`Release succeeded, but worktree is not clean:\n${finalStatus}`);
  }

  console.log(`\nReleased ${version}: https://github.com/${repo}/releases/tag/${tag}`);
}

function parseArgs(argv) {
  const parsed = {
    dryRun: false,
    help: false,
    message: undefined,
    version: undefined,
    yes: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--message" || arg === "-m") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a commit message.`);
      }
      parsed.message = normalizeCommitMessage(value);
      index += 1;
    } else if (arg.startsWith("--message=")) {
      parsed.message = normalizeCommitMessage(arg.slice("--message=".length));
    } else if (arg === "--yes" || arg === "-y") {
      parsed.yes = true;
    } else if (!parsed.version) {
      parsed.version = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return parsed;
}

function normalizeCommitMessage(value) {
  const message = value.trim();
  if (!message) {
    throw new Error("Commit message cannot be empty.");
  }
  if (message.includes("\n") || message.includes("\r")) {
    throw new Error("Commit message must be a single-line subject.");
  }
  return message;
}

function printUsage() {
  console.log(`Usage:
  npm run release:beta -- <version> [--yes] [--message "commit subject"]
  npm run release:beta -- <version> --dry-run

Examples:
  npm run release:beta -- 1.5.121
  npm run release:beta -- 1.5.121 --yes --message "fix: improve waifu reply targeting"

This beta script bumps versions, validates, packs, commits, pushes, creates the
GitHub release, watches OCR/root npm workflows, verifies npm latest, verifies
release assets, and smoke-installs from npm.`);
}

function isSemver(version) {
  return /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

function bumpVersions(version) {
  run("npm", ["version", version, "--no-git-tag-version"]);
  run("npm", [
    "pkg",
    "set",
    ...ocrPackages.map((name) => `optionalDependencies.${name}=${version}`),
  ]);
  for (const dir of ocrPackageDirs) {
    run("npm", ["pkg", "set", `version=${version}`, "--prefix", dir]);
  }
  run("npm", ["install", "--package-lock-only", "--ignore-scripts"]);
}

function validateAndPack(version) {
  run("npm", ["run", "typecheck"]);
  run("npm", ["test"]);
  run("npm", ["run", "build"]);
  run("npm", ["pack"], { npmCache: true });

  const prefix = mkdtempSync(join(tmpdir(), `waifus-smoke-${version}.`));
  run("npm", [
    "install",
    "--prefix",
    prefix,
    "--omit=optional",
    "-g",
    resolve(`starlight-ai-discord-waifus-${version}.tgz`),
  ], { npmCache: true });
  run(join(prefix, "bin/waifus"), ["help"]);
}

function verifyRegistry(version) {
  for (const name of [rootPackage, ...ocrPackages]) {
    const info = JSON.parse(capture("npm", ["view", name, "version", "dist-tags", "license", "--json"], { npmCache: true }));
    if (info.version !== version || info["dist-tags"]?.latest !== version) {
      throw new Error(`${name} registry verification failed: ${JSON.stringify(info)}`);
    }
  }
}

function verifyRelease(tag, version, expectedSha) {
  const release = JSON.parse(capture("gh", [
    "release",
    "view",
    tag,
    "--repo",
    repo,
    "--json",
    "tagName,targetCommitish,url,assets",
  ]));
  if (release.tagName !== tag || release.targetCommitish !== expectedSha) {
    throw new Error(`Release metadata verification failed: ${JSON.stringify(release)}`);
  }

  const expectedAssets = new Set([
    `starlight-ai-discord-waifus-${version}.tgz`,
    `starlight-ai-discord-waifus-ocr-darwin-arm64-${version}.tgz`,
    `starlight-ai-discord-waifus-ocr-darwin-x64-${version}.tgz`,
    `starlight-ai-discord-waifus-ocr-linux-x64-gnu-${version}.tgz`,
    `starlight-ai-discord-waifus-ocr-win32-x64-${version}.tgz`,
  ]);
  const actualAssets = new Set(release.assets.map((asset) => asset.name));
  for (const asset of expectedAssets) {
    if (!actualAssets.has(asset)) {
      throw new Error(`Missing release asset: ${asset}`);
    }
  }
}

function freshInstall(version) {
  const prefix = mkdtempSync(join(tmpdir(), `waifus-npm-${version}.`));
  run("npm", ["install", "--prefix", prefix, "-g", `${rootPackage}@${version}`], { npmCache: true });
  run(join(prefix, "bin/waifus"), ["help"]);
  const doctor = capture(join(prefix, "bin/waifus"), ["doctor"], {
    env: {
      DC_WAIFUS_HOME: `${prefix}-data`,
    },
  });
  const parsed = JSON.parse(doctor);
  if (parsed.ocr?.bundled?.supported && !parsed.ocr.bundled.available) {
    throw new Error(`Bundled OCR was expected but unavailable: ${JSON.stringify(parsed.ocr.bundled)}`);
  }
}

function ensureNoRemoteTag(tag) {
  const tagInfo = capture("git", ["ls-remote", "origin", `refs/tags/${tag}`]).trim();
  if (tagInfo) {
    throw new Error(`Remote tag already exists: ${tag}`);
  }
}

function ensureNoRelease(tag) {
  const result = run("gh", ["release", "view", tag, "--repo", repo, "--json", "tagName"], {
    capture: true,
    allowFailure: true,
  });
  if (result.status === 0) {
    throw new Error(`GitHub release already exists: ${tag}`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!/release not found|not found|HTTP 404/i.test(output)) {
    throw new Error(`Could not verify GitHub release absence for ${tag}: ${output.trim()}`);
  }
}

function ensurePackageVersionMissing(name, version) {
  const result = run("npm", ["view", `${name}@${version}`, "version"], {
    allowFailure: true,
    capture: true,
    npmCache: true,
  });
  if (result.status === 0 && result.stdout.trim() === version) {
    throw new Error(`npm package already exists: ${name}@${version}`);
  }
  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (!/E404|404|No match found|not found/i.test(output)) {
      throw new Error(`Could not verify npm package absence for ${name}@${version}: ${output.trim()}`);
    }
  }
}

function waitForWorkflowRun(workflowName, filters) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const runs = JSON.parse(capture("gh", [
      "run",
      "list",
      "--repo",
      repo,
      "--workflow",
      workflowName,
      "--limit",
      "20",
      "--json",
      "databaseId,headBranch,event,status,conclusion,createdAt,displayTitle,url",
    ]));
    const match = runs.find((run) => {
      if (filters.headBranch && run.headBranch !== filters.headBranch) {
        return false;
      }
      if (filters.event && run.event !== filters.event) {
        return false;
      }
      if (filters.createdAfter && Date.parse(run.createdAt) < filters.createdAfter.getTime() - 5_000) {
        return false;
      }
      return ["queued", "in_progress", "waiting", "requested", "completed"].includes(run.status);
    });
    if (match) {
      console.log(`${workflowName} run: ${match.url}`);
      return match.databaseId;
    }
    sleep(3_000);
  }
  throw new Error(`Timed out waiting for ${workflowName} workflow run.`);
}

async function confirmOrExit(question, yes) {
  if (yes) {
    return;
  }
  if (!input.isTTY) {
    throw new Error("Refusing to publish without --yes in a non-interactive shell.");
  }
  const rl = createInterface({ input, output });
  const answer = await rl.question(`${question} Type "yes" to continue: `);
  rl.close();
  if (answer !== "yes") {
    throw new Error("Release cancelled.");
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: commandEnv(options),
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (!options.allowFailure && result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(`${command} ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return result;
}

function capture(command, args, options = {}) {
  const result = run(command, args, { ...options, capture: true });
  return result.stdout;
}

function captureAllowFail(command, args, options = {}) {
  return run(command, args, { ...options, allowFailure: true, capture: true });
}

function commandEnv(options) {
  return {
    ...process.env,
    ...(options.npmCache ? { NPM_CONFIG_CACHE: npmCache } : {}),
    ...(options.env ?? {}),
  };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
