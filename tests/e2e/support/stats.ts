/**
 * Shared timing statistics for the perf specs (q-5, AR-F4): the nearest-rank
 * percentile and average-of-middle median that the ttfr benchmark, the
 * head-of-line instrument, and the virtualization frame-timing log previously
 * re-declared (with a drifted median — see `median` below).
 */

/** Nearest-rank percentile (`p` in 0–100) over unsorted samples. */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index] as number
}

/**
 * Average-of-middle median. This is the most-correct of the copies that were
 * inlined: bench-ttfr averaged the two middle samples for even n while the
 * others returned the upper-middle element outright; n is odd in every current
 * call site (engine-head-of-line's 5 repeats), so unifying changes no value.
 * Returns `NaN` for an empty sample set rather than throwing.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}
