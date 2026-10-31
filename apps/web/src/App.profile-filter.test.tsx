// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GridViewportModel } from '@assay/grid'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * ug-16 click-to-act wiring pins through the REAL App composition root with
 * only the picker/engine boundaries faked (the `App.profile-honesty` posture).
 * The real `ProfilePanel` is loaded through `preloadBottomPanels`, so these
 * tests prove the whole bridge: profile click → resolve base name against the
 * active ops + effective schema → compile with the grid builder → the EXACT
 * predicate handed to `GridViewportModel.setFilters`, or a byte-exact refusal
 * with no filter and no engine call.
 *
 * Copy is pinned as literals, never imported from the component.
 */

const RENAMED =
  'This column is now "nation" in the edited view. The profile still uses the file\'s original name, "country" — use "nation" in Filters instead.'

const FAKE_HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }

const FAKE_SCHEMA: readonly { name: string; type: string }[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'country', type: 'VARCHAR' },
  { name: 'income', type: 'BIGINT' },
]

const FAKE_PROFILE = {
  rowCount: 1,
  columns: [
    {
      name: 'country',
      type: 'VARCHAR',
      kind: 'categorical' as const,
      nullCount: 0,
      distinctCount: 1,
      categorical: { topK: [{ value: 'SG', count: 1 }] },
    },
    {
      name: 'income',
      type: 'BIGINT',
      kind: 'numeric' as const,
      nullCount: 1,
      distinctCount: 0,
      numeric: {
        min: null,
        max: null,
        mean: null,
        stddev: null,
        quantiles: { p50: null, p90: null, p95: null, p99: null },
      },
    },
  ],
}

const h = vi.hoisted(() => ({
  profile: vi.fn(),
  /** Filters carried by each `overlayRowCount` request (the engine's view). */
  filterRequests: [] as (readonly { column: string; predicate: string }[] | undefined)[],
  /** Rows the filtered view reports (zero-row honest empty state). */
  filteredRows: 1,
  /** One-shot: the next filtered count rejects (engine rejection + rollback). */
  failFilteredCountOnce: false,
}))

function fakeBaseBatch(): ArrowTableLike {
  const columns = [{ get: () => 1 }, { get: () => 'SG' }, { get: () => 52000 }]
  return {
    numRows: 1,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
  }
}

function fakeOverlayBatch(columnCount: number, numRows: number): ArrowTableLike {
  const columns = [
    { get: () => 'base:fv-1:0' },
    ...Array.from({ length: columnCount }, () => ({ get: () => null })),
  ]
  return {
    numRows,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
  }
}

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } }> => ({
    source: { getFile: async () => new File(['id\n1\n'], 'ug16.jsonl') },
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
  /** Enough of the schema fold for the rename/cast assertions. */
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
  interface CountOptions {
    readonly filters?: readonly { column: string; predicate: string }[]
  }
  return {
    engineClient: {
      open: async () => FAKE_HANDLE,
      schema: async () => FAKE_SCHEMA,
      rowCount: async () => 1,
      fetchRange: async () => ({ batch: fakeBaseBatch(), hasMore: false }),
      overlaySchema: async (_handle: unknown, overlay: Overlay) => effectiveSchema(overlay),
      overlayRowCount: async (_handle: unknown, _overlay: Overlay, options?: CountOptions) => {
        h.filterRequests.push(options?.filters)
        if (options?.filters !== undefined && h.failFilteredCountOnce) {
          h.failFilteredCountOnce = false
          throw new Error('engine unavailable')
        }
        return options?.filters === undefined ? 1 : h.filteredRows
      },
      overlayCastCheck: async () => ({ hasNonConvertibleValues: false }),
      fetchOverlayRange: async (_handle: unknown, overlay: Overlay, request?: CountOptions) => ({
        batch: fakeOverlayBatch(
          effectiveSchema(overlay).length,
          request?.filters === undefined ? 1 : h.filteredRows,
        ),
        hasMore: false,
      }),
      profile: h.profile,
    },
  }
})

afterEach(cleanup)
beforeEach(() => {
  h.profile.mockReset()
  h.profile.mockResolvedValue(FAKE_PROFILE)
  h.filterRequests.length = 0
  h.filteredRows = 1
  h.failFilteredCountOnce = false
})

async function openFixture(): Promise<void> {
  render(<App />)
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('schema-section')
  expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
}

function expandProfile(): void {
  fireEvent.click(screen.getByTestId('profile-toggle'))
  expect(screen.getByTestId('profile-toggle').getAttribute('aria-expanded')).toBe('true')
}

async function computeProfile(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('profile-run'))
  })
  await screen.findByTestId('profile-rowcount')
}

