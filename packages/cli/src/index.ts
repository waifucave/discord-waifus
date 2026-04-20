#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { cac } from "cac";
import { parse as parseToml } from "smol-toml";
import pc from "picocolors";
import { saveCliConfig } from "./config-store.js";
import { assertProjectRoot, resolveProjectRoot } from "./project-root.js";
import {
  fileExists,
  GlobalOptions,
  info,
  readJsonFile,
  requiredBuildArtifacts,
  requireProjectRoot,
  runtimeConfigFiles,
  spawnPassthrough,
  success,
  warn
} from "./command-utils.js";
import { openUrl } from "./open-url.js";
import {
  bootstrapLocalRuntime,
  getRuntimeLayoutPaths,
  hasLegacyLiveConfig,
  inspectRuntimeState,
  localRuntimeFiles
} from "./runtime-layout.js";
import { migrateLocalConfig } from "./local-config-migrator.js";
import {
  getPm2LogCommand,
  listManagedServices,
  restartServices,
  startServices,
  stopServices
} from "./pm2-manager.js";
import { bootstrapRepoFromGitHubArchive } from "./repo-bootstrap.js";
import { getServiceEnv } from "./service-env.js";

const cli = cac("waifus");
const DEFAULT_PROJECT_DIRNAME = "Discord-Waifus";

cli.option("--project <path>", "Override the project root for this command");

cli
  .command("use <projectPath>", "Store the default Discord Waifus project root for future commands")
  .action(async (projectPath: string) => {
    try {
      const resolvedRoot = await assertProjectRoot(projectPath);
      await saveCliConfig({ defaultProjectRoot: resolvedRoot });
      console.log(pc.green(`Default project root saved: ${resolvedRoot}`));
    } catch (error) {
      fail(error);
    }
  });

cli
  .command("init <targetDir>", "Download the Discord Waifus repo into a target directory and register it")
  .option("--repo <repo>", "GitHub repo URL or owner/repo slug. If omitted, uses the package repository when available.")
  .option("--ref <ref>", "Git ref, branch, or tag to download. Defaults to the repo default branch.")
  .option("--no-install", "Skip pnpm install after download")
  .action(async (targetDir: string, options: { repo?: string; ref?: string; install?: boolean }) => {
    try {
      const result = await bootstrapRepoFromGitHubArchive(targetDir, {
        repo: options.repo ?? null,
        ref: options.ref ?? null
      });
      await assertProjectRoot(result.projectRoot);

      success(`Downloaded project into ${result.projectRoot}`);
      info(`Source: ${result.sourceRepo}${result.sourceRef ? ` @ ${result.sourceRef}` : ""}`);

      await saveCliConfig({ defaultProjectRoot: result.projectRoot });
      success(`Default project root saved: ${result.projectRoot}`);

      if (options.install !== false) {
        info("Installing project dependencies with pnpm...");
        await spawnPassthrough("pnpm", ["install"], result.projectRoot);
        success("Dependencies installed.");
      } else {
        warn("Skipped pnpm install. Run `pnpm install` inside the project before building.");
      }

      info("Next steps:");
      info(`- waifus build`);
      info(`- waifus init-config`);
      info(`- waifus start`);
    } catch (error) {
      fail(error);
    }
  });

