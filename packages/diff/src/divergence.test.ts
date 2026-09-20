import { describe, expect, it } from 'vitest'
import { binIndex } from './bins'
import {
  DIVERGENCE_EPSILON,
  JENSEN_SHANNON_MAX,
  jensenShannon,
  newCategories,
  psi,
  totalVariation,
  vanishedCategories,
} from './divergence'

/**
 * Divergence pins (checkpoint C1). Golden values are hand-derived:
 *
 * - PSI([.5,.5]‖[.25,.75]) = .25·ln 2 + .25·ln(3/2) = 0.274653072167…
 * - J-S([.5,.5],[.25,.75]): M = (.375,.625); ½·KL(A‖M) + ½·KL(B‖M)
 *   = ½(.5·ln(4/3) + .5·ln(.8)) + ½(.25·ln(2/3) + .75·ln(1.2))
 *   = 0.033822075568605205
 * - TV(A=[x:.6,y:.4], B=[y:.5]) over top-k∪{other} = ½(.6+.1+.5) = 0.6
 *
 * The PSI directionality is honest: the Σ(a−b)ln(a/b) form is the
 * *symmetrized* (Jeffreys) KL — on fixed bins it is formally symmetric
 * (pinned to 12 decimals). The documented asymmetry lives in the bins:
 * reports always bin by side A, and A-bins vs B-bins genuinely differ
 * (pinned below). J-S is symmetric by construction; TV is symmetric.
 */

const EPS = DIVERGENCE_EPSILON

describe('psi — goldens and conventions', () => {
  it('matches the hand-derived golden (natural log, nats)', () => {
    expect(psi([10], [50, 50], [25, 75])).toBeCloseTo(0.27465307216702745, 12)
  })

  it('is exactly 0 for identical count vectors (identity pin)', () => {
    expect(psi([10], [30, 70], [30, 70])).toBe(0)
    expect(psi([1, 2, 3], [5, 0, 5, 7], [5, 0, 5, 7])).toBe(0)
  })

  it('is symmetric on fixed bins (Jeffreys form — pinned to rounding)', () => {
    const forward = psi([10], [50, 50], [25, 75])
    const swapped = psi([10], [25, 75], [50, 50])
    if (forward === null || swapped === null) throw new Error('unreachable: valid histograms')
    expect(forward).toBeCloseTo(swapped, 12)
  })

  it('the directionality lives in the bins: same data, A-bins vs B-bins differ (pinned)', () => {
    // Histogram the SAME raw values through two different reference binnings
    // (A's quantile bins vs B's quantile bins, via the documented binIndex
    // semantics): the count vectors genuinely differ, so "PSI(A‖B) is
    // A-binned" is a real directionality choice, not a phrasing one.
    const valuesA = [1, 1, 1, 1, 9]
    const valuesB = [11, 12, 13]
    const aBins = [5] // A's degenerate reference collapses to one edge
    const bBins = [12, 13] // B's quantile cutpoint set
    const countsInto = (edges: number[], values: number[]) => {
      const counts = Array.from<number>({ length: edges.length + 1 }).fill(0)
      for (const v of values) counts[binIndex(edges, v)] += 1
      return counts
    }
    const psiOnABins = psi(aBins, countsInto(aBins, valuesA), countsInto(aBins, valuesB))
    const psiOnBBins = psi(bBins, countsInto(bBins, valuesA), countsInto(bBins, valuesB))
    if (psiOnABins === null || psiOnBBins === null)
      throw new Error('unreachable: histograms are valid')
    expect(psiOnABins).not.toBeCloseTo(psiOnBBins, 3)
  })

  it('substitutes the documented epsilon for a one-sided zero bin', () => {
    // A has no mass in bin 0 → its share becomes EPS; b = (.5, .5):
    // term0 = (EPS − .5)·ln(EPS/.5); term1 = (1 − .5)·ln(1/.5)
    const expected = (EPS - 0.5) * Math.log(EPS / 0.5) + 0.5 * Math.log(1 / 0.5)
    expect(psi([10], [0, 100], [100, 100])).toBeCloseTo(expected, 12)
  })

  it('a bin with zero mass on both sides contributes exactly 0 (no epsilon)', () => {
    expect(psi([10, 20], [10, 0, 90], [10, 0, 90])).toBe(0)
    expect(psi([10], [0, 100], [0, 50])).toBeCloseTo(0, 12) // both-zero bin 0
  })

  it('is non-negative and finite wherever defined', () => {
    expect(psi([10], [1, 99], [99, 1])).toBeGreaterThan(0)
    expect(psi([10], [1, 99], [99, 1])).toBeLessThan(30) // bounded by the epsilon convention in practice
  })

  it('returns null (documented undefined) on malformed vectors', () => {
    expect(psi([10], [50], [25, 75])).toBeNull() // length mismatch
    expect(psi([10], [-1, 101], [25, 75])).toBeNull() // negative count
    expect(psi([10], [0, 0], [25, 75])).toBeNull() // empty side
    expect(psi([10], [NaN, 100], [25, 75])).toBeNull() // non-finite count
    expect(psi([10], [Infinity, 0], [25, 75])).toBeNull() // non-finite total
    expect(psi('nope' as unknown as number[], [50, 50], [25, 75])).toBeNull()
    expect(psi([NaN], [50, 50], [25, 75])).toBeNull() // non-finite edge
  })
})

