// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { distributionDeltas } from './deltas'

/**
 * Distribution-delta pins (checkpoint C1), computed purely from the two
 * profiles. Goldens are hand-derived: standardized shifts against side A,
 * raw quantile shifts, side-A bins embedded; categorical TV + new/vanished
 * relative to A. Directionality is pinned by swapping sides.
 */

const numericProfile = (
  stats: {
    min: number | null
    max: number | null
    mean: number | null
    stddev: number | null
    quantiles: { p50: number | null; p90: number | null; p95: number | null; p99: number | null }
  },
  rowCount = 1000,
  type = 'DOUBLE',
) => ({
  rowCount,
  columns: [
    {
      name: 'value',
      type,
      kind: 'numeric' as const,
      nullCount: 0,
      distinctCount: rowCount,
      numeric: stats,
    },
  ],
})

describe('distributionDeltas — numeric goldens (standardized against side A)', () => {
  it('pins the standardized mean shift, variance shift, and raw quantile shifts', () => {
    const a = numericProfile({
      min: 0,
      max: 200,
      mean: 100,
      stddev: 20,
      quantiles: { p50: 100, p90: 140, p95: 150, p99: 190 },
    })
    const b = numericProfile({
      min: 5,
      max: 400,
      mean: 105,
      stddev: 30,
      quantiles: { p50: 102.5, p90: 145, p95: 160, p99: 195 },
    })
    const { deltas, issues } = distributionDeltas(a, b)
    expect(issues).toEqual([])
    expect(deltas).toHaveLength(1)
    const delta = deltas[0]
    expect(delta).toMatchObject({
      column: 'value',
      typeA: 'DOUBLE',
      typeB: 'DOUBLE',
      kindA: 'numeric',
      kindB: 'numeric',
    })
    // (105 − 100) / 20 = 0.25 — exactly (A-standardized; swapping sides changes the denominator)
    expect(delta?.numeric?.meanShiftStandardized).toBe(0.25)
    // (30² − 20²) / 20² = (900 − 400) / 400 = 1.25
    expect(delta?.numeric?.varianceShiftStandardized).toBe(1.25)
    // raw quantile shifts in the column's own units
    expect(delta?.numeric?.p50Shift).toBe(2.5)
    expect(delta?.numeric?.p90Shift).toBe(5)
    // side-A bins travel on the delta for downstream PSI/J-S histograms
    expect(delta?.numeric?.bins).toEqual({ edges: [100, 140, 150, 190] })
  })

  it('directionality pin: swapping sides is NOT the same numeric delta', () => {
    const a = numericProfile({
      min: 0,
      max: 10,
      mean: 4,
      stddev: 2,
      quantiles: { p50: 4, p90: 8, p95: 9, p99: 10 },
    })
    const b = numericProfile({
      min: 0,
      max: 10,
      mean: 7,
      stddev: 1,
      quantiles: { p50: 7, p90: 9, p95: 9.5, p99: 10 },
    })
    const forward = distributionDeltas(a, b).deltas[0]?.numeric
    const backward = distributionDeltas(b, a).deltas[0]?.numeric
    // (7−4)/2 = 1.5 forward, (4−7)/1 = −3 backward: sign AND denominator change
    expect(forward?.meanShiftStandardized).toBe(1.5)
    expect(backward?.meanShiftStandardized).toBe(-3)
    expect(forward?.varianceShiftStandardized).toBe((1 - 4) / 4)
    expect(backward?.varianceShiftStandardized).toBe((4 - 1) / 1)
    expect(forward?.p50Shift).toBe(3)
    expect(backward?.p50Shift).toBe(-3)
    // bins always derive from side A (the reference)
    expect(forward?.bins).toEqual({ edges: [4, 8, 9, 10] })
    expect(backward?.bins).toEqual({ edges: [7, 9, 9.5, 10] })
  })

  it('undefined, not zero: zero/unknown reference spread and missing stats are null', () => {
    const constant = numericProfile({
      min: 5,
      max: 5,
      mean: 5,
      stddev: 0, // constant column: no spread → standardization undefined
      quantiles: { p50: 5, p90: 5, p95: 5, p99: 5 },
    })
    const shifted = numericProfile({
      min: 0,
      max: 10,
      mean: 7,
      stddev: 1,
      quantiles: { p50: 7, p90: 9, p95: 9.5, p99: 10 },
    })
    const { deltas } = distributionDeltas(constant, shifted)
    expect(deltas[0]?.numeric?.meanShiftStandardized).toBeNull()
    expect(deltas[0]?.numeric?.varianceShiftStandardized).toBeNull()
    // the raw quantile shifts keep their signal exactly
    expect(deltas[0]?.numeric?.p50Shift).toBe(2)
    expect(deltas[0]?.numeric?.bins).toEqual({ edges: [5] })
  })

  it('overflowing intermediates are null, never NaN/Infinity', () => {
    const a = numericProfile({
      min: -1e300,
      max: 1e300,
      mean: 0,
      stddev: 1e-300,
      quantiles: { p50: 0, p90: 1e300, p95: 1e300, p99: 1e300 },
    })
    const b = numericProfile({
      min: -1e300,
      max: 1e300,
      mean: 1e300,
      stddev: 1e300,
      quantiles: { p50: 0, p90: 0, p95: 0, p99: 0 },
    })
    const { deltas } = distributionDeltas(a, b)
    expect(deltas[0]?.numeric?.meanShiftStandardized).toBeNull() // 1e300 / 1e-300 overflows
    expect(deltas[0]?.numeric?.varianceShiftStandardized).toBeNull()
  })

  it('identity: a numeric column compared to itself is exactly 0 everywhere', () => {
    const a = numericProfile({
      min: -3,
      max: 3,
      mean: 0.5,
      stddev: 1.5,
      quantiles: { p50: 0.25, p90: 2, p95: 2.5, p99: 2.75 },
    })
    const { deltas, issues } = distributionDeltas(a, a)
    expect(issues).toEqual([])
    const numeric = deltas[0]?.numeric
    expect(numeric?.meanShiftStandardized).toBe(0)
    expect(numeric?.varianceShiftStandardized).toBe(0)
    expect(numeric?.p50Shift).toBe(0)
    expect(numeric?.p90Shift).toBe(0)
  })

  it('identity stays exactly zero for a valid positive subnormal-scale spread', () => {
    // σA = σB = 1e-200: σ² = 1e-400 underflows to 0 in a double, so the old
    // quotient form (σB² − σA²)/σA² produced 0/0 = NaN → a spurious `null`
    // for a mathematically-defined identity. The ratio form is exact.
    const subnormal = {
      min: -1e-200,
      max: 1e-200,
      mean: 3e-200,
      stddev: 1e-200,
      quantiles: { p50: 0, p90: 1e-200, p95: 1e-200, p99: 1e-200 },
    }
    const a = numericProfile(subnormal)
    const b = numericProfile(JSON.parse(JSON.stringify(subnormal)))
    const { deltas, issues } = distributionDeltas(a, b)
    expect(issues).toEqual([])
    const numeric = deltas[0]?.numeric
    expect(numeric?.varianceShiftStandardized).toBe(0)
    expect(numeric?.meanShiftStandardized).toBe(0)
    expect(numeric?.p50Shift).toBe(0)
    expect(numeric?.p90Shift).toBe(0)
  })

  it('the ratio form keeps the defined relative shift at subnormal spread (golden)', () => {
    // σA = 1e-200, σB = 2e-200 → (σB/σA)² − 1 = 2² − 1 = 3 exactly (the old
    // quotient form underflowed to (0 − 0)/0 = NaN → null).
    const a = numericProfile({
      min: -1e-200,
      max: 2e-200,
      mean: 0,
      stddev: 1e-200,
      quantiles: { p50: 0, p90: 1e-200, p95: 1e-200, p99: 2e-200 },
    })
    const b = numericProfile({
      min: -2e-200,
      max: 4e-200,
      mean: 1e-200,
      stddev: 2e-200,
      quantiles: { p50: 1e-200, p90: 2e-200, p95: 2e-200, p99: 3e-200 },
    })
    const { deltas, issues } = distributionDeltas(a, b)
    expect(issues).toEqual([])
    const numeric = deltas[0]?.numeric
    expect(numeric?.varianceShiftStandardized).toBe(3)
    // (1e-200 − 0) / 1e-200 = 1 — the mean standardization is exact too
    expect(numeric?.meanShiftStandardized).toBe(1)
    expect(numeric?.p50Shift).toBe(1e-200)
  })
})

