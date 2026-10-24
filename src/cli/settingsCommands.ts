// `waifus help | list | get | set | unset` (overhaul spec §10.5, Living cast §14.2): every setting of
// the registry, read and written through the running host's HTTP API (`app` also offline, straight
// in config.toml). One adapter per settings group turns the registry's dotted keys into that
// group's read and write requests; a test checks there is one for every group.

import { loadAppConfig, updateAppConfig } from "../config/appConfig.js";
import { redactSecrets } from "../backend/redaction.js";
import { UpdateAppConfigBodySchema } from "../shared/schemas/config.js";
import { coerceValue, getPath, groupKeyInfos, mergePatches, nestedPatch, typeLabel } from "../shared/settings/introspect.js";
import { SETTING_GROUPS, settingGroup } from "../shared/settings/registry.js";
import { topicMarkdown } from "../shared/settings/render.js";
import { resolveTopic, suggestTopics } from "../shared/settings/topics.js";
import type { KeyInfo, SettingGroup, SettingGroupId } from "../shared/settings/types.js";
import { hostInstanceState } from "../storage/instanceLock.js";
import { processIsAlive } from "./processState.js";
import { processStartTime } from "../storage/instanceLock.js";
import { call, CliFailure, display, EXIT, HOST_NOT_RUNNING, requireHost, usageError, type CliContext, type ExitCode } from "./cliContext.js";
import type { HostTransport } from "./hostClient.js";

export type Target = { group: SettingGroup; id?: string; label: string };

const SNOWFLAKE = /^\d{17,20}$/u;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/u;

/** `app`, `waifu:aria`, `channel:<guild>/<channel>`, … */
export function parseTarget(raw: string): Target {
  const colon = raw.indexOf(":");
  const groupId = colon < 0 ? raw : raw.slice(0, colon);
  const id = colon < 0 ? undefined : raw.slice(colon + 1);
  const group = settingGroup(groupId);
  if (!group) throw usageError(`Unknown target ${raw}.`, `Targets: ${SETTING_GROUPS.map((entry) => (entry.target.kind === "singleton" ? entry.id : `${entry.id}:<id>`)).join(", ")}.`);
  if (group.target.kind === "singleton") {
    if (id !== undefined) throw usageError(`${group.id} takes no id.`);
    return { group, label: group.id };
  }
  if (!id) throw usageError(`${group.id} needs an id: ${group.id}:<${group.target.idName}> (e.g. ${group.id}:${group.target.example}).`);
  const valid =
    group.target.idKind === "snowflake"
      ? SNOWFLAKE.test(id)
      : group.target.idKind === "snowflake-pair"
        ? /^\d{17,20}\/\d{17,20}$/u.test(id)
        : SAFE_ID.test(id) && !/^\.+$/u.test(id);
  if (!valid) throw usageError(`Invalid ${group.target.idName}: ${id}.`);
  return { group, id, label: `${group.id}:${id}` };
}

/**
 * The TARGET [KEY] of get/set/unset, also as one dotted word for singleton groups
 * (`app.life.maxSendsPerTurn`, `assistant.model`).
 */
export function splitTargetAndKey(args: readonly string[]): { target: Target; keys: string[] } {
  const [first, ...rest] = args;
  if (!first) throw usageError("Name a target, like app or waifu:aria.");
  const dot = first.indexOf(".");
  if (dot > 0 && !first.includes(":")) {
    const group = settingGroup(first.slice(0, dot));
    if (group && group.target.kind === "singleton") return { target: parseTarget(group.id), keys: [first.slice(dot + 1), ...rest] };
  }
  return { target: parseTarget(first), keys: rest };
}

export function keyOf(target: Target, path: string): KeyInfo {
  const info = groupKeyInfos(target.group).find((candidate) => candidate.path === path);
  if (!info) {
    const reason = target.group.excluded[path];
    if (reason) throw usageError(`${path} is not a ${target.group.id} setting. ${reason}`);
    const near = suggestTopics(`${target.group.id}.${path}`).filter((name) => name.startsWith(`${target.group.id}.`));
    // Never echo something that looks like a secret (a key pasted where a key name belongs).
    const shown = redactSecrets(path) !== path || path.length > 80 ? "(not shown)" : path;
    throw usageError(`Unknown ${target.group.id} key: ${shown}.`, near.length ? `Did you mean ${near.map((name) => name.slice(target.group.id.length + 1)).join(", ")}? See waifus list ${target.group.id}.` : `See waifus list ${target.group.id}.`);
  }
  return info;
}

