// SPDX-License-Identifier: AGPL-3.0-or-later

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
const h = vi.hoisted(() => ({
  healthy: true,
  /** Pre-commit cast check outcome: pass, refuse, or reject (engine error). */
  castCheck: 'ok' as 'ok' | 'refuse' | 'throw',
  /**
   * When set, `overlayCastCheck` awaits this before resolving — lets a test
   * land a same-table history change in the window between the pre-cast
   * snapshot and the check result (the m4-4 race guard's target).
   */
  castCheckGate: null as Promise<void> | null,
  /**
   * When true, refuse iff the checked overlay already has ops. Models a value
   * that cannot convert under the *changed* state, so a stale check against
   * the empty overlay would wrongly pass.
   */
  castCheckRefuseWhenNonEmpty: false,
  /** Ops count of each overlay the check was asked to validate. */
  castCheckOpCounts: [] as number[],
  /**
   * One-shot overlay-materialization failure (q-8): when set, the next
   * overlay read rejects with this message and the flag clears, so the
   * commit refresh fails but the rollback refresh succeeds.
   */
  overlayFailureOnce: null as string | null,
}))

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
  /** One-shot q-8 overlay failure; clears so the restore refresh succeeds. */
  const overlayRefusal = (): void => {
    if (h.overlayFailureOnce !== null) {
      const message = h.overlayFailureOnce
      h.overlayFailureOnce = null
      throw new Error(message)
    }
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
      overlaySchema: async (_handle: unknown, overlay: Overlay) => {
        overlayRefusal()
        return h.healthy ? effectiveSchema(overlay) : unhealthy()
      },
      overlayRowCount: async () => {
        overlayRefusal()
        return h.healthy ? 1 : unhealthy()
      },
      overlayCastCheck: async (_handle: unknown, overlay: Overlay) => {
        const opCount = overlay.ops?.length ?? 0
        h.castCheckOpCounts.push(opCount)
        if (h.castCheckGate !== null) await h.castCheckGate
        if (h.castCheck === 'throw') throw new Error('engine unavailable')
        if (h.castCheckRefuseWhenNonEmpty && opCount > 0) {
          return { hasNonConvertibleValues: true }
        }
        return { hasNonConvertibleValues: h.castCheck === 'refuse' }
      },
      fetchOverlayRange: async (_handle: unknown, overlay: Overlay) => {
        overlayRefusal()
        return {
          batch: h.healthy ? fakeOverlayBatch(effectiveSchema(overlay).length) : unhealthy(),
          hasMore: false,
        }
      },
    },
  }
})

vi.mock('./sql/SqlPanel', () => ({ SqlPanel: () => null }))
vi.mock('./profile/ProfilePanel', () => ({ ProfilePanel: () => null }))

afterEach(() => {
  cleanup()
  h.healthy = true
  h.castCheck = 'ok'
  h.castCheckGate = null
  h.castCheckRefuseWhenNonEmpty = false
  h.castCheckOpCounts = []
  h.overlayFailureOnce = null
})