describe('distributionDeltas — categorical goldens', () => {
  const categoricalProfile = (
    topK: { value: string; count: number }[],
    rowCount: number,
    nullCount = 0,
    type = 'VARCHAR',
  ) => ({
    rowCount,
    columns: [
      {
        name: 'country',
        type,
        kind: 'categorical' as const,
        nullCount,
        distinctCount: 5,
        categorical: { topK },
      },
    ],
  })

  it('pins TV over top-k∪other and the new/vanished lists relative to A', () => {
    const a = categoricalProfile(
      [
        { value: 'US', count: 60 },
        { value: 'GB', count: 40 },
      ],
      100,
    )
    const b = categoricalProfile([{ value: 'GB', count: 50 }], 100)
    const { deltas, issues } = distributionDeltas(a, b)
    expect(issues).toEqual([])
    const categorical = deltas[0]?.categorical
    expect(categorical?.totalVariation).toBeCloseTo(0.6, 12)
    expect(categorical?.newCategories).toEqual([])
    expect(categorical?.vanishedCategories).toEqual([{ value: 'US', count: 60 }])
  })

  it('carries prototype-spelling category values as inert report content', () => {
    const a = categoricalProfile([{ value: '__proto__', count: 10 }], 10)
    const b = categoricalProfile([{ value: 'toString', count: 4 }], 10)
    const { deltas } = distributionDeltas(a, b)
    expect(deltas[0]?.categorical?.newCategories).toEqual([{ value: 'toString', count: 4 }])
    expect(deltas[0]?.categorical?.vanishedCategories).toEqual([{ value: '__proto__', count: 10 }])
  })

  it('identity: identical categorical profiles are exactly 0 with empty lists', () => {
    const a = categoricalProfile(
      [
        { value: 'US', count: 6 },
        { value: 'GB', count: 4 },
      ],
      10,
      0,
    )
    const { deltas } = distributionDeltas(a, a)
    expect(deltas[0]?.categorical?.totalVariation).toBe(0)
    expect(deltas[0]?.categorical?.newCategories).toEqual([])
    expect(deltas[0]?.categorical?.vanishedCategories).toEqual([])
  })

  it('null shares enter the TV denominator (non-null mass, documented)', () => {
    // nonNull = 150 − 100 = 50 on both sides; shares are count/50
    const a = categoricalProfile([{ value: 'US', count: 50 }], 150, 100)
    const b = categoricalProfile([{ value: 'GB', count: 25 }], 150, 100)
    const { deltas } = distributionDeltas(a, b)
    expect(deltas[0]?.categorical?.totalVariation).toBe(1)
  })
})

