import path from "node:path";
import { ModelCallError } from "../models/errors.js";

// Per-provider quota/billing cooldowns (spec 8.10, Living cast §9.1). A model call that fails with
// error kind `quota` or `billing` (src/models/errors.ts) opens a cooldown for that provider (10 / 30
// minutes); while it is open, calls fail fast with `provider_quota` / `provider_billing` and never
// reach the network. Surfaced to the dashboard through `/api/runtime.providerAlerts`.

export type ProviderAlertKind = "quota" | "billing";
export type ProviderAlert = { providerId: string; kind: ProviderAlertKind; until: string; lastMessage: string };

export const QUOTA_COOLDOWN_MS = 10 * 60_000;
export const BILLING_COOLDOWN_MS = 30 * 60_000;
const MAX_MESSAGE_CHARS = 300;

export class ProviderCooldownError extends ModelCallError {
  override name = "ProviderCooldownError";

  constructor(readonly alert: ProviderAlert) {
    super(alert.kind, `Provider ${alert.providerId} is cooling down after a ${alert.kind} error until ${alert.until}.`, {
      code: alert.kind === "billing" ? "provider_billing" : "provider_quota"
    });
  }
}

type Cooldown = { untilMs: number; lastMessage: string };

export type ProviderAlertsOptions = { now?: () => number; quotaMs?: number; billingMs?: number };

export class ProviderAlerts {
  private readonly cooldowns = new Map<string, Cooldown>(); // `${providerId}\0${kind}`
  private readonly now: () => number;
  private readonly durations: Record<ProviderAlertKind, number>;

  constructor(options: ProviderAlertsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.durations = { quota: options.quotaMs ?? QUOTA_COOLDOWN_MS, billing: options.billingMs ?? BILLING_COOLDOWN_MS };
  }

  /** Opens a cooldown when `error` is a quota/billing model error. Returns whether it did. */
  report(providerId: string, error: unknown): boolean {
    if (!(error instanceof ModelCallError) || error instanceof ProviderCooldownError) return false;
    if (error.kind !== "quota" && error.kind !== "billing") return false;
    const kind: ProviderAlertKind = error.kind;
    this.cooldowns.set(this.key(providerId, kind), {
      untilMs: this.now() + this.durations[kind],
      lastMessage: error.message.slice(0, MAX_MESSAGE_CHARS)
    });
    return true;
  }

  /** The error to throw instead of calling `providerId`, or undefined when it is available. */
  check(providerId: string): ProviderCooldownError | undefined {
    // billing outlasts quota, so it wins when both are open
    for (const kind of ["billing", "quota"] as const) {
      const alert = this.alertFor(providerId, kind);
      if (alert) return new ProviderCooldownError(alert);
    }
    return undefined;
  }

  /** How long `providerId` still cools down (ms), or undefined when it is available. */
  remainingMs(providerId: string): number | undefined {
    const error = this.check(providerId);
    return error ? Math.max(0, Date.parse(error.alert.until) - this.now()) : undefined;
  }

  assertAvailable(providerId: string): void {
    const error = this.check(providerId);
    if (error) throw error;
  }

  clear(providerId: string): void {
    for (const kind of ["quota", "billing"] as const) this.cooldowns.delete(this.key(providerId, kind));
  }

  /** Active cooldowns only (expired ones are pruned), for `/api/runtime.providerAlerts`. */
  snapshot(): ProviderAlert[] {
    const out: ProviderAlert[] = [];
    for (const key of [...this.cooldowns.keys()]) {
      const [providerId, kind] = key.split("\0") as [string, ProviderAlertKind];
      const alert = this.alertFor(providerId, kind);
      if (alert) out.push(alert);
    }
    return out.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.kind.localeCompare(b.kind));
  }

  private alertFor(providerId: string, kind: ProviderAlertKind): ProviderAlert | undefined {
    const key = this.key(providerId, kind);
    const entry = this.cooldowns.get(key);
    if (!entry) return undefined;
    if (entry.untilMs <= this.now()) {
      this.cooldowns.delete(key);
      return undefined;
    }
    return { providerId, kind, until: new Date(entry.untilMs).toISOString(), lastMessage: entry.lastMessage };
  }

  private key(providerId: string, kind: ProviderAlertKind): string {
    return `${providerId}\0${kind}`;
  }
}

const sharedAlerts = new Map<string, ProviderAlerts>();

/** The process-wide alert state for a data root (pipelines built without explicit alerts use it). */
export function sharedProviderAlerts(dataRoot: string): ProviderAlerts {
  const key = path.resolve(dataRoot);
  let alerts = sharedAlerts.get(key);
  if (!alerts) {
    alerts = new ProviderAlerts();
    sharedAlerts.set(key, alerts);
  }
  return alerts;
}
