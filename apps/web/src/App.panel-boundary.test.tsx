// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * ug-7/R-06–R-07 integration pins through the REAL App composition root:
 *
 * - a mounted tool panel throw is contained to that section while the grid,
 *   pending-changes summary and committed history stay usable;
 * - Try again recovers a transient fault without `beginSession()` / a
 *   dataset reopen, and a deterministic fault stays contained;
 * - Close section hides the body (still mounted), focuses the existing nav
 *   link, and nav reopen shows the retained fallback without auto-retrying;
 * - external SQL requests are claimed BEFORE the query: a true remount with
 *   the same consumed sequence runs ZERO additional `engineClient.query`
 *   calls, a new sequence runs exactly one, and a replacement dataset cannot
 *   run a stale request.
 */

const h = vi.hoisted(() => {
  const resets = new Set<() => void>()
  const tokenRef = { current: 0 }
  const beginSession = vi.fn(() => {
    tokenRef.current += 1
    for (const reset of resets) reset()
    return tokenRef.current
  })
  return {
    beginSession,
    tokenRef,
    session: {
      tokenRef,
      beginSession,
      registerReset: (reset: () => void) => {
        resets.add(reset)
        return () => {
          resets.delete(reset)
        }
      },
    },
    files: [] as File[],
    throwFilter: false,
    throwHistory: false,
    throwSql: false,
    open: vi.fn(),
    query: vi.fn(),
  }
})

const FAKE_HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }
const FAKE_SCHEMA: readonly { name: string; type: string }[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'meta', type: 'STRUCT(a INTEGER)' },
]

function fakeBatch(): ArrowTableLike {
  const columns = [{ get: () => 1 }, { get: () => ({ a: 1 }) }]
  return {
    numRows: 1,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
  }
}

function queryResult() {
  const column = { get: () => 1 }
  return {
    batch: {
      numRows: 1,
      numCols: 1,
      getChildAt: () => column,
      schema: { fields: [{ name: 'a' }] },
    },
    hasMore: false,
  }
}

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } } | null> => {
    const file = h.files.shift()
    if (file === undefined) return null
    return { source: { getFile: async () => file } }
  },
}))

vi.mock('./sessions/session-reset', () => ({
  useDatasetSession: () => h.session,
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
    query: h.query,
    dispose: async () => {},
  },
}))

vi.mock('./grid/FilterBar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./grid/FilterBar')>()
  return {
    FilterBar: (props: Parameters<typeof actual.FilterBar>[0]) => {
      if (h.throwFilter) throw new Error('filter-panel-boom')
      return <actual.FilterBar {...props} />
    },
  }
})

vi.mock('./edit/HistoryPanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./edit/HistoryPanel')>()
  return {
    HistoryPanel: (props: Parameters<typeof actual.HistoryPanel>[0]) => {
      if (h.throwHistory) throw new Error('history-panel-boom')
      return <actual.HistoryPanel {...props} />
    },
  }
})

vi.mock('./sql/SqlPanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sql/SqlPanel')>()
  return {
    ...actual,
    SqlPanel: (props: Parameters<typeof actual.SqlPanel>[0]) => {
      if (h.throwSql) throw new Error('sql-panel-boom')
      return <actual.SqlPanel {...props} />
    },
  }
})

vi.mock('./profile/ProfilePanel', () => ({ ProfilePanel: () => null }))

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  h.tokenRef.current = 0
  h.beginSession.mockClear()
  h.files.length = 0
  h.throwFilter = false
  h.throwHistory = false
  h.throwSql = false
  h.open.mockReset()
  h.open.mockResolvedValue(FAKE_HANDLE)
  h.query.mockReset()
  h.query.mockResolvedValue(queryResult())
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  errorSpy.mockRestore()
})

async function chooseFile(name: string): Promise<void> {
  h.files.push(new File(['id\n1\n'], name))
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('schema-section')
}

async function open(name = 'recovery.jsonl'): Promise<void> {
  render(<App />)
  await chooseFile(name)
}

async function insertRows(count: number, expectedTotal: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      fireEvent.click(screen.getByTestId('edit-insert-row'))
    })
  }
  // The commit path awaits the grid refresh; wait for the honest summary
  // rather than assuming a single act() flushes the whole chain.
  await waitFor(() => {
    expect(screen.getByTestId('pending-changes').textContent).toContain(
      `${String(expectedTotal)} pending`,
    )
  })
}

