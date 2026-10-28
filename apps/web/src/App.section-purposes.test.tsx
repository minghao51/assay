// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * ug-13 / R-14 pins, driven through the REAL App composition root with only
 * the picker/engine boundaries faked (the `App.shell`/`App.headings` posture):
 *
 * 1. **Purpose subtitle on every section, verbatim.** All twelve subtitles
 *    from the implementation spec §2 R-14 render after open with no user
 *    expansion; the eight shell-managed sections are still collapsed
 *    (`aria-expanded="false"`) while their subtitle is visible inside the
 *    toggle, and the four inner-disclosure sections (Schema/Filters/Profile/
 *    Record) carry the shell-rendered line above their own panel.
 * 2. **Accessible description without a name change.** Every managed toggle
 *    points `aria-describedby` at its purpose element's stable id, while the
 *    accessible name stays exactly `Expand <Title>` / `Collapse <Title>` (the
 *    purpose is never part of the name).
 * 3. **Record closed-state hint, full lifecycle.** While no record is
 *    requested the dock shows the value-free hint; once a row opens through
 *    the real grid gesture the hint is absent (no duplicate guidance beside
 *    the inspector), and it returns — with byte-exact copy — when the
 *    inspector is closed and when an epoch shift opens a new dataset. The
 *    shell already owns both clears (`onClosed`, the open flow's
 *    `setRecordRequest(null)`); these pins prove it, they add no logic.
 * 4. **No Record rename.** Nav link, section heading and inspector label all
 *    agree on "Record" (R-14 keeps the name; the hint disambiguates).
 *
 * Environment scoping mirrors `App.headings.test.tsx`: the virtualizer is
 * faked so one grid row renders under happy-dom and the row gesture is
 * reachable.
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

interface VirtualItem {
  index: number
  key: string
  start: number
  size: number
}

const h = vi.hoisted(() => ({
  rows: [] as VirtualItem[],
  /** Pick count — a re-open must resolve a genuinely different dataset. */
  picks: 0,
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => h.rows,
    getTotalSize: () => h.rows.length * 28,
    scrollToIndex: vi.fn(),
  }),
}))

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } }> => {
    h.picks += 1
    const name = `purposes-pin-${String(h.picks)}.jsonl`
    return { source: { getFile: async () => new File(['id\n1\n'], name) } }
  },
}))

vi.mock('./lib/engine', () => ({
  engineClient: {
    open: async () => FAKE_HANDLE,
    schema: async () => FAKE_SCHEMA,
    rowCount: async () => 1,
    fetchRange: async () => ({ batch: fakeBatch(), hasMore: false }),
  },
}))

/** Spec §2 R-14 copy, verbatim — the single assertion authority for this pin. */
const SECTION_PURPOSES: Readonly<Record<string, string>> = {
  schema: 'Fields and types',
  grid: 'Browse the rows',
  filters: 'Show only matching rows',
  validation: 'Check data against rules',
  compare: 'Diff two datasets by key',
  sql: 'Query with DuckDB SQL',
  editing: 'Stage edits in this session',
  history: 'Review and undo staged edits',
  export: 'Write a reviewed copy',
  record: 'Inspect one row in full',
  profile: 'Column statistics summary',
  pipeline: 'Chained contract checks',
}

/** Visible section titles (ids/titles unchanged by R-14). */
const SECTION_TITLES: Readonly<Record<string, string>> = {
  schema: 'Schema',
  grid: 'Grid',
  filters: 'Filters',
  validation: 'Validation',
  compare: 'Compare',
  sql: 'SQL',
  editing: 'Editing',
  history: 'History',
  export: 'Export',
  record: 'Record',
  profile: 'Profile',
  pipeline: 'Pipeline',
}

/** Sections whose toggle the shell owns (the rest are inner disclosures). */
const MANAGED_SECTIONS = [
  'grid',
  'editing',
  'export',
  'history',
  'validation',
  'compare',
  'sql',
  'pipeline',
] as const

