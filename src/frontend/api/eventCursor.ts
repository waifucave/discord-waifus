const EVENT_CURSOR_PATTERN = /^v1:([A-Za-z0-9_-]{21}[AQgw]):(0|[1-9][0-9]{0,19})$/u;
const UINT64_MAX = 18_446_744_073_709_551_615n;

export type EventCursor = string & { readonly __eventCursorV1: unique symbol };

export type EventCursorParts = {
  streamEpoch: string;
  sequence: bigint;
};

/** Parse the wire cursor without ever narrowing its uint64 sequence to a Number. */
export function parseEventCursor(value: string): EventCursorParts {
  const match = EVENT_CURSOR_PATTERN.exec(value);
  if (!match) throw new TypeError("Invalid event cursor.");
  const sequence = BigInt(match[2]);
  if (sequence > UINT64_MAX) throw new TypeError("Event cursor sequence exceeds uint64.");
  return { streamEpoch: match[1], sequence };
}

export function asEventCursor(value: string): EventCursor {
  parseEventCursor(value);
  return value as EventCursor;
}

export function compareEventCursors(left: string, right: string): number | undefined {
  const a = parseEventCursor(left);
  const b = parseEventCursor(right);
  if (a.streamEpoch !== b.streamEpoch) return undefined;
  return a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0;
}

export function latestEventCursor(values: readonly string[]): EventCursor | undefined {
  let latest: EventCursor | undefined;
  for (const value of values) {
    const candidate = asEventCursor(value);
    if (!latest) {
      latest = candidate;
      continue;
    }
    const comparison = compareEventCursors(latest, candidate);
    if (comparison === undefined) {
      // Stored conversation events must share one process-local epoch. If stale mixed data ever
      // appears, recovery from no cursor forces a canonical snapshot instead of guessing.
      return undefined;
    }
    if (comparison < 0) latest = candidate;
  }
  return latest;
}
