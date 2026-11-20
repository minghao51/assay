// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyHistory, insertRowId } from '@assay/domain'
import type { EditOp, HistoryEntry, OverlayBase, TransformationHistory } from '@assay/domain'
import type { GridViewportModel } from '@assay/grid'
import { useDiffSession } from './useDiffSession'
import { useValidationSession } from './useValidationSession'
import type { DatasetSession } from './session-reset'
import type { NavigateToRow, Phase } from './types'

/**
 * ug-12 (UG-26) call-site pins: both sample-list jump handlers hand the shared
 * `NavigateToRow` channel the DOMAIN DISPLAY KEY of the sample's logical row
 * key (`base #2`), never the raw effective row index and never the export form
 * (`base:2`). That label is what the single polite live region announces
 * (`Showing base #2 in the grid and record inspector`), so it must be derived
 * from `displayRowKey(rowKey)` at the handler, not re-invented by the panel or
 * the grid.
 *
 * The hooks are real; only the engine boundary is untouched because a jump
 * resolves against the already-held base/history (no engine call).
 */

const BASE: OverlayBase = {
  baseAnchor: 'fv-2-1000',
  overlayAnchor: 'ov-1',
  columns: [{ name: 'id', type: 'BIGINT' }],
  baseRowCount: 3,
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

/** One applied append: `base` rows 0–2 followed by inserted row `insert #3`. */
function historyWithAppend(): TransformationHistory {
  const op: EditOp = {
    kind: 'row-insert',
    rowId: insertRowId('ov-1', 3),
    position: { kind: 'end' },
    values: new Map(),
  }
  const entry: HistoryEntry = { op, outcome: { status: 'applied', notes: [] }, inverse: [] }
  return { entries: [entry], cursor: 1 }
}

afterEach(() => {
  vi.clearAllMocks()
})

function renderValidation(navigateToRow: NavigateToRow) {
  return renderHook(() =>
    useValidationSession({
      phase: PHASE,
      session: SESSION,
      historyRef: HISTORY_REF,
      overlayRef: { current: null },
      overlayRevision: 0,
      sourceIdentityRef: { current: null },
      navigateToRow,
    }),
  )
}

function renderDiff(navigateToRow: NavigateToRow) {
  return renderHook(() =>
    useDiffSession({
      phase: PHASE,
      session: SESSION,
      historyRef: HISTORY_REF,
      overlayRef: { current: null },
      overlayRevision: 0,
      sourceIdentityRef: { current: null },
      navigateToRow,
    }),
  )
}

describe('ug-12 — validation jump labels the row with its domain display key', () => {
  it('passes the resolved index plus displayRowKey, never the raw/export form', () => {
    const navigateToRow = vi.fn()
    const { result } = renderValidation(navigateToRow)

    act(() => {
      result.current.handleJumpToSample('base:fv-2-1000#2')
    })

    expect(navigateToRow).toHaveBeenCalledTimes(1)
    // `base #2` is the display grammar; `base:2` is the export form and a bare
    // `2` is the effective row index — both must never be the label.
    expect(navigateToRow).toHaveBeenCalledWith(2, 'base #2')
    expect(navigateToRow.mock.calls[0]?.[1]).not.toBe('base:2')
    expect(navigateToRow.mock.calls[0]?.[1]).not.toBe(2)
    expect(result.current.jumpError).toBeNull()
  })

  it('labels an inserted row `insert #N` while handing over its effective index', () => {
    const navigateToRow = vi.fn()
    const historyRef = { current: historyWithAppend() }
    const { result } = renderHook(() =>
      useValidationSession({
        phase: PHASE,
        session: SESSION,
        historyRef,
        overlayRef: { current: null },
        overlayRevision: 1,
        sourceIdentityRef: { current: null },
        navigateToRow,
      }),
    )

    act(() => {
      result.current.handleJumpToSample('ins:ov-1#3')
    })

    // The insert appends after the three base rows: effective index 3, and
    // the domain display grammar names it `insert #3`.
    expect(navigateToRow).toHaveBeenCalledWith(3, 'insert #3')
  })

  it('a failed jump keeps the existing jumpError flow and announces nothing', () => {
    const navigateToRow = vi.fn()
    const { result } = renderValidation(navigateToRow)

    act(() => {
      result.current.handleJumpToSample('base:fv-2-1000#9')
    })

    expect(navigateToRow).not.toHaveBeenCalled()
    expect(result.current.jumpError).toBe(
      'That row is no longer in the current view — it may have been deleted after the verdict was computed. Re-validate for a fresh report.',
    )
  })
})

describe('ug-12 — diff jump labels the row with its domain display key', () => {
  it('passes the resolved index plus displayRowKey, never the raw/export form', () => {
    const navigateToRow = vi.fn()
    const { result } = renderDiff(navigateToRow)

    act(() => {
      result.current.handleJumpToDiffSample('base:fv-2-1000#2')
    })

    expect(navigateToRow).toHaveBeenCalledTimes(1)
    expect(navigateToRow).toHaveBeenCalledWith(2, 'base #2')
    expect(navigateToRow.mock.calls[0]?.[1]).not.toBe('base:2')
    expect(navigateToRow.mock.calls[0]?.[1]).not.toBe(2)
    expect(result.current.diffJumpError).toBeNull()
  })

  it('a failed diff jump keeps diffJumpError and announces nothing', () => {
    const navigateToRow = vi.fn()
    const { result } = renderDiff(navigateToRow)

    act(() => {
      result.current.handleJumpToDiffSample('base:fv-2-1000#9')
    })

    expect(navigateToRow).not.toHaveBeenCalled()
    expect(result.current.diffJumpError).toBe(
      'That row is no longer in the current view — it may have been deleted or changed after the diff ran. Run the diff again for a fresh report.',
    )
  })
})