async function openFixture(): Promise<void> {
  render(<App />)
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('schema-section')
  expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
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

  it('exports the active history-prefix operation count through undo, redo, and truncation', async () => {
    await openFixture()

    const readStagedCount = async (): Promise<string | null> => {
      await act(async () => {
        fireEvent.click(screen.getByTestId('export-open'))
      })
      const count = screen.queryByTestId('export-staged-count')?.textContent ?? null
      await act(async () => {
        fireEvent.click(screen.getByTestId('export-close'))
      })
      return count
    }
    const renameColumn = async (from: string, to: string): Promise<void> => {
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

    expect(await readStagedCount()).toBeNull()

    await renameColumn('country', 'nation')
    await renameColumn('income', 'salary')
    expect(await readStagedCount()).toBe('Includes 2 staged changes — review in History')

    // The full history still has two entries, but only the first remains active.
    await act(async () => {
      fireEvent.click(screen.getByTestId('history-undo'))
    })
    expect(await readStagedCount()).toBe('Includes 1 staged change — review in History')

    await act(async () => {
      fireEvent.click(screen.getByTestId('history-redo'))
    })
    expect(await readStagedCount()).toBe('Includes 2 staged changes — review in History')

    await act(async () => {
      fireEvent.click(screen.getByTestId('history-undo'))
      fireEvent.click(screen.getByTestId('history-undo'))
    })
    expect(await readStagedCount()).toBeNull()

    // A new op after undo truncates the two-entry redo tail.
    await renameColumn('country', 'territory')
    expect(await readStagedCount()).toBe('Includes 1 staged change — review in History')
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

describe('cast validate-before-commit (m4-4 fix round)', () => {
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

  it('refuses a cast the engine check proves non-convertible, appending nothing', async () => {
    await openFixture()
    h.castCheck = 'refuse'

    await castColumn('income', 'INTEGER')

    expect(screen.getByTestId('edit-error').textContent).toContain('No cast was applied')
    expect(screen.getByTestId('edit-error').textContent).toContain('"income"')
    // No op committed: no history entry, pending summary empty, header type
    // still the base BIGINT.
    expect(screen.queryByTestId('history-description')).toBeNull()
    expect(screen.getByTestId('pending-changes').textContent).toBe('No pending changes.')
    const incomeHeader = screen
      .getAllByTestId('grid-header-cell')
      .find((cell) => cell.getAttribute('data-col-name') === 'income')
    expect(incomeHeader?.getAttribute('data-col-type')).toBe('BIGINT')
  })

  it('surfaces a rejected check as readable text and appends nothing', async () => {
    await openFixture()
    h.castCheck = 'throw'

    await castColumn('income', 'INTEGER')

    expect(screen.getByTestId('edit-error').textContent).toContain('The engine rejected this edit')
    expect(screen.queryByTestId('history-description')).toBeNull()
    expect(screen.getByTestId('pending-changes').textContent).toBe('No pending changes.')
  })

  it('commits the cast only after the check passes', async () => {
    await openFixture()

    await castColumn('income', 'DECIMAL(10,2)')

    expect(screen.getByTestId('history-description').textContent).toBe(
      'cast column "income" to DECIMAL(10,2)',
    )
    expect(screen.getByTestId('pending-changes').textContent).toContain('1 column cast')
  })

  it('re-checks and drops a stale verdict when the history changes mid-check', async () => {
    await openFixture()

    // Defer the engine's check so a same-table history change can land while
    // it is in flight, and make the *changed* state refuse the cast — the
    // reviewer's race: a stale `hasNonConvertibleValues:false` computed over
    // the empty overlay must not append a cast over the changed state.
    let releaseCheck!: () => void
    h.castCheckGate = new Promise<void>((resolve) => {
      releaseCheck = resolve
    })
    h.castCheckRefuseWhenNonEmpty = true

    await castColumn('income', 'DECIMAL(10,2)')
    // The first call validated the empty overlay, and pending is visible.
    expect(h.castCheckOpCounts).toEqual([0])
    expect(screen.getByTestId('column-cast-pending').textContent).toBe('Checking…')

    // A same-table edit (rename) lands during the check window.
    const panel = within(screen.getByTestId('schema-panel'))
    await act(async () => {
      fireEvent.click(panel.getByRole('button', { name: 'Rename column country' }))
    })
    const input = panel.getByTestId('column-rename-input')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'nation' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    // Release the stale (empty-overlay) verdict: it must be discarded and the
    // check re-run against the renamed state, which then refuses.
    await act(async () => {
      releaseCheck()
    })
    await screen.findByTestId('edit-error')

    expect(screen.getByTestId('edit-error').textContent).toContain('No cast was applied')
    // Two checks ran: the stale one (no ops) and the re-check (one op).
    expect(h.castCheckOpCounts).toEqual([0, 1])
    // Only the rename was applied; the stale cast was never appended over it.
    expect(screen.getByTestId('pending-changes').textContent).toContain('1 column rename')
    expect(screen.getByTestId('pending-changes').textContent).not.toContain('column cast')
    expect(screen.queryByTestId('column-cast-pending')).toBeNull()
  })
})

describe('schema panel freshness (m4-4 fix round 2)', () => {
  it('re-keys names/types after rename and cast, and casts the renamed column', async () => {
    await openFixture()
    const panel = within(screen.getByTestId('schema-panel'))

    // Rename income → salary through the panel.
    await act(async () => {
      fireEvent.click(panel.getByRole('button', { name: 'Rename column income' }))
    })
    const input = panel.getByTestId('column-rename-input')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'salary' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    // The panel followed the rename: the new name is present with its badge,
    // the pre-rename entry is gone (the stale-panel bug kept `income`).
    expect(
      screen.getAllByTestId('schema-column').map((el) => el.getAttribute('data-col-name')),
    ).toEqual(['id', 'country', 'salary'])
    expect(panel.queryByRole('button', { name: 'Rename column income' })).toBeNull()
    const salaryColumn = screen
      .getAllByTestId('schema-column')
      .find((el) => el.getAttribute('data-col-name') === 'salary')
    expect(salaryColumn).toBeDefined()
    expect(within(salaryColumn!).getByTestId('schema-type-badge').textContent).toBe('BIGINT')

    // Cast the renamed column through the panel — it must target `salary`, not
    // the pre-rename name (which surfaced as an unknown-column engine error).
    await act(async () => {
      fireEvent.click(within(salaryColumn!).getByRole('button', { name: 'Cast column salary' }))
    })
    await act(async () => {
      fireEvent.change(screen.getByTestId('column-cast-select'), { target: { value: 'DOUBLE' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('column-cast-commit'))
    })

    expect(screen.queryByTestId('edit-error')).toBeNull()
    expect(screen.getAllByTestId('history-description').map((el) => el.textContent)).toEqual([
      'rename column "income" to "salary"',
      'cast column "salary" to DOUBLE',
    ])
    const header = screen
      .getAllByTestId('grid-header-cell')
      .find((el) => el.getAttribute('data-col-name') === 'salary')
    expect(header?.getAttribute('data-col-type')).toBe('DOUBLE')
    // The panel badge re-keyed to the cast type too.
    const castSalary = screen
      .getAllByTestId('schema-column')
      .find((el) => el.getAttribute('data-col-name') === 'salary')
    expect(within(castSalary!).getByTestId('schema-type-badge').textContent).toBe('DOUBLE')
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

describe('value-free edit rejection (q-8)', () => {
  it('renders the engine materialization class, never a value/SQL fragment, and rolls back', async () => {
    await openFixture()
    const panel = within(screen.getByTestId('schema-panel'))

    // The engine maps its raw DuckDB error to the value-free class before
    // posting (engine-executor); the component test stands in for that
    // protocol reply. The failure is one-shot, so the rollback refresh
    // succeeds and the previous view is restored. The reply's summary line is
    // the class, but the reflected SQL tail below it carries the typed value
    // — `errorSummary` keeps only the first line, so the tail must not leak.
    h.overlayFailureOnce =
      'the edited view could not be materialized\n' +
      "LINE 1: SELECT CAST('not-a-date''; DROP TABLE x --' AS DATE)"
    await act(async () => {
      fireEvent.click(panel.getByRole('button', { name: 'Rename column country' }))
    })
    const input = panel.getByTestId('column-rename-input')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'nation' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    const alert = screen.getByTestId('edit-error')
    expect(alert.textContent).toBe(
      'The engine rejected this edit: the edited view could not be materialized. ' +
        'The previous view is unchanged.',
    )
    // Class-only: the reply carried a value/SQL fragment on its second line,
    // yet the rendered alert holds only the class.
    expect(alert.textContent).not.toContain("'; DROP TABLE x --")
    expect(alert.textContent).not.toContain('SELECT')

    // Rolled back: header unchanged, no history entry, previous view intact.
    const headers = screen
      .getAllByTestId('grid-header-cell')
      .map((el) => el.getAttribute('data-col-name'))
    expect(headers).toEqual(['id', 'country', 'income'])
    expect(screen.queryByTestId('history-description')).toBeNull()
    expect(screen.getByTestId('grid-total-rows').textContent).toBe('1')
  })
})

/**
 * rd-3c pin: durable edit feedback from any task.
 *
 * The durable `edit-error` (engine rejection, cast refusal, non-applied op)
 * lives in the Editing section, which rd-3b hides outside Change. The shell
 * therefore reveals that section through the existing `revealSectionFromNav`
 * seam when the error transitions to a non-null value — once per error, and
 * without moving focus. These cases drive the REAL App composition root from
 * the Explore default (no task activation), so they fail if the reveal is
 * missing, if it fires on success, or if the ref guard is dropped.
 *
 * Scope note: JSDOM has no layout, no scroll containers and no
 * `scrollIntoView`, so the scroll half of the reveal (the opt-in
 * `{ scroll: true }` request) is deliberately NOT asserted here — nothing here
 * could distinguish a scrolled section from an unscrolled one. It is proven in
 * the browser, from this same Explore default, by the in-viewport assertion in
 * `tests/e2e/grid-editing.spec.ts` ("engine rejection…"). These cases keep the
 * trigger and ref-guard semantics (`data-task`, `aria-checked`, section
 * expansion, message identity), which are layout-independent.
 */
describe('durable edit feedback reveals the Editing section (rd-3c)', () => {
  /** The pane's `data-task` — what the ≥1024px exposure rule keys on. */
  const paneTask = (): string | null =>
    document.querySelector('.workbench-tools')?.getAttribute('data-task') ?? null
  const editingExpanded = (): string | null =>
    screen.getByTestId('section-toggle-editing').getAttribute('aria-expanded')

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

  it('switches the pane to Change and expands Editing for an engine rejection from Explore', async () => {
    await openFixture()
    // The rd-3b default: Explore is the active task and Editing is collapsed.
    expect(paneTask()).toBe('explore')
    expect(screen.getByTestId('task-explore').getAttribute('aria-checked')).toBe('true')
    expect(editingExpanded()).toBe('false')

    h.castCheck = 'throw'
    await castColumn('income', 'INTEGER')

    // The message itself is unchanged (same text, same single place, no
    // second render) — only its section is now exposed.
    const alert = screen.getByTestId('edit-error')
    expect(alert.textContent).toBe(
      'The engine rejected this edit: engine unavailable. The previous view is unchanged.',
    )
    expect(screen.getAllByTestId('edit-error')).toHaveLength(1)

    // The shell activated Change and expanded the Editing section.
    expect(screen.getByTestId('task-change').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('task-explore').getAttribute('aria-checked')).toBe('false')
    expect(paneTask()).toBe('change')
    expect(editingExpanded()).toBe('true')
  })

  it('does not switch tasks for edits that apply', async () => {
    await openFixture()

    // A successful rename and a successful cast both leave `editError` null,
    // so no reveal happens: the user stays where they were.
    await renameColumn('country', 'nation')
    expect(screen.queryByTestId('edit-error')).toBeNull()
    expect(screen.getByTestId('task-explore').getAttribute('aria-checked')).toBe('true')
    expect(paneTask()).toBe('explore')
    expect(editingExpanded()).toBe('false')

    await castColumn('income', 'DOUBLE')
    expect(screen.queryByTestId('edit-error')).toBeNull()
    expect(paneTask()).toBe('explore')
    expect(editingExpanded()).toBe('false')
  })

  it('does not re-reveal the same error after the user returns to Explore', async () => {
    await openFixture()
    h.castCheck = 'throw'
    await castColumn('income', 'INTEGER')
    expect(paneTask()).toBe('change')

    // The user deliberately goes back to Explore with the error still on
    // record — they must not be yanked back.
    await act(async () => {
      fireEvent.click(screen.getByTestId('task-explore'))
    })
    expect(screen.getByTestId('task-explore').getAttribute('aria-checked')).toBe('true')
    expect(paneTask()).toBe('explore')

    // Unrelated re-renders (another task selection) do not re-fire either.
    await act(async () => {
      fireEvent.click(screen.getByTestId('task-explore'))
    })
    expect(paneTask()).toBe('explore')

    // Repeating the same failing attempt produces the SAME message, which the
    // ref guard treats as the same error: still no reveal.
    await castColumn('income', 'INTEGER')
    expect(screen.getByTestId('edit-error')).not.toBeNull()
    expect(paneTask()).toBe('explore')
  })

  it('reveals again for a later error once the previous one has cleared', async () => {
    await openFixture()
    h.castCheck = 'throw'
    await castColumn('income', 'INTEGER')
    expect(paneTask()).toBe('change')

    // A successful edit clears the durable error in the session hook, which
    // resets the guard.
    h.castCheck = 'ok'
    await castColumn('income', 'DOUBLE')
    expect(screen.queryByTestId('edit-error')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByTestId('task-explore'))
    })
    expect(paneTask()).toBe('explore')

    // A DIFFERENT later error is a fresh transition and reveals again.
    h.castCheck = 'refuse'
    await castColumn('income', 'BIGINT')
    expect(screen.getByTestId('edit-error').textContent).toContain('No cast was applied')
    expect(screen.getByTestId('task-change').getAttribute('aria-checked')).toBe('true')
    expect(paneTask()).toBe('change')
    expect(editingExpanded()).toBe('true')
  })

  it('is a no-op when Change is already active with Editing already open', async () => {
    await openFixture()
    await act(async () => {
      fireEvent.click(screen.getByTestId('task-change'))
    })
    expect(paneTask()).toBe('change')
    expect(editingExpanded()).toBe('true')

    // An error raised while the target is already exposed: the message appears
    // in place, nothing is re-activated and nothing re-opens (no scroll jitter).
    h.castCheck = 'throw'
    await castColumn('income', 'INTEGER')

    expect(screen.getByTestId('edit-error').textContent).toContain('The engine rejected this edit')
    expect(screen.getAllByTestId('edit-error')).toHaveLength(1)
    expect(paneTask()).toBe('change')
    expect(screen.getByTestId('task-change').getAttribute('aria-checked')).toBe('true')
    expect(editingExpanded()).toBe('true')
  })
})
