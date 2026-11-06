import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { openFixture } from './support/fixtures'

/**
 * gb-4 — external-writer DOUBLE agreement (slice-2 recorded gap 2).
 *
 * During ptv2-6 desktop comparison work, externally written parquet
 * (DuckDB 1.5.x CLI) with DOUBLE columns was observed reporting equal
 * values as changed. The engine's vendored WASM is v1.4.3, so an external
 * v1.5.5 writer vs the pinned reader is exactly the skew under test.
 * These journeys run the REAL browser engine (not the CLI) over
 * runtime-generated CLI-written parquet (never committed):
 *
 *  1. self-agreement — A vs an identical copy of A must report no
 *     differences (row-level included), across representation-edge DOUBLE
 *     values (0.1, -0.0/0.0, denormals, π-precision, near-DBL_MAX);
 *  2. non-DOUBLE differ — when only a VARCHAR cell differs, the changed
 *     sample's field list must be exactly that column (DOUBLE columns
 *     never reported changed);
 *  3. pinned upstream limitation — a DOUBLE column whose parquet
 *     statistics span a real range with max near DBL_MAX (≥ ~5e307,
 *     written by the v1.5.5 CLI) crashes the v1.4.3 WASM reader inside
 *     staging with an internal glue error. The pinned HONEST behavior:
 *     staging fails with the value-free typed error, the grid stays
 *     usable, and the scratch slot is rolled back so a subsequent benign
 *     staging succeeds. Degenerate statistics (min == max, e.g. the same
 *     extreme value twice) do NOT trigger it and diff correctly — pinned
 *     by the self-agreement fixture's `huge` column (5e307 twice). Do not
 *     "fix" by upgrading the engine in place — revisit on a deliberate
 *     DuckDB-WASM upgrade.
 *
 * Privacy (ADR 0025): synthetic runtime temp files, committed nowhere; no
 * dataset values are logged.
 */

interface ExternalPair {
  readonly aPath: string
  readonly identicalCopyPath: string
  readonly bPath: string
  readonly extremeRangePath: string
  readonly benignPath: string
}

const DUCKDB_CLI = process.env['DUCKDB'] ?? '/tmp/duckdb'

/**
 * The DOUBLE values both sides carry unchanged. `huge` repeats 5e307 so its
 * parquet statistics are degenerate (min == max) — the shape that reads
 * back cleanly — while `inexact` spans 0.1..0.2 and `neg` spans the
 * denormal range, covering ordinary min/max statistics too.
 */
const A_ROWS: readonly string[] = [
  "SELECT 1 AS id, 'one' AS label, 0.5::DOUBLE AS ratio, 0.1::DOUBLE AS inexact, 5e307::DOUBLE AS huge",
  "SELECT 2, 'two', -0.0::DOUBLE, 0.2::DOUBLE, 5e307::DOUBLE",
  "SELECT 3, 'three', 3.141592653589793::DOUBLE, 2.718281828459045::DOUBLE, 5e307::DOUBLE",
  "SELECT 4, 'four', 42.0::DOUBLE, -1e-308::DOUBLE, 5e307::DOUBLE",
]

/** Same DOUBLE values; only id 3's label differs (the non-DOUBLE edit). */
const B_ROWS: readonly string[] = [
  ...A_ROWS.slice(0, 2),
  "SELECT 3, 'three-edit', 3.141592653589793::DOUBLE, 2.718281828459045::DOUBLE, 5e307::DOUBLE",
  ...A_ROWS.slice(3),
]

/**
 * The pinned-crash shape: a DOUBLE column whose min/max statistics span a
 * real range crossing 1.0 → 5e307 (min < max, max near DBL_MAX).
 */
const EXTREME_ROWS: readonly string[] = [
  'SELECT 1 AS id, 1.0::DOUBLE AS val',
  'SELECT 2, 5e307::DOUBLE',
]

/** A minimal benign parquet for the post-failure restaging check. */
const BENIGN_ROWS: readonly string[] = ['SELECT 1 AS id, 1.5::DOUBLE AS val']

