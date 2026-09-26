// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from 'vitest'
import { runGuarded } from './guarded-run'
import { RunGuard } from './run-guard'

/**
 * A promise plus its resolvers, so each test controls exactly when (and
 * whether) the run settles — the late-delivery cases are the point.
 */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (cause: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Settle-and-flush: awaiting the deferred promise runs every handler that
 * was attached to it before this await (attachment order = resolution
 * order), so assertions after it observe the delivery deterministically.
 */
async function settle<T>(run: { promise: Promise<T> }): Promise<void> {
  await run.promise.then(
    () => {},
    () => {},
  )
}

describe('runGuarded — the guarded async tail of a SQL run', () => {
  it('begins a run and returns its token (active immediately)', () => {
    const guard = new RunGuard()
    const token = runGuarded(guard, deferred<string>().promise, {
      onResult: vi.fn(),
      onError: vi.fn(),
    })
    expect(guard.isActive(token)).toBe(true)
  })

  it('an active run settling with a value reaches onResult (with the value) and never onError', async () => {
    const guard = new RunGuard()
    const run = deferred<string>()
    const onResult = vi.fn()
    const onError = vi.fn()
    runGuarded(guard, run.promise, { onResult, onError })

    run.resolve('page-1')
    await settle(run)

    expect(onResult).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenCalledWith('page-1')
    expect(onError).not.toHaveBeenCalled()
  })

  it('an active run rejecting reaches onError (with the cause) and never onResult', async () => {
    const guard = new RunGuard()
    const run = deferred<string>()
    const onResult = vi.fn()
    const onError = vi.fn()
    runGuarded(guard, run.promise, { onResult, onError })
    const cause = new Error('engine said no')

    run.reject(cause)
    await settle(run)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(cause)
    expect(onResult).not.toHaveBeenCalled()
  })

  it('a cancelled run’s late result is discarded — an invalidated token never invokes the handlers', async () => {
    const guard = new RunGuard()
    const run = deferred<string>()
    const onResult = vi.fn()
    const onError = vi.fn()
    runGuarded(guard, run.promise, { onResult, onError })

    guard.invalidate() // the Cancel path (SqlPanel's cancel())
    run.resolve('late page') // the abandoned query eventually delivers…
    await settle(run)

    // …but its late result never renders: no handler fires at all.
    expect(onResult).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('a cancelled run’s late rejection is discarded too', async () => {
    const guard = new RunGuard()
    const run = deferred<string>()
    const onResult = vi.fn()
    const onError = vi.fn()
    runGuarded(guard, run.promise, { onResult, onError })

    guard.invalidate()
    run.reject(new Error('late failure'))
    await settle(run)

    expect(onResult).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('a superseded run’s late result never reaches the older run’s handlers', async () => {
    const guard = new RunGuard()
    const first = deferred<string>()
    const firstHandlers = { onResult: vi.fn(), onError: vi.fn() }
    runGuarded(guard, first.promise, firstHandlers)

    // A newer run begins (e.g. the user pages forward) — the first run's
    // token is superseded before it settles.
    const second = deferred<string>()
    const secondHandlers = { onResult: vi.fn(), onError: vi.fn() }
    runGuarded(guard, second.promise, secondHandlers)

    first.resolve('stale page')
    await settle(first)

    expect(firstHandlers.onResult).not.toHaveBeenCalled()
    expect(firstHandlers.onError).not.toHaveBeenCalled()
    expect(secondHandlers.onResult).not.toHaveBeenCalled()
    expect(secondHandlers.onError).not.toHaveBeenCalled()

    // The newer run still delivers normally.
    second.resolve('fresh page')
    await settle(second)
    expect(secondHandlers.onResult).toHaveBeenCalledTimes(1)
    expect(secondHandlers.onResult).toHaveBeenCalledWith('fresh page')
    expect(firstHandlers.onResult).not.toHaveBeenCalled()
  })

  it('a superseded run’s late rejection never reaches the newer run’s handlers either', async () => {
    const guard = new RunGuard()
    const first = deferred<string>()
    const firstHandlers = { onResult: vi.fn(), onError: vi.fn() }
    runGuarded(guard, first.promise, firstHandlers)

    const second = deferred<string>()
    const secondHandlers = { onResult: vi.fn(), onError: vi.fn() }
    runGuarded(guard, second.promise, secondHandlers)

    first.reject(new Error('stale failure'))
    await settle(first)

    expect(firstHandlers.onResult).not.toHaveBeenCalled()
    expect(firstHandlers.onError).not.toHaveBeenCalled()
    expect(secondHandlers.onResult).not.toHaveBeenCalled()
    expect(secondHandlers.onError).not.toHaveBeenCalled()
  })

  it('the pane stays usable: after invalidate() the next begun run delivers normally', async () => {
    const guard = new RunGuard()
    const abandoned = deferred<string>()
    const abandonedHandlers = { onResult: vi.fn(), onError: vi.fn() }
    runGuarded(guard, abandoned.promise, abandonedHandlers)

    guard.invalidate() // cancel
    const next = deferred<string>()
    const nextHandlers = { onResult: vi.fn(), onError: vi.fn() }
    runGuarded(guard, next.promise, nextHandlers)

    // Both runs eventually settle — the abandoned one first (FIFO), then
    // the follow-up. Only the follow-up's handlers may fire.
    abandoned.resolve('abandoned page')
    await settle(abandoned)
    next.resolve('follow-up page')
    await settle(next)

    expect(abandonedHandlers.onResult).not.toHaveBeenCalled()
    expect(abandonedHandlers.onError).not.toHaveBeenCalled()
    expect(nextHandlers.onResult).toHaveBeenCalledTimes(1)
    expect(nextHandlers.onResult).toHaveBeenCalledWith('follow-up page')
  })

  it('a throw from onResult is routed to onError, not left as an unhandled rejection', async () => {
    const guard = new RunGuard()
    const run = deferred<string>()
    const onError = vi.fn()
    const boom = new Error('projection failed')
    runGuarded(guard, run.promise, {
      onResult: () => {
        throw boom
      },
      onError,
    })

    run.resolve('page that breaks the projection')
    await settle(run)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(boom)
  })

  it('discard survives handler identity: the same handlers object is reused, tokens are not', async () => {
    // Guards against an implementation that captures "the latest handlers"
    // instead of the per-run token: the cancelled run's delivery must stay
    // silent even though a newer run shares the handler references.
    const guard = new RunGuard()
    const run = deferred<string>()
    const onResult = vi.fn()
    const onError = vi.fn()
    runGuarded(guard, run.promise, { onResult, onError })

    const next = deferred<string>()
    runGuarded(guard, next.promise, { onResult, onError }) // same handlers object shape

    guard.invalidate() // cancels the *newest* run
    run.resolve('old page')
    await settle(run)
    next.resolve('newest page — but it was cancelled')
    await settle(next)

    expect(onResult).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })
})
