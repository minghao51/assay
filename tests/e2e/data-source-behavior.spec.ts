import { expect, test } from './support/fixture'
import { runScenario } from './support/conformance'
import type { RunAllReport } from './support/conformance'

// Task T3 (handoff §6): the data-source behavior suite lives in @assay/testing
// (docs/engineering/03-repository-structure.md §4) and is parameterized over a
// DataSourceBehaviorSubject. This spec runs every scenario against the REAL
// BrowserFileSource in Chromium through the data-sources harness
// (packages/data-sources/harness): genuine OPFS-staged FileSystemFileHandles
// (ADR 0017 disposable-cache framing) and the real browser capability globals.
//
// The scenario logic itself is not duplicated here — the suite owns it and is
// additionally proven under Node vitest: against a compliant/non-compliant
// fake (packages/testing/src/data-source-behavior.test.ts) and against the
// real BrowserFileSource with in-memory handles
// (packages/data-sources/src/behavior-subject.test.ts).
//
// Harness served from packages/data-sources by the third webServer in
// playwright.config.ts; port env-overridable for parallel worktree batches
// (default 4180 — this task runs on the DEFAULT ports, no overrides).
const HARNESS_URL = `http://localhost:${process.env['ASSAY_E2E_PORT_DS'] ?? 4180}/`

const SCENARIOS = [
  'identity-idempotency',
  'one-shot-file',
  'metadata-contract',
  'cancel-semantics',
  'capability-matrix',
  'fallback-order',
] as const

/** Button labels as rendered by the harness (kept human-readable there). */
const BUTTON_LABELS: Record<(typeof SCENARIOS)[number], string> = {
  'identity-idempotency': 'Behavior: identity & idempotency',
  'one-shot-file': 'Behavior: one-shot file',
  'metadata-contract': 'Behavior: metadata contract',
  'cancel-semantics': 'Behavior: cancel semantics',
  'capability-matrix': 'Behavior: capability matrix',
  'fallback-order': 'Behavior: fallback order',
}

for (const name of SCENARIOS) {
  test(`data-source behavior: ${name} passes against the real BrowserFileSource`, async ({
    page,
  }) => {
    const result = await runScenario(page, {
      url: HARNESS_URL,
      buttonLabel: BUTTON_LABELS[name],
      resultTestId: `behavior-result-${name}`,
      timeoutMs: 30_000,
      assertEngineIdle: false,
    })
    expect(result.name).toBe(name)
    expect(result.passed, `scenario ${name}: ${result.detail}`).toBe(true)

    // Scenario-specific evidence beyond the pass flag (m1-3/m1-4 semantics).
    switch (name) {
      case 'identity-idempotency':
        expect(result.facts['reopenIdentical']).toBe(true)
        expect(result.facts['frozenHandle']).toBe(true)
        expect(result.facts['identityStable']).toBe(true)
        expect(result.facts['freshInstanceNewId']).toBe(true)
        break
      case 'one-shot-file':
        expect(result.facts['lazyResolve']).toBe(true)
        expect(result.facts['handleGetFileCalls']).toBe(1)
        expect(result.facts['fileSeam']).toBe('shared')
        expect(result.facts['fallbackSnapshotExact']).toBe(true)
        break
      case 'metadata-contract':
        // au3-11: casesProbed is derived from the subject's detect map — six
        // shipped formats + one case-insensitive probe + unknown + fallback.
        expect(result.facts['casesProbed']).toBe(9)
        expect(result.facts['keyCount']).toBe(2)
        expect(result.facts['engineFieldsUnset']).toBe(true)
        break
      case 'cancel-semantics':
        expect(result.facts['fsaCancelResolvedNull']).toBe(true)
        expect(result.facts['emptyPickerResolvedNull']).toBe(true)
        expect(result.facts['nonAbortPropagated']).toBe(true)
        expect(result.facts['inputCancelResolvedNull']).toBe(true)
        break
      case 'capability-matrix':
        expect(result.facts['scopesProbed']).toBe(5)
        expect(result.facts['booleansOnly']).toBe(true)
        expect(result.facts['defaultScopeSafe']).toBe(true)
        break
      case 'fallback-order':
        expect(result.facts['fsaBranchFirst']).toBe(true)
        expect(result.facts['multipleAlwaysFalse']).toBe(true)
        expect(result.facts['inputUnusedWhenPickerAvailable']).toBe(true)
        expect(result.facts['fallbackOnlyWithoutPicker']).toBe(true)
        break
      default:
        break
    }
  })
}

test('data-source behavior run-all: the whole suite passes in one page against BrowserFileSource', async ({
  page,
}) => {
  await page.goto(HARNESS_URL)
  await page.getByRole('button', { name: 'Behavior: run all scenarios' }).click()
  const element = page.getByTestId('behavior-run-all')
  await expect(element).not.toHaveText('not run', { timeout: 30_000 })
  const report = JSON.parse((await element.textContent())!) as RunAllReport

  expect(report.subject).toBe('browser-file-source')
  expect(report.results.map((result) => result.name)).toEqual([...SCENARIOS])
  for (const result of report.results) {
    expect(result.passed, `scenario ${result.name}: ${result.detail}`).toBe(true)
  }
  expect(report.allPassed).toBe(true)
})
