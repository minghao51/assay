// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The per-invocation sinks a command runner renders into (q-4).
 *
 * The entry (`index.ts`) builds ONE context from the process streams and the
 * parsed flags, so every command shares the same stdout contract, the same
 * TTY/`--quiet` progress policy, and the same human-report styling. The
 * runners stay pure-ish: tests can inject a capturing `out`, an identity
 * `style`, and a silent `progress`.
 */
import type { ProgressReporter } from './progress.js'
import type { ReportStyle } from './style.js'

/** The output surfaces for one CLI run. */
export interface CommandContext {
  /** Write the report (stdout in production; the byte-stable contract). */
  readonly out: (text: string) => void
  /** Human-report styling (the identity when color is off). */
  readonly style: ReportStyle
  /** stderr progress (a no-op unless interactive and not `--quiet`). */
  readonly progress: ProgressReporter
}
