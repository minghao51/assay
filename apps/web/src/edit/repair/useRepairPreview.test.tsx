// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { OverlayBase } from '@assay/domain'
import { initialState } from '@assay/domain'
import { composeRepairPreviewCountSql } from '@assay/engine-duckdb'
import { repairAffectedEnginePlan } from './preview-sql'
import type { RepairCaptureTag } from './capture'
import { validateRepairPlan } from './refusal'
import type { RepairPlan } from './plan'
import type { RepairPreviewRead } from './preview'
import { useRepairPreview, type RepairSeam } from './useRepairPreview'

/**
 * EW-04I — the surface's state machine, driven without a DOM dialog.
 *
 * Two of the row's named host conditions live here:
 *
 * - **U3 (out-of-order results).** Two preview reads are in flight and the
 *   OLDER one settles last: it must not publish, must not overwrite the newer
 *   preview and must not be what Apply sends. The same guard drops a read that
 *   settles after the surface closed.
 * - **The Apply gate.** Applying is only possible for a preview of *this* plan
 *   against *this* session with at least one changed row; every other state
 *   yields its own sentence and no publication.
 */

const BASE: OverlayBase = {
  baseAnchor: 'fv-5-1000',
  overlayAnchor: 'ov-1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'country', type: 'VARCHAR' },
  ],
  baseRowCount: 5,
}
const STATE = initialState(BASE)

/**
 * EW-04I fix round 1 — the cancellation class, measured by the REAL predicate.
 *
 * `trim = ' '` with `M = {a → ' a '}` maps a trimmed value straight back, so
 * `' a '` is unchanged and the plan must preview as **zero affected** (U1).
 * The count below is produced by the production composition — the ENGINE's
 * typed count statement (`composeRepairPreviewCountSql`) — executed by the
 * pinned DuckDB CLI, so this leg fails if the predicate regresses to
 * over-counting — the exact defect this round fixes. The CLI is the
 * repository's convention for CLI-backed pins; without it the case skips
 * rather than passing vacuously.
 */
const DUCKDB_CLI = process.env['DUCKDB'] ?? '/tmp/duckdb'
const hasDuckDbCli = existsSync(DUCKDB_CLI)

const CANCELLATION_PLAN: RepairPlan = {
  column: 'country',
  trim: ' ',
  mapping: new Map([['a', ' a ']]),
}

const CANCELLATION_ROWS: readonly string[] = [' a ', 'SG', 'US', 'DE', 'US']

/** The rows the real predicate counts as affected for `plan` over `rows`. */
function affectedByRealEngine(plan: RepairPlan, rows: readonly string[]): number {
  const base: OverlayBase = { ...BASE, baseRowCount: rows.length }
  const values = rows
    .map((row, index) => `(${String(index)}, '${row.replaceAll("'", "''")}')`)
    .join(', ')
  const script =
    'CREATE TABLE assay_t1 (id INTEGER, country VARCHAR);' +
    `INSERT INTO assay_t1 VALUES ${values};` +
    `SELECT 'affected', affected FROM (${composeRepairPreviewCountSql(
      { viewName: 'assay_t1', base, state: initialState(base) },
      repairAffectedEnginePlan(plan),
    )});`
  const stdout = execFileSync(DUCKDB_CLI, ['-noheader', '-list', '-c', script], {
    encoding: 'utf8',
    stdio: 'pipe',
  })
  const line = stdout.trim().split(/\r?\n/).pop() ?? ''
  return Number(line.slice(line.indexOf('|') + 1))
}

const TAG: RepairCaptureTag = {
  baseAnchor: 'fv-5-1000',
  overlayAnchor: 'ov-1',
  cursor: 0,
  historyRevision: 0,
  column: 'country',
  columnType: 'VARCHAR',
  schemaSignature: 'id:BIGINT\u0000country:VARCHAR',
}

function read(affected: number, values: readonly string[] = ['SG']): RepairPreviewRead {
  return {
    scanned: 5,
    affected,
    exampleCap: 10,
    exampleRows: values.map((value, index) => ({
      rowId: `base:fv-5-1000#${String(index)}`,
      value,
    })),
  }
}

