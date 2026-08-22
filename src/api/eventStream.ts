import {
  MAX_EVENT_BYTES,
  MAX_EVENT_REPLAY_BYTES,
  MAX_EVENT_REPLAY_RECORDS,
  StreamSnapshotRequiredV1Schema,
  type EventCursor,
  type StreamSnapshotRequiredV1
} from "../shared/schemas/adminOperations.js";
import {
  UINT64_MAX,
  formatUint64Decimal
} from "../shared/schemas/remoteProtocol.js";
import {
  createStreamEpoch,
  formatEventCursor,
  parseEventCursor
} from "../shared/eventCursor.js";

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

export type EventStreamRecord<T> = {
  readonly cursor: EventCursor;
  readonly event: string;
  readonly data: T;
  readonly sequence: bigint;
  readonly bytes: number;
};

export type EventStreamRecovery<T> = {
  readonly latestCursor: EventCursor;
  readonly snapshotRequired: boolean;
  readonly reset?: StreamSnapshotRequiredV1;
  readonly records: readonly EventStreamRecord<T>[];
};

export type EventStreamOptions = {
  streamEpoch?: string;
  initialSequence?: bigint;
  maxRecords?: number;
  maxReplayBytes?: number;
  maxEventBytes?: number;
};

export class EventStreamEventTooLargeError extends Error {
  constructor() {
    super("Event exceeds the stream event-size limit.");
    this.name = "EventStreamEventTooLargeError";
  }
}

export class EventStreamClosedError extends Error {
  constructor() {
    super("Event stream is closed.");
    this.name = "EventStreamClosedError";
  }
}

export type AuthorizedSubscription<T> = {
  readonly ready: Promise<void>;
  heartbeat: (send: () => void | Promise<void>) => Promise<void>;
  close: () => void;
};

type InternalSubscriber<T> = {
  closed: boolean;
  tail: Promise<void>;
  enqueueRecord: (record: EventStreamRecord<T>) => Promise<void>;
  enqueueTask: (task: () => void | Promise<void>) => Promise<void>;
  close: () => void;
  terminate: () => void;
};

export class EventStream<T> {
  readonly streamEpoch: string;
  private readonly maxRecords: number;
  private readonly maxReplayBytes: number;
  private readonly maxEventBytes: number;
  private readonly records: EventStreamRecord<T>[] = [];
  private readonly subscribers = new Set<InternalSubscriber<T>>();
  private sequence: bigint;
  private replayBytes = 0;
  private closed = false;

  constructor(options: EventStreamOptions = {}) {
    this.streamEpoch = options.streamEpoch ?? createStreamEpoch();
    this.sequence = options.initialSequence ?? 0n;
    this.maxRecords = boundedInteger(options.maxRecords ?? MAX_EVENT_REPLAY_RECORDS, "maxRecords");
    this.maxReplayBytes = boundedInteger(
      options.maxReplayBytes ?? MAX_EVENT_REPLAY_BYTES,
      "maxReplayBytes"
    );
    this.maxEventBytes = boundedInteger(options.maxEventBytes ?? MAX_EVENT_BYTES, "maxEventBytes");
    formatEventCursor({
      streamEpoch: this.streamEpoch,
      sequence: formatUint64Decimal(this.sequence)
    });
  }

  publish(event: string, data: T): EventCursor {
    if (this.closed) throw new EventStreamClosedError();
    if (!EVENT_NAME_PATTERN.test(event)) throw new TypeError("Invalid SSE event name.");
    if (this.sequence === UINT64_MAX) throw new RangeError("Event stream sequence is exhausted.");
    const cloned = structuredClone(data);
    const sequence = this.sequence + 1n;
    const cursor = formatEventCursor({
      streamEpoch: this.streamEpoch,
      sequence: formatUint64Decimal(sequence)
    });
    const bytes = serializedEventBytes(event, cloned, cursor);
    if (bytes > this.maxEventBytes) throw new EventStreamEventTooLargeError();

    this.sequence = sequence;
    const record = Object.freeze({ cursor, event, data: cloned, sequence, bytes });
    this.records.push(record);
    this.replayBytes += bytes;
    while (
      this.records.length > 0
      && (this.records.length > this.maxRecords || this.replayBytes > this.maxReplayBytes)
    ) {
      const removed = this.records.shift();
      if (removed) this.replayBytes -= removed.bytes;
    }
    for (const subscriber of this.subscribers) {
      void subscriber.enqueueRecord(record);
    }
    return cursor;
  }

  recover(lastEventId?: string): EventStreamRecovery<T> {
    const latestCursor = this.latestCursor();
    if (!lastEventId) {
      return { latestCursor, snapshotRequired: true, records: [] };
    }
    let parsed: ReturnType<typeof parseEventCursor> | undefined;
    try {
      parsed = parseEventCursor(lastEventId);
    } catch {
      return this.resetRecovery("cursor_gap", latestCursor);
    }
    if (parsed.streamEpoch !== this.streamEpoch) {
      return this.resetRecovery("epoch_mismatch", latestCursor);
    }
    const requested = BigInt(parsed.sequence);
    if (requested > this.sequence) {
      return this.resetRecovery("cursor_gap", latestCursor);
    }
    const earliest = this.records[0]?.sequence ?? this.sequence + 1n;
    if (requested + 1n < earliest) {
      return this.resetRecovery("cursor_gap", latestCursor);
    }
    return {
      latestCursor,
      snapshotRequired: false,
      records: this.records.filter((record) => record.sequence > requested)
    };
  }

