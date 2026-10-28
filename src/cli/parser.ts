export type CliCommand =
  | "help"
  | "start"
  | "stop"
  | "restart"
  | "status"
  | "doctor"
  | "clean"
  | "update"
  | "dev"
  | "remote"
  | "list"
  | "get"
  | "set"
  | "unset"
  | "wake"
  | "life"
  | "forget"
  | "usage"
  | "files"
  | "wakeups"
  | "schedule"
  | "watches";

export type RemoteCliAction = "start" | "status" | "stop";

export type ParsedCli = {
  command: CliCommand;
  flags: Record<string, string | boolean>;
  positional: string[];
  remoteAction?: RemoteCliAction;
  /** `--help`/`-h` anywhere before `--`: print the command's help and do nothing else. */
  helpRequested?: true;
};

const COMMANDS = new Set<CliCommand>([
  "help",
  "start",
  "stop",
  "restart",
  "status",
  "doctor",
  "clean",
  "update",
  "dev",
  "remote",
  "list",
  "get",
  "set",
  "unset",
  "wake",
  "life",
  "forget",
  "usage",
  "files",
  "wakeups",
  "schedule",
  "watches"
]);

/** The settings and life commands (they talk to the host through `hostClient.ts`). */
export const SETTINGS_AND_LIFE_COMMANDS: ReadonlySet<CliCommand> = new Set<CliCommand>(["list", "get", "set", "unset", "wake", "life", "forget", "usage", "files", "wakeups", "schedule", "watches"]);

// Switches that never take a value, so `waifus wake aria --json hello` keeps "hello" as an argument.
const BOOLEAN_FLAGS = new Set([
  "json",
  "yes",
  "log",
  "private",
  "dryRun",
  "stdin",
  "force",
  "includeLogs",
  "foreground",
  "setup",
  "noOpen",
  "npm",
  "global",
  "github",
  "release",
  "git"
]);

export function parseCliArgs(rawArgv: string[]): ParsedCli {
  // Strip help switches up front: as ordinary flags they were ignored (`waifus start --help`
  // started the app) or swallowed the next argument as their value.
  const separator = rawArgv.indexOf("--");
  const beforeSeparator = separator >= 0 ? rawArgv.slice(0, separator) : rawArgv;
  const isHelpSwitch = (arg: string) => arg === "--help" || arg === "-h";
  const helpRequested = beforeSeparator.some(isHelpSwitch);
  const argv = helpRequested
    ? [...beforeSeparator.filter((arg) => !isHelpSwitch(arg)), ...(separator >= 0 ? rawArgv.slice(separator) : [])]
    : rawArgv;
  const [first, ...rest] = argv;
  const command = COMMANDS.has(first as CliCommand) ? (first as CliCommand) : "help";
  const commandArgs = command === "help" && first && !first.startsWith("-") && first !== "help"
    ? argv
    : rest;
  const remoteAction = command === "remote" && (commandArgs[0] === "status" || commandArgs[0] === "stop")
    ? commandArgs[0]
    : command === "remote"
      ? "start"
      : undefined;
  const args = remoteAction === "status" || remoteAction === "stop"
    ? commandArgs.slice(1)
    : commandArgs;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
      flags[toCamel(withoutPrefix.slice(0, equalsIndex))] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }
    const key = toCamel(withoutPrefix);
    const next = args[index + 1];
    if (next && !next.startsWith("--") && !BOOLEAN_FLAGS.has(key)) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }

  return {
    command,
    flags,
    positional,
    ...(remoteAction ? { remoteAction } : {}),
    ...(helpRequested ? { helpRequested: true as const } : {})
  };
}

export function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

export function flagBoolean(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}

export function flagNumber(flags: Record<string, string | boolean>, key: string): number | undefined {
  const value = flagString(flags, key);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toCamel(input: string): string {
  return input.replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
}
