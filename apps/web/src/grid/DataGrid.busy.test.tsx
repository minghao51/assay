// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GridViewportModel } from '@assay/grid'
import { DataGrid } from './DataGrid'

/**
 * ug-19 (findings UG-19/UG-15) pins: the sort/filter in-flight signal.
 *
 * The grid exposes the host's combined query epoch as `aria-busy="true"` on the
 * `role="grid"` element plus ONE polite footer status — byte-exact `Sorting…`
 * for the grid's own header-sort epoch (reported up through
 * `onSortBusyChange`) and `Filtering…` when the host reports a filter apply
 * (`queryBusy`). `Filtering…` wins while both are in flight. The signal clears
 * on settle for success AND failure, and the read-only pipeline-preview shape
 * (no `queryBusy`, no `onSortBusyChange`) renders no busy UI at all.
 *
 * `HostHarness` mirrors the App's minimum wiring (the two flags combined into
 * one `queryBusy`), so the grid is verified against the real signal loop rather
 * than a hand-fed prop alone. The virtualizer is faked (no layout in happy-dom)
 * and the model's `setSort` is held open by the test, so "in flight" is a
 * test-controlled state rather than a timing accident.
 */

const h = vi.hoisted(() => ({
  rows: [] as { index: number; key: string; start: number; size: number }[],
  scrollToIndex: vi.fn(),
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => h.rows,
    getTotalSize: () => h.rows.length * 28,
    scrollToIndex: h.scrollToIndex,
  }),
}))

const SCHEMA: readonly { name: string; type: string }[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'name', type: 'VARCHAR' },
]

interface SortGate {
  resolve: () => void
  reject: (error: Error) => void
}

function fakeModel(options: { failures?: number } = {}): {
  model: GridViewportModel
  gates: SortGate[]
  retry: ReturnType<typeof vi.fn>
} {
  const gates: SortGate[] = []
  const retry = vi.fn()
  const model = {
    subscribe: () => () => {},
    getVersion: () => 0,
    schema: SCHEMA,
    totalRows: 2,
    sort: null,
    filters: [],
    stats: {
      fetchCalls: 1,
      rowsRequested: 2,
      rowsReceived: 2,
      maxSpanRows: 2,
      cachedRows: 2,
      failedSpans: options.failures ?? 0,
      fatalError: null,
    },
    getRow: (index: number) => ({
      status: 'ready' as const,
      row: [index, `name-${String(index)}`],
      key: `base:${String(index)}`,
    }),
    setSort: () =>
      new Promise<void>((resolve, reject) => {
        gates.push({ resolve, reject })
      }),
    setFilters: async () => {},
    observeViewport: () => {},
    retry,
  }
  return { model: model as unknown as GridViewportModel, gates, retry }
}

/**
 * The App's minimum busy wiring: the grid reports its sort epoch up, the host
 * owns the combined state, and a filter epoch arrives as the `filtering` prop
 * (in App, the FilterBar's `onPendingChange`). `Filtering…` wins.
 */
function HostHarness({
  model,
  filtering,
  onSortBusyChange,
}: {
  model: GridViewportModel
  filtering: boolean
  onSortBusyChange?: (busy: boolean) => void
}) {
  const [sorting, setSorting] = useState(false)
  const queryBusy = filtering ? 'filtering' : sorting ? 'sorting' : null
  return (
    <DataGrid
      model={model}
      onNestedAction={() => {}}
      queryBusy={queryBusy}
      onSortBusyChange={(busy) => {
        setSorting(busy)
        onSortBusyChange?.(busy)
      }}
    />
  )
}

beforeEach(() => {
  h.rows = [0, 1].map((index) => ({
    index,
    key: `row-${String(index)}`,
    start: index * 28,
    size: 28,
  }))
  h.scrollToIndex.mockReset()
})

afterEach(cleanup)

function viewport(): HTMLElement {
  return screen.getByTestId('grid-viewport')
}

function busyStatus(): HTMLElement | null {
  return screen.queryByTestId('grid-busy-status')
}

/** Click a column header's sort toggle (the only sort gesture). */
function clickSort(column: string): void {
  fireEvent.click(
    document.querySelector<HTMLElement>(
      `[data-testid="grid-sort-toggle"][data-col-name="${column}"]`,
    ) as HTMLElement,
  )
}

/** Settle the gate-i sort epoch promise and let React commit the tail. */
async function settleSort(gates: SortGate[], index: number, error?: Error): Promise<void> {
  await act(async () => {
    const gate = gates[index]
    if (gate === undefined) throw new Error(`no in-flight sort ${String(index)}`)
    if (error === undefined) gate.resolve()
    else gate.reject(error)
    for (let tick = 0; tick < 8; tick += 1) await Promise.resolve()
  })
}

