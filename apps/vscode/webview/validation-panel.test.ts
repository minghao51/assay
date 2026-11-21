// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * D03b — the extracted validation presentation controller, driven through its
 * real DOM surface under happy-dom.
 *
 * These tests pin the invariants the split must not lose:
 * - a FAILED or superseded run KEEPS the previous report (and the status line
 *   says so), so a reader never loses a verdict to a transient failure;
 * - the stale marker is recomputed against the CURRENT edit revision, not the
 *   revision the report was published at;
 * - a newly loaded contract resets the report; cancelled/uncorrelated frames
 *   and late generations change nothing;
 * - a compilation refusal never reaches the engine.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { EngineOverlay, EngineValidationResult } from '@assay/engine-duckdb'
import type { ValidationHostRequest } from './validation-panel'
import { ValidationPanel } from './validation-panel'
import {
  CANCELLED_STATUS,
  COMPILING_STATUS,
  COMPLETE_STATUS,
  FAILED_STATUS,
  SELECT_CONTRACT_STATUS,
  validationStaleVisible,
} from '../src/pure/validation-presenter'

const CONTRACT =
  'format: v1\nname: sample\nversion: 1\ncolumns:\n  - name: id\n    required: true\n'
const UNBOUND_CONTRACT =
  'format: v1\nname: sample\nversion: 1\ncolumns:\n  - name: missing_column\n    required: true\n'

const RESULT: EngineValidationResult = {
  valid: false,
  rowCount: 12,
  rules: [
    {
      ruleId: 'id_required',
      outcome: 'row-samples',
      failCount: 1,
      failPercent: 8.33,
      sampleFailures: [{ rowKey: 'base:a#6', value: null }],
    },
  ],
}

function scaffold(): void {
  document.body.replaceChildren()
  const add = (tag: string, id: string): HTMLElement => {
    const node = document.createElement(tag)
    node.id = id
    document.body.appendChild(node)
    return node
  }
  add('button', 'contract-select')
  add('div', 'validation-controls').hidden = true
  add('button', 'validate-button')
  add('button', 'validate-cancel').hidden = true
  add('p', 'validation-status')
  add('p', 'validation-stale').hidden = true
  add('div', 'validation-results')
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`missing #${id}`)
  return found
}

interface Harness {
  readonly panel: ValidationPanel
  readonly posts: ValidationHostRequest[]
  readonly validateCalls: () => number
  readonly setRevision: (revision: number) => void
  readonly setEditPending: (pending: boolean) => void
  readonly resolveRun: (result: EngineValidationResult) => void
  readonly failRun: (error: unknown) => void
  readonly startRun: () => Promise<void>
  /** Select the contract through the real host-frame path. */
  readonly loadContract: (text: string) => void
}

function harness(): Harness {
  const posts: ValidationHostRequest[] = []
  let revision = 0
  let editPending = false
  let nextId = 0
  let validateCalls = 0
  let settle: {
    resolve: (r: EngineValidationResult) => void
    reject: (e: unknown) => void
  } | null = null
  const panel = new ValidationPanel({
    post: (message) => posts.push(message),
    currentRevision: () => revision,
    editPending: () => editPending,
    effectiveColumns: () => [{ name: 'id', type: 'VARCHAR' }],
    overlay: () => ({ ops: [] }) as unknown as EngineOverlay,
    validate: () => {
      validateCalls++
      return new Promise<EngineValidationResult>((resolve, reject) => {
        settle = { resolve, reject }
      })
    },
    navigateToRow: async () => true,
    createId: () => `req-${++nextId}`,
  })
  panel.mount()
  return {
    panel,
    posts,
    validateCalls: () => validateCalls,
    setRevision: (next) => {
      revision = next
    },
    setEditPending: (pending) => {
      editPending = pending
    },
    resolveRun: (result) => settle?.resolve(result),
    failRun: (error) => settle?.reject(error),
    startRun: () => panel.run(),
    loadContract: (text) => {
      panel.requestContract()
      const request = panel.pendingRequest
      if (request === null) throw new Error('no pending contract request')
      panel.handleHostFrame({ kind: 'contract-loaded', ...request, text })
    },
  }
}

