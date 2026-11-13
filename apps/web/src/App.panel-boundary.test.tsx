// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PANEL_CRASH_STORAGE_KEY,
  setPanelCrash,
} from '../../../tests/visual/panel-recovery/injection'
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

vi.mock('./schema/SchemaPanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./schema/SchemaPanel')>()
  const { usePanelCrash } = await import('../../../tests/visual/panel-recovery/injection')
  const { useSyncExternalStore } = await import('react')
  return {
    ...actual,
    SchemaPanel: (props: Parameters<typeof actual.SchemaPanel>[0]) => {
      if (usePanelCrash('schema', useSyncExternalStore))
        throw new Error('test-only panel crash: schema')
      return <actual.SchemaPanel {...props} />
    },
  }
})

vi.mock('./edit/EditToolbar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./edit/EditToolbar')>()
  const { usePanelCrash } = await import('../../../tests/visual/panel-recovery/injection')
  const { useSyncExternalStore } = await import('react')
  return {
    ...actual,
    EditToolbar: (props: Parameters<typeof actual.EditToolbar>[0]) => {
      if (usePanelCrash('editing', useSyncExternalStore))
        throw new Error('test-only panel crash: editing')
      return <actual.EditToolbar {...props} />
    },
  }
})

vi.mock('./export/ExportDialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./export/ExportDialog')>()
  const { usePanelCrash } = await import('../../../tests/visual/panel-recovery/injection')
  const { useSyncExternalStore } = await import('react')
  return {
    ...actual,
    ExportDialog: (props: Parameters<typeof actual.ExportDialog>[0]) => {
      if (usePanelCrash('export', useSyncExternalStore))
        throw new Error('test-only panel crash: export')
      return <actual.ExportDialog {...props} />
    },
  }
})

vi.mock('./edit/HistoryPanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./edit/HistoryPanel')>()
  const { usePanelCrash } = await import('../../../tests/visual/panel-recovery/injection')
  const { useSyncExternalStore } = await import('react')
  return {
    ...actual,
    HistoryPanel: (props: Parameters<typeof actual.HistoryPanel>[0]) => {
      if (usePanelCrash('history', useSyncExternalStore))
        throw new Error('test-only panel crash: history')
      return <actual.HistoryPanel {...props} />
    },
  }
})

vi.mock('./validation/ValidationPanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./validation/ValidationPanel')>()
  const { usePanelCrash } = await import('../../../tests/visual/panel-recovery/injection')
  const { useSyncExternalStore } = await import('react')
  return {
    ...actual,
    ValidationPanel: (props: Parameters<typeof actual.ValidationPanel>[0]) => {
      if (usePanelCrash('validation', useSyncExternalStore))
        throw new Error('test-only panel crash: validation')
      return <actual.ValidationPanel {...props} />
    },
  }
})

vi.mock('./diff/DiffPanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./diff/DiffPanel')>()
  const { usePanelCrash } = await import('../../../tests/visual/panel-recovery/injection')
  const { useSyncExternalStore } = await import('react')
  return {
    ...actual,
    DiffPanel: (props: Parameters<typeof actual.DiffPanel>[0]) => {
      if (usePanelCrash('compare', useSyncExternalStore))
        throw new Error('test-only panel crash: compare')
      return <actual.DiffPanel {...props} />
    },
  }
})

vi.mock('./grid/FilterBar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./grid/FilterBar')>()
  const { usePanelCrash } = await import('../../../tests/visual/panel-recovery/injection')
  const { useSyncExternalStore } = await import('react')
  return {
    ...actual,
    FilterBar: (props: Parameters<typeof actual.FilterBar>[0]) => {
      if (usePanelCrash('filters', useSyncExternalStore))
        throw new Error('test-only panel crash: filters')
      return <actual.FilterBar {...props} />
    },
  }
})

vi.mock('./sql/SqlPanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sql/SqlPanel')>()
  const { usePanelCrash } = await import('../../../tests/visual/panel-recovery/injection')
  const { useSyncExternalStore } = await import('react')
  return {
    ...actual,
    SqlPanel: (props: Parameters<typeof actual.SqlPanel>[0]) => {
      if (usePanelCrash('sql', useSyncExternalStore)) throw new Error('test-only panel crash: sql')
      return <actual.SqlPanel {...props} />
    },
  }
})

vi.mock('./profile/ProfilePanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./profile/ProfilePanel')>()
  const { usePanelCrash } = await import('../../../tests/visual/panel-recovery/injection')
  const { useSyncExternalStore } = await import('react')
  return {
    ...actual,
    ProfilePanel: (props: Parameters<typeof actual.ProfilePanel>[0]) => {
      if (usePanelCrash('profile', useSyncExternalStore))
        throw new Error('test-only panel crash: profile')
      return <actual.ProfilePanel {...props} />
    },
  }
})

