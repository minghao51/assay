// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { MISSING_STAT, formatStat, quantileStripLabel, topKChartLabel } from './format-stats'

/**
 * Pins for the profile panel's text layer (m2-6 + ux-3): null statistics
 * render as '—' (never faked as a value), numbers render display-rounded to
 * six significant digits (pure, locale-free, e2e-stable) while the exact
 * double stays in the JSON/CLI envelopes, and the chart accessible names
 * carry the complete data as a text alternative.
 */
describe('formatStat', () => {
  it('renders null and undefined as the missing-stat dash', () => {
    expect(formatStat(null)).toBe(MISSING_STAT)
    expect(formatStat(undefined)).toBe('—')
  })

  it('renders numbers display-rounded to six significant digits, locale-free', () => {
    expect(formatStat(0)).toBe('0')
    expect(formatStat(-0)).toBe('0')
    expect(formatStat(48000)).toBe('48000')
    expect(formatStat(4.6)).toBe('4.6')
    // The audit's raw-float offenders (UX-5): rounded to six significant
    // digits, never the full double text.
    expect(formatStat(1.5811388300841898)).toBe('1.58114')
    expect(formatStat(1.6329931618554474)).toBe('1.63299')
    expect(formatStat(955.0500000000002)).toBe('955.05')
    expect(formatStat(11972.189997378648)).toBe('11972.2')
    expect(formatStat(-12.5)).toBe('-12.5')
  })

  it('keeps the rounding rule total: non-finite values pass through', () => {
    expect(formatStat(Number.POSITIVE_INFINITY)).toBe('Infinity')
    expect(formatStat(Number.NaN)).toBe('NaN')
  })
})

describe('topKChartLabel — accessible name / text alternative of the top-k bar chart', () => {
  it('lists every bar as value+count with the distinct-value context', () => {
    expect(
      topKChartLabel(
        'country',
        [
          { value: 'SG', count: 2 },
          { value: 'US', count: 2 },
          { value: 'DE', count: 1 },
        ],
        3,
      ),
    ).toBe(
      'Bar chart of top values in column country: SG 2, US 2, DE 1 (3 of 3 distinct non-null values shown)',
    )
  })

  it('states how much of the cardinality the top-k covers (k < distinct)', () => {
    const label = topKChartLabel(
      'bucket',
      Array.from({ length: 10 }, (_, index) => ({ value: String(index), count: 10 })),
      100,
    )
    expect(label).toContain('(10 of 100 distinct non-null values shown)')
  })

  it('renders an empty top-k honestly (zero shown)', () => {
    expect(topKChartLabel('ghost', [], 0)).toBe(
      'Bar chart of top values in column ghost:  (0 of 0 distinct non-null values shown)',
    )
  })
})

describe('quantileStripLabel — accessible name / text alternative of the quantile strip', () => {
  it('carries every boundary value in order', () => {
    expect(
      quantileStripLabel('income', {
        min: 48000,
        max: 75000,
        mean: 59000,
        stddev: 11972.189997378648,
        quantiles: { p50: 56500, p90: 70800, p95: 72900, p99: 74580 },
      }),
    ).toBe(
      'Quantile distribution of column income: min 48000, p50 56500, p90 70800, p95 72900, p99 74580, max 75000',
    )
  })

  it('uses the missing-stat dash for null boundaries (all-null column)', () => {
    expect(
      quantileStripLabel('void', {
        min: null,
        max: null,
        mean: null,
        stddev: null,
        quantiles: { p50: null, p90: null, p95: null, p99: null },
      }),
    ).toBe('Quantile distribution of column void: min —, p50 —, p90 —, p95 —, p99 —, max —')
  })
})
