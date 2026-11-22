// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilterApplyError } from '@assay/grid'
import type { FilterSpec, GridViewportModel } from '@assay/grid'
import { emptyHistory } from '@assay/domain'
import type { OverlayBase, TransformationHistory } from '@assay/domain'
import type { ValidationReportRow } from '../validation/report-model'
import { FILTER_RELOAD_FAILED_MESSAGE, FILTER_RESTORE_FAILED_MESSAGE } from '../grid/filter-failure'
import { useValidationSession } from './useValidationSession'
import type { DatasetSession } from './session-reset'
import type { Phase } from './types'

/**
 * C02b — the validation panel's "Show only failing rows" bridge after the
 * filter transaction moved under the model (C01 §7/§9.1 row 13).
 *
 * The pin: the bridge issues **exactly one** `setFilters` per click and maps
 * the model's `FilterApplyError.phase` to the shared, value-free copy — it no
 * longer restores the previous list itself (the model owns the single
 * restoration attempt) and never echoes the engine's diagnostic.
 */

const BASE: OverlayBase = {
  baseAnchor: 'fv-2-1000',
  overlayAnchor: 'ov-1',
  columns: [{ name: 'country', type: 'VARCHAR' }],
  baseRowCount: 3,
}

const SESSION: DatasetSession = {
  tokenRef: { current: 1 },
  beginSession: () => ({ token: 1, faults: [] }),
  registerReset: () => () => {},
}

const HISTORY_REF: { current: TransformationHistory } = { current: emptyHistory() }

/** A report row whose failure filter is ready (the control is enabled). */
function failingRow(predicate = "= 'SG'"): ValidationReportRow {
  return {
    ruleId: 'r-country',
    column: 'country',
    kind: 'allowed-values',
    label: 'Allowed values',
    failCount: 2,
    failPercent: 66.67,
    failing: true,
    outcome: 'row-samples',
    samples: [],
    samplesComplete: true,
    filter: { kind: 'ready', predicate },
  }
}

/**
 * A ready phase whose model records every `setFilters`/`refresh` and can
 * reject either (`refreshFailures` = the queue for recovery retries only).
 */
