import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Task T1 (handoff §6): the data-engine conformance suite lives in
// @assay/testing (docs/engineering/05-repository-structure.md §4) and is
// parameterized over an EngineConformanceSubject. This spec runs every
// scenario against the REAL DuckDB-WASM client in Chromium: the harness
// (packages/engine-duckdb/harness) hosts the DuckDB subject adapter and
// renders each scenario's ConformanceScenarioResult as JSON; here we assert
// each scenario passed, plus scenario-specific evidence (facts).
//
// The scenario logic itself is not duplicated here — the suite owns it and is
// additionally proven under Node vitest against a compliant/incompliant fake
// engine (packages/testing/src/engine-conformance.test.ts).
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

interface RunAllReport {
  subject: string
  results: ScenarioResult[]
  allPassed: boolean
}

const SCENARIOS = [
  'lazy-boot',
  'file-lifecycle',
  'error-classes',
  'window-clamping',
  'arrow-shape',
  'corrupt-file-rollback',
  'mid-stream-error-reuse',
  'window-filter-sort',
  'predicate-error-reuse',
  'profile-semantics',
  'nested-schema-fidelity',
  'nested-window-fidelity',
  'nested-window-clamp',
  'overlay-window-fidelity',
  'overlay-insert-edits',
  'overlay-cast-check',
  'export-round-trip',
  'source-immutability',
  'overlay-hostile-types-rejected',
  'validation-plan-execution',
  'row-diff-plan-execution',
] as const

/** Button labels as rendered by the harness (kept human-readable there). */
const BUTTON_LABELS: Record<(typeof SCENARIOS)[number], string> = {
  'lazy-boot': 'Conformance: lazy boot',
  'file-lifecycle': 'Conformance: file lifecycle',
  'error-classes': 'Conformance: error classes',
  'window-clamping': 'Conformance: window clamping',
  'arrow-shape': 'Conformance: arrow shape',
  'corrupt-file-rollback': 'Conformance: corrupt file rollback',
  'mid-stream-error-reuse': 'Conformance: mid-stream error reuse',
  'window-filter-sort': 'Conformance: window filter sort',
  'predicate-error-reuse': 'Conformance: predicate error reuse',
  'profile-semantics': 'Conformance: profile semantics',
  'nested-schema-fidelity': 'Conformance: nested schema fidelity',
  'nested-window-fidelity': 'Conformance: nested window fidelity',
  'nested-window-clamp': 'Conformance: nested window clamp',
  'overlay-window-fidelity': 'Conformance: overlay window fidelity',
  'overlay-insert-edits': 'Conformance: overlay insert edits',
  'overlay-cast-check': 'Conformance: overlay cast check',
  'export-round-trip': 'Conformance: export round-trip',
  'source-immutability': 'Conformance: source immutability',
  'overlay-hostile-types-rejected': 'Conformance: overlay hostile types rejected',
  'validation-plan-execution': 'Conformance: validation plan execution',
  'row-diff-plan-execution': 'Conformance: row-diff plan execution',
}

/** Click a scenario button and wait for its JSON result to render. */
async function runScenario(page: Page, name: string): Promise<ScenarioResult> {
  await page.goto(HARNESS_URL)
  // Laziness at page level: loading the harness must not boot the engine.
  await expect(page.getByTestId('engine-status')).toHaveText('idle')
  await page.getByRole('button', { name: BUTTON_LABELS[name] }).click()
  const element = page.getByTestId(`conformance-result-${name}`)
  await expect(element).not.toHaveText('not run', { timeout: 60_000 })
  const text = await element.textContent()
  expect(text, `result of ${name} renders as JSON`).toBeTruthy()
  return JSON.parse(text!) as ScenarioResult
}

