import { useEffect, useState } from "react";
import { api, openEventStream } from "../api/client";
import type { ResumableEventFeed } from "../api/resumableEventFeed";
import type { StatusResponse } from "../api/types";

type Listener = (status: StatusResponse | undefined) => void;

class RuntimeStore {
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
        onEvent: (event) => {
          if (event.event !== "runtime" && event.event !== "snapshot") return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data);
          } catch {
            return;
          }
          const runtime = event.event === "snapshot"
            ? (parsed as { runtime?: unknown } | undefined)?.runtime
            : parsed;
          this.applyRuntime(runtime);
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

  private applyRuntime(value: unknown): void {
    try {
      const parsed = value as Record<string, any> | undefined;
      if (parsed && typeof parsed === "object") {
        this.current = {
          running: true,
          paused: Boolean(parsed.paused),
          httpUrl: `http://127.0.0.1:${parsed.port ?? 3888}`,
          dataRoot: parsed.dataRoot ?? "",
          discord: parsed.discord ?? {
            connected: false,
            orchestratorConnected: false,
            waifuBotCount: 0,
            warnings: []
          },
          queues: parsed.queues ?? { active: 0, configuredGuilds: 0 }
        };
        this.emit();
      }
    } catch {
      // Ignore malformed stream payloads; polling remains authoritative.
    }
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
