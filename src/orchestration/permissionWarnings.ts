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

/**
 * Spec 9.5: a Discord send failure that is a final answer for this reply rather than a crash.
 * 50083 (thread archived) -> unavailable/thread_archived; 200000/200001 (AutoMod blocked the
 * message) -> blocked/automod. Anything else is undefined (the caller rethrows).
 */
export function classifyDiscordSendError(
  error: unknown
): { status: "unavailable"; reason: "thread_archived" } | { status: "blocked"; reason: "automod" } | undefined {
  const code = (error as { code?: number } | undefined)?.code;
  if (code === 50083) return { status: "unavailable", reason: "thread_archived" };
  if (code === 200000 || code === 200001) return { status: "blocked", reason: "automod" };
  return undefined;
}

export class PermissionWarningTracker {
  private readonly warnings = new Map<string, string>();

  record(guildId: string, channelId: string, botLabel: string, error: unknown, o: { thread?: boolean } = {}): void {
    if (!isPermissionError(error)) return;
    const message = error instanceof Error ? error.message : String(error);
    const where = o.thread ? "thread" : "channel";
    const hint = o.thread ? " (in a thread this needs Send Messages in Threads, and View Channel on the parent)" : "";
    this.warnings.set(
      `${guildId}:${channelId}`,
      `${botLabel} cannot send in ${where} ${channelId} (${message}) — check the ${where} permissions in Discord${hint}; replies resume automatically once fixed.`
    );
  }

  resolve(guildId: string, channelId: string): void {
    this.warnings.delete(`${guildId}:${channelId}`);
  }

  list(): string[] {
    return [...this.warnings.values()];
  }
}
