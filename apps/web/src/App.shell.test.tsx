// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * q-15 — workbench shell slice 2 (spec docs/product/05-workbench-shell.md §3;
 * ADR 0044), driven through the REAL App composition root with only the
 * picker/engine boundaries faked (the `App.headings` posture).
 *
 * What this file pins:
 *
 * 1. **Two-pane DOM.** The tool pane (nav + ten tool sections) renders before
 *    the center column (grid + record dock): the tools-left reading order the
 *    ADR rules. The <1024px stack order is a CSS `order` concern (index.css),
 *    not DOM — so the heading map is stable across layouts.
 * 2. **Grid is the persistent center.** The grid section is always mounted and
 *    sits in the center column; collapsing it (or the tool pane to a rail) never
 *    unmounts it.
 * 3. **Disclosure discipline.** First paint expands exactly one tool section
 *    (Schema — an inner-disclosure panel) and collapses every managed tool
 *    section; expansion is non-exclusive (opening one never closes another), so
 *    a validate→jump→edit round-trip can hold several tools open.
 * 4. **Uniform managed affordance.** Grid/Editing/Export/History/Validation/
 *    Compare/SQL/Pipeline each render the shared `section-toggle-<id>` with
 *    `aria-expanded`/`aria-controls` and a visible name; Schema/Filters/Profile/
 *    Record keep their own equivalent disclosure and get NO second toggle.
 * 5. **Sticky nav.** The nav keeps the slice-1 reading order, exposes all
 *    twelve anchors, and clicking one expands its target section.
 * 6. **Pane rail.** The pane toggle collapses the tool pane to a rail without
 *    touching the center column.
 */

const FAKE_HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }

const FAKE_SCHEMA: readonly { name: string; type: string }[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'country', type: 'VARCHAR' },
]

function fakeBatch(): ArrowTableLike {
  const columns = [{ get: () => 1 }, { get: () => 'SG' }]
  return {
    numRows: 1,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
  }
}

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } }> => ({
    source: { getFile: async () => new File(['id\n1\n'], 'shell.jsonl') },
  }),
}))

vi.mock('./lib/engine', () => ({
  engineClient: {
    open: async () => FAKE_HANDLE,
    schema: async () => FAKE_SCHEMA,
    rowCount: async () => 1,
    fetchRange: async () => ({ batch: fakeBatch(), hasMore: false }),
  },
}))

// Real SqlPanel/ProfilePanel render (their sections are part of the shell)
// but never call the engine on mount, so no query/profile fakes are needed.

afterEach(cleanup)

/** The sticky-nav reading order (slice-1 order, grid promoted). */
const NAV_ORDER = [
  'schema',
  'grid',
  'editing',
  'export',
  'history',
  'validation',
  'compare',
  'filters',
  'record',
  'sql',
  'profile',
  'pipeline',
] as const

/** The two-pane DOM order: tool pane first (tools-left), then the center. */
const DOM_ORDER = [
  'schema',
  'editing',
  'export',
  'history',
  'validation',
  'compare',
  'filters',
  'sql',
  'profile',
  'pipeline',
  'grid',
  'record',
] as const

/** Tool sections whose shell owns the shared toggle. */
const MANAGED_TOOL_SECTIONS = [
  'editing',
  'export',
  'history',
  'validation',
  'compare',
  'sql',
  'pipeline',
] as const

/** Visible section title, as it must appear in the collapsed toggle row. */
const SECTION_TITLES: Record<(typeof NAV_ORDER)[number], string> = {
  schema: 'Schema',
  grid: 'Grid',
  editing: 'Editing',
  export: 'Export',
  history: 'History',
  validation: 'Validation',
  compare: 'Compare',
  filters: 'Filters',
  record: 'Record',
  sql: 'SQL',
  profile: 'Profile',
  pipeline: 'Pipeline',
}

/**
 * The shared shell toggle testid for each managed section (the four
 * inner-disclosure sections — Schema/Filters/Profile/Record — have no shell
 * toggle; their own controls are asserted directly).
 */
const SECTION_TOGGLE_TESTIDS: Record<'grid' | (typeof MANAGED_TOOL_SECTIONS)[number], string> = {
  grid: 'section-toggle-grid',
  editing: 'section-toggle-editing',
  export: 'section-toggle-export',
  history: 'section-toggle-history',
  validation: 'section-toggle-validation',
  compare: 'section-toggle-compare',
  sql: 'section-toggle-sql',
  pipeline: 'section-toggle-pipeline',
}

async function open(): Promise<void> {
  render(<App />)
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('schema-section')
}

