// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EngineCategoricalTopKEntry, EngineNumericColumnStats } from '@assay/engine-duckdb'

/**
 * Text formatting for the profile panel (m2-6) — pure, deterministic, and
 * Node-tested. Profile outputs are *data* (ADR 0007 spirit): everything here
 * produces plain strings rendered through React text interpolation — never
 * markup — and nothing here logs (ADR 0025).
 *
 * Number rendering: profile outputs are display *copy*, so numbers are
 * rounded to `STAT_DISPLAY_SIGNIFICANT_DIGITS` significant digits before
 * rendering (ux-3 / audit UX-5). The engine contract (m2-5) delivers finite
 * doubles or null, and the exact double text survives in the JSON/CLI
 * envelopes — only this web display layer rounds (byte-stability is a hard
 * invariant: nothing here feeds an export path). The rule is pure,
 * deterministic, and locale-free (ECMAScript `toPrecision`, which is
 * spec-exact — not `Intl`/locale formatting), so e2e pins stay stable. Null
 * stats render as '—' — an undefined statistic is shown as missing, never
 * faked as a value.
 */

/** The honest "no value" rendering for a null statistic. */
export const MISSING_STAT = '—' as const

/**
 * Significant digits kept when a profile statistic is displayed. Six matches
 * the *spirit* of `@assay/diff`'s report convention (the one rounding family
 * this app uses) without importing it: that convention keeps six *fractional*
 * digits, which would still let a large magnitude carry many more significant
 * digits than the audit's "~4–6" display budget allows. The profile's rule is
 * therefore deliberately a significant-digit rule, kept local and tested.
 */
export const STAT_DISPLAY_SIGNIFICANT_DIGITS = 6

/**
 * Display rounding for one statistic: `STAT_DISPLAY_SIGNIFICANT_DIGITS`
 * significant digits, pure/deterministic/locale-free. Non-finite values pass
 * through untouched (the engine contract is finite-or-null, and `String`
 * keeps "NaN"/"Infinity" honest); `-0` normalizes to `0` so the text is
 * never `"-0"`.
 */
export function roundForDisplay(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value
  const rounded = Number(value.toPrecision(STAT_DISPLAY_SIGNIFICANT_DIGITS))
  return rounded === 0 ? 0 : rounded
}

/** One numeric statistic: `null` (undefined on the data) renders as '—'. */
export function formatStat(value: number | null | undefined): string {
  return value === null || value === undefined ? MISSING_STAT : String(roundForDisplay(value))
}

/**
 * Accessible name (and text alternative) for a categorical top-k bar chart.
 * Carries every bar's value+count so the chart is fully readable as text —
 * the per-bar `<title>`s and the visible rows restate the same data.
 */
export function topKChartLabel(
  columnName: string,
  topK: readonly EngineCategoricalTopKEntry[],
  distinctCount: number,
): string {
  const entries = topK.map((entry) => `${entry.value} ${String(entry.count)}`).join(', ')
  const shown = `${String(topK.length)} of ${String(distinctCount)} distinct non-null values shown`
  return `Bar chart of top values in column ${columnName}: ${entries} (${shown})`
}

/**
 * Accessible name (and text alternative) for the numeric quantile strip —
 * every boundary value in order, so the distribution is readable as text.
 */
export function quantileStripLabel(columnName: string, stats: EngineNumericColumnStats): string {
  return (
    `Quantile distribution of column ${columnName}: ` +
    `min ${formatStat(stats.min)}, p50 ${formatStat(stats.quantiles.p50)}, ` +
    `p90 ${formatStat(stats.quantiles.p90)}, p95 ${formatStat(stats.quantiles.p95)}, ` +
    `p99 ${formatStat(stats.quantiles.p99)}, max ${formatStat(stats.max)}`
  )
}
