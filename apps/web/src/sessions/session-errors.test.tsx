// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseContract } from '@assay/contracts'
import { baseRowId, emptyHistory } from '@assay/domain'
import type { EngineComparisonHandle, EngineDatasetProfile } from '@assay/engine-duckdb'
import type { GridViewportModel } from '@assay/grid'
import type { OverlayBase, TransformationHistory } from '@assay/domain'
import { useDiffSession } from './useDiffSession'
import { useEditingSession } from './useEditingSession'
import { useValidationSession } from './useValidationSession'
import type { DatasetSession } from './session-reset'
import type { Phase } from './types'

/**
 * UG-25 / UG-30 call-site pins for the read-only sessions.
 *
 * `engineRejectionMessage` says "The engine rejected this **edit**…" — copy
 * that is honest for the editing session and nonsense in Validation/Compare
 * (the m5-3/m6-4 panels reused it, producing "Validation failed: The engine
 * rejected this edit…"). These tests drive the REAL hooks with only the engine
 * boundary faked and pin the framed, single-line, edit-free message each
 * session hands its panel.
 */

const h = vi.hoisted(() => ({
  validate: vi.fn(),
  stageComparison: vi.fn(),
  open: vi.fn(),
  profile: vi.fn(),
  diff: vi.fn(),
  overlayCastCheck: vi.fn(),
  exportView: vi.fn(),
}))

vi.mock('../lib/engine', () => ({
  engineClient: {
    validate: h.validate,
    stageComparison: h.stageComparison,
    open: h.open,
    profile: h.profile,
    diff: h.diff,
    overlayCastCheck: h.overlayCastCheck,
    exportView: h.exportView,
  },
}))

/** A realistic multi-line engine diagnostic (summary + composed SQL tail). */
const MULTILINE = new Error(
  'the validation row-key query failed to execute\n' +
    'LINE 1: SELECT * FROM "assay_validation_target" WHERE "country" = \'SG\'',
)

const BASE: OverlayBase = {
  baseAnchor: 'fv-2-1000',
  overlayAnchor: 'ov-1',
  columns: [{ name: 'id', type: 'BIGINT' }],
  baseRowCount: 2,
}

const PHASE: Phase = {
  kind: 'ready',
  model: {} as unknown as GridViewportModel,
  tableId: 't1',
  handle: { kind: 'table', id: 't1' },
  base: BASE,
  provider: {} as never,
}

const SESSION: DatasetSession = {
  tokenRef: { current: 1 },
  beginSession: () => ({ token: 1, faults: [] }),
  registerReset: () => () => {},
}

const HISTORY_REF: { current: TransformationHistory } = { current: emptyHistory() }

/** The committed-shape native contract (dataset.min-rows needs no column). */
const CONTRACT = parseContract(
  'format: v1\nname: session-pin\nversion: 1\ndataset:\n  min-rows: 1\n',
)
if (!CONTRACT.ok) throw new Error('the session-pin contract fixture must parse')

const PROFILE: EngineDatasetProfile = {
  rowCount: 2,
  columns: [
    {
      name: 'id',
      type: 'BIGINT',
      kind: 'numeric',
      nullCount: 0,
      distinctCount: 2,
    },
  ],
}

const COMPARISON: EngineComparisonHandle = {
  kind: 'comparison',
  id: 'c1',
  schema: [{ name: 'id', type: 'BIGINT' }],
}