cli
  .command("doctor", "Validate the local setup")
  .action(async () => {
    try {
      const projectRoot = await requireProjectRoot(cli.options as GlobalOptions);
      const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
      const pnpmVersion = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
      const configFiles = runtimeConfigFiles(projectRoot);
      const artifactFiles = requiredBuildArtifacts(projectRoot);
      const runtimeState = await inspectRuntimeState(projectRoot);

      console.log(pc.bold("waifus doctor"));
      info(`Project root: ${projectRoot}`);

      if (Number.isFinite(nodeMajor) && nodeMajor >= 20) {
        success(`Node.js ${process.versions.node}`);
      } else {
        warn(`Node.js ${process.versions.node} detected. Recommended: Node.js 20+`);
      }

      if (pnpmVersion.status === 0) {
        success(`pnpm ${pnpmVersion.stdout.trim()}`);
      } else {
        warn("pnpm not found in PATH");
      }

      if (runtimeState.isCanonicalLocalRuntime) {
        success("Canonical local runtime detected: .waifus/");
      } else if (runtimeState.isMigrationPending) {
        warn("Migration pending: legacy config still takes precedence until import completes.");
      } else if (runtimeState.legacyLiveExists) {
        warn("Legacy runtime detected. Local .waifus/ bootstrap is blocked until migration.");
      } else {
        warn("Local runtime not initialized. Run: waifus init-config");
      }

      for (const configFile of configFiles) {
        if (await fileExists(configFile)) {
          success(`Config present: ${path.relative(projectRoot, configFile)}`);
        } else {
          warn(`Missing config: ${path.relative(projectRoot, configFile)} (run: waifus init-config)`);
        }
      }

      for (const artifactFile of artifactFiles) {
        if (await fileExists(artifactFile)) {
          success(`Build artifact present: ${path.relative(projectRoot, artifactFile)}`);
        } else {
          warn(`Build artifact missing: ${path.relative(projectRoot, artifactFile)}`);
        }
      }

      const filesToScan =
        runtimeState.isCanonicalLocalRuntime || (runtimeState.runtimeRootExists && !runtimeState.legacyLiveExists)
          ? [
              ...localRuntimeFiles(projectRoot),
              ...(await listWaifuDocumentFiles(projectRoot))
            ]
          : [
              ...legacyConfigFiles(projectRoot)
            ];

      for (const configFile of filesToScan) {
        if (!(await fileExists(configFile))) {
          continue;
        }

        const configValue = await readConfigFile(configFile);
        if (configValue === null) {
          warn(`Could not parse config: ${path.relative(projectRoot, configFile)}`);
          continue;
        }

        for (const envReference of findEnvReferences(configValue)) {
          if (process.env[envReference.variableName]) {
            success(
              `Environment value resolved for ${envReference.variableName} in ${path.relative(projectRoot, configFile)}`
            );
          } else {
            warn(
              `Unresolved ${envReference.raw} in ${path.relative(projectRoot, configFile)}. Export ${envReference.variableName} before start.`
            );
          }
        }

        if (
          configFile.endsWith(path.join(".waifus", "orchestrator.toml")) ||
          configFile.endsWith(path.join("config", "orchestrator.json"))
        ) {
          const orchestrator =
            "orchestrator" in (configValue as Record<string, unknown>)
              ? ((configValue as { orchestrator?: { providerId?: string; provider_id?: string; model?: string } }).orchestrator ?? {})
              : {};
          const providerValue =
            typeof (orchestrator as { providerId?: string }).providerId === "string"
              ? (orchestrator as { providerId?: string }).providerId
              : typeof (orchestrator as { provider_id?: string }).provider_id === "string"
                ? (orchestrator as { provider_id?: string }).provider_id
                : "";
          const modelValue =
            typeof (orchestrator as { model?: string }).model === "string"
              ? (orchestrator as { model?: string }).model
              : "";

          if (
            providerValue === "configure-me" ||
            providerValue === "" ||
            modelValue === "configure-me" ||
            modelValue === ""
          ) {
            warn("Orchestrator config is still unconfigured. Update it in the dashboard before relying on orchestration.");
          }
        }
      }

      if (runtimeState.runtimeRootExists && runtimeState.migrationState) {
        info(`Migration state: ${runtimeState.migrationState.status}`);
      }

      info("If you edit config on disk, apply it with: waifus restart");
    } catch (error) {
      fail(error);
    }
  });

cli.command("build", "Build backend, dashboard, and CLI").action(async () => {
  try {
    const projectRoot = await requireProjectRoot(cli.options as GlobalOptions);
    await spawnPassthrough("pnpm", ["build"], projectRoot);
  } catch (error) {
    fail(error);
  }
  });

