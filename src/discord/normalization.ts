import { GuildEmojiCacheEntry, GuildMemberCacheEntry } from "../shared/schemas/domain.js";

const USER_MENTION_RE = /<@!?(\d+)>/g;
const MODEL_USER_MENTION_RE = /<@([^>]+)>/g;
const DISCORD_CUSTOM_EMOJI_RE = /<(a?):([A-Za-z0-9_]+):(\d+)>/g;
const MODEL_CUSTOM_EMOJI_RE =
  /<(a?):([A-Za-z0-9_]+):>|(?<![A-Za-z0-9_<]):([A-Za-z0-9_]{2,32}):(?![A-Za-z0-9_>])/g;
const ROLE_MENTION_RE = /<@&(\d+)>/g;

export type NormalizationResult = {
  content: string;
  warnings: string[];
};

export type ModelVisibleRole = {
  id: string;
  name: string;
};

export type DenormalizationResult = NormalizationResult & {
  allowedMentions: {
    parse?: [];
    users: string[];
    roles: [];
    repliedUser: false;
  };
};

export function normalizeDiscordContentForModel(
  content: string,
  cache: {
    members?: GuildMemberCacheEntry[];
    emojis?: GuildEmojiCacheEntry[];
    roles?: ModelVisibleRole[];
  }
): NormalizationResult {
  const warnings: string[] = [];
  const memberById = new Map((cache.members ?? []).map((member) => [member.userId, member]));
  const emojiById = new Map((cache.emojis ?? []).map((emoji) => [emoji.id, emoji]));
  const roleById = new Map((cache.roles ?? []).map((role) => [role.id, role]));

  let normalized = content.replace(USER_MENTION_RE, (_raw, userId: string) => {
    const member = memberById.get(userId);
    if (!member) {
      warnings.push(`Unknown user mention ${userId} was hidden from model context.`);
      return "@unknown-user";
    }
    return `<@${modelVisibleMemberName(member)}>`;
  });

  normalized = normalized.replace(
    DISCORD_CUSTOM_EMOJI_RE,
    (_raw, animatedMarker: string, name: string, emojiId: string) => {
      const emoji = emojiById.get(emojiId);
      if (!emoji || !emoji.available) {
        warnings.push(`Unknown or unavailable custom emoji ${name} was converted to plain text.`);
        return `:${name}:`;
      }
      const marker = emoji.animated ? "a" : "";
      return `<${marker}:${emoji.name}:>`;
    }
  );

  normalized = normalized.replace(ROLE_MENTION_RE, (_raw, roleId: string) => {
    const role = roleById.get(roleId);
    if (role) {
      return `<@${role.name}>`;
    }
    warnings.push("Role mention was hidden from model context.");
    return "@unknown-role";
  });

  return { content: normalized, warnings };
}