describe('distributionDeltas — matching and documented skips', () => {
  it('columns present on one side only get no delta (presence is schema drift’s)', () => {
    const profile = (names: string[]) => ({
      rowCount: 10,
      columns: names.map((name) => ({
        name,
        type: 'INTEGER',
        kind: 'numeric' as const,
        nullCount: 0,
        distinctCount: 3,
        numeric: {
          min: 0,
          max: 1,
          mean: 0.5,
          stddev: 0.25,
          quantiles: { p50: 0.5, p90: 1, p95: 1, p99: 1 },
        },
      })),
    })
    const { deltas, issues } = distributionDeltas(profile(['a', 'gone']), profile(['a', 'new']))
    expect(issues).toEqual([])
    expect(deltas.map((d) => d.column)).toEqual(['a']) // 'gone'/'new' belong to schema drift
  })

  it('kind-changed columns get an entry without metrics (the type finding explains it)', () => {
    const a = {
      rowCount: 10,
      columns: [
        {
          name: 'x',
          type: 'INTEGER',
          kind: 'numeric' as const,
          nullCount: 0,
          distinctCount: 3,
          numeric: {
            min: 0,
            max: 1,
            mean: 0.5,
            stddev: 0.25,
            quantiles: { p50: 0.5, p90: 1, p95: 1, p99: 1 },
          },
        },
      ],
    }
    const b = {
      rowCount: 10,
      columns: [
        {
          name: 'x',
          type: 'VARCHAR',
          kind: 'categorical' as const,
          nullCount: 0,
          distinctCount: 3,
          categorical: { topK: [{ value: '1', count: 3 }] },
        },
      ],
    }
    const { deltas } = distributionDeltas(a, b)
    expect(deltas).toEqual([
      {
        column: 'x',
        typeA: 'INTEGER',
        typeB: 'VARCHAR',
        kindA: 'numeric',
        kindB: 'categorical',
      },
    ])
  })

  it('deltas appear in profile-A column order (documented ordering)', () => {
    const profile = (names: string[]) => ({
      rowCount: 10,
      columns: names.map((name) => ({
        name,
        type: 'INTEGER',
        kind: 'other' as const,
        nullCount: 0,
        distinctCount: 1,
      })),
    })
    expect(
      distributionDeltas(profile(['z', 'a', 'm']), profile(['m', 'z', 'a'])).deltas.map(
        (d) => d.column,
      ),
    ).toEqual(['z', 'a', 'm'])
  })
})
