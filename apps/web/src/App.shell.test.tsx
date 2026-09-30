// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * ux-6 — workbench shell slice 1 pins, driven through the REAL App composition
 * root with only the picker/engine boundaries faked (the `App.headings`
 * posture). Spec: docs/product/05-workbench-shell.md §3/§4.
 *
 * What this file pins:
 *
 * 1. **One shared disclosure per managed section.** Grid, Editing, Export,
 *    History, Validation, Compare, Record, SQL and Pipeline each render the
 *    shared `section-toggle-<id>` with `aria-expanded`. Schema, Filters and
 *    Profile keep their own equivalent `aria-expanded` disclosure (ux-3/ux-4)
 *    — the shell deliberately does NOT wrap them in a second toggle.
 * 2. **CSS-only collapse keeps the section mounted.** Toggling a section flips
 *    `aria-expanded` and sets `hidden` on the body, but the child component
 *    stays in the DOM (the grid/fetch and f-2 memo invariants).
 * 3. **Sticky nav order == DOM order.** The nav links list all twelve sections
 *    in the same order the sections render, and every `href` resolves to a
 *    real `section-<id>` anchor.
 * 4. **Grid hoisted.** The rendered section order is Schema → Grid → the rest
 *    (the grid is the first thing after the open section).
 * 5. **Uniform collapsed affordance.** Collapsing any section leaves its
 *    visible name in the toggle row — every one of the eleven sections,
 *    including the two (Validation, Compare) that previously rendered a
 *    bare chevron.
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

/** The slice-1 section order, independently pinned from the implementation. */
const SECTION_ORDER = [
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

/** Sections whose shell owns the shared toggle (the other three have their own). */
const MANAGED_SECTIONS = [
  'grid',
  'editing',
  'export',
  'history',
  'validation',
  'compare',
  'record',
  'sql',
  'pipeline',
] as const

/** Visible section title, as it must appear in the collapsed toggle row. */
const SECTION_TITLES: Record<(typeof SECTION_ORDER)[number], string> = {
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
 * The disclosure control whose visible label names each section: the shared
 * shell toggle for managed sections, the panel's own equivalent control for
 * the three inner-disclosure sections.
 */
const SECTION_TOGGLE_TESTIDS: Record<(typeof SECTION_ORDER)[number], string> = {
  schema: 'schema-toggle',
  grid: 'section-toggle-grid',
  editing: 'section-toggle-editing',
  export: 'section-toggle-export',
  history: 'section-toggle-history',
  validation: 'section-toggle-validation',
  compare: 'section-toggle-compare',
  filters: 'filter-toggle',
  record: 'section-toggle-record',
  sql: 'section-toggle-sql',
  profile: 'profile-toggle',
  pipeline: 'section-toggle-pipeline',
}

async function open(): Promise<void> {
  render(<App />)
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('schema-section')
}

describe('ux-6 — workbench section shell', () => {
  it('exposes one aria-expanded disclosure per section without double toggles', async () => {
    await open()

    for (const id of MANAGED_SECTIONS) {
      expect(screen.getByTestId(`section-toggle-${id}`).getAttribute('aria-expanded')).toBe('true')
    }
    // The inner-disclosure sections keep their own control and get NO shell
    // toggle (a second toggle would be a confusing nested disclosure).
    expect(screen.getByTestId('schema-toggle').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('filter-toggle').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByTestId('profile-toggle').getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByTestId('section-toggle-schema')).toBeNull()
    expect(screen.queryByTestId('section-toggle-filters')).toBeNull()
    expect(screen.queryByTestId('section-toggle-profile')).toBeNull()
  })

  it('names every section in its toggle row when collapsed (uniform affordance)', async () => {
    await open()

    for (const id of SECTION_ORDER) {
      const toggle = screen.getByTestId(SECTION_TOGGLE_TESTIDS[id])
      // Filters starts collapsed (its own disclosure default); every other
      // section starts open. Collapse only what is open.
      if (toggle.getAttribute('aria-expanded') === 'true') {
        await act(async () => {
          fireEvent.click(toggle)
        })
      }
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      // The visible name stays in the toggle row for ALL twelve sections —
      // a collapsed Validation/Compare is no longer a bare chevron.
      expect(toggle.textContent).toContain(SECTION_TITLES[id])
    }
  })

  it('collapses and re-expands a managed section while keeping it mounted', async () => {
    await open()

    const toggle = screen.getByTestId('section-toggle-editing')
    const body = document.getElementById('section-editing-content')
    expect(body).not.toBeNull()
    expect(body?.hasAttribute('hidden')).toBe(false)

    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(body?.hasAttribute('hidden')).toBe(true)
    // CSS-only collapse: the child is still mounted (grid/fetch + memo invariants).
    expect(screen.getByTestId('edit-toolbar')).toBeTruthy()

    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(body?.hasAttribute('hidden')).toBe(false)
  })

  it('lists every section in the sticky nav in DOM order with resolving anchors', async () => {
    await open()

    const nav = screen.getByTestId('section-nav')
    const linkIds = Array.from(nav.querySelectorAll('a')).map((link) =>
      link.getAttribute('data-testid'),
    )
    expect(linkIds).toEqual(SECTION_ORDER.map((id) => `section-nav-${id}`))

    for (const id of SECTION_ORDER) {
      const link = screen.getByTestId(`section-nav-${id}`)
      expect(link.getAttribute('href')).toBe(`#section-${id}`)
      expect(document.getElementById(`section-${id}`)).not.toBeNull()
    }
  })

  it('renders the grid immediately after the schema section in DOM order', async () => {
    await open()

    const rendered = Array.from(document.querySelectorAll('.workbench-section')).map((section) =>
      section.getAttribute('data-section'),
    )
    expect(rendered).toEqual([...SECTION_ORDER])
  })
})