for (const name of SCENARIOS) {
  test(`conformance: ${name} passes against the real DuckDB-WASM client`, async ({ page }) => {
    const result = await runScenario(page, name)
    expect(result.name).toBe(name)
    expect(result.passed, `scenario ${name}: ${result.detail}`).toBe(true)

    // Scenario-specific evidence beyond the pass flag.
    switch (name) {
      case 'file-lifecycle':
        expect(result.facts['rowCount']).toBe(5)
        expect(result.facts['disposedFetchRangeRejected']).toBe(true)
        expect(result.facts['secondDisposeResolved']).toBe(true)
        break
      case 'window-clamping':
        expect(result.facts['clampedRows']).toBe(1000) // MAX_RANGE_ROWS cap itself
        expect(result.facts['tailRows']).toBe(3)
        expect(result.facts['invalidRejected']).toBe(3)
        break
      case 'corrupt-file-rollback':
        expect(result.facts['openRejected']).toBe(true)
        expect(result.facts['registeredAfterFailedOpen']).toBe(0)
        expect(result.facts['repeatOpenRejected']).toBe(true)
        expect(result.facts['goodOpenAfterFailure']).toBe(true)
        expect(result.facts['registeredAfterGoodOpen']).toBe(1)
        break
      case 'mid-stream-error-reuse':
        expect(result.facts['midStreamRejected']).toBe(true)
        expect(result.facts['followUpValue']).toBe('42')
        expect(result.facts['engineReadyAfter']).toBe(true)
        break
      case 'window-filter-sort':
        expect(result.facts['entries']).toBe(4)
        expect(result.facts['filteredEntries']).toBe(2)
        expect(result.facts['naturalOrderPreserved']).toBe(true)
        expect(result.facts['invalidWindowWithFiltersRejected']).toBe(true)
        break
      case 'predicate-error-reuse':
        expect(result.facts['rejectedProbes']).toBe(3)
        expect(result.facts['containedBreakouts']).toBe(2)
        expect(result.facts['viewIntact']).toBe(true)
        expect(result.facts['engineReusable']).toBe(true)
        break
      case 'profile-semantics':
        expect(result.facts['rowCount']).toBe(5)
        expect(result.facts['columns']).toBe(6)
        expect(result.facts['unknownHandleRejected']).toBe(true)
        expect(result.facts['nullsOnlyColumn']).toBe(true)
        expect(result.facts['topKTiePinned']).toBe(true)
        expect(result.facts['reusableAfterProfile']).toBe(true)
        break
      case 'nested-schema-fidelity':
        expect(result.facts['schemaColumns']).toBe(10)
        expect(result.facts['rowCount']).toBe(12)
        break
      case 'nested-window-fidelity':
        expect(result.facts['columns']).toBe(10)
        expect(result.facts['rows']).toBe(12)
        expect(result.facts['cells']).toBe(120)
        break
      case 'nested-window-clamp':
        expect(result.facts['oversizedRows']).toBe(12)
        expect(result.facts['offsetRows']).toBe(3)
        expect(result.facts['invalidRejected']).toBe(3)
        break
      case 'overlay-window-fidelity':
        // Effective schema includes the two cast array spellings and the plain
        // list (fix round 2); the value pins cover the five scalar columns.
        expect(result.facts['schemaColumns']).toBe(8)
        expect(result.facts['liveRowCount']).toBe(9)
        expect(result.facts['filteredCount']).toBe(2)
        expect(result.facts['sliceRows']).toBe(3)
        expect(result.facts['cells']).toBe(45)
        expect(result.facts['sortedRows']).toBe(9)
        break
      case 'overlay-insert-edits':
        // m4-2b: inserted-row edits merged into the composed SQL — schema,
        // live count, window cells, and the CSV+JSONL export round-trip.
        expect(result.facts['schemaColumns']).toBe(8)
        expect(result.facts['liveRowCount']).toBe(6)
        expect(result.facts['cells']).toBe(30)
        expect(result.facts['formats']).toBe(2)
        expect(result.facts['engineReopens']).toBe(2)
        expect(result.facts['csvSanitizationProbed']).toBe(true)
        break
      case 'overlay-cast-check':
        // m4-4b: validate-before-commit cast check — the classifications a
        // 1-row probe cannot cover, the multi-cast-chain false negative the
        // review found, the prior-cast+edit case, the symmetric
        // false-positive direction, and the typed invalid-target/unknown-
        // column rejections.
        expect(result.facts['cases']).toBe(9)
        expect(result.facts['convertible']).toBe(4)
        expect(result.facts['nonConvertible']).toBe(5)
        expect(result.facts['agreements']).toBe(13)
        expect(result.facts['invalidRejected']).toBe(3)
        expect(result.facts['unknownRejected']).toBe(2)
        expect(result.facts['engineReusable']).toBe(true)
        break
      case 'export-round-trip':
        expect(result.facts['formats']).toBe(5)
        expect(result.facts['engineReopens']).toBe(4)
        expect(result.facts['arrowVerified']).toBe(1)
        expect(result.facts['csvSanitizationProbed']).toBe(true)
        break
      case 'source-immutability':
        expect(result.facts['exports']).toBe(5)
        expect(result.facts['distinctDestinations']).toBe(5)
        expect(result.facts['digestUnchanged']).toBe(true)
        break
      case 'overlay-hostile-types-rejected':
        // Both hostile type positions (cast target + base column) rejected
        // with the typed operation category; the injection side-effect tables
        // absent; the engine reusable afterwards.
        expect(result.facts['probes']).toBe(2)
        expect(result.facts['rejected']).toBe(2)
        expect(result.facts['injectedAbsent']).toBe(true)
        expect(result.facts['engineReusable']).toBe(true)
        break
      case 'validation-plan-execution':
        // m5-2 + fix rounds: the real compiler's plan executed over the
        // effective view — exact counts (19 planned rules, 8 failing on the
        // base run), the overlay-interaction flips in both directions (9 fix
        // flips: the tombstone run clears unique, the fix-all run clears all
        // 8 failing rules; 3 violate flips: tombstoning drops below
        // min-rows, the insert-until-max run trips max-rows and
        // min-distinct-share), the sample clamp (a K=100 plan reports 100
        // samples; m5-2 round 3: a K=500 plan ALSO executes — 100 samples,
        // FULL failCount), the hostile-plan rejections including the review's
        // canary probes (both absent via catalog listing), the round-3
        // comment-bearing pseudo-reference probes, the shape-valid plan
        // whose counts exceed the dataset (round-3 result-sanity guard),
        // the pre-existing-view survival pin, and the 21-spelling vocabulary
        // agreement (including the bare-DECIMAL caveat).
        expect(result.facts['rules']).toBe(19)
        expect(result.facts['rowCount']).toBe(120)
        expect(result.facts['failingRules']).toBe(8)
        expect(result.facts['interactions']).toBe(6)
        expect(result.facts['fixFlips']).toBe(9)
        expect(result.facts['violateFlips']).toBe(3)
        expect(result.facts['hardMaxSamples']).toBe(100)
        expect(result.facts['clampedKSamples']).toBe(100)
        expect(result.facts['oversizeKClamped']).toBe(true)
        expect(result.facts['hostileRejected']).toBe(11)
        expect(result.facts['canariesAbsent']).toBe(true)
        expect(result.facts['preExistingViewSurvived']).toBe(true)
        expect(result.facts['vocabularyAgreed']).toBe(21)
        expect(result.facts['engineReusable']).toBe(true)
        break
      case 'row-diff-plan-execution':
        // m6-2: the real m6-1 compiler's plan executed with side A on the
        // effective view and side B on the staged comparison — exact counts
        // (132 A rows / 260 B rows; 130 added / 2 removed / 130 changed),
        // the overlay-interaction flips, the K clamp (a K=500 plan reports
        // 100 samples with the FULL count 130), the hostile-plan rejections,
        // the canary absence, the pre-existing-view survival pin, and the
        // staging failure paths.
        expect(result.facts['keys']).toBe(1)
        expect(result.facts['rowCountA']).toBe(132)
        expect(result.facts['rowCountB']).toBe(260)
        expect(result.facts['added']).toBe(130)
        expect(result.facts['removed']).toBe(2)
        expect(result.facts['changed']).toBe(130)
        expect(result.facts['interactions']).toBe(2)
        expect(result.facts['countFlips']).toBeGreaterThanOrEqual(1)
        expect(result.facts['clampedCount']).toBe(130)
        expect(result.facts['clampedSamples']).toBe(100)
        expect(result.facts['hostileRejected']).toBe(11)
        expect(result.facts['canariesAbsent']).toBe(true)
        expect(result.facts['preExistingViewSurvived']).toBe(true)
        expect(result.facts['stagingFailuresRejected']).toBe(true)
        expect(result.facts['engineReusable']).toBe(true)
        break
      default:
        break
    }
  })
}

test('conformance run-all: the whole suite passes in one page against engine-duckdb', async ({
  page,
}) => {
  test.setTimeout(300_000) // twenty scenarios, each with a fresh engine boot
  await page.goto(HARNESS_URL)
  await page.getByRole('button', { name: 'Conformance: run all scenarios' }).click()
  const element = page.getByTestId('conformance-run-all')
  await expect(element).not.toHaveText('not run', { timeout: 120_000 })
  const report = JSON.parse((await element.textContent())!) as RunAllReport

  expect(report.subject).toBe('engine-duckdb')
  expect(report.results.map((result) => result.name)).toEqual([...SCENARIOS])
  for (const result of report.results) {
    expect(result.passed, `scenario ${result.name}: ${result.detail}`).toBe(true)
  }
  expect(report.allPassed).toBe(true)
  // Isolation: scenarios run on their own fresh clients — the harness's
  // page-level engine client was never booted by any of them.
  await expect(page.getByTestId('engine-status')).toHaveText('idle')
})
