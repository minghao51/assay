/**
 * Deterministic reference-bin derivation (checkpoint C1).
 *
 * PSI and Jensen–Shannon need histograms; profiles don't carry them. This
 * module is half of the documented seam: `deriveBins` produces the bins
 * from **side A's** numeric stats (A = reference), downstream tasks (m6-2's
 * engine execution) produce the per-bin counts on both sides, and
 * `divergence.ts` turns (bins, countsA, countsB) into a divergence.
 *
 * ## The documented bin convention
 *
 * - Cutpoints are side A's profile quantiles **p50, p90, p95, p99** (the m2
 *   profile contract's exact position set). Profile `min`/`max` are context
 *   only and never become edges: quantile cutpoints keep every bin
 *   non-trivially populated on A, and the outer bins are unbounded so
 *   current-side values beyond the reference range always classify — that
 *   tail mass is exactly the drift signal.
 * - Null/non-finite cutpoints are skipped; the rest is sorted ascending and
 *   deduplicated (`===` after `-0` normalization). A hostile out-of-order
 *   profile (p90 < p50) normalizes to ascending — derivation is total.
 * - Bins are the `edges.length + 1` half-open intervals
 *   `(-∞, e0), [e0, e1), …, [e_{k−1}, +∞)`; edges are exclusive upper
 *   bounds, so a value equal to an edge lands in the *upper* bin
 *   (`binIndex` pins the semantics).
 * - A constant/degenerate reference (all four quantiles equal) collapses to
 *   one edge and two bins — PSI over it still detects a shifted current
 *   side through the unbounded bins. A reference with no finite cutpoints
 *   (e.g. an all-null column) yields zero edges (one bin); divergence over
 *   such histograms is defined and documented in `divergence.ts`.
 */

import type { NumericColumnStats } from './profile'
import { isFiniteNumber, normZero, readFieldPath } from './guards'

/** The quantile cutpoints bins derive from (documented; the m2 position set). */
const QUANTILE_KEYS = ['p50', 'p90', 'p95', 'p99'] as const

/**
 * A bin set: interior edges, ascending, deduplicated, finite. The bin count
 * is always `edges.length + 1` (two unbounded outer bins included).
 */
export interface BinSet {
  readonly edges: readonly number[]
}

/**
 * Derive the side-A reference bins from numeric stats (see module doc for
 * the convention). Total: a hostile stats object (missing quantiles,
 * non-number entries behind a cast) degrades to the bins its finite
 * cutpoints determine — never a throw.
 */
export function deriveBins(stats: NumericColumnStats): BinSet {
  const cutpoints: number[] = []
  for (const key of QUANTILE_KEYS) {
    const read = readFieldPath(stats, 'quantiles', key)
    if (read.ok && isFiniteNumber(read.value)) cutpoints.push(normZero(read.value))
  }
  cutpoints.sort((a, b) => a - b)
  const edges: number[] = []
  for (const q of cutpoints) {
    if (edges.length === 0 || edges[edges.length - 1] !== q) edges.push(q)
  }
  return { edges }
}

/**
 * The bin a value falls into: `0` is `(-∞, e0)`, …, `edges.length` is
 * `[e_last, +∞)`. Edges are exclusive upper bounds — a value equal to an
 * edge lands in the upper bin. Total: `NaN` and ±Infinity classify into the
 * last bin (a documented degenerate; engine-rendered values are finite).
 */
export function binIndex(edges: readonly number[], value: number): number {
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]
    if (edge !== undefined && value < edge) return i
  }
  return edges.length
}