vi.mock('./pipeline/PipelinePanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pipeline/PipelinePanel')>()
  const { usePanelCrash } = await import('../../../tests/visual/panel-recovery/injection')
  const { useSyncExternalStore } = await import('react')
  return {
    ...actual,
    PipelinePanel: (props: Parameters<typeof actual.PipelinePanel>[0]) => {
      if (usePanelCrash('pipeline', useSyncExternalStore))
        throw new Error('test-only panel crash: pipeline')
      return <actual.PipelinePanel {...props} />
    },
  }
})

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  h.tokenRef.current = 0
  h.beginSession.mockClear()
  h.files.length = 0
  localStorage.removeItem(PANEL_CRASH_STORAGE_KEY)
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
  // WF-06 (amendment A1, setup only): from `idle` this click is the unchanged
  // legacy open; from a READY session a replacement is gated, and a dirty
  // session (staged edits) shows the reviewed guard — choosing is the only way
  // into the picker. The same mock pick then feeds either path, and the drain
  // lets the candidate prepare and adopt before the caller's assertion. No
  // assertion is touched.
  const choose = screen.queryByTestId('replace-choose')
  if (choose !== null) {
    await act(async () => {
      fireEvent.click(choose)
      for (let tick = 0; tick < 48; tick += 1) await Promise.resolve()
    })
  }
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

async function injectPanelCrash(panelId: string | null): Promise<void> {
  await act(async () => {
    setPanelCrash(panelId)
  })
}

