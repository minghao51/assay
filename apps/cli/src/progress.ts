// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Lightweight stderr progress for the CLI's slow scans (q-4 / AR-C6).
 *
 * Progress is a courtesy for an interactive run, never product output: it is
 * written line-by-line to STDERR only (stdout stays the byte-stable report,
 * so JSON pipes are untouched) and is emitted only when stderr is a terminal.
 * A piped/redirected stderr is therefore already quiet — and `--quiet` turns
 * the interactive line off too. There is deliberately no elapsed-time or
 * spinner state: one authored, value-free line per phase.
 *
 * Privacy (ADR 0025): the messages are fixed strings — no dataset values, no
 * paths, no counts derived from the data.
 */

/** The minimal stream surface progression needs (a TTY-aware writable). */
export interface ProgressStream {
  write(chunk: string): unknown
  readonly isTTY?: boolean | undefined
}

/** The progress surface the command runners use (no-op when disabled). */
export interface ProgressReporter {
  /** True when steps are actually written. */
  readonly enabled: boolean
  /** Emit one phase line. */
  step(message: string): void
  /** Emit the terminal phase line. */
  done(): void
}

/** The shared disabled reporter (stable identity; no writes). */
export const silentProgress: ProgressReporter = {
  enabled: false,
  step: () => {},
  done: () => {},
}

/**
 * Whether progress should be written: only on an interactive stderr and only
 * when `--quiet` did not ask for it to stop.
 */
export function shouldShowProgress(options: {
  readonly isTTY: boolean
  readonly quiet: boolean
}): boolean {
  return !options.quiet && options.isTTY
}

/** Build a reporter for one destination stream (stderr in production). */
export function createProgressReporter(options: {
  readonly stream: ProgressStream
  readonly quiet: boolean
}): ProgressReporter {
  if (!shouldShowProgress({ isTTY: options.stream.isTTY === true, quiet: options.quiet })) {
    return silentProgress
  }
  return {
    enabled: true,
    step: (message) => {
      options.stream.write(`assay: ${message}\n`)
    },
    done: () => {
      options.stream.write('assay: done\n')
    },
  }
}