/** A seam whose reads are settled by the test, one deferred at a time. */
function harness(options: { readonly stale?: boolean; readonly liveRows?: number } = {}) {
  const deferred: { resolve(read: RepairPreviewRead): void; reject(error: Error): void }[] = []
  const applied: { plan: RepairPlan; affected: number }[] = []
  let stale = options.stale === true
  let revision = 0

  const seam: RepairSeam = {
    facts: () => ({ liveRows: options.liveRows ?? 5, repairPairs: 0 }),
    captureTag: (column) => ({ ...TAG, column, historyRevision: stale ? revision + 1 : revision }),
    // The real domain fold, not a stub: the capture refusals are the domain's.
    validatePlan: (plan) => validateRepairPlan(BASE, STATE, plan),
    readPreview: () =>
      new Promise<RepairPreviewRead>((resolve, reject) => {
        deferred.push({ resolve, reject })
      }),
    apply: (plan, guard) => {
      applied.push({ plan, affected: guard.affected })
    },
  }

  const mounted = renderHook(() => useRepairPreview(seam))
  return {
    ...mounted,
    applied,
    seam,
    /** Mark the session as changed, so the preview's tag becomes stale. */
    drift(): void {
      stale = true
      revision += 1
    },
    /** Settle the read at `index` (deferred reads settle in the test's order). */
    async settle(index: number, result: RepairPreviewRead): Promise<void> {
      await act(async () => {
        deferred[index]?.resolve(result)
        await Promise.resolve()
      })
    },
    async fail(index: number, error: Error): Promise<void> {
      await act(async () => {
        deferred[index]?.reject(error)
        await Promise.resolve()
      })
    },
  }
}

/** Fill in a parseable plan on the surface. */
function authorPlan(hook: ReturnType<typeof harness>): void {
  act(() => {
    hook.result.current.openDialog()
  })
  act(() => {
    hook.result.current.update({ column: 'country', mappingText: 'SG => Singapore' })
  })
}

describe('useRepairPreview — capture gates the preview without an engine call', () => {
  it('cannot preview until the plan parses and the domain accepts it', () => {
    const hook = harness()
    act(() => {
      hook.result.current.openDialog()
    })
    expect(hook.result.current.canPreview).toBe(false)
    expect(hook.result.current.refusal?.message).toBe('Choose the column to repair.')

    act(() => {
      hook.result.current.update({ column: 'country' })
    })
    // No pairs and no trim: the domain's identity no-op, refused at capture.
    expect(hook.result.current.canPreview).toBe(false)
    expect(hook.result.current.refusal?.code).toBe('repair-identity')

    act(() => {
      hook.result.current.update({ mappingText: 'SG => Singapore' })
    })
    expect(hook.result.current.refusal).toBeNull()
    expect(hook.result.current.canPreview).toBe(true)
  })

  it('a domain refusal stops the read from ever being dispatched', () => {
    const hook = harness()
    const readSpy = vi.spyOn(hook.seam, 'readPreview')
    act(() => {
      hook.result.current.openDialog()
    })
    act(() => {
      hook.result.current.update({ column: 'country', mappingText: 'no separator here' })
    })
    act(() => {
      hook.result.current.runPreview()
    })
    expect(readSpy).not.toHaveBeenCalled()
    expect(hook.result.current.preview.kind).toBe('idle')
  })

  it('the export-budget refusal blocks the preview before any read (D4 a)', () => {
    const hook = harness({ liveRows: 2_000_000 })
    const readSpy = vi.spyOn(hook.seam, 'readPreview')
    authorPlan(hook)
    // 500 pairs over 2M rows is the envelope corner; 501 is over it.
    const overCap = Array.from({ length: 500 }, (_, index) => `k${String(index)} => v`).join('\n')
    act(() => {
      hook.result.current.update({ mappingText: overCap })
    })
    expect(hook.result.current.pairCount).toBe(500)
    // 500 pairs × 2,000,000 rows = 1e9 = the envelope exactly: allowed.
    expect(hook.result.current.budgetRefusal).toBeNull()
    act(() => {
      hook.result.current.update({ mappingText: `${overCap}\nz => y` })
    })
    expect(hook.result.current.pairCount).toBe(501)
    expect(hook.result.current.budgetRefusal).toBe(
      'This plan would cost 2000000 rows × 501 mapping pairs = 1,002,000,000 cell rewrites, ' +
        'over the published envelope of 1,000,000,000. Nothing was previewed or applied: export ' +
        'the edits to a new file and re-open it before repairing further.',
    )
    expect(hook.result.current.canPreview).toBe(false)
    act(() => {
      hook.result.current.runPreview()
    })
    expect(readSpy).not.toHaveBeenCalled()
  })
})

