// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * ug-19 (finding UG-19) App-wiring pins: the FilterBar's existing `pending`
 * apply reaches the grid as `aria-busy="true"` plus one polite footer
 * `Filtering…` status, and both clear on settle — success AND rejection. The
 * real composition root runs with only the picker/engine boundaries faked (the
 * `App.profile-filter` posture), so this proves the minimum shared wiring the
 * contract reserves: App owns the combined epoch, FilterBar reports its
 * transition, DataGrid renders it. The sort half of the combination is pinned
 * in `grid/DataGrid.busy.test.tsx` (it needs no App state of its own).
 *
 * Copy is pinned as literals, never imported from the component.
 */

const FAKE_SCHEMA: readonly { name: string; type: string }[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'country', type: 'VARCHAR' },
  { name: 'income', type: 'BIGINT' },
]

const h = vi.hoisted(() => ({
  /** Rows the filtered view reports. */
  filteredRows: 1,
  /** A controllable in-flight filtered count (the apply epoch gate). */
  deferredFilteredCount: null as Promise<void> | null,
  /** Chooser calls — proves a refused gesture really opened no picker. */
  picks: 0,
  /** Engine opens — the adoption completion signal for the reachable leg. */
  openCalls: 0,
}))

function fakeBaseBatch(): ArrowTableLike {
  const columns = [{ get: () => 1 }, { get: () => 'SG' }, { get: () => 52000 }]
  return {
    numRows: 1,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
  }
}

function fakeOverlayBatch(columnCount: number, numRows: number): ArrowTableLike {
  const columns = [
    { get: () => 'base:fv-1:0' },
    ...Array.from({ length: columnCount }, () => ({ get: () => null })),
  ]
  return {
    numRows,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
  }
}

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } }> => {
    h.picks += 1
    return { source: { getFile: async () => new File(['id\n1\n'], 'ug19.jsonl') } }
  },
}))

vi.mock('./lib/engine', () => {
  interface CountOptions {
    readonly filters?: readonly { column: string; predicate: string }[]
  }
  return {
    engineClient: {
      // WF-06 (amendment A1, setup only): each open gets its own id and is
      // counted, so the reachable replacement leg has an adoption signal.
      open: async () => {
        h.openCalls += 1
        return { kind: 'table' as const, id: `t${String(h.openCalls)}` }
      },
      schema: async () => FAKE_SCHEMA,
      rowCount: async () => 1,
      fetchRange: async () => ({ batch: fakeBaseBatch(), hasMore: false }),
      overlaySchema: async () => FAKE_SCHEMA,
      overlayRowCount: async (
        _handle: unknown,
        _overlay: unknown,
        options?: CountOptions,
      ): Promise<number> => {
        if (options?.filters !== undefined) {
          const gate = h.deferredFilteredCount
          h.deferredFilteredCount = null
          if (gate !== null) await gate
          return h.filteredRows
        }
        return 1
      },
      overlayCastCheck: async () => ({ hasNonConvertibleValues: false }),
      fetchOverlayRange: async (_handle: unknown, _overlay: unknown, request?: CountOptions) => ({
        batch: fakeOverlayBatch(FAKE_SCHEMA.length, request?.filters === undefined ? 1 : 1),
        hasMore: false,
      }),
      profile: async () => ({
        rowCount: 1,
        columns: [],
      }),
      query: async () => ({ batch: fakeBaseBatch(), hasMore: false }),
    },
  }
})

afterEach(cleanup)
beforeEach(() => {
  h.filteredRows = 1
  h.deferredFilteredCount = null
  h.picks = 0
  h.openCalls = 0
})

async function openFixture(): Promise<void> {
  render(<App />)
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('schema-section')
  expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
}

function openFilterBar(): void {
  fireEvent.click(screen.getByTestId('filter-toggle'))
  expect(screen.getByTestId('filter-toggle').getAttribute('aria-expanded')).toBe('true')
}