describe('DataGrid sort epoch busy signal (ug-19)', () => {
  it('sets aria-busy on the grid and shows Sorting… while a header sort is in flight', async () => {
    const { model, gates } = fakeModel()
    render(<HostHarness model={model} filtering={false} />)

    // Idle: no busy attribute, no status line.
    expect(viewport().getAttribute('aria-busy')).toBeNull()
    expect(busyStatus()).toBeNull()

    clickSort('id')

    expect(viewport().getAttribute('aria-busy')).toBe('true')
    expect(busyStatus()?.textContent).toBe('Sorting…')
    // The status is a polite, value-free one-liner.
    expect(busyStatus()?.getAttribute('role')).toBe('status')
    expect(busyStatus()?.textContent).not.toMatch(/id|name|base/)

    await settleSort(gates, 0)

    expect(viewport().getAttribute('aria-busy')).toBeNull()
    expect(busyStatus()).toBeNull()
    // No command error on a successful settle.
    expect(screen.queryByTestId('grid-command-error')).toBeNull()
  })

  it('reports the transition to the host and clears on a FAILED settle too', async () => {
    const { model, gates } = fakeModel()
    const onSortBusyChange = vi.fn()
    render(<HostHarness model={model} filtering={false} onSortBusyChange={onSortBusyChange} />)

    clickSort('id')
    expect(onSortBusyChange.mock.calls).toEqual([[true]])

    await settleSort(gates, 0, new Error('sort failed'))

    // Failure clears the epoch (the existing command error keeps the reason).
    expect(onSortBusyChange.mock.calls).toEqual([[true], [false]])
    expect(viewport().getAttribute('aria-busy')).toBeNull()
    expect(busyStatus()).toBeNull()
    expect(screen.getByTestId('grid-command-error').textContent).toBe('sort failed')
  })

  it('clears the host sort epoch when the grid unmounts mid-sort', () => {
    const { model } = fakeModel()
    const onSortBusyChange = vi.fn()
    const { unmount } = render(
      <DataGrid model={model} onNestedAction={() => {}} onSortBusyChange={onSortBusyChange} />,
    )

    clickSort('id')
    expect(onSortBusyChange.mock.calls).toEqual([[true]])

    // A dataset swap/closing boundary can unmount the grid while the sort is
    // still in flight; the host must not be left reporting a busy epoch.
    unmount()
    expect(onSortBusyChange.mock.calls).toEqual([[true], [false]])
  })

  it('keeps the busy signal until the LAST concurrent sort epoch settles', async () => {
    const { model, gates } = fakeModel()
    const onSortBusyChange = vi.fn()
    render(<HostHarness model={model} filtering={false} onSortBusyChange={onSortBusyChange} />)

    clickSort('id')
    clickSort('name')
    expect(onSortBusyChange.mock.calls).toEqual([[true]])

    await settleSort(gates, 0)
    // One epoch still in flight: the first settle must not clear the signal.
    expect(onSortBusyChange.mock.calls).toEqual([[true]])
    expect(viewport().getAttribute('aria-busy')).toBe('true')
    expect(busyStatus()?.textContent).toBe('Sorting…')

    await settleSort(gates, 1)
    expect(onSortBusyChange.mock.calls).toEqual([[true], [false]])
    expect(viewport().getAttribute('aria-busy')).toBeNull()
    expect(busyStatus()).toBeNull()
  })
})

describe('DataGrid host query epoch (ug-19)', () => {
  it('renders Filtering… when the host reports a filter apply', () => {
    const { model } = fakeModel()
    const { rerender } = render(
      <DataGrid model={model} onNestedAction={() => {}} queryBusy={null} />,
    )
    expect(busyStatus()).toBeNull()

    rerender(<DataGrid model={model} onNestedAction={() => {}} queryBusy="filtering" />)
    expect(viewport().getAttribute('aria-busy')).toBe('true')
    expect(busyStatus()?.textContent).toBe('Filtering…')

    rerender(<DataGrid model={model} onNestedAction={() => {}} queryBusy="sorting" />)
    expect(busyStatus()?.textContent).toBe('Sorting…')

    rerender(<DataGrid model={model} onNestedAction={() => {}} queryBusy={null} />)
    expect(viewport().getAttribute('aria-busy')).toBeNull()
    expect(busyStatus()).toBeNull()
  })

  it('shows Filtering… while both epochs are in flight and clears only when both settle', async () => {
    const { model, gates } = fakeModel()
    const { rerender } = render(<HostHarness model={model} filtering />)

    // A sort starts under a pending filter: Filtering… still wins.
    clickSort('id')
    expect(busyStatus()?.textContent).toBe('Filtering…')
    expect(viewport().getAttribute('aria-busy')).toBe('true')

    // The sort settles first: the filter epoch is still in flight, so the
    // status must NOT clear (and must not flip to Sorting…).
    await settleSort(gates, 0)
    expect(busyStatus()?.textContent).toBe('Filtering…')
    expect(viewport().getAttribute('aria-busy')).toBe('true')

    // The host clears its filter epoch (both epochs are now settled): idle.
    rerender(<HostHarness model={model} filtering={false} />)
    expect(viewport().getAttribute('aria-busy')).toBeNull()
    expect(busyStatus()).toBeNull()
  })

  it('renders no busy UI on the read-only preview shape (no host props)', () => {
    const { model } = fakeModel()
    render(<DataGrid model={model} onNestedAction={() => {}} />)

    // The header sort still works (it is not editing), but a read-only preview
    // advertises no busy state and no status line: nothing is wired.
    clickSort('id')
    expect(viewport().getAttribute('aria-busy')).toBeNull()
    expect(busyStatus()).toBeNull()
  })

  it('leaves the footer diagnostics, counters, errors and retry button intact', () => {
    const { model, retry } = fakeModel({ failures: 1 })
    render(<DataGrid model={model} onNestedAction={() => {}} queryBusy="filtering" />)

    expect(screen.getByTestId('grid-busy-status').textContent).toBe('Filtering…')
    // Every pre-ug-19 footer sibling keeps its presence and content.
    const diagnostics = document.querySelector<HTMLDetailsElement>(
      '[data-testid="grid-diagnostics"]',
    )
    expect(diagnostics?.tagName).toBe('DETAILS')
    expect(diagnostics?.open).toBe(false)
    expect(screen.getByTestId('grid-stats').textContent).toBe(
      'fetches=1 requested=2 received=2 maxSpan=2 cached=2',
    )
    expect(screen.getByTestId('grid-retry').textContent).toBe('Retry 1 failed window')
    fireEvent.click(screen.getByTestId('grid-retry'))
    expect(retry.mock.calls).toHaveLength(1)
  })
})
