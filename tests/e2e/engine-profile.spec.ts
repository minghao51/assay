import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { clickAndGetJson } from './support/fixtures'

// Task m2-5 (handoff §6): dataset profiling through the REAL DuckDB-WASM
// client on golden fixtures. The harness (packages/engine-duckdb) opens the
// fixtures through staged genuine FileSystemFileHandles and drives
// client.profile(), rendering the result as JSON. The expected values below
// are pinned against DuckDB CLI 1.5.5 (the same engine version the WASM
// bundle tracks) — exact numeric stats, top-k with the SG/US count tie
// broken by value ascending, a NULL income, DATE-as-categorical, and the
// STRUCT column degrading to kind 'other' with no payloads.
//
// Conformance-level semantics (kinds/nulls-only/tie/error-reuse) run in
// tests/e2e/engine-conformance.spec.ts via the @assay/testing suite; this
// spec proves the real-fixture outputs directly.
// Harness served from packages/engine-duckdb by the second webServer in
// playwright.config.ts; port env-overridable for parallel worktree batches
// (default 4179).
const HARNESS_URL = `http://localhost:${process.env['ASSAY_E2E_PORT_ENGINE'] ?? 4179}/`

interface ProfileColumnEvidence {
  name: string
  type: string
  kind: string
  nullCount: number
  distinctCount: number
  numeric?: {
    min: number | null
    max: number | null
    mean: number | null
    stddev: number | null
    quantiles: {
      p50: number | null
      p90: number | null
      p95: number | null
      p99: number | null
    }
  }
  categorical?: { topK: { value: string; count: number }[] }
}

interface ProfileEvidence {
  rowCount?: number
  columns?: ProfileColumnEvidence[]
  error?: string
  rejected?: boolean
  rowCountAfterReuse?: number
  fatal?: string
}

/** Open a fixture via the harness and wait until the engine reports it. */
async function openHarnessFixture(
  page: Page,
  key: 'flat' | 'nested',
  tableId: string,
): Promise<void> {
  await page.goto(HARNESS_URL)
  // Laziness: loading the harness must not boot the engine.
  await expect(page.getByTestId('engine-status')).toHaveText('idle')
  await page.getByRole('button', { name: `Open ${key} fixture via engine` }).click()
  await expect(page.getByTestId(`open-status-${key}`)).toHaveText('opened', { timeout: 20_000 })
  await expect(page.getByTestId(`open-table-id-${key}`)).toHaveText(tableId)
}

test('profile of the flat fixture returns the exact pinned stats (numeric, top-k ties, nulls, dates)', async ({
  page,
}) => {
  await openHarnessFixture(page, 'flat', 't1')
  const evidence = await clickAndGetJson<ProfileEvidence>(
    page,
    'Profile flat fixture via engine',
    'profile-flat-result',
  )
  expect(evidence.error).toBeUndefined()
  expect(evidence.rowCount).toBe(5)
  // customer_id BIGINT: numeric, no nulls, ids 1..5.
  expect(evidence.columns![0]).toEqual({
    name: 'customer_id',
    type: 'BIGINT',
    kind: 'numeric',
    nullCount: 0,
    distinctCount: 5,
    numeric: {
      min: 1,
      max: 5,
      mean: 3,
      stddev: 1.5811388300841898,
      quantiles: { p50: 3, p90: 4.6, p95: 4.8, p99: 4.96 },
    },
  })
  // country VARCHAR: categorical; SG/US tie at count 2 broken by value ASC.
  expect(evidence.columns![1]).toEqual({
    name: 'country',
    type: 'VARCHAR',
    kind: 'categorical',
    nullCount: 0,
    distinctCount: 3,
    categorical: {
      topK: [
        { value: 'SG', count: 2 },
        { value: 'US', count: 2 },
        { value: 'DE', count: 1 },
      ],
    },
  })
  // income BIGINT: one NULL; exact stats over the four non-null values.
  expect(evidence.columns![2]).toEqual({
    name: 'income',
    type: 'BIGINT',
    kind: 'numeric',
    nullCount: 1,
    distinctCount: 4,
    numeric: {
      min: 48000,
      max: 75000,
      mean: 59000,
      stddev: 11972.189997378648,
      quantiles: { p50: 56500, p90: 70800, p95: 72900, p99: 74580 },
    },
  })
  // signup_date DATE: the temporal-as-categorical decision — top-k over the
  // rendered text, count-1 ties broken by value ascending.
  expect(evidence.columns![3]).toEqual({
    name: 'signup_date',
    type: 'DATE',
    kind: 'categorical',
    nullCount: 0,
    distinctCount: 5,
    categorical: {
      topK: [
        { value: '2025-01-04', count: 1 },
        { value: '2025-01-11', count: 1 },
        { value: '2025-02-02', count: 1 },
        { value: '2025-02-19', count: 1 },
        { value: '2025-03-01', count: 1 },
      ],
    },
  })
  await expect(page.getByTestId('engine-status')).toHaveText('ready')
})

test('profile of the nested fixture degrades gracefully on STRUCT (kind other, no payloads)', async ({
  page,
}) => {
  await openHarnessFixture(page, 'nested', 't1')
  const evidence = await clickAndGetJson<ProfileEvidence>(
    page,
    'Profile nested fixture via engine',
    'profile-nested-result',
  )
  expect(evidence.error).toBeUndefined()
  expect(evidence.rowCount).toBe(50)
  // id BIGINT: numeric stats over 0..49.
  expect(evidence.columns![0]).toEqual({
    name: 'id',
    type: 'BIGINT',
    kind: 'numeric',
    nullCount: 0,
    distinctCount: 50,
    numeric: {
      min: 0,
      max: 49,
      mean: 24.5,
      stddev: 14.577379737113251,
      quantiles: { p50: 24.5, p90: 44.1, p95: 46.55, p99: 48.51 },
    },
  })
  // payload STRUCT: exact counts still reported; no numeric/categorical
  // payloads — the never-throws degradation contract on an exotic type.
  expect(evidence.columns![1]).toEqual({
    name: 'payload',
    type: expect.stringMatching(/struct/i),
    kind: 'other',
    nullCount: 0,
    distinctCount: 50,
  })
  expect(evidence.columns![1]!.numeric).toBeUndefined()
  expect(evidence.columns![1]!.categorical).toBeUndefined()
  await expect(page.getByTestId('engine-status')).toHaveText('ready')
})

test('profile of an unknown handle rejects with an engine error and the engine stays reusable', async ({
  page,
}) => {
  await openHarnessFixture(page, 'flat', 't1')
  const evidence = await clickAndGetJson<ProfileEvidence>(
    page,
    'Profile unknown handle, then flat fixture again',
    'profile-error-reuse-result',
  )
  // The unknown handle rejected with the engine's own classified error text.
  expect(evidence.rejected).toBe(true)
  expect(evidence.error).toContain('unknown table handle')
  // The engine then answered a real profile — full reuse after the failure.
  expect(evidence.rowCountAfterReuse).toBe(5)
  expect(evidence.fatal).toBeUndefined()
  await expect(page.getByTestId('engine-status')).toHaveText('ready')
})