/** Choose a column/operator/value in the compose row and press Apply. */
function applyComposeFilter(column: string, operator: string, value: string): void {
  fireEvent.change(screen.getByTestId('filter-compose-column'), { target: { value: column } })
  fireEvent.change(screen.getByTestId('filter-compose-operator'), { target: { value: operator } })
  fireEvent.change(screen.getByTestId('filter-compose-value'), { target: { value } })
  fireEvent.click(screen.getByTestId('filter-compose-apply'))
}

/**
 * Arm a controllable in-flight filter apply: the next FILTERED row count parks
 * on this gate, so the test decides exactly when the epoch settles.
 */
function armDeferredApply(): { readonly release: () => void; readonly reject: () => void } {
  let releaseDeferred: (() => void) | null = null
  let rejectDeferred: ((error: Error) => void) | null = null
  h.deferredFilteredCount = new Promise<void>((resolve, reject) => {
    releaseDeferred = resolve
    rejectDeferred = reject
  })
  return {
    release: () => {
      releaseDeferred?.()
    },
    reject: () => {
      rejectDeferred?.(new Error('engine unavailable'))
    },
  }
}

/** Drain the apply + model promise chains (resolved-promise hops only). */
async function flushAsync(ticks = 48): Promise<void> {
  await act(async () => {
    for (let index = 0; index < ticks; index += 1) await Promise.resolve()
  })
}

function viewport(): HTMLElement {
  return screen.getByTestId('grid-viewport')
}

