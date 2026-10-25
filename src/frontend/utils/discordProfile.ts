// What the Cast editor's "Discord profile" section says about her bot's profile sync (Living cast
// §17). Pure, so it is testable without a DOM.

import type { DiscordProfileStatus } from "../api/types";
import type { NoticeTone } from "../components/Notice";

const FIELD_LABEL: Record<string, string> = {
  username: "Username",
  avatar: "Avatar",
  banner: "Banner",
  bio: "Bio",
  nickname: "Nickname"
};

/** "34 min", "2 h 5 min", "less than a minute". */
export function waitLabel(untilIso: string, now: number): string {
  const minutes = Math.ceil((Date.parse(untilIso) - now) / 60_000);
  if (!(minutes > 0)) return "less than a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function list(fields: string[]): string {
  const labels = fields.map((field) => FIELD_LABEL[field] ?? field);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)!.toLowerCase()}`;
}

/** One line for the sync state, with its tone. */
export function profileStatusLine(status: DiscordProfileStatus, now: number): { tone: NoticeTone; text: string } {
  switch (status.state) {
    case "no_bot":
      return { tone: "info", text: "She has no bot of her own yet. Link one above; her profile is set on it once it connects." };
    case "bot_missing":
      return { tone: "warn", text: "Her bot entry is missing. Set it up in Settings → App (Discord bots)." };
    case "shared_bot":
      return { tone: "info", text: "Another waifu uses the same bot, so the app leaves its profile alone." };
    case "offline":
      return {
        tone: "info",
        text: status.pendingFields.length
          ? `Her bot is offline. ${list(status.pendingFields)} will be set when it connects.`
          : "Her bot is offline. Her profile is checked again when it connects."
      };
    case "synced":
      return { tone: "ok", text: "Synced: her bot shows this profile." };
    case "rate_limited": {
      const waiting = status.pendingFields.filter((field) => status.retryAfterByField[field]);
      const until = status.retryAfter ?? Object.values(status.retryAfterByField).sort()[0];
      const subject = waiting.length === 1 ? `${list(waiting)} change` : `${list(waiting)} changes`;
      return {
        tone: "warn",
        text: `${subject} waiting for Discord's rate limit${until ? ` (try again in ${waitLabel(until, now)})` : ""}. The app retries on its own.`
      };
    }
    case "error":
      return { tone: "err", text: `Discord refused the change: ${status.lastError ?? "unknown error"}` };
    case "pending":
    default:
      return { tone: "info", text: `Syncing ${list(status.pendingFields).toLowerCase()}…` };
  }
}

/** "PNG · 120 KB · on Discord". */
export function imageLabel(image: DiscordProfileStatus["images"]["avatar"]): string {
  if (!image) return "none uploaded";
  const kb = image.bytes < 1024 * 1024 ? `${Math.max(1, Math.round(image.bytes / 1024))} KB` : `${(image.bytes / (1024 * 1024)).toFixed(1)} MB`;
  const type = image.contentType.replace(/^image\//u, "").toUpperCase().replace("JPEG", "JPG");
  return `${type} · ${kb}${image.synced ? " · on Discord" : ""}`;
}
