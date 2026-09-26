// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for the q-4 progress policy: the reporter writes authored phase
 * lines to its stream only when the stream is a TTY and `--quiet` was not
 * passed; otherwise it is the shared no-op (so a piped/captured stderr is
 * byte-free and stdout is never touched).
 */
import { describe, expect, it } from 'vitest'
import { createProgressReporter, shouldShowProgress, silentProgress } from './progress.js'

interface FakeStream {
  readonly isTTY: boolean
  readonly writes: string[]
  write(chunk: string): unknown
}

function fakeStream(isTTY: boolean): FakeStream {
  const writes: string[] = []
  return {
    isTTY,
    writes,
    write: (chunk: string) => {
      writes.push(chunk)
      return true
    },
  }
}

describe('progress — TTY-gated, quiet-suppressed, stderr-only', () => {
  it('emits phase lines when stderr is a TTY and --quiet is absent', () => {
    const stream = fakeStream(true)
    const reporter = createProgressReporter({ stream, quiet: false })
    expect(reporter.enabled).toBe(true)
    reporter.step('opening dataset')
    reporter.step('running validation plan')
    reporter.done()
    expect(stream.writes).toEqual([
      'assay: opening dataset\n',
      'assay: running validation plan\n',
      'assay: done\n',
    ])
  })

  it('is the shared no-op when stderr is piped (not a TTY)', () => {
    const stream = fakeStream(false)
    const reporter = createProgressReporter({ stream, quiet: false })
    expect(reporter).toBe(silentProgress)
    reporter.step('ignored')
    reporter.done()
    expect(stream.writes).toEqual([])
  })

  it('--quiet suppresses progress even on a TTY', () => {
    const stream = fakeStream(true)
    const reporter = createProgressReporter({ stream, quiet: true })
    expect(reporter).toBe(silentProgress)
    reporter.step('ignored')
    reporter.done()
    expect(stream.writes).toEqual([])
  })

  it('shouldShowProgress is the single decision function', () => {
    expect(shouldShowProgress({ isTTY: true, quiet: false })).toBe(true)
    expect(shouldShowProgress({ isTTY: true, quiet: true })).toBe(false)
    expect(shouldShowProgress({ isTTY: false, quiet: false })).toBe(false)
    expect(shouldShowProgress({ isTTY: false, quiet: true })).toBe(false)
  })
})
