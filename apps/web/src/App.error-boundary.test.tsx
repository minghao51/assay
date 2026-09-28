// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * AR-W4 integration pin: the grid sits inside its own error boundary, so a
 * grid render failure surfaces the grid fallback while the rest of the
 * workbench (open flow, schema panel) stays usable — it does not white-screen
 * the app. The top-level boundary is not triggered.
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
    source: { getFile: async () => new File(['id\n1\n'], 'grid-boundary.jsonl') },
  }),
}))

vi.mock('./lib/engine', () => ({
  engineClient: {
    open: async () => FAKE_HANDLE,
    schema: async () => FAKE_SCHEMA,
    rowCount: async () => 1,
    fetchRange: async () => ({ batch: fakeBatch(), hasMore: false }),
    dispose: async () => {},
  },
}))

// The grid throws on render — the exact white-screen class AR-W4 guards.
vi.mock('./grid/DataGrid', () => ({
  DataGrid: (): never => {
    throw new Error('grid-render-boom')
  },
}))
vi.mock('./sql/SqlPanel', () => ({ SqlPanel: () => null }))
vi.mock('./profile/ProfilePanel', () => ({ ProfilePanel: () => null }))

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  errorSpy.mockRestore()
})

describe('App grid error boundary (AR-W4)', () => {
  it('contains a grid render failure without taking down the workbench', async () => {
    render(<App />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })
    await screen.findByTestId('schema-section')

    expect(screen.getByTestId('error-boundary-grid')).toBeTruthy()
    // The rest of the workbench is still rendered.
    expect(screen.getByTestId('open-flow')).toBeTruthy()
    expect(screen.getByTestId('schema-panel')).toBeTruthy()
    // The top-level boundary did not trip.
    expect(screen.queryByTestId('error-boundary-app')).toBeNull()
  })
})