describe('useRepairPreview — U3: out-of-order results never publish', () => {
  it('a slower earlier read cannot overwrite a newer preview, and never becomes applicable', async () => {
    const hook = harness()
    authorPlan(hook)

    act(() => {
      hook.result.current.runPreview()
    })
    // Second dispatch (as a re-preview after editing the plan would do).
    act(() => {
      hook.result.current.update({ mappingText: 'SG => Singapore\nUS => United States' })
    })
    act(() => {
      hook.result.current.runPreview()
    })
    expect(hook.result.current.preview.kind).toBe('loading')

    // The NEWER read settles first…
    await hook.settle(1, read(3, ['SG', 'US', ' SG ']))
    expect(hook.result.current.preview.kind).toBe('ready')
    expect(
      hook.result.current.preview.kind === 'ready' && hook.result.current.preview.preview.counts,
    ).toEqual({ scanned: 5, affected: 3, unaffected: 2 })

    // …then the OLDER one arrives late and must be dropped.
    await hook.settle(0, read(1))
    const after = hook.result.current.preview
    expect(after.kind).toBe('ready')
    expect(after.kind === 'ready' && after.preview.counts.affected).toBe(3)

    // And Apply sends the previewed (newer) plan, exactly once.
    act(() => {
      hook.result.current.applyPreview()
    })
    expect(hook.applied).toHaveLength(1)
    expect([...(hook.applied[0]?.plan.mapping.keys() ?? [])]).toEqual(['SG', 'US'])
    expect(hook.applied[0]?.affected).toBe(3)
    // The surface closed with the publication it just made.
    expect(hook.result.current.open).toBe(false)
    expect(hook.result.current.preview.kind).toBe('idle')
  })

  it('a read that settles after the surface was closed is dropped', async () => {
    const hook = harness()
    authorPlan(hook)
    act(() => {
      hook.result.current.runPreview()
    })
    act(() => {
      hook.result.current.closeDialog()
    })
    await hook.settle(0, read(2))
    expect(hook.result.current.open).toBe(false)
    expect(hook.result.current.preview.kind).toBe('idle')
    act(() => {
      hook.result.current.applyPreview()
    })
    expect(hook.applied).toHaveLength(0)
  })

  it('a failed read reports the framed sentence and is not applicable', async () => {
    const hook = harness()
    authorPlan(hook)
    act(() => {
      hook.result.current.runPreview()
    })
    await hook.fail(0, new Error('Binder Error: no such column'))
    const failed = hook.result.current.preview
    expect(failed.kind).toBe('failed')
    expect(failed.kind === 'failed' && failed.message).toBe(
      'The repair preview could not be read: Binder Error: no such column. Nothing was applied.',
    )
    act(() => {
      hook.result.current.applyPreview()
    })
    expect(hook.applied).toHaveLength(0)
    expect(hook.result.current.message).toBe(
      'Preview this plan before applying it — nothing was applied.',
    )
  })
})

