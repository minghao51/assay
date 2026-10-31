// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GridViewportModel } from '@assay/grid'
import type { OverlayState } from '@assay/domain'
import { DataGrid } from './DataGrid'

/**
 * ug-4 (UG-9/UG-33) pins: the grid's interaction language is visible AND
 * truthful about the instance that renders it.
 *
 * 1. **Editable ready grid** (the app's main grid: overlay + commit + record
 *    opener): the byte-exact hint `Double-click a cell to edit · Enter edits
 *    the focused cell · Esc cancels` (U+00B7 separators) renders as visible
 *    text outside the role=grid subtree, is the grid role's `aria-describedby`
 *    description, and the footer's `Keyboard` disclosure lists the edit,
 *    inspect and navigate gestures this component implements.
 * 2. **Inspect-only grid** (`onOpenRecord` wired, editing not): no editing
 *    hint and no description — there is no editing gesture to announce — and
 *    the disclosure carries Inspect + Navigate only, with no Edit group.
 * 3. **Preview-shaped read-only grid** (the pipeline node preview mount:
 *    `model` + `onNestedAction` only): no hint, no Keyboard disclosure and no
 *    `aria-describedby`, so nothing claims edit/inspect/navigate capability
 *    that this surface does not wire.
 *
 * Every advertised line is traced to the handlers in `DataGrid.tsx` (the
 * roving-tabindex/edit-mode behaviour itself is pinned by
 * `DataGrid.keyboard.test.tsx`); no aspirational shortcut is listed. The copy
 * is value-free (ADR 0025).
 *
 * The virtualizer is faked (no layout in happy-dom) so the ready window is
 * deterministic.
 */

interface VirtualItem {
  index: number
  key: string
  start: number
  size: number
}

const h = vi.hoisted(() => ({
  rows: [] as VirtualItem[],
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => h.rows,
    getTotalSize: () => h.rows.length * 28,
    scrollToIndex: vi.fn(),
  }),
}))

/** The one user-facing string this row owns (byte-exact, single spaces). */
const HINT = 'Double-click a cell to edit · Enter edits the focused cell · Esc cancels'

const SCHEMA: readonly { name: string; type: string }[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'name', type: 'VARCHAR' },
]

h.rows = [0, 1, 2].map((index) => ({
  index,
  key: `row-${String(index)}`,
  start: index * 28,
  size: 28,
}))

function fakeModel(): GridViewportModel {
  return {
    subscribe: () => () => {},
    getVersion: () => 0,
    schema: SCHEMA,
    totalRows: 3,
    sort: null,
    filters: [],
    stats: {
      fetchCalls: 0,
      rowsRequested: 0,
      rowsReceived: 0,
      maxSpanRows: 0,
      cachedRows: 0,
      failedSpans: 0,
      fatalError: null,
    },
    getRow: (index: number) => ({
      status: 'ready',
      row: [index, `name-${String(index)}`],
      key: `base:${String(index)}`,
    }),
    setSort: async () => {},
    setFilters: async () => {},
    observeViewport: () => {},
    retry: () => {},
  } as unknown as GridViewportModel
}

function fakeOverlay(): OverlayState {
  return {
    anchors: { baseAnchor: 'b', overlayAnchor: 'o' },
    columns: [],
    edits: new Map(),
    inserts: new Map(),
    deletedBase: new Set(),
    nextInsertSeq: 0,
  } as unknown as OverlayState
}

/** The app's main ready grid: editing + record-opener props are wired. */
function editableGrid() {
  return render(
    <DataGrid
      model={fakeModel()}
      onNestedAction={() => {}}
      onOpenRecord={() => {}}
      overlayState={fakeOverlay()}
      onCommitCell={() => {}}
    />,
  )
}

/** Inspector-wired but non-editing grid (read-only rows that can be opened). */
function inspectOnlyGrid() {
  return render(<DataGrid model={fakeModel()} onNestedAction={() => {}} onOpenRecord={() => {}} />)
}

/** Exactly the pipeline node preview mount (`PipelinePanel.tsx`). */
function previewGrid() {
  return render(<DataGrid model={fakeModel()} onNestedAction={() => {}} />)
}

function viewport(): HTMLElement {
  return screen.getByTestId('grid-viewport')
}

function hint(): HTMLElement {
  return screen.getByTestId('grid-edit-hint')
}

function keyboardHelp(): HTMLDetailsElement | null {
  return document.querySelector<HTMLDetailsElement>('[data-testid="grid-keyboard-help"]')
}

