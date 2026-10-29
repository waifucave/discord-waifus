// Deterministic checks on text a waifu sends (Living cast spec §6.3), kept from the retired reply
// path (verbosity.ts typing delay, outputValidator.ts / replyMarker.ts outbound checks). No LLM
// reviewer. `SendMessage` (L2) is their caller.

import { stripLeakedContextHeader } from "../discord/normalization.js";

const MS_PER_CHAR = 30;
const MIN_DELAY_MS = 600;
const MAX_DELAY_MS = 4500;
/** The longest typing before one message. */
export const MAX_TYPING_DELAY_MS = MAX_DELAY_MS;

/** How long to show "typing…" before sending `text`: 30 ms per character, 0.6–4.5 s. */
export function typingDelayMs(text: string): number {
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, text.length * MS_PER_CHAR));
}

// A copied transcript header at the very start (`[14:02 #k3]`, `[14:03 #k4 ↩#a1]` from before §22,
// `[14:05]`), with the name and reply mark after it when there is one (`[14:03 #k4] Kevin ↩#a1:`).
const LEADING_TRANSCRIPT_HEADER_RE = /^\s*\[\d{1,2}:\d{2}(?: #[0-9a-z]{2,8})?(?: ↩[^\]\n]{1,40})?\](?:[ \t]+[^\n:\[\]]{1,40} ↩[^\s:\]]{1,40}:)?[ \t]*/;

/** Removes up to four leading copied transcript headers. */
export function stripLeadingTranscriptHeader(raw: string): string {
  let text = raw;
  for (let i = 0; i < 4; i += 1) {
    const next = text.replace(LEADING_TRANSCRIPT_HEADER_RE, "");
    if (next === text) break;
    text = next;
  }
  return text;
}

/**
 * Check 1: strips a leading copied `[HH:MM #ref] Name:` header (her own name after it included),
 * the shape a model copies from `ReadMessages` output.
 */
export function stripCopiedHeader(text: string, selfNames: readonly string[]): string {
  const withoutHeader = stripLeadingTranscriptHeader(text);
  return stripLeakedContextHeader(withoutHeader, { selfDisplayNames: [...selfNames], stripImpersonation: false }).trim();
}

const TOOL_CALL_TAG_RE = /^\s*<(?:tool_call|function_call|tool_use|invoke)\b[\s\S]*<\/(?:tool_call|function_call|tool_use|invoke)>\s*$/i;

/**
 * Check 2: true when the text is nothing but tool-call syntax — a JSON object/array, a
 * `<tool_call>…</tool_call>` block, or `tool_name({...})` / `tool_name: {...}` for one of `toolNames`.
 * Such text is rejected rather than sent.
 */
export function isOnlyToolCallSyntax(text: string, toolNames: readonly string[] = []): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (TOOL_CALL_TAG_RE.test(trimmed)) return true;
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") return true;
    } catch {
      // not JSON
    }
  }
  for (const name of toolNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^${escaped}\\s*(?:\\(|:)\\s*[\\[{][\\s\\S]*[\\]}]\\s*\\)?\\s*$`, "i").test(trimmed)) return true;
  }
  return false;
}