export function denormalizeModelContentForDiscord(
  content: string,
  cache: {
    members?: GuildMemberCacheEntry[];
    emojis?: GuildEmojiCacheEntry[];
    activeAuthorIds?: string[];
  }
): DenormalizationResult {
  const warnings: string[] = [];
  const allowedUsers = new Set<string>();
  const activeIds = new Set(cache.activeAuthorIds ?? []);
  const membersByName = groupMembersByModelName(cache.members ?? []);
  const emojis = cache.emojis ?? [];
  const modelMentionRe = modelUserMentionRe(cache.members ?? []);

  const resolveModelMention = (raw: string, displayName: string) => {
    const candidates = membersByName.get(displayName.trim().toLowerCase()) ?? [];
    const activeCandidates = candidates.filter((member) => activeIds.has(member.userId));
    const resolved =
      activeCandidates.length === 1
        ? activeCandidates[0]
        : candidates.length === 1
          ? candidates[0]
          : undefined;

    if (!resolved) {
      warnings.push(`Model mention ${raw} could not be resolved uniquely and was left unpinged.`);
      return `@${displayName}`;
    }
    allowedUsers.add(resolved.userId);
    return `<@${resolved.userId}>`;
  };

  let denormalized = sanitizeMassMentions(content).replace(
    modelMentionRe,
    (
      raw,
      validDisplayName: string | undefined,
      prefix: string | undefined,
      marker: string | undefined,
      malformedDisplayName: string | undefined
    ) => {
      if (validDisplayName !== undefined) {
        return resolveModelMention(raw, validDisplayName);
      }
      return `${prefix ?? ""}${resolveModelMention(`${marker}${malformedDisplayName}`, malformedDisplayName ?? "")}`;
    }
  );

  denormalized = denormalized
    .replace(ROLE_MENTION_RE, "@role")
    .replace(MODEL_CUSTOM_EMOJI_RE, (raw, _animatedMarker: string, modelName: string, plainName: string) => {
      const name = modelName ?? plainName;
      const emoji = findClosestAvailableEmoji(name, emojis);
      if (!emoji) {
        warnings.push(`Model emoji ${raw} is not in the cached server emoji list.`);
        return `:${name}:`;
      }
      if (emoji.name.toLowerCase() !== name.toLowerCase()) {
        warnings.push(`Model emoji ${raw} was corrected to :${emoji.name}:.`);
      }
      const marker = emoji.animated ? "a" : "";
      return `<${marker}:${emoji.name}:${emoji.id}>`;
    });

  return {
    content: denormalized,
    warnings,
    allowedMentions: {
      ...(allowedUsers.size === 0 ? { parse: [] as [] } : {}),
      users: [...allowedUsers],
      roles: [],
      repliedUser: false
    }
  };
}

const LEADING_BRACKET_TAG_RE = /^\s*\[[A-Za-z_][A-Za-z0-9 _-]*:[^\]\n]*\]\s*/;
const INLINE_LEAKED_HEADER_RE =
  /(?<=\n)[ \t]*\[(?:timestamp|sender|index):[^\]\n]*\][ \t]*(?:\[[A-Za-z_][A-Za-z0-9 _-]*:[^\]\n]*\][ \t]*)*/gi;
const ORPHAN_META_LINE_RE = /(?<=\n)[ \t]*\[(?:replying to|reactions):[^\]\n]*\][ \t]*(?=\n)/gi;
const COLLAPSE_BLANK_LINES_RE = /\n{3,}/g;
const LEGACY_LEADING_INDEX_RE = /^\s*#\d+\b[ \t]*/;
const LEGACY_LEADING_TIMESTAMP_RE = /^\s*\[(?:just now|yesterday|\d+\s+(?:min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\s+ago)\][ \t]*/i;
const LEGACY_LEADING_REPLY_LINE_RE = /^\s*reply_to:[^\n]*(?:\r?\n|$)/i;
const LEGACY_LEADING_REACTIONS_LINE_RE = /^\s*reactions:[^\n]*(?:\r?\n|$)/i;
const TRAILING_BRACKET_TAG_RE = /\s*\[[A-Za-z_][A-Za-z0-9 _-]*:[^\]\n]*\]\s*$/;
const LEADING_WHITESPACE_RE = /^[ \t\r\n]+/;
const TRAILING_WHITESPACE_RE = /[ \t\r\n]+$/;
const ANALYSIS_CLOSE_TAG_RE = /<\/(?:analysis|thinking|reasoning|thought|scratchpad)>/gi;
const LEADING_ANALYSIS_OPEN_TAG_RE = /^\s*<(?:analysis|thinking|reasoning|thought|scratchpad)\b[^>]*>\s*/i;
const META_ANALYSIS_LEAK_RE =
  /^\s*(?:the readable data,\s*parsed|(?:analysis|reasoning|thoughts?|scratchpad|response draft|draft reply|actual reply|message to send)\s*:)/i;
const DRAFT_MARKER_RE =
  /(?:response draft|draft reply|actual reply|final reply|final answer|message to send)\s*:\s*/gi;

