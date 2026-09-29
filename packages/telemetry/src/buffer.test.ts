// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  MAX_BUFFERED_BYTES,
  MAX_BUFFERED_EVENTS,
  createEventBuffer,
  splitIntoBatches,
  validateEvent,
} from './index.js'
import type { TelemetryEvent } from './index.js'
import { validEventFor } from './test-support.js'

function event(name: Parameters<typeof validEventFor>[0]): TelemetryEvent {
  const result = validateEvent(validEventFor(name))
  if (!result.ok) throw new Error(`fixture invalid: ${name}`)
  return result.value
}

describe('event buffer — §5.2 caps (oldest dropped first)', () => {
  it('retains everything under the caps', () => {
    const buffer = createEventBuffer()
    for (let index = 0; index < 5; index++) {
      expect(buffer.add(event('app_boot'))).toBe(true)
    }
    expect(buffer.size).toBe(5)
    expect(buffer.byteSize).toBeGreaterThan(0)
  })

  it('drops the OLDEST event once the event cap is exceeded', () => {
    const buffer = createEventBuffer({ maxEvents: 3 })
    const events = [1, 2, 3, 4].map((seq) => {
      const built = event('app_boot')
      return { ...built, app_version_patch: seq } as TelemetryEvent
    })
    for (const built of events) buffer.add(built)
    expect(buffer.size).toBe(3)
    const drained = buffer.drain()
    expect(drained.map((item) => item.app_version_patch)).toEqual([2, 3, 4])
  })

  it('drops the OLDEST event once the byte cap is exceeded', () => {
    // A tiny byte cap plus a deterministic 10-byte measure: three adds fit,
    // the fourth evicts the first.
    const buffer = createEventBuffer({ maxBytes: 25, byteLength: () => 10 })
    const first = { ...event('app_boot'), app_version_patch: 1 } as TelemetryEvent
    const second = { ...event('app_boot'), app_version_patch: 2 } as TelemetryEvent
    const third = { ...event('app_boot'), app_version_patch: 3 } as TelemetryEvent
    const fourth = { ...event('app_boot'), app_version_patch: 4 } as TelemetryEvent
    for (const built of [first, second, third, fourth]) buffer.add(built)
    expect(buffer.size).toBe(2)
    expect(buffer.byteSize).toBe(20)
    expect(buffer.drain().map((item) => item.app_version_patch)).toEqual([3, 4])
  })

  it('refuses a single event above the byte cap', () => {
    const buffer = createEventBuffer({ byteLength: () => 1_000_000 })
    expect(buffer.add(event('app_boot'))).toBe(false)
    expect(buffer.size).toBe(0)
  })

  it('clear() empties the buffer synchronously (mid-session opt-out, §6.5)', () => {
    const buffer = createEventBuffer()
    buffer.add(event('app_boot'))
    buffer.add(event('query_run'))
    buffer.clear()
    expect(buffer.size).toBe(0)
    expect(buffer.byteSize).toBe(0)
    expect(buffer.drain()).toEqual([])
  })

  it('pins the design cap constants', () => {
    expect(MAX_BUFFERED_EVENTS).toBe(32)
    expect(MAX_BUFFERED_BYTES).toBe(256 * 1024)
    expect(MAX_BATCH_EVENTS).toBe(32)
    expect(MAX_BATCH_BYTES).toBe(256 * 1024)
  })
})

describe('batch splitter — §8.3 (≤32 events / ≤256 KiB)', () => {
  it('returns no batches for an empty input', () => {
    expect(splitIntoBatches([])).toEqual([])
  })

  it('splits on the event cap boundary', () => {
    const events = Array.from({ length: 33 }, () => event('app_boot'))
    const batches = splitIntoBatches(events, { maxEvents: 32, maxBytes: 1_000_000 })
    expect(batches.map((batch) => batch.length)).toEqual([32, 1])
  })

  it('splits on the byte cap boundary', () => {
    const events = Array.from({ length: 5 }, () => event('app_boot'))
    const batches = splitIntoBatches(events, { maxEvents: 32, maxBytes: 25, byteLength: () => 10 })
    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1])
  })

  it('places an oversized single event in its own batch', () => {
    const batches = splitIntoBatches([event('app_boot')], {
      maxEvents: 32,
      maxBytes: 1,
      byteLength: () => 10,
    })
    expect(batches.map((batch) => batch.length)).toEqual([1])
  })

  it('preserves insertion order across batches', () => {
    const events = [1, 2, 3, 4, 5].map(
      (seq) => ({ ...event('app_boot'), app_version_patch: seq }) as TelemetryEvent,
    )
    const batches = splitIntoBatches(events, { maxEvents: 2, maxBytes: 1_000_000 })
    expect(batches.flat().map((item) => item.app_version_patch)).toEqual([1, 2, 3, 4, 5])
  })
})