describe('q-15 — workbench two-pane shell', () => {
  it('renders the tool pane before the center column, grid in the center', async () => {
    await open()

    const tools = document.querySelectorAll('.workbench-tools .workbench-section')
    expect(Array.from(tools).map((section) => section.getAttribute('data-section'))).toEqual([
      'schema',
      'editing',
      'export',
      'history',
      'validation',
      'compare',
      'filters',
      'sql',
      'profile',
      'pipeline',
    ])

    const center = document.querySelectorAll('.workbench-center .workbench-section')
    expect(Array.from(center).map((section) => section.getAttribute('data-section'))).toEqual([
      'grid',
      'record',
    ])

    const rendered = Array.from(document.querySelectorAll('.workbench-section')).map((section) =>
      section.getAttribute('data-section'),
    )
    expect(rendered).toEqual([...DOM_ORDER])
  })

  it('expands exactly one tool section on first paint (Schema) and collapses the rest', async () => {
    await open()

    // Inner-disclosure Schema opens; managed tool sections start collapsed.
    expect(screen.getByTestId('schema-toggle').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('filter-toggle').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByTestId('profile-toggle').getAttribute('aria-expanded')).toBe('false')
    for (const id of MANAGED_TOOL_SECTIONS) {
      expect(screen.getByTestId(`section-toggle-${id}`).getAttribute('aria-expanded')).toBe('false')
    }
    // Grid is the persistent center and starts expanded.
    expect(screen.getByTestId('section-toggle-grid').getAttribute('aria-expanded')).toBe('true')
    // Inner-disclosure sections get no second shell toggle.
    expect(screen.queryByTestId('section-toggle-schema')).toBeNull()
    expect(screen.queryByTestId('section-toggle-filters')).toBeNull()
    expect(screen.queryByTestId('section-toggle-profile')).toBeNull()
    expect(screen.queryByTestId('section-toggle-record')).toBeNull()
  })

  it('expands non-exclusively: opening a second section never closes the first', async () => {
    await open()

    const editing = screen.getByTestId('section-toggle-editing')
    const exportToggle = screen.getByTestId('section-toggle-export')
    await act(async () => {
      fireEvent.click(editing)
    })
    await act(async () => {
      fireEvent.click(exportToggle)
    })

    expect(editing.getAttribute('aria-expanded')).toBe('true')
    expect(exportToggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('section-toggle-grid').getAttribute('aria-expanded')).toBe('true')
  })

  it('collapses and re-expands a managed section while keeping it mounted', async () => {
    await open()

    const toggle = screen.getByTestId('section-toggle-editing')
    const body = document.getElementById('section-editing-content')
    expect(body).not.toBeNull()
    expect(body?.hasAttribute('hidden')).toBe(true)

    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(body?.hasAttribute('hidden')).toBe(false)
    // CSS-only collapse: the child is still mounted (grid/fetch + memo invariants).
    expect(screen.getByTestId('edit-toolbar')).toBeTruthy()
    expect(screen.getByTestId('edit-overlay-explanation').textContent).toBe(
      'Edits are staged in this session; the opened file is never modified. Export writes a copy.',
    )

    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(body?.hasAttribute('hidden')).toBe(true)
  })

  it('names every managed section in its collapsed toggle row (uniform affordance)', async () => {
    await open()

    for (const id of ['grid', ...MANAGED_TOOL_SECTIONS] as const) {
      const toggle = screen.getByTestId(SECTION_TOGGLE_TESTIDS[id])
      expect(toggle.textContent).toContain(SECTION_TITLES[id])
    }
  })

  it('lists every section in the sticky nav in reading order with resolving anchors', async () => {
    await open()

    const nav = screen.getByTestId('section-nav')
    const linkIds = Array.from(nav.querySelectorAll('a')).map((link) =>
      link.getAttribute('data-testid'),
    )
    expect(linkIds).toEqual(NAV_ORDER.map((id) => `section-nav-${id}`))

    for (const id of NAV_ORDER) {
      const link = screen.getByTestId(`section-nav-${id}`)
      expect(link.getAttribute('href')).toBe(`#section-${id}`)
      expect(document.getElementById(`section-${id}`)).not.toBeNull()
    }
  })

  it('expands the target section when its sticky-nav link is activated', async () => {
    await open()

    const validation = screen.getByTestId('section-toggle-validation')
    expect(validation.getAttribute('aria-expanded')).toBe('false')

    await act(async () => {
      fireEvent.click(screen.getByTestId('section-nav-validation'))
    })

    expect(validation.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById('section-validation-content')?.hasAttribute('hidden')).toBe(
      false,
    )
  })

  it('keeps the grid mounted and in the center when the pane collapses to a rail', async () => {
    await open()

    // The grid is mounted before and after the rail collapse.
    expect(screen.getByTestId('grid')).toBeTruthy()
    const toggle = screen.getByTestId('pane-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    await act(async () => {
      fireEvent.click(toggle)
    })

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById('workbench-tools-body')?.hasAttribute('hidden')).toBe(true)
    // Same mounted grid (rendering position only — no data-flow change).
    expect(screen.getByTestId('grid')).toBeTruthy()
    expect(screen.getByTestId('section-toggle-grid').getAttribute('aria-expanded')).toBe('true')
  })
})
