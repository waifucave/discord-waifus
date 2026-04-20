import { createRequire } from "node:module";
import path from "node:path";
import { getServiceEnv } from "./service-env.js";

type PM2Runtime = typeof import("pm2");
type StartOptions = import("pm2").StartOptions;
type ProcessDescription = import("pm2").ProcessDescription;
const require = createRequire(import.meta.url);

export const backendProcessName = "waifus-backend";
export const dashboardProcessName = "waifus-dashboard";

export interface ManagedProcessStatus {
  name: string;
  status: string;
  cwd: string | null;
  pid: number | null;
  restartCount: number;
  uptimeMs: number | null;
}

export async function startServices(projectRoot: string): Promise<void> {
  await withPm2(async () => {
    await ensureStarted({
      name: backendProcessName,
      cwd: projectRoot,
      script: "pnpm",
      args: ["--filter", "backend", "start"],
      env: getServiceEnv("backend")
    });

    await ensureStarted({
      name: dashboardProcessName,
      cwd: projectRoot,
      script: "pnpm",
      args: ["--filter", "dashboard", "start"],
      env: getServiceEnv("dashboard")
    });
  });
}

export async function stopServices(): Promise<void> {
  await withPm2(async () => {
    await stopIfPresent(backendProcessName);
    await stopIfPresent(dashboardProcessName);
  });
}

export async function restartServices(projectRoot: string): Promise<void> {
  await withPm2(async () => {
    await restartOrStart({
      name: backendProcessName,
      cwd: projectRoot,
      script: "pnpm",
      args: ["--filter", "backend", "start"],
      env: getServiceEnv("backend")
    });

    await restartOrStart({
      name: dashboardProcessName,
      cwd: projectRoot,
      script: "pnpm",
      args: ["--filter", "dashboard", "start"],
      env: getServiceEnv("dashboard")
    });
  });
}

export async function listManagedServices(): Promise<ManagedProcessStatus[]> {
  return withPm2(async () => {
    const processes = await listProcesses();
    return processes
      .filter((processDescription) =>
        [backendProcessName, dashboardProcessName].includes(processDescription.name ?? "")
      )
      .map((processDescription) => ({
        name: processDescription.name ?? "unknown",
        status: processDescription.pm2_env?.status ?? "unknown",
        cwd: processDescription.pm2_env?.pm_cwd ?? null,
        pid: typeof processDescription.pid === "number" ? processDescription.pid : null,
        restartCount: processDescription.pm2_env?.restart_time ?? 0,
        uptimeMs:
          typeof processDescription.pm2_env?.pm_uptime === "number"
            ? Date.now() - processDescription.pm2_env.pm_uptime
            : null
      }));
  });
}

export function getPm2LogCommand(service: "backend" | "dashboard" | null, lines: number): {
  command: string;
  args: string[];
} {
  const pm2Bin = resolvePm2Bin();
  const args = ["logs"];

  if (service === "backend") {
    args.push(backendProcessName);
  } else if (service === "dashboard") {
    args.push(dashboardProcessName);
  } else {
    args.push(backendProcessName, dashboardProcessName);
  }

  args.push("--lines", String(lines));

  return {
    command: process.execPath,
    args: [pm2Bin, ...args]
  };
}

async function ensureStarted(options: StartOptions): Promise<void> {
  if (await hasManagedProcess(options.name ?? "")) {
    await restartProcess(options.name ?? "");
    return;
  }
  await startProcess(options);
}

async function restartOrStart(options: StartOptions): Promise<void> {
  if (await hasManagedProcess(options.name ?? "")) {
    await restartProcess(options.name ?? "");
    return;
  }
  await startProcess(options);
}

async function stopIfPresent(processName: string): Promise<void> {
  if (!(await hasManagedProcess(processName))) {
    return;
  }
  await stopProcess(processName);
}

async function withPm2<T>(callback: () => Promise<T>): Promise<T> {
  const pm2 = await loadPm2();
  await connect(pm2);
  try {
    return await callback();
  } finally {
    pm2.disconnect();
  }
}

function connect(pm2: PM2Runtime): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.connect((error: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function startProcess(options: StartOptions): Promise<void> {
  const pm2 = await loadPm2();
  return new Promise((resolve, reject) => {
    pm2.start(options, (error: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function restartProcess(processName: string): Promise<void> {
  const pm2 = await loadPm2();
  return new Promise((resolve, reject) => {
    pm2.restart(processName, (error: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function stopProcess(processName: string): Promise<void> {
  const pm2 = await loadPm2();
  return new Promise((resolve, reject) => {
    pm2.stop(processName, (error: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function listProcesses(): Promise<ProcessDescription[]> {
  const pm2 = await loadPm2();
  return new Promise((resolve, reject) => {
    pm2.list((error: Error | null, processDescription: ProcessDescription[]) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(processDescription);
    });
  });
}

async function hasManagedProcess(processName: string): Promise<boolean> {
  const processes = await listProcesses();
  return processes.some((processDescription) => processDescription.name === processName);
}

let pm2Promise: Promise<PM2Runtime> | null = null;

async function loadPm2(): Promise<PM2Runtime> {
  if (!pm2Promise) {
    pm2Promise = Promise.resolve(require("pm2") as PM2Runtime);
  }

  return pm2Promise;
}

function resolvePm2Bin(): string {
  return require.resolve(path.join("pm2", "bin", "pm2"));
}
