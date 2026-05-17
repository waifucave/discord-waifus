import { useEffect, useState } from "react";
import { api, openEventStream } from "../api/client";
import type { StatusResponse } from "../api/types";

type Listener = (status: StatusResponse | undefined) => void;

class RuntimeStore {
  private current: StatusResponse | undefined;
  private listeners = new Set<Listener>();
  private es: EventSource | undefined;
  private pollTimer: number | undefined;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.refresh();
    try {
      this.es = openEventStream();
      this.es.addEventListener("runtime", (ev) => {
        try {
          const parsed = JSON.parse((ev as MessageEvent).data);
          // backend sends RuntimeState shape; merge what we need into status
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
          // ignore parse errors
        }
      });
      this.es.onerror = () => {
        // fall back to polling silently; SSE errors are noisy in dev
      };
    } catch {
      // ignore EventSource availability errors
    }
    this.pollTimer = window.setInterval(() => void this.refresh(), 5_000);
  }

  stop(): void {
    this.started = false;
    this.es?.close();
    this.es = undefined;
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