export function stripLeakedContextHeader(
  content: string,
  options: {
    senderDisplayName?: string;
    participantDisplayNames?: string[];
    stripImpersonation?: boolean;
  } = {}
): string {
  let text = content;
  const escapedSender = options.senderDisplayName
    ? options.senderDisplayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : null;
  const senderPrefixRe = escapedSender ? new RegExp(`^\\s*${escapedSender}\\s*:[ \\t]*`, "i") : null;

  const leadingPatterns = [
    LEADING_WHITESPACE_RE,
    LEADING_BRACKET_TAG_RE,
    LEGACY_LEADING_INDEX_RE,
    LEGACY_LEADING_TIMESTAMP_RE,
    LEGACY_LEADING_REPLY_LINE_RE,
    LEGACY_LEADING_REACTIONS_LINE_RE,
    ...(senderPrefixRe ? [senderPrefixRe] : [])
  ];

  let changed = true;
  let safety = 32;
  while (changed && safety-- > 0) {
    changed = false;
    for (const re of leadingPatterns) {
      const next = text.replace(re, "");
      if (next !== text) {
        text = next;
        changed = true;
      }
    }
    const trailingNext = text
      .replace(TRAILING_BRACKET_TAG_RE, "")
      .replace(TRAILING_WHITESPACE_RE, "");
    if (trailingNext !== text) {
      text = trailingNext;
      changed = true;
    }
  }
  text = stripInlineLeakedContextEntries(text);
  text = stripLeakedModelAnalysis(text);
  if (options.stripImpersonation === false) return text;
  return stripImpersonationLines(text, options.senderDisplayName, options.participantDisplayNames);
}

