// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * m4-4 component pin: the column rename/cast affordances and the honest
 * failure surfaces around them, driven through the REAL `App` composition
 * root with only the environment boundaries faked (picker + engine client).
 *
 * Pinned behaviors:
 * 1. rename success → effective header follows AND the history panel records
 *    a human-readable step AND the pending summary counts it; panel Undo
 *    restores the old name;
 * 2. rename collision → the domain's typed conflict is surfaced readably in
 *    the toolbar alert, no history entry, header unchanged;
 * 3. cast invalid spelling → refused inline via the engine validator, no op,
 *    no history entry;
 * 4. double failure (the commit refresh AND the restore refresh reject) → the
 *    alert names both failures and a Retry affordance appears; Retry after
 *    recovery clears it (carry-over b).
 */

/** Mutable engine-health flag shared with the hoisted mock factory. */
const h = vi.hoisted(() => ({ healthy: true }))

const FAKE_HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }

const FAKE_SCHEMA: readonly { name: string; type: string }[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'country', type: 'VARCHAR' },
  { name: 'income', type: 'BIGINT' },
]

function fakeBaseBatch(): ArrowTableLike {
  const columns = [{ get: () => 1 }, { get: () => 'SG' }, { get: () => 52000 }]
  return {
    numRows: 1,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
  }
}

/** Row-id column + one data row; the component test only asserts headers. */
function fakeOverlayBatch(columnCount: number): ArrowTableLike {
  const columns = [
    { get: () => 'base:fv-1:0' },
    ...Array.from({ length: columnCount }, () => ({ get: () => null })),
  ]
  return {
    numRows: 1,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
  }
}

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } }> => ({
    source: { getFile: async () => new File(['id\n1\n'], 'm4-4.jsonl') },
  }),
}))

vi.mock('./lib/engine', () => {
  interface OverlayOp {
    readonly kind: string
    readonly from?: string
    readonly to?: string
    readonly column?: string
    readonly targetType?: string
  }
  interface Overlay {
    readonly base: unknown
    readonly ops?: readonly OverlayOp[]
  }
  /** Enough of the schema fold for the test's rename/cast assertions. */
  function effectiveSchema(overlay: Overlay): { name: string; type: string }[] {
    let columns = FAKE_SCHEMA.map((column) => ({ ...column }))
    for (const op of overlay.ops ?? []) {
      if (op.kind === 'column-rename' && op.from !== undefined && op.to !== undefined) {
        columns = columns.map((column) =>
          column.name === op.from ? { name: op.to as string, type: column.type } : column,
        )
      } else if (
        op.kind === 'column-cast' &&
        op.column !== undefined &&
        op.targetType !== undefined
      ) {
        columns = columns.map((column) =>
          column.name === op.column ? { name: column.name, type: op.targetType as string } : column,
        )
      }
    }
    return columns
  }
  const unhealthy = (): never => {
    throw new Error('engine unavailable')
  }
  return {
    engineClient: {
      open: async () => FAKE_HANDLE,
      schema: async () => (h.healthy ? FAKE_SCHEMA : unhealthy()),
      rowCount: async () => (h.healthy ? 1 : unhealthy()),
      fetchRange: async () => ({
        batch: h.healthy ? fakeBaseBatch() : unhealthy(),
        hasMore: false,
      }),
      overlaySchema: async (_handle: unknown, overlay: Overlay) =>
        h.healthy ? effectiveSchema(overlay) : unhealthy(),
      overlayRowCount: async () => (h.healthy ? 1 : unhealthy()),
      fetchOverlayRange: async (_handle: unknown, overlay: Overlay) => ({
        batch: h.healthy ? fakeOverlayBatch(effectiveSchema(overlay).length) : unhealthy(),
        hasMore: false,
      }),
    },
  }
})

vi.mock('./sql/SqlPanel', () => ({ SqlPanel: () => null }))
vi.mock('./profile/ProfilePanel', () => ({ ProfilePanel: () => null }))

afterEach(() => {
  cleanup()
  h.healthy = true
})

async function openFixture(): Promise<void> {
  render(<App />)
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('schema-section')
  expect(screen.getByTestId('open-status').textContent).toBe('ready')
}

