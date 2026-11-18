// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * EW-04I — the column-repair surface wired into the REAL `App` composition
 * root (the `App.csv-review` / `App.column-ops` posture): only the picker and
 * the engine client are faked, so the dialog, the plan model, the domain
 * refusals, the history/undo machinery and the session's commit boundary are
 * all real code.
 *
 * What is pinned here, one observable per claim:
 *
 * 1. **Entry + capture refusals without an engine call** — a non-text column is
 *    refused by the domain and `query`/`fetchOverlayRange` are never called.
 * 2. **Preview** — the complete counts (engine count scan + the pure fold),
 *    the stated example cap, and before/after text, with the count's SQL shown
 *    to carry the plan predicate.
 * 3. **Apply** — one history entry, one undo step, one redo; the entry's
 *    description is plan-shape only (ADR 0025) and dirty follows the applied
 *    outcome.
 * 4. **U2 at the surface** — a session change after the preview marks it stale,
 *    disables Apply and appends nothing (the commit-boundary half is
 *    `useEditingSession.repair.test.tsx`).
 * 5. **U1 at the surface** — a zero-affected preview is refused with the honest
 *    sentence and no entry.
 * 6. **U3** — two previews settle out of order; the newer one is what is shown
 *    and what Apply publishes.
 * 7. **Budget (D4 a)** — over-envelope projections are refused before any read.
 *
 * Copy is asserted as independent literals (never imported from `repair/copy`).
 */

const SCOPE =
  'This repair reads the whole column: every row in the session, including rows the grid is filtering out. Sorting, filtering and paging never change what it reaches. Nothing is applied until you choose Apply repair.'

const ENTRY = 'Repair a column…'
const STALE =
  'This preview is out of date: an edit, an undo or a different file version landed after it was read. Preview again before applying — nothing was applied.'
const ZERO_AFFECTED =
  'No row changes under this plan, so nothing was applied and the history is unchanged.'
const NOT_TEXT =
  'That column is not a text column, so a repair cannot target it: only VARCHAR, TEXT and STRING can be repaired. Character and ENUM columns are refused because a trim would re-declare their type.'

const SCHEMA = [
  { name: 'id', type: 'BIGINT' },
  { name: 'country', type: 'VARCHAR' },
  { name: 'income', type: 'BIGINT' },
]

interface CountCall {
  readonly sql: string
  release: () => void
}

interface ExampleCall {
  readonly columns: readonly string[] | undefined
  readonly endRow: number | undefined
  readonly filters: readonly { readonly column: string; readonly predicate: string }[] | undefined
  readonly includeRowIds: boolean | undefined
}

interface VirtualItem {
  index: number
  key: string
  start: number
  size: number
}

const h = vi.hoisted(() => ({
  rows: [{ index: 0, key: '0', start: 0, size: 28 }] as VirtualItem[],
  rowCount: 5,
  /** The affected count the fake count scan answers (per call, in order). */
  affectedQueue: [] as number[],
  affected: 0,
  /** When true, a count scan is held until the test releases it. */
  gateCounts: false,
  countCalls: [] as CountCall[],
  exampleCalls: [] as ExampleCall[],
  exampleRows: [] as { rowId: string; value: string }[],
  nextTableId: 1,
  events: [] as string[],
}))

function fakeBatch(): ArrowTableLike {
  const cells = SCHEMA.map((_column, index) => ({ get: () => (index === 0 ? 1 : 'x') }))
  return {
    numRows: 1,
    numCols: cells.length,
    getChildAt: (index: number) => cells[index] ?? null,
  }
}

/** A one-row/one-column batch carrying the affected count as a BIGINT. */
function countBatch(value: number): ArrowTableLike {
  return {
    numRows: 1,
    numCols: 1,
    getChildAt: () => ({ get: () => BigInt(value) }),
  }
}

