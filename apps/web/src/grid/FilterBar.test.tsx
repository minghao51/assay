// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FilterSpec, GridViewportModel } from '@assay/grid'
import { FilterBar, filterInputId } from './FilterBar'

/**
 * AR-W11 pins: distinct column names must produce distinct DOM ids. The old
 * `[^A-Za-z0-9_-] → -` mapping made `a.b` and `a-b` collide, so one label
 * pointed at the other column's input. Also pins the label↔input association
 * survives.
 *
 * ux-4 pins (below): the collapsed-by-default disclosure with a
 * `model.filters` summary, the type-aware builder compiling operator+value to
 * the `FilterSpec` predicate grammar (through the real component), the
 * client-side rejection that never reaches the model, the preserved
 * SQL-fragment escape hatch, and the programmatic-`setFilters` bridge.
 */

const COLUMNS: readonly { name: string; type: string }[] = [
  { name: 'income', type: 'BIGINT' },
  { name: 'country', type: 'VARCHAR' },
  { name: 'signup_date', type: 'DATE' },
  { name: 'active', type: 'BOOLEAN' },
]

/** Minimal model surface FilterBar reads (subscribe/getVersion/schema/filters). */
function fakeModel(
  columns: readonly { name: string; type: string }[],
  filters: readonly FilterSpec[] = [],
): { model: GridViewportModel; setFilters: ReturnType<typeof vi.fn> } {
  const setFilters = vi.fn(async () => {})
  return {
    setFilters,
    model: {
      subscribe: () => () => {},
      getVersion: () => 0,
      schema: columns,
      filters,
      setFilters,
    } as unknown as GridViewportModel,
  }
}

/**
 * A tiny reactive store (the real `GridViewportModel` shape FilterBar uses):
 * `setFilters` replaces the list, bumps the version, and notifies — so a test
 * can drive the programmatic bridge exactly as the validation panel does.
 */
function storeModel(
  columns: readonly { name: string; type: string }[],
): GridViewportModel & { setFilters: (next: FilterSpec[] | null) => Promise<void> } {
  let version = 0
  const listeners = new Set<() => void>()
  const model = {
    schema: columns,
    filters: [] as readonly FilterSpec[],
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getVersion: () => version,
    setFilters: async (next: FilterSpec[] | null) => {
      model.filters = next ?? []
      version += 1
      for (const listener of listeners) listener()
    },
  }
  return model as unknown as GridViewportModel & {
    setFilters: (next: FilterSpec[] | null) => Promise<void>
  }
}

/**
 * A store model whose `setFilters` is held open until `flush()` is called, so a
 * test can act while an apply is in flight (the uxc-4 collapse-during-apply
 * race). Applies land in call order; `flush()` releases the oldest.
 */
function blockingModel(columns: readonly { name: string; type: string }[]): {
  model: GridViewportModel
  flush: () => void
} {
  let version = 0
  const listeners = new Set<() => void>()
  const releases: (() => void)[] = []
  const model = {
    schema: columns,
    filters: [] as readonly FilterSpec[],
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getVersion: () => version,
    setFilters: (next: FilterSpec[] | null) =>
      new Promise<void>((resolve) => {
        releases.push(() => {
          model.filters = next ?? []
          version += 1
          for (const listener of listeners) listener()
          resolve()
        })
      }),
  }
  return {
    model: model as unknown as GridViewportModel,
    flush: () => {
      releases.shift()?.()
    },
  }
}

/**
 * A model whose first `failures.length` `setFilters` calls reject in order,
 * then accepts — the applyList rollback shapes the FilterBar error state is
 * built on (UG-30): one failure for the apply + a successful restore, or two
 * for the apply + failed restore (the double failure).
 */
function failingModel(
  columns: readonly { name: string; type: string }[],
  ...failures: unknown[]
): { model: GridViewportModel; setFilters: ReturnType<typeof vi.fn> } {
  let version = 0
  const listeners = new Set<() => void>()
  let calls = 0
  const setFilters = vi.fn(async (next: FilterSpec[] | null) => {
    calls += 1
    if (calls <= failures.length) throw failures[calls - 1]
    model.filters = next ?? []
    version += 1
    for (const listener of listeners) listener()
  })
  const model = {
    schema: columns,
    filters: [] as readonly FilterSpec[],
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getVersion: () => version,
    setFilters,
  }
  return { model: model as unknown as GridViewportModel, setFilters }
}

/** A builder control scoped to one column (testids repeat per column). */
function control(testId: string, column: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${testId}"][data-col-name="${column}"]`)
  if (element === null) throw new Error(`no ${testId} for column ${column}`)
  return element as HTMLElement
}