function writeParquet(sql: string, target: string): void {
  execFileSync(DUCKDB_CLI, ['-c', `COPY (${sql}) TO '${target}' (FORMAT PARQUET)`], {
    stdio: 'ignore',
  })
}

function writeExternalParquetPair(): ExternalPair {
  const dir = mkdtempSync(path.join(tmpdir(), 'assay-gb4-external-'))
  const rows = A_ROWS.join(' UNION ALL ')
  const paths = {
    aPath: path.join(dir, 'double-a.parquet'),
    identicalCopyPath: path.join(dir, 'double-copy.parquet'),
    bPath: path.join(dir, 'double-b.parquet'),
    extremeRangePath: path.join(dir, 'double-extreme-range.parquet'),
    benignPath: path.join(dir, 'double-benign.parquet'),
  }
  writeParquet(rows, paths.aPath)
  writeParquet(rows, paths.identicalCopyPath)
  writeParquet(B_ROWS.join(' UNION ALL '), paths.bPath)
  writeParquet(EXTREME_ROWS.join(' UNION ALL '), paths.extremeRangePath)
  writeParquet(BENIGN_ROWS.join(' UNION ALL '), paths.benignPath)
  return paths
}

async function stageComparison(page: Page, bPath: string): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('diff-open-comparison').click()
  const chooser = await chooserPromise
  await chooser.setFiles(bPath)
  await expect(page.getByTestId('diff-comparison-info')).toBeVisible({ timeout: 20_000 })
}

// Same picker-fallback arming as diff-panel.spec.ts: without deleting the
// File System Access globals, the app calls the native picker and no
// Playwright `filechooser` event fires.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
    } catch {
      // Non-configurable globals would be a Chromium change; the test then
      // fails loudly at the chooser rather than silently.
    }
  })
})

test('external-writer DOUBLE columns agree with themselves (row-level: no differences)', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const pair = writeExternalParquetPair()
  // rd-3b: the comparison controls live in Compare, a Check section.
  await openFixture(page, pair.aPath, { assertFileNameHidden: true, task: 'check' })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('4')
  await stageComparison(page, pair.identicalCopyPath)
  await page.getByTestId('diff-run').click()
  await expect(page.getByTestId('diff-verdict')).toContainText(
    'No differences: schema, profile, and row-level comparison (keys: id) all agree',
  )
})

test('external-writer DOUBLE columns never appear changed when only a VARCHAR cell differs', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const pair = writeExternalParquetPair()
  // rd-3b: the comparison controls live in Compare, a Check section.
  await openFixture(page, pair.aPath, { assertFileNameHidden: true, task: 'check' })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('4')
  await stageComparison(page, pair.bPath)
  await page.getByTestId('diff-run').click()
  await expect(page.getByTestId('diff-verdict')).toContainText(
    '0 added, 0 removed, 1 changed — rows 4 → 4',
  )
  const changedSample = page
    .locator('[data-testid="diff-aspect"][data-aspect="changed"]')
    .getByTestId('diff-sample')
  await expect(changedSample).toHaveCount(1)
  await expect(changedSample.getByTestId('diff-sample-changed')).toHaveText('label')
})

test('pinned limitation: DOUBLE stats range to near-DBL_MAX fails staging honestly; grid usable; restaging works', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const pair = writeExternalParquetPair()
  // rd-3b: the comparison controls live in Compare, a Check section.
  await openFixture(page, pair.aPath, { assertFileNameHidden: true, task: 'check' })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('4')

  // The extreme-range staging fails with the value-free typed error…
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('diff-open-comparison').click()
  const chooser = await chooserPromise
  await chooser.setFiles(pair.extremeRangePath)
  const alert = page.getByTestId('diff-stage-error')
  await expect(alert).toBeVisible({ timeout: 20_000 })
  await expect(alert).toContainText('The comparison file could not be staged')
  // …the grid (side A) stays open and usable throughout…
  await expect(page.getByTestId('grid-total-rows')).toHaveText('4')
  // …and the failed staging rolled its scratch back: a benign file stages next.
  await stageComparison(page, pair.benignPath)
  await page.getByTestId('diff-run').click()
  await expect(page.getByTestId('diff-verdict')).toBeVisible()
})