/** The bounded example window: `assay_row_id` first, then the value. */
function exampleBatch(rows: readonly { rowId: string; value: string }[]): ArrowTableLike {
  const ids = rows.map((row) => row.rowId)
  const values = rows.map((row) => row.value)
  return {
    numRows: rows.length,
    numCols: 2,
    getChildAt: (index: number) => {
      const source = index === 0 ? ids : values
      return { get: (rowIndex: number) => source[rowIndex] ?? null }
    },
  }
}

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => h.rows,
    getTotalSize: () => h.rows.length * 28,
    scrollToIndex: vi.fn(),
  }),
}))

vi.mock('@assay/data-sources/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assay/data-sources/browser')>()
  return {
    ...actual,
    pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } }> => {
      const file = new File(['id,country,income\n1,SG,52000\n'], 'customers.csv')
      return { source: { getFile: async () => file } }
    },
  }
})

vi.mock('./sessions/session-reset', () => ({
  useDatasetSession: () => {
    const session = {
      tokenRef: { current: 1 },
      beginSession: () => 1,
      registerReset: () => () => {},
    }
    return session
  },
}))

vi.mock('./lib/engine', () => {
  const engineClient = {
    open: async () => {
      const id = `t${String(h.nextTableId)}`
      h.nextTableId += 1
      return { kind: 'table', id }
    },
    query: (sql: string): Promise<{ batch: ArrowTableLike; hasMore: boolean }> => {
      const next = h.affectedQueue.shift()
      const value = next ?? h.affected
      const call: CountCall = {
        sql,
        release: () => {},
      }
      if (!h.gateCounts) {
        h.countCalls.push(call)
        return Promise.resolve({ batch: countBatch(value), hasMore: false })
      }
      // Held: the test settles this scan by index.
      return new Promise((resolve) => {
        call.release = () => {
          resolve({ batch: countBatch(value), hasMore: false })
        }
        h.countCalls.push(call)
      })
    },
    schema: async () => SCHEMA,
    rowCount: async () => h.rowCount,
    fetchRange: async () => ({ batch: fakeBatch(), hasMore: false }),
    overlaySchema: async () => SCHEMA,
    overlayRowCount: async () => h.rowCount,
    fetchOverlayRange: async (
      _handle: unknown,
      _overlay: unknown,
      window: ExampleCall,
    ): Promise<{ batch: ArrowTableLike; hasMore: boolean }> => {
      // The repair's example read is the only one carrying filters.
      if (window.filters === undefined) return { batch: fakeBatch(), hasMore: false }
      h.exampleCalls.push({
        columns: window.columns,
        endRow: window.endRow,
        filters: window.filters,
        includeRowIds: window.includeRowIds,
      })
      return { batch: exampleBatch(h.exampleRows), hasMore: false }
    },
    overlayCastCheck: async () => ({ hasNonConvertibleValues: false }),
    exportView: async () => ({ path: 'p', format: 'csv', rowCount: 0, bytes: 0 }),
    dispose: async () => undefined,
    csvPreview: async () => null,
  }
  return { engineClient }
})

vi.mock('./profile/ProfilePanel', () => ({ ProfilePanel: () => null }))

function fakeRuntime(): Record<string, unknown> {
  return {
    surface: 'web',
    hardOff: false,
    endpointConfigured: false,
    emit: (name: string) => {
      h.events.push(name)
    },
    flush: async () => undefined,
    getPreference: () => 'off',
    setPreference: () => undefined,
    isEnabledNow: () => false,
    shouldShowDisclosure: () => false,
    markDisclosureShown: () => undefined,
    dispose: () => undefined,
  }
}

