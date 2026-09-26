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
 *   2. then `FORCE_COLOR` `0`/`false` disables, and an explicit truthy
 *      `FORCE_COLOR` beats `NO_COLOR` on a terminal (Node's precedence);
 *   3. else `NO_COLOR` (present, non-empty) disables;
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
 * terminal, `FORCE_COLOR=0`/`false` disables and an explicit truthy
 * `FORCE_COLOR` beats `NO_COLOR` (Node's documented order); otherwise
 * `NO_COLOR` (non-empty) disables; otherwise the terminal is colored.
 */
export function shouldUseColor(options: {
  readonly isTTY: boolean
  readonly env: NodeJS.ProcessEnv
}): boolean {
  const force = options.env.FORCE_COLOR
  const forceOff = force !== undefined && (force === '0' || force.toLowerCase() === 'false')
  if (forceOff) return false
  if (!options.isTTY) return false
  const noColor = options.env.NO_COLOR
  if (noColor !== undefined && noColor !== '') {
    return force !== undefined
  }
  return true
}
