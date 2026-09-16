import type { EngineCategoricalTopKEntry, EngineNumericColumnStats } from '@assay/engine-duckdb'

/**
 * Text formatting for the profile panel (m2-6) — pure, deterministic, and
 * Node-tested. Profile outputs are *data* (ADR 0007 spirit): everything here
 * produces plain strings rendered through React text interpolation — never
 * markup — and nothing here logs (ADR 0025).
 *
 * Number rendering is deliberately `String(value)`: the engine contract
 * (m2-5) delivers finite doubles or null, so the exact double text is both
 * honest (no silent rounding of, say, a sample stddev) and deterministic
 * (locale-free, stable for e2e pinning). Null stats render as '—' — an
 * undefined statistic is shown as missing, never faked as a value.
 */

/** The honest "no value" rendering for a null statistic. */
export const MISSING_STAT = '—' as const

/** One numeric statistic: `null` (undefined on the data) renders as '—'. */
export function formatStat(value: number | null | undefined): string {
  return value === null || value === undefined ? MISSING_STAT : String(value)
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