cli
  .command("init-config", "Create or repair the local .waifus runtime layout from defaults/")
  .option("--force", "Reserved for future explicit empty-bootstrap overrides")
  .action(async () => {
    try {
      const projectRoot = await requireProjectRoot(cli.options as GlobalOptions);
      const legacyLiveExists = await hasLegacyLiveConfig(projectRoot);
      const runtimeState = await inspectRuntimeState(projectRoot);

      if (legacyLiveExists && runtimeState.migrationState?.status !== "import_completed") {
        throw new Error("Legacy live config still exists. Run: waifus migrate-local-config");
      }

      const written = await bootstrapLocalRuntime(projectRoot);
      if (written.length === 0) {
        info("Local runtime layout already satisfied.");
      } else {
        for (const filePath of written) {
          success(`Wrote ${path.relative(projectRoot, filePath)}`);
        }
      }

      info("Finish configuration in the dashboard after start.");
      info("If you later edit config on disk, apply it with: waifus restart");
    } catch (error) {
      fail(error);
    }
  });

cli
  .command("migrate-local-config", "Import legacy config/*.json runtime data into the local .waifus layout")
  .action(async () => {
    try {
      const projectRoot = await requireProjectRoot(cli.options as GlobalOptions);
      const result = await migrateLocalConfig(projectRoot);

      success(`Imported legacy runtime into .waifus/ (${result.written.length} files written).`);
      if (Object.keys(result.idMap).some((legacyId) => legacyId !== result.idMap[legacyId])) {
        info("Sanitized waifu IDs:");
        for (const [legacyId, nextId] of Object.entries(result.idMap)) {
          if (legacyId === nextId) {
            continue;
          }
          info(`- ${legacyId} -> ${nextId}`);
        }
      }
      if (result.warningCount > 0) {
        warn(
          `Migration completed with ${result.warningCount} warning(s). Review ${path.relative(projectRoot, getRuntimeLayoutPaths(projectRoot).migrationWarningsFile)}`
        );
      } else {
        success("Migration warnings: none");
      }
      info("Legacy files were left untouched. After reviewing the import, apply it with: waifus restart");
    } catch (error) {
      fail(error);
    }
  });

cli
  .command("start", "Start backend and dashboard under PM2")
  .action(async () => {
    try {
      const projectRoot = await requireProjectRootForStart(cli.options as GlobalOptions);
      await assertNoPendingLegacyMigration(projectRoot);
      await ensureBuildArtifacts(projectRoot);
      await startManagedServices(projectRoot);
    } catch (error) {
      fail(error);
    }
  });

cli.command("stop", "Stop PM2-managed backend and dashboard").action(async () => {
  try {
    await requireProjectRoot(cli.options as GlobalOptions);
    await stopServices();
    success("Stopped waifus-backend and waifus-dashboard.");
  } catch (error) {
    fail(error);
  }
});

cli
  .command("restart", "Restart PM2-managed backend and dashboard")
  .action(async () => {
    try {
      const projectRoot = await requireProjectRoot(cli.options as GlobalOptions);
      await assertNoPendingLegacyMigration(projectRoot);
      for (const artifactFile of requiredBuildArtifacts(projectRoot)) {
        if (!(await fileExists(artifactFile))) {
          throw new Error(
            `Missing build artifact: ${path.relative(projectRoot, artifactFile)}\nRun: waifus build`
          );
        }
      }

      await restartServices(projectRoot);
      success("Restarted waifus-backend and waifus-dashboard.");
      info("Local dashboard: http://localhost:3000");
      info("Local backend: http://127.0.0.1:4000");
      warn("These services are local to this machine.");
      info("Config changes on disk are now applied.");
    } catch (error) {
      fail(error);
    }
  });

