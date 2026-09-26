import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Shared harness-scenario runner (q-5, AR-F4). The engine-conformance,
 * overlay, and data-source-behavior specs each rendered a scenario's JSON
 * result through the same click-and-wait flow; this is the one definition.
 * The per-spec differences (harness URL, result-element prefix, button
 * labels, timeout, lazy-boot pin) are explicit options, so every call keeps
 * its previous semantics exactly.
 */

/** Structural mirror of the @assay/testing scenario result envelopes. */
export interface ScenarioResult {
  name: string
  passed: boolean
  detail: string
  facts: Record<string, string | number | boolean>
}

/** The harness's run-all report envelope. */
export interface RunAllReport {
  subject: string
  results: ScenarioResult[]
  allPassed: boolean
}

/** Per-call configuration for {@link runScenario}. */
export interface RunScenarioOptions {
  /** Harness root URL (each harness serves its own port). */
  readonly url: string
  /** Human-readable button label that starts the scenario. */
  readonly buttonLabel: string
  /** Test id of the element that renders the scenario JSON. */
  readonly resultTestId: string
  /** How long the result element may stay `not run` (default 60 s). */
  readonly timeoutMs?: number
  /**
   * Pin the harness's lazy-boot contract first: `engine-status` must read
   * `idle` before the scenario button is clicked. The data-source harness
   * boots no engine, so its runner passes `false`.
   */
  readonly assertEngineIdle?: boolean
}

/** Click a harness scenario button and return its parsed JSON result. */
export async function runScenario(
  page: Page,
  options: RunScenarioOptions,
): Promise<ScenarioResult> {
  const { url, buttonLabel, resultTestId, timeoutMs = 60_000, assertEngineIdle = true } = options
  await page.goto(url)
  if (assertEngineIdle) {
    await expect(page.getByTestId('engine-status')).toHaveText('idle')
  }
  await page.getByRole('button', { name: buttonLabel }).click()
  const element = page.getByTestId(resultTestId)
  await expect(element).not.toHaveText('not run', { timeout: timeoutMs })
  const text = await element.textContent()
  expect(text, `result of ${resultTestId} renders as JSON`).toBeTruthy()
  return JSON.parse(text!) as ScenarioResult
}
