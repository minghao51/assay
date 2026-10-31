// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GridViewportModel } from '@assay/grid'
import type { OverlayState } from '@assay/domain'
import { DataGrid } from './DataGrid'

/**
 * ug-4 (UG-9/UG-33) pins: the grid's interaction language is visible, not
 * comment-only.
 *
 * 1. **Editing hint.** `Double-click a cell to edit · Enter edits the focused
 *    cell · Esc cancels` (byte-exact, U+00B7 separators) renders as visible
 *    text in every grid render — including a read-only one — outside the
 *    role=grid subtree, and it is that grid's `aria-describedby` description.
 * 2. **Keyboard list.** The footer gains a collapsed-by-default native
 *    `<details data-testid="grid-keyboard-help">` whose `Keyboard` summary
 *    opens a list of the gestures THIS component implements: edit
 *    (double-click / Enter / Esc), inspect (Enter on a row) and navigate
 *    (arrows, Home/End, Ctrl+Home/End, Tab).
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

function viewport(): HTMLElement {
  return screen.getByTestId('grid-viewport')
}

function hint(): HTMLElement {
  return screen.getByTestId('grid-edit-hint')
}

function keyboardHelp(): HTMLDetailsElement {
  const element = document.querySelector<HTMLDetailsElement>('[data-testid="grid-keyboard-help"]')
  if (element === null) throw new Error('grid keyboard help disclosure not rendered')
  return element
}

afterEach(cleanup)

describe('DataGrid editing hint (ug-4 / UG-9)', () => {
  it('renders the byte-exact hint as visible text, outside the role=grid subtree', () => {
    render(<DataGrid model={fakeModel()} onNestedAction={() => {}} />)

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
    render(<DataGrid model={fakeModel()} onNestedAction={() => {}} />)

    const grid = viewport()
    expect(grid.getAttribute('role')).toBe('grid')
    const describedBy = grid.getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    const referenced = document.getElementById(describedBy ?? '')
    expect(referenced).toBe(hint())
    expect(referenced?.textContent).toBe(HINT)
  })

  it('is present on first ready paint, before any interaction', () => {
    // No pointer/keyboard event has run and the grid carries no editing props:
    // the hint is part of the ready render itself, not a post-gesture state.
    render(<DataGrid model={fakeModel()} onNestedAction={() => {}} />)
    expect(hint().textContent).toBe(HINT)
    expect(viewport().getAttribute('aria-describedby')).toBe(hint().id)
  })

  it('keeps per-instance ids so two grids on one page stay valid ARIA', () => {
    // The pipeline node preview reuses this renderer: duplicate idrefs would be
    // an axe `duplicate-id-aria` violation, so each grid owns its own hint.
    render(
      <>
        <DataGrid model={fakeModel()} onNestedAction={() => {}} />
        <DataGrid model={fakeModel()} onNestedAction={() => {}} />
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
})

describe('DataGrid keyboard help disclosure (ug-4 / UG-33)', () => {
  it('is a collapsed native details whose summary is Keyboard', () => {
    render(<DataGrid model={fakeModel()} onNestedAction={() => {}} />)

    const details = keyboardHelp()
    expect(details.tagName).toBe('DETAILS')
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toBe('Keyboard')
    // It is the footer's first disclosure, beside the untouched Diagnostics.
    const footerDetails = document.querySelectorAll('.grid-footer > details')
    expect(Array.from(footerDetails)).toEqual([
      keyboardHelp(),
      screen.getByTestId('grid-diagnostics'),
    ])
  })

  it('lists exactly the implemented edit / inspect / navigate gesture groups', () => {
    render(<DataGrid model={fakeModel()} onNestedAction={() => {}} />)

    const details = keyboardHelp()
    expect(
      Array.from(details.querySelectorAll('p.grid-keyboard-group')).map((el) => el.textContent),
    ).toEqual(['Edit', 'Inspect', 'Navigate'])

    const [edit, inspect, navigate] = Array.from(details.querySelectorAll('dl'))
    const keys = (list: Element | undefined): (string | null)[] =>
      Array.from(list?.querySelectorAll('dt') ?? []).map((el) => el.textContent)
    const actions = (list: Element | undefined): (string | null)[] =>
      Array.from(list?.querySelectorAll('dd') ?? []).map((el) => el.textContent)

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

  it('keeps hint and shortcut list on an interactive grid, including while editing', () => {
    // The app's ready grid passes the editing + record props; the language must
    // not depend on the editor being closed or on a gesture having happened.
    render(
      <DataGrid
        model={fakeModel()}
        onNestedAction={() => {}}
        onOpenRecord={() => {}}
        overlayState={fakeOverlay()}
        onCommitCell={() => {}}
      />,
    )
    expect(hint().textContent).toBe(HINT)
    expect(viewport().getAttribute('aria-describedby')).toBe(hint().id)
    expect(keyboardHelp().querySelector('summary')?.textContent).toBe('Keyboard')
    expect(keyboardHelp().querySelectorAll('dl')).toHaveLength(3)
  })
})
