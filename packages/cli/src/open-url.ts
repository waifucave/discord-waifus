import process from "node:process";
import { spawn } from "node:child_process";

export async function openUrl(url: string): Promise<void> {
  const platform = process.platform;

  if (platform === "darwin") {
    await spawnDetached("open", [url]);
    return;
  }

  if (platform === "win32") {
    await spawnDetached("cmd", ["/c", "start", "", url]);
    return;
  }

  await spawnDetached("xdg-open", [url]);
}

async function spawnDetached(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      env: process.env
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
