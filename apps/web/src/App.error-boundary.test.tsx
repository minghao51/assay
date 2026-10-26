// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * AR-W4 + ug-7/R-06 integration pins: the grid sits inside its own error
 * boundary, so a grid render failure surfaces the exact grid recovery copy
 * while the rest of the workbench — including the pending-changes summary and
 * committed staged history — stays usable. "Try again" resets in place,
 * preserves the session (the engine is opened once), and focuses a usable
 * grid target. The top-level/app scope is not triggered.
 */

const h = vi.hoisted(() => ({
  throwGrid: false,
  open: vi.fn(),
}))

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
    source: { getFile: async () => new File(['id\n1\n'], 'grid-boundary.jsonl') },
  }),
}))

vi.mock('./lib/engine', () => ({
  engineClient: {
    open: h.open,
    schema: async () => FAKE_SCHEMA,
    rowCount: async () => 1,
    fetchRange: async () => ({ batch: fakeBatch(), hasMore: false }),
    // Edit commits re-read the effective overlay through these ops; without
    // them the commit rolls back and the pending/history pins are vacuous.
    overlaySchema: async () => FAKE_SCHEMA.map((column) => ({ ...column })),
    overlayRowCount: async () => 2,
    fetchOverlayRange: async () => ({ batch: fakeBatch(), hasMore: false }),
    dispose: async () => {},
  },
}))

// The grid throws on render when the flag is set — the exact white-screen
// class AR-W4 guards. Healthy renders expose one focusable target so the
// post-retry focus move can be asserted.
vi.mock('./grid/DataGrid', () => ({
  DataGrid: () => {
    if (h.throwGrid) throw new Error('grid-render-boom')
    return (
      <div className="grid" data-testid="grid">
        <button type="button" data-testid="fake-grid-target">
          Grid target
        </button>
      </div>
    )
  },
}))
vi.mock('./sql/SqlPanel', () => ({ SqlPanel: () => null }))
vi.mock('./profile/ProfilePanel', () => ({ ProfilePanel: () => null }))

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  h.throwGrid = false
  h.open.mockReset()
  h.open.mockResolvedValue(FAKE_HANDLE)
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  errorSpy.mockRestore()
})

async function open(): Promise<void> {
  render(<App />)
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('schema-section')
}

describe('App grid error boundary (AR-W4 / ug-7)', () => {
  it('contains a grid render failure without taking down the workbench', async () => {
    h.throwGrid = true
    await open()

    expect(screen.getByTestId('error-boundary-grid')).toBeTruthy()
    // The rest of the workbench is still rendered.
    expect(screen.getByTestId('open-flow')).toBeTruthy()
    expect(screen.getByTestId('schema-panel')).toBeTruthy()
    // The top-level boundary did not trip.
    expect(screen.queryByTestId('error-boundary-app')).toBeNull()
  })

  it('renders the exact grid fallback and recovers in place without reopening the dataset', async () => {
    await open()
    h.open.mockClear()

    // Stage edits while the grid works, then make it throw on the next App
    // render. The pending/history state must survive the failure and retry.
    await act(async () => {
      fireEvent.click(screen.getByTestId('section-toggle-editing'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('edit-insert-row'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('pending-changes').textContent).toBe(
        '1 pending change: 1 row insert.',
      )
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('section-toggle-history'))
    })
    expect(screen.getAllByTestId('history-item')).toHaveLength(1)

    h.throwGrid = true
    await act(async () => {
      fireEvent.click(screen.getByTestId('edit-insert-row'))
    })

    const fallback = await screen.findByTestId('error-boundary-grid')
    await waitFor(() => {
      expect(screen.getByTestId('pending-changes').textContent).toBe(
        '2 pending changes: 2 row inserts.',
      )
    })
    expect(fallback.textContent).toBe(
      'The data grid could not render' +
        'The rest of the workbench and committed staged changes remain available. The opened file was not changed.' +
        'Try again resets the grid view; an uncommitted cell draft, focus and scroll position may be lost. Reload starts a fresh session and loses session edits.' +
        'Try again' +
        'Reload the workbench',
    )
    expect(fallback.textContent).not.toContain('grid-render-boom')
    const actions = Array.from(fallback.querySelectorAll('button')).map(
      (button) => button.textContent,
    )
    expect(actions).toEqual(['Try again', 'Reload the workbench'])
    // Failure focus lands on reachable fallback content.
    expect(document.activeElement).toBe(fallback)

    // The panel surfaces around the grid remain usable with the staged edits.
    expect(screen.getByTestId('pending-changes').textContent).toBe(
      '2 pending changes: 2 row inserts.',
    )
    expect(screen.getByTestId('history-panel')).toBeTruthy()
    expect(screen.getAllByTestId('history-item')).toHaveLength(2)
    expect(screen.getByTestId('schema-panel')).toBeTruthy()

    h.throwGrid = false
    fireEvent.click(screen.getByTestId('error-boundary-retry'))

    expect(await screen.findByTestId('grid')).toBeTruthy()
    expect(screen.queryByTestId('error-boundary-grid')).toBeNull()
    expect(screen.getByTestId('pending-changes').textContent).toBe(
      '2 pending changes: 2 row inserts.',
    )
    expect(screen.getAllByTestId('history-item')).toHaveLength(2)
    // The retry preserved the session: no second engine open.
    expect(h.open).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('fake-grid-target'))
    })
  })
})
