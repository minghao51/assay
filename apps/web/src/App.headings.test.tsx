// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * ux-3 (UX-6 + UX-7) pins, driven through the REAL App composition root with
 * only the picker/engine boundaries faked (the `App.test.tsx` posture):
 *
 * 1. **Complete heading map.** The ready frame carries an h1 and one h2 per
 *    top-level section, in DOM order matching the visual order: Schema,
 *    Editing, Export, History, Validation, Compare, Filters, Grid, Record,
 *    SQL, Profile, Pipeline (p-5: Pipeline is the provisional tail, after
 *    Profile). Schema/Editing/Export/History/Filters/Grid/Record/SQL/
 *    Profile/Pipeline use the visually-hidden h2 (their visible controls are
 *    a toggle or already-labelled section); Validation and Compare keep their
 *    visible h2. The Record heading exists only while the inspector is open,
 *    so the map is asserted after opening a record through the real row-click
 *    gesture.
 * 2. **Exactly one Undo/Redo pair** (UX-6): the history panel owns the only
 *    undo/redo buttons; the editing toolbar keeps Insert row + the pending
 *    summary. `getAllByRole` returns exactly one of each by accessible name.
 *
 * Mutation-observability (drilled in the task report): deleting one section's
 * h2 fails (1); reintroducing the toolbar's Undo/Redo buttons fails (2).
 *
 * Environment scoping: the root vitest config routes `apps/web/src/**` into a
 * happy-dom project; the virtualizer is faked (no layout in happy-dom) so one
 * grid row renders and can be clicked to open the record inspector.
 */

/** Fake open result: the engine's opaque handle shape (engine-generated id). */
const FAKE_HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }

/** DESCRIBE-shaped fake schema: three columns (grid + record tree). */
const FAKE_SCHEMA: readonly { name: string; type: string }[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'country', type: 'VARCHAR' },
  { name: 'amount', type: 'DOUBLE' },
]

/** One-row fake Arrow batch, structurally shaped for the provider seam. */
function fakeBatch(): ArrowTableLike {
  const columns = [{ get: () => 1 }, { get: () => 'SG' }, { get: () => 10 }]
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
}))

// Deterministic one-row window so the grid row renders under happy-dom (no
// layout) and the row-click record gesture is reachable.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => h.rows,
    getTotalSize: () => h.rows.length * 28,
    scrollToIndex: vi.fn(),
  }),
}))

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } }> => ({
    source: { getFile: async () => new File(['id\n1\n'], 'headings-pin.jsonl') },
  }),
}))

// Real SqlPanel/ProfilePanel render (their h2s are part of the map) but never
// call the engine on mount, so no query/profile fakes are needed.
vi.mock('./lib/engine', () => ({
  engineClient: {
    open: async () => FAKE_HANDLE,
    schema: async () => FAKE_SCHEMA,
    rowCount: async () => 1,
    fetchRange: async () => ({ batch: fakeBatch(), hasMore: false }),
  },
}))

beforeEach(() => {
  h.rows = [{ index: 0, key: 'row-0', start: 0, size: 28 }]
})

afterEach(() => {
  cleanup()
})

/** Open the faked fixture through the real flow and wait for the ready UI. */
async function open(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('schema-section')
}

/**
 * Explicit wait budget for the two environment transitions this pin crosses:
 * the grid row's payload arriving (its current-epoch slot turning `ready`)
 * and the row-click → record-inspector render. Both are microtask-driven
 * fakes here, but the full unit run executes them under host load, where the
 * suite-wide 1000 ms default proved too tight (reviewer: 2/12 full runs).
 * Five seconds follows the repo's long-wait style (e2e uses 20–60 s) while
 * staying inside Vitest's 5 s test budget — and the readiness precondition
 * in `openRecord` below, not this budget, is what makes the gesture
 * deterministic.
 */
const READY_WAIT_MS = 5_000

/** Open the record inspector via the real grid row-click gesture. */
async function openRecord(): Promise<void> {
  const row = (): HTMLElement => screen.getByTestId('grid-row')
  // Determinism by construction, not by a big timeout: RecordInspector's open
  // effect only fires when the clicked row's **current-epoch** slot is
  // `ready` (record/RecordInspector.tsx — a click while the grid is still
  // fetching that epoch is a deliberate no-op, and the effect does NOT
  // re-run when the slot later lands). Waiting for the rendered row to report
  // `data-status="ready"` is therefore the exact precondition the app checks
  // before the row click can open the inspector; only then do we click.
  await waitFor(
    () => {
      expect(row().getAttribute('data-status')).toBe('ready')
    },
    { timeout: READY_WAIT_MS },
  )
  await act(async () => {
    fireEvent.click(row())
  })
  await screen.findByTestId('record-inspector', {}, { timeout: READY_WAIT_MS })
}

describe('ux-3 — complete heading map (UX-7)', () => {
  it('renders h1 + one h2 per top-level section, in visual order', async () => {
    render(<App />)
    await open()
    await openRecord()

    const h1 = screen.getAllByRole('heading', { level: 1 })
    expect(h1).toHaveLength(1)

    const h2 = screen.getAllByRole('heading', { level: 2 })
    expect(h2.map((heading) => heading.textContent)).toEqual([
      'Schema',
      'Grid',
      'Editing',
      'Export',
      'History',
      'Validation',
      'Compare',
      'Filters',
      'Record',
      'SQL',
      'Profile',
      'Pipeline',
    ])
  })

  it('keeps the Record heading out of the map while no record is open', async () => {
    render(<App />)
    await open()

    expect(screen.queryByTestId('record-inspector')).toBeNull()
    const names = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)
    expect(names).not.toContain('Record')
    // Every other section heading is present pre-record.
    expect(names).toEqual([
      'Schema',
      'Grid',
      'Editing',
      'Export',
      'History',
      'Validation',
      'Compare',
      'Filters',
      'SQL',
      'Profile',
      'Pipeline',
    ])
  })
})

describe('ux-3 — single Undo/Redo pair (UX-6)', () => {
  it('renders exactly one Undo and one Redo button in the ready frame', async () => {
    render(<App />)
    await open()

    expect(screen.getAllByRole('button', { name: /^Undo$/ })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /^Redo$/ })).toHaveLength(1)

    // The pair lives in the history panel; the editing toolbar keeps its
    // insert row but no time-travel controls.
    const toolbar = screen.getByTestId('edit-toolbar')
    expect(toolbar.querySelector('[data-testid="history-undo"]')).toBeNull()
    expect(toolbar.querySelector('[data-testid="history-redo"]')).toBeNull()
    const history = screen.getByTestId('history-panel')
    expect(history.querySelector('[data-testid="history-undo"]')).not.toBeNull()
    expect(history.querySelector('[data-testid="history-redo"]')).not.toBeNull()
  })
})