type Change = { info: KeyInfo; value: unknown; unset: boolean };

/** One settings group's reads and writes over HTTP. `view` keys are the registry paths. */
export type GroupAdapter = {
  read(ctx: CliContext, target: Target): Promise<{ view: Record<string, unknown>; revision?: number | string }>;
  write(ctx: CliContext, target: Target, changes: Change[]): Promise<{ view: Record<string, unknown>; revision?: number | string }>;
  /** Existing targets of the group (`waifus list waifu` with the host running). */
  list?(host: HostTransport): Promise<string[]>;
};

function stripEnvelope(record: Record<string, unknown>): Record<string, unknown> {
  const { schemaVersion: _version, revision: _revision, updatedAt: _updated, ...rest } = record;
  return rest;
}

function patchOf(changes: readonly Change[]): Record<string, unknown> {
  return changes.reduce<Record<string, unknown>>((patch, change) => mergePatches(patch, nestedPatch(change.info.path, change.value)), {});
}

/** What `unset` sends: null for a key that takes it, else the default (or a usage error). */
function unsetValue(info: KeyInfo): unknown {
  if (info.flags.nullUnset) return null;
  if (info.default !== undefined) return info.default;
  if (info.nullable) return null;
  throw usageError(`${info.id} has no default to go back to; set a value instead.`);
}

/** A revisioned GET → PUT, re-read and re-applied on a 409 (up to 3 times). */
async function revisioned(
  host: HostTransport,
  o: { readPath: string; writePath: string; what: string; body: (current: Record<string, unknown>) => Record<string, unknown>; revisionOf?: (current: Record<string, unknown>) => unknown }
): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt += 1) {
    const current = await host({ method: "GET", path: o.readPath });
    const record = current.status === 404 ? {} : current.status === 200 ? (current.body as Record<string, unknown>) : undefined;
    if (!record) throw (await import("./cliContext.js")).httpFailure(current, o.what);
    const revision = o.revisionOf ? o.revisionOf(record) : record["revision"];
    const response = await host({ method: "PUT", path: o.writePath, body: { ...o.body(record), ...(revision !== undefined ? { revision } : {}) } });
    if (response.status === 409 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.floor(Math.random() * 200)));
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw (await import("./cliContext.js")).httpFailure(response, o.what);
    return response.body as Record<string, unknown>;
  }
}

const enc = encodeURIComponent;

async function hostIsStarting(dataRoot: string): Promise<boolean> {
  const state = await hostInstanceState(dataRoot, { isAlive: processIsAlive, startTime: (pid) => processStartTime(pid) }).catch(() => undefined);
  return state?.state === "starting" || state?.state === "running";
}

