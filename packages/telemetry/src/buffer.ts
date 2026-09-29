// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pure in-memory event buffer (design §5.2) and batch splitter (§8.3).
 *
 * The buffer is bounded: at most {@link MAX_BUFFERED_EVENTS} events and
 * {@link MAX_BUFFERED_BYTES} serialized bytes, oldest dropped first. The
 * splitter partitions a drained buffer into transport batches of at most
 * {@link MAX_BATCH_EVENTS} events / {@link MAX_BATCH_BYTES} bytes.
 *
 * No timer, transport, persistence, or environment read lives here — the
 * emission surfaces own scheduling and delivery (design §8.3/R9/R13). Keeping
 * this pure lets the web and CLI surfaces share the exact cap semantics and
 * unit-pin them without a browser or a runtime.
 */

import type { TelemetryEvent } from './schema.js'

/** Max events retained in the session buffer (design §5.2). */
export const MAX_BUFFERED_EVENTS = 32

/** Max serialized bytes retained in the session buffer (design §5.2). */
export const MAX_BUFFERED_BYTES = 256 * 1024

/** Max events in one transport batch (design §8.3). */
export const MAX_BATCH_EVENTS = 32

/** Max serialized bytes in one transport batch (design §8.3). */
export const MAX_BATCH_BYTES = 256 * 1024

/** Injectable byte measure (defaults to UTF-8). Kept injectable for tests. */
export type ByteLength = (value: string) => number

/** Options for {@link createEventBuffer}. */
export interface EventBufferOptions {
  readonly maxEvents?: number
  readonly maxBytes?: number
  readonly byteLength?: ByteLength
}

/** A bounded FIFO of validated events; `add` drops the oldest when full. */
export interface EventBuffer {
  /** Number of buffered events. */
  readonly size: number
  /** Serialized byte size of the buffered events. */
  readonly byteSize: number
  /**
   * Append an event, evicting the oldest while over the caps. Returns `false`
   * when the event itself is larger than `maxBytes` and cannot be retained.
   */
  add(event: TelemetryEvent): boolean
  /** Drop everything (the mid-session opt-out path, design §6.5). */
  clear(): void
  /** Remove and return every buffered event, in insertion order. */
  drain(): readonly TelemetryEvent[]
}

/** The compact JSON representation sent on the wire (design §8.3). */
export function serializeEvent(event: TelemetryEvent): string {
  return JSON.stringify(event)
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

/** Create a bounded in-memory buffer (design §5.2). */
export function createEventBuffer(options: EventBufferOptions = {}): EventBuffer {
  const maxEvents = options.maxEvents ?? MAX_BUFFERED_EVENTS
  const maxBytes = options.maxBytes ?? MAX_BUFFERED_BYTES
  const byteLength = options.byteLength ?? utf8ByteLength
  let events: TelemetryEvent[] = []
  let bytes = 0
  return {
    get size(): number {
      return events.length
    },
    get byteSize(): number {
      return bytes
    },
    add(event: TelemetryEvent): boolean {
      const size = byteLength(serializeEvent(event))
      // A single event above the byte cap can never be retained (design §5.2).
      if (size > maxBytes) return false
      events = [...events, event]
      bytes += size
      // Oldest dropped first until both caps hold.
      while (events.length > maxEvents || bytes > maxBytes) {
        const dropped = events[0]
        if (dropped === undefined) break
        events = events.slice(1)
        bytes -= byteLength(serializeEvent(dropped))
      }
      return true
    },
    clear(): void {
      events = []
      bytes = 0
    },
    drain(): readonly TelemetryEvent[] {
      const drained = events
      events = []
      bytes = 0
      return drained
    },
  }
}

/** Options for {@link splitIntoBatches}. */
export interface BatchOptions {
  readonly maxEvents?: number
  readonly maxBytes?: number
  readonly byteLength?: ByteLength
}

/**
 * Greedily partition `events` into batches of at most `maxEvents` events and
 * `maxBytes` serialized bytes (design §8.3). A single event larger than the
 * byte cap still forms its own batch (the buffer already bounds size).
 */
export function splitIntoBatches(
  events: readonly TelemetryEvent[],
  options: BatchOptions = {},
): readonly (readonly TelemetryEvent[])[] {
  const maxEvents = options.maxEvents ?? MAX_BATCH_EVENTS
  const maxBytes = options.maxBytes ?? MAX_BATCH_BYTES
  const byteLength = options.byteLength ?? utf8ByteLength
  const batches: TelemetryEvent[][] = []
  let current: TelemetryEvent[] = []
  let bytes = 0
  for (const event of events) {
    const size = byteLength(serializeEvent(event))
    if (current.length > 0 && (current.length >= maxEvents || bytes + size > maxBytes)) {
      batches.push(current)
      current = []
      bytes = 0
    }
    current.push(event)
    bytes += size
  }
  if (current.length > 0) batches.push(current)
  return batches
}
