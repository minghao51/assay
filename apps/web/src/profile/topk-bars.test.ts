// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { scaleTopKBars } from './topk-bars'

/**
 * Pins for the categorical top-k bar scaling (m2-6): widths are relative to
 * the largest count (longest bar = full track), engine order is preserved,
 * and degenerate inputs degrade without throwing.
 */
describe('scaleTopKBars', () => {
  it('scales each bar relative to the largest count', () => {
    expect(
      scaleTopKBars([
        { value: 'SG', count: 2 },
        { value: 'US', count: 2 },
        { value: 'DE', count: 1 },
      ]),
    ).toEqual([
      { value: 'SG', count: 2, fraction: 1 },
      { value: 'US', count: 2, fraction: 1 },
      { value: 'DE', count: 1, fraction: 0.5 },
    ])
  })

  it('preserves the engine’s count-descending / value-ascending order untouched', () => {
    const entries = [
      { value: 'a', count: 5 },
      { value: 'b', count: 3 },
      { value: 'c', count: 3 },
    ]
    expect(scaleTopKBars(entries).map((bar) => bar.value)).toEqual(['a', 'b', 'c'])
  })

  it('a single entry spans the full track', () => {
    expect(scaleTopKBars([{ value: 'only', count: 7 }])).toEqual([
      { value: 'only', count: 7, fraction: 1 },
    ])
  })

  it('fractions stay in [0,1] for skewed counts', () => {
    const bars = scaleTopKBars([
      { value: 'big', count: 1000 },
      { value: 'small', count: 1 },
    ])
    expect(bars.map((bar) => bar.fraction)).toEqual([1, 0.001])
  })

  it('an empty top-k produces no bars', () => {
    expect(scaleTopKBars([])).toEqual([])
  })

  it('is defensive against all-zero counts (no division by zero, zero-width bars)', () => {
    expect(
      scaleTopKBars([
        { value: 'x', count: 0 },
        { value: 'y', count: 0 },
      ]),
    ).toEqual([
      { value: 'x', count: 0, fraction: 0 },
      { value: 'y', count: 0, fraction: 0 },
    ])
  })
})
