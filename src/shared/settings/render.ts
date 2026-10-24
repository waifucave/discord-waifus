// Deterministic help renderers (overhaul spec §10.4): JSON for `GET /api/help/:topic`, Markdown for
// `?format=md`, `waifus help` and the generated assistant KB page (docs/assistant-kb/settings.md).
// Help payloads never use secret-looking object keys (flags are a list), so the API's redaction
// leaves them intact.

import { COMMANDS, GLOBAL_FLAGS } from "./commands.js";
import { groupKeyInfos, typeLabel } from "./introspect.js";
import { RESOURCE_TOPICS, SETTING_GROUPS } from "./registry.js";
import type { ResolvedTopic } from "./topics.js";
import type { CommandSpec, KeyInfo, ResourceTopic, RouteRef, SettingGroup } from "./types.js";

/** The route's one-line summary, when the caller knows it (the API's route help table). */
export type RouteSummary = (route: RouteRef) => string | undefined;

export function targetExample(group: SettingGroup): string {
  return group.target.kind === "singleton" ? group.id : `${group.id}:${group.target.example}`;
}

function formatValue(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? (value === "" ? '""' : value) : JSON.stringify(value);
}

export function cliForKey(group: SettingGroup, info: KeyInfo): string[] {
  const target = targetExample(group);
  const lines = [`waifus get ${target} ${info.path}`];
  if (info.flags.readOnly) return lines;
  if (info.flags.secret) {
    lines.push(`waifus set ${target} ${info.path} --from-env VAR`, `printf '%s' "$VALUE" | waifus set ${target} ${info.path} --stdin`);
  } else {
    const example = info.example ?? "VALUE";
    lines.push(`waifus set ${target} ${info.path} ${/\s|["'{[]/u.test(example) ? `'${example}'` : example}`);
  }
  if (info.flags.nullUnset || info.default !== undefined || info.flags.secret) lines.push(`waifus unset ${target} ${info.path}`);
  return lines;
}

const FLAG_NAMES = ["secret", "readOnly", "localOnlyWrite", "remoteHidden", "nullUnset", "nullIsValue", "leaf"] as const;

export function keyHelpJson(group: SettingGroup, info: KeyInfo) {
  return {
    id: info.id,
    group: info.group,
    path: info.path,
    type: info.type,
    typeLabel: typeLabel(info),
    ...(info.enum ? { enum: info.enum } : {}),
    ...(info.min !== undefined ? { min: info.min } : {}),
    ...(info.max !== undefined ? { max: info.max } : {}),
    ...(info.maxLength !== undefined ? { maxLength: info.maxLength } : {}),
    nullable: info.nullable || info.flags.nullIsValue === true,
    ...(info.default !== undefined && !info.flags.secret ? { default: info.default } : {}),
    help: info.help,
    flags: FLAG_NAMES.filter((flag) => info.flags[flag]),
    applies: info.flags.applies ?? "live",
    ...(info.example !== undefined ? { example: info.example } : {}),
    ...(info.unit !== undefined ? { unit: info.unit } : {}),
    cli: cliForKey(group, info)
  };
}

export type KeyHelpJson = ReturnType<typeof keyHelpJson>;

function routesOf(group: SettingGroup): RouteRef[] {
  return [...(group.list ? [group.list] : []), group.read, { method: group.write.method, path: group.write.path }];
}

export function groupHelpJson(group: SettingGroup) {
  return {
    kind: "group" as const,
    id: group.id,
    title: group.title,
    summary: group.summary,
    description: group.description,
    target: group.target.kind === "singleton" ? { kind: "singleton" as const, example: group.id } : { kind: "id" as const, idName: group.target.idName, example: targetExample(group) },
    storage: group.storage,
    routes: routesOf(group),
    revision: group.write.revision,
    keys: groupKeyInfos(group).map((info) => keyHelpJson(group, info)),
    excluded: Object.entries(group.excluded).map(([path, reason]) => ({ path, reason })),
    notes: group.notes ?? [],
    cli: [`waifus list ${group.id}`, `waifus get ${targetExample(group)}`, `waifus set ${targetExample(group)} KEY VALUE`, `waifus unset ${targetExample(group)} KEY`]
  };
}