function openBar(): void {
  fireEvent.click(screen.getByTestId('filter-toggle'))
}

/**
 * Flip the disclosure (open when collapsed, collapse when open). The same
 * action as `openBar`, named for the uxc-4 latch pins where the direction is
 * the point under test.
 */
const toggleBar = openBar

afterEach(cleanup)

describe('filterInputId (AR-W11)', () => {
  it('maps distinct column names to distinct ids', () => {
    const names = ['a.b', 'a-b', 'a b', 'a_b', 'x!y', 'x?y', 'weird "quoted" key']
    const ids = names.map(filterInputId)
    expect(new Set(ids).size).toBe(names.length)
    expect(filterInputId('a.b')).not.toBe(filterInputId('a-b'))
    expect(filterInputId('a b')).not.toBe(filterInputId('a_b'))
  })

  it('is stable and DOM-id-safe', () => {
    expect(filterInputId('a.b')).toBe(filterInputId('a.b'))
    expect(filterInputId('a.b')).toMatch(/^filter-input-[0-9a-f-]+$/)
    // A lone surrogate must not throw (column names are untrusted text).
    expect(() => filterInputId('\uD800')).not.toThrow()
  })
})

describe('FilterBar id/label association (AR-W11)', () => {
  it('renders one input per column with a matching, unique label target', () => {
    const columns = [
      { name: 'a.b', type: 'VARCHAR' },
      { name: 'a-b', type: 'VARCHAR' },
    ]
    const { model } = fakeModel(columns)
    render(<FilterBar model={model} />)
    openBar()
    const inputs = screen.getAllByTestId('filter-input')
    expect(inputs).toHaveLength(2)
    expect(inputs[0]?.id).not.toBe(inputs[1]?.id)
    for (const input of inputs) {
      const label = document.querySelector(`label[for="${input.id}"]`)
      expect(label).not.toBeNull()
      expect(label?.textContent).toBe(input.getAttribute('data-col-name'))
    }
  })
})

