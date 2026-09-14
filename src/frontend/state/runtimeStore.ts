import { useEffect, useState } from "react";
import { api, openEventStream } from "../api/client";
import type { ResumableEventFeed } from "../api/resumableEventFeed";
import type { RuntimeState, StatusResponse } from "../api/types";

type Listener = (status: StatusResponse | undefined) => void;

export type RuntimeFeedAction =
  | { type: "reset" }
  | { type: "event"; event: string; data: string };

export function reduceRuntimeFeed(
  current: StatusResponse | undefined,
  action: RuntimeFeedAction
): StatusResponse | undefined {
  if (action.type === "reset") return undefined;
  if (action.event !== "runtime" && action.event !== "snapshot") return current;
  let parsed: unknown;
  try {
    parsed = JSON.parse(action.data);
  } catch {
    return current;
  }
  const runtime = action.event === "snapshot"
    ? (parsed as { runtime?: unknown } | undefined)?.runtime
    : parsed;
  const value = runtime as Partial<RuntimeState> | undefined;
  if (!value || typeof value !== "object") return current;
  return {
    running: true,
    paused: Boolean(value.paused),
    httpUrl: `http://127.0.0.1:${value.port ?? 3888}`,
    dataRoot: value.dataRoot ?? "",
    discord: value.discord ?? {
      connected: false,
      orchestratorConnected: false,
      waifuBotCount: 0,
      warnings: []
    },
    queues: value.queues ?? { active: 0, configuredGuilds: 0 }
  };
}

export class RuntimeStore {
  private current: StatusResponse | undefined;
  private listeners = new Set<Listener>();
  private feed: ResumableEventFeed | undefined;
  private pollTimer: number | undefined;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.refresh();
    try {
      this.feed = openEventStream({
        onReset: () => {
          this.applyFeed({ type: "reset" });
          void this.refresh();
        },
        onEvent: (event) => {
          this.applyFeed({ type: "event", event: event.event, data: event.data });
        },
        onError: () => {
          // Polling below remains the quiet fallback while the feed reconnects.
        }
      });
    } catch {
      // Polling below remains available when streaming cannot be constructed.
    }
    this.pollTimer = window.setInterval(() => void this.refresh(), 5_000);
  }

  private applyFeed(action: RuntimeFeedAction): void {
    const next = reduceRuntimeFeed(this.current, action);
    if (next === this.current) return;
    this.current = next;
    this.emit();
  }

  stop(): void {
    this.started = false;
    this.feed?.close();
    this.feed = undefined;
    if (this.pollTimer !== undefined) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  async refresh(): Promise<void> {
    try {
      const next = await api.status();
      this.current = next;
      this.emit();
    } catch {
      // leave existing value; offline state surfaces in UI
    }
  }

  get(): StatusResponse | undefined {
    return this.current;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.current);
  }
}

export const runtimeStore = new RuntimeStore();

export function useRuntimeStatus(): StatusResponse | undefined {
  const [status, setStatus] = useState<StatusResponse | undefined>(runtimeStore.get());
  useEffect(() => {
    runtimeStore.start();
    return runtimeStore.subscribe(setStatus);
  }, []);
  return status;
}