export function resourceHelpJson(topic: ResourceTopic, summary?: RouteSummary) {
  return {
    kind: "resource" as const,
    id: topic.id,
    title: topic.title,
    summary: topic.summary,
    description: topic.description,
    routes: topic.routes.map((route) => ({ ...route, summary: summary?.(route) ?? "" })),
    cli: topic.cli
  };
}

export function commandHelpJson(command: CommandSpec) {
  return {
    kind: "command" as const,
    id: `cli.${command.name}`,
    name: command.name,
    summary: command.summary,
    usage: command.usage,
    ...(command.description ? { description: command.description } : {}),
    flags: [...(command.flags ?? []), ...(GLOBAL_FLAGS ?? [])]
  };
}

export function topicJson(resolved: Exclude<ResolvedTopic, { kind: "index" }>, summary?: RouteSummary) {
  switch (resolved.kind) {
    case "group":
      return groupHelpJson(resolved.group);
    case "subtree":
      return {
        kind: "subtree" as const,
        id: `${resolved.group.id}.${resolved.prefix}`,
        group: resolved.group.id,
        routes: routesOf(resolved.group),
        keys: resolved.keys.map((info) => keyHelpJson(resolved.group, info))
      };
    case "key":
      return { kind: "key" as const, id: resolved.key.id, group: resolved.group.id, routes: routesOf(resolved.group), key: keyHelpJson(resolved.group, resolved.key) };
    case "resource":
      return resourceHelpJson(resolved.topic, summary);
    case "command":
      return commandHelpJson(resolved.command);
  }
}

// ---- Markdown --------------------------------------------------------------------------------------

function escapeCell(text: string): string {
  return text.replace(/\|/gu, "\\|").replace(/\n/gu, " ");
}

function keyTable(group: SettingGroup, keys: readonly KeyInfo[]): string[] {
  const lines = ["| Key | Type | Default | What it does |", "|---|---|---|---|"];
  for (const info of keys) {
    const flags = [info.flags.readOnly ? "read-only" : "", info.flags.secret ? "secret, write-only" : "", info.flags.localOnlyWrite ? "local-only write" : "", info.flags.applies === "restart" ? "next start" : ""].filter(Boolean);
    const shown = info.default !== undefined && !info.flags.secret ? `\`${escapeCell(formatValue(info.default))}\`` : "";
    lines.push(`| \`${info.path}\` | ${escapeCell(typeLabel(info))} | ${shown} | ${escapeCell(info.help)}${flags.length ? ` (${flags.join("; ")})` : ""} |`);
  }
  return lines;
}

function routeLines(routes: readonly RouteRef[], summary?: RouteSummary): string[] {
  return routes.map((route) => `- \`${route.method} ${route.path}\`${summary?.(route) ? ` — ${summary(route)}` : ""}`);
}

export function groupMarkdown(group: SettingGroup, summary?: RouteSummary, o: { heading?: string } = {}): string {
  const heading = o.heading ?? "#";
  const target = group.target.kind === "singleton" ? `\`${group.id}\`` : `\`${group.id}:<${group.target.idName}>\` (e.g. \`${targetExample(group)}\`)`;
  return [
    `${heading} ${group.title} (\`${group.id}\`)`,
    "",
    group.description,
    "",
    `Target ${target} · stored in \`${group.storage}\` · writes: revision ${group.write.revision}.`,
    "",
    ...routeLines(routesOf(group), summary),
    "",
    ...keyTable(group, groupKeyInfos(group)),
    "",
    `CLI: \`waifus get ${targetExample(group)} [KEY]\`, \`waifus set ${targetExample(group)} KEY VALUE\`, \`waifus unset ${targetExample(group)} KEY\`.`,
    ...Object.entries(group.excluded).filter(([path]) => !["schemaVersion", "revision", "updatedAt"].includes(path)).map(([path, reason]) => `Not here: \`${path}\` — ${reason}`)
  ].join("\n");
}