describe('jensenShannon — goldens and conventions', () => {
  it('matches the hand-derived golden (nats)', () => {
    expect(jensenShannon([10], [50, 50], [25, 75])).toBeCloseTo(0.033822075568605205, 12)
  })

  it('is exactly 0 for identical count vectors (identity pin)', () => {
    expect(jensenShannon([10], [5, 5], [5, 5])).toBe(0)
  })

  it('is symmetric by construction (pinned)', () => {
    expect(jensenShannon([10], [50, 50], [25, 75])).toBeCloseTo(
      jensenShannon([10], [25, 75], [50, 50]) as number,
      12,
    )
  })

  it('is bounded by ln 2 with no epsilon machinery', () => {
    expect(jensenShannon([10], [100, 0], [0, 100])).toBeCloseTo(Math.LN2, 12)
    expect(JENSEN_SHANNON_MAX).toBe(Math.LN2)
    expect(jensenShannon([10], [100, 0], [0, 100])).toBeLessThanOrEqual(JENSEN_SHANNON_MAX)
  })

  it('returns null (documented undefined) on malformed vectors', () => {
    expect(jensenShannon([10], [50], [25, 75])).toBeNull()
    expect(jensenShannon([10], [0, 0], [25, 75])).toBeNull()
    expect(jensenShannon([10], [NaN, 100], [25, 75])).toBeNull()
  })
})

describe('totalVariation — goldens and conventions', () => {
  it('matches the hand-derived top-k∪other golden', () => {
    // A: x .6, y .4, other 0 · B: y .5, other .5 → ½(.6 + .1 + .5) = 0.6
    expect(
      totalVariation(
        [
          { value: 'x', count: 60 },
          { value: 'y', count: 40 },
        ],
        100,
        [{ value: 'y', count: 50 }],
        100,
      ),
    ).toBeCloseTo(0.6, 12)
  })

  it('is exactly 0 for identical summaries (identity pin)', () => {
    expect(totalVariation([{ value: 'x', count: 3 }], 10, [{ value: 'x', count: 3 }], 10)).toBe(0)
  })

  it('is symmetric (pinned)', () => {
    const a = [
      { value: 'x', count: 60 },
      { value: 'y', count: 40 },
    ]
    const b = [{ value: 'y', count: 50 }]
    expect(totalVariation(a, 100, b, 100)).toBeCloseTo(totalVariation(b, 100, a, 100) as number, 12)
  })

  it('is bounded by [0, 1]', () => {
    expect(totalVariation([{ value: 'x', count: 10 }], 10, [{ value: 'y', count: 10 }], 10)).toBe(1)
    // disjoint supports (including the pooled other): the maximal distance
    expect(totalVariation([{ value: 'x', count: 10 }], 10, [], 10)).toBe(1)
  })

  it('treats prototype-spelling values as inert strings', () => {
    expect(
      totalVariation(
        [{ value: '__proto__', count: 10 }],
        10,
        [{ value: '__proto__', count: 4 }],
        10,
      ),
    ).toBeCloseTo(0.6, 12)
  })

  it('returns null (documented undefined) on malformed input', () => {
    expect(
      totalVariation([{ value: 'x', count: 60 }], 0, [{ value: 'y', count: 5 }], 10),
    ).toBeNull() // empty side
    expect(totalVariation([{ value: 'x', count: 6 }], 5, [{ value: 'y', count: 5 }], 10)).toBeNull() // counts exceed non-null mass
    expect(
      totalVariation(
        [
          { value: 'x', count: 2 },
          { value: 'x', count: 3 },
        ],
        100,
        [],
        10,
      ),
    ).toBeNull() // duplicate value
    expect(totalVariation([{ value: 5, count: 2 }] as never, 10, [], 10)).toBeNull() // non-string value
    expect(totalVariation([{ value: 'x', count: -1 }], 10, [], 10)).toBeNull()
    expect(totalVariation([], 10.5, [], 10)).toBeNull() // non-integer mass
  })
})

describe('new/vanished categories — relative to A, documented order', () => {
  const topKA = [
    { value: 'x', count: 60 },
    { value: 'y', count: 40 },
  ]
  const topKB = [
    { value: 'y', count: 70 },
    { value: 'z', count: 20 },
    { value: 'x', count: 10 },
  ]

  it('new = in B’s top-k, absent from A’s (B’s order)', () => {
    expect(newCategories(topKA, topKB)).toEqual([{ value: 'z', count: 20 }])
  })

  it('vanished = in A’s top-k, absent from B’s (A’s order)', () => {
    expect(vanishedCategories(topKA, topKB)).toEqual([])
    expect(vanishedCategories(topKB, topKA)).toEqual([{ value: 'z', count: 20 }])
  })

  it('swapping sides exchanges the lists exactly (pinned)', () => {
    expect(newCategories(topKB, topKA)).toEqual(vanishedCategories(topKA, topKB))
  })

  it('identity: neither list has entries', () => {
    expect(newCategories(topKA, topKA)).toEqual([])
    expect(vanishedCategories(topKA, topKA)).toEqual([])
  })

  it('prototype-spelling values participate as plain strings', () => {
    expect(
      newCategories([{ value: '__proto__', count: 1 }], [{ value: 'toString', count: 1 }]),
    ).toEqual([{ value: 'toString', count: 1 }])
  })
})
