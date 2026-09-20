/**
 * Divergence metrics over caller-supplied histograms (checkpoint C1).
 *
 * Profiles do not carry per-bin counts, so PSI and Jensen–Shannon are pure
 * functions over a *bin set plus two count vectors*: `deriveBins` produces
 * the documented reference bins from side A's numeric stats, the caller
 * (m6-2's engine execution; later the CLI/web surfaces) produces the per-bin
 * counts on both sides, and these functions turn them into a deterministic
 * divergence. Everything here is total: malformed input returns `null`
 * (documented "undefined"), never a throw.
 *
 * ## Conventions (byte-identical across surfaces — web and CLI must agree)
 *
 * - **Log base: natural** (nats). `PSI / Math.LN10` converts to the log10
 *   convention some texts use; the model never applies that factor.
 * - **PSI form:** `Σ (a_i − b_i) · ln(a_i / b_i)` over bin *shares*. This
 *   is the symmetrized (Jeffreys) KL divergence — **on fixed bins it is
 *   formally symmetric**. The documented directionality lives in the bins:
 *   the model always bins by side A (the reference), so "PSI(A‖B)" in a
 *   diff report means *A-binned* — B's values are counted into side A's
 *   quantile bins, and B mass beyond A's observed range lands in the
 *   unbounded outer bins (exactly the drift signal). Pinned: same bins +
 *   swapped vectors give the same value up to floating-point rounding;
 *   A-bins vs B-bins need not agree.
 * - **Epsilon convention:** a bin where one side's share is 0 and the
 *   other's is not substitutes `DIVERGENCE_EPSILON = 1e-6` for the zero
 *   share (a fixed documented constant — deliberately not n-dependent, so
 *   the convention cannot drift between surfaces). A bin where both shares
 *   are 0 contributes exactly 0: there is no mass to compare, and no
 *   epsilon is introduced.
 * - **Jensen–Shannon** needs no epsilon: `0·log 0 := 0`, and the mixture
 *   share is 0 only where both sides are 0. Bounded by `Math.LN2` nats;
 *   symmetric by construction (pinned).
 * - **`null` (undefined — never NaN) when:** the count vectors are not
 *   arrays, their lengths do not match `edges.length + 1`, a count is
 *   negative or non-finite, a side's counts sum to 0 or overflow to
 *   ±Infinity, or an edge is non-finite. Profile *validation* happens
 *   upstream; these functions validate only their own arguments.
 */

import type { CategoricalTopKEntry } from './profile'
import { isFiniteNumber, isNonNegativeFinite, normZero } from './guards'

/** Substituted for a zero share when only one side has mass in a bin (documented). */
export const DIVERGENCE_EPSILON = 1e-6

/** Jensen–Shannon's tight upper bound in nats (`ln 2`). */
export const JENSEN_SHANNON_MAX = Math.LN2

/**
 * PSI(A‖B) over side-A bins: `Σ (a_i − b_i) · ln(a_i / b_i)` in nats (see
 * module doc for the form, the epsilon convention, and the directionality
 * that lives in the bin derivation, not the formula).
 */
export function psi(
  edges: readonly number[],
  countsA: readonly number[],
  countsB: readonly number[],
): number | null {
  const shares = shareVectors(edges, countsA, countsB)
  if (shares === null) return null
  let total = 0
  for (let i = 0; i < shares.a.length; i++) {
    const a = shares.a[i]
    const b = shares.b[i]
    if (a === undefined || b === undefined) return null // unreachable; narrows for TS
    if (a === 0 && b === 0) continue // documented: no mass on either side → term 0
    const av = a === 0 ? DIVERGENCE_EPSILON : a
    const bv = b === 0 ? DIVERGENCE_EPSILON : b
    total += (av - bv) * Math.log(av / bv)
  }
  return normZero(total)
}

/**
 * Jensen–Shannon divergence between the two count vectors' share
 * distributions, in nats — `0.5·KL(A‖M) + 0.5·KL(B‖M)` with
 * `M = (A + B) / 2`. Symmetric by construction; bounded by
 * {@link JENSEN_SHANNON_MAX}; epsilon-free (see module doc).
 */
export function jensenShannon(
  edges: readonly number[],
  countsA: readonly number[],
  countsB: readonly number[],
): number | null {
  const shares = shareVectors(edges, countsA, countsB)
  if (shares === null) return null
  let total = 0
  for (let i = 0; i < shares.a.length; i++) {
    const a = shares.a[i]
    const b = shares.b[i]
    if (a === undefined || b === undefined) return null // unreachable; narrows for TS
    const m = (a + b) / 2
    if (a > 0) total += 0.5 * a * Math.log(a / m)
    if (b > 0) total += 0.5 * b * Math.log(b / m)
  }
  return normZero(total)
}

/**
 * Validated share vectors for `psi`/`jensenShannon`, or `null` when the
 * input cannot determine a divergence (documented conditions in the module
 * doc). Shares are `count / total` per side.
 */
