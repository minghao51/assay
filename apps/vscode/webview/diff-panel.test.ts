// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * D03b — the extracted diff presentation controller, driven through its real
 * DOM surface under happy-dom.
 *
 * These tests pin the invariants the split must not lose:
 * - nothing runs before an EXPLICIT confirmation, and a refusal names why;
 * - a FAILED or superseded run KEEPS the previous report (status says so);
 * - the stale flag is recomputed against the CURRENT revision — for the marker
 *   AND for the create-only exported report body (never the publish-time flag);
 * - the exported body stays the canonical projection (`assay-diff-report`);
 * - only A-side samples offer navigation.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type {
  EngineColumnSchema,
  EngineComparisonHandle,
  EngineDatasetProfile,
  EngineTableHandle,
} from '@assay/engine-duckdb'
import type { StagedComparisonFrame } from './diff-panel'
import { DiffPanel } from './diff-panel'
import type { DiffColumn, EngineDiffResult } from '../src/pure/diff-controller'
import {
  COMPARISON_REPLACE_REFUSED,
  DIFF_CANCELLED_STATUS,
  DIFF_COMPLETE_STATUS,
  DIFF_FAILED_STATUS,
  STAGED_READY_STATUS,
  diffStaleVisible,
} from '../src/pure/diff-presenter'

const HANDLE_A = { kind: 'table', id: 'table-a' } as unknown as EngineTableHandle
const HANDLE_B = { kind: 'table', id: 'table-b' } as unknown as EngineTableHandle
const COMPARISON = { id: 'comparison-1' } as unknown as EngineComparisonHandle

const SCHEMA_A: readonly EngineColumnSchema[] = [
  { name: 'id', type: 'BIGINT' } as unknown as EngineColumnSchema,
  { name: 'value', type: 'DOUBLE' } as unknown as EngineColumnSchema,
]
const COLUMNS: readonly DiffColumn[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'value', type: 'DOUBLE' },
]

function profile(rowCount: number): EngineDatasetProfile {
  return {
    rowCount,
    columns: [
      { name: 'id', type: 'BIGINT', kind: 'other', nullCount: 0, distinctCount: rowCount },
      { name: 'value', type: 'DOUBLE', kind: 'other', nullCount: 0, distinctCount: rowCount },
    ],
  } as unknown as EngineDatasetProfile
}