function fallback(section: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="error-boundary-panel"][data-section="${section}"]`,
  )
  if (element === null) throw new Error(`missing panel fallback for ${section}`)
  return element
}

describe('ug-7 panel-scoped recovery (R-06)', () => {
  it('contains a mounted panel throw and recovers in place without starting a session', async () => {
    await open()
    await act(async () => {
      fireEvent.click(screen.getByTestId('section-toggle-editing'))
      fireEvent.click(screen.getByTestId('section-toggle-history'))
    })
    await insertRows(2, 2)
    expect(screen.getByTestId('pending-changes').textContent).toBe(
      '2 pending changes: 2 row inserts.',
    )
    expect(screen.getAllByTestId('history-item')).toHaveLength(2)

    h.throwFilter = true
    await insertRows(1, 3)

    const panel = await screen.findByTestId('error-boundary-panel')
    expect(panel).toBe(fallback('filters'))
    expect(panel.textContent).toBe(
      'This section could not render' +
        'The grid and staged changes remain available. The opened file was not changed.' +
        `Try again resets this section's local state. If the error returns, close the section and use another tool.` +
        'Try again' +
        'Close section',
    )
    expect(panel.textContent).not.toContain('filter-panel-boom')
    // Failure focus lands on reachable fallback content.
    expect(document.activeElement).toBe(panel)

    // The rest of the workbench is untouched: grid, pending summary, history.
    expect(screen.getByTestId('grid')).toBeTruthy()
    expect(screen.getByTestId('pending-changes').textContent).toBe(
      '3 pending changes: 3 row inserts.',
    )
    expect(screen.getAllByTestId('history-item')).toHaveLength(3)
    expect(h.beginSession).toHaveBeenCalledTimes(1)
    expect(h.open).toHaveBeenCalledTimes(1)

    h.throwFilter = false
    fireEvent.click(screen.getByTestId('error-boundary-retry'))

    expect(await screen.findByTestId('filter-bar')).toBeTruthy()
    expect(screen.queryByTestId('error-boundary-panel')).toBeNull()
    expect(screen.getByTestId('pending-changes').textContent).toBe(
      '3 pending changes: 3 row inserts.',
    )
    expect(h.beginSession).toHaveBeenCalledTimes(1)
    expect(h.open).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('filter-toggle'))
    })
  })

  it('keeps a deterministic panel fault contained across retry', async () => {
    await open()
    h.throwFilter = true
    await insertRows(1, 1)
    expect(await screen.findByTestId('error-boundary-panel')).toBeTruthy()

    fireEvent.click(screen.getByTestId('error-boundary-retry'))
    expect(await screen.findByTestId('error-boundary-panel')).toBeTruthy()
    expect(screen.getByTestId('grid')).toBeTruthy()
    expect(screen.getByTestId('pending-changes').textContent).toBe(
      '1 pending change: 1 row insert.',
    )
  })
})