function shareVectors(
  edges: readonly number[],
  countsA: readonly number[],
  countsB: readonly number[],
): { a: number[]; b: number[] } | null {
  if (!Array.isArray(edges) || !Array.isArray(countsA) || !Array.isArray(countsB)) return null
  const binCount = edges.length + 1
  if (countsA.length !== binCount || countsB.length !== binCount) return null
  for (const edge of edges) {
    if (!isFiniteNumber(edge)) return null
  }
  let totalA = 0
  let totalB = 0
  for (const count of countsA) {
    if (!isNonNegativeFinite(count)) return null
    totalA += count
  }
  for (const count of countsB) {
    if (!isNonNegativeFinite(count)) return null
    totalB += count
  }
  if (!Number.isFinite(totalA) || !Number.isFinite(totalB)) return null
  if (totalA <= 0 || totalB <= 0) return null // no mass on a side → nothing to compare
  return {
    a: countsA.map((c) => c / totalA),
    b: countsB.map((c) => c / totalB),
  }
}

/**
 * Total-variation distance between two categorical profiles' top-k
 * summaries (checkpoint C1).
 *
 * Honest scope: a profile carries only the at-most-k most frequent values,
 * so the metric is defined over the **pooled distribution `top-k ∪
 * {other}`**: each side's share for one of its top-k values is
 * `count / nonNullTotal`, and each side's remaining mass (its top-k tail)
 * pools into a per-side pseudo-category. A value outside both top-k sets
 * is therefore indistinguishable from other tail mass — that residual
 * ambiguity is exactly what the new/vanished lists are for. This is a
 * documented pooled proxy computed purely from profile summaries, not the
 * full-distribution TV.
 *
 * Bounds `[0, 1]`; symmetric (pinned). `null` (undefined) when either
 * side's non-null total is not a positive safe integer, a top-k entry is
 * malformed, a side's top-k contains duplicate values, or a side's counts
 * exceed its non-null total (an arithmetically impossible profile).
 */
export function totalVariation(
  topKA: readonly CategoricalTopKEntry[],
  nonNullA: number,
  topKB: readonly CategoricalTopKEntry[],
  nonNullB: number,
): number | null {
  const sharesA = topKShares(topKA, nonNullA)
  const sharesB = topKShares(topKB, nonNullB)
  if (sharesA === null || sharesB === null) return null
  let mass = Math.abs(sharesA.other - sharesB.other)
  for (const [value, shareA] of sharesA.byValue) {
    const shareB = sharesB.byValue.get(value) ?? 0
    mass += Math.abs(shareA - shareB)
  }
  for (const [value, shareB] of sharesB.byValue) {
    if (!sharesA.byValue.has(value)) mass += Math.abs(shareB)
  }
  return normZero(mass / 2)
}

/**
 * Values in B's top-k that are absent from A's top-k — **relative to A**
 * (A = reference), carried in B's own top-k order (the documented engine
 * order: count descending, ties by value ascending — never re-sorted).
 * Entries are carried verbatim; entries with a non-string value are skipped
 * (standalone-callers' hostile input; the model validates upstream).
 */
export function newCategories(
  topKA: readonly CategoricalTopKEntry[],
  topKB: readonly CategoricalTopKEntry[],
): CategoricalTopKEntry[] {
  const known = new Set<string>()
  for (const entry of topKA) {
    if (typeof entry.value === 'string') known.add(entry.value)
  }
  const fresh: CategoricalTopKEntry[] = []
  for (const entry of topKB) {
    if (typeof entry.value !== 'string') continue
    if (!known.has(entry.value)) fresh.push(entry)
  }
  return fresh
}

/**
 * Values in A's top-k that are absent from B's top-k — **relative to A**,
 * in A's own top-k order (see {@link newCategories}). Swapping the sides
 * exchanges the two lists exactly (pinned).
 */
export function vanishedCategories(
  topKA: readonly CategoricalTopKEntry[],
  topKB: readonly CategoricalTopKEntry[],
): CategoricalTopKEntry[] {
  return newCategories(topKB, topKA)
}

/**
 * Shares for one side's top-k summary: a map value → share plus the pooled
 * `other` mass. `null` under the documented invalid conditions.
 */
function topKShares(
  topK: readonly CategoricalTopKEntry[],
  nonNull: number,
): { byValue: Map<string, number>; other: number } | null {
  if (!Array.isArray(topK)) return null
  if (!isFiniteNumber(nonNull) || !Number.isSafeInteger(nonNull) || nonNull <= 0) return null
  const byValue = new Map<string, number>()
  let sum = 0
  for (const entry of topK) {
    if (entry === null || typeof entry !== 'object') return null
    if (typeof entry.value !== 'string') return null
    if (!isNonNegativeFinite(entry.count)) return null
    if (byValue.has(entry.value)) return null // duplicate value: undefined semantics
    byValue.set(entry.value, entry.count / nonNull)
    sum += entry.count
  }
  if (sum > nonNull) return null // counts cannot exceed the non-null mass
  return { byValue, other: 1 - sum / nonNull }
}
