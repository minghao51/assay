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

/** A ready phase whose model records every `setFilters` and can reject. */
function harness(failures: readonly unknown[] = []) {
  const calls: (readonly FilterSpec[])[] = []
  const remaining = [...failures]
  const model = {
    filters: [] as readonly FilterSpec[],
    calls,
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
