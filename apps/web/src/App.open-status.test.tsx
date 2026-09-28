// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * ux-2 (UX-2 + UX-10) pins, driven through the REAL App composition root with
 * only the picker/engine boundaries faked (the `App.test.tsx` posture). This
 * file pins the human open-flow copy contract and the open-completion
 * announcement/focus behavior:
 *
 * 1. `open-status` carries a stable machine token on `data-phase` and renders
 *    ONLY human copy — never the raw `phase.kind` ("idle"/"opening"/"ready").
 *    2. The `table-info` line drops the engine handle: "Dataset · N rows · M
 *    columns" (the SQL pane keeps `assay_t1` for SQL, pinned by e2e).
 * 3. On the transition into `ready` (and only then) a polite `role="status"`
 *    region announces the completion with value-free copy, and focus moves
 *    off the Open button to the first ready panel (the schema disclosure
 *    toggle).
 *
 * Mutation-observability (drilled in the task report): rendering
 * `{phase.kind}` again fails (1); restoring the `open-table-id` handle fails
 * (2); dropping `role="status"` or the focus move fails (3).
 */

/** Fake open result: the engine's opaque handle shape (engine-generated id). */
const FAKE_HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }

/** DESCRIBE-shaped fake schema: three columns so the plural copy is exercised. */
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

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } }> => ({
    source: { getFile: async () => new File(['id\n1\n'], 'open-status.jsonl') },
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

// The two engine-calling panels are orthogonal to this pin (they have e2e
// coverage) and would otherwise need query/profile fakes. SchemaPanel stays
// real so the focus target exists.
vi.mock('./sql/SqlPanel', () => ({ SqlPanel: () => null }))
vi.mock('./profile/ProfilePanel', () => ({ ProfilePanel: () => null }))

afterEach(cleanup)

/** Open the faked fixture through the real flow and wait for the ready UI. */
async function open(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('schema-section')
}

describe('ux-2 — human open/status copy', () => {
  it('renders human copy + a stable data-phase token, never the raw phase.kind', async () => {
    render(<App />)

    const idle = screen.getByTestId('open-status')
    expect(idle.getAttribute('data-phase')).toBe('idle')
    expect(idle.textContent).toBe('No file open')

    await open()

    const ready = screen.getByTestId('open-status')
    expect(ready.getAttribute('data-phase')).toBe('ready')
    // The raw token must never reach visible copy (`ready` folds into the
    // info line below).
    expect(ready.textContent).toBe('')
    expect(ready.textContent).not.toContain('ready')

    // The info line is human and drops the engine handle.
    expect(screen.getByTestId('table-info').textContent).toBe('Dataset · 1 rows · 3 columns')
    expect(screen.queryByTestId('open-table-id')).toBeNull()
  })
})

describe('ux-10 — open-completion announcement + focus move', () => {
  it('announces through role=status and moves focus to the first ready panel', async () => {
    render(<App />)
    await open()

    const live = screen.getByTestId('open-live-region')
    expect(live.getAttribute('role')).toBe('status')
    await waitFor(() => {
      expect(live.textContent).toBe('Dataset opened · 1 row · 3 columns')
    })

    const toggle = screen.getByTestId('schema-toggle')
    expect(document.activeElement).toBe(toggle)
    expect(document.activeElement).not.toBe(screen.getByTestId('open-button'))
  })
})
