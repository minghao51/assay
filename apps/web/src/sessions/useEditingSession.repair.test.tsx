// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { baseRowId, initialState, stateAtCursor } from '@assay/domain'
import type { OverlayBase } from '@assay/domain'
import type { GridViewportModel } from '@assay/grid'
import { hasAppliedChanges } from '../edit/session'
import type { RepairPlan } from '../edit/repair/plan'
import type { RepairApplyGuard } from '../edit/repair/capture'
import { repairAffectedCountSql } from '../edit/repair/preview-sql'
import { useEditingSession } from './useEditingSession'
import type { DatasetSession } from './session-reset'
import type { Phase } from './types'

/**
 * EW-04I — the repair **publication** path in the editing session.
 *
 * These are the session-layer halves of the row's named host conditions, run
 * against the real history/fold/commit code with only the engine client faked:
 *
 * - **U1** — a zero-affected plan is refused and appends **nothing** (no no-op
 *   entry, no extra undo step). This is the check that bites the reviewer's
 *   "append a zero-affected plan" drill: the surface's disabled Apply is not
 *   what is being tested here.
 * - **U2** — a preview taken before a session change is refused end-to-end at
 *   the commit boundary, with no entry appended.
 * - **D7** — the identical plan already applied at the cursor is refused by
 *   plan identity.
 * - **One entry, one undo step, undo by exact refold** (ADR 0050): one Apply is
 *   one history entry carrying `inverse: []` + the `'undo-by-refold'` note, one
 *   undo removes its effect from the folded state, and redo restores it.
 */

vi.mock('../lib/engine', () => ({
  engineClient: {
    // The repair publication path never checks a cast; the mock only has to
    // exist so the module graph loads.
    overlayCastCheck: async () => ({ hasNonConvertibleValues: false }),
    query: async () => ({ batch: { numRows: 0, numCols: 0, getChildAt: () => null } }),
    fetchOverlayRange: async () => ({
      batch: { numRows: 0, numCols: 0, getChildAt: () => null },
      hasMore: false,
    }),
    exportView: async () => ({ path: 'p', format: 'csv', rowCount: 0, bytes: 0 }),
  },
}))

const BASE: OverlayBase = {
  baseAnchor: 'fv-2-1000',
  overlayAnchor: 'ov-1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'country', type: 'VARCHAR' },
  ],
  baseRowCount: 5,
}

const PLAN: RepairPlan = {
  column: 'country',
  trim: ' ',
  mapping: new Map([['SG', 'Singapore']]),
}

/**
 * EW-04I fix round 1 — U1 for the trim/mapping **cancellation** class, measured
 * by the real predicate.
 *
 * `trim = ' '` with `M = {a → ' a '}` maps a trimmed value straight back, so
 * `' a '` is unchanged and the preview's complete count is **0**. The count here
 * is produced by the production composition (`repairAffectedCountSql`) executed
 * by the pinned DuckDB CLI: with the fix-round-1 defect it is 1, `affected: 1`
 * reaches `handleApplyRepair`, and a no-op repair entry is appended — which is
 * exactly what the assertions below refuse. Without the CLI the case skips
 * (the repository's convention for CLI-backed pins) rather than passing
 * vacuously.
 */
const DUCKDB_CLI = process.env['DUCKDB'] ?? '/tmp/duckdb'
const hasDuckDbCli = existsSync(DUCKDB_CLI)

const CANCELLATION_PLAN: RepairPlan = {
  column: 'country',
  trim: ' ',
  mapping: new Map([['a', ' a ']]),
}

const CANCELLATION_ROWS: readonly string[] = [' a ', 'SG', 'US', 'DE', 'US']

/** The rows the real predicate counts as affected for `plan` over `ROWS`. */
function affectedByRealEngine(plan: RepairPlan, rows: readonly string[]): number {
  const base: OverlayBase = { ...BASE, baseRowCount: rows.length }
  const values = rows
    .map((row, index) => `(${String(index)}, '${row.replaceAll("'", "''")}')`)
    .join(', ')
  const script =
    'CREATE TABLE assay_t1 (id INTEGER, country VARCHAR);' +
    `INSERT INTO assay_t1 VALUES ${values};` +
    `SELECT 'affected', affected FROM (${repairAffectedCountSql(
      { viewName: 'assay_t1', base, state: initialState(base) },
      plan,
    )});`
  const stdout = execFileSync(DUCKDB_CLI, ['-noheader', '-list', '-c', script], {
    encoding: 'utf8',
    stdio: 'pipe',
  })
  const line = stdout.trim().split(/\r?\n/).pop() ?? ''
  return Number(line.slice(line.indexOf('|') + 1))
}

