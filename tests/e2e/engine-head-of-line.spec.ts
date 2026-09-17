import { expect, test } from '@playwright/test'

// Task m2-7 (handoff §6): FIFO head-of-line latency revisit. This spec is the
// measurement instrument: with the flat fixture open, it runs the m2-4-
// calibrated ~2.8 s aggregate through `query()` (the SQL-editor path), then
// fires the grid's interactive traffic (fetchRange + rowCount + schema)
// while the query runs, and records each op's fire→settle wait against its
// idle-engine baseline — 5 repeats, medians and p95 computed here from the
// raw samples (at n=5 the nearest-rank p95 IS the max — reported honestly).
//
// The settle order is the architecture evidence: under the pre-m2-7 single
// FIFO the queued interactive ops cannot settle before the query that owns
// the lane head; after the m2-7 two-lane split they must. The assertions
// below pin the SHIPPED architecture (two lanes — see op-channel.ts); the
// measured before/after numbers live in the task report and in the module
// docs (op-channel.ts / engine-executor.ts / worker.ts).
//
// Variance honesty (G1-R/T4 precedent): timing assertions stay coarse — the
// long query's median must merely prove its magnitude (≥ 1 s), and the
// queued-vs-query ordering assertions are discrete (settlement order), not
// wall-clock thresholds that CPU contention could flip.
//
// Harness served from packages/engine-duckdb by the second webServer in
// playwright.config.ts; port env-overridable for parallel worktree batches
// (default 4179).
const HARNESS_URL = `http://localhost:${process.env['ASSAY_E2E_PORT_ENGINE'] ?? 4179}/`

/** Structural mirror of the harness's HeadOfLineEvidence JSON. */
interface HeadOfLineRepeat {
  baselineRangeMs: number
  baselineCountMs: number
  baselineSchemaMs: number
  queuedRangeMs: number
  queuedCountMs: number
  queuedSchemaMs: number
  queuedRangeRows: number
  longQueryMs: number
  settleOrder: string[]
  error?: string
}

interface HeadOfLineEvidence {
  repeats: HeadOfLineRepeat[]
  fatal?: string
}

/** Median (middle element; n is odd). */
function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

/** Nearest-rank p95 — with n=5 this is the max, which is stated as such. */
function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] ?? Number.NaN
}

function summarize(evidence: HeadOfLineEvidence): Record<string, number> {
  const pick = (key: keyof HeadOfLineRepeat): number[] =>
    evidence.repeats.map((repeat) => repeat[key] as number)
  return {
    medianLongQueryMs: median(pick('longQueryMs')),
    p95LongQueryMs: p95(pick('longQueryMs')),
    medianQueuedRangeMs: median(pick('queuedRangeMs')),
    p95QueuedRangeMs: p95(pick('queuedRangeMs')),
    medianQueuedCountMs: median(pick('queuedCountMs')),
    p95QueuedCountMs: p95(pick('queuedCountMs')),
    medianQueuedSchemaMs: median(pick('queuedSchemaMs')),
    p95QueuedSchemaMs: p95(pick('queuedSchemaMs')),
    medianBaselineRangeMs: median(pick('baselineRangeMs')),
    medianBaselineCountMs: median(pick('baselineCountMs')),
    medianBaselineSchemaMs: median(pick('baselineSchemaMs')),
  }
}

test('measures interactive-op waits behind a long query (m2-7 evidence)', async ({ page }) => {
  // Generous: engine boot + open + 5 repeats, each dominated by one ~2.8 s
  // long query (the queued interactive ops ride the same window) — scaled up
  // for CPU contention (G1-R precedent).
  test.setTimeout(300_000)
  await page.goto(HARNESS_URL)

  // Laziness: loading the page must not boot the engine.
  await expect(page.getByTestId('engine-status')).toHaveText('idle')

  // Seed the registered table the interactive ops address.
  await page.getByRole('button', { name: 'Open flat fixture via engine' }).click()
  await expect(page.getByTestId('open-status-flat')).toHaveText('opened', { timeout: 60_000 })

  await page.getByRole('button', { name: /Measure interactive-op waits/ }).click()
  const element = page.getByTestId('head-of-line-result')
  await expect(element).not.toHaveText('not run', { timeout: 240_000 })
  const evidence = JSON.parse((await element.textContent())!) as HeadOfLineEvidence

  // Evidence FIRST (before any assertion): a failing run must still record
  // its numbers — that is how this spec's pre-implementation measurement was
  // taken, and how a future regression gets diagnosed.
  const summary = summarize(evidence)
  await test.info().attach('head-of-line-evidence.json', {
    body: JSON.stringify({ summary, evidence }, null, 2),
    contentType: 'application/json',
  })
  console.log('[m2-7 head-of-line] summary:', JSON.stringify(summary))

  // No fatal harness error, and every repeat completed cleanly.
  expect(evidence.fatal, 'harness reported a fatal error').toBeUndefined()
  expect(evidence.repeats, 'five repeats ran').toHaveLength(5)
  for (const repeat of evidence.repeats) {
    expect(repeat.error, 'repeat completed without an error').toBeUndefined()
    // The burst window is the real fixture window — the interactive ops
    // returned their own results, not another op's.
    expect(repeat.queuedRangeRows, 'burst fetchRange rows').toBe(5)
    // Magnitude sanity: the long query really is a multi-second query.
    expect(repeat.longQueryMs).toBeGreaterThanOrEqual(1_000)
    // The shipped two-lane architecture: the interactive burst settles while
    // the long query still runs — the query settles LAST (the discrete,
    // contention-proof form of the head-of-line relief claim).
    expect(repeat.settleOrder[repeat.settleOrder.length - 1], 'long query settles last').toBe(
      'query',
    )
    expect(repeat.settleOrder.slice(0, -1)).toEqual(
      expect.arrayContaining(['range', 'count', 'schema']),
    )
  }

  // Head-of-line relief, coarse form (asserted after the evidence is
  // recorded): the median queued wait of every interactive op stays far
  // below the long query's duration (the two lanes overlap; the query's own
  // work dominates the repeat). The exact numbers are recorded, not pinned —
  // this is a latency-shape guarantee, not a performance benchmark.
  expect(summary.medianQueuedRangeMs, 'median queued fetchRange wait').toBeLessThan(
    summary.medianLongQueryMs / 2,
  )
  expect(summary.medianQueuedCountMs, 'median queued rowCount wait').toBeLessThan(
    summary.medianLongQueryMs / 2,
  )
  expect(summary.medianQueuedSchemaMs, 'median queued schema wait').toBeLessThan(
    summary.medianLongQueryMs / 2,
  )
})