describe('ug-7 recoverable close/reopen (R-07)', () => {
  it('closes an inner-disclosure section, focuses its nav link, and does not retry on reopen', async () => {
    await open()
    h.throwFilter = true
    await insertRows(1, 1)
    expect(fallback('filters')).toBeTruthy()

    fireEvent.click(screen.getByTestId('error-boundary-close'))
    expect(document.getElementById('section-filters-content')?.hasAttribute('hidden')).toBe(true)
    expect(document.activeElement).toBe(screen.getByTestId('section-nav-filters'))
    // The body stays mounted (the fallback is retained, not unmounted).
    expect(fallback('filters')).toBeTruthy()

    // A now-healthy panel would recover on any auto-retry; nav reopen must
    // show the retained fallback and run nothing until the explicit action.
    h.throwFilter = false
    fireEvent.click(screen.getByTestId('section-nav-filters'))
    expect(document.getElementById('section-filters-content')?.hasAttribute('hidden')).toBe(false)
    expect(fallback('filters')).toBeTruthy()
    expect(screen.queryByTestId('filter-bar')).toBeNull()

    fireEvent.click(screen.getByTestId('error-boundary-retry'))
    expect(await screen.findByTestId('filter-bar')).toBeTruthy()
    expect(screen.queryByTestId('error-boundary-panel')).toBeNull()
    expect(document.getElementById('section-filters-content')?.hasAttribute('hidden')).toBe(false)
  })

  it('clears an inner-disclosure recovery close when a replacement dataset opens', async () => {
    await open()
    h.throwFilter = true
    await insertRows(1, 1)
    expect(fallback('filters')).toBeTruthy()

    fireEvent.click(screen.getByTestId('error-boundary-close'))
    expect(document.getElementById('section-filters-content')?.hasAttribute('hidden')).toBe(true)

    // A replacement dataset is a new session. The recovery-only visibility
    // override lives in App state and survives the open flow, so it must be
    // cleared explicitly; otherwise Filters would stay hidden in new data.
    h.throwFilter = false
    await chooseFile('replacement.jsonl')
    expect(h.beginSession).toHaveBeenCalledTimes(2)
    expect(document.getElementById('section-filters-content')?.hasAttribute('hidden')).toBe(false)
    expect(await screen.findByTestId('filter-bar')).toBeTruthy()
  })

  it('closes a managed section, focuses its nav link, and reopens the retained fallback', async () => {
    await open()
    await act(async () => {
      fireEvent.click(screen.getByTestId('section-toggle-history'))
    })
    await insertRows(1, 1)
    expect(screen.getAllByTestId('history-item')).toHaveLength(1)

    h.throwHistory = true
    await insertRows(1, 2)
    expect(fallback('history')).toBeTruthy()

    fireEvent.click(screen.getByTestId('error-boundary-close'))
    expect(document.getElementById('section-history-content')?.hasAttribute('hidden')).toBe(true)
    expect(document.activeElement).toBe(screen.getByTestId('section-nav-history'))
    expect(fallback('history')).toBeTruthy()

    h.throwHistory = false
    fireEvent.click(screen.getByTestId('section-nav-history'))
    expect(document.getElementById('section-history-content')?.hasAttribute('hidden')).toBe(false)
    expect(fallback('history')).toBeTruthy()
    expect(screen.queryByTestId('history-panel')).toBeNull()

    fireEvent.click(screen.getByTestId('error-boundary-retry'))
    expect(await screen.findByTestId('history-panel')).toBeTruthy()
    expect(screen.queryByTestId('error-boundary-panel')).toBeNull()
    expect(screen.getAllByTestId('history-item')).toHaveLength(2)
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('history-undo'))
    })
  })
})

describe('ug-7 SQL request lifetime in App (R-07)', () => {
  it('claims a consumed nested request before querying, so a boundary remount replays zero queries', async () => {
    await open()
    expect(h.throwSql).toBe(false)

    const action = screen.getAllByTestId('schema-node-action')[0]
    if (action === undefined) throw new Error('expected a nested schema action')
    fireEvent.click(action)

    await waitFor(() => {
      expect(h.query).toHaveBeenCalledTimes(1)
    })
    expect(screen.getByTestId('sql-input')).toBeTruthy()

    // Make the SQL pane throw on the next App render, then retry it with the
    // SAME App-owned runRequest state.
    h.throwSql = true
    await insertRows(1, 1)
    expect(fallback('sql')).toBeTruthy()

    h.throwSql = false
    fireEvent.click(screen.getByTestId('error-boundary-retry'))
    expect(await screen.findByTestId('sql-input')).toBeTruthy()
    await act(async () => {})
    // Mandatory pin: zero additional queries on the remount.
    expect(h.query).toHaveBeenCalledTimes(1)
    // The composed statement stays visible for an explicit Run.
    expect((screen.getByTestId('sql-input') as HTMLTextAreaElement).value).toContain('meta')

    // Manual Run is still permitted after recovery: exactly one more query.
    fireEvent.click(screen.getByTestId('sql-run'))
    await waitFor(() => {
      expect(h.query).toHaveBeenCalledTimes(2)
    })

    // A genuinely new sequence runs exactly once.
    const nextAction = screen.getAllByTestId('schema-node-action')[0]
    if (nextAction === undefined) throw new Error('expected a nested schema action')
    fireEvent.click(nextAction)
    await waitFor(() => {
      expect(h.query).toHaveBeenCalledTimes(3)
    })
  })

  it('does not run a request from a replaced dataset session', async () => {
    await open()
    const action = screen.getAllByTestId('schema-node-action')[0]
    if (action === undefined) throw new Error('expected a nested schema action')
    fireEvent.click(action)
    await waitFor(() => {
      expect(h.query).toHaveBeenCalledTimes(1)
    })

    // A replacement dataset starts a new session; the open flow nulls the
    // request and the App-owned ledger resets. The SQL pane is still mounted
    // (same instance), so no stale request can be replayed into the new data.
    await chooseFile('replacement.jsonl')
    expect(h.beginSession).toHaveBeenCalledTimes(2)
    await act(async () => {})
    expect(h.query).toHaveBeenCalledTimes(1)
    expect(h.open).toHaveBeenCalledTimes(2)
  })
})
