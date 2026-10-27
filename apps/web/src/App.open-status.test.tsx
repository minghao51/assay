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

/**
 * When `deferOpen` is set, `engineClient.open` parks on a promise that the test
 * never resolves, so the app stays in the `opening` phase for the copy pin
 * (reviewer item 1).
 */
const h = vi.hoisted(() => ({
  deferOpen: false,
  openError: false,
  openResolvers: [] as Array<(value: unknown) => void>,
  openCalls: [] as Array<{ name: string; getFile: () => Promise<File> }>,
  pickerCalls: 0,
}))

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
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } }> => {
    h.pickerCalls += 1
    return { source: { getFile: async () => new File(['id\n1\n'], 'open-status.jsonl') } }
  },
}))

vi.mock('./lib/engine', () => ({
  engineClient: {
    open: async (source: { name: string; getFile: () => Promise<File> }) => {
      h.openCalls.push(source)
      if (h.deferOpen) {
        await new Promise<unknown>((resolve) => h.openResolvers.push(resolve))
      }
      if (h.openError) throw new Error('corrupt dataset')
      return FAKE_HANDLE
    },
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

afterEach(() => {
  cleanup()
  h.deferOpen = false
  h.openError = false
  h.openResolvers = []
  h.openCalls = []
  h.pickerCalls = 0
})

/** Open the faked fixture through the real flow and wait for the ready UI. */
async function open(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('schema-section')
}

describe('R-03 — first-run idle screen copy', () => {
  it('renders the capability sentence and format line and no scaffold/roadmap copy', () => {
    render(<App />)

    expect(screen.getByTestId('idle-capability').textContent).toBe(
      'Inspect, query, validate, compare, and repair local datasets.',
    )
    expect(screen.getByTestId('idle-formats').textContent).toBe(
      'Opens .parquet · .csv · .jsonl · .json',
    )

    // The primary control is unchanged.
    const button = screen.getByTestId('open-button')
    expect(button.textContent).toBe('Open a data file…')
    expect(button.hasAttribute('disabled')).toBe(false)

    // The old scaffold/roadmap/docs block is gone, including the raw
    // constants and the milestone language they carried.
    const visible = document.body.textContent ?? ''
    for (const forbidden of [
      'MVP complete',
      'PT-0',
      'G0',
      'D12',
      'docs/',
      'Documentation lives',
      'Next:',
      'post-MVP',
      'milestone',
      'roadmap',
    ]) {
      expect(visible).not.toContain(forbidden)
    }
  })

  it('does not render the welcome copy while opening', async () => {
    h.deferOpen = true
    render(<App />)
    expect(screen.getByTestId('idle-capability')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })

    expect(screen.queryByTestId('idle-intro')).toBeNull()
    expect(screen.queryByTestId('idle-capability')).toBeNull()
    expect(screen.queryByTestId('example-data-button')).toBeNull()
    expect(screen.queryByTestId('example-data-helper')).toBeNull()
    const opening = screen.getByTestId('open-status')
    expect(opening.getAttribute('data-phase')).toBe('opening')
    expect(opening.textContent).toBe('Opening…')
  })

  it('does not render the welcome copy on an open error and keeps the alert', async () => {
    h.openError = true
    render(<App />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })

    const alert = await screen.findByTestId('open-error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toContain('corrupt dataset')
    expect(screen.queryByTestId('idle-intro')).toBeNull()
    expect(screen.queryByTestId('idle-capability')).toBeNull()
    expect(screen.queryByTestId('example-data-button')).toBeNull()
    expect(screen.queryByTestId('example-data-helper')).toBeNull()
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('error')
    expect(screen.getByTestId('open-button').hasAttribute('disabled')).toBe(false)
  })
})

describe('R-05 — bundled example entry', () => {
  it('offers the exact idle copy and opens the bundled file without invoking the picker', async () => {
    render(<App />)

    expect(screen.getByTestId('example-data-button').textContent).toBe('Try with example data')
    expect(screen.getByTestId('example-data-helper').textContent).toBe(
      'Explore nested fields with a small synthetic example.',
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('example-data-button'))
    })
    await screen.findByTestId('schema-section')

    expect(h.pickerCalls).toBe(0)
    expect(h.openCalls).toHaveLength(1)
    const opened = h.openCalls[0]
    expect(opened?.name).toBe('nested.jsonl')
    const file = await opened?.getFile()
    expect(file?.name).toBe('nested.jsonl')
    expect(file?.size).toBeGreaterThan(0)
    expect(screen.queryByTestId('example-data-button')).toBeNull()
    expect(screen.queryByTestId('example-data-helper')).toBeNull()
  })

  it('keeps the primary control on the existing picker path', async () => {
    render(<App />)
    await open()

    expect(h.pickerCalls).toBe(1)
    expect(h.openCalls).toHaveLength(1)
    expect(h.openCalls[0]?.name).toBe('open-status.jsonl')
  })
})

describe('ux-2 — human open/status copy', () => {
  it('pins the opening state: human copy + the raw phase token on data-phase only', async () => {
    h.deferOpen = true
    render(<App />)

    const idle = screen.getByTestId('open-status')
    expect(idle.getAttribute('data-phase')).toBe('idle')
    expect(idle.textContent).toBe('No file open')

    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })

    // `open` never settles, so the app is parked in `opening`; the visible
    // copy must be human, not the raw `phase.kind` token.
    const opening = screen.getByTestId('open-status')
    expect(opening.getAttribute('data-phase')).toBe('opening')
    expect(opening.textContent).toBe('Opening…')
  })

  it('renders human copy + a stable data-phase token, never the raw phase.kind', async () => {
    render(<App />)

    const idle = screen.getByTestId('open-status')
    expect(idle.getAttribute('data-phase')).toBe('idle')
    expect(idle.textContent).toBe('No file open')

    await open()

    const ready = screen.getByTestId('open-status')
    expect(ready.getAttribute('data-phase')).toBe('ready')
    expect(screen.queryByTestId('example-data-button')).toBeNull()
    // The raw token must never reach visible copy (`ready` folds into the
    // info line below).
    expect(ready.textContent).toBe('')

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