cli.command("status", "Show PM2 service status").action(async () => {
  try {
    await requireProjectRoot(cli.options as GlobalOptions);
    const services = await listManagedServices();

    console.log(pc.bold("waifus status"));
    if (services.length === 0) {
      warn("No managed waifus PM2 services found.");
    } else {
      for (const service of services) {
        console.log(
          [
            `- ${service.name}`,
            `  status: ${service.status}`,
            `  cwd: ${service.cwd ?? "unknown"}`,
            `  pid: ${service.pid ?? "not running"}`,
            `  restarts: ${service.restartCount}`,
            `  uptimeMs: ${service.uptimeMs ?? "unknown"}`
          ].join("\n")
        );
      }
    }

    try {
      const response = await fetch("http://127.0.0.1:4000/api/status");
      if (response.ok) {
        const payload = (await response.json()) as { uptimeSeconds?: number };
        info(`Backend health: reachable on 127.0.0.1:4000 (uptimeSeconds=${payload.uptimeSeconds ?? "unknown"})`);
      } else {
        warn(`Backend health check returned HTTP ${response.status}`);
      }
    } catch {
      warn("Backend health: not reachable on 127.0.0.1:4000");
    }

    warn("These services are local to this machine.");
  } catch (error) {
    fail(error);
  }
});

cli
  .command("logs [service]", "Tail PM2 logs for backend, dashboard, or both")
  .option("--lines <count>", "How many recent lines to include", { default: "100" })
  .action(async (service: string | undefined, options: { lines: string }) => {
    try {
      await requireProjectRoot(cli.options as GlobalOptions);
      const normalizedService =
        service === "backend" || service === "dashboard" ? service : service ? null : null;

      if (service && !normalizedService) {
        throw new Error("Invalid service. Use: waifus logs | waifus logs backend | waifus logs dashboard");
      }

      const lineCount = Number.parseInt(options.lines, 10);
      if (!Number.isFinite(lineCount) || lineCount <= 0) {
        throw new Error("Invalid --lines value. Use a positive integer.");
      }

      const logCommand = getPm2LogCommand(normalizedService, lineCount);
      await spawnPassthrough(logCommand.command, logCommand.args, process.cwd());
    } catch (error) {
      fail(error);
    }
  });

cli.command("open", "Open the local dashboard in the browser").action(async () => {
  try {
    await requireProjectRoot(cli.options as GlobalOptions);
    await openUrl("http://localhost:3000");
    success("Opened http://localhost:3000");
  } catch (error) {
    fail(error);
  }
});

cli
  .command("run <service>", "Run backend or dashboard in the foreground")
  .action(async (service: string) => {
    try {
      const projectRoot = await requireProjectRoot(cli.options as GlobalOptions);
      if (service !== "backend" && service !== "dashboard") {
        throw new Error("Invalid service. Use: waifus run backend | waifus run dashboard");
      }

      const filterTarget = service === "backend" ? "backend" : "dashboard";
      await spawnPassthrough("pnpm", ["--filter", filterTarget, "start"], projectRoot, getServiceEnv(service));
    } catch (error) {
      fail(error);
    }
  });

cli.help();
cli.version("0.1.0");

if (process.argv.length <= 2) {
  runDefaultCommand().catch(fail);
} else {
  cli.parse(process.argv);
}

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : "Unknown CLI error";
  console.error(pc.red(message));
  process.exit(1);
}

async function listWaifuDocumentFiles(projectRoot: string): Promise<string[]> {
  const paths = getRuntimeLayoutPaths(projectRoot);
  try {
    const entries = await fs.readdir(paths.runtimeWaifusRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(paths.runtimeWaifusRoot, entry.name));
  } catch {
    return [];
  }
}

function legacyConfigFiles(projectRoot: string): string[] {
  const paths = getRuntimeLayoutPaths(projectRoot);
  return [
    paths.legacyWaifusFile,
    paths.legacyProvidersFile,
    paths.legacyChannelsFile,
    paths.legacyOrchestratorFile,
    paths.legacyStageManagerFile
  ];
}

async function readConfigFile(filePath: string): Promise<unknown | null> {
  try {
    if (filePath.endsWith(".json")) {
      return await readJsonFile(filePath);
    }

    if (filePath.endsWith(".toml")) {
      return parseToml(await fs.readFile(filePath, "utf8"));
    }

    return null;
  } catch {
    return null;
  }
}

async function assertNoPendingLegacyMigration(projectRoot: string): Promise<void> {
  const runtimeState = await inspectRuntimeState(projectRoot);
  if (runtimeState.legacyLiveExists && runtimeState.migrationState?.status !== "import_completed") {
    throw new Error("Legacy live config still exists. Run: waifus migrate-local-config");
  }
}

