// Help topics (overhaul spec §10.4): one resolver for `GET /api/help/:topic`, `waifus help TOPIC`
// and the KB generator. Order: a settings group, a resource topic, a command (`cli.<name>` or the
// bare name), a key by full id, a part of a group, then the app shorthand (`life.maxSendsPerTurn`).

import { COMMANDS, commandSpec } from "./commands.js";
import { allKeyInfos, groupKeyInfos } from "./introspect.js";
import { RESOURCE_TOPICS, SETTING_GROUPS, settingGroup } from "./registry.js";
import type { CommandSpec, KeyInfo, ResourceTopic, SettingGroup } from "./types.js";

export type ResolvedTopic =
  | { kind: "index" }
  | { kind: "group"; group: SettingGroup }
  | { kind: "subtree"; group: SettingGroup; prefix: string; keys: KeyInfo[] }
  | { kind: "key"; group: SettingGroup; key: KeyInfo }
  | { kind: "resource"; topic: ResourceTopic }
  | { kind: "command"; command: CommandSpec };

function subtree(group: SettingGroup, prefix: string): ResolvedTopic | undefined {
  const keys = groupKeyInfos(group).filter((info) => info.path.startsWith(`${prefix}.`));
  return keys.length > 0 ? { kind: "subtree", group, prefix, keys } : undefined;
}

export function resolveTopic(raw: string | undefined): ResolvedTopic | undefined {
  const topic = (raw ?? "").trim();
  if (!topic || topic === "index" || topic === "help") return { kind: "index" };
  const group = settingGroup(topic);
  if (group) return { kind: "group", group };
  const resource = RESOURCE_TOPICS.find((entry) => entry.id === topic);
  if (resource) return { kind: "resource", topic: resource };
  const command = commandSpec(topic.startsWith("cli.") ? topic.slice(4) : topic);
  if (command) return { kind: "command", command };
  for (const candidate of SETTING_GROUPS) {
    if (!topic.startsWith(`${candidate.id}.`)) continue;
    const path = topic.slice(candidate.id.length + 1);
    const key = groupKeyInfos(candidate).find((info) => info.path === path);
    if (key) return { kind: "key", group: candidate, key };
    const part = subtree(candidate, path);
    if (part) return part;
  }
  const app = settingGroup("app")!;
  const key = groupKeyInfos(app).find((info) => info.path === topic);
  if (key) return { kind: "key", group: app, key };
  return subtree(app, topic);
}

/** Every topic name the resolver knows (for suggestions and the docs). */
export function topicNames(): string[] {
  const names = new Set<string>();
  for (const group of SETTING_GROUPS) names.add(group.id);
  for (const topic of RESOURCE_TOPICS) names.add(topic.id);
  for (const command of COMMANDS) names.add(command.name);
  for (const info of allKeyInfos()) {
    names.add(info.id);
    const segments = info.path.split(".");
    for (let index = 1; index < segments.length; index += 1) names.add(`${info.group}.${segments.slice(0, index).join(".")}`);
  }
  return [...names].sort();
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** Up to three close topic names (edit distance ≤ 2 on the last segment, or a prefix match). */
export function suggestTopics(raw: string): string[] {
  const wanted = raw.trim().toLowerCase();
  if (!wanted) return [];
  const scored = topicNames().map((name) => {
    const lower = name.toLowerCase();
    const tail = lower.split(".").pop() ?? lower;
    const distance = Math.min(editDistance(wanted, lower), editDistance(wanted.split(".").pop() ?? wanted, tail));
    return { name, distance: lower.includes(wanted) ? Math.min(distance, 1) : distance };
  });
  return scored
    .filter((entry) => entry.distance <= 2)
    .sort((a, b) => a.distance - b.distance || a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((entry) => entry.name);
}
