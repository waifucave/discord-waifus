import type { FastifyInstance, FastifyRequest } from "fastify";

/** Shared, synchronous admission gate. No asynchronous idle-check/start race. */
export class UpdateActivity {
  private active = 0;
  private lastActivity: number;
  private sealedUntil = 0;
  private stopping = false;

  constructor(private readonly now: () => number = Date.now) {
    this.lastActivity = now();
  }

  begin(touch = true): (() => void) | undefined {
    if (this.stopping || this.sealedUntil > this.now()) return undefined;
    this.sealedUntil = 0;
    this.active++;
    if (touch) this.lastActivity = this.now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      if (touch) this.lastActivity = this.now();
    };
  }

  snapshot() {
    return { active: this.active, idleMs: Math.max(0, this.now() - this.lastActivity),
      prepared: this.sealedUntil > this.now(), stopping: this.stopping };
  }

  prepare(idleMs: number, busy: boolean): boolean {
    if (busy || this.active !== 0 || this.snapshot().idleMs < idleMs || this.stopping) return false;
    this.sealedUntil = this.now() + 15_000;
    return true;
  }

  cancel(): void { this.sealedUntil = 0; }

  commit(busy: boolean): boolean {
    if (busy || !this.snapshot().prepared || this.active !== 0) return false;
    this.stopping = true;
    return true;
  }
}

// Passive polling and subscriptions are not conversations. Finite polling requests are still
// counted in flight, but don't reset the quiet window; live assistant POSTs remain tracked.
export function passiveUpdateRequest(method: string, url: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const target = url.split("?", 1)[0];
  return /^\/api\/(?:health|status|runtime|updates|logs|queries|replies|events|operations(?:\/[^/]+)?|remote-access(?:\/diagnostics)?|client-context)$/.test(target)
    || /^\/api\/assistant\/conversations\/[^/]+\/stream$/.test(target)
    || /^\/_waifus_remote\/(?:resume-state|frame-keepalive|v1\/(?:bootstrap|events))$/.test(target);
}

export function installUpdateActivity(app: FastifyInstance, activity: UpdateActivity): void {
  const leases = new WeakMap<FastifyRequest, { release: () => void; started: boolean; handled: boolean; responded: boolean }>();
  const finish = (request: FastifyRequest) => {
    const lease = leases.get(request);
    if (lease?.handled && lease.responded) lease.release();
  };
  app.addHook("onRoute", options => {
    const handler = options.handler;
    options.handler = async function(request, reply) {
      const lease = leases.get(request);
      if (lease) lease.started = true;
      try { return await handler.call(this, request, reply); }
      finally {
        const lease = leases.get(request);
        if (lease) lease.handled = true;
        finish(request);
      }
    };
  });
  app.addHook("onRequest", async (request, reply) => {
    const target = request.url.split("?", 1)[0];
    // Subscription liveness alone doesn't hold an update hostage.
    if (request.method === "GET" && (target === "/api/events" || target === "/_waifus_remote/v1/events"
      || /^\/api\/assistant\/conversations\/[^/]+\/stream$/.test(target))) return;
    const release = activity.begin(!passiveUpdateRequest(request.method, request.url));
    if (!release) return reply.code(503).header("retry-after", "15").send({
      error: "UpdateInProgress", message: "An idle update is restarting Waifus. Retry shortly."
    });
    const lease = { release, started: false, handled: false, responded: false };
    leases.set(request, lease);
    reply.raw.once("close", () => { lease.responded = true; finish(request); });
  });
  app.addHook("onResponse", async request => {
    const lease = leases.get(request);
    if (lease) lease.responded = true;
    finish(request);
  });
  // Authentication/validation failures can end a request without invoking its handler.
  app.addHook("onSend", async (request, _reply, payload) => {
    const lease = leases.get(request);
    if (lease && !lease.started) lease.handled = true;
    return payload;
  });
}