function groups(details: HTMLDetailsElement | null): (string | null)[] {
  return Array.from(details?.querySelectorAll('p.grid-keyboard-group') ?? []).map(
    (element) => element.textContent,
  )
}

function keys(list: Element | undefined): (string | null)[] {
  return Array.from(list?.querySelectorAll('dt') ?? []).map((element) => element.textContent)
}

function actions(list: Element | undefined): (string | null)[] {
  return Array.from(list?.querySelectorAll('dd') ?? []).map((element) => element.textContent)
}

afterEach(cleanup)

describe('DataGrid interaction copy — editable ready grid (ug-4 / UG-9, UG-33)', () => {
  it('renders the byte-exact hint as visible text, outside the role=grid subtree', () => {
    editableGrid()

    const element = hint()
    expect(element.tagName).toBe('P')
    expect(element.textContent).toBe(HINT)
    // Visible text, not screen-reader-only and not a tooltip: the class list
    // carries the hint's own style hook and nothing that hides it.
    expect(Array.from(element.classList)).toEqual(['grid-edit-hint'])
    expect(element.getAttribute('aria-hidden')).toBeNull()
    expect(element.hasAttribute('hidden')).toBe(false)
    // UX-9: the grid role owns rows/rowgroups only, so the hint sits outside.
    expect(viewport().contains(element)).toBe(false)
    expect(element.id).toContain('grid-edit-hint')
  })

  it('is the grid role accessible description (aria-describedby resolves to it)', () => {
    editableGrid()

    const grid = viewport()
    expect(grid.getAttribute('role')).toBe('grid')
    const describedBy = grid.getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    const referenced = document.getElementById(describedBy ?? '')
    expect(referenced).toBe(hint())
    expect(referenced?.textContent).toBe(HINT)
  })

  it('is present on first ready paint, before any interaction', () => {
    // No pointer/keyboard event has run: the hint is part of the ready render
    // itself, not a post-gesture state. The description points at it.
    editableGrid()
    expect(hint().textContent).toBe(HINT)
    expect(viewport().getAttribute('aria-describedby')).toBe(hint().id)
  })

  it('keeps per-instance ids so two grids on one page stay valid ARIA', () => {
    // The pipeline node preview reuses this renderer: duplicate idrefs would be
    // an axe `duplicate-id-aria` violation, so each grid owns its own hint.
    render(
      <>
        <DataGrid
          model={fakeModel()}
          onNestedAction={() => {}}
          onOpenRecord={() => {}}
          overlayState={fakeOverlay()}
          onCommitCell={() => {}}
        />
        <DataGrid
          model={fakeModel()}
          onNestedAction={() => {}}
          onOpenRecord={() => {}}
          overlayState={fakeOverlay()}
          onCommitCell={() => {}}
        />
      </>,
    )
    const hints = screen.getAllByTestId('grid-edit-hint')
    const grids = screen.getAllByTestId('grid-viewport')
    expect(hints).toHaveLength(2)
    expect(grids).toHaveLength(2)
    expect(hints[0]?.id).not.toBe(hints[1]?.id)
    expect(grids[0]?.getAttribute('aria-describedby')).toBe(hints[0]?.id)
    expect(grids[1]?.getAttribute('aria-describedby')).toBe(hints[1]?.id)
    // Both idrefs resolve to exactly one element.
    for (const hintId of hints.map((element) => element.id)) {
      expect(document.querySelectorAll(`[id="${hintId}"]`)).toHaveLength(1)
    }
  })

  it('is a collapsed native Keyboard disclosure, first in the footer beside Diagnostics', () => {
    editableGrid()

    const details = keyboardHelp()
    if (details === null) throw new Error('grid keyboard help disclosure not rendered')
    expect(details.tagName).toBe('DETAILS')
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toBe('Keyboard')
    // It is the footer's first disclosure, beside the untouched Diagnostics.
    const footerDetails = document.querySelectorAll('.grid-footer > details')
    expect(Array.from(footerDetails)).toEqual([details, screen.getByTestId('grid-diagnostics')])
  })

  it('lists exactly the implemented edit / inspect / navigate gesture groups', () => {
    editableGrid()

    const details = keyboardHelp()
    expect(groups(details)).toEqual(['Edit', 'Inspect', 'Navigate'])

    const [edit, inspect, navigate] = Array.from(details?.querySelectorAll('dl') ?? [])

    expect(keys(edit)).toEqual(['Double-click a cell', 'Enter on a focused cell', 'Esc'])
    expect(actions(edit)).toEqual([
      'Edit the cell — nested columns stay read-only.',
      'Open the inline editor.',
      'Cancel the open edit.',
    ])

    expect(keys(inspect)).toEqual(['Enter on a focused row'])
    expect(actions(inspect)).toEqual(['Open it in the record inspector (no cell focused).'])

    expect(keys(navigate)).toEqual([
      '↑ ↓ ← →',
      'Home / End',
      'Ctrl+Home / Ctrl+End',
      'Tab / Shift+Tab',
    ])
    expect(actions(navigate)).toEqual([
      'Move between cells.',
      'Jump to the row’s first or last cell.',
      'Jump to the grid’s first or last cell (Cmd on macOS).',
      'Enter or leave the grid.',
    ])
  })
})

