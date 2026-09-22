/**
 * The ONE documented report-rounding convention for this package: round
 * half away from zero to 6 fractional digits (`REPORT_DECIMALS`), normalize
 * `-0` to `0`, pass non-finite through (model metrics are finite-or-null;
 * the passthrough keeps the function total).
 *
 * Full precision lives in the model; every surface (CLI human report, CLI
 * `--format json`, web panel, exported reports) applies this before
 * rendering so cross-surface output stays byte-identical (m6-5 asserts it).
 * `0` rounds to `0` — the identity pin survives rounding (pinned).
 *
 * The convention is IEEE-754 double arithmetic: scale by `10^6`, round the
 * non-negative magnitude (where `Math.round`'s half-toward-+∞ *is* half
 * away from zero), scale back, restore the sign. It is deterministic
 * everywhere by construction and is a *reporting* convention — not
 * decimal-exact arithmetic, which the contracts package does for
 * user-written rule numbers (a different, exactness-critical problem).
 */

import { normZero } from './guards.js'

/** Fractional digits kept in report-facing numbers. */
export const REPORT_DECIMALS = 6

const SCALE = 10 ** REPORT_DECIMALS

/**
 * Apply the documented report-rounding convention (see module doc). Total:
 * a non-number argument (hostile, behind a cast) is passed through
 * untouched — `Math.abs`/`<` would coerce it through `valueOf`, and a
 * hostile `valueOf`/`Symbol.toPrimitive` can throw. Numbers (including
 * NaN/±Infinity, which pass through per the documented rule) are unchanged.
 */
export function roundForReport(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value
  const scaled = Math.abs(value) * SCALE
  // Overflow guard: |value| ≳ 9e307 would scale to Infinity and stay there.
  if (!Number.isFinite(scaled)) return value
  const rounded = Math.round(scaled) / SCALE
  return normZero(value < 0 ? -rounded : rounded)
}
