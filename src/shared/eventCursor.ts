import { randomBytes } from "node:crypto";
import {
  Base64Url16BytesSchema,
  UINT64_MAX,
  Uint64DecimalSchema,
  formatUint64Decimal,
  type Base64Url16Bytes,
  type Uint64Decimal
} from "./schemas/remoteProtocol.js";
import {
  EventCursorSchema,
  type EventCursor
} from "./schemas/adminOperations.js";

export interface EventCursorParts {
  streamEpoch: Base64Url16Bytes;
  sequence: Uint64Decimal;
}

export function createStreamEpoch(): Base64Url16Bytes {
  return Base64Url16BytesSchema.parse(randomBytes(16).toString("base64url"));
}

export function formatEventCursor(value: {
  streamEpoch: string;
  sequence: string;
}): EventCursor {
  const streamEpoch = Base64Url16BytesSchema.parse(value.streamEpoch);
  const sequence = Uint64DecimalSchema.parse(value.sequence);
  return EventCursorSchema.parse(`v1:${streamEpoch}:${sequence}`);
}

export function parseEventCursor(value: string): EventCursorParts {
  const cursor = EventCursorSchema.parse(value);
  const [, streamEpoch, sequence] = cursor.split(":");
  return {
    streamEpoch: Base64Url16BytesSchema.parse(streamEpoch),
    sequence: Uint64DecimalSchema.parse(sequence)
  };
}

export function nextEventCursor(value: string): EventCursor {
  const current = parseEventCursor(value);
  const sequence = BigInt(current.sequence);
  if (sequence === UINT64_MAX) {
    throw new RangeError("Event cursor sequence is exhausted.");
  }
  return formatEventCursor({
    streamEpoch: current.streamEpoch,
    sequence: formatUint64Decimal(sequence + 1n)
  });
}
