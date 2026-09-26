// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { OpChannel } from './op-channel'

/**
 * Unit tests for the T2 worker-side operation channel (the single
 * pending-query channel). Deterministic: every task's progress is gated on
 * an explicitly-resolved promise, so interleavings are scripted, never
 * timing-based (no real DuckDB, no real worker).
 */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Flush microtask chains (channel continuations) to a macrotask boundary. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('OpChannel (T2 single pending-query channel)', () => {
  it('runs enqueued tasks one at a time, in FIFO arrival order', async () => {
    const channel = new OpChannel()
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()]
    const events: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const makeTask = (name: string, gate: Deferred<void>) => async (): Promise<string> => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      events.push(`start:${name}`)
      await gate.promise
      inFlight -= 1
      events.push(`end:${name}`)
      return name
    }

    const a = channel.run(makeTask('a', gates[0]!))
    const b = channel.run(makeTask('b', gates[1]!))
    const c = channel.run(makeTask('c', gates[2]!))
    await flush()

    // Only the first task runs; b and c are queued behind it.
    expect(events).toEqual(['start:a'])
    gates[0]!.resolve(undefined)
    await expect(a).resolves.toBe('a')
    await flush()
    expect(events).toEqual(['start:a', 'end:a', 'start:b'])
    gates[1]!.resolve(undefined)
    await expect(b).resolves.toBe('b')
    await flush()
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c'])
    gates[2]!.resolve(undefined)
    await expect(c).resolves.toBe('c')

    // The collision guard: no two tasks were ever in flight at once.
    expect(maxInFlight).toBe(1)
  })

  it('delivers each task’s error only to its own caller and keeps the queue usable', async () => {
    const channel = new OpChannel()
    const boom = deferred<void>()
    const events: string[] = []

    const first = channel.run(async () => {
      events.push('first')
      return 'ok'
    })
    const failing = channel.run(async () => {
      events.push('failing')
      await boom.promise
      throw new Error('op failed')
    })
    const after = channel.run(async () => {
      events.push('after')
      return 'recovered'
    })

    await flush()
    // 'first' completes instantly, so 'failing' has already started (and is
    // parked inside its gate); 'after' is still queued behind it.
    expect(events).toEqual(['first', 'failing'])
    boom.reject(new Error('op failed'))

    await expect(first).resolves.toBe('ok')
    await expect(failing).rejects.toThrow('op failed')
    // The next task still ran — the failing task never wedged the queue —
    // and received no trace of its predecessor's error.
    await expect(after).resolves.toBe('recovered')
    expect(events).toEqual(['first', 'failing', 'after'])
  })

  it('survives many sequential failures (the queue never stays wedged)', async () => {
    const channel = new OpChannel()
    for (let index = 0; index < 5; index += 1) {
      await expect(
        channel.run(async () => {
          throw new Error(`fail ${index}`)
        }),
      ).rejects.toThrow(`fail ${index}`)
    }
    await expect(channel.run(async () => 'alive')).resolves.toBe('alive')
  })

  it('preserves FIFO order when many callers enqueue concurrently', async () => {
    const channel = new OpChannel()
    const order: number[] = []
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        channel.run(async () => {
          order.push(index)
          return index * 2
        }),
      ),
    )
    // `Promise.all` invokes the `run` calls synchronously in array order, so
    // arrival order is 0..9 and execution must follow it exactly.
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18])
  })

  it('starts a task that was enqueued after a synchronous (already-settled) run', async () => {
    const channel = new OpChannel()
    await expect(channel.run(async () => 'one')).resolves.toBe('one')
    await expect(channel.run(async () => 'two')).resolves.toBe('two')
  })
})
