import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Task m4-2 (handoff §6): the edit-overlay engine surface — overlay-aware
// windows/counts/effective schema composed over the base view + overlay ops
// (ADR 0012), and the COPY-based export/rewrite op. This spec runs the three
// m4-2 conformance scenarios from @assay/testing against the REAL
// DuckDB-WASM client in Chromium:
//
// - overlay-window-fidelity: a scripted op sequence (edits incl. `text`
//   literal casts, five inserts covering every position kind incl. a dead
//   anchor, a delete, rename, cast, no-op + foreign-anchor replays) must
//   deliver the pinned effective schema, live/filtered counts, and windows
//   whose row order reproduces the domain's `effectiveRowIds` exactly —
//   every expectation derived with the pinned DuckDB CLI (v1.5.5) over the
//   identical composed SQL (see the DuckDB subject adapter for the
//   derivation transcript).
// - export-round-trip: every exported format lands as a NEW file with
//   honest counts; re-opened content matches per format — CSV must be
//   formula-injection-sanitized (apostrophe-prefix convention; the probed
//   baits: `=SUM(A1:A2)`, `+CMD`, `-1+1`, `@x`, embedded TAB, embedded CR)
//   while JSONL keeps the raw content visible.
// - source-immutability: the staged source file's sha-256 is unchanged by a
//   full edit+export session, and no export ever targets the source path.
//
// The scenario logic lives in the suite (packages/testing); this spec pins
// pass + scenario-specific evidence, mirroring engine-conformance.spec.ts.
//
// Harness served from packages/engine-duckdb by the second webServer in
// playwright.config.ts; port env-overridable for parallel worktree batches
// (default 4179).
const HARNESS_URL = `http://localhost:${process.env['ASSAY_E2E_PORT_ENGINE'] ?? 4179}/`

/** Structural mirror of @assay/testing's ConformanceScenarioResult. */
interface ScenarioResult {
  name: string
  passed: boolean
  detail: string
  facts: Record<string, string | number | boolean>
}

const SCENARIOS = [
  'overlay-window-fidelity',
  'export-round-trip',
  'source-immutability',
  'overlay-hostile-types-rejected',
] as const

/** Button labels as rendered by the harness (kept human-readable there). */
const BUTTON_LABELS: Record<(typeof SCENARIOS)[number], string> = {
  'overlay-window-fidelity': 'Conformance: overlay window fidelity',
  'export-round-trip': 'Conformance: export round-trip',
  'source-immutability': 'Conformance: source immutability',
  'overlay-hostile-types-rejected': 'Conformance: overlay hostile types rejected',
}

/** Click a scenario button and wait for its JSON result to render. */
async function runScenario(page: Page, name: string): Promise<ScenarioResult> {
  await page.goto(HARNESS_URL)
  // Laziness at page level: loading the harness must not boot the engine.
  await expect(page.getByTestId('engine-status')).toHaveText('idle')
  await page
    .getByRole('button', { name: BUTTON_LABELS[name as keyof typeof BUTTON_LABELS] })
    .click()
  const element = page.getByTestId(`conformance-result-${name}`)
  await expect(element).not.toHaveText('not run', { timeout: 60_000 })
  const text = await element.textContent()
  expect(text, `result of ${name} renders as JSON`).toBeTruthy()
  return JSON.parse(text!) as ScenarioResult
}

for (const name of SCENARIOS) {
  test(`m4-2 overlay: ${name} passes against the real DuckDB-WASM client`, async ({ page }) => {
    const result = await runScenario(page, name)
    expect(result.name).toBe(name)
    expect(result.passed, `scenario ${name}: ${result.detail}`).toBe(true)

    // Scenario-specific evidence beyond the pass flag.
    switch (name) {
      case 'overlay-window-fidelity':
        // Effective schema (rename + cast visible), live/filtered counts,
        // the full 9-row effective order with every cell value pinned, the
        // LIMIT/OFFSET slice, and the sorted window.
        expect(result.facts['schemaColumns']).toBe(4)
        expect(result.facts['liveRowCount']).toBe(9)
        expect(result.facts['filteredCount']).toBe(2)
        expect(result.facts['sliceRows']).toBe(3)
        expect(result.facts['cells']).toBe(36)
        expect(result.facts['sortedRows']).toBe(9)
        break
      case 'export-round-trip':
        // All five shipped formats verified; four re-opened through the
        // engine (parquet/jsonl/json/csv), arrow through its IPC container
        // (the engine cannot re-open .arrow files yet — m1-4 deferral);
        // the CSV pin is non-vacuously probed (sanitized ≠ effective).
        expect(result.facts['formats']).toBe(5)
        expect(result.facts['engineReopens']).toBe(4)
        expect(result.facts['arrowVerified']).toBe(1)
        expect(result.facts['csvSanitizationProbed']).toBe(true)
        break
      case 'source-immutability':
        // sha-256 of the staged source unchanged after the full session;
        // five exports, five distinct generated destinations, none of them
        // the source path (ADR 0012: never rewritten in place).
        expect(result.facts['exports']).toBe(5)
        expect(result.facts['distinctDestinations']).toBe(5)
        expect(result.facts['digestUnchanged']).toBe(true)
        break
      case 'overlay-hostile-types-rejected':
        // The review's injection payload (and a base-column variant) is
        // rejected with a typed operation error before any SQL is composed;
        // neither side-effect table exists and the engine stays reusable.
        expect(result.facts['probes']).toBe(2)
        expect(result.facts['rejected']).toBe(2)
        expect(result.facts['injectedAbsent']).toBe(true)
        expect(result.facts['engineReusable']).toBe(true)
        break
      default:
        break
    }
  })
}
