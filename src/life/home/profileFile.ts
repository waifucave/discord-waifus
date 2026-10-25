// `~/profile.json` (Living cast spec §17.1): her Discord profile as a file in her home, the same
// values as her config's `username`, `bio` and `nicknames` (the dashboard, CLI and HTTP fields).
// Her write is checked like her other special files and then becomes her config; a change from the
// dashboard rewrites the file. Her plain `name` is shown for reference and can't be changed here.
// Nicknames are keyed by the server as her places name it (`bake-club`, the first part of a room's
// handle in places.md); a server id works too.

import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  DISCORD_BIO_MAX,
  discordNicknameProblem,
  discordUsernameProblem
} from "../../shared/constants/discordProfile.js";
import { ServerConfigSchema, WaifuConfigSchema, type ServerConfig, type WaifuConfig } from "../../shared/schemas/domain.js";
import type { StorageService } from "../../storage/storageService.js";
import { slugify } from "../places.js";
import { JsonSyntaxError, parseStrictJson } from "./specialFiles.js";

export const PROFILE_FILE_NAME = "profile.json";

/** Her profile fields as the config stores them (guild ids as nickname keys). */
export type ProfileFields = {
  username?: string;
  bio?: string;
  nicknames?: Record<string, string>;
};

export type ProfileServer = { guildId: string; name?: string };

/** Every configured server (the ones her rooms are in, and any other the owner set up). */
export async function profileServers(storage: StorageService): Promise<ProfileServer[]> {
  let entries: string[];
  try {
    entries = await readdir(path.join(storage.dataRoot, "user", "servers"));
  } catch {
    return [];
  }
  const out: ProfileServer[] = [];
  for (const entry of entries) {
    if (!/^\d{5,25}$/u.test(entry)) continue;
    const server: ServerConfig | undefined = await storage
      .readJson(path.join("user", "servers", entry, "server.json"), ServerConfigSchema)
      .catch(() => undefined);
    if (server) out.push({ guildId: server.guildId, ...(server.name ? { name: server.name } : {}) });
  }
  return out;
}

/** A server's key in her file: its slug when that names one server only, else its id. */
function serverKey(guildId: string, servers: readonly ProfileServer[]): string {
  const server = servers.find((candidate) => candidate.guildId === guildId);
  const slug = slugify(server?.name);
  if (!slug) return guildId;
  return servers.filter((candidate) => slugify(candidate.name) === slug).length === 1 ? slug : guildId;
}

