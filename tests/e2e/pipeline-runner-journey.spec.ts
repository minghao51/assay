import { expect, test } from './support/fixture'
import type { RunAllReport } from './support/conformance'
// The scenario list is the suite package's single source of truth (au3-11,
// the engine-conformance.spec.ts precedent): the root e2e has no
// `@assay/testing` dependency to resolve the bare specifier, so this imports
// the exported module node directly.
import { pipelineRunnerConformanceScenarioNames } from '../../packages/testing/src/pipeline-runner-conformance'

// p-3: the pipeline runner on the real engine. The harness
// (packages/engine-duckdb/harness) hosts two pieces of evidence:
//
// 1. `pipeline-journey-result` — ONE explicit user-triggered run of a
//    3-node pipeline (source → transform filter → sql projection) via
//    `client.runPipeline`: the fixture dataset registers as the source
//    relation, the two compiled nodes materialize as named views in
//    topological order, the final relation's rows are read back, and a
//    second identical run proves idempotency (recreate, never append).
// 2. `pipeline-conformance-run-all` — the @assay/testing runner suite
//    (success, mid-DAG failure + clean re-run, cancel, unknown-node
//    refusal, hostile-SQL refusal, relation handle, validate pass/gated,
//    publish gate + two-gate blockedGates, diff node, table/export
//    materialization, mode refusals, table↔view mode change)
//    against fresh real clients.
//
// Harness served from packages/engine-duckdb by the second webServer in
// playwright.config.ts; port env-overridable for parallel worktree batches
// (default 4179).
const HARNESS_URL = `http://localhost:${process.env['ASSAY_E2E_PORT_ENGINE'] ?? 4179}/`

interface JourneyNodeEvidence {
  nodeId: string
  relation: string
  rowCount: number
}

interface PipelineJourneyEvidence {
  status?: string
  nodes?: JourneyNodeEvidence[]
  finalRows?: string[]
  reRunStatus?: string
  reRunRowCounts?: number[]
  reRunFinalRows?: string[]
  error?: string
}

test('pipeline journey: a 3-node pipeline runs end-to-end on the real engine', async ({ page }) => {
  await page.goto(HARNESS_URL)
  await expect(page.getByTestId('engine-status')).toHaveText('idle')
  await page.getByRole('button', { name: 'Pipeline: run the 3-node journey' }).click()
  const element = page.getByTestId('pipeline-journey-result')
  await expect(element).not.toHaveText('not run', { timeout: 60_000 })
  const evidence = JSON.parse((await element.textContent())!) as PipelineJourneyEvidence

  expect(evidence.error, 'the journey must not error').toBeUndefined()
  expect(evidence.status).toBe('completed')
  // Topological order with the fixture's pinned counts: 5 source rows, the
  // two SG rows after the filter, the same two after the projection.
  expect(evidence.nodes).toEqual([
    { nodeId: 'customers', relation: 'customers', rowCount: 5 },
    { nodeId: 'sg', relation: 'sg', rowCount: 2 },
    { nodeId: 'out', relation: 'out', rowCount: 2 },
  ])
  expect(evidence.finalRows).toEqual(['1', '3'])

  // Idempotent re-run: recreated, never appended.
  expect(evidence.reRunStatus).toBe('completed')
  expect(evidence.reRunRowCounts).toEqual([5, 2, 2])
  expect(evidence.reRunFinalRows).toEqual(['1', '3'])
})

test('pipeline conformance run-all: the runner suite passes against the real engine', async ({
  page,
}) => {
  test.setTimeout(600_000) // one fresh engine boot per scenario
  await page.goto(HARNESS_URL)
  await page.getByRole('button', { name: 'Pipeline runner conformance: run all' }).click()
  const element = page.getByTestId('pipeline-conformance-run-all')
  await expect(element).not.toHaveText('not run', { timeout: 360_000 })
  const report = JSON.parse((await element.textContent())!) as RunAllReport

  expect(report.subject).toBe('engine-duckdb')
  expect(report.results.map((result) => result.name)).toEqual([
    ...pipelineRunnerConformanceScenarioNames,
  ])
  for (const result of report.results) {
    expect(result.passed, `scenario ${result.name}: ${result.detail}`).toBe(true)
  }
  expect(report.allPassed).toBe(true)
  // Isolation: scenarios run on their own fresh clients — the harness's
  // page-level engine client was never booted by any of them.
  await expect(page.getByTestId('engine-status')).toHaveText('idle')
})