function keyMarkdown(group: SettingGroup, info: KeyInfo): string {
  return [
    `# ${info.id}`,
    "",
    info.help,
    "",
    `- Type: ${typeLabel(info)}`,
    ...(info.default !== undefined && !info.flags.secret ? [`- Default: \`${formatValue(info.default)}\``] : []),
    `- Takes effect: ${info.flags.applies === "restart" ? "at the next start" : info.flags.applies === "reload" ? "after the runtime reload the write triggers" : "at once"}`,
    ...(info.flags.secret ? ["- Secret: write-only; never on the command line."] : []),
    ...(info.flags.localOnlyWrite ? ["- Only the host itself may change it (not a paired remote device)."] : []),
    `- HTTP: \`${group.read.method} ${group.read.path}\`${info.flags.readOnly ? "" : `, \`${group.write.method} ${group.write.path}\``}`,
    "",
    "CLI:",
    "",
    ...cliForKey(group, info).map((line) => `    ${line}`)
  ].join("\n");
}

function resourceMarkdown(topic: ResourceTopic, summary?: RouteSummary): string {
  return [`# ${topic.title}`, "", topic.description, "", ...routeLines(topic.routes, summary), ...(topic.cli.length ? ["", "CLI:", "", ...topic.cli.map((line) => `    ${line}`)] : [])].join("\n");
}

export function commandMarkdown(command: CommandSpec): string {
  const flags = [...(command.flags ?? []), ...(GLOBAL_FLAGS ?? [])];
  return [
    `# waifus ${command.name}`,
    "",
    command.summary,
    "",
    "Usage:",
    "",
    ...command.usage.map((line) => `    ${line}`),
    ...(command.description ? ["", command.description] : []),
    ...(flags.length ? ["", "Options:", "", ...flags.map((flag) => `- \`${flag.name}${flag.value ? ` ${flag.value}` : ""}\` — ${flag.help}`)] : [])
  ].join("\n");
}

export function indexMarkdown(): string {
  return [
    "# waifus help",
    "",
    "Commands:",
    "",
    ...COMMANDS.flatMap((command) => [`- \`${command.usage[0]}\` — ${command.summary}`, ...command.usage.slice(1).filter((line) => !line.includes(" app.") && !line.includes(":")).map((line) => `  \`${line}\``)]),
    "",
    "Settings groups (`waifus help GROUP`, `waifus list GROUP`):",
    "",
    ...SETTING_GROUPS.map((group) => `- \`${group.id}\` — ${group.summary}`),
    "",
    "Topics:",
    "",
    ...RESOURCE_TOPICS.map((topic) => `- \`${topic.id}\` — ${topic.summary}`),
    "",
    "A key's help: `waifus help app.life.maxSendsPerTurn` (app keys also as `life.maxSendsPerTurn`)."
  ].join("\n");
}

export function topicMarkdown(resolved: ResolvedTopic, summary?: RouteSummary): string {
  switch (resolved.kind) {
    case "index":
      return indexMarkdown();
    case "group":
      return groupMarkdown(resolved.group, summary);
    case "subtree":
      return [`# ${resolved.group.id}.${resolved.prefix}`, "", ...keyTable(resolved.group, resolved.keys), "", `CLI: \`waifus set ${targetExample(resolved.group)} ${resolved.prefix}.KEY VALUE\`.`].join("\n");
    case "key":
      return keyMarkdown(resolved.group, resolved.key);
    case "resource":
      return resourceMarkdown(resolved.topic, summary);
    case "command":
      return commandMarkdown(resolved.command);
  }
}

/** The generated KB page: every settings group with its keys, the topics and the CLI. */
export function settingsKbMarkdown(): string {
  return [
    "# Settings, help and the CLI",
    "",
    "Every setting, with its type, default and what it does; generated from the settings registry (do not edit by hand: run `npm run docs:settings:generate`). Read and write any of them over HTTP (the routes below) or with `waifus get|set|unset`; `GET /api/help/<topic>` and `waifus help <topic>` show the same help.",
    "",
    "Targets: `app`, `assistant`, `remote-access`, `waifu:<id>`, `server:<guildId>`, `channel:<guildId>/<channelId>`, `bot:<house|id>`, `provider:<id>`. Secrets (`apiKey`, `token`) are write-only and never go on the command line.",
    "",
    ...SETTING_GROUPS.flatMap((group) => [groupMarkdown(group, undefined, { heading: "##" }), ""]),
    "## Topics",
    "",
    ...RESOURCE_TOPICS.flatMap((topic) => [`### ${topic.title} (\`${topic.id}\`)`, "", topic.description, "", ...routeLines(topic.routes), ...(topic.cli.length ? ["", ...topic.cli.map((line) => `- \`${line}\``)] : []), ""]),
    "## Commands",
    "",
    ...COMMANDS.map((command) => `- \`${command.usage.join("` · `")}\` — ${command.summary}`),
    ""
  ].join("\n");
}