/** Her profile file, from her config. */
export function profileFileText(waifu: Pick<WaifuConfig, "name"> & ProfileFields, servers: readonly ProfileServer[]): string {
  const nicknames: Record<string, string> = {};
  for (const [guildId, nick] of Object.entries(waifu.nicknames ?? {}).sort(([a], [b]) => a.localeCompare(b))) nicknames[serverKey(guildId, servers)] = nick;
  const file = {
    name: waifu.name,
    username: waifu.username ?? null,
    bio: waifu.bio ?? null,
    nicknames
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Whether the file and her config say the same (her own layout is kept when they do). */
export function sameProfile(a: ProfileFields, b: ProfileFields): boolean {
  const norm = (fields: ProfileFields) =>
    JSON.stringify({
      username: fields.username ?? null,
      bio: fields.bio ?? null,
      nicknames: Object.entries(fields.nicknames ?? {}).sort(([x], [y]) => x.localeCompare(y))
    });
  return norm(a) === norm(b);
}

/**
 * Her checked file becomes her config (username, bio, nicknames replaced whole). Returns whether her
 * config changed. Taken under her waifu lock, inside her home lock (never the other way round).
 */
export async function saveProfileToConfig(storage: StorageService, waifuId: string, fields: ProfileFields): Promise<boolean> {
  const relativePath = path.join("user", "waifus", waifuId, "waifu.json");
  const current = await storage.readJson(relativePath, WaifuConfigSchema);
  if (sameProfile(current, fields)) return false;
  await storage.updateRevisionedJson({
    resourceKey: `waifu:${waifuId}`,
    relativePath,
    schema: WaifuConfigSchema,
    fallback: current,
    transform: (latest) => {
      const { username: _username, bio: _bio, nicknames: _nicknames, ...rest } = latest;
      return { ...rest, username: fields.username, bio: fields.bio, nicknames: fields.nicknames };
    }
  });
  return true;
}

export type ProfileCheck = { ok: true; fields: ProfileFields } | { ok: false; error: string };

const FILE = PROFILE_FILE_NAME;
const KEYS = ["name", "username", "bio", "nicknames"];

/** Resolves a nickname key she wrote to a server id. */
function resolveServer(key: string, servers: readonly ProfileServer[]): { ok: true; guildId: string } | { ok: false; error: string } {
  const trimmed = key.trim();
  if (/^\d{17,20}$/u.test(trimmed)) return { ok: true, guildId: trimmed };
  const wanted = slugify(trimmed.replace(/^#/u, "").split("/")[0]);
  const matches = wanted ? servers.filter((server) => slugify(server.name) === wanted) : [];
  if (matches.length === 1) return { ok: true, guildId: matches[0]!.guildId };
  const known = [...new Set(servers.map((server) => slugify(server.name)).filter(Boolean))].slice(0, 6);
  if (matches.length > 1) return { ok: false, error: `error: ${FILE} nicknames: more than one server is called "${trimmed}"; use its id instead` };
  return {
    ok: false,
    error: `error: ${FILE} nicknames: there is no server called "${trimmed}"; use a server as your places name it (the part before /# in places.md)${known.length ? `, like ${known.join(", ")}` : ""}`
  };
}

/** Checks her file; on success, the fields her config gets. Nothing is saved on an error. */
export function checkProfileText(text: string, ctx: { name: string; servers: readonly ProfileServer[] }): ProfileCheck {
  if (text.trim() === "") return { ok: false, error: `error: ${FILE} can't be empty; it holds your username, bio and nicknames (Read it to see the layout)` };
  let value: unknown;
  try {
    value = parseStrictJson(text);
  } catch (error) {
    if (error instanceof JsonSyntaxError) return { ok: false, error: `error: ${FILE} line ${error.position.line}, column ${error.position.column}: ${error.message}` };
    throw error;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: `error: ${FILE} must be one JSON object, like {"name": "${ctx.name}", "username": "…", "bio": "…", "nicknames": {}}` };
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !KEYS.includes(key));
  if (unknown.length > 0) return { ok: false, error: `error: ${FILE}: unknown field ${unknown.map((key) => `"${key}"`).join(", ")}; it holds name, username, bio and nicknames` };
  if ("name" in record && record["name"] !== ctx.name) {
    return { ok: false, error: `error: ${FILE} name: your name is ${ctx.name} and can't be changed here (change username for your Discord name); leave it as "${ctx.name}"` };
  }
  const fields: ProfileFields = {};
  const username = record["username"];
  if (username !== undefined && username !== null && username !== "") {
    if (typeof username !== "string") return { ok: false, error: `error: ${FILE} username must be text (or null for your display name)` };
    const problem = discordUsernameProblem(username);
    if (problem) return { ok: false, error: `error: ${FILE} username: ${problem}` };
    fields.username = username.trim();
  }
  const bio = record["bio"];
  if (bio !== undefined && bio !== null && bio !== "") {
    if (typeof bio !== "string") return { ok: false, error: `error: ${FILE} bio must be text (or null)` };
    if (bio.length > DISCORD_BIO_MAX) return { ok: false, error: `error: ${FILE} bio has ${bio.length} characters; at most ${DISCORD_BIO_MAX}` };
    fields.bio = bio;
  }
  const nicknames = record["nicknames"];
  if (nicknames !== undefined && nicknames !== null) {
    if (typeof nicknames !== "object" || Array.isArray(nicknames)) return { ok: false, error: `error: ${FILE} nicknames must be an object of server → nickname, like {"bake-club": "Ari"}` };
    const out: Record<string, string> = {};
    for (const [key, nick] of Object.entries(nicknames as Record<string, unknown>)) {
      if (typeof nick !== "string") return { ok: false, error: `error: ${FILE} nicknames "${key}" must be text` };
      const problem = discordNicknameProblem(nick);
      if (problem) return { ok: false, error: `error: ${FILE} nicknames "${key}": ${problem}` };
      const server = resolveServer(key, ctx.servers);
      if (!server.ok) return server;
      if (out[server.guildId] !== undefined) return { ok: false, error: `error: ${FILE} nicknames: "${key}" names a server that is already listed` };
      out[server.guildId] = nick.trim();
    }
    if (Object.keys(out).length > 0) fields.nicknames = out;
  }
  return { ok: true, fields };
}