describe('FilterBar disclosure (ux-4)', () => {
  it('is collapsed by default and shows a bare "Filters" summary', () => {
    const { model } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    const toggle = screen.getByTestId('filter-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe('Filters')
    expect(screen.queryByTestId('filter-body')).toBeNull()
  })

  it('summarises the active count from model.filters', () => {
    const { model } = fakeModel(COLUMNS, [{ column: 'country', predicate: "= 'US'" }])
    render(<FilterBar model={model} />)
    expect(screen.getByTestId('filter-toggle').textContent).toBe('Filters · 1 active')
  })

  it('opens to reveal the builder after a programmatic setFilters (validation bridge)', async () => {
    const model = storeModel(COLUMNS)
    render(<FilterBar model={model} />)
    expect(screen.getByTestId('filter-toggle').getAttribute('aria-expanded')).toBe('false')

    await act(async () => {
      await model.setFilters([{ column: 'country', predicate: "= 'US'" }])
    })

    expect(screen.getByTestId('filter-toggle').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('filter-toggle').textContent).toBe('Filters · 1 active')
    expect(screen.getByTestId('filter-chip')).toBeTruthy()
  })
})

describe('FilterBar auto-open identity (uxc-4)', () => {
  it('re-opens a user-collapsed bar on a same-count programmatic replacement (identity, not count)', async () => {
    const model = storeModel(COLUMNS)
    render(<FilterBar model={model} />)

    // Rule A lands programmatically and auto-opens.
    await act(async () => {
      await model.setFilters([{ column: 'country', predicate: "= 'US'" }])
    })
    const toggle = screen.getByTestId('filter-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    // The user collapses over rule A.
    toggleBar()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    // Rule B replaces rule A at the same active count (1). The predicate
    // changed, so the bar must re-open instead of silently swapping under it.
    await act(async () => {
      await model.setFilters([{ column: 'income', predicate: '> 50000' }])
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('filter-chip').getAttribute('data-col-name')).toBe('income')
    expect(screen.getByTestId('filter-chip').querySelector('code')?.textContent).toBe(
      'income > 50000',
    )
  })

  it('honors the user-collapse latch across a same-identity programmatic re-set (latch is load-bearing)', async () => {
    const model = storeModel(COLUMNS)
    render(<FilterBar model={model} />)

    await act(async () => {
      await model.setFilters([{ column: 'country', predicate: "= 'US'" }])
    })
    const toggle = screen.getByTestId('filter-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    // The user collapses; the latch binds to this exact predicate.
    toggleBar()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    // A routine programmatic re-set with the same identity (fresh array, same
    // column:predicate) re-fires the effect but must match the latch and leave
    // the bar collapsed. Deleting the latch-match guard makes this fail.
    await act(async () => {
      await model.setFilters([{ column: 'country', predicate: "= 'US'" }])
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('auto-opens on the first filter when the bar starts empty (retained behavior)', async () => {
    const model = storeModel(COLUMNS)
    render(<FilterBar model={model} />)
    expect(screen.getByTestId('filter-toggle').getAttribute('aria-expanded')).toBe('false')

    await act(async () => {
      await model.setFilters([{ column: 'income', predicate: '> 50000' }])
    })
    expect(screen.getByTestId('filter-toggle').getAttribute('aria-expanded')).toBe('true')
  })

  it('closes on a user collapse and re-opens on a second user click (toggle clears the latch)', async () => {
    const model = storeModel(COLUMNS)
    render(<FilterBar model={model} />)

    await act(async () => {
      await model.setFilters([{ column: 'country', predicate: "= 'US'" }])
    })
    const toggle = screen.getByTestId('filter-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    toggleBar()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    toggleBar()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('does not force-open when filters empty out, then auto-opens a fresh filter', async () => {
    const model = storeModel(COLUMNS)
    render(<FilterBar model={model} />)

    await act(async () => {
      await model.setFilters([{ column: 'country', predicate: "= 'US'" }])
    })
    const toggle = screen.getByTestId('filter-toggle')
    toggleBar()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    // Emptying retires the latch but never force-opens the bar.
    await act(async () => {
      await model.setFilters([])
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    // A fresh filter after the empty state auto-opens (the latch for the old
    // set was retired, so this counts as a new set even if it repeats a
    // predicate).
    await act(async () => {
      await model.setFilters([{ column: 'country', predicate: "= 'US'" }])
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('honors a collapse made mid-apply for the incoming set (collapse-during-apply policy (i))', async () => {
    const { model, flush } = blockingModel(COLUMNS)
    render(<FilterBar model={model} />)
    openBar()

    // A user edit starts an apply that has not landed yet (pending).
    fireEvent.change(control('filter-builder-operator', 'income'), { target: { value: 'gt' } })
    fireEvent.change(control('filter-builder-value', 'income'), { target: { value: '50000' } })
    fireEvent.click(control('filter-builder-apply', 'income'))

    // While it is in flight the user collapses. Latching the *visible*
    // (pre-apply, empty) signature would let the incoming filter force-open
    // the bar over this deliberate collapse.
    const toggle = screen.getByTestId('filter-toggle')
    toggleBar()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    // The apply lands: the deliberate collapse survives the user's own edit.
    await act(async () => {
      flush()
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe('Filters · 1 active')
  })
})

describe('FilterBar builder compilation (ux-4)', () => {
  it('compiles a numeric operator+value and applies it through setFilters', async () => {
    const { model, setFilters } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    openBar()

    fireEvent.change(control('filter-builder-operator', 'income'), { target: { value: 'gt' } })
    fireEvent.change(control('filter-builder-value', 'income'), { target: { value: '50000' } })
    fireEvent.click(control('filter-builder-apply', 'income'))

    await waitFor(() => {
      expect(setFilters).toHaveBeenCalledWith([{ column: 'income', predicate: '> 50000' }])
    })
  })

  it('escapes LIKE metacharacters in a string contains predicate', async () => {
    const { model, setFilters } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    openBar()

    fireEvent.change(control('filter-builder-operator', 'country'), {
      target: { value: 'contains' },
    })
    fireEvent.change(control('filter-builder-value', 'country'), { target: { value: '50%' } })
    fireEvent.click(control('filter-builder-apply', 'country'))

    await waitFor(() => {
      expect(setFilters).toHaveBeenCalledWith([
        { column: 'country', predicate: "LIKE '%50\\%%' ESCAPE '\\'" },
      ])
    })
  })

  it('hides the value input for boolean and null operators', () => {
    const { model } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    openBar()

    // `active` defaults to `= true`, which takes no value.
    expect(control('filter-builder-operator', 'active')).toBeTruthy()
    expect(
      document.querySelector('[data-testid="filter-builder-value"][data-col-name="active"]'),
    ).toBeNull()

    fireEvent.change(control('filter-builder-operator', 'income'), { target: { value: 'is-null' } })
    expect(
      document.querySelector('[data-testid="filter-builder-value"][data-col-name="income"]'),
    ).toBeNull()
  })
})

describe('FilterBar client-side rejection (ux-4)', () => {
  it('rejects an empty value inline without calling setFilters', () => {
    const { model, setFilters } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    openBar()

    fireEvent.change(control('filter-builder-operator', 'income'), { target: { value: 'gt' } })
    fireEvent.click(control('filter-builder-apply', 'income'))

    expect(setFilters).not.toHaveBeenCalled()
    expect(control('filter-builder-error', 'income').textContent).toBe(
      'Enter a value for this operator.',
    )
  })

  it('rejects a non-numeric value for a numeric column inline', () => {
    const { model, setFilters } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    openBar()

    fireEvent.change(control('filter-builder-value', 'income'), { target: { value: 'abc' } })
    fireEvent.click(control('filter-builder-apply', 'income'))

    expect(setFilters).not.toHaveBeenCalled()
    expect(control('filter-builder-error', 'income').textContent).toBe('That is not a number.')
  })

  it('rejects a malformed date inline', () => {
    const { model, setFilters } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    openBar()

    fireEvent.change(control('filter-builder-value', 'signup_date'), {
      target: { value: '2025-02-30' },
    })
    fireEvent.click(control('filter-builder-apply', 'signup_date'))

    expect(setFilters).not.toHaveBeenCalled()
    expect(control('filter-builder-error', 'signup_date').textContent).toBe(
      'Enter a date as YYYY-MM-DD.',
    )
  })
})

describe('FilterBar SQL predicate escape hatch (ux-4)', () => {
  it('still emits the raw fragment through setFilters', async () => {
    const { model, setFilters } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    openBar()

    fireEvent.change(control('filter-input', 'country'), { target: { value: "= 'US'" } })
    fireEvent.click(control('filter-apply', 'country'))

    await waitFor(() => {
      expect(setFilters).toHaveBeenCalledWith([{ column: 'country', predicate: "= 'US'" }])
    })
  })
})

/**
 * UG-30 pin: a rejected filter change renders ONE framed, single-line message
 * through the shared engine-error helper, and the rollback to the previous
 * filter list is part of that message (not a second raw diagnostic).
 */
describe('FilterBar engine-error framing (UG-30)', () => {
  it('renders a single-line, framed filter error and restores the previous filters', async () => {
    const { model, setFilters } = failingModel(
      COLUMNS,
      new Error(
        'Binder Error: Referenced column "nope" not found in FROM clause!\n' +
          'LINE 1: SELECT * FROM "assay_t1" WHERE "nope" = 1',
      ),
    )
    render(<FilterBar model={model} />)
    openBar()

    fireEvent.change(control('filter-input', 'country'), { target: { value: "= 'US'" } })
    fireEvent.click(control('filter-apply', 'country'))

    const error = await screen.findByTestId('filter-error')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toBe(
      'The filter could not be applied: Binder Error: Referenced column "nope" not found in ' +
        'FROM clause. The previous filters are still in effect.',
    )
    expect(error.textContent).not.toMatch(/\r|\n/)
    expect(document.body.textContent).not.toContain('LINE 1')
    // The rejection rolled the model back to the previous (empty) list.
    expect(setFilters).toHaveBeenCalledTimes(2)
    expect(setFilters).toHaveBeenLastCalledWith([])
  })

  it('never claims the previous filters survive when the restore also fails', async () => {
    const APPLY_FAILURE = new Error(
      'Binder Error: Referenced column "nope" not found in FROM clause!\n' +
        'LINE 1: SELECT * FROM "assay_t1" WHERE "nope" = 1',
    )
    const RESTORE_FAILURE = new Error('_setThrew is not defined')
    const { model, setFilters } = failingModel(COLUMNS, APPLY_FAILURE, RESTORE_FAILURE)
    render(<FilterBar model={model} />)
    openBar()

    fireEvent.change(control('filter-input', 'country'), { target: { value: "= 'US'" } })
    fireEvent.click(control('filter-apply', 'country'))

    const error = await screen.findByTestId('filter-error')
    expect(error.getAttribute('role')).toBe('alert')
    // The double-failure copy states only what is known: both calls failed.
    // It must not inherit the single-failure framing, which asserts a rollback
    // that was just reported as failed.
    expect(error.textContent).toBe(
      'The filter could not be applied and the previous filters could not be restored. ' +
        'Re-apply a filter or reopen the dataset if the grid looks wrong.',
    )
    expect(error.textContent).not.toContain('still in effect')
    // The single-failure sentence (framed with a colon) is not shown either.
    expect(error.textContent).not.toContain('could not be applied:')
    // No raw diagnostic, no engine vocabulary, no second line.
    expect(error.textContent).not.toContain('Binder Error')
    expect(error.textContent).not.toContain('_setThrew')
    expect(error.textContent).not.toMatch(/\r|\n/)
    expect(document.body.textContent).not.toContain('LINE 1')
    // Exactly the apply + the attempted restore; nothing silently retried.
    expect(setFilters).toHaveBeenCalledTimes(2)
  })
})
