import type { EngineNumericColumnStats } from '@assay/engine-duckdb'

/**
 * Geometry for the numeric quantile distribution strip (m2-6) — pure and
 * Node-tested.
 *
 * The m2-5 engine contract delivers exact p50/p90/p95/p99 (finite or null)
 * but no row samples, so a true histogram is impossible here; the honest
 * chart is a **strip of proportional quantile buckets**: the segment between
 * consecutive boundaries min→p50→p90→p95→p99→max is drawn with width equal
 * to that boundary gap's share of the [min, max] span. The panel labels it
 * "quantile distribution" — it shows where the quantile boundaries sit, not
 * row density between them.
 *
 * Defensive posture (the engine guarantees monotone exact quantiles, but
 * this module is total): positions are clamped to [0,1] and segment widths
 * never go negative; null interior quantiles are *skipped* (their neighbors
 * merge into one segment) and reported in `skipped` so the UI can annotate.
 */

export interface StripSegment {
  /** Boundary pair this segment spans, e.g. `p90–p95`. */
  readonly name: string
  readonly from: number
  readonly to: number
  /** Segment start within [min, max], clamped to [0,1]. */
  readonly fromFraction: number
  /** Segment end within [min, max], clamped to [0,1] and ≥ fromFraction. */
  readonly toFraction: number
}

export interface QuantileStrip {
  readonly segments: readonly StripSegment[]
  /** True when min === max — every non-null value is identical: one full-width segment. */
  readonly degenerate: boolean
  /** Names of null interior quantiles that were skipped (empty normally). */
  readonly skipped: readonly string[]
}

const EMPTY_STRIP: QuantileStrip = { segments: [], degenerate: false, skipped: [] }

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Builds the strip geometry, or an empty strip when there is nothing to draw. */
export function quantileStrip(stats: EngineNumericColumnStats): QuantileStrip {
  const { min, max, quantiles } = stats
  if (min === null || max === null) return EMPTY_STRIP

  const span = max - min
  if (span <= 0) {
    // Degenerate (all non-null values equal): exact quantiles equal min/max,
    // so a single full-width segment is the faithful rendering.
    return {
      segments: [{ name: 'min–max', from: min, to: max, fromFraction: 0, toFraction: 1 }],
      degenerate: true,
      skipped: [],
    }
  }

  const position = (value: number): number => clamp01((value - min) / span)
  const interior: ReadonlyArray<{ name: string; value: number | null }> = [
    { name: 'p50', value: quantiles.p50 },
    { name: 'p90' as const, value: quantiles.p90 },
    { name: 'p95' as const, value: quantiles.p95 },
    { name: 'p99', value: quantiles.p99 },
  ]
  const skipped = interior
    .filter((boundary) => boundary.value === null)
    .map((boundary) => boundary.name)

  const bounds: { name: string; value: number; fraction: number }[] = [
    { name: 'min', value: min, fraction: 0 },
    ...interior
      .filter((boundary): boundary is { name: string; value: number } => boundary.value !== null)
      .map((boundary) => ({
        name: boundary.name,
        value: boundary.value,
        fraction: position(boundary.value),
      })),
    { name: 'max', value: max, fraction: 1 },
  ]

  const segments: StripSegment[] = []
  for (let index = 0; index < bounds.length - 1; index++) {
    const start = bounds[index]!
    const end = bounds[index + 1]!
    segments.push({
      name: `${start.name}–${end.name}`,
      from: start.value,
      to: end.value,
      fromFraction: start.fraction,
      // Defensive: monotone input makes the max redundant; a non-monotone
      // boundary collapses its segment to zero width instead of back-tracking.
      toFraction: Math.max(end.fraction, start.fraction),
    })
  }
  return { segments, degenerate: false, skipped }
}
