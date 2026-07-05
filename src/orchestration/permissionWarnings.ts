/**
 * Persistent, self-clearing warnings for Discord permission failures. A send that dies with
 * 50001/50013 used to burn retriggers silently (see the 2026-07-05 #secret-room outage) —
 * these surface on /api/runtime (dashboard status strip + Norma's get_runtime_status) until
 * a send in that channel succeeds again.
 */
export function isPermissionError(error: unknown): boolean {
  const code = (error as { code?: number } | undefined)?.code;
  if (code === 50001 || code === 50013) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /missing access|missing permissions/i.test(message);
}

export class PermissionWarningTracker {
  private readonly warnings = new Map<string, string>();

  record(guildId: string, channelId: string, botLabel: string, error: unknown): void {
    if (!isPermissionError(error)) return;
    const message = error instanceof Error ? error.message : String(error);
    this.warnings.set(
      `${guildId}:${channelId}`,
      `${botLabel} cannot send in channel ${channelId} (${message}) — check the channel permissions in Discord; replies resume automatically once fixed.`
    );
  }

  resolve(guildId: string, channelId: string): void {
    this.warnings.delete(`${guildId}:${channelId}`);
  }

  list(): string[] {
    return [...this.warnings.values()];
  }
}