beforeEach(() => {
  h.rows = [{ index: 0, key: '0', start: 0, size: 28 }]
  h.rowCount = 5
  h.affectedQueue = []
  h.affected = 0
  h.gateCounts = false
  h.countCalls = []
  h.exampleCalls = []
  h.exampleRows = []
  h.nextTableId = 1
  h.events = []
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function waitForReady(): Promise<void> {
  await waitFor(
    () => {
      expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
    },
    { timeout: 5000 },
  )
}

/** Open the fixture and reveal the Editing section (which owns the entry). */
async function openAndRevealEditing(): Promise<void> {
  render(<App telemetry={fakeRuntime() as never} />)
  await waitFor(() => {
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('idle')
  })
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await waitForReady()
  const toggle = screen.getByTestId('section-toggle-editing')
  if (toggle.getAttribute('aria-expanded') !== 'true') {
    await act(async () => {
      fireEvent.click(toggle)
    })
  }
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
}

async function openDialog(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('repair-open'))
  })
  await screen.findByTestId('repair')
}

async function authorPlan(input: {
  column: string
  mapping: string
  trim?: 'none' | 'default'
}): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByTestId('repair-column'), { target: { value: input.column } })
  })
  if (input.trim === 'default') {
    await act(async () => {
      fireEvent.change(screen.getByTestId('repair-trim-mode'), { target: { value: 'default' } })
    })
  }
  await act(async () => {
    fireEvent.change(screen.getByTestId('repair-mapping'), { target: { value: input.mapping } })
  })
}

async function runPreview(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('repair-preview'))
  })
  await waitFor(() => {
    const ready =
      screen.queryByTestId('repair-count-affected') !== null ||
      screen.queryByTestId('repair-preview-failed') !== null
    expect(ready).toBe(true)
  })
}

function text(testId: string): string {
  return screen.getByTestId(testId).textContent ?? ''
}

describe('repair — capture refusals land without an engine call', () => {
  it('offers the entry in the editing surface and states the whole-column scope', async () => {
    await openAndRevealEditing()
    expect(screen.getByTestId('repair-open').textContent).toBe(ENTRY)
    await openDialog()
    expect(text('repair-scope')).toBe(SCOPE)
    // Nothing has been read to open the surface.
    expect(h.countCalls).toHaveLength(0)
    expect(h.exampleCalls).toHaveLength(0)
  })

  it('refuses a non-text column with the domain’s sentence and never calls the engine', async () => {
    await openAndRevealEditing()
    await openDialog()
    await authorPlan({ column: 'income', mapping: 'a => b' })

    expect(text('repair-refusal')).toBe(NOT_TEXT)
    const preview = screen.getByTestId('repair-preview')
    expect(preview).toHaveProperty('disabled', true)

    await act(async () => {
      fireEvent.click(preview)
    })
    // No count scan, no example read: the fold decided.
    expect(h.countCalls).toHaveLength(0)
    expect(h.exampleCalls).toHaveLength(0)
  })

  it('refuses a malformed line and a repeated left-hand value before any read', async () => {
    await openAndRevealEditing()
    await openDialog()
    await authorPlan({ column: 'country', mapping: 'no arrow here' })
    expect(text('repair-refusal')).toBe(
      'Each line must read value => replacement. A line without => is refused.',
    )
    await authorPlan({ column: 'country', mapping: 'SG => Singapore\nSG => Singapura' })
    expect(text('repair-refusal')).toBe(
      'Two lines use the same left-hand value. Each value may appear in the mapping once.',
    )
    expect(h.countCalls).toHaveLength(0)
  })
})

