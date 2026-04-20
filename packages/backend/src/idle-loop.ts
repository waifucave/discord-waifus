import type { ChannelConfig } from "./types/index.js";
import type { Orchestrator } from "./orchestrator.js";

export class IdleLoop {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly orchestrator: Orchestrator) {}

  startForChannel(channelId: string, config: ChannelConfig): void {
    this.stopForChannel(channelId);
    this.scheduleRandom(channelId, config);
  }

  resetForChannel(channelId: string, config: ChannelConfig): void {
    this.stopForChannel(channelId);
    this.scheduleRandom(channelId, config);
  }

  snoozeForChannel(channelId: string, config: ChannelConfig, seconds: number): void {
    this.stopForChannel(channelId);
    this.scheduleAfter(channelId, config, seconds * 1_000);
  }

  stopForChannel(channelId: string): void {
    const timer = this.timers.get(channelId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(channelId);
    }
  }

  stopAll(): void {
    for (const channelId of this.timers.keys()) {
      this.stopForChannel(channelId);
    }
  }

  private scheduleRandom(channelId: string, config: ChannelConfig): void {
    if (!config.idleChatterEnabled) {
      return;
    }

    const min = config.idleTimerMinSeconds * 1_000;
    const max = config.idleTimerMaxSeconds * 1_000;
    this.scheduleAfter(channelId, config, randomBetween(min, max));
  }

  private scheduleAfter(channelId: string, config: ChannelConfig, delayMs: number): void {
    const timer = setTimeout(async () => {
      try {
        await this.orchestrator.handleIdleTrigger(channelId);
      } finally {
        if (this.timers.get(channelId) === timer) {
          this.scheduleRandom(channelId, config);
        }
      }
    }, delayMs);

    this.timers.set(channelId, timer);
  }
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