/** The dock's closed-state hint (spec §2 R-14, verbatim). */
const RECORD_CLOSED_HINT = 'Select a row to inspect it here — press Enter or double-click a row.'

beforeEach(() => {
  h.rows = [{ index: 0, key: 'row-0', start: 0, size: 28 }]
  h.picks = 0
})

afterEach(() => {
  cleanup()
})

/** Open the faked fixture through the real flow and wait for the ready UI. */
async function open(): Promise<void> {
  render(<App />)
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('schema-section')
}

/**
 * Open the record inspector through the real row-click gesture. The row's
 * current-epoch slot must be `ready` first — RecordInspector deliberately
 * drops a click on a still-loading row (see `App.headings.test.tsx`).
 */
async function openRecord(): Promise<void> {
  const row = (): HTMLElement => screen.getByTestId('grid-row')
  await waitFor(
    () => {
      expect(row().getAttribute('data-status')).toBe('ready')
    },
    { timeout: 5_000 },
  )
  await act(async () => {
    fireEvent.click(row())
  })
  await screen.findByTestId('record-inspector', {}, { timeout: 5_000 })
}

/**
 * Open a second, different dataset through the app's normal open path (the
 * picker fake hands back a new filename per pick). `openDataFile` bumps the
 * dataset-session epoch, which is the shell's stated close-on-epoch-shift
 * rule for the record dock.
 */
async function openDifferentDataset(): Promise<void> {
  const picksBefore = h.picks
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  // The fake picker really ran again: this is a session bump, not a no-op.
  expect(h.picks).toBe(picksBefore + 1)
  await waitFor(
    () => {
      expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
    },
    { timeout: 5_000 },
  )
  await screen.findByTestId('schema-section')
  // The new session's grid must be live before the dock state is meaningful.
  await waitFor(
    () => {
      expect(screen.getByTestId('grid-row').getAttribute('data-status')).toBe('ready')
    },
    { timeout: 5_000 },
  )
}

describe('ug-13 — section purpose subtitles (R-14)', () => {
  it('renders all twelve purpose subtitles verbatim after open, with managed sections still collapsed', async () => {
    await open()

    // No user expansion: every shell-managed tool section is collapsed (the
    // grid is the one persistent center section) and the inner-disclosure
    // panels keep their own default state.
    for (const id of MANAGED_SECTIONS) {
      const toggle = screen.getByTestId(`section-toggle-${id}`)
      if (id === 'grid') {
        expect(toggle.getAttribute('aria-expanded')).toBe('true')
      } else {
        expect(toggle.getAttribute('aria-expanded')).toBe('false')
      }
    }

    for (const [id, copy] of Object.entries(SECTION_PURPOSES)) {
      const purpose = screen.getByTestId(`section-purpose-${id}`)
      expect(purpose.textContent).toBe(copy)
      // Visible: not inside a collapsed (hidden) body.
      expect(purpose.closest('[hidden]')).toBeNull()
    }

    // The managed subtitle lives inside the toggle header (so collapsing the
    // body can never hide it); inner sections render theirs at section level.
    for (const id of MANAGED_SECTIONS) {
      const toggle = screen.getByTestId(`section-toggle-${id}`)
      const purpose = screen.getByTestId(`section-purpose-${id}`)
      expect(toggle.contains(purpose)).toBe(true)
    }
    for (const id of ['schema', 'filters', 'profile', 'record']) {
      const purpose = screen.getByTestId(`section-purpose-${id}`)
      const toggle = document.querySelector(`[data-testid="section-toggle-${id}"]`)
      expect(toggle).toBeNull()
      expect(purpose.closest('.workbench-section')?.getAttribute('data-section')).toBe(id)
    }
  })

  it('describes every managed toggle without changing its accessible name', async () => {
    await open()

    for (const id of MANAGED_SECTIONS) {
      const toggle = screen.getByTestId(`section-toggle-${id}`)
      const purpose = screen.getByTestId(`section-purpose-${id}`)

      // Stable id + attribute wiring.
      expect(purpose.id).toBe(`section-${id}-purpose`)
      expect(toggle.getAttribute('aria-describedby')).toBe(purpose.id)

      // Name stability: the toggle is still reachable by its exact
      // `Expand/Collapse <Title>` name (aria-label wins over the text column).
      const expanded = toggle.getAttribute('aria-expanded') === 'true'
      const name = `${expanded ? 'Collapse' : 'Expand'} ${SECTION_TITLES[id]}`
      expect(screen.getByRole('button', { name })).toBe(toggle)

      // And the purpose text is a DESCRIPTION, never part of the name.
      expect(screen.queryByRole('button', { name: new RegExp(SECTION_PURPOSES[id]!) })).toBeNull()
    }
  })
})