const RESULT: EngineDiffResult = {
  rowCountA: 12,
  rowCountB: 12,
  aspects: [
    { aspect: 'added', count: 1, samples: [{ side: 'A', rowKey: 'base:a#7' }] },
    { aspect: 'removed', count: 1, samples: [{ side: 'B', rowKey: 'base:b#8' }] },
    {
      aspect: 'changed',
      count: 1,
      samples: [
        { side: 'A', rowKey: 'base:a#2', changedColumns: ['value'] },
        { side: 'B', rowKey: 'base:b#2', changedColumns: ['value'] },
      ],
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
  add('div', 'diff-controls').hidden = true
  add('button', 'comparison-select')
  add('button', 'diff-confirm')
  add('button', 'diff-cancel').hidden = true
  add('button', 'diff-export')
  add('p', 'diff-status')
  add('div', 'diff-disclosure')
  add('div', 'diff-candidates')
  add('select', 'diff-keys').setAttribute('multiple', 'true')
  add('div', 'diff-results')
  add('p', 'diff-stale').hidden = true
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`missing #${id}`)
  return found
}

interface Harness {
  readonly panel: DiffPanel
  readonly posts: Record<string, unknown>[]
  readonly exportRequests: () => Record<string, unknown>[]
  readonly setRevision: (revision: number) => void
  readonly setEditPending: (pending: boolean) => void
  readonly resolveRun: (result: EngineDiffResult) => void
  readonly failRun: (error: unknown) => void
  readonly runDiffCalls: () => number
  /** Select the comparison through the real host-frame path. */
  readonly stageComparison: () => Promise<void>
  /** Confirm the `id` key exactly as a user would (select, then click). */
  readonly confirmIdKey: () => Promise<void>
}

function harness(): Harness {
  const posts: Record<string, unknown>[] = []
  let revision = 0
  let editPending = false
  let nextId = 0
  let runDiffCalls = 0
  let settle: { resolve: (r: EngineDiffResult) => void; reject: (e: unknown) => void } | null = null
  const panel = new DiffPanel({
    post: (message) => posts.push(message as Record<string, unknown>),
    datasetHandle: HANDLE_A,
    currentRevision: () => revision,
    editPending: () => editPending,
    effectiveColumns: () => COLUMNS,
    overlay: () => ({ ops: [] }) as never,
    stageComparison: async () => COMPARISON,
    openComparison: async () => HANDLE_B,
    schema: async (handle) => (handle === HANDLE_A ? SCHEMA_A : SCHEMA_A),
    profile: async () => profile(12),
    runDiff: () => {
      runDiffCalls++
      return new Promise<EngineDiffResult>((resolve, reject) => {
        settle = { resolve, reject }
      })
    },
    navigateToRow: async () => true,
    createId: () => `req-${++nextId}`,
  })
  panel.mount()
  const stageComparison = async (): Promise<void> => {
    panel.selectComparison()
    const posted = posts.filter((entry) => entry['kind'] === 'comparison-select-request').at(-1)
    if (posted === undefined) throw new Error('no comparison-select-request was posted')
    const frame: StagedComparisonFrame = {
      id: String(posted['id']),
      generation: Number(posted['generation']),
      name: 'comparison-b.csv',
      displayName: 'comparison-b.csv',
      bytes: new ArrayBuffer(8),
    }
    if (panel.handleHostFrame({ kind: 'comparison-loaded', ...frame }) !== true)
      throw new Error('comparison-loaded frame was not routed to the panel')
    await flush()
  }
  const confirmIdKey = async (): Promise<void> => {
    const select = element('diff-keys') as HTMLSelectElement
    for (const option of [...select.options]) option.selected = option.value === 'id'
    element('diff-confirm').dispatchEvent(new Event('click'))
    await flush()
  }
  return {
    panel,
    posts,
    exportRequests: () => posts.filter((entry) => entry['kind'] === 'report-export-request'),
    setRevision: (next) => {
      revision = next
    },
    setEditPending: (pending) => {
      editPending = pending
    },
    resolveRun: (result) => settle?.resolve(result),
    failRun: (error) => settle?.reject(error),
    runDiffCalls: () => runDiffCalls,
    stageComparison,
    confirmIdKey,
  }
}

/** Let the panel's queued promise callbacks (and the fake engine seams) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

describe('diff panel (extracted presentation controller)', () => {
  beforeEach(scaffold)

  it('refuses to run before a comparison is staged and before keys are confirmed', async () => {
    const h = harness()
    element('diff-confirm').dispatchEvent(new Event('click'))
    expect(element('diff-status').textContent).toBe('Diff refused: busy or comparison unavailable.')
    expect(h.runDiffCalls()).toBe(0)

    await h.stageComparison()
    expect(h.panel.comparisonIsStaged).toBe(true)
    expect(element('diff-status').textContent).toBe(STAGED_READY_STATUS)
    // The multi-select starts empty: confirmation without keys is a refusal.
    element('diff-confirm').dispatchEvent(new Event('click'))
    expect(element('diff-status').textContent).toBe('Diff refused: invalid keys (empty).')
    expect(h.runDiffCalls()).toBe(0)
  })

  it('refuses staging while an edit is pending and releases the latch', async () => {
    const h = harness()
    h.setEditPending(true)
    h.panel.selectComparison()
    expect(element('diff-status').textContent).toBe(COMPARISON_REPLACE_REFUSED)
    h.setEditPending(false)
    await h.stageComparison()
    expect(h.panel.comparisonIsStaged).toBe(true)
  })

  it('publishes a confirmed report, then RETAINS it across a failed run with recomputed staleness', async () => {
    const h = harness()
    await h.stageComparison()
    h.setRevision(3)
    await h.confirmIdKey()
    expect(h.runDiffCalls()).toBe(1)
    h.resolveRun(RESULT)
    await flush()

    const published = h.panel.publishedReport
    expect(published).not.toBeNull()
    expect(published?.revision).toBe(3)
    expect(published?.baseViewOnly).toBe(true)
    expect(element('diff-status').textContent).toBe(DIFF_COMPLETE_STATUS)
    expect(element('diff-results').textContent).toContain('DIFFERENCES found')
    expect(element('diff-results').textContent).toContain('Keys: ["id"] (explicit)')
    expect(element('diff-stale').hidden).toBe(true)
    expect(element('diff-export').hasAttribute('disabled')).toBe(false)

    // An accepted edit moves the revision: the marker appears, the report stays.
    h.setRevision(4)
    h.panel.refreshStale()
    expect(element('diff-stale').hidden).toBe(false)
    expect(diffStaleVisible(h.panel.publishedReport, 4)).toBe(true)

    // A failing run keeps the PREVIOUS report (same object and revision).
    element('diff-confirm').dispatchEvent(new Event('click'))
    await flush()
    h.failRun(new Error('engine refused the diff'))
    await flush()
    expect(h.panel.publishedReport).toBe(published)
    expect(h.panel.publishedReport?.revision).toBe(3)
    expect(element('diff-status').textContent).toBe(DIFF_FAILED_STATUS)
    expect(element('diff-results').textContent).toContain('DIFFERENCES found')
    h.panel.refreshStale()
    expect(element('diff-stale').hidden).toBe(false)
    expect(element('diff-confirm').hasAttribute('disabled')).toBe(false)
    expect(element('diff-cancel').hidden).toBe(true)
  })

  it('exports the create-only body with a stale flag recomputed at click time', async () => {
    const h = harness()
    await h.stageComparison()
    h.setRevision(3)
    const run = h.confirmIdKey()
    await run
    h.resolveRun(RESULT)
    await flush()
    expect(h.panel.publishedReport?.revision).toBe(3)

    // Move the revision AFTER the report was published: the exported body must
    // carry the recomputed flag, not the publish-time one.
    h.setRevision(9)
    element('diff-export').dispatchEvent(new Event('click'))
    const requests = h.exportRequests()
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(typeof request['generation']).toBe('number')
    expect(typeof request['id']).toBe('string')
    const body = JSON.parse(String(request['json'])) as Record<string, unknown>
    expect(body['report']).toBe('assay-diff-report')
    expect(body['stale']).toBe(true)
    expect(body['baseViewOnly']).toBe(true)
    expect(body['keys']).toEqual(['id'])
    expect(element('diff-status').textContent).toBe('Choose a new local file for the JSON report…')

    // Correlated result → honest status; uncorrelated → not routed here.
    expect(
      h.panel.handleHostFrame({
        kind: 'report-export-result',
        id: request['id'],
        generation: request['generation'],
        status: 'created',
      }),
    ).toBe(true)
    expect(element('diff-status').textContent).toBe('JSON report created as a new local file.')
    expect(h.panel.pendingReportExport).toBeNull()
    expect(
      h.panel.handleHostFrame({
        kind: 'report-export-result',
        id: 'other',
        generation: request['generation'],
        status: 'created',
      }),
    ).toBe(false)
  })

  it('ignores a superseded run: cancel keeps the previous report and drops the late result', async () => {
    const h = harness()
    await h.stageComparison()
    h.setRevision(1)
    const first = h.confirmIdKey()
    await first
    h.resolveRun(RESULT)
    await flush()
    const published = h.panel.publishedReport
    expect(published).not.toBeNull()

    element('diff-confirm').dispatchEvent(new Event('click'))
    await flush()
    expect(h.runDiffCalls()).toBe(2)
    element('diff-cancel').dispatchEvent(new Event('click'))
    expect(element('diff-status').textContent).toBe(DIFF_CANCELLED_STATUS)
    h.resolveRun({ ...RESULT, rowCountA: 99 })
    await flush()
    expect(h.panel.publishedReport).toBe(published)
    expect(h.panel.publishedReport?.rowCountA).toBe(12)
    expect(element('diff-status').textContent).toBe(DIFF_CANCELLED_STATUS)
  })

  it('resets the report when a NEW comparison is staged (a new staging invalidates it)', async () => {
    const h = harness()
    await h.stageComparison()
    h.setRevision(2)
    const run = h.confirmIdKey()
    await run
    h.resolveRun(RESULT)
    await flush()
    expect(h.panel.publishedReport).not.toBeNull()

    await h.stageComparison()
    expect(h.panel.publishedReport).toBeNull()
    expect(element('diff-results').textContent).toBe('')
    expect(element('diff-stale').hidden).toBe(true)
    expect(element('diff-export').hasAttribute('disabled')).toBe(true)
    // The disclosure always accompanies a staged comparison.
    expect(element('diff-disclosure').textContent).toContain('no row diff runs before confirmation')
  })

  it('offers navigation only for A-side samples', async () => {
    const h = harness()
    await h.stageComparison()
    h.setRevision(1)
    const run = h.confirmIdKey()
    await run
    h.resolveRun(RESULT)
    await flush()
    const labels = [...element('diff-results').querySelectorAll('button')].map(
      (button) => button.textContent,
    )
    // The A-side added and changed samples navigate; the B-side sample
    // (`base:b#8`) is display-only and must never offer a jump.
    expect(labels).toEqual(['Go to A row base #7', 'Go to A row base #2'])
    expect(labels.some((label) => label.includes('base #8'))).toBe(false)
  })
})
