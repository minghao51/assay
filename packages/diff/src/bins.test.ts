// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { binIndex, deriveBins } from './bins'

/**
 * Bin-derivation pins (checkpoint C1): cutpoints are side A's p50/p90/p95/p99
 * (documented), sorted ascending, deduplicated, `-0` normalized; bins are the
 * half-open intervals with exclusive upper edges and unbounded outers.
 * `deriveBins` is total over hostile stats (documented degradation).
 */

const stats = (q: {
  p50: number | null
  p90: number | null
  p95: number | null
  p99: number | null
}) => ({
  min: null,
  max: null,
  mean: null,
  stddev: null,
  quantiles: q,
})

describe('deriveBins — the documented convention', () => {
  it('derives ascending edges from the four quantile cutpoints', () => {
    expect(deriveBins(stats({ p50: 50, p90: 90, p95: 95, p99: 99 })).edges).toEqual([
      50, 90, 95, 99,
    ])
  })

  it('sorts hostile out-of-order quantiles ascending', () => {
    expect(deriveBins(stats({ p50: 95, p90: 50, p95: 99, p99: 90 })).edges).toEqual([
      50, 90, 95, 99,
    ])
  })

  it('collapses a constant/degenerate reference to one edge (two bins)', () => {
    expect(deriveBins(stats({ p50: 42, p90: 42, p95: 42, p99: 42 })).edges).toEqual([42])
  })

  it('skips null and non-finite cutpoints', () => {
    expect(deriveBins(stats({ p50: 10, p90: null, p95: Infinity, p99: 20 })).edges).toEqual([
      10, 20,
    ])
  })

  it('yields zero edges (one bin) when no cutpoint survives', () => {
    expect(deriveBins(stats({ p50: null, p90: null, p95: null, p99: null })).edges).toEqual([])
  })

  it('is total over a hostile stats object (missing quantiles, non-number entries)', () => {
    expect(deriveBins(undefined as unknown as Parameters<typeof deriveBins>[0]).edges).toEqual([])
    expect(
      deriveBins({
        min: null,
        max: null,
        mean: null,
        stddev: null,
        quantiles: { p50: 'five', p90: 5, p95: NaN, p99: 9 } as unknown as never,
      }).edges,
    ).toEqual([5, 9])
  })

  it('normalizes -0 cutpoints to +0', () => {
    const edges = deriveBins(stats({ p50: -0, p90: 0, p95: 5, p99: 9 })).edges
    expect(edges).toEqual([0, 5, 9])
    for (const edge of edges) expect(Object.is(edge, -0)).toBe(false)
  })
})

describe('binIndex — edge semantics (edges are exclusive upper bounds)', () => {
  const edges = [10, 20, 30, 40]

  it('classifies below, at, and between edges', () => {
    expect(binIndex(edges, 5)).toBe(0)
    expect(binIndex(edges, 10)).toBe(1) // equal to an edge → upper bin
    expect(binIndex(edges, 15)).toBe(1)
    expect(binIndex(edges, 20)).toBe(2)
    expect(binIndex(edges, 35)).toBe(3)
  })

  it('the last bin is unbounded above', () => {
    expect(binIndex(edges, 40)).toBe(4)
    expect(binIndex(edges, 40000)).toBe(4)
    expect(binIndex(edges, Infinity)).toBe(4)
  })

  it('the first bin reaches to -Infinity', () => {
    expect(binIndex(edges, -Infinity)).toBe(0)
    expect(binIndex([], 7)).toBe(0) // a single bin covers everything
  })

  it('NaN classifies into the last bin (documented degenerate)', () => {
    expect(binIndex(edges, NaN)).toBe(4)
  })
})
