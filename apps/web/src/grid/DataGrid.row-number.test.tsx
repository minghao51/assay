// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GridViewportModel } from '@assay/grid'
import type { OverlayState } from '@assay/domain'
import { DataGrid } from './DataGrid'
import { RecordInspector } from '../record/RecordInspector'

/**
 * ug-11 (UG-12) — row identity made visible, part (a): the sticky 1-based
 * row-number gutter.
 *
 * Pins:
 * 1. the header carries a `columnheader` named `Row number` with a visible
 *    `#` (the accessible name is real, visually hidden text — the q-3
 *    `empty-table-header` precedent);
 * 2. every rendered body row leads with a `rowheader` cell carrying the
 *    **1-based** number (`effective index + 1`), including rows whose slot is
 *    still loading (the number is the row's position, not its payload);
 * 3. `aria-colcount` counts the extra leading column (and still counts the
 *    trailing row-actions column);
 * 4. **gutter ↔ dock agreement**: the record dock's title number for a row
 *    equals the gutter number for the same row — the two user-facing numbers
 *    can never drift into different conventions.
 *
 * The virtualizer is faked (no layout in happy-dom); its rendered window is
 * set per test so the assertions describe exactly what the DOM contains.
 */

interface VirtualItem {
  index: number
  key: string
  start: number
  size: number
}

const h = vi.hoisted(() => ({ rows: [] as VirtualItem[] }))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => h.rows,
    getTotalSize: () => h.rows.length * 28,
    scrollToIndex: vi.fn(),
  }),
}))

function setRenderedRows(indices: readonly number[]): void {
  h.rows = indices.map((index) => ({
    index,
    key: `row-${String(index)}`,
    start: index * 28,
    size: 28,
  }))
}

type RowStatus = 'ready' | 'loading' | 'error'

/** A viewport model whose per-row status the test controls. */
function fakeModel(totalRows: number, statuses: readonly RowStatus[] = []): GridViewportModel {
  return {
    subscribe: () => () => {},
    getVersion: () => 0,
    schema: [
      { name: 'id', type: 'BIGINT' },
      { name: 'label', type: 'VARCHAR' },
    ],
    totalRows,
    sort: null,
    filters: [],
    stats: {
      fetchCalls: 0,
      rowsRequested: 0,
      rowsReceived: 0,
      maxSpanRows: 0,
      cachedRows: 0,
      failedSpans: 0,
    },
    getRow: (index: number) => {
      const status = statuses[index] ?? 'ready'
      if (status === 'ready') {
        return { status, row: [index, `row-${String(index)}`], key: `base:anchor#${String(index)}` }
      }
      if (status === 'error') return { status, message: 'span failed' }
      return { status }
    },
    setSort: async () => {},
    setFilters: async () => {},
    observeViewport: () => {},
    retry: () => {},
  } as unknown as GridViewportModel
}

function gutterFor(rowIndex: number): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `[data-testid="grid-row"][data-row-index="${String(rowIndex)}"]`,
  )
  if (row === null) throw new Error(`row ${String(rowIndex)} not rendered`)
  const gutter = row.querySelector<HTMLElement>('[data-testid="grid-row-number"]')
  if (gutter === null) throw new Error(`row ${String(rowIndex)} has no row-number cell`)
  return gutter
}

function headerRow(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.grid-header-row')
  if (element === null) throw new Error('header row not rendered')
  return element
}

afterEach(() => {
  cleanup()
  h.rows = []
})

