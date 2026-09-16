/**
 * Bar scaling for the categorical top-k chart (m2-6) — pure and Node-tested.
 *
 * The engine's top-k (m2-5) is ordered by count descending (ties by value
 * ascending); this module only attaches geometry. Bar widths are relative to
 * the **largest** count (the longest bar spans the full track) — the standard
 * bar-chart normalization, independent of k and of the row count, so a
 * top-k of 3 of 5 distinct values still reads proportionally.
 */

export interface TopKBar {
  /** Engine-rendered value text (ADR 0007 spirit — displayed verbatim). */
  readonly value: string
  readonly count: number
  /**
   * Bar width as a fraction of the track, `count / max(count)` — in [0,1].
   * 0 only in the defensive all-zero case (the engine never emits a 0 count).
   */
  readonly fraction: number
}

/** Attaches proportional widths to a top-k list, preserving engine order. */
export function scaleTopKBars(entries: readonly { value: string; count: number }[]): TopKBar[] {
  let max = 0
  for (const entry of entries) {
    if (entry.count > max) max = entry.count
  }
  return entries.map((entry) => ({
    value: entry.value,
    count: entry.count,
    fraction: max > 0 ? entry.count / max : 0,
  }))
}
