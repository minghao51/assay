import type { Page } from '@playwright/test'

/**
 * Shared reader for the grid footer's stats line (m4-0 dedupe — the reader
 * was previously copied into three specs). The footer renders the headless
 * model's request counters as `fetches=N requested=N received=N maxSpan=N
 * cached=N` (DataGrid footer), the observable form of the "never
 * materializes the dataset" guarantee (ADR 0003).
 */

/** The full counter snapshot parsed from one `grid-stats` line. */
export interface GridStatsSnapshot {
  readonly fetches: number
  readonly requested: number
  readonly received: number
  readonly maxSpan: number
  readonly cached: number
}

/**
 * Parse the footer's stats line into the full counter snapshot. Throws when
 * any key is missing (the footer renders all five, so a miss means the grid
 * never reached its ready render — fail loudly, never assert on a partial).
 */
export async function readGridStats(page: Page): Promise<GridStatsSnapshot> {
  const text = await page.getByTestId('grid-stats').innerText()
  const field = (key: string): number => {
    const match = text.match(new RegExp(`${key}=(\\d+)`))
    if (match === null) throw new Error(`grid stats missing "${key}": ${text}`)
    return Number(match[1])
  }
  return {
    fetches: field('fetches'),
    requested: field('requested'),
    received: field('received'),
    maxSpan: field('maxSpan'),
    cached: field('cached'),
  }
}

/**
 * The narrower `{fetches, cached}` projection for specs that assert only the
 * per-epoch fetch/cache counters (nested-grid): fetches ≥ 1 marks a genuine
 * provider refetch after an epoch reset, cached ≥ 1 a cache-served window.
 */
export async function readGridFetchCache(page: Page): Promise<{ fetches: number; cached: number }> {
  const stats = await readGridStats(page)
  return { fetches: stats.fetches, cached: stats.cached }
}
