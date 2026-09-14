import { spawn } from "node:child_process";

export type BrowserProcessSpawner = (
  command: string,
  args: readonly string[]
) => Readonly<{ unref: () => void }>;

export async function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawnProcess: BrowserProcessSpawner = (command, args) => spawn(command, args, {
    detached: true,
    stdio: "ignore"
  })
): Promise<void> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "http:"
    || !/^waifus-[a-z2-7]{52}\.localhost$/u.test(parsed.hostname)
    || parsed.port === ""
    || parsed.username !== ""
    || parsed.password !== ""
    || !/^\/_waifus_remote\/bootstrap\/[A-Za-z0-9_-]{43}$/u.test(parsed.pathname)
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new Error("Refusing to open a non-local remote gateway URL.");
  }
  const invocation = platform === "darwin"
    ? { command: "open", args: [url] }
    : platform === "win32"
      ? { command: "cmd.exe", args: ["/d", "/s", "/c", "start", "", url] }
      : { command: "xdg-open", args: [url] };
  const child = spawnProcess(invocation.command, invocation.args);
  child.unref();
}