describe('useRepairPreview — the Apply gate', () => {
  it('refuses a stale preview at render and at apply (U2 render half)', async () => {
    const hook = harness()
    authorPlan(hook)
    act(() => {
      hook.result.current.runPreview()
    })
    await hook.settle(0, read(2))
    expect(hook.result.current.previewStale).toBe(false)
    expect(hook.result.current.canApply).toBe(true)

    // Someone edited/undid something: the tag no longer describes the session.
    // A real session change always lands with a state change, so the test
    // re-renders exactly as React would.
    act(() => {
      hook.drift()
    })
    act(() => {
      hook.rerender()
    })
    expect(hook.result.current.previewStale).toBe(true)
    expect(hook.result.current.canApply).toBe(false)
    expect(hook.result.current.applyBlockedReason).toBe(
      'This preview is out of date: an edit, an undo or a different file version landed after it was read. Preview again before applying — nothing was applied.',
    )
    act(() => {
      hook.result.current.applyPreview()
    })
    expect(hook.applied).toHaveLength(0)
    expect(hook.result.current.message).toBe(
      'This preview is out of date: an edit, an undo or a different file version landed after it was read. Preview again before applying — nothing was applied.',
    )
  })

  it('refuses a preview of a plan the draft no longer describes', async () => {
    const hook = harness()
    authorPlan(hook)
    act(() => {
      hook.result.current.runPreview()
    })
    await hook.settle(0, read(2))
    expect(hook.result.current.canApply).toBe(true)

    act(() => {
      hook.result.current.update({ mappingText: 'SG => Singapura' })
    })
    expect(hook.result.current.previewOutdated).toBe(true)
    expect(hook.result.current.canApply).toBe(false)
    act(() => {
      hook.result.current.applyPreview()
    })
    expect(hook.applied).toHaveLength(0)
    expect(hook.result.current.message).toBe(
      'The plan changed after this preview. Preview it again before applying.',
    )
  })

  it('refuses a zero-affected preview (U1 gate) and appends nothing', async () => {
    const hook = harness()
    authorPlan(hook)
    act(() => {
      hook.result.current.runPreview()
    })
    await hook.settle(0, read(0, []))
    expect(hook.result.current.canApply).toBe(false)
    expect(hook.result.current.applyBlockedReason).toBe(
      'No row changes under this plan, so nothing was applied and the history is unchanged.',
    )
    act(() => {
      hook.result.current.applyPreview()
    })
    expect(hook.applied).toHaveLength(0)
  })
})

describe.skipIf(!hasDuckDbCli)('useRepairPreview — U1 on the real predicate', () => {
  it('a trim/mapping cancellation previews as zero affected and refuses Apply', async () => {
    const hook = harness()
    act(() => {
      hook.result.current.openDialog()
    })
    act(() => {
      hook.result.current.update({
        column: 'country',
        trimMode: 'custom',
        customTrim: ' ',
        mappingText: 'a =>  a ',
      })
    })
    // The draft is the reviewer's cancellation plan…
    expect(hook.result.current.pairCount).toBe(1)
    expect(hook.result.current.refusal).toBeNull()

    // …and the count the SURFACE receives comes from the production predicate
    // run by the real engine. With the fix-round-1 defect this is 1 (the ` a `
    // row over-counted) and the assertions below fail exactly as the reviewer
    // saw them in the browser: Apply offered for a plan that changes nothing.
    const affected = affectedByRealEngine(CANCELLATION_PLAN, CANCELLATION_ROWS)

    act(() => {
      hook.result.current.runPreview()
    })
    await hook.settle(0, {
      scanned: CANCELLATION_ROWS.length,
      affected,
      exampleCap: 10,
      exampleRows: [],
    })

    expect(hook.result.current.canApply).toBe(false)
    expect(hook.result.current.applyBlockedReason).toBe(
      'No row changes under this plan, so nothing was applied and the history is unchanged.',
    )
    act(() => {
      hook.result.current.applyPreview()
    })
    expect(hook.applied).toHaveLength(0)
    // Root cause last, so a regression fails FIRST on the symptom the reviewer
    // saw in the browser (`applyEnabled=true`, an applyable no-op plan) and then
    // on the count itself.
    expect(affected).toBe(0)
  })
})
