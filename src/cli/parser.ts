export type CliCommand =
  | "help"
  | "start"
  | "stop"
  | "restart"
  | "status"
  | "doctor"
  | "clean"
  | "update"
  | "dev";

export type ParsedCli = {
  command: CliCommand;
  flags: Record<string, string | boolean>;
  positional: string[];
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
  "dev"
]);

export function parseCliArgs(argv: string[]): ParsedCli {
  const [first, ...rest] = argv;
  const command = COMMANDS.has(first as CliCommand) ? (first as CliCommand) : "help";
  const args = command === "help" && first && !first.startsWith("-") && first !== "help" ? argv : rest;
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
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }

  return { command, flags, positional };
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
