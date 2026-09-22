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
 *   one edge and two bins — a known blind spot: only a **downward** shift
 *   (below the point) lands in the unbounded lower bin and moves PSI; an
 *   **upward** shift lands in the same upper bin as the mass itself, so
 *   PSI reads exactly 0 (the raw quantile shift still surfaces it through
 *   the profile comparison — audit AR-F1). A reference with no finite
 *   cutpoints (e.g. an all-null column) yields zero edges (one bin);
 *   divergence over such histograms is defined and documented in
 *   `divergence.ts`.
 */

import type { NumericColumnStats } from './profile.js'
import { isFiniteNumber, normZero, readArray, readFieldPath } from './guards.js'

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
 * edge lands in the upper bin. Total, over hostile `edges` and `value`:
 *
 * - `edges` is read through a snapshot ({@link readArray}); an unreadable
 *   or non-array value degrades to the zero-edge shape — a single bin, so
 *   `0` (the same degrade path `deriveBins` takes over a hostile stats
 *   object).
 * - an edge that is not a number cannot order anything and is skipped —
 *   exactly the semantics the raw comparison already gave NaN edges
 *   (`v < NaN` is false). NaN/±Infinity *values* keep their documented
 *   classification (NaN and +Infinity → last bin; −Infinity → first edge).
 * - a non-number `value` (hostile, behind a cast) is treated as NaN — its
 *   `valueOf`/`Symbol.toPrimitive` could throw, and the comparison must
 *   never run on it.
 */
export function binIndex(edges: readonly number[], value: number): number {
  const edgeList = readArray(edges)
  if (edgeList === null) return 0 // documented: unreadable edges degrade to the one-bin shape
  const v = typeof value === 'number' ? value : NaN // never coerce a hostile value
  for (let i = 0; i < edgeList.length; i++) {
    const edge = edgeList[i]
    if (typeof edge === 'number' && v < edge) return i
  }
  return edgeList.length
}
