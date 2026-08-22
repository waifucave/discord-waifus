import {
  asEventCursor,
  parseEventCursor,
  type EventCursor
} from "./eventCursor";

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const MAX_PENDING_SSE_CHARACTERS = 512 * 1024;

export type ParsedSseEvent = {
  event: string;
  data: string;
  id?: string;
};

export type ResumableEvent = ParsedSseEvent & {
  cursor?: EventCursor;
};

export type FeedReset = {
  reason: "epoch_mismatch" | "cursor_gap" | "invalid_cursor";
  detail?: unknown;
};

export type ResumableEventFeedOptions = {
  url: string;
  initialCursor?: string;
  fetchImpl?: typeof fetch;
  prepareHeaders?: () => HeadersInit | Promise<HeadersInit>;
  onEvent: (event: ResumableEvent) => void | Promise<void>;
  onReset?: (reset: FeedReset) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
  onResponseError?: (response: Response) => boolean | Promise<boolean>;
  reconnectDelayMs?: number;
};

/** Incremental UTF-8-safe SSE block parser. Feed decoded text chunks from one response. */
export class SseParser {
  private buffer = "";
  private eventName = "";
  private dataLines: string[] = [];
  private eventId: string | undefined;
  private eventCharacters = 0;

  push(text: string): ParsedSseEvent[] {
    this.buffer += text;
    if (this.buffer.length > MAX_PENDING_SSE_CHARACTERS) {
      throw new RangeError("SSE event exceeds the client buffer limit.");
    }
    const events: ParsedSseEvent[] = [];
    while (true) {
      const match = /\r\n|\r|\n/u.exec(this.buffer);
      if (!match || match.index === undefined) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.consumeLine(line, events);
    }
    return events;
  }

  finish(): ParsedSseEvent[] {
    const events: ParsedSseEvent[] = [];
    if (this.buffer) this.consumeLine(this.buffer, events);
    this.buffer = "";
    this.dispatch(events);
    return events;
  }

  private consumeLine(line: string, events: ParsedSseEvent[]): void {
    if (line === "") {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(":")) return;
    this.eventCharacters += line.length;
    if (this.eventCharacters > MAX_PENDING_SSE_CHARACTERS) {
      throw new RangeError("SSE event exceeds the client buffer limit.");
    }
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.eventName = value;
    else if (field === "data") this.dataLines.push(value);
    else if (field === "id" && !value.includes("\0")) this.eventId = value;
  }

  private dispatch(events: ParsedSseEvent[]): void {
    if (this.dataLines.length > 0) {
      events.push({
        event: this.eventName || "message",
        data: this.dataLines.join("\n"),
        ...(this.eventId !== undefined ? { id: this.eventId } : {})
      });
    }
    this.eventName = "";
    this.dataLines = [];
    this.eventId = undefined;
    this.eventCharacters = 0;
  }
}

class RestartFeedError extends Error {
  constructor() {
    super("Restarting event feed after a cursor discontinuity.");
    this.name = "RestartFeedError";
  }
}

/**
 * Same-origin credentialed SSE over fetch. Unlike EventSource, reconnects can carry an explicit
 * Last-Event-ID header and cancellation is owned by one AbortController lifecycle.
 */
export class ResumableEventFeed {
  private readonly fetchImpl: typeof fetch;
  private readonly reconnectDelayMs: number;
  private cursorValue: EventCursor | undefined;
  private lifecycle: AbortController | undefined;
  private runPromise: Promise<void> | undefined;

  constructor(private readonly options: ResumableEventFeedOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.reconnectDelayMs = boundedDelay(options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS);
    this.cursorValue = options.initialCursor === undefined
      ? undefined
      : asEventCursor(options.initialCursor);
  }

  get cursor(): EventCursor | undefined {
    return this.cursorValue;
  }

  get running(): boolean {
    return this.lifecycle !== undefined && !this.lifecycle.signal.aborted;
  }

  start(): void {
    if (this.lifecycle) return;
    const lifecycle = new AbortController();
    this.lifecycle = lifecycle;
    this.runPromise = this.run(lifecycle.signal).finally(() => {
      if (this.lifecycle === lifecycle) this.lifecycle = undefined;
    });
  }

  close(): void {
    this.lifecycle?.abort();
  }