async function renameColumn(from: string, to: string): Promise<void> {
  const panel = within(screen.getByTestId('schema-panel'))
  await act(async () => {
    fireEvent.click(panel.getByRole('button', { name: `Rename column ${from}` }))
  })
  const input = panel.getByTestId('column-rename-input')
  await act(async () => {
    fireEvent.change(input, { target: { value: to } })
    fireEvent.keyDown(input, { key: 'Enter' })
  })
}

async function castColumn(column: string, target: string): Promise<void> {
  const panel = within(screen.getByTestId('schema-panel'))
  await act(async () => {
    fireEvent.click(panel.getByRole('button', { name: `Cast column ${column}` }))
  })
  await act(async () => {
    fireEvent.change(panel.getByTestId('column-cast-select'), { target: { value: target } })
  })
  await act(async () => {
    fireEvent.click(panel.getByTestId('column-cast-commit'))
  })
}

function topKButton(column: string, value: string): HTMLElement {
  return within(
    screen
      .getByTestId('profile-panel')
      .querySelector<HTMLElement>(
        `[data-testid="profile-column"][data-col-name="${column}"]`,
      ) as HTMLElement,
  ).getByRole('button', { name: `Filter ${column} to ${value}` })
}

describe('ug-16 — top-k value click applies the builder-compiled predicate', () => {
  it("hands `= 'SG'` on the resolved column to setFilters and the engine sees it", async () => {
    const setFilters = vi.spyOn(GridViewportModel.prototype, 'setFilters')
    await openFixture()
    expandProfile()
    await computeProfile()

    await act(async () => {
      fireEvent.click(topKButton('country', 'SG'))
    })

    expect(setFilters).toHaveBeenCalledTimes(1)
    expect(setFilters.mock.calls[0]?.[0]).toEqual([{ column: 'country', predicate: "= 'SG'" }])
    // The same predicate is what the engine/provider is asked to count under.
    expect(h.filterRequests.at(-1)).toEqual([{ column: 'country', predicate: "= 'SG'" }])
    expect(screen.queryByTestId('profile-filter-refusal')).toBeNull()
    expect(screen.queryByTestId('profile-filter-error')).toBeNull()
    vi.restoreAllMocks()
  })

  it('hands `IS NULL` for a null-count click', async () => {
    const setFilters = vi.spyOn(GridViewportModel.prototype, 'setFilters')
    await openFixture()
    expandProfile()
    await computeProfile()

    const income = within(
      screen
        .getByTestId('profile-panel')
        .querySelector<HTMLElement>(
          '[data-testid="profile-column"][data-col-name="income"]',
        ) as HTMLElement,
    )
    await act(async () => {
      fireEvent.click(income.getByRole('button', { name: 'Filter income where null' }))
    })

    expect(setFilters).toHaveBeenCalledTimes(1)
    expect(setFilters.mock.calls[0]?.[0]).toEqual([{ column: 'income', predicate: 'IS NULL' }])
    expect(h.filterRequests.at(-1)).toEqual([{ column: 'income', predicate: 'IS NULL' }])
    vi.restoreAllMocks()
  })

  it('keeps the existing empty state when the resolved filter matches zero rows', async () => {
    h.filteredRows = 0
    await openFixture()
    expandProfile()
    await computeProfile()
    expect(h.profile).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.click(topKButton('country', 'SG'))
    })

    // The honest existing empty state only: zero total, no rows, no new copy,
    // no fallback, and no re-profile.
    expect(screen.getByTestId('grid-total-rows').textContent).toBe('0')
    expect(screen.queryAllByTestId('grid-row')).toHaveLength(0)
    expect(screen.queryByTestId('profile-filter-refusal')).toBeNull()
    expect(screen.queryByTestId('profile-filter-error')).toBeNull()
    expect(screen.getByTestId('profile-section').getAttribute('data-state')).toBe('done')
    expect(h.profile).toHaveBeenCalledTimes(1)
  })
})

