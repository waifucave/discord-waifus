// The CLI's command table (overhaul spec §10.5, Living cast §14.2), data only: `waifus help`, the
// help API's command topics and the generated assistant KB all read it. Global flags:
// `--data-root PATH`, `--json`, `-h/--help`, `--yes`.

import type { CommandSpec } from "./types.js";

export const GLOBAL_FLAGS: CommandSpec["flags"] = [
  { name: "--data-root", value: "PATH", help: "Use this data root instead of DC_WAIFUS_HOME or ~/.dc-waifus." },
  { name: "--json", help: "Print machine-readable JSON." },
  { name: "--help", help: "Show help for a command without running it (also -h)." }
];

export const COMMANDS: readonly CommandSpec[] = Object.freeze([
  {
    name: "help",
    summary: "Help for a command, a settings group, a key or a topic (works offline).",
    usage: ["waifus help [TOPIC]"],
    description: "TOPIC is a command (wake), a settings group (app, waifu, server, channel, assistant, bot, provider, remote-access), a key (app.life.maxSendsPerTurn, or life.maxSendsPerTurn for app keys), a part of a group (app.life) or a topic (life, forget, usage, detector, runtime, environment). `waifus help` lists them all."
  },
  {
    name: "list",
    summary: "List the settings groups, or one group's keys with type, default and help (and its targets when the host runs).",
    usage: ["waifus list [GROUP]"],
    topic: "app"
  },
  {
    name: "get",
    summary: "Read settings: a whole target or one key.",
    usage: ["waifus get TARGET [KEY]", "waifus get app.life.maxSendsPerTurn"],
    description: "TARGET is app, assistant, remote-access, waifu:<id>, server:<guildId>, channel:<guildId>/<channelId>, bot:<house|id> or provider:<id>. Secrets are never shown, only whether they are set. `app` works with the host stopped (it reads config.toml); the rest need the running host."
  },
  {
    name: "set",
    summary: "Change settings: one key, or several KEY=VALUE pairs in one write.",
    usage: ["waifus set TARGET KEY VALUE", "waifus set TARGET KEY=VALUE [KEY=VALUE…]", "waifus set app.life.maxSendsPerTurn 6", "waifus set provider:anthropic apiKey --from-env ANTHROPIC_KEY"],
    description:
      "Values are typed by the key: true/false, numbers, enums, HH:mm times, text, JSON for objects and lists (a list of ids may also be comma separated), `null` where the key takes it. Secrets (apiKey, token) are never accepted on the command line: use --from-env VAR or pipe them on stdin. Writes send the revision they read and retry a conflicting write up to 3 times.",
    flags: [
      { name: "--from-env", value: "VAR", help: "Read a secret value from this environment variable." },
      { name: "--stdin", help: "Read the value from standard input (multi-line text, secrets)." },
      { name: "--file", value: "PATH", help: "Read the value from a file." }
    ]
  },
  {
    name: "unset",
    summary: "Reset keys: a key that takes null is cleared, any other key goes back to its default.",
    usage: ["waifus unset TARGET KEY [KEY…]", "waifus unset waifu:aria life.dailyBudgetUsd"]
  },
  {
    name: "wake",
    summary: "Wake a waifu now, with an optional note she sees (an owner wake skips sleep and budget).",
    usage: ["waifus wake WAIFU [NOTE…]"],
    topic: "life"
  },
  {
    name: "life",
    summary: "A waifu's life: status, queue and today's cost; --log adds the recent life log.",
    usage: ["waifus life WAIFU [--log] [--limit N] [--private]"],
    description: "DM content is left out unless --private is given (it is shown only on the host itself).",
    flags: [
      { name: "--log", help: "Also print the newest life-log lines." },
      { name: "--limit", value: "N", help: "How many log lines (default 20, at most 200)." },
      { name: "--private", help: "Include DM content (local only)." }
    ],
    topic: "life"
  },
  {
    name: "forget",
    summary: "Forget a Discord user everywhere (best-effort scrub); asks for confirmation unless --yes.",
    usage: ["waifus forget USER_ID [--yes] [--dry-run]"],
    flags: [
      { name: "--yes", help: "Do not ask for confirmation (needed without a terminal)." },
      { name: "--dry-run", help: "Report what would be deleted without deleting anything." }
    ],
    topic: "forget"
  },
  {
    name: "usage",
    summary: "Model calls and cost from the usage ledger, by local day (or another grouping).",
    usage: ["waifus usage [--from DAY] [--to DAY] [--by KEY[,KEY]] [--waifu ID] [--tz ZONE]"],
    flags: [
      { name: "--from", value: "DAY", help: "First local day (YYYY-MM-DD; default 6 days before --to)." },
      { name: "--to", value: "DAY", help: "Last local day (default today)." },
      { name: "--by", value: "KEY", help: "day, waifu, purpose, model, provider, turn, place or server (one or two, comma separated)." },
      { name: "--waifu", value: "ID", help: "Only this waifu's calls." },
      { name: "--tz", value: "ZONE", help: "IANA time zone for the day boundaries (default the host's)." }
    ],
    topic: "usage"
  },
  { name: "start", summary: "Start the host in the background (dashboard, API and Discord).", usage: ["waifus start [--host 127.0.0.1] [--port 3888] [--foreground]"], lifecycle: true },
  { name: "dev", summary: "Run the host in the foreground for development.", usage: ["waifus dev [--host 127.0.0.1] [--port 3888]"], lifecycle: true },
  { name: "stop", summary: "Stop the host.", usage: ["waifus stop"], lifecycle: true },
  { name: "restart", summary: "Stop, then start the host.", usage: ["waifus restart [--host 127.0.0.1] [--port 3888]"], lifecycle: true },
  { name: "status", summary: "Whether the host and the remote gateway run, plus the Living cast's state that needs attention (JSON).", usage: ["waifus status"], lifecycle: true, topic: "runtime" },
  { name: "doctor", summary: "Check the install and the data root (read-only; JSON).", usage: ["waifus doctor"], lifecycle: true, topic: "runtime" },
  { name: "clean", summary: "Delete ordinary user data (keeps Remote Access pairing).", usage: ["waifus clean [--force] [--include-logs]"], lifecycle: true },
  { name: "update", summary: "Update the installed package, or turn idle updates on or off.", usage: ["waifus update [--npm | --github]", "waifus update --auto on|off|status"], lifecycle: true },
  {
    name: "remote",
    summary: "Run the Remote Access gateway on this device, or check or stop it.",
    usage: ["waifus remote [--setup] [--foreground] [--no-open] [--host ID_OR_NAME] [--port PORT]", "waifus remote status", "waifus remote stop"],
    lifecycle: true
  }
]);

export function commandSpec(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}
