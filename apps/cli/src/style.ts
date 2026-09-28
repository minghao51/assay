// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Minimal ANSI styling for the CLI's HUMAN reports (q-4 / AR-C6).
 *
 * Only the human renderers take a {@link ReportStyle}; the machine format
 * (`--format json`) is byte-stable and NEVER styled. The default,
 * {@link plainStyle}, is the identity — so every existing byte pin and every
 * piped run is unchanged. Styling is opt-in per the environment:
 *
 *   1. a NON-TTY destination is never colored — the piped/captured output
 *      contract is absolute, so `FORCE_COLOR=1` (which test runners such as
 *      Playwright set for their OWN output and which a spawned child
 *      inherits) cannot make a pipe non-byte-stable;
 *   2. then `FORCE_COLOR` disables when it is `''`, `0` (or `false`), and any
 *      other `FORCE_COLOR` value beats `NO_COLOR` on a terminal;
 *   3. else `NO_COLOR` (present, any value including the empty string)
 *      disables;
 *   4. else a TTY is colored.
 *
 * The colored set is deliberately small (the brief: status words + issue
 * counts), applied by role in the renderers:
 *
 *   - `fail`  red    — the `FAIL` word and `INVALID`/`DIFFERENCES` verdicts;
 *   - `pass`  green  — the `PASS` word and `VALID`/`IDENTICAL` verdicts;
 *   - `warn`  yellow — collected diff-issue lines;
 *   - `count` cyan   — the numbers in section headers and rule summaries.
 *
 * No new dependency: the handful of SGR codes are spelled here, and every
 * styled span ends with an explicit reset so nesting cannot leak.
 */

/** Red foreground. */
const RED = '\u001b[31m'
/** Green foreground. */
const GREEN = '\u001b[32m'
/** Yellow foreground. */
const YELLOW = '\u001b[33m'
/** Cyan foreground. */
const CYAN = '\u001b[36m'
/** Reset all attributes. */
const RESET = '\u001b[0m'

/** The styling roles a human renderer may apply (identity when disabled). */
export interface ReportStyle {
  /** True when the methods actually wrap text in ANSI codes. */
  readonly enabled: boolean
  /** Red — failing status words. */
  fail(text: string): string
  /** Green — passing status words. */
  pass(text: string): string
  /** Yellow — collected issue lines. */
  warn(text: string): string
  /** Cyan — issue/delta counts. */
  count(text: string): string
}

/** The identity style: no color, byte-identical to the pre-q-4 output. */
export const plainStyle: ReportStyle = {
  enabled: false,
  fail: (text) => text,
  pass: (text) => text,
  warn: (text) => text,
  count: (text) => text,
}

/** Wrap `text` in one SGR code + reset. */
function wrap(code: string, text: string): string {
  return `${code}${text}${RESET}`
}

/** Build a style; `enabled=false` returns the shared identity style. */
export function createReportStyle(enabled: boolean): ReportStyle {
  if (!enabled) return plainStyle
  return {
    enabled: true,
    fail: (text) => wrap(RED, text),
    pass: (text) => wrap(GREEN, text),
    warn: (text) => wrap(YELLOW, text),
    count: (text) => wrap(CYAN, text),
  }
}

/**
 * Decide whether color is on for one destination stream.
 *
 * A non-TTY destination is always plain — the piped-output contract wins over
 * every environment variable (this is what keeps a spawned CLI in a test
 * runner plain even though Playwright exports `FORCE_COLOR=1`). On a
 * terminal, `FORCE_COLOR` `''`/`0`/`false` disables and any other
 * `FORCE_COLOR` value beats `NO_COLOR` (Node's documented order); otherwise
 * `NO_COLOR` (present, ANY value — including the empty string, matching the
 * ecosystem's common reading) disables; otherwise the terminal is colored.
 */
export function shouldUseColor(options: {
  readonly isTTY: boolean
  readonly env: NodeJS.ProcessEnv
}): boolean {
  const force = options.env.FORCE_COLOR
  // `FORCE_COLOR=''` is an explicit "off" (not "unset"): the ecosystem treats
  // an empty value as disabling, and the previous `force !== undefined` check
  // mistakenly let it force color on. `0`/`false` disable too.
  const forceOff =
    force !== undefined && (force === '' || force === '0' || force.toLowerCase() === 'false')
  if (!options.isTTY) return false
  if (forceOff) return false
  // Any other explicit FORCE_COLOR value wins over NO_COLOR (force-color
  // convention: FORCE_COLOR takes precedence when both are set).
  if (force !== undefined) return true
  // NO_COLOR disables regardless of value — including the empty string.
  if (options.env.NO_COLOR !== undefined) return false
  return true
}