function stripImpersonationLines(
  content: string,
  senderDisplayName: string | undefined,
  participantDisplayNames: string[] | undefined
): string {
  if (!senderDisplayName && !participantDisplayNames?.length) return content;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const senderRe = senderDisplayName
    ? new RegExp(`^\\s*${escape(senderDisplayName)}\\s*:[ \\t]*`, "i")
    : null;
  const otherRes: RegExp[] = [];
  const seen = new Set<string>();
  for (const name of participantDisplayNames ?? []) {
    const trimmed = name?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (senderDisplayName && key === senderDisplayName.toLowerCase()) continue;
    otherRes.push(new RegExp(`^\\s*${escape(trimmed)}\\s*:`, "i"));
  }
  if (!senderRe && otherRes.length === 0) return content;
  const lines = content.split("\n");
  const kept: string[] = [];
  let skippingIndentedOtherSpeakerBody = false;
  for (const line of lines) {
    if (senderRe && senderRe.test(line)) {
      skippingIndentedOtherSpeakerBody = false;
      kept.push(line.replace(senderRe, ""));
      continue;
    }
    const otherMatch = otherRes.find((re) => re.test(line));
    if (otherMatch) {
      skippingIndentedOtherSpeakerBody = line.replace(otherMatch, "").trim().length === 0;
      continue;
    }
    if (skippingIndentedOtherSpeakerBody) {
      if (line.trim().length === 0) {
        skippingIndentedOtherSpeakerBody = false;
      } else if (/^\s/.test(line)) {
        continue;
      } else {
        skippingIndentedOtherSpeakerBody = false;
      }
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripInlineLeakedContextEntries(content: string): string {
  const before = content;
  let text = content
    .replace(INLINE_LEAKED_HEADER_RE, "")
    .replace(ORPHAN_META_LINE_RE, "");
  if (text === before) return content;
  text = text.replace(COLLAPSE_BLANK_LINES_RE, "\n\n");
  return text.trim();
}

function stripLeakedModelAnalysis(content: string): string {
  let text = content.trim();

  const closingTags = [...text.matchAll(ANALYSIS_CLOSE_TAG_RE)];
  const lastClosingTag = closingTags.at(-1);
  if (lastClosingTag?.index !== undefined) {
    text = text.slice(lastClosingTag.index + lastClosingTag[0].length).trim();
  }

  text = text.replace(LEADING_ANALYSIS_OPEN_TAG_RE, "").trim();
  if (!META_ANALYSIS_LEAK_RE.test(text) && !/<(?:analysis|thinking|reasoning|thought|scratchpad)\b/i.test(text)) {
    return text;
  }

  const draftMarkers = [...text.matchAll(DRAFT_MARKER_RE)];
  const lastDraftMarker = draftMarkers.at(-1);
  if (lastDraftMarker?.index !== undefined) {
    return text.slice(lastDraftMarker.index + lastDraftMarker[0].length).trim();
  }

  return "";
}

export function modelVisibleMemberName(member: GuildMemberCacheEntry): string {
  return member.guildDisplayName ?? member.globalDisplayName ?? member.username ?? "unknown-user";
}

export function modelVisibleEmojiToken(emoji: GuildEmojiCacheEntry): string {
  return `<${emoji.animated ? "a" : ""}:${emoji.name}:>`;
}

function groupMembersByModelName(members: GuildMemberCacheEntry[]): Map<string, GuildMemberCacheEntry[]> {
  const map = new Map<string, GuildMemberCacheEntry[]>();
  for (const member of members) {
    const key = modelVisibleMemberName(member).trim().toLowerCase();
    const entries = map.get(key) ?? [];
    entries.push(member);
    map.set(key, entries);
  }
  return map;
}

function modelUserMentionRe(members: GuildMemberCacheEntry[]): RegExp {
  const names = modelVisibleMemberNames(members);
  if (!names.length) return MODEL_USER_MENTION_RE;
  const namePattern = names.map(escapeRegExp).join("|");
  return new RegExp(`${MODEL_USER_MENTION_RE.source}|(^|[^A-Za-z0-9_<])(<@|@)(${namePattern})(?=$|[\\s.,!?;:)\\]}])`, "gi");
}

function modelVisibleMemberNames(members: GuildMemberCacheEntry[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const member of members) {
    const name = modelVisibleMemberName(member).trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names.sort((a, b) => b.length - a.length);
}

function findClosestAvailableEmoji(
  name: string,
  emojis: GuildEmojiCacheEntry[]
): GuildEmojiCacheEntry | undefined {
  const normalizedName = name.toLowerCase();
  const exactMatch = emojis.find(
    (emoji) => emoji.available && emoji.name.toLowerCase() === normalizedName
  );
  if (exactMatch) return exactMatch;

  let fuzzyMatch: GuildEmojiCacheEntry | undefined;

  for (const emoji of emojis) {
    if (!emoji.available) continue;
    const normalizedCandidate = emoji.name.toLowerCase();
    if (
      Math.min(normalizedName.length, normalizedCandidate.length) < 4 ||
      !isSingleEmojiNameEdit(normalizedName, normalizedCandidate)
    ) {
      continue;
    }
    if (fuzzyMatch && fuzzyMatch.name.toLowerCase() !== normalizedCandidate) {
      return undefined;
    }
    fuzzyMatch = emoji;
  }

  return fuzzyMatch;
}

function isSingleEmojiNameEdit(left: string, right: string): boolean {
  const lengthDifference = Math.abs(left.length - right.length);
  if (lengthDifference > 1) return false;

  if (left.length === right.length) {
    const mismatches: number[] = [];
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) {
        mismatches.push(index);
        if (mismatches.length > 2) return false;
      }
    }
    if (mismatches.length === 1) return true;
    if (mismatches.length !== 2) return false;
    const [first, second] = mismatches;
    return (
      second === first + 1 &&
      left[first] === right[second] &&
      left[second] === right[first]
    );
  }

  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  let shorterIndex = 0;
  let longerIndex = 0;
  let skipped = false;

  while (shorterIndex < shorter.length && longerIndex < longer.length) {
    if (shorter[shorterIndex] === longer[longerIndex]) {
      shorterIndex += 1;
      longerIndex += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    longerIndex += 1;
  }

  return true;
}

function sanitizeMassMentions(content: string): string {
  return content.replace(/@everyone/g, "@ everyone").replace(/@here/g, "@ here");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
