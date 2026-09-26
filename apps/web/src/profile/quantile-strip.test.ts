// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type { EngineNumericColumnStats } from '@assay/engine-duckdb'
import { quantileStrip } from './quantile-strip'

/** Numeric stats helper: min/max plus the four quantiles (other stats unused here). */
function stats(
  min: number | null,
  max: number | null,
  p50: number | null,
  p90: number | null,
  p95: number | null,
  p99: number | null,
): EngineNumericColumnStats {
  return { min, max, mean: null, stddev: null, quantiles: { p50, p90, p95, p99 } }
}

/**
 * Pins for the quantile-bucket geometry (m2-6): proportional segments over
 * min→p50→p90→p95→p99→max, the degenerate all-equal case, null-boundary
 * skipping with annotation, and the defensive clamps.
 */
describe('quantileStrip', () => {
  it('builds five proportional segments over the exact engine boundaries', () => {
    // customer_id of customers.parquet (values 1..5): quantile fractions of
    // the span 4 — exactly what the SVG renders.
    const strip = quantileStrip(stats(1, 5, 3, 4.6, 4.8, 4.96))
    expect(strip.degenerate).toBe(false)
    expect(strip.skipped).toEqual([])
    expect(strip.segments.map((segment) => segment.name)).toEqual([
      'min–p50',
      'p50–p90',
      'p90–p95',
      'p95–p99',
      'p99–max',
    ])
    expect(strip.segments.map((segment) => segment.fromFraction)).toEqual(
      [0, 0.5, 0.9, 0.95, 0.99].map((expected) => expect.closeTo(expected)),
    )
    expect(strip.segments.map((segment) => segment.toFraction)).toEqual(
      [0.5, 0.9, 0.95, 0.99, 1].map((expected) => expect.closeTo(expected)),
    )
    expect(strip.segments[0]).toEqual({
      name: 'min–p50',
      from: 1,
      to: 3,
      fromFraction: 0,
      toFraction: 0.5,
    })
  })

  it('covers the whole track: first segment starts at 0, last ends at 1, widths are contiguous', () => {
    const strip = quantileStrip(stats(0, 49, 24.5, 44.1, 46.55, 48.51))
    expect(strip.segments[0]!.fromFraction).toBe(0)
    expect(strip.segments.at(-1)!.toFraction).toBe(1)
    for (let index = 1; index < strip.segments.length; index++) {
      expect(strip.segments[index]!.fromFraction).toBe(strip.segments[index - 1]!.toFraction)
    }
  })

  it('a degenerate column (min === max) renders one full-width segment', () => {
    const strip = quantileStrip(stats(7, 7, 7, 7, 7, 7))
    expect(strip.degenerate).toBe(true)
    expect(strip.segments).toEqual([
      { name: 'min–max', from: 7, to: 7, fromFraction: 0, toFraction: 1 },
    ])
  })

  it('an all-null column has no geometry (the panel explains instead of drawing)', () => {
    expect(quantileStrip(stats(null, null, null, null, null, null))).toEqual({
      segments: [],
      degenerate: false,
      skipped: [],
    })
  })

  it('a null interior quantile is skipped, its neighbors merge, and the skip is annotated', () => {
    const strip = quantileStrip(stats(0, 10, 5, null, 8, 9))
    expect(strip.skipped).toEqual(['p90'])
    expect(strip.segments.map((segment) => segment.name)).toEqual([
      'min–p50',
      'p50–p95', // p90 skipped: the segment spans straight across it
      'p95–p99',
      'p99–max',
    ])
    expect(strip.segments[1]).toEqual({
      name: 'p50–p95',
      from: 5,
      to: 8,
      fromFraction: 0.5,
      toFraction: 0.8,
    })
  })

  it('multiple null interior quantiles are all skipped and annotated', () => {
    const strip = quantileStrip(stats(0, 10, null, null, 8, null))
    expect(strip.skipped).toEqual(['p50', 'p90', 'p99'])
    expect(strip.segments.map((segment) => segment.name)).toEqual(['min–p95', 'p95–max'])
  })

  it('is defensive against out-of-span boundaries: positions clamp to [0,1]', () => {
    // The engine delivers exact monotone quantiles; a broken engine must not
    // produce negative-width or out-of-track geometry.
    const strip = quantileStrip(stats(0, 10, 20, 5, 5, -1))
    expect(strip.skipped).toEqual([])
    for (const segment of strip.segments) {
      expect(segment.fromFraction).toBeGreaterThanOrEqual(0)
      expect(segment.toFraction).toBeLessThanOrEqual(1)
      expect(segment.toFraction).toBeGreaterThanOrEqual(segment.fromFraction)
    }
  })
})