  subscribeAuthorized<P, S, U, V>(options: {
    principal: P;
    lastEventId?: string;
    authorize: (principal: P) => boolean | Promise<boolean>;
    project: (principal: P, event: string, data: T) => U | undefined;
    snapshot: () => S;
    projectSnapshot: (principal: P, snapshot: S) => V;
    onReset: (reset: StreamSnapshotRequiredV1) => void | Promise<void>;
    onSnapshot: (snapshot: V, cursor: EventCursor) => void | Promise<void>;
    onEvent: (event: string, data: U, cursor: EventCursor) => void | Promise<void>;
    onUnauthorized: () => void | Promise<void>;
    onClose?: () => void | Promise<void>;
    onError?: (error: unknown) => void | Promise<void>;
  }): AuthorizedSubscription<T> {
    if (this.closed) throw new EventStreamClosedError();
    const recovery = this.recover(options.lastEventId);
    const capturedSnapshot = recovery.snapshotRequired
      ? structuredClone(options.snapshot())
      : undefined;
    const principal = options.principal;
    let unauthorizedNotified = false;
    let closeNotified = false;

    const subscriber = {} as InternalSubscriber<T>;
    const remove = (): void => {
      subscriber.closed = true;
      this.subscribers.delete(subscriber);
    };
    const terminate = (): void => {
      if (subscriber.closed) return;
      remove();
      if (!closeNotified) {
        closeNotified = true;
        void Promise.resolve(options.onClose?.()).catch(() => undefined);
      }
    };
    const fail = async (error: unknown): Promise<void> => {
      if (subscriber.closed) return;
      remove();
      try {
        await options.onError?.(error);
      } catch {
        // Error notification is terminal and must not create an unhandled subscriber chain.
      }
    };
    const deny = async (): Promise<void> => {
      if (subscriber.closed) return;
      remove();
      if (!unauthorizedNotified) {
        unauthorizedNotified = true;
        try {
          await options.onUnauthorized();
        } catch {
          // Authorization denial remains terminal even if transport cleanup itself fails.
        }
      }
    };
    const enqueueTask = (task: () => void | Promise<void>): Promise<void> => {
      subscriber.tail = subscriber.tail.then(async () => {
        if (subscriber.closed) return;
        let authorized: boolean;
        try {
          authorized = await options.authorize(principal);
        } catch (error) {
          await fail(error);
          return;
        }
        if (!authorized) {
          await deny();
          return;
        }
        if (subscriber.closed) return;
        try {
          await task();
        } catch (error) {
          await fail(error);
        }
      });
      return subscriber.tail;
    };
    const enqueueRecord = (record: EventStreamRecord<T>): Promise<void> => enqueueTask(async () => {
      const projected = options.project(principal, record.event, structuredClone(record.data));
      if (projected === undefined) return;
      if (serializedEventBytes(record.event, projected, record.cursor) > this.maxEventBytes) {
        throw new EventStreamEventTooLargeError();
      }
      await options.onEvent(record.event, projected, record.cursor);
    });
    subscriber.closed = false;
    subscriber.tail = Promise.resolve();
    subscriber.enqueueRecord = enqueueRecord;
    subscriber.enqueueTask = enqueueTask;
    subscriber.close = remove;
    subscriber.terminate = terminate;
    this.subscribers.add(subscriber);

    if (recovery.snapshotRequired) {
      if (recovery.reset) {
        void enqueueTask(() => options.onReset(recovery.reset!));
      }
      void enqueueTask(async () => {
        const projected = options.projectSnapshot(principal, structuredClone(capturedSnapshot as S));
        if (serializedEventBytes("snapshot", projected, recovery.latestCursor) > this.maxEventBytes) {
          throw new EventStreamEventTooLargeError();
        }
        await options.onSnapshot(projected, recovery.latestCursor);
      });
    }
    for (const record of recovery.records) void enqueueRecord(record);
    const ready = subscriber.tail;
    return {
      ready,
      heartbeat: (send) => enqueueTask(send),
      close: remove
    };
  }

  latestCursor(): EventCursor {
    return formatEventCursor({
      streamEpoch: this.streamEpoch,
      sequence: formatUint64Decimal(this.sequence)
    });
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  retainedCount(): number {
    return this.records.length;
  }

  retainedBytes(): number {
    return this.replayBytes;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const subscriber of [...this.subscribers]) subscriber.terminate();
  }

  private resetRecovery(
    reason: StreamSnapshotRequiredV1["reason"],
    latestCursor: EventCursor
  ): EventStreamRecovery<T> {
    return {
      latestCursor,
      snapshotRequired: true,
      reset: StreamSnapshotRequiredV1Schema.parse({
        version: 1,
        type: "snapshot_required",
        reason,
        streamEpoch: this.streamEpoch,
        latestSequence: formatUint64Decimal(this.sequence)
      }),
      records: []
    };
  }
}

export function serializeSseEvent(input: {
  event: string;
  data: unknown;
  cursor?: string;
}): string {
  if (!EVENT_NAME_PATTERN.test(input.event)) throw new TypeError("Invalid SSE event name.");
  const data = JSON.stringify(input.data);
  if (data === undefined) throw new TypeError("SSE event data must be JSON serializable.");
  const id = input.cursor === undefined ? "" : `id: ${input.cursor}\n`;
  return `${id}event: ${input.event}\ndata: ${data}\n\n`;
}

function serializedEventBytes(event: string, data: unknown, cursor: string): number {
  return Buffer.byteLength(serializeSseEvent({ event, data, cursor }), "utf8");
}

function boundedInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative safe integer.`);
  }
  return value;
}