describe('DataGrid interaction copy — inspect-only grid (ug-4 honesty)', () => {
  it('renders no editing hint and no description, because editing is not wired', () => {
    inspectOnlyGrid()

    // The record opener is wired (`interactive` is true), so the disclosure
    // exists — but there is no editing gesture to announce, so the editing
    // hint must not render and the grid must not be described by one.
    expect(screen.queryByTestId('grid-edit-hint')).toBeNull()
    expect(viewport().getAttribute('aria-describedby')).toBeNull()
    // No description text anywhere in the footer either: an empty or
    // substitute editing claim would be just as false.
    const footer = document.querySelector('.grid-footer')
    expect(footer?.textContent).not.toContain('Double-click a cell to edit')
    expect(footer?.textContent).not.toContain('Esc cancels')
  })

  it('discloses Inspect + Navigate only, with no Edit group and no edit keys', () => {
    inspectOnlyGrid()

    const details = keyboardHelp()
    if (details === null) throw new Error('inspect-only grid must still disclose its keys')
    expect(details.querySelector('summary')?.textContent).toBe('Keyboard')
    expect(groups(details)).toEqual(['Inspect', 'Navigate'])

    const [inspect, navigate] = Array.from(details.querySelectorAll('dl'))
    expect(keys(inspect)).toEqual(['Enter on a focused row'])
    expect(actions(inspect)).toEqual(['Open it in the record inspector (no cell focused).'])
    expect(keys(navigate)).toEqual([
      '↑ ↓ ← →',
      'Home / End',
      'Ctrl+Home / Ctrl+End',
      'Tab / Shift+Tab',
    ])
    // The edit gestures are absent, not merely hidden behind another group.
    const disclosed = keys(details).join(' | ')
    expect(disclosed).not.toContain('Double-click a cell')
    expect(disclosed).not.toContain('Esc')
  })
})

describe('DataGrid interaction copy — preview-shaped read-only grid (ug-4 honesty)', () => {
  it('renders no hint, no Keyboard disclosure and no aria-describedby', () => {
    // The exact pipeline node preview mount: no overlay/commit (no editing)
    // and no onOpenRecord (no inspector, no roving tab stop).
    previewGrid()

    expect(screen.queryByTestId('grid-edit-hint')).toBeNull()
    expect(keyboardHelp()).toBeNull()
    expect(viewport().getAttribute('aria-describedby')).toBeNull()
    // Only the untouched Diagnostics disclosure remains in the footer.
    expect(
      Array.from(document.querySelectorAll('.grid-footer > details')).map((element) =>
        element.getAttribute('data-testid'),
      ),
    ).toEqual(['grid-diagnostics'])
  })

  it('claims no edit, inspect or navigation capability anywhere in the footer', () => {
    previewGrid()

    const footerText = document.querySelector('.grid-footer')?.textContent ?? ''
    // Diagnostics counters stay; none of the interaction promises may appear.
    expect(footerText).toContain('Diagnostics')
    for (const falseClaim of [
      'Double-click',
      'Enter',
      'Esc',
      'inspector',
      'Keyboard',
      'Home',
      'Tab',
    ]) {
      expect(footerText).not.toContain(falseClaim)
    }
  })

  it('drops the copy when a wired grid becomes read-only (capabilities are read live)', () => {
    const { rerender } = editableGrid()
    expect(hint().textContent).toBe(HINT)
    expect(keyboardHelp()).not.toBeNull()

    rerender(<DataGrid model={fakeModel()} onNestedAction={() => {}} />)
    expect(screen.queryByTestId('grid-edit-hint')).toBeNull()
    expect(keyboardHelp()).toBeNull()
    expect(viewport().getAttribute('aria-describedby')).toBeNull()
  })
})