describe('DataGrid row-number gutter (ug-11)', () => {
  it('leads the header with an accessible `#` columnheader', () => {
    setRenderedRows([0])
    render(<DataGrid model={fakeModel(3)} onNestedAction={() => {}} onOpenRecord={() => {}} />)

    const header = screen.getByTestId('grid-row-number-header')
    expect(header.getAttribute('role')).toBe('columnheader')
    // The visible glyph is decoration; the accessible name is real text (an
    // aria-label alone fails axe `empty-table-header`).
    expect(header.textContent).toContain('#')
    expect(screen.getByRole('columnheader', { name: 'Row number' })).toBe(header)
    // Leading track, not an appended column.
    expect(headerRow().firstElementChild).toBe(header)
  })

  it('renders a 1-based rowheader gutter as the first cell of every rendered row', () => {
    setRenderedRows([0, 1, 2])
    render(<DataGrid model={fakeModel(3)} onNestedAction={() => {}} onOpenRecord={() => {}} />)

    const gutters = screen.getAllByTestId('grid-row-number')
    expect(gutters.map((gutter) => gutter.textContent)).toEqual(['1', '2', '3'])
    expect(gutters.map((gutter) => gutter.getAttribute('data-row-number'))).toEqual(['1', '2', '3'])
    for (const gutter of gutters) expect(gutter.getAttribute('role')).toBe('rowheader')
    expect(screen.getAllByRole('rowheader')).toHaveLength(3)

    // Each gutter is the row's leading track, before the schema cells.
    for (const rowIndex of [0, 1, 2]) {
      const row = document.querySelector<HTMLElement>(
        `[data-testid="grid-row"][data-row-index="${String(rowIndex)}"]`,
      )
      expect(row?.firstElementChild).toBe(gutterFor(rowIndex))
    }
  })

  it('numbers a loading row too — the number is the position, not the payload', () => {
    setRenderedRows([0, 1, 2])
    render(
      <DataGrid
        model={fakeModel(3, ['ready', 'loading', 'error'])}
        onNestedAction={() => {}}
        onOpenRecord={() => {}}
      />,
    )

    const loadingRow = document.querySelector<HTMLElement>(
      '[data-testid="grid-row"][data-row-index="1"]',
    )
    expect(loadingRow?.getAttribute('data-status')).toBe('loading')
    expect(gutterFor(0).textContent).toBe('1')
    expect(gutterFor(1).textContent).toBe('2')
    expect(gutterFor(2).textContent).toBe('3')
  })

  it('counts the gutter (and the row-actions column) in aria-colcount', () => {
    setRenderedRows([0])
    const { unmount } = render(
      <DataGrid model={fakeModel(3)} onNestedAction={() => {}} onOpenRecord={() => {}} />,
    )
    // 2 schema columns + the leading row-number column.
    expect(screen.getByTestId('grid-viewport').getAttribute('aria-colcount')).toBe('3')
    unmount()

    render(
      <DataGrid
        model={fakeModel(3)}
        onNestedAction={() => {}}
        onOpenRecord={() => {}}
        overlayState={{ edits: new Map() } as unknown as OverlayState}
        onDeleteRow={() => {}}
      />,
    )
    // …+ the trailing row-actions column.
    expect(screen.getByTestId('grid-viewport').getAttribute('aria-colcount')).toBe('4')
    expect(screen.getByTestId('grid-row-actions')).toBeTruthy()
  })

  it('agrees with the record dock: the title number equals the gutter number', () => {
    setRenderedRows([0, 1])
    const model = fakeModel(3)
    const onStep = vi.fn()
    render(
      <>
        <DataGrid model={model} onNestedAction={() => {}} onOpenRecord={() => {}} />
        <RecordInspector
          model={model}
          request={{ rowIndex: 1, seq: 1 }}
          onClosed={() => {}}
          onStep={onStep}
          overlayRevision={0}
        />
      </>,
    )

    const gutterNumber = gutterFor(1).getAttribute('data-row-number')
    const titleNumber = screen.getByTestId('record-title-row').textContent
    const labelled = screen.getByTestId('record-inspector').getAttribute('aria-label')
    expect(gutterNumber).toBe('2')
    expect(titleNumber).toBe(gutterNumber)
    expect(labelled).toBe('Record inspector — row 2')
  })
})