describe('repair — the preview: complete counts, bounded stated examples', () => {
  it('shows the counts, the cap and the before/after pairs over the whole column', async () => {
    h.affectedQueue = [2]
    h.exampleRows = [
      { rowId: 'base:fv-11-1200#0', value: 'SG' },
      { rowId: 'base:fv-11-1200#2', value: ' SG ' },
    ]
    await openAndRevealEditing()
    await openDialog()
    await authorPlan({ column: 'country', mapping: 'SG => Singapore', trim: 'default' })
    await runPreview()

    expect(text('repair-count-scanned')).toBe('5')
    expect(text('repair-count-affected')).toBe('2')
    expect(text('repair-count-unaffected')).toBe('3')
    expect(text('repair-count-note')).toBe(
      'Counted over the whole column in one pass. Grid filters and sorting do not narrow these numbers.',
    )
    // Both changed rows are shown, so the cap sentence says "all".
    expect(text('repair-example-cap')).toBe('All 2 changed rows are shown.')

    const rows = screen.getAllByTestId('repair-example')
    expect(rows).toHaveLength(2)
    // Row labels are the anchor-free grammar: never the opaque host anchors.
    expect(screen.getAllByTestId('repair-example-row').map((cell) => cell.textContent)).toEqual([
      'base #0',
      'base #2',
    ])
    const befores = screen.getAllByTestId('repair-example-before').map((cell) => cell.textContent)
    const afters = screen.getAllByTestId('repair-example-after').map((cell) => cell.textContent)
    expect(befores).toEqual(['SG', ' SG '])
    expect(afters).toEqual(['Singapore', 'Singapore'])
    // The example window is a stated LIMIT of 10 rows carrying the row id.
    expect(h.exampleCalls[0]?.endRow).toBe(10)
    expect(h.exampleCalls[0]?.includeRowIds).toBe(true)
    expect(h.exampleCalls[0]?.columns).toEqual(['country'])
  })

  it('states "the first N of K" when more rows change than are shown, and counts engine-side', async () => {
    h.affectedQueue = [13]
    h.exampleRows = Array.from({ length: 10 }, (_, index) => ({
      rowId: `base:fv-11-1200#${String(index)}`,
      value: 'SG',
    }))
    await openAndRevealEditing()
    await openDialog()
    await authorPlan({ column: 'country', mapping: 'SG => Singapore' })
    await runPreview()

    expect(text('repair-count-affected')).toBe('13')
    expect(text('repair-count-unaffected')).toBe('0')
    expect(text('repair-example-cap')).toBe('Showing the first 10 of 13 changed rows.')
    expect(screen.getAllByTestId('repair-example')).toHaveLength(10)

    // The complete count is one `count(*)` under the plan predicate over the
    // engine-composed effective relation — not a host-side row walk.
    const sql = h.countCalls[0]?.sql ?? ''
    expect(sql).toContain('SELECT count(*)::BIGINT AS affected FROM (')
    // The exact predicate: the pair-set cancellation term plus the key list.
    expect(sql).toContain(
      'WHERE ("country" IS NOT NULL AND ' +
        '("country", "country") NOT IN (VALUES (\'SG\', \'Singapore\')) AND ' +
        '("country" IN (\'SG\') OR "country" <> "country"))',
    )
    // The example read carries the SAME predicate (one source).
    expect(h.exampleCalls[0]?.filters?.[0]?.predicate).toBe(
      'IS NOT NULL AND ("country", "country") NOT IN (VALUES (\'SG\', \'Singapore\')) ' +
        'AND ("country" IN (\'SG\') OR "country" <> "country")',
    )
  })
})