/** Let the panel's queued promise callbacks (and the engine seam) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

describe('validation panel (extracted presentation controller)', () => {
  beforeEach(scaffold)

  it('selects a contract through a correlated frame and posts one request at a time', () => {
    const h = harness()
    h.panel.requestContract()
    // A second click while a request is in flight must not post again.
    h.panel.requestContract()
    expect(h.posts).toEqual([{ kind: 'validate-request', id: 'req-1', generation: 1 }])
    expect(element('validation-status').textContent).toBe(SELECT_CONTRACT_STATUS)

    const request = h.panel.pendingRequest
    expect(request).not.toBeNull()
    // An uncorrelated frame is consumed (routed) but changes nothing.
    expect(
      h.panel.handleHostFrame({
        kind: 'contract-loaded',
        id: 'other',
        generation: 1,
        text: CONTRACT,
      }),
    ).toBe(true)
    expect(h.panel.selectedContract).toBeNull()
    expect(h.panel.pendingRequest).toEqual(request)

    h.loadContract(CONTRACT)
    expect(h.panel.selectedContract).toBe(CONTRACT)
    expect(h.panel.pendingRequest).toBeNull()
    expect(element('validation-status').textContent).toBe(
      'Contract selected. Validate the effective view when ready.',
    )
    expect(element('validate-button').hasAttribute('disabled')).toBe(false)
  })

  it('publishes a current-generation report, then RETAINS it across a failed run', async () => {
    const h = harness()
    h.loadContract(CONTRACT)
    h.setRevision(3)

    const first = h.startRun()
    await flush()
    expect(element('validation-status').textContent).toBe(COMPILING_STATUS)
    expect(element('validate-button').hasAttribute('disabled')).toBe(true)
    expect(element('validate-cancel').hidden).toBe(false)
    h.resolveRun(RESULT)
    await first

    const published = h.panel.publishedReport
    expect(published).not.toBeNull()
    expect(published?.revision).toBe(3)
    expect(element('validation-status').textContent).toBe(COMPLETE_STATUS)
    expect(element('validation-results').textContent).toContain('INVALID — 12 effective rows.')
    expect(element('validation-stale').hidden).toBe(true)

    // An accepted edit moves the revision: the marker appears, the report stays.
    h.setRevision(4)
    h.panel.refreshStale()
    expect(element('validation-stale').hidden).toBe(false)
    expect(validationStaleVisible(h.panel.publishedReport, 4)).toBe(true)

    // A failing run keeps the PREVIOUS projection (same object, same revision)
    // and says so; it never clears the rendered report.
    const failing = h.startRun()
    await flush()
    h.failRun(new Error('engine refused'))
    await failing
    expect(h.panel.publishedReport).toBe(published)
    expect(h.panel.publishedReport?.revision).toBe(3)
    expect(element('validation-status').textContent).toBe(FAILED_STATUS)
    expect(element('validation-results').textContent).toContain('INVALID — 12 effective rows.')
    // The retained report is STALE against the current revision (4), not (3).
    h.panel.refreshStale()
    expect(element('validation-stale').hidden).toBe(false)
    expect(element('validate-button').hasAttribute('disabled')).toBe(false)
    expect(element('validate-cancel').hidden).toBe(true)
  })

  it('ignores a superseded run: cancel keeps the previous report and drops the late result', async () => {
    const h = harness()
    h.loadContract(CONTRACT)
    h.setRevision(1)
    const first = h.startRun()
    await flush()
    h.resolveRun(RESULT)
    await first
    const published = h.panel.publishedReport
    expect(published).not.toBeNull()

    const second = h.startRun()
    await flush()
    h.panel.cancel()
    expect(element('validation-status').textContent).toBe(CANCELLED_STATUS)
    expect(element('validate-button').hasAttribute('disabled')).toBe(false)
    h.resolveRun({ ...RESULT, valid: true, rowCount: 99 })
    await second
    // The cancelled generation never published: the previous report stands.
    expect(h.panel.publishedReport).toBe(published)
    expect(h.panel.publishedReport?.rowCount).toBe(12)
    expect(element('validation-status').textContent).toBe(CANCELLED_STATUS)
  })

  it('resets the report only for a newly loaded contract', async () => {
    const h = harness()
    h.loadContract(CONTRACT)
    h.setRevision(1)
    const run = h.startRun()
    await flush()
    h.resolveRun(RESULT)
    await run
    expect(h.panel.publishedReport).not.toBeNull()

    // Cancelled / errored selection frames keep the published verdict.
    h.panel.requestContract()
    const request = h.panel.pendingRequest
    h.panel.handleHostFrame({ kind: 'contract-cancelled', ...request })
    expect(h.panel.publishedReport).not.toBeNull()
    expect(element('validation-status').textContent).toBe('Contract selection cancelled.')

    // A loaded contract is a DIFFERENT contract: the old verdict is not its own.
    h.loadContract(CONTRACT)
    expect(h.panel.publishedReport).toBeNull()
    expect(element('validation-results').textContent).toBe('')
    expect(element('validation-stale').hidden).toBe(true)
  })

  it('refuses to compile an unbound contract without calling the engine', async () => {
    const h = harness()
    h.loadContract(UNBOUND_CONTRACT)
    await h.panel.run()
    expect(h.validateCalls()).toBe(0)
    expect(h.panel.publishedReport).toBeNull()
    expect(element('validation-status').textContent).toBe(
      'Contract does not bind to the effective schema.',
    )
    expect(element('validate-button').hasAttribute('disabled')).toBe(false)
  })

  it('refuses to run while an edit is pending or before a contract is chosen', async () => {
    const h = harness()
    await h.panel.run()
    expect(h.validateCalls()).toBe(0)
    expect(element('validation-status').textContent).toBe('')

    h.loadContract(CONTRACT)
    h.setEditPending(true)
    await h.panel.run()
    expect(h.validateCalls()).toBe(0)
    expect(element('validation-status').textContent).toBe(
      'Contract selected. Validate the effective view when ready.',
    )
  })

  it('recomputes staleness only from a published report', () => {
    const h = harness()
    h.setRevision(2)
    h.panel.refreshStale()
    expect(element('validation-stale').hidden).toBe(true)
    expect(validationStaleVisible(h.panel.publishedReport, 2)).toBe(false)
  })
})