function readyPhase(): Phase {
  const model = {
    refresh: async (): Promise<void> => undefined,
    schema: BASE.columns,
    totalRows: 5,
  }
  return {
    kind: 'ready',
    model: model as unknown as GridViewportModel,
    tableId: 't1',
    handle: { kind: 'table', id: 't1' },
    base: BASE,
    provider: {} as never,
  }
}

const SESSION: DatasetSession = {
  tokenRef: { current: 1 },
  beginSession: () => ({ token: 1, faults: [] }),
  registerReset: () => () => {},
}

function mount(): ReturnType<typeof renderHook<ReturnType<typeof useEditingSession>, unknown>> {
  return renderHook(() => useEditingSession(readyPhase(), SESSION, { current: null }))
}

/** Let the serialized mutation chain drain (it awaits refresh() per commit). */
async function drain(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  })
}

/** A guard built from the live capture tag, as the surface would. */
function guardFor(hook: ReturnType<typeof mount>, affected: number): RepairApplyGuard {
  const tag = hook.result.current.captureRepairTag(PLAN.column)
  if (tag === null) throw new Error('fixture column is missing from the schema')
  return { tag, affected }
}

describe('handleApplyRepair — U1: a zero-affected plan appends nothing', () => {
  it('refuses and leaves the history exactly as it was', async () => {
    const hook = mount()
    const before = hook.result.current.history
    expect(before.entries).toHaveLength(0)

    act(() => {
      hook.result.current.handleApplyRepair(PLAN, guardFor(hook, 0))
    })
    await drain()

    expect(hook.result.current.history.entries).toHaveLength(0)
    expect(hook.result.current.history).toBe(before)
    expect(hook.result.current.editError).toBe(
      'No row changes under this plan, so nothing was applied and the history is unchanged.',
    )
    // No effect anywhere: the folded state carries no repair.
    expect(stateAtCursor(BASE, hook.result.current.history).repairs).toHaveLength(0)
    expect(hasAppliedChanges(hook.result.current.history)).toBe(false)
  })
})

describe('handleApplyRepair — U2: a stale preview is refused end-to-end', () => {
  it('refuses at the commit boundary after the session changed, appending nothing', async () => {
    const hook = mount()
    const staleGuard = guardFor(hook, 2)

    // A change lands AFTER the preview was captured (a cell edit here; any
    // history activation — undo, redo, cursor move, rename, cast — is the same
    // class, and a dataset replacement is refused by the queued-task token).
    act(() => {
      hook.result.current.handleCommitCell(baseRowId(BASE.baseAnchor, 0), 'country', {
        kind: 'string',
        value: 'SG',
      })
    })
    await drain()
    expect(hook.result.current.history.entries).toHaveLength(1)
    const afterEdit = hook.result.current.history

    act(() => {
      hook.result.current.handleApplyRepair(PLAN, staleGuard)
    })
    await drain()

    // Still exactly the cell edit: no repair entry was appended.
    expect(hook.result.current.history.entries).toBe(afterEdit.entries)
    expect(hook.result.current.history).toBe(afterEdit)
    expect(hook.result.current.editError).toBe(
      'This preview is out of date: an edit, an undo or a different file version landed after it was read. Preview again before applying — nothing was applied.',
    )
    expect(stateAtCursor(BASE, hook.result.current.history).repairs).toHaveLength(0)
  })
})