describe('ug-16 — base-derived stats refuse rather than remap', () => {
  it('refuses a renamed column with the byte-exact copy, applying no filter', async () => {
    const setFilters = vi.spyOn(GridViewportModel.prototype, 'setFilters')
    await openFixture()
    expandProfile()
    await computeProfile()

    await renameColumn('country', 'nation')

    await act(async () => {
      fireEvent.click(topKButton('country', 'SG'))
    })

    // No filter state change and no engine call — never a silent remap. This
    // is asserted before the copy so a mutant that applies the base-name
    // filter fails on the safety property, not on the message.
    expect(setFilters).not.toHaveBeenCalled()
    expect(screen.queryAllByTestId('filter-chip')).toHaveLength(0)
    const refusal = screen.getByTestId('profile-filter-refusal')
    expect(refusal.getAttribute('role')).toBe('status')
    expect(refusal.textContent).toBe(RENAMED)
    // R-16 pins survive alongside the refusal.
    expect(screen.getByTestId('profile-standing-hint').textContent).toBe(
      'Statistics describe the file as opened — staged changes are not included.',
    )
    expect(screen.getByTestId('profile-staged-note').textContent).toBe(
      '1 staged change is not reflected here — the grid uses the edited view. Validation must be run explicitly against the edited view.',
    )
    vi.restoreAllMocks()
  })

  it('clears the refusal on undo/redo and on the next click', async () => {
    await openFixture()
    expandProfile()
    await computeProfile()

    // Two active renames keep a redo available: country→nation→land.
    await renameColumn('country', 'nation')
    await renameColumn('nation', 'land')
    await act(async () => {
      fireEvent.click(screen.getByTestId('history-undo'))
    })

    // Cursor 1 (only country→nation active): the click refuses with `nation`.
    await act(async () => {
      fireEvent.click(topKButton('country', 'SG'))
    })
    expect(screen.getByTestId('profile-filter-refusal').textContent).toBe(
      'This column is now "nation" in the edited view. The profile still uses the file\'s original name, "country" — use "nation" in Filters instead.',
    )

    // Redo moves the cursor to 2: the stale refusal is dropped.
    await act(async () => {
      fireEvent.click(screen.getByTestId('history-redo'))
    })
    expect(screen.queryByTestId('profile-filter-refusal')).toBeNull()

    // Clicking again at cursor 2 re-resolves (country→land).
    await act(async () => {
      fireEvent.click(topKButton('country', 'SG'))
    })
    expect(screen.getByTestId('profile-filter-refusal').textContent).toBe(
      'This column is now "land" in the edited view. The profile still uses the file\'s original name, "country" — use "land" in Filters instead.',
    )

    // Undo back to cursor 1 also drops the refusal before any click.
    await act(async () => {
      fireEvent.click(screen.getByTestId('history-undo'))
    })
    expect(screen.queryByTestId('profile-filter-refusal')).toBeNull()
  })

  it('applies a resolved filter after the rename is undone (refusal never sticks)', async () => {
    const setFilters = vi.spyOn(GridViewportModel.prototype, 'setFilters')
    await openFixture()
    expandProfile()
    await computeProfile()
    await renameColumn('country', 'nation')

    await act(async () => {
      fireEvent.click(topKButton('country', 'SG'))
    })
    expect(screen.getByTestId('profile-filter-refusal').textContent).toBe(RENAMED)

    await act(async () => {
      fireEvent.click(screen.getByTestId('history-undo'))
    })
    expect(screen.queryByTestId('profile-filter-refusal')).toBeNull()

    // The next click resolves `country` as itself again and applies the filter.
    await act(async () => {
      fireEvent.click(topKButton('country', 'SG'))
    })
    expect(screen.queryByTestId('profile-filter-refusal')).toBeNull()
    expect(setFilters).toHaveBeenCalledTimes(1)
    expect(setFilters.mock.calls[0]?.[0]).toEqual([{ column: 'country', predicate: "= 'SG'" }])
    vi.restoreAllMocks()
  })

  it('refuses a cast type mismatch with the builder message and no engine call', async () => {
    const setFilters = vi.spyOn(GridViewportModel.prototype, 'setFilters')
    await openFixture()
    expandProfile()
    await computeProfile()

    // The base profile's top-k value is a string; the edited view casts the
    // column to BIGINT. The builder must reject — never coerce, never remap.
    await castColumn('country', 'BIGINT')
    const header = screen
      .getAllByTestId('grid-header-cell')
      .find((element) => element.getAttribute('data-col-name') === 'country')
    expect(header?.getAttribute('data-col-type')).toBe('BIGINT')

    await act(async () => {
      fireEvent.click(topKButton('country', 'SG'))
    })

    expect(screen.getByTestId('profile-filter-refusal').textContent).toBe('That is not a number.')
    expect(setFilters).not.toHaveBeenCalled()
    expect(screen.queryAllByTestId('filter-chip')).toHaveLength(0)
    vi.restoreAllMocks()
  })

  it('surfaces the framed filter error and rolls back when the engine rejects the apply', async () => {
    const setFilters = vi.spyOn(GridViewportModel.prototype, 'setFilters')
    h.failFilteredCountOnce = true
    await openFixture()
    expandProfile()
    await computeProfile()

    await act(async () => {
      fireEvent.click(topKButton('country', 'SG'))
    })

    // The apply rejected, the previous (empty) filter list was restored, and
    // the existing framed `filter` copy is shown as an alert.
    expect(setFilters).toHaveBeenCalledTimes(2)
    expect(setFilters.mock.calls[1]?.[0]).toEqual([])
    expect(screen.getByTestId('profile-filter-error').textContent).toBe(
      'The filter could not be applied: engine unavailable. The previous filters are still in effect.',
    )
    expect(screen.getByTestId('profile-filter-error').getAttribute('role')).toBe('alert')
    expect(screen.getByTestId('grid-total-rows').textContent).toBe('1')
    vi.restoreAllMocks()
  })
})