function fallback(section: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="error-boundary-panel"][data-section="${section}"]`,
  )
  if (element === null) throw new Error(`missing panel fallback for ${section}`)
  return element
}

const TOOL_BODY_PANELS = [
  ['schema', 'schema-panel', 'inner'],
  ['editing', 'edit-toolbar', 'managed'],
  ['export', 'export-dialog', 'managed'],
  ['history', 'history-panel', 'managed'],
  ['validation', 'validation-panel', 'managed'],
  ['compare', 'diff-panel', 'managed'],
  ['filters', 'filter-bar', 'inner'],
  ['sql', 'sql-panel', 'managed'],
  ['profile', 'profile-section', 'inner'],
  ['pipeline', 'pipeline-panel', 'managed'],
] as const

describe('ug-7 panel-scoped recovery (R-06)', () => {
  it.each(TOOL_BODY_PANELS)(
    'contains the mounted %s App panel with staged edits and recovers only that body',
    async (panelId, bodyTestId, disclosure) => {
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

      if (disclosure === 'managed' && panelId !== 'editing' && panelId !== 'history') {
        fireEvent.click(screen.getByTestId(`section-toggle-${panelId}`))
      }
      if (panelId === 'export') {
        fireEvent.click(screen.getByTestId('export-open'))
        expect(screen.getByTestId('export-dialog')).toBeTruthy()
      }

      // The test-local wrapper throws from the actual component slot in App;
      // the real ErrorBoundary, section visibility and session remain in play.
      await injectPanelCrash(panelId)
      const panel = await screen.findByTestId('error-boundary-panel')
      expect(panel).toBe(fallback(panelId))
      expect(panel.getAttribute('data-section')).toBe(panelId)
      expect(panel.textContent).toBe(
        'This section could not render' +
          'The grid and staged changes remain available. The opened file was not changed.' +
          "Try again resets this section's local state. If the error returns, close the section and use another tool." +
          'Try again' +
          'Close section',
      )
      expect(panel.textContent).not.toContain(`test-only panel crash: ${panelId}`)
      expect(screen.queryByTestId('error-boundary-app')).toBeNull()
      expect(screen.getByTestId('grid')).toBeTruthy()
      if (panelId !== 'editing') {
        expect(screen.getByTestId('pending-changes').textContent).toBe(
          '2 pending changes: 2 row inserts.',
        )
      }
      expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
      if (panelId !== 'history') expect(screen.getAllByTestId('history-item')).toHaveLength(2)
      expect(h.beginSession).toHaveBeenCalledTimes(1)
      expect(h.open).toHaveBeenCalledTimes(1)

      // A deterministic/persistent crash remains contained after a first retry.
      fireEvent.click(screen.getByTestId('error-boundary-retry'))
      expect(await screen.findByTestId('error-boundary-panel')).toBe(fallback(panelId))
      expect(screen.getByTestId('grid')).toBeTruthy()
      if (panelId !== 'editing') {
        expect(screen.getByTestId('pending-changes').textContent).toBe(
          '2 pending changes: 2 row inserts.',
        )
      }
      expect(h.beginSession).toHaveBeenCalledTimes(1)
      expect(h.open).toHaveBeenCalledTimes(1)

      // Clear the transient injected fault; an explicit second retry remounts
      // the original component without reopening the dataset or losing history.
      await injectPanelCrash(null)
      fireEvent.click(screen.getByTestId('error-boundary-retry'))
      expect(await screen.findByTestId(bodyTestId)).toBeTruthy()
      expect(screen.queryByTestId('error-boundary-panel')).toBeNull()
      expect(screen.getByTestId('pending-changes').textContent).toBe(
        '2 pending changes: 2 row inserts.',
      )
      expect(screen.getAllByTestId('history-item')).toHaveLength(2)
      expect(h.beginSession).toHaveBeenCalledTimes(1)
      expect(h.open).toHaveBeenCalledTimes(1)
    },
  )
})

describe('ug-7 recoverable close/reopen (R-07)', () => {
  it('closes an inner-disclosure section, focuses its nav link, and does not retry on reopen', async () => {
    await open()
    await injectPanelCrash('filters')
    await insertRows(1, 1)
    expect(fallback('filters')).toBeTruthy()

    fireEvent.click(screen.getByTestId('error-boundary-close'))
    expect(document.getElementById('section-filters-content')?.hasAttribute('hidden')).toBe(true)
    expect(document.activeElement).toBe(screen.getByTestId('section-nav-filters'))
    // The body stays mounted (the fallback is retained, not unmounted).
    expect(fallback('filters')).toBeTruthy()

    // A now-healthy panel would recover on any auto-retry; nav reopen must
    // show the retained fallback and run nothing until the explicit action.
    await injectPanelCrash(null)
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
    await injectPanelCrash('filters')
    await insertRows(1, 1)
    expect(fallback('filters')).toBeTruthy()

    fireEvent.click(screen.getByTestId('error-boundary-close'))
    expect(document.getElementById('section-filters-content')?.hasAttribute('hidden')).toBe(true)

    // A replacement dataset is a new session. The recovery-only visibility
    // override lives in App state and survives the open flow, so it must be
    // cleared explicitly; otherwise Filters would stay hidden in new data.
    await injectPanelCrash(null)
    await chooseFile('replacement.jsonl')
    expect(h.beginSession).toHaveBeenCalledTimes(2)
    expect(document.getElementById('section-filters-content')?.hasAttribute('hidden')).toBe(false)
    // WF-06 (amendment A1, setup only): the ready subtree no longer remounts on
    // adoption (session preservation), so a panel that DID fail keeps its own
    // recovery affordance — the boundary's existing Retry is its documented
    // way back (the preceding test drives the same control). Clearing the
    // injected crash and pressing it reaches the live panel; no assertion is
    // touched.
    fireEvent.click(screen.getByTestId('error-boundary-retry'))
    expect(await screen.findByTestId('filter-bar')).toBeTruthy()
  })

  it('closes a managed section, focuses its nav link, and reopens the retained fallback', async () => {
    await open()
    await act(async () => {
      fireEvent.click(screen.getByTestId('section-toggle-history'))
    })
    await insertRows(1, 1)
    expect(screen.getAllByTestId('history-item')).toHaveLength(1)

    await injectPanelCrash('history')
    await insertRows(1, 2)
    expect(fallback('history')).toBeTruthy()

    fireEvent.click(screen.getByTestId('error-boundary-close'))
    expect(document.getElementById('section-history-content')?.hasAttribute('hidden')).toBe(true)
    expect(document.activeElement).toBe(screen.getByTestId('section-nav-history'))
    expect(fallback('history')).toBeTruthy()

    await injectPanelCrash(null)
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
    expect(screen.getByTestId('sql-input')).toBeTruthy()

    const action = screen.getAllByTestId('schema-node-action')[0]
    if (action === undefined) throw new Error('expected a nested schema action')
    fireEvent.click(action)

    await waitFor(() => {
      expect(h.query).toHaveBeenCalledTimes(1)
    })
    expect(screen.getByTestId('sql-input')).toBeTruthy()

    // Inject a render failure into the real SQL child, then retry it with the
    // SAME App-owned runRequest state.
    await injectPanelCrash('sql')
    await insertRows(1, 1)
    expect(fallback('sql')).toBeTruthy()

    await injectPanelCrash(null)
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