async function requireProjectRootForStart(options: GlobalOptions): Promise<string> {
  const resolvedProjectRoot = await resolveProjectRoot({
    cwd: process.cwd(),
    explicitProjectRoot: options.project ?? null
  });

  if (resolvedProjectRoot) {
    return resolvedProjectRoot;
  }

  if (options.project) {
    throw new Error(`No valid project root found at ${options.project}`);
  }

  return bootstrapDefaultProjectRoot();
}

async function runDefaultCommand(): Promise<void> {
  const options = cli.options as GlobalOptions;
  const projectRoot = await requireProjectRootForStart(options);
  await assertNoPendingLegacyMigration(projectRoot);

  if (!(await hasCanonicalRuntime(projectRoot))) {
    info("Initializing local runtime...");
    const written = await bootstrapLocalRuntime(projectRoot);
    if (written.length === 0) {
      info("Local runtime already initialized.");
    } else {
      for (const filePath of written) {
        success(`Wrote ${path.relative(projectRoot, filePath)}`);
      }
    }
  }

  await ensureBuildArtifacts(projectRoot);
  await startManagedServices(projectRoot);
}

async function bootstrapDefaultProjectRoot(): Promise<string> {
  const targetDir = path.join(process.env.HOME ?? process.cwd(), DEFAULT_PROJECT_DIRNAME);
  info(`No project configured. Bootstrapping into ${targetDir}`);

  const result = await bootstrapRepoFromGitHubArchive(targetDir, {});
  await assertProjectRoot(result.projectRoot);
  await saveCliConfig({ defaultProjectRoot: result.projectRoot });

  success(`Downloaded project into ${result.projectRoot}`);
  info(`Source: ${result.sourceRepo}${result.sourceRef ? ` @ ${result.sourceRef}` : ""}`);
  success(`Default project root saved: ${result.projectRoot}`);

  info("Installing project dependencies with pnpm...");
  await spawnPassthrough("pnpm", ["install"], result.projectRoot);
  success("Dependencies installed.");

  return result.projectRoot;
}

async function hasCanonicalRuntime(projectRoot: string): Promise<boolean> {
  const runtimeState = await inspectRuntimeState(projectRoot);
  return runtimeState.isCanonicalLocalRuntime;
}

async function ensureBuildArtifacts(projectRoot: string): Promise<void> {
  const missingArtifacts = [];

  for (const artifactFile of requiredBuildArtifacts(projectRoot)) {
    if (!(await fileExists(artifactFile))) {
      missingArtifacts.push(path.relative(projectRoot, artifactFile));
    }
  }

  if (missingArtifacts.length === 0) {
    return;
  }

  info("Build artifacts missing. Running `waifus build` automatically...");
  await spawnPassthrough("pnpm", ["build"], projectRoot);
}

async function startManagedServices(projectRoot: string): Promise<void> {
  await startServices(projectRoot);
  success("Started waifus-backend and waifus-dashboard through PM2.");
  info("Local dashboard: http://localhost:3000");
  info("Local backend: http://127.0.0.1:4000");
  warn("These services are local to this machine.");
  info("If you edit config on disk, apply it with: waifus restart");
}

function findEnvReferences(value: unknown): Array<{ raw: string; variableName: string }> {
  const references: Array<{ raw: string; variableName: string }> = [];

  visit(value, (candidate) => {
    if (typeof candidate !== "string") {
      return;
    }

    const envPrefixMatch = candidate.match(/^env:([A-Z0-9_]+)$/i);
    if (envPrefixMatch) {
      references.push({
        raw: candidate,
        variableName: envPrefixMatch[1]
      });
      return;
    }

    const templateMatch = candidate.match(/^\$\{([A-Z0-9_]+)\}$/i);
    if (templateMatch) {
      references.push({
        raw: candidate,
        variableName: templateMatch[1]
      });
    }
  });

  return references;
}

function visit(value: unknown, callback: (candidate: unknown) => void): void {
  callback(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      visit(entry, callback);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      visit(entry, callback);
    }
  }
}