describe('ug-13 — Record dock closed-state hint (R-14)', () => {
  it('shows the hint before any row is selected and removes it once a row opens', async () => {
    await open()

    expect(screen.queryByTestId('record-inspector')).toBeNull()
    const hint = screen.getByTestId('record-hint')
    expect(hint.textContent).toBe(RECORD_CLOSED_HINT)
    expect(hint.closest('[hidden]')).toBeNull()

    await openRecord()

    // The open inspector is the guidance now — exactly ONE guidance surface:
    // the hint renders zero times (count, not just absence-of-first).
    const inspector = screen.getByTestId('record-inspector')
    expect(inspector.closest('[hidden]')).toBeNull()
    expect(screen.queryAllByTestId('record-hint')).toHaveLength(0)
  })

  it('restores the hint with byte-exact copy once the inspector is closed', async () => {
    await open()

    await openRecord()
    expect(screen.queryAllByTestId('record-hint')).toHaveLength(0)

    // Close through the inspector's own close control (not a shell hack).
    await act(async () => {
      fireEvent.click(screen.getByTestId('record-close'))
    })
    await waitFor(() => {
      expect(screen.queryByTestId('record-inspector')).toBeNull()
    })

    const hint = screen.getByTestId('record-hint')
    expect(hint.textContent).toBe(RECORD_CLOSED_HINT)
    expect(hint.closest('[hidden]')).toBeNull()
  })

  it('restores the hint and drops the stale inspector on an epoch shift to a new dataset', async () => {
    await open()

    await openRecord()
    // Stale-inspector guard: the open record belongs to the OLD dataset.
    expect(screen.getByTestId('record-inspector').getAttribute('aria-label')).toBe(
      'Record inspector — row 0',
    )
    expect(screen.queryAllByTestId('record-hint')).toHaveLength(0)

    await openDifferentDataset()

    // No stale inspector survives the session bump, and the dock is back to
    // its closed state with the same copy.
    expect(screen.queryByTestId('record-inspector')).toBeNull()
    const hint = screen.getByTestId('record-hint')
    expect(hint.textContent).toBe(RECORD_CLOSED_HINT)
    expect(hint.closest('[hidden]')).toBeNull()
  })

  it('keeps the name "Record" across nav link, section heading and inspector label', async () => {
    await open()

    const nav = screen.getByTestId('section-nav-record')
    expect(nav.textContent).toBe('Record')

    // The dock has no shell toggle (deliberate: it is grid-linked state), so
    // there is no second toggle label that could drift from the agreed name.
    expect(screen.queryByTestId('section-toggle-record')).toBeNull()

    await openRecord()

    const section = document.getElementById('section-record')
    expect(section).not.toBeNull()
    const heading = section?.querySelector('h2')
    expect(heading?.textContent).toBe('Record')

    const inspector = screen.getByTestId('record-inspector')
    expect(inspector.getAttribute('aria-label')).toBe('Record inspector — row 0')
  })
})