describe('handleApplyRepair — one entry, one undo step, undo by exact refold (ADR 0050)', () => {
  it('appends one repair entry with an empty inverse and the refold note', async () => {
    const hook = mount()
    act(() => {
      hook.result.current.handleApplyRepair(PLAN, guardFor(hook, 2))
    })
    await drain()

    const history = hook.result.current.history
    expect(history.entries).toHaveLength(1)
    const entry = history.entries[0]
    expect(entry?.op.kind).toBe('column-repair')
    // ADR 0050: no materialized inverse; the note is the durable marker.
    expect(entry?.inverse).toEqual([])
    expect(entry?.outcome).toEqual({ status: 'applied', notes: ['undo-by-refold'] })
    expect(history.cursor).toBe(1)
    // Dirty by the adopted WF-06 predicate: an applied outcome is in the prefix.
    expect(hasAppliedChanges(history)).toBe(true)

    // The folded prefix carries exactly one repair record, and undo removes it
    // from the fold because the entry leaves the prefix (not by an inverse).
    expect(stateAtCursor(BASE, history).repairs).toHaveLength(1)
    act(() => {
      hook.result.current.handleUndo()
    })
    await drain()
    expect(hook.result.current.history.cursor).toBe(0)
    expect(stateAtCursor(BASE, hook.result.current.history).repairs).toHaveLength(0)
    expect(hasAppliedChanges(hook.result.current.history)).toBe(false)

    // Redo is the cursor move back: the same prefix folds to the same state.
    act(() => {
      hook.result.current.handleRedo()
    })
    await drain()
    expect(hook.result.current.history.cursor).toBe(1)
    expect(stateAtCursor(BASE, hook.result.current.history).repairs).toHaveLength(1)
    expect(hasAppliedChanges(hook.result.current.history)).toBe(true)
  })

  it('D7: the identical plan is refused by identity once it is applied', async () => {
    const hook = mount()
    act(() => {
      hook.result.current.handleApplyRepair(PLAN, guardFor(hook, 2))
    })
    await drain()
    expect(hook.result.current.history.entries).toHaveLength(1)

    // A fresh preview of the same plan would be re-captured under a NEW tag,
    // so the identity rule is what refuses this (not staleness).
    act(() => {
      hook.result.current.handleApplyRepair(PLAN, guardFor(hook, 2))
    })
    await drain()
    expect(hook.result.current.history.entries).toHaveLength(1)
    expect(hook.result.current.editError).toBe(
      'This exact plan is already applied at this point in the history, so nothing was applied. One undo removes the repair that is there.',
    )

    // A *different* plan on the same column is not the same identity, and a
    // truncated/undone repair can be applied again.
    act(() => {
      hook.result.current.handleUndo()
    })
    await drain()
    act(() => {
      hook.result.current.handleApplyRepair(PLAN, guardFor(hook, 2))
    })
    await drain()
    expect(hook.result.current.history.entries).toHaveLength(1)
    expect(hook.result.current.editError).toBeNull()
  })
})

describe('captureRepairTag — the session-side seam', () => {
  it('reflects the live history position and revision', async () => {
    const hook = mount()
    const first = hook.result.current.captureRepairTag('country')
    expect(first).not.toBeNull()
    expect(first?.cursor).toBe(0)

    act(() => {
      hook.result.current.handleCommitCell(baseRowId(BASE.baseAnchor, 0), 'country', {
        kind: 'string',
        value: 'SG',
      })
    })
    await drain()
    const second = hook.result.current.captureRepairTag('country')
    expect(second?.cursor).toBe(1)
    expect(second?.historyRevision).toBeGreaterThan(first?.historyRevision ?? 0)
    // An unknown column has no tag at all.
    expect(hook.result.current.captureRepairTag('nope')).toBeNull()
  })
})

describe.skipIf(!hasDuckDbCli)('handleApplyRepair — U1 on the real predicate', () => {
  it('a trim/mapping cancellation refuses at the commit boundary and appends nothing', async () => {
    const hook = mount()
    const before = hook.result.current.history

    // The complete count the SURFACE would show, from the production predicate
    // run by the real engine. With the fix-round-1 defect this is 1 and a no-op
    // entry is appended below — the failure the reviewer saw as "Step 2 of 2".
    const affected = affectedByRealEngine(CANCELLATION_PLAN, CANCELLATION_ROWS)

    act(() => {
      hook.result.current.handleApplyRepair(CANCELLATION_PLAN, {
        tag: guardFor(hook, affected).tag,
        affected,
      })
    })
    await drain()

    // Nothing appended, no effect anywhere: the history is the same object.
    expect(hook.result.current.history).toBe(before)
    expect(hook.result.current.history.entries).toHaveLength(0)
    expect(stateAtCursor(BASE, hook.result.current.history).repairs).toHaveLength(0)
    expect(hasAppliedChanges(hook.result.current.history)).toBe(false)
    expect(hook.result.current.editError).toBe(
      'No row changes under this plan, so nothing was applied and the history is unchanged.',
    )
    // Root cause last, so a regression fails FIRST on the symptom the reviewer
    // saw (`Step 2 of 2`: a no-op entry appended) and then on the count.
    expect(affected).toBe(0)
  })
})
