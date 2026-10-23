import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { runCommand } from "../src/cli/commands.js";
import { parseCliArgs } from "../src/cli/parser.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

let roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

describe("CLI --help", () => {
  it("parses --help and -h on any command as a help request, not a flag", () => {
    for (const argv of [["start", "--help"], ["start", "-h"], ["stop", "--port", "1", "--help"]]) {
      const parsed = parseCliArgs(argv);
      expect(parsed.command).toBe(argv[0]);
      expect(parsed.helpRequested).toBe(true);
      expect(parsed.flags.help).toBeUndefined();
    }
    expect(parseCliArgs(["remote", "status", "--help"])).toMatchObject({ command: "remote", helpRequested: true });
    expect(parseCliArgs(["start", "--", "--help"]).helpRequested).toBeUndefined();
  });

  it("prints command help and exits 0 without starting, stopping, or creating anything", async () => {
    const root = path.join(await makeTempRoot(), "never-created");
    roots.push(path.dirname(root));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
    const detachedSpawner = vi.fn();
    const killProcess = vi.fn();
    for (const argv of [["start", "--help"], ["restart", "-h"], ["stop", "--help"], ["dev", "--help"], ["clean", "--help"]]) {
      lines.length = 0;
      const code = await runCommand(parseCliArgs([...argv, "--data-root", root]), {
        detachedSpawner: detachedSpawner as never,
        killProcess
      });
      expect(code, argv.join(" ")).toBe(0);
      const output = lines.join("\n");
      expect(output).toContain(`waifus ${argv[0]}`);
      expect(output).not.toContain("waifus doctor");
    }
    expect(detachedSpawner).not.toHaveBeenCalled();
    expect(killProcess).not.toHaveBeenCalled();
    expect(existsSync(root)).toBe(false);
  });

  it("waifus help <command> prints that command's usage", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
    expect(await runCommand(parseCliArgs(["help", "remote"]))).toBe(0);
    expect(lines.join("\n")).toContain("waifus remote status");
    expect(lines.join("\n")).not.toContain("waifus start");
  });
});