export const ADAPTERS: Record<SettingGroupId, GroupAdapter> = {
  app: {
    async read(ctx) {
      const host = await ctx.host();
      if (host) return { view: stripEnvelope((await call(host, { method: "GET", path: "/api/config" }, "Reading app settings")).body) };
      return { view: stripEnvelope(await loadAppConfig(ctx.dataRoot)) };
    },
    async write(ctx, _target, changes) {
      const patch = patchOf(changes.map((change) => ({ ...change, value: change.unset && change.info.flags.nullUnset ? null : change.value })));
      const host = await ctx.host();
      if (host) return { view: stripEnvelope((await call(host, { method: "PUT", path: "/api/config", body: patch }, "Saving app settings")).body) };
      // Offline: config.toml directly, only while no host is starting on this data root.
      if (changes.some((change) => change.info.path === "updates.enabled")) {
        throw usageError("With the host stopped, turn idle updates on or off with waifus update --auto on|off (it also checks the installation).");
      }
      const parsed = UpdateAppConfigBodySchema.safeParse(patch);
      if (!parsed.success) throw new CliFailure(EXIT.usage, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
      if (await hostIsStarting(ctx.dataRoot)) throw new CliFailure(EXIT.host, "A host is starting on this data root (or runs without answering yet); try again in a moment.");
      return { view: stripEnvelope(await updateAppConfig(ctx.dataRoot, parsed.data)) };
    }
  },
  waifu: {
    async read(ctx, target) {
      const body = (await call(await requireHost(ctx), { method: "GET", path: `/api/waifus/${enc(target.id!)}` }, `Reading ${target.label}`)).body;
      return { view: stripEnvelope(body), revision: body["revision"] as number };
    },
    async write(ctx, target, changes) {
      const host = await requireHost(ctx);
      const saved = await revisioned(host, { readPath: `/api/waifus/${enc(target.id!)}`, writePath: `/api/waifus/${enc(target.id!)}`, what: `Saving ${target.label}`, body: () => patchOf(changes) });
      return { view: stripEnvelope(saved), revision: saved["revision"] as number };
    },
    async list(host) {
      const body = (await call<{ waifus: Array<{ id: string }> }>(host, { method: "GET", path: "/api/waifus" }, "Listing waifus")).body;
      return body.waifus.map((waifu) => `waifu:${waifu.id}`);
    }
  },
  server: {
    async read(ctx, target) {
      const body = (await call(await requireHost(ctx), { method: "GET", path: `/api/servers/${target.id!}` }, `Reading ${target.label}`)).body;
      return { view: stripEnvelope(body), revision: body["revision"] as number };
    },
    async write(ctx, target, changes) {
      const host = await requireHost(ctx);
      const body = changes.reduce<Record<string, unknown>>(
        (patch, change) => (change.info.path === "detector.target" && change.unset ? { ...patch, detector: null } : mergePatches(patch, nestedPatch(change.info.path, change.value))),
        {}
      );
      const saved = await revisioned(host, { readPath: `/api/servers/${target.id!}`, writePath: `/api/servers/${target.id!}`, what: `Saving ${target.label}`, body: () => body });
      return { view: stripEnvelope(saved), revision: saved["revision"] as number };
    },
    async list(host) {
      const body = (await call<{ servers: Array<{ guildId: string; channels?: Record<string, unknown> }> }>(host, { method: "GET", path: "/api/servers" }, "Listing servers")).body;
      return body.servers.map((server) => `server:${server.guildId}`);
    }
  },
  channel: {
    async read(ctx, target) {
      const [guildId, channelId] = target.id!.split("/") as [string, string];
      const body = (await call<{ revision: number; channels?: Record<string, Record<string, unknown>> }>(await requireHost(ctx), { method: "GET", path: `/api/servers/${guildId}` }, `Reading ${target.label}`)).body;
      const channel = body.channels?.[channelId];
      if (!channel) throw new CliFailure(EXIT.rejected, `${target.label} is not configured yet; set a key to add it.`);
      return { view: channel, revision: body.revision };
    },
    async write(ctx, target, changes) {
      const [guildId, channelId] = target.id!.split("/") as [string, string];
      const host = await requireHost(ctx);
      const body: Record<string, unknown> = {};
      for (const change of changes) {
        if (change.info.path === "threads" && change.unset) body["threads"] = "inherit";
        else body[change.info.path] = change.value;
      }
      const saved = await revisioned(host, { readPath: `/api/servers/${guildId}`, writePath: `/api/servers/${guildId}/channels/${channelId}`, what: `Saving ${target.label}`, body: () => body });
      const channels = (saved["channels"] ?? {}) as Record<string, Record<string, unknown>>;
      return { view: channels[channelId] ?? {}, revision: saved["revision"] as number };
    },
    async list(host) {
      const body = (await call<{ servers: Array<{ guildId: string; channels?: Record<string, unknown> }> }>(host, { method: "GET", path: "/api/servers" }, "Listing channels")).body;
      return body.servers.flatMap((server) => Object.keys(server.channels ?? {}).map((channelId) => `channel:${server.guildId}/${channelId}`));
    }
  },
  assistant: {
    async read(ctx) {
      const body = (await call(await requireHost(ctx), { method: "GET", path: "/api/assistant/config" }, "Reading the assistant's settings")).body;
      return { view: stripEnvelope(body), revision: body["revision"] as number };
    },
    async write(ctx, _target, changes) {
      const host = await requireHost(ctx);
      const saved = await revisioned(host, { readPath: "/api/assistant/config", writePath: "/api/assistant/config", what: "Saving the assistant's settings", body: () => patchOf(changes) });
      return { view: stripEnvelope(saved), revision: saved["revision"] as number };
    }
  },
  bot: {
    async read(ctx, target) {
      const body = (await call<Record<string, unknown>>(await requireHost(ctx), { method: "GET", path: "/api/discord-bots" }, "Reading Discord bots")).body;
      const bot = botEntry(body, target.id!);
      if (!bot) throw new CliFailure(EXIT.rejected, `${target.label} is not configured; set its displayName or token to add it.`);
      return { view: botView(bot), revision: body["revision"] as number };
    },
    async write(ctx, target, changes) {
      const host = await requireHost(ctx);
      const house = target.id === "house";
      const saved = await revisioned(host, {
        readPath: "/api/discord-bots",
        writePath: "/api/discord-bots",
        what: `Saving ${target.label}`,
        body: (current) => {
          const existing = botEntry(current, target.id!);
          const { tokenConfigured: _configured, tokenHint: _hint, token: _token, ...kept } = existing ?? {};
          let entry: Record<string, unknown> = { id: house ? "house" : target.id!, displayName: house ? "House" : target.id!, enabled: true, ...kept };
          for (const change of changes) {
            if (change.unset) {
              if (change.info.path === "token") throw usageError("A bot token cannot be unset; replace it, or remove the bot in the dashboard.");
              const { [change.info.path]: _removed, ...rest } = entry;
              entry = change.info.default !== undefined ? { ...rest, [change.info.path]: change.info.default } : rest;
            } else entry = { ...entry, [change.info.path]: change.value };
          }
          if (house) return { orchestrator: entry };
          const waifus = ((current["waifus"] ?? []) as Array<Record<string, unknown>>).map(({ tokenConfigured: _c, tokenHint: _h, token: _t, ...rest }) => rest);
          return { waifus: [...waifus.filter((bot) => bot["id"] !== target.id), entry] };
        }
      });
      const bot = botEntry(saved, target.id!);
      return { view: bot ? botView(bot) : {}, revision: saved["revision"] as number };
    },
    async list(host) {
      const body = (await call<{ orchestrator: unknown; waifus: Array<{ id: string }> }>(host, { method: "GET", path: "/api/discord-bots" }, "Listing bots")).body;
      return [...(body.orchestrator ? ["bot:house"] : []), ...body.waifus.map((bot) => `bot:${bot.id}`)];
    }
  },
  provider: {
    async read(ctx, target) {
      const body = (await call<{ providers: Array<Record<string, unknown>>; revision: number }>(await requireHost(ctx), { method: "GET", path: "/api/providers" }, "Reading providers")).body;
      const provider = body.providers.find((entry) => entry["id"] === target.id);
      if (!provider) throw new CliFailure(EXIT.rejected, `Unknown provider ${target.id}; see waifus list provider.`);
      return { view: providerView(provider), revision: body.revision };
    },
    async write(ctx, target, changes) {
      const host = await requireHost(ctx);
      const path = `/api/providers/${enc(target.id!)}/credentials`;
      const apiKey = changes.find((change) => change.info.path === "apiKey");
      if (apiKey?.unset) {
        if (changes.length > 1) throw usageError("Unset apiKey on its own.");
        const body = (await call(host, { method: "DELETE", path }, `Removing ${target.label}'s key`)).body;
        return { view: providerView({ credentials: body["credentials"] }), revision: body["revision"] as number };
      }
      if (!apiKey) throw usageError(`Setting ${target.label}'s label re-sends its key: give apiKey too (--from-env VAR or stdin).`);
      const label = changes.find((change) => change.info.path === "label");
      const body = (await call(host, { method: "PUT", path, body: { apiKey: apiKey.value, ...(label && !label.unset ? { label: label.value } : {}) } }, `Saving ${target.label}'s key`)).body;
      return { view: providerView({ credentials: body["credentials"] }), revision: body["revision"] as number };
    },
    async list(host) {
      const body = (await call<{ providers: Array<{ id: string }> }>(host, { method: "GET", path: "/api/providers" }, "Listing providers")).body;
      return body.providers.map((provider) => `provider:${provider.id}`);
    }
  },
  "remote-access": {
    async read(ctx) {
      const body = (await call<{ config: Record<string, unknown> }>(await requireHost(ctx), { method: "GET", path: "/api/remote-access" }, "Reading Remote Access")).body;
      const { revision, updatedAt: _updated, ...view } = body.config;
      return { view, revision: revision as string };
    },
    async write(ctx, _target, changes) {
      const host = await requireHost(ctx);
      const saved = await revisioned(host, {
        readPath: "/api/remote-access",
        writePath: "/api/remote-access",
        what: "Saving Remote Access",
        body: () => patchOf(changes),
        revisionOf: (current) => (current["config"] as Record<string, unknown> | undefined)?.["revision"]
      });
      // Turning it on or off answers 202 with an operation (the helper starts or drains on its own);
      // the saved setting is read back.
      if (typeof saved["operationId"] === "string") return ADAPTERS["remote-access"].read(ctx, _target);
      const config = (saved["config"] ?? saved) as Record<string, unknown>;
      const { revision, updatedAt: _updated, ...view } = config;
      return { view, ...(typeof revision === "string" ? { revision } : {}) };
    }
  }
};

function botEntry(file: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
  if (id === "house") return (file["orchestrator"] as Record<string, unknown> | null) ?? undefined;
  return ((file["waifus"] ?? []) as Array<Record<string, unknown>>).find((bot) => bot["id"] === id);
}

function botView(bot: Record<string, unknown>): Record<string, unknown> {
  const { tokenConfigured, tokenHint, token: _token, ...rest } = bot;
  return { ...rest, token: tokenConfigured ? `(set${tokenHint ? `, ${String(tokenHint)}` : ""})` : "(not set)" };
}

function providerView(provider: Record<string, unknown>): Record<string, unknown> {
  const credentials = (provider["credentials"] ?? {}) as Record<string, unknown>;
  return {
    apiKey: credentials["configured"] ? `(set${credentials["keyHint"] ? `, ${String(credentials["keyHint"])}` : ""})` : "(not set)",
    ...(credentials["label"] !== undefined ? { label: credentials["label"] } : {})
  };
}

// ---- commands ---------------------------------------------------------------------------------------

/** `waifus help [TOPIC]`: offline. An unknown topic is a usage error with suggestions. */
export function helpCommand(ctx: Pick<CliContext, "out" | "err">, topic: string | undefined): ExitCode {
  const resolved = resolveTopic(topic);
  if (!resolved) {
    const near = suggestTopics(topic ?? "");
    ctx.err(`No command or help topic "${topic}".${near.length ? ` Did you mean ${near.join(", ")}?` : ""} Run waifus help for the list.`);
    return EXIT.usage;
  }
  ctx.out(topicMarkdown(resolved));
  return EXIT.ok;
}

/** `waifus list [GROUP]`. */
export async function listCommand(ctx: CliContext, groupId: string | undefined): Promise<ExitCode> {
  if (!groupId) {
    const rows = SETTING_GROUPS.map((group) => ({ group: group.id, target: group.target.kind === "singleton" ? group.id : `${group.id}:<${group.target.idName}>`, summary: group.summary }));
    if (ctx.json) ctx.out(JSON.stringify({ groups: rows }, null, 2));
    else for (const row of rows) ctx.out(`${row.target.padEnd(32)} ${row.summary}`);
    return EXIT.ok;
  }
  const group = settingGroup(groupId);
  if (!group) throw usageError(`Unknown settings group ${groupId}.`, `Groups: ${SETTING_GROUPS.map((entry) => entry.id).join(", ")}.`);
  const keys = groupKeyInfos(group);
  const host = await ctx.host().catch(() => undefined);
  const targets = host && ADAPTERS[group.id].list ? await ADAPTERS[group.id].list!(host).catch(() => [] as string[]) : [];
  if (ctx.json) {
    ctx.out(JSON.stringify({ group: group.id, targets, keys: keys.map((info) => ({ key: info.path, type: typeLabel(info), default: info.default, help: info.help })) }, null, 2));
    return EXIT.ok;
  }
  if (targets.length > 0) ctx.out(`Targets: ${targets.join(", ")}\n`);
  for (const info of keys) {
    const fallback = info.default !== undefined && !info.flags.secret ? ` (default ${display(info.default)})` : "";
    ctx.out(`${info.path} — ${typeLabel(info)}${fallback}${info.flags.readOnly ? " [read-only]" : ""}${info.flags.secret ? " [secret]" : ""}`);
    ctx.out(`    ${info.help}`);
  }
  return EXIT.ok;
}

/** `waifus get TARGET [KEY]`. */
export async function getCommand(ctx: CliContext, args: readonly string[]): Promise<ExitCode> {
  const { target, keys } = splitTargetAndKey(args);
  if (keys.length > 1) throw usageError("get reads one key at a time (or the whole target).");
  const infos = keys.length === 1 ? [keyOf(target, keys[0]!)] : groupKeyInfos(target.group);
  const { view, revision } = await ADAPTERS[target.group.id].read(ctx, target);
  if (keys.length === 1) {
    const value = getPath(view, infos[0]!.path);
    if (ctx.json) ctx.out(JSON.stringify({ target: target.label, key: infos[0]!.path, value: value ?? null, ...(revision !== undefined ? { revision } : {}) }, null, 2));
    else ctx.out(display(value));
    return EXIT.ok;
  }
  const values = Object.fromEntries(infos.map((info) => [info.path, getPath(view, info.path)]));
  if (ctx.json) ctx.out(JSON.stringify({ target: target.label, ...(revision !== undefined ? { revision } : {}), values }, null, 2));
  else for (const info of infos) ctx.out(`${info.path} = ${display(values[info.path])}`);
  return EXIT.ok;
}

export type ValueSources = { fromEnv?: string; stdin?: boolean; file?: string };

/** A secret: from an environment variable, piped stdin or a hidden prompt; never argv. */
async function secretValue(ctx: CliContext, info: KeyInfo, sources: ValueSources): Promise<string> {
  if (sources.fromEnv) {
    const value = ctx.env[sources.fromEnv];
    if (!value) throw usageError(`Environment variable ${sources.fromEnv} is empty or unset.`);
    return value.trim();
  }
  const piped = await ctx.readStdin();
  if (piped !== undefined && piped.trim()) return piped.trim();
  if (ctx.ask) {
    const typed = (await ctx.ask(`${info.id}: `, { hidden: true })).trim();
    if (typed) return typed;
  }
  throw usageError(`${info.id} is secret: pass it with --from-env VAR or pipe it on stdin.`);
}

/** Parses `KEY VALUE` or `KEY=VALUE…` into changes (values typed and checked by the key). */
async function parseChanges(ctx: CliContext, target: Target, args: readonly string[], sources: ValueSources): Promise<Change[]> {
  const fromSource = sources.stdin || sources.file !== undefined;
  const pairs: Array<{ path: string; raw?: string }> = [];
  if (args.length === 0) throw usageError("Name a key to set.");
  const isSecretKey = (arg: string) => !arg.includes("=") && keyOf(target, arg).flags.secret === true;
  if (args.length === 2 && isSecretKey(args[0]!) && !args[1]!.includes("=")) {
    throw usageError(`${target.group.id}.${args[0]} is secret and never goes on the command line: use --from-env VAR or pipe it on stdin.`);
  }
  if (args.length === 2 && !args[0]!.includes("=") && !isSecretKey(args[0]!)) {
    // KEY VALUE (the value may itself contain "=").
    pairs.push({ path: args[0]!, raw: args[1]! });
  } else {
    // KEY=VALUE pairs; a bare KEY takes its value from --from-env, --stdin, --file or a prompt.
    for (const arg of args) {
      const index = arg.indexOf("=");
      if (index > 0) pairs.push({ path: arg.slice(0, index), raw: arg.slice(index + 1) });
      else if (index < 0) pairs.push({ path: arg });
      else throw usageError(`Missing key before "=" in ${arg}.`);
    }
    if (pairs.filter((pair) => pair.raw === undefined && !isSecretKey(pair.path)).length > (fromSource ? 1 : 0)) {
      throw usageError("Use KEY VALUE, or KEY=VALUE pairs (quote a value with spaces); --stdin or --file gives one key its value.");
    }
  }
  const changes: Change[] = [];
  for (const pair of pairs) {
    const info = keyOf(target, pair.path);
    if (info.flags.readOnly) throw usageError(`${info.id} is read-only.`);
    if (info.flags.secret) {
      if (pair.raw !== undefined) throw usageError(`${info.id} is secret and never goes on the command line: use --from-env VAR or pipe it on stdin.`);
      changes.push({ info, value: await secretValue(ctx, info, sources), unset: false });
      continue;
    }
    let raw = pair.raw;
    if (raw === undefined && fromSource) {
      raw = sources.file !== undefined ? await (await import("node:fs/promises")).readFile(sources.file, "utf8") : await ctx.readStdin();
      if (raw !== undefined && info.type !== "string") raw = raw.trim();
    }
    if (raw === undefined) throw usageError(`Give ${info.id} a value (${typeLabel(info)}).`);
    // A value that looks like a key or a token belongs in a secret key, never on the command line.
    if (redactSecrets(raw) !== raw) throw usageError(`That value looks like a secret; secrets never go on the command line.`);
    const coerced = coerceValue(info, raw);
    if (!coerced.ok) throw new CliFailure(EXIT.usage, coerced.error, { hint: `See waifus help ${info.id}.` });
    changes.push({ info, value: coerced.value, unset: false });
  }
  return changes;
}

function changedLines(target: Target, changes: readonly Change[], view: Record<string, unknown>, revision: number | string | undefined): string[] {
  const head = `updated ${target.label}${revision !== undefined ? ` (revision ${revision})` : ""}:`;
  return [head, ...changes.map((change) => `  ${change.info.path} = ${change.info.flags.secret ? "(saved)" : display(getPath(view, change.info.path))}`)];
}

/** `waifus set TARGET KEY VALUE | TARGET KEY=VALUE…`. */
export async function setCommand(ctx: CliContext, args: readonly string[], sources: ValueSources): Promise<ExitCode> {
  const { target, keys } = splitTargetAndKey(args);
  const changes = await parseChanges(ctx, target, keys, sources);
  const result = await ADAPTERS[target.group.id].write(ctx, target, changes);
  if (ctx.json) {
    ctx.out(JSON.stringify({ ok: true, target: target.label, ...(result.revision !== undefined ? { revision: result.revision } : {}), changed: changes.map((change) => change.info.path) }, null, 2));
  } else for (const line of changedLines(target, changes, result.view, result.revision)) ctx.out(line);
  return EXIT.ok;
}

/** `waifus unset TARGET KEY…`. */
export async function unsetCommand(ctx: CliContext, args: readonly string[]): Promise<ExitCode> {
  const { target, keys } = splitTargetAndKey(args);
  if (keys.length === 0) throw usageError("Name the key(s) to unset.");
  const changes = keys.map((path) => {
    const info = keyOf(target, path);
    if (info.flags.readOnly) throw usageError(`${info.id} is read-only.`);
    return { info, value: info.flags.secret ? undefined : unsetValue(info), unset: true };
  });
  const result = await ADAPTERS[target.group.id].write(ctx, target, changes);
  if (ctx.json) ctx.out(JSON.stringify({ ok: true, target: target.label, ...(result.revision !== undefined ? { revision: result.revision } : {}), changed: keys }, null, 2));
  else for (const line of changedLines(target, changes, result.view, result.revision)) ctx.out(line);
  return EXIT.ok;
}

export { HOST_NOT_RUNNING };