describe('repair — Apply is one history entry and one undo step', () => {
  it('appends exactly one entry, undoes with one step (refold) and redoes', async () => {
    h.affectedQueue = [2]
    h.exampleRows = [{ rowId: 'base:fv-11-1200#0', value: 'SG' }]
    await openAndRevealEditing()
    await openDialog()
    await authorPlan({ column: 'country', mapping: 'SG => Singapore' })
    await runPreview()

    await act(async () => {
      fireEvent.click(screen.getByTestId('repair-apply'))
    })
    // The surface closes with the publication it made.
    await waitFor(() => {
      expect(screen.queryByTestId('repair')).toBeNull()
    })

    expect(screen.getAllByTestId('history-item')).toHaveLength(1)
    // Plan shape only: the column and the pair count, never a mapping entry
    // (ADR 0025 / `describeOp`).
    expect(text('history-description')).toBe('repair column "country" (1 mapping pairs)')
    expect(text('history-cursor')).toBe('Step 1 of 1 applied')
    expect(text('pending-changes')).toContain('1 column repair')

    // One undo step takes the whole repair out of the active prefix; the entry
    // stays in the log as the redo tail (a cursor move, never an inverse).
    await act(async () => {
      fireEvent.click(screen.getByTestId('history-undo'))
    })
    await waitFor(() => {
      expect(text('history-cursor')).toBe('Step 0 of 1 applied')
    })
    expect(screen.getByTestId('history-item').getAttribute('data-applied')).toBe('false')

    await act(async () => {
      fireEvent.click(screen.getByTestId('history-redo'))
    })
    await waitFor(() => {
      expect(text('history-cursor')).toBe('Step 1 of 1 applied')
    })
    expect(screen.getByTestId('history-item').getAttribute('data-applied')).toBe('true')
  })

  it('U2: a session change after the preview marks it stale and publishes nothing', async () => {
    h.affectedQueue = [2, 2]
    h.exampleRows = [{ rowId: 'base:fv-11-1200#0', value: 'SG' }]
    await openAndRevealEditing()
    await openDialog()
    await authorPlan({ column: 'country', mapping: 'SG => Singapore' })
    await runPreview()
    expect(screen.getByTestId('repair-apply')).toHaveProperty('disabled', false)
    // Control: an untouched session shows no stale note.
    expect(screen.queryByTestId('repair-preview-stale')).toBeNull()

    // A real history change now lands (a row insert through the editing
    // toolbar). The preview's captured revision is no longer the live one, so
    // the surface must mark it and refuse to apply it — the cast-path
    // stale-at-render rule, applied to the repair.
    await act(async () => {
      fireEvent.click(screen.getByTestId('edit-insert-row'))
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('history-item')).toHaveLength(1)
    })
    expect(text('repair-preview-stale')).toBe(STALE)
    expect(screen.getByTestId('repair-apply')).toHaveProperty('disabled', true)
    expect(text('repair-apply-blocked')).toBe(STALE)

    // Clicking the (disabled) Apply appends nothing: the history keeps exactly
    // the one row-insert entry.
    await act(async () => {
      fireEvent.click(screen.getByTestId('repair-apply'))
    })
    expect(screen.getAllByTestId('history-item')).toHaveLength(1)
    expect(text('history-cursor')).toBe('Step 1 of 1 applied')

    // The honest exit: preview again. A fresh capture is not stale.
    await runPreview()
    expect(screen.queryByTestId('repair-preview-stale')).toBeNull()
    expect(screen.getByTestId('repair-apply')).toHaveProperty('disabled', false)
  })

  it('U1: a zero-affected preview refuses Apply and appends nothing', async () => {
    h.affectedQueue = [0]
    h.exampleRows = []
    await openAndRevealEditing()
    await openDialog()
    await authorPlan({ column: 'country', mapping: 'ZZ => nothing' })
    await runPreview()

    expect(text('repair-count-affected')).toBe('0')
    expect(text('repair-count-unaffected')).toBe('5')
    expect(screen.getByTestId('repair-apply')).toHaveProperty('disabled', true)
    expect(text('repair-apply-blocked')).toBe(ZERO_AFFECTED)
    expect(text('repair-examples-none')).toBe(
      'No row changes under this plan, so there is nothing to show.',
    )
    // No history entry was appended for the refused plan.
    expect(screen.getByTestId('history-empty')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByTestId('repair-apply'))
    })
    expect(screen.getByTestId('history-empty')).toBeTruthy()
  })

  it('U3: an older preview settling last publishes neither value nor plan', async () => {
    // Preview 1 answers 2 affected rows, preview 2 answers 13 — the reads are
    // held so the test controls their order.
    h.gateCounts = true
    h.affectedQueue = [2, 13]
    h.exampleRows = [{ rowId: 'base:fv-11-1200#0', value: 'SG' }]
    await openAndRevealEditing()
    await openDialog()

    // Preview 1 (one pair), then edit the plan and preview again (two pairs).
    await authorPlan({ column: 'country', mapping: 'SG => Singapore' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('repair-preview'))
    })
    await authorPlan({ column: 'country', mapping: 'SG => Singapore\nUS => United States' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('repair-preview'))
    })
    expect(h.countCalls).toHaveLength(2)

    // The NEWER read settles first, then the older one arrives late.
    await act(async () => {
      h.countCalls[1]?.release()
    })
    await waitFor(() => {
      expect(screen.queryByTestId('repair-count-affected')).not.toBeNull()
    })
    expect(text('repair-count-affected')).toBe('13')
    await act(async () => {
      h.countCalls[0]?.release()
    })

    // The late result neither overwrote the counts nor the previewed plan.
    expect(text('repair-count-affected')).toBe('13')
    await act(async () => {
      fireEvent.click(screen.getByTestId('repair-apply'))
    })
    await waitFor(() => {
      expect(screen.queryByTestId('repair')).toBeNull()
    })
    // Exactly one entry, and it is the NEWER plan (two pairs), not the stale one.
    expect(screen.getAllByTestId('history-item')).toHaveLength(1)
    expect(text('history-description')).toBe('repair column "country" (2 mapping pairs)')
  })
})