afterEach(() => {
  vi.clearAllMocks()
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('UG-25 — validation session error copy', () => {
  it('frames a failed validation run without the edit-domain wording', async () => {
    h.validate.mockRejectedValue(MULTILINE)
    const { result } = renderHook(() =>
      useValidationSession({
        phase: PHASE,
        session: SESSION,
        historyRef: HISTORY_REF,
        overlayRef: { current: null },
        overlayRevision: 0,
        sourceIdentityRef: { current: null },
        navigateToRow: () => {},
      }),
    )

    act(() => {
      result.current.handleContractDocument(CONTRACT.contract)
    })
    act(() => {
      result.current.handleValidate()
    })

    await waitFor(() => {
      expect(result.current.validationRun.kind).toBe('failed')
    })
    const run = result.current.validationRun
    if (run.kind !== 'failed') throw new Error('expected a failed validation run')
    expect(run.message).toBe(
      'the validation row-key query failed to execute. The previous validation view is unchanged.',
    )
    expect(run.message).not.toContain('edit')
    expect(run.message).not.toMatch(/\r|\n/)
    expect(run.message).not.toContain('LINE 1')
  })
})

describe('UG-25 — diff session error copy', () => {
  function renderDiff() {
    return renderHook(() =>
      useDiffSession({
        phase: PHASE,
        session: SESSION,
        historyRef: HISTORY_REF,
        overlayRef: { current: null },
        overlayRevision: 0,
        sourceIdentityRef: { current: null },
        navigateToRow: () => {},
      }),
    )
  }

  it('frames a failed comparison staging without the edit-domain wording', async () => {
    h.stageComparison.mockRejectedValue(MULTILINE)
    const { result } = renderDiff()

    act(() => {
      result.current.handleComparisonFile(new File(['id\n1\n'], 'comparison.csv'))
    })

    await waitFor(() => {
      expect(result.current.comparisonState.kind).toBe('failed')
    })
    const staging = result.current.comparisonState
    if (staging.kind !== 'failed') throw new Error('expected a failed comparison stage')
    expect(staging.message).toBe(
      'the validation row-key query failed to execute. The previous comparison view is unchanged.',
    )
    expect(staging.message).not.toContain('edit')
    expect(staging.message).not.toMatch(/\r|\n/)
  })

  it('frames a failed row diff without the edit-domain wording', async () => {
    h.stageComparison.mockResolvedValue(COMPARISON)
    h.open.mockResolvedValue({ kind: 'table', id: 't2' })
    h.profile.mockResolvedValue(PROFILE)
    h.diff.mockRejectedValue(MULTILINE)
    const { result } = renderDiff()

    act(() => {
      result.current.handleComparisonFile(new File(['id\n1\n'], 'comparison.csv'))
    })
    await waitFor(() => {
      expect(result.current.comparisonState.kind).toBe('staged')
    })

    act(() => {
      result.current.handleRunDiff(['id'], 'explicit', null)
    })

    await waitFor(() => {
      expect(result.current.diffRun.kind).toBe('failed')
    })
    const run = result.current.diffRun
    if (run.kind !== 'failed') throw new Error('expected a failed row diff')
    expect(run.message).toBe(
      'the validation row-key query failed to execute. The previous comparison view is unchanged.',
    )
    expect(run.message).not.toContain('edit')
    expect(run.message).not.toMatch(/\r|\n/)
  })
})

/**
 * R1-C — the pre-commit cell-edit value check.
 *
 * The commit's `refresh()` only reads metadata, so a value the column's type
 * cannot convert used to commit and surface later as retryable `!` cells with
 * no message. These tests drive the REAL editing hook (only the engine boundary
 * is faked) and pin the behaviours below, one per `it`:
 *
 * 1. the refusal happens before anything is activated — no refresh, empty
 *    history, existing value-free wording;
 * 2. a convertible value still commits and re-materializes once;
 * 3. a dataset replacement drops a check that *resolves* — no edit error;
 * 4. a dataset replacement drops a check that *rejects* — no stale edit error,
 *    while a rejection without a replacement is still framed (next item);
 * 5. a failing check without a replacement is framed with the existing wording
 *    and appends nothing (a genuine engine failure is never swallowed);
 * 6. three overlapping hostile edits are refused one verdict at a time (the
 *    mutation chain), staging nothing and refreshing nothing;
 * 7. two overlapping valid edits land in order (no lost edit);
 * 8. an undo issued during an in-flight check waits for it instead of racing
 *    it;
 * 9. a cast whose verdict went stale while its append waited in the chain is
 *    refused with the existing raced-cast copy;
 * 10. `row-insert` is deliberately uncovered (v1 inserts carry empty values), so
 *    the insert path asks no value question — its later cell-sets are checked
 *    like any other edit.
 *
 * A same-table commit can no longer land mid-check (the chain serializes every
 * activation), so there is deliberately no re-derive/re-check pin here.
 */
describe('R1-C — the pre-commit cell value check (useEditingSession)', () => {
  const EDIT_BASE: OverlayBase = {
    baseAnchor: 'fv-2-1000',
    overlayAnchor: 'ov-1',
    columns: [
      { name: 'id', type: 'BIGINT' },
      { name: 'label', type: 'VARCHAR' },
      { name: 'd', type: 'DATE' },
    ],
    baseRowCount: 2,
  }

  const HOSTILE_DATE = "not-a-date'; DROP TABLE x --"

  interface Deferred<T> {
    readonly promise: Promise<T>
    readonly resolve: (value: T) => void
    readonly reject: (error: unknown) => void
  }

  function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  /** Mount the real editing hook over a fake engine boundary. */
  function mountEditing(session: DatasetSession = SESSION): {
    readonly result: { current: ReturnType<typeof useEditingSession> }
    readonly refreshes: () => number
  } {
    const refresh = vi.fn(async () => {})
    const phase: Phase = {
      kind: 'ready',
      model: { refresh } as unknown as GridViewportModel,
      tableId: 't1',
      handle: { kind: 'table', id: 't1' },
      base: EDIT_BASE,
      provider: {} as never,
    }
    const hook = renderHook(() => useEditingSession(phase, session, { current: null }))
    return { result: hook.result, refreshes: () => refresh.mock.calls.length }
  }

  beforeEach(() => {
    h.overlayCastCheck.mockReset()
  })

  it('refuses a value the column type cannot convert before anything is activated', async () => {
    h.overlayCastCheck.mockResolvedValue({ hasNonConvertibleValues: true })
    const { result, refreshes } = mountEditing()

    act(() => {
      result.current.handleCommitCell(baseRowId(EDIT_BASE.baseAnchor, 0), 'd', {
        kind: 'text',
        text: HOSTILE_DATE,
      })
    })

    await waitFor(() => {
      expect(result.current.editError).not.toBeNull()
    })
    // The EXISTING refusal framing, and value-free: the hostile draft never
    // reaches the alert (ADR 0025).
    expect(result.current.editError).toBe(
      "The engine rejected this edit: the column's type rejected the value. " +
        'The previous view is unchanged.',
    )
    expect(result.current.editError).not.toContain('not-a-date')
    // Refused, nothing applied: no activation, no re-materialization, no
    // rollback, and the history is still empty (so no undo step appears).
    expect(result.current.history.entries).toHaveLength(0)
    expect(result.current.overlayRef.current).toBeNull()
    expect(refreshes()).toBe(0)
    expect(result.current.viewError).toBe(false)
    // q-3: the polite live region carries the same value-free text.
    expect(result.current.editAnnouncement?.text).toBe(result.current.editError)

    // The check asked the engine about the edited column's OWN effective type,
    // over the prospective overlay (the staged op is already in it).
    const call = h.overlayCastCheck.mock.calls[0]
    if (call === undefined) throw new Error('the value check was never asked')
    expect(call[2]).toEqual({ column: 'd', targetType: 'DATE' })
    const overlay = call[1] as { readonly ops?: readonly unknown[] }
    expect(overlay.ops).toHaveLength(1)
  })

  it('commits and re-materializes normally when the value converts', async () => {
    h.overlayCastCheck.mockResolvedValue({ hasNonConvertibleValues: false })
    const { result, refreshes } = mountEditing()

    act(() => {
      result.current.handleCommitCell(baseRowId(EDIT_BASE.baseAnchor, 0), 'd', {
        kind: 'text',
        text: '2024-05-06',
      })
    })

    await waitFor(() => {
      expect(result.current.history.entries).toHaveLength(1)
    })
    await waitFor(() => {
      expect(refreshes()).toBe(1)
    })
    expect(h.overlayCastCheck).toHaveBeenCalledTimes(1)
    expect(result.current.editError).toBeNull()
    expect(result.current.editAnnouncement?.text).toBe('Edit committed.')
    expect(result.current.overlayRef.current?.ops).toHaveLength(1)
  })

  it('drops a check invalidated by a table replacement without a stale edit error', async () => {
    const held = deferred<{ readonly hasNonConvertibleValues: boolean }>()
    h.overlayCastCheck.mockReturnValue(held.promise)
    const session: DatasetSession = {
      tokenRef: { current: 1 },
      beginSession: () => ({ token: 2, faults: [] }),
      registerReset: () => () => {},
    }
    const { result, refreshes } = mountEditing(session)

    act(() => {
      result.current.handleCommitCell(baseRowId(EDIT_BASE.baseAnchor, 0), 'd', {
        kind: 'text',
        text: '2024-05-06',
      })
    })
    await waitFor(() => {
      expect(result.current.mutationStateRef.current).toBe(1)
    })

    // The table is replaced while the check is in flight (beginSession bumps
    // the token before the reset runs).
    session.tokenRef.current = 2
    await act(async () => {
      held.resolve({ hasNonConvertibleValues: false })
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(result.current.mutationStateRef.current).toBe(0)
    })

    // Nothing was activated and no stale edit error was surfaced.
    expect(result.current.history.entries).toHaveLength(0)
    expect(result.current.overlayRef.current).toBeNull()
    expect(refreshes()).toBe(0)
    expect(result.current.editError).toBeNull()
    expect(result.current.editAnnouncement).toBeNull()
  })

  it('drops a check that REJECTS after a table replacement, without a stale edit error', async () => {
    // The reject-path sibling of the test above: the staleness rule must hold for
    // both outcomes. A rejection that arrives after the dataset was replaced
    // describes a table that no longer exists, so it is dropped exactly like a
    // resolved verdict — nothing activated, nothing refreshed, and no edit error
    // about a table that is already gone (a rejection *without* a replacement is
    // still framed; see "frames a failing check with the existing wording").
    const held = deferred<{ readonly hasNonConvertibleValues: boolean }>()
    h.overlayCastCheck.mockReturnValue(held.promise)
    const session: DatasetSession = {
      tokenRef: { current: 1 },
      beginSession: () => ({ token: 2, faults: [] }),
      registerReset: () => () => {},
    }
    const { result, refreshes } = mountEditing(session)

    act(() => {
      result.current.handleCommitCell(baseRowId(EDIT_BASE.baseAnchor, 0), 'd', {
        kind: 'text',
        text: '2024-05-06',
      })
    })
    await waitFor(() => {
      expect(result.current.mutationStateRef.current).toBe(1)
    })

    // The table is replaced while the check is in flight (beginSession bumps the
    // token before the reset runs), and the engine then rejects the doomed
    // request because its table has disappeared.
    session.tokenRef.current = 2
    await act(async () => {
      held.reject(new Error('Table with name assay_t1 has disappeared'))
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(result.current.mutationStateRef.current).toBe(0)
    })

    // Nothing was activated or refreshed, and the stale rejection never reached
    // the alert or the live region.
    expect(result.current.history.entries).toHaveLength(0)
    expect(result.current.overlayRef.current).toBeNull()
    expect(refreshes()).toBe(0)
    expect(result.current.editError).toBeNull()
    expect(result.current.editAnnouncement).toBeNull()
  })

  it('refuses a burst of three overlapping hostile edits: nothing staged, nothing refreshed', async () => {
    // The reviewer's probe shape: three `cell-set` gestures issued inside one
    // engine round-trip. The mutation chain serializes them, so only ONE verdict
    // is ever in flight — the second edit's check cannot even be asked until the
    // first refusal has settled. That is what removes the "invalidated verdict"
    // window (and with it the old bounded retry and its unchecked fallback).
    const held: Array<(verdict: { readonly hasNonConvertibleValues: boolean }) => void> = []
    h.overlayCastCheck.mockImplementation(
      () =>
        new Promise((resolve) => {
          held.push(resolve)
        }),
    )
    const { result, refreshes } = mountEditing()

    act(() => {
      result.current.handleCommitCell(baseRowId(EDIT_BASE.baseAnchor, 0), 'd', {
        kind: 'text',
        text: 'HOSTILE-one',
      })
      result.current.handleCommitCell(baseRowId(EDIT_BASE.baseAnchor, 0), 'label', {
        kind: 'string',
        value: 'HOSTILE-two',
      })
      result.current.handleCommitCell(baseRowId(EDIT_BASE.baseAnchor, 1), 'd', {
        kind: 'text',
        text: 'HOSTILE-three',
      })
    })

    // Serialization: exactly one value check is in flight, in gesture order.
    await waitFor(() => {
      expect(held).toHaveLength(1)
    })
    expect(h.overlayCastCheck.mock.calls[0]?.[2]).toEqual({ column: 'd', targetType: 'DATE' })

    // Each refusal releases the next edit's check — one at a time, FIFO.
    await act(async () => {
      held[0]?.({ hasNonConvertibleValues: true })
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(held).toHaveLength(2)
    })
    expect(h.overlayCastCheck.mock.calls[1]?.[2]).toEqual({
      column: 'label',
      targetType: 'VARCHAR',
    })
    await act(async () => {
      held[1]?.({ hasNonConvertibleValues: true })
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(held).toHaveLength(3)
    })
    await act(async () => {
      held[2]?.({ hasNonConvertibleValues: true })
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(result.current.mutationStateRef.current).toBe(0)
    })

    // Every verdict was a refusal: nothing was activated, nothing was refreshed,
    // and the hostile values never reached the history or the alert.
    expect(h.overlayCastCheck).toHaveBeenCalledTimes(3)
    expect(result.current.history.entries).toHaveLength(0)
    expect(result.current.overlayRef.current).toBeNull()
    expect(refreshes()).toBe(0)
    expect(result.current.editError).toBe(
      "The engine rejected this edit: the column's type rejected the value. " +
        'The previous view is unchanged.',
    )
    expect(result.current.editError).not.toContain('HOSTILE')
    expect(JSON.stringify(result.current.history)).not.toContain('HOSTILE')
    expect(JSON.stringify(result.current.overlayRef.current)).not.toContain('HOSTILE')
  })

  it('lands two overlapping valid edits in order (the chain composes, no lost edit)', async () => {
    h.overlayCastCheck.mockResolvedValue({ hasNonConvertibleValues: false })
    const { result, refreshes } = mountEditing()

    act(() => {
      result.current.handleCommitCell(baseRowId(EDIT_BASE.baseAnchor, 0), 'label', {
        kind: 'string',
        value: 'one',
      })
      result.current.handleCommitCell(baseRowId(EDIT_BASE.baseAnchor, 1), 'label', {
        kind: 'string',
        value: 'two',
      })
    })

    await waitFor(() => {
      expect(result.current.history.entries).toHaveLength(2)
    })
    await waitFor(() => {
      expect(refreshes()).toBe(2)
    })
    // In gesture order, and the second edit was appended to the first's history
    // (each task reads `historyRef.current` when it runs).
    expect(
      result.current.history.entries.map((entry) =>
        entry.op.kind === 'cell-set' && entry.op.value.kind === 'string'
          ? entry.op.value.value
          : null,
      ),
    ).toEqual(['one', 'two'])
    expect(result.current.overlayRef.current?.ops).toHaveLength(2)
    expect(result.current.editError).toBeNull()
  })

  it('makes a non-cell mutation wait for an in-flight value check instead of racing it', async () => {
    const held = deferred<{ readonly hasNonConvertibleValues: boolean }>()
    h.overlayCastCheck.mockReturnValue(held.promise)
    const { result, refreshes } = mountEditing()

    act(() => {
      result.current.handleCommitCell(baseRowId(EDIT_BASE.baseAnchor, 0), 'label', {
        kind: 'string',
        value: 'one',
      })
      // Issued while the cell's value check is in flight: the undo must not
      // bypass or invalidate that check — it waits its turn in the chain.
      result.current.handleUndo()
    })
    await waitFor(() => {
      expect(h.overlayCastCheck).toHaveBeenCalledTimes(1)
    })
    // Nothing has activated and nothing has been undone behind the check's back.
    expect(result.current.history.entries).toHaveLength(0)
    expect(result.current.history.cursor).toBe(0)
    expect(refreshes()).toBe(0)

    await act(async () => {
      held.resolve({ hasNonConvertibleValues: false })
      await Promise.resolve()
    })
    // The edit commits first ...
    await waitFor(() => {
      expect(result.current.history.entries).toHaveLength(1)
    })
    // ... and only then does the queued undo run, landing the cursor back at 0.
    await waitFor(() => {
      expect(result.current.history.cursor).toBe(0)
    })
    expect(result.current.mutationStateRef.current).toBe(0)
    expect(refreshes()).toBe(2)
  })

  it('refuses a cast whose verdict went stale while its append waited in the chain', async () => {
    // The cast flow asks its question outside the chain (its contract is to
    // re-run on a same-table change, pinned by `App.column-ops`), so its append
    // can be queued behind a commit that is still in flight. When that commit
    // activates, the verdict the cast enqueued no longer describes the view, and
    // the queued task refuses with the existing raced-cast copy instead of
    // appending it unchecked.
    const heldCellCheck = deferred<{ readonly hasNonConvertibleValues: boolean }>()
    h.overlayCastCheck
      .mockReturnValueOnce(heldCellCheck.promise)
      .mockResolvedValue({ hasNonConvertibleValues: false })
    const { result, refreshes } = mountEditing()

    act(() => {
      result.current.handleCommitCell(baseRowId(EDIT_BASE.baseAnchor, 0), 'label', {
        kind: 'string',
        value: 'one',
      })
    })
    // The cell edit is inside its value check, so nothing is activated yet.
    await waitFor(() => {
      expect(h.overlayCastCheck).toHaveBeenCalledTimes(1)
    })
    expect(result.current.history.entries).toHaveLength(0)

    // The cast check runs concurrently (second question) and its append is
    // queued behind the cell commit, tagged with the revision it verified.
    act(() => {
      result.current.handleCastColumn('label', 'VARCHAR')
    })
    await waitFor(() => {
      expect(h.overlayCastCheck).toHaveBeenCalledTimes(2)
    })
    expect(result.current.history.entries).toHaveLength(0)

    // The cell edit now commits and activates, moving the revision the cast
    // verified; its queued append must refuse rather than append.
    await act(async () => {
      heldCellCheck.resolve({ hasNonConvertibleValues: false })
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(result.current.editError).not.toBeNull()
    })
    expect(result.current.editError).toContain('the view changed while the cast was being checked')
    expect(result.current.editError).toContain('No cast was applied')
    expect(refreshes()).toBe(1)
    expect(result.current.history.entries).toHaveLength(1)
    expect(result.current.history.entries[0]?.op.kind).toBe('cell-set')
  })

  it('frames a failing check with the existing wording and appends nothing', async () => {
    h.overlayCastCheck.mockRejectedValue(
      new Error(
        'Binder Error: Referenced column "d" not found in FROM clause!\n' +
          'LINE 1: SELECT TRY_CAST("d" AS DATE) FROM "assay_t1"',
      ),
    )
    const { result, refreshes } = mountEditing()

    act(() => {
      result.current.handleCommitCell(baseRowId(EDIT_BASE.baseAnchor, 0), 'd', {
        kind: 'text',
        text: '2024-05-06',
      })
    })

    await waitFor(() => {
      expect(result.current.editError).not.toBeNull()
    })
    expect(result.current.editError).toBe(
      'The engine rejected this edit: Binder Error: Referenced column "d" not found in FROM clause!. ' +
        'The previous view is unchanged.',
    )
    expect(result.current.editError).not.toContain('LINE 1')
    expect(result.current.history.entries).toHaveLength(0)
    expect(result.current.overlayRef.current).toBeNull()
    expect(refreshes()).toBe(0)
  })

  it('leaves row-insert uncovered (v1 inserts carry no values)', async () => {
    const { result, refreshes } = mountEditing()

    act(() => {
      result.current.handleInsertRow()
    })

    await waitFor(() => {
      expect(result.current.history.entries).toHaveLength(1)
    })
    expect(h.overlayCastCheck).not.toHaveBeenCalled()
    expect(refreshes()).toBe(1)
  })
})

/**
 * C03b — an `unknown` activation outcome must reach the EXISTING retry
 * affordance (`viewError`/`view-retry`), never a success claim and never a
 * dead end. The commit here fails both refreshes, which is the double-failure
 * class the host already renders a retry for; `retryView()` then clears it once
 * the view materializes.
 */
describe('C03b — an unknown commit activation exposes the view retry', () => {
  it('sets viewError for an unknown outcome and retryView clears it when the view reloads', async () => {
    h.overlayCastCheck.mockResolvedValue({ hasNonConvertibleValues: false })
    let engineDown = true
    const refresh = vi.fn(async () => {
      if (engineDown) throw new Error('engine unavailable')
    })
    const phase: Phase = {
      kind: 'ready',
      model: { refresh } as unknown as GridViewportModel,
      tableId: 't1',
      handle: { kind: 'table', id: 't1' },
      base: BASE,
      provider: {} as never,
    }
    const { result } = renderHook(() => useEditingSession(phase, SESSION, { current: null }))

    act(() => {
      result.current.handleCommitCell(baseRowId(BASE.baseAnchor, 0), 'id', {
        kind: 'text',
        text: '7',
      })
    })

    await waitFor(() => {
      expect(result.current.viewError).toBe(true)
    })
    // The double-failure copy is attributable, and the activation is not claimed
    // as a value rejection nor as a success.
    expect(result.current.editError).toContain('Restoring the previous view also failed')
    expect(result.current.editError).not.toContain('Edit committed')
    expect(result.current.editAnnouncement?.text).toBe(result.current.editError)

    engineDown = false
    await act(async () => {
      await result.current.retryView()
    })
    expect(result.current.viewError).toBe(false)
    expect(result.current.editError).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(3)
  })
})
