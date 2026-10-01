import { expect, test } from '@playwright/test'

// p2-4: a gated pipeline on the real engine. The harness
// (packages/engine-duckdb/harness) hosts `pipeline-gate-journey-result`:
//
//   source → filter(SG) → validate(gate) → publish(out, requires gate)
//
// The first run binds a FAILING contract (a NULL income on row 3) — the run
// stops as a `gated` outcome naming the validate node, the publish never
// runs, and the partial state is named. Re-binding a PASSING contract and
// re-running completes with the publish gate unblocked (re-run-after-fix).
//
// Harness served from packages/engine-duckdb by the second webServer in
// playwright.config.ts; port env-overridable for parallel worktree batches
// (default 4179).
const HARNESS_URL = `http://localhost:${process.env['ASSAY_E2E_PORT_ENGINE'] ?? 4179}/`

interface GateJourneyNodeEvidence {
  nodeId: string
  relation: string
  rowCount: number
  materialization: string
}

interface GateJourneyEvidence {
  status?: string
  gatedAt?: string
  gate?: string
  nodes?: GateJourneyNodeEvidence[]
  gateValid?: boolean
  publishBlockedGates?: number
  reRunStatus?: string
  reRunNodes?: string[]
  reRunGateValid?: boolean
  reRunPublishGateBlocked?: number
  error?: string
}

test('pipeline gate journey: a gated pipeline stops and re-runs after the fix', async ({
  page,
}) => {
  await page.goto(HARNESS_URL)
  await expect(page.getByTestId('engine-status')).toHaveText('idle')
  await page.getByRole('button', { name: 'Pipeline: run the gated journey' }).click()
  const element = page.getByTestId('pipeline-gate-journey-result')
  await expect(element).not.toHaveText('not run', { timeout: 60_000 })
  const evidence = JSON.parse((await element.textContent())!) as GateJourneyEvidence

  expect(evidence.error, 'the journey must not error').toBeUndefined()
  // The failing validate is reported at the publish that requires it: the
  // run is gated there, the failed verdict is named, and the publish does not
  // pass its gate.
  expect(evidence.status).toBe('gated')
  expect(evidence.gatedAt).toBe('out')
  expect(evidence.gate).toBe('publish-blocked')
  expect(evidence.gateValid).toBe(false)
  expect(evidence.publishBlockedGates).toBe(1)
  expect(evidence.nodes?.map((node) => node.nodeId)).toEqual(['customers', 'sg', 'gate', 'out'])
  expect(evidence.nodes?.find((node) => node.nodeId === 'gate')?.rowCount).toBe(2)

  // Re-binding the passing contract completes the run and unblocks the gate.
  expect(evidence.reRunStatus).toBe('completed')
  expect(evidence.reRunNodes).toContain('out')
  expect(evidence.reRunGateValid).toBe(true)
  expect(evidence.reRunPublishGateBlocked).toBe(0)
})
