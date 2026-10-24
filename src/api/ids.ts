import { badRequest } from "./errors.js";

// Ids become path segments under the data root. The character class alone admitted "." and
// "..", so `DELETE /api/servers/%2E%2E` (Fastify decodes it to "..") resolved to `user/` and
// removed every user file. Dot-only ids are rejected here; resolveDataPath also refuses any
// path that escapes the data root as a second line of defence.
export function assertSafeId(id: string): void {
  if (typeof id !== "string" || !/^[A-Za-z0-9._:-]+$/.test(id) || /^\.+$/.test(id)) {
    throw badRequest(`Invalid id: ${id}`);
  }
}

// Guild, channel and user ids always come from Discord, so anything but a snowflake is malformed.
export function assertSnowflakeId(id: string): void {
  if (typeof id !== "string" || !/^\d{17,20}$/.test(id)) {
    throw badRequest(`Invalid Discord id: ${id}`);
  }
}