  async settled(): Promise<void> {
    await this.runPromise;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let immediateRetry = false;
      try {
        const prepared = await this.options.prepareHeaders?.();
        const headers = new Headers(prepared);
        if (this.cursorValue) headers.set("Last-Event-ID", this.cursorValue);
        const response = await this.fetchImpl(this.options.url, {
          method: "GET",
          headers,
          credentials: "same-origin",
          cache: "no-store",
          signal
        });
        if (!response.ok) {
          immediateRetry = await this.options.onResponseError?.(response) === true;
          await response.body?.cancel().catch(() => undefined);
          if (!immediateRetry) throw new Error(`Event stream returned HTTP ${response.status}.`);
        } else {
          await this.consume(response, signal);
          if (!signal.aborted) throw new Error("Event stream ended unexpectedly.");
        }
      } catch (error) {
        if (signal.aborted) return;
        if (!(error instanceof RestartFeedError)) await this.options.onError?.(error);
      }
      if (!signal.aborted && !immediateRetry) {
        await abortableDelay(this.reconnectDelayMs, signal);
      }
    }
  }

  private async consume(response: Response, signal: AbortSignal): Promise<void> {
    if (!response.body) throw new Error("Event stream response has no body.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) {
          for (const event of parser.push(decoder.decode())) await this.accept(event);
          for (const event of parser.finish()) await this.accept(event);
          return;
        }
        const decoded = decoder.decode(chunk.value, { stream: true });
        for (const event of parser.push(decoded)) await this.accept(event);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private async accept(event: ParsedSseEvent): Promise<void> {
    if (event.event === "snapshot_required") {
      this.cursorValue = undefined;
      await this.options.onReset?.({ reason: resetReason(event.data), detail: parseJson(event.data) });
      return;
    }

    let cursor: EventCursor | undefined;
    if (event.id !== undefined && event.id !== "") {
      try {
        cursor = asEventCursor(event.id);
      } catch {
        this.cursorValue = undefined;
        await this.options.onReset?.({ reason: "invalid_cursor", detail: event.id });
        throw new RestartFeedError();
      }
    }

    if (event.event === "snapshot") {
      if (!cursor) {
        this.cursorValue = undefined;
        await this.options.onReset?.({ reason: "invalid_cursor", detail: "snapshot_without_cursor" });
        throw new RestartFeedError();
      }
      await this.options.onEvent({ ...event, cursor });
      this.cursorValue = cursor;
      return;
    }

    if (cursor) {
      if (!this.cursorValue) {
        await this.options.onReset?.({ reason: "cursor_gap", detail: cursor });
        throw new RestartFeedError();
      }
      const current = parseEventCursor(this.cursorValue);
      const incoming = parseEventCursor(cursor);
      if (incoming.streamEpoch !== current.streamEpoch) {
        this.cursorValue = undefined;
        await this.options.onReset?.({ reason: "epoch_mismatch", detail: cursor });
        throw new RestartFeedError();
      }
      if (incoming.sequence <= current.sequence) return;
      if (incoming.sequence !== current.sequence + 1n) {
        this.cursorValue = undefined;
        await this.options.onReset?.({ reason: "cursor_gap", detail: cursor });
        throw new RestartFeedError();
      }
    }

    if (!cursor && event.event !== "heartbeat") {
      this.cursorValue = undefined;
      await this.options.onReset?.({ reason: "invalid_cursor", detail: event.event });
      throw new RestartFeedError();
    }

    await this.options.onEvent({
      ...event,
      ...(cursor ? { cursor } : {})
    });
    if (cursor) this.cursorValue = cursor;
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function resetReason(data: string): FeedReset["reason"] {
  const parsed = parseJson(data);
  if (
    parsed
    && typeof parsed === "object"
    && ((parsed as { reason?: unknown }).reason === "epoch_mismatch"
      || (parsed as { reason?: unknown }).reason === "cursor_gap")
  ) {
    return (parsed as { reason: "epoch_mismatch" | "cursor_gap" }).reason;
  }
  return "cursor_gap";
}

function boundedDelay(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 60_000) {
    throw new TypeError("reconnectDelayMs must be between 0 and 60000.");
  }
  return value;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || milliseconds === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