describe('ug-19 — filter apply exposes the grid busy epoch through App', () => {
  it('sets aria-busy and shows Filtering… while the apply is in flight, clearing on success', async () => {
    await openFixture()
    openFilterBar()

    const gate = armDeferredApply()
    await act(async () => {
      applyComposeFilter('country', 'eq', 'ZZ')
    })

    await waitFor(() => {
      expect(viewport().getAttribute('aria-busy')).toBe('true')
    })
    const status = screen.getByTestId('grid-busy-status')
    expect(status.getAttribute('role')).toBe('status')
    expect(status.textContent).toBe('Filtering…')
    // Value-free copy: no column name and no predicate value (ADR 0025).
    expect(status.textContent).not.toContain('country')
    expect(status.textContent).not.toContain('ZZ')

    await act(async () => {
      gate.release()
    })
    await flushAsync()

    await waitFor(() => {
      expect(viewport().getAttribute('aria-busy')).toBeNull()
    })
    expect(screen.queryByTestId('grid-busy-status')).toBeNull()
    // The filter really landed: the accepted filter is displayed by the bar.
    await waitFor(() => {
      expect(screen.getByTestId('filter-active-row').getAttribute('data-col-name')).toBe('country')
    })
    expect(screen.queryByTestId('filter-error')).toBeNull()
  })

  it('clears the busy epoch on a rejected apply and keeps the existing error path', async () => {
    await openFixture()
    openFilterBar()

    const gate = armDeferredApply()
    await act(async () => {
      applyComposeFilter('income', 'gt', '1000')
    })
    await waitFor(() => {
      expect(viewport().getAttribute('aria-busy')).toBe('true')
    })
    expect(screen.getByTestId('grid-busy-status').textContent).toBe('Filtering…')

    await act(async () => {
      gate.reject()
    })
    await flushAsync()

    // The rejection still rolls back and shows the framed single-line alert …
    const error = await screen.findByTestId('filter-error')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).not.toMatch(/\r|\n/)
    // … and the busy epoch is over (success AND failure clear it).
    await waitFor(() => {
      expect(viewport().getAttribute('aria-busy')).toBeNull()
    })
    expect(screen.queryByTestId('grid-busy-status')).toBeNull()
  })

  /**
   * WF-06 amendment A1 — one assertion replacement, because the reviewed
   * contract makes "open a replacement while a filter apply is in flight"
   * unreachable: gate row G5 refuses the ready-state gesture while
   * `gridBusy !== null` (v5 §3.2). The old expectation (a second open retires
   * the parked epoch) therefore describes behaviour that no longer exists.
   *
   * The intent is preserved on both sides: (1) the refusal keeps the epoch it
   * does not own exactly as it was and opens no picker/guard; releasing it
   * clears only its own state; (2) epoch retirement is still covered on the
   * reachable path — a replacement adopted while NO apply is in flight
   * publishes a clean epoch (no carried busy state, no carried filter chips
   * from the retired session).
   */
  it('refuses a replacement while the filter epoch is in flight, then adopts into a clean epoch', async () => {
    await openFixture()
    openFilterBar()

    const gate = armDeferredApply()
    await act(async () => {
      applyComposeFilter('country', 'eq', 'ZZ')
    })
    await waitFor(() => {
      expect(viewport().getAttribute('aria-busy')).toBe('true')
    })
    expect(screen.getByTestId('grid-busy-status').textContent).toBe('Filtering…')
    const rowsBefore = screen.getByTestId('grid-total-rows').textContent
    const picksBefore = h.picks

    // G5: the in-flight filter epoch refuses the replacement. No chooser, no
    // guard, no progress, no session write — the epoch stays exactly as it was.
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })
    expect(screen.queryByTestId('replace-guard')).toBeNull()
    expect(screen.queryByTestId('replace-progress')).toBeNull()
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
    expect(h.picks).toBe(picksBefore)
    expect(viewport().getAttribute('aria-busy')).toBe('true')
    expect(screen.getByTestId('grid-busy-status').textContent).toBe('Filtering…')
    expect(screen.getByTestId('grid-total-rows').textContent).toBe(rowsBefore)

    // Releasing the refused gesture's own apply clears the epoch it owns and
    // nothing else; the refusal never auto-resumes (no guard, no picker).
    await act(async () => {
      gate.release()
    })
    await flushAsync()
    await waitFor(() => {
      expect(viewport().getAttribute('aria-busy')).toBeNull()
    })
    expect(screen.queryByTestId('grid-busy-status')).toBeNull()
    expect(screen.queryByTestId('replace-guard')).toBeNull()
    expect(h.picks).toBe(picksBefore)

    // The reachable retirement path: adopt a new dataset with no epoch in
    // flight; the published epoch is clean and carries no retired filter.
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })
    await waitFor(() => {
      expect(h.picks).toBe(picksBefore + 1)
    })
    await waitFor(() => {
      expect(h.openCalls).toBe(2)
    })
    await flushAsync()
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
    expect(viewport().getAttribute('aria-busy')).toBeNull()
    expect(screen.queryByTestId('grid-busy-status')).toBeNull()
    expect(screen.queryAllByTestId('filter-chip')).toHaveLength(0)
  })

  it('keeps Filtering… while a sort is also in flight and clears only after both settle', async () => {
    await openFixture()
    openFilterBar()

    const gate = armDeferredApply()
    await act(async () => {
      applyComposeFilter('country', 'eq', 'SG')
    })
    await waitFor(() => {
      expect(screen.getByTestId('grid-busy-status').textContent).toBe('Filtering…')
    })

    // A header sort starts while the filter apply is still pending: Filtering…
    // wins over Sorting…, and the grid stays busy.
    await act(async () => {
      fireEvent.click(
        document.querySelector<HTMLElement>(
          '[data-testid="grid-sort-toggle"][data-col-name="income"]',
        ) as HTMLElement,
      )
    })
    expect(screen.getByTestId('grid-busy-status').textContent).toBe('Filtering…')
    expect(viewport().getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      gate.release()
    })
    await flushAsync()

    // Both epochs settled (the sort is serialized behind the filter): idle.
    await waitFor(() => {
      expect(viewport().getAttribute('aria-busy')).toBeNull()
    })
    expect(screen.queryByTestId('grid-busy-status')).toBeNull()
  })
})