function harness(failures: readonly unknown[] = [], refreshFailures: readonly unknown[] = []) {
  const calls: (readonly FilterSpec[])[] = []
  const remaining = [...failures]
  const remainingRefreshes = [...refreshFailures]
  const model = {
    filters: [] as readonly FilterSpec[],
    calls,
    refreshCalls: 0,
    refresh: async () => {
      model.refreshCalls += 1
      if (remainingRefreshes.length > 0) throw remainingRefreshes.shift()
    },
    setFilters: async (specs: readonly FilterSpec[]) => {
      calls.push(specs)
      if (remaining.length > 0) throw remaining.shift()
      model.filters = specs
    },
  }
  const phase: Phase = {
    kind: 'ready',
    model: model as unknown as GridViewportModel,
    tableId: 't1',
    handle: { kind: 'table', id: 't1' },
    base: BASE,
    provider: {} as never,
  }
  const render = () =>
    renderHook(() =>
      useValidationSession({
        phase,
        session: SESSION,
        historyRef: HISTORY_REF,
        overlayRef: { current: null },
        overlayRevision: 0,
        sourceIdentityRef: { current: null },
        navigateToRow: () => {},
      }),
    )
  return { model, phase, render }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('useValidationSession.handleFilterToFailures (C02b)', () => {
  it('applies the rule predicate in exactly one setFilters call on success', async () => {
    const { model, render } = harness()
    const { result } = render()

    await act(async () => {
      result.current.handleFilterToFailures(failingRow())
    })

    expect(model.calls).toEqual([[{ column: 'country', predicate: "= 'SG'" }]])
    expect(result.current.filterToFailuresError).toBeNull()
  })

  it('maps a refusal to the framed copy without a compensating restore', async () => {
    const { model, render } = harness([
      new FilterApplyError(
        'refused-before-change',
        new Error('Binder Error: nope\nLINE 1: SELECT * FROM "t" WHERE ("x" = 1)'),
      ),
    ])
    const { result } = render()

    await act(async () => {
      result.current.handleFilterToFailures(failingRow())
    })

    expect(model.calls).toHaveLength(1)
    expect(result.current.filterToFailuresError).toBe(
      'The filter could not be applied: Binder Error: nope. The previous filters are still in effect.',
    )
    expect(result.current.filterToFailuresError).not.toMatch(/\r|\n/)
    expect(result.current.filterToFailuresError).not.toContain('LINE 1')
  })

  it('maps an accepted-but-not-reloaded apply to the reload sentence (never a rollback claim)', async () => {
    const { model, render } = harness([
      new FilterApplyError('accepted-reload-failed', new Error('engine unavailable')),
    ])
    const { result } = render()

    await act(async () => {
      result.current.handleFilterToFailures(failingRow())
    })

    expect(model.calls).toHaveLength(1)
    expect(result.current.filterToFailuresError).toBe(FILTER_RELOAD_FAILED_MESSAGE)
    expect(result.current.filterToFailuresError).not.toContain('previous filters')
    expect(result.current.filterToFailuresError).not.toContain('engine unavailable')
  })

  it('maps a failed restore to the honest unknown-state copy', async () => {
    const { model, render } = harness([
      new FilterApplyError('restore-failed', new Error('_setThrew is not defined')),
    ])
    const { result } = render()

    await act(async () => {
      result.current.handleFilterToFailures(failingRow())
    })

    expect(model.calls).toHaveLength(1)
    expect(result.current.filterToFailuresError).toBe(FILTER_RESTORE_FAILED_MESSAGE)
    expect(result.current.filterToFailuresError).not.toContain('still in effect')
    expect(result.current.filterToFailuresError).not.toContain('_setThrew')
  })
})

/**
 * C02 parity / A3 (spec §3/§4): the hook exposes the phase-derived recovery
 * control beside the message it already published, and dispatches it against
 * the live `phase.model` — `retry` → `refresh()`, `clear` → `setFilters([])`.
 * The message values themselves are unchanged in every case.
 */
describe('useValidationSession — the filter failure recovery (C02 parity)', () => {
  it('exposes the reload failure copy with the retry recovery', async () => {
    const { render } = harness([
      new FilterApplyError('accepted-reload-failed', new Error('engine unavailable')),
    ])
    const { result } = render()

    await act(async () => {
      result.current.handleFilterToFailures(failingRow())
    })

    expect(result.current.filterToFailuresError).toBe(FILTER_RELOAD_FAILED_MESSAGE)
    expect(result.current.filterToFailuresRecovery).toEqual({ kind: 'retry' })
  })

  it('exposes the restore failure copy with the clear recovery', async () => {
    const { render } = harness([
      new FilterApplyError('restore-failed', new Error('_setThrew is not defined')),
    ])
    const { result } = render()

    await act(async () => {
      result.current.handleFilterToFailures(failingRow())
    })

    expect(result.current.filterToFailuresError).toBe(FILTER_RESTORE_FAILED_MESSAGE)
    expect(result.current.filterToFailuresRecovery).toEqual({ kind: 'clear' })
  })

  it('offers no recovery for a refusal (the phase promises no action)', async () => {
    const { render } = harness([new FilterApplyError('refused-before-change', new Error('nope'))])
    const { result } = render()

    await act(async () => {
      result.current.handleFilterToFailures(failingRow())
    })

    expect(result.current.filterToFailuresError).toBe(
      'The filter could not be applied: nope. The previous filters are still in effect.',
    )
    expect(result.current.filterToFailuresRecovery).toBeNull()
  })

  it('offers no recovery for a non-transaction rejection', async () => {
    const { render } = harness([new Error('malformed spec')])
    const { result } = render()

    await act(async () => {
      result.current.handleFilterToFailures(failingRow())
    })

    expect(result.current.filterToFailuresRecovery).toBeNull()
    expect(result.current.filterToFailuresError).not.toBeNull()
  })

  it('dispatches clear as exactly one setFilters([]) and drops the feedback', async () => {
    const { model, render } = harness([new FilterApplyError('restore-failed', new Error('x'))])
    const { result } = render()

    await act(async () => {
      result.current.handleFilterToFailures(failingRow())
    })
    expect(model.calls).toHaveLength(1)

    await act(async () => {
      result.current.handleFilterToFailuresRecover({ kind: 'clear' })
    })

    expect(model.calls).toEqual([[{ column: 'country', predicate: "= 'SG'" }], []])
    expect(model.filters).toEqual([])
    expect(result.current.filterToFailuresError).toBeNull()
    expect(result.current.filterToFailuresRecovery).toBeNull()
    expect(model.refreshCalls).toBe(0)
  })

  it('dispatches retry as one refresh() and drops the feedback', async () => {
    const { model, render } = harness([
      new FilterApplyError('accepted-reload-failed', new Error('engine unavailable')),
    ])
    const { result } = render()

    await act(async () => {
      result.current.handleFilterToFailures(failingRow())
    })

    await act(async () => {
      result.current.handleFilterToFailuresRecover({ kind: 'retry' })
    })

    expect(model.refreshCalls).toBe(1)
    // A retry never re-applies or rolls back filters: still the one attempt.
    expect(model.calls).toHaveLength(1)
    expect(result.current.filterToFailuresError).toBeNull()
    expect(result.current.filterToFailuresRecovery).toBeNull()
  })

  it('keeps the accepted-but-not-reloaded copy when the retry reload fails again', async () => {
    const { model, render } = harness(
      [new FilterApplyError('accepted-reload-failed', new Error('engine unavailable'))],
      [new Error('still unavailable')],
    )
    const { result } = render()

    await act(async () => {
      result.current.handleFilterToFailures(failingRow())
    })

    await act(async () => {
      result.current.handleFilterToFailuresRecover({ kind: 'retry' })
    })

    expect(model.refreshCalls).toBe(1)
    // Never re-classified as a refusal or a rollback (the phase is unchanged).
    expect(result.current.filterToFailuresError).toBe(FILTER_RELOAD_FAILED_MESSAGE)
    expect(result.current.filterToFailuresRecovery).toEqual({ kind: 'retry' })
  })

  it('a recovery that lands after the dataset reset writes no feedback (A3 identity guard)', async () => {
    // The hook's state outlives a dataset replacement, so a recovery that
    // completes late must not resurrect feedback on the new session. Without
    // the guard the rejection below publishes FILTER_RELOAD_FAILED_MESSAGE
    // after the reset had already cleared it.
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const resets: (() => void)[] = []
    const session: DatasetSession = {
      tokenRef: { current: 7 },
      beginSession: () => ({ token: 7, faults: [] }),
      registerReset: (reset) => {
        resets.push(reset)
        return () => {}
      },
    }
    const model = {
      filters: [] as readonly FilterSpec[],
      refresh: async (): Promise<void> => {
        await gate
        throw new Error('late engine failure')
      },
      setFilters: async (): Promise<void> => {},
    }
    const phase: Phase = {
      kind: 'ready',
      model: model as unknown as GridViewportModel,
      tableId: 't1',
      handle: { kind: 'table', id: 't1' },
      base: BASE,
      provider: {} as never,
    }
    const { result } = renderHook(() =>
      useValidationSession({
        phase,
        session,
        historyRef: HISTORY_REF,
        overlayRef: { current: null },
        overlayRevision: 0,
        sourceIdentityRef: { current: null },
        navigateToRow: () => {},
      }),
    )

    await act(async () => {
      result.current.handleFilterToFailuresRecover({ kind: 'retry' })
    })

    // The dataset is replaced while the refresh is still in flight.
    act(() => {
      for (const reset of resets) reset()
    })
    session.tokenRef.current = 8

    await act(async () => {
      release()
      await Promise.resolve()
    })

    expect(result.current.filterToFailuresError).toBeNull()
    expect(result.current.filterToFailuresRecovery).toBeNull()
  })
})
