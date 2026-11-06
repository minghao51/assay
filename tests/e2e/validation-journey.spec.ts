import { expect, test } from './support/fixture'
import type { Page } from '@playwright/test'

// m5-2 validation journey (handoff §6): the edit → re-validate → verdict
// flip flow, driven through the REAL DuckDB-WASM client in Chromium. The
// harness compiles the contract with the real m5-1 compiler against the
// engine's own schema, stages the on-demand dirty dataset (runtime-built,
// never committed), and validates the SAME plan three times: the plain base
// view, a one-edit overlay, then a fix-everything overlay. Step 1 pins the
// exact CLI-derived counts; step 2 pins that a single edit flips exactly one
// rule's verdict; step 3 pins the total verdict flip to valid.
//
// Harness served from packages/engine-duckdb by the second webServer in
// playwright.config.ts (port env-overridable for parallel worktree batches).
const HARNESS_URL = `http://localhost:${process.env['ASSAY_E2E_PORT_ENGINE'] ?? 4179}/`

interface JourneyStep {
  step: string
  valid?: boolean
  rowCount?: number
  failingRules?: number
  /** ruleId → "failCount/failPercent" (counts only — never sample values). */
  rules?: Record<string, string>
  changedFromPrevious?: string[]
  error?: string
}

test('validation journey: base counts → one edit flips one rule → fix-all flips the verdict', async ({
  page,
}: {
  page: Page
}) => {
  test.setTimeout(120_000)
  await page.goto(HARNESS_URL)
  // Laziness at page level: loading the harness must not boot the engine.
  await expect(page.getByTestId('engine-status')).toHaveText('idle')
  await page.getByRole('button', { name: 'Validate: run the dirty-dataset journey' }).click()
  const element = page.getByTestId('validate-journey-result')
  await expect(element).not.toHaveText('not run', { timeout: 60_000 })
  const steps = JSON.parse((await element.textContent()) ?? '[]') as JourneyStep[]

  // The journey ran to completion (no error step) and produced three runs.
  expect(steps).toHaveLength(3)
  for (const step of steps) {
    expect(step.error, `step ${step.step}: ${step.error ?? ''}`).toBeUndefined()
  }

  // Step 1 — the base view: exact CLI-derived counts and percents.
  const [base, fixOne, fixAll] = steps as [JourneyStep, JourneyStep, JourneyStep]
  expect(base.step).toBe('base')
  expect(base.valid).toBe(false)
  expect(base.rowCount).toBe(120)
  expect(base.failingRules).toBe(8)
  expect(base.rules?.['columns[0].unique']).toBe('2/2')
  expect(base.rules?.['columns[1].allowed-values']).toBe('24/20')
  expect(base.rules?.['columns[1].regex']).toBe('4/3')
  expect(base.rules?.['columns[2].min']).toBe('12/10')
  expect(base.rules?.['columns[3].allowed-values']).toBe('4/3')
  expect(base.rules?.['columns[3].regex']).toBe('1/1')
  expect(base.rules?.['columns[4].max']).toBe('28/23')
  expect(base.rules?.['columns[5].allowed-values']).toBe('110/92')

  // Step 2 — one overlay edit: exactly the allowed-values rule changed.
  expect(fixOne.step).toBe('fix-one')
  expect(fixOne.valid).toBe(false)
  expect(fixOne.rowCount).toBe(120)
  expect(fixOne.rules?.['columns[1].allowed-values']).toBe('23/19')
  expect(fixOne.changedFromPrevious).toEqual(['columns[1].allowed-values'])

  // Step 3 — fix every violating cell: the total verdict flips to valid.
  expect(fixAll.step).toBe('fix-all')
  expect(fixAll.valid).toBe(true)
  expect(fixAll.rowCount).toBe(120)
  expect(fixAll.failingRules).toBe(0)
  // Every previously failing rule flipped; the already-clean ones did not.
  expect(fixAll.changedFromPrevious?.sort()).toEqual(
    [
      'columns[0].unique',
      'columns[1].allowed-values',
      'columns[1].regex',
      'columns[2].min',
      'columns[3].allowed-values',
      'columns[3].regex',
      'columns[4].max',
      'columns[5].allowed-values',
    ].sort(),
  )

  // The engine survived the whole journey: the page-level client is ready
  // and the engine is reusable (a follow-up op would answer).
  await expect(page.getByTestId('engine-status')).toHaveText('ready')
})