describe('repair — the published envelope is refused pre-apply', () => {
  it('refuses over-envelope projections before any read (D4 option (a))', async () => {
    h.rowCount = 2_000_000
    h.affected = 0
    await openAndRevealEditing()
    await openDialog()

    // 501 pairs × 2,000,000 rows = 1.002e9 > 1e9.
    const pairs = Array.from({ length: 501 }, (_, index) => `k${String(index)} => v`).join('\n')
    await authorPlan({ column: 'country', mapping: pairs })

    expect(text('repair-budget-refusal')).toBe(
      'This plan would cost 2000000 rows × 501 mapping pairs = 1,002,000,000 cell rewrites, ' +
        'over the published envelope of 1,000,000,000. Nothing was previewed or applied: export ' +
        'the edits to a new file and re-open it before repairing further.',
    )
    expect(screen.getByTestId('repair-preview')).toHaveProperty('disabled', true)
    await act(async () => {
      fireEvent.click(screen.getByTestId('repair-preview'))
    })
    expect(h.countCalls).toHaveLength(0)
    expect(h.exampleCalls).toHaveLength(0)
    // No interrupt vocabulary anywhere in the surface (there is no cancel op).
    const dialog = screen.getByTestId('repair')
    expect(dialog.textContent?.toLowerCase()).not.toContain('interrupt')
    expect(dialog.textContent?.toLowerCase()).not.toContain('aborted')
  })
})

describe('repair — whole-effective scope: sorting and filtering never invalidate', () => {
  it('keeps the plan and its preview when the grid is re-sorted and re-filtered', async () => {
    h.affectedQueue = [2]
    h.exampleRows = [{ rowId: 'base:fv-11-1200#0', value: 'SG' }]
    await openAndRevealEditing()

    // Re-sort the grid BEFORE authoring: the plan must not capture the sort,
    // so the preview is still the whole-column truth.
    const sortToggle = document.querySelector<HTMLElement>(
      '[data-testid="grid-sort-toggle"][data-col-name="country"]',
    )
    expect(sortToggle).not.toBeNull()
    await act(async () => {
      sortToggle?.click()
    })

    await openDialog()
    await authorPlan({ column: 'country', mapping: 'SG => Singapore' })
    await runPreview()
    expect(text('repair-count-scanned')).toBe('5')
    expect(text('repair-count-affected')).toBe('2')
    expect(screen.queryByTestId('repair-preview-stale')).toBeNull()
    // The example read carried no grid sort/filter — it is the plan's predicate
    // and nothing else.
    expect(h.exampleCalls).toHaveLength(1)
    expect(h.exampleCalls[0]?.filters).toHaveLength(1)
    expect(screen.getByTestId('repair-apply')).toHaveProperty('disabled', false)
  })
})
