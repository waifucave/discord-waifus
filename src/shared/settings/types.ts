// Settings registry types (overhaul spec §10.2, reused by Living cast §14.2). Zod-free except for
// type imports, so the dashboard and the CLI's help path can load them cheaply.
import type { z } from "zod";

export type HttpMethod = "GET" | "PUT" | "POST" | "DELETE";
export type RouteRef = { method: HttpMethod; path: string };

/** How a write is guarded: `required` (409/428), `optional`, a uint64 string (Remote Access), or none. */
export type RevisionRule = "required" | "optional" | "uint64-string" | "none";

/** When a change takes effect: at once, after the runtime reload the write triggers, or at the next start. */
export type Applies = "live" | "reload" | "restart";

export type IdKind = "safe-id" | "snowflake" | "snowflake-pair" | "bot" | "provider";

export type KeyHelp = {
  /** One or two sentences: what it does, in the owner's terms. */
  help: string;
  /** A short human name for forms ("Turns at once"); the dotted path stays the key. */
  label?: string;
  /** Never shown or accepted on the command line (read from an environment variable or stdin). */
  secret?: true;
  /** Shown but not writable (ids, timestamps). */
  readOnly?: true;
  /** Only the host itself may change it (not a paired remote device). */
  localOnlyWrite?: true;
  /** Hidden from a paired remote device. */
  remoteHidden?: true;
  /** `unset` sends `null`, which removes the stored value. */
  nullUnset?: true;
  /** `null` is a real value (no limit, no budget); `unset` restores the default. */
  nullIsValue?: true;
  /** An object or a list written whole (as JSON on the command line). */
  leaf?: true;
  applies?: Applies;
  /** A value the CLI accepts for this key (used in help and by the round-trip test). */
  example?: string;
  /** Units or format shown next to the type ("ms", "USD", "HH:mm"). */
  unit?: string;
};

export type SettingGroupId = "app" | "waifu" | "server" | "channel" | "assistant" | "bot" | "provider" | "remote-access";

export type SettingGroup = {
  id: SettingGroupId;
  title: string;
  summary: string;
  description: string;
  /** `singleton` targets are named by the group id; `id` targets by `<group>:<id>`. */
  target: { kind: "singleton" } | { kind: "id"; idName: string; idKind: IdKind; example: string };
  /** Where it is stored, relative to the data root. */
  storage: string;
  list?: RouteRef;
  read: RouteRef;
  write: RouteRef & { revision: RevisionRule };
  /** The stored/read schema whose leaves are the keys. */
  schema: z.ZodType;
  /** Every settable or shown leaf, by dotted path. */
  keys: Record<string, KeyHelp>;
  /** Schema leaves that are not settings of this group, with the reason (`channels` → the channel group). */
  excluded: Record<string, string>;
  /** A parsed record holding every default (absent keys have none). */
  defaults?: () => unknown;
  notes?: string[];
};

/** A non-settings topic (life, usage, forget, …): its routes and CLI commands. */
export type ResourceTopic = { id: string; title: string; summary: string; description: string; routes: RouteRef[]; cli: string[] };

/** Everything the help needs about one key, computed from the schema and the registry. */
export type KeyInfo = {
  group: SettingGroupId;
  path: string;
  /** `app.life.maxSendsPerTurn`, `waifu.dm.sleepNotice`. */
  id: string;
  type: "boolean" | "integer" | "number" | "string" | "enum" | "string-list" | "json";
  enum?: string[];
  min?: number;
  /** `min` itself is not allowed (a positive amount: more than 0). */
  minExclusive?: true;
  max?: number;
  maxLength?: number;
  nullable: boolean;
  default?: unknown;
  help: string;
  label?: string;
  flags: Omit<KeyHelp, "help" | "label" | "example" | "unit">;
  example?: string;
  unit?: string;
};

/** A CLI command (data only): `waifus <name> …`. */
export type CommandSpec = {
  name: string;
  summary: string;
  usage: string[];
  description?: string;
  /** Flags the command takes besides the global ones. */
  flags?: Array<{ name: string; value?: string; help: string }>;
  topic?: string;
  /** Lifecycle commands start or stop processes; the others talk to the host or read help. */
  lifecycle?: true;
};
