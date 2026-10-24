// Dispatch for the settings and life commands (`list get set unset wake life forget usage`) and the
// registry-driven `waifus help`. They share one context: the data root, `--json`, the output streams
// and the verified host connection (looked up once, on first use).

import { commandSpec, GLOBAL_FLAGS } from "../shared/settings/commands.js";
import { suggestTopics } from "../shared/settings/topics.js";
import { CliFailure, defaultIo, EXIT, runCli, usageError, type CliContext, type CliIo, type ExitCode } from "./cliContext.js";
import { connectHost, type HostTransport } from "./hostClient.js";
import { forgetCommand, lifeCommand, usageCommand, wakeCommand } from "./lifeCommands.js";
import { flagBoolean, flagString, type ParsedCli } from "./parser.js";
import { getCommand, helpCommand, listCommand, setCommand, unsetCommand } from "./settingsCommands.js";
import type { ProcessIdentityProbe } from "../storage/instanceLock.js";

export type OwnerCommandOptions = {
  io?: CliIo;
  /** Test hook: the host transport (null: no host runs). Default: the verified host of the data root. */
  hostTransport?: HostTransport | null;
  probe?: ProcessIdentityProbe;
  now?: () => Date;
};

function toCamel(input: string): string {
  return input.replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
}

/** Flags a command declares (plus the global ones); anything else is a usage error. */
function checkFlags(parsed: ParsedCli): void {
  const spec = commandSpec(parsed.command);
  const allowed = new Set([...(spec?.flags ?? []), ...(GLOBAL_FLAGS ?? [])].map((flag) => toCamel(flag.name.replace(/^--/u, ""))));
  for (const flag of Object.keys(parsed.flags)) {
    if (!allowed.has(flag)) {
      throw usageError(`Unknown option for waifus ${parsed.command}: --${flag.replace(/[A-Z]/gu, (char) => `-${char.toLowerCase()}`)}.`, `See waifus help ${parsed.command === "life" || parsed.command === "forget" || parsed.command === "usage" ? `cli.${parsed.command}` : parsed.command}.`);
    }
  }
}

function makeContext(parsed: ParsedCli, dataRoot: string, o: OwnerCommandOptions): CliContext {
  const io = o.io ?? defaultIo();
  let connection: Promise<HostTransport | undefined> | undefined;
  return {
    ...io,
    dataRoot,
    json: flagBoolean(parsed.flags, "json"),
    host: () => {
      connection ??= o.hostTransport !== undefined ? Promise.resolve(o.hostTransport ?? undefined) : connectHost(dataRoot, o.probe ? { probe: o.probe } : {});
      return connection;
    }
  };
}

/** `waifus help [TOPIC]` and `waifus <command> --help`. Unknown topics exit 2 with suggestions. */
export function runHelp(topic: string | undefined, o: { io?: CliIo } = {}): ExitCode {
  const io = o.io ?? defaultIo();
  return helpCommand(io, topic);
}

export async function runOwnerCommand(parsed: ParsedCli, dataRoot: string, o: OwnerCommandOptions = {}): Promise<ExitCode> {
  const ctx = makeContext(parsed, dataRoot, o);
  return runCli(ctx, async () => {
    checkFlags(parsed);
    const args = parsed.positional;
    const flags = parsed.flags;
    switch (parsed.command) {
      case "list":
        if (args.length > 1) throw usageError("waifus list takes at most one group.");
        return listCommand(ctx, args[0]);
      case "get":
        return getCommand(ctx, args);
      case "set": {
        const fromEnv = flagString(flags, "fromEnv");
        const file = flagString(flags, "file");
        if (flags["fromEnv"] !== undefined && !fromEnv) throw usageError("--from-env needs the variable's name.");
        if (flags["file"] !== undefined && !file) throw usageError("--file needs a path.");
        return setCommand(ctx, args, { ...(fromEnv ? { fromEnv } : {}), ...(file ? { file } : {}), stdin: flagBoolean(flags, "stdin") });
      }
      case "unset":
        return unsetCommand(ctx, args);
      case "wake":
        return wakeCommand(ctx, args);
      case "life":
        return lifeCommand(ctx, args, { log: flagBoolean(flags, "log"), private: flagBoolean(flags, "private"), ...(flagString(flags, "limit") !== undefined ? { limit: flagString(flags, "limit")! } : {}) });
      case "forget":
        return forgetCommand(ctx, args, { yes: flagBoolean(flags, "yes"), dryRun: flagBoolean(flags, "dryRun") });
      case "usage": {
        if (args.length > 0) throw usageError("waifus usage takes options only (see waifus help cli.usage).");
        const value = (name: string) => {
          if (flags[name] === true) throw usageError(`--${name} needs a value.`);
          return flagString(flags, name);
        };
        const options = { from: value("from"), to: value("to"), by: value("by"), waifu: value("waifu"), tz: value("tz") };
        return usageCommand(ctx, Object.fromEntries(Object.entries(options).filter(([, entry]) => entry !== undefined)), o.now);
      }
      default:
        throw new CliFailure(EXIT.usage, `Unknown command ${parsed.command}.`, { hint: suggestTopics(parsed.command).join(", ") || undefined });
    }
  });
}