describe('column rename affordance (m4-4)', () => {
  it('renames, follows through to the grid header + history, and the panel undoes it', async () => {
    await openFixture()
    const panel = within(screen.getByTestId('schema-panel'))

    await act(async () => {
      fireEvent.click(panel.getByRole('button', { name: 'Rename column country' }))
    })
    const input = panel.getByTestId('column-rename-input')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'nation' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    // The effective grid header follows the rename.
    const headers = screen
      .getAllByTestId('grid-header-cell')
      .map((element) => element.getAttribute('data-col-name'))
    expect(headers).toEqual(['id', 'nation', 'income'])
    // History panel + pending summary record the step.
    expect(screen.getByTestId('pending-changes').textContent).toContain('1 pending change')
    expect(screen.getByTestId('pending-changes').textContent).toContain('1 column rename')
    expect(screen.getByTestId('history-description').textContent).toBe(
      'rename column "country" to "nation"',
    )

    // Panel Undo restores the old name (matches the toolbar semantics).
    await act(async () => {
      fireEvent.click(screen.getByTestId('history-undo'))
    })
    const restored = screen
      .getAllByTestId('grid-header-cell')
      .map((element) => element.getAttribute('data-col-name'))
    expect(restored).toEqual(['id', 'country', 'income'])
    expect(screen.getByTestId('pending-changes').textContent).toBe('No pending changes.')
  })

  it('surfaces a rename collision as a typed conflict and changes nothing', async () => {
    await openFixture()
    const panel = within(screen.getByTestId('schema-panel'))

    await act(async () => {
      fireEvent.click(panel.getByRole('button', { name: 'Rename column country' }))
    })
    const input = panel.getByTestId('column-rename-input')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'income' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(screen.getByTestId('edit-error').textContent).toContain('already exists')
    // No history entry; the schema is unchanged.
    expect(screen.queryByTestId('history-description')).toBeNull()
    const headers = screen
      .getAllByTestId('grid-header-cell')
      .map((element) => element.getAttribute('data-col-name'))
    expect(headers).toEqual(['id', 'country', 'income'])
  })

  it('refuses an invalid cast spelling before composing an op', async () => {
    await openFixture()
    const panel = within(screen.getByTestId('schema-panel'))

    await act(async () => {
      fireEvent.click(panel.getByRole('button', { name: 'Cast column income' }))
    })
    await act(async () => {
      fireEvent.change(panel.getByTestId('column-cast-select'), {
        target: { value: '__custom__' },
      })
    })
    await act(async () => {
      fireEvent.change(panel.getByTestId('column-cast-custom'), {
        target: { value: 'MAP(INTEGER)' },
      })
    })
    await act(async () => {
      fireEvent.click(panel.getByTestId('column-cast-commit'))
    })

    expect(screen.getByTestId('column-op-error').textContent).toContain('not a valid column type')
    expect(screen.getByTestId('pending-changes').textContent).toBe('No pending changes.')
    expect(screen.queryByTestId('history-description')).toBeNull()
  })
})

describe('double-failure honesty + recoverable grid (m4-3 carry-over b)', () => {
  it('names both failures, offers Retry, and recovers when the engine returns', async () => {
    await openFixture()
    const panel = within(screen.getByTestId('schema-panel'))

    // The next commit's refresh AND its rollback refresh will both reject.
    h.healthy = false
    await act(async () => {
      fireEvent.click(panel.getByRole('button', { name: 'Rename column country' }))
    })
    const input = panel.getByTestId('column-rename-input')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'nation' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    const alert = screen.getByTestId('edit-error')
    expect(alert.textContent).toContain('Restoring the previous view also failed')
    expect(screen.getByTestId('view-error')).toBeTruthy()
    const retry = screen.getByTestId('view-retry')

    // Engine recovers → Retry reloads the previous (clean) view.
    h.healthy = true
    await act(async () => {
      fireEvent.click(retry)
    })
    expect(screen.queryByTestId('view-error')).toBeNull()
    expect(screen.getByTestId('grid-total-rows').textContent).toBe('1')
  })
})
