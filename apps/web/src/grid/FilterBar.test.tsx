// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilterApplyError, GridViewportModel } from '@assay/grid'
import type { FilterSpec, GridDataProvider } from '@assay/grid'
import {
  FILTER_COMPOSE_VALUE_ID,
  FilterBar,
  filterActivePredicateId,
  filterChipKey,
  filterInputId,
} from './FilterBar'
import { FILTER_RELOAD_FAILED_MESSAGE, FILTER_RESTORE_FAILED_MESSAGE } from './filter-failure'

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
 *
 * ug-18 pins (below, findings UG-16/UG-17): ONE compose row instead of the
 * per-column builder wall, editable rows for the active filters, the escape
 * hatch behind its own `SQL predicates` disclosure, the collapsed summary
 * naming the active columns, and the chips (with remove buttons) rendered
 * beside — never inside — the collapsed toggle.
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
 * race, and the ug-18 round-2 pending-guard pins). Applies land in call order;
 * `flush()` releases the oldest. `initialFilters` lets a test start with an
 * accepted list (and therefore active rows) already in place.
 */
function blockingModel(
  columns: readonly { name: string; type: string }[],
  initialFilters: readonly FilterSpec[] = [],
): {
  model: GridViewportModel
  flush: () => void
} {
  let version = 0
  const listeners = new Set<() => void>()
  const releases: (() => void)[] = []
  const model = {
    schema: columns,
    filters: initialFilters as readonly FilterSpec[],
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
 * then accepts. Each entry is thrown verbatim, so a test names the exact
 * `FilterApplyError.phase` the real model would classify (C02b: the FilterBar
 * no longer restores anything itself — the model owns the transaction and its
 * single restoration attempt). `filters` seeds the published list.
 */
function failingModel(
  columns: readonly { name: string; type: string }[],
  {
    failures = [],
    filters = [],
  }: { failures?: readonly unknown[]; filters?: readonly FilterSpec[] } = {},
): {
  model: GridViewportModel
  setFilters: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
} {
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
  const refresh = vi.fn(async () => {})
  const model = {
    schema: columns,
    filters: filters as readonly FilterSpec[],
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getVersion: () => version,
    setFilters,
    refresh,
  }
  return {
    model: model as unknown as GridViewportModel,
    setFilters,
    refresh,
  }
}

/** A per-column control scoped to one column (the SQL hatch repeats per column). */
function control(testId: string, column: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${testId}"][data-col-name="${column}"]`)
  if (element === null) throw new Error(`no ${testId} for column ${column}`)
  return element as HTMLElement
}

/**
 * Every removal control currently mounted, across both states: the collapsed
 * header's chip buttons and the expanded active rows' Remove buttons. The
 * ug-18 round-2 finding-4 invariant is that this set has exactly one entry per
 * active filter — never two for one filter (expanded body chips are
 * display-only).
 */
function removalControls(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-testid="filter-chip-remove"], [data-testid="filter-active-remove"]',
    ),
  )
}

function openBar(): void {
  fireEvent.click(screen.getByTestId('filter-toggle'))
}

/**
 * Open the bar unless it is already open: a model that mounts with filters
 * auto-opens through the uxc-4 effect, so an unconditional click would close
 * it (the "collapse" action).
 */
function ensureOpen(): void {
  if (screen.getByTestId('filter-toggle').getAttribute('aria-expanded') !== 'true') openBar()
}

/**
 * Flip the disclosure (open when collapsed, collapse when open). The same
 * action as `openBar`, named for the uxc-4 latch pins where the direction is
 * the point under test.
 */
const toggleBar = openBar

/** The compose row's controls (ug-18: exactly one set exists). */
function composeColumn(): HTMLSelectElement {
  return screen.getByTestId('filter-compose-column') as HTMLSelectElement
}

function composeOperator(): HTMLSelectElement {
  return screen.getByTestId('filter-compose-operator') as HTMLSelectElement
}

function composeValue(): HTMLInputElement {
  return screen.getByTestId('filter-compose-value') as HTMLInputElement
}

function composeApply(): HTMLElement {
  return screen.getByTestId('filter-compose-apply')
}

/** Choose a column, an operator and a value in the compose row, then Apply. */
function compose(column: string, operatorId: string, value?: string): void {
  fireEvent.change(composeColumn(), { target: { value: column } })
  fireEvent.change(composeOperator(), { target: { value: operatorId } })
  if (value !== undefined) fireEvent.change(composeValue(), { target: { value } })
  fireEvent.click(composeApply())
}

/** The operator ids the compose row currently offers, in catalog order. */
function composeOperatorIds(): string[] {
  return Array.from(composeOperator().options).map((option) => option.value)
}

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

  it('keeps the active-row and SQL-hatch inputs for one column distinct', () => {
    expect(filterActivePredicateId('a.b')).not.toBe(filterInputId('a.b'))
    expect(filterActivePredicateId('a.b')).toBe(filterActivePredicateId('a.b'))
    expect(filterActivePredicateId('a.b')).not.toBe(filterActivePredicateId('a-b'))
  })

  it('gives the single compose value input a compose-scoped id', () => {
    const { model } = fakeModel(COLUMNS, [{ column: 'income', predicate: '> 50000' }])
    render(<FilterBar model={model} />)
    ensureOpen()

    // One control per bar, so its id is compose-scoped rather than a
    // historical per-column builder id (`filter-builder-value-<column>`).
    expect(composeValue().id).toBe(FILTER_COMPOSE_VALUE_ID)
    expect(document.querySelectorAll(`#${FILTER_COMPOSE_VALUE_ID}`)).toHaveLength(1)
    // Distinct from the per-column inputs, so no label can point at it.
    for (const column of COLUMNS) {
      expect(FILTER_COMPOSE_VALUE_ID).not.toBe(filterInputId(column.name))
      expect(FILTER_COMPOSE_VALUE_ID).not.toBe(filterActivePredicateId(column.name))
    }
  })
})

describe('FilterBar id/label association (AR-W11)', () => {
  it('renders one SQL-hatch input per column with a matching, unique label target', () => {
    const columns = [
      { name: 'a.b', type: 'VARCHAR' },
      { name: 'a-b', type: 'VARCHAR' },
    ]
    const { model } = fakeModel(columns)
    render(<FilterBar model={model} />)
    ensureOpen()
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

  it('opens to reveal the compose row after a programmatic setFilters (validation bridge)', async () => {
    const model = storeModel(COLUMNS)
    render(<FilterBar model={model} />)
    expect(screen.getByTestId('filter-toggle').getAttribute('aria-expanded')).toBe('false')

    await act(async () => {
      await model.setFilters([{ column: 'country', predicate: "= 'US'" }])
    })

    expect(screen.getByTestId('filter-toggle').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('filter-compose')).toBeTruthy()
    expect(screen.getByTestId('filter-toggle').textContent).toBe('Filters · 1 active: country')
    expect(screen.getByTestId('filter-chip')).toBeTruthy()
  })
})

describe('FilterBar collapsed summary (ug-18 / UG-17)', () => {
  it('names the active columns in filter order at 1 and 2 filters', () => {
    const one = fakeModel(COLUMNS, [{ column: 'income', predicate: '> 50000' }])
    const { unmount } = render(<FilterBar model={one.model} />)
    expect(screen.getByTestId('filter-toggle').textContent).toBe('Filters · 1 active: income')
    unmount()

    const two = fakeModel(COLUMNS, [
      { column: 'income', predicate: '> 50000' },
      { column: 'country', predicate: "= 'US'" },
    ])
    render(<FilterBar model={two.model} />)
    expect(screen.getByTestId('filter-toggle').textContent).toBe(
      'Filters · 2 active: income, country',
    )
  })

  it('renders the chips beside the toggle, never inside the button', () => {
    const { model } = fakeModel(COLUMNS, [
      { column: 'income', predicate: '> 50000' },
      { column: 'country', predicate: "= 'US'" },
    ])
    render(<FilterBar model={model} />)
    // The bar auto-opens on a non-empty filter list (uxc-4); collapse it to
    // reach the recommended collapsed posture.
    toggleBar()
    expect(screen.getByTestId('filter-toggle').getAttribute('aria-expanded')).toBe('false')

    const toggle = screen.getByTestId('filter-toggle')
    const chips = screen.getAllByTestId('filter-chip')
    expect(chips).toHaveLength(2)
    for (const chip of chips) {
      // Sibling, not descendant: a button may not contain interactive controls.
      expect(toggle.contains(chip)).toBe(false)
      expect(chip.closest('button')).toBeNull()
    }
    const header = screen.getByTestId('filter-chips-header')
    expect(header.previousElementSibling).toBe(toggle)
    expect(header.parentElement).toBe(toggle.parentElement)
    expect(chips.map((chip) => chip.getAttribute('data-col-name'))).toEqual(['income', 'country'])
    // The expanded body's own chip list is not rendered while collapsed, so no
    // chip appears twice.
    expect(screen.queryByTestId('filter-chips')).toBeNull()
  })

  it('removes a filter from a collapsed chip and restores the summary', async () => {
    const model = storeModel(COLUMNS)
    render(<FilterBar model={model} />)
    await act(async () => {
      await model.setFilters([{ column: 'income', predicate: '> 50000' }])
    })
    const toggle = screen.getByTestId('filter-toggle')
    toggleBar()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe('Filters · 1 active: income')

    fireEvent.click(control('filter-chip-remove', 'income'))

    await waitFor(() => {
      expect(toggle.textContent).toBe('Filters')
    })
    expect(model.filters).toEqual([])
    expect(screen.queryByTestId('filter-chip')).toBeNull()
    expect(screen.queryByTestId('filter-chips-header')).toBeNull()
  })

  it('keeps the collapsed chips/summary in step with a same-identity re-set', async () => {
    const model = storeModel(COLUMNS)
    render(<FilterBar model={model} />)
    await act(async () => {
      await model.setFilters([
        { column: 'income', predicate: '> 50000' },
        { column: 'country', predicate: "= 'US'" },
      ])
    })
    const toggle = screen.getByTestId('filter-toggle')
    toggleBar()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    // A fresh-but-equal list re-fires the effect; the latch keeps the bar
    // collapsed and the header chips still mirror `model.filters`.
    await act(async () => {
      await model.setFilters([
        { column: 'income', predicate: '> 50000' },
        { column: 'country', predicate: "= 'US'" },
      ])
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe('Filters · 2 active: income, country')
    expect(screen.getByTestId('filter-chips-header').children).toHaveLength(2)
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
    ensureOpen()

    // A user edit starts an apply that has not landed yet (pending).
    compose('income', 'gt', '50000')

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
    expect(toggle.textContent).toBe('Filters · 1 active: income')
  })
})

describe('FilterBar compose row (ug-18 / UG-16)', () => {
  it('renders exactly one column/operator/value/Apply set and no builder wall', () => {
    const { model } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    ensureOpen()

    expect(screen.getAllByTestId('filter-compose-column')).toHaveLength(1)
    expect(screen.getAllByTestId('filter-compose-operator')).toHaveLength(1)
    expect(screen.getAllByTestId('filter-compose-value')).toHaveLength(1)
    expect(screen.getAllByTestId('filter-compose-apply')).toHaveLength(1)
    expect(screen.getByText('Filter on:')).toBeTruthy()

    // The per-column builder wall is gone: none of its controls remain.
    for (const testId of [
      'filter-builder-column',
      'filter-builder-operator',
      'filter-builder-value',
      'filter-builder-apply',
    ]) {
      expect(screen.queryAllByTestId(testId)).toHaveLength(0)
    }
    expect(screen.queryAllByTestId('filter-active-row')).toHaveLength(0)
  })

  it("offers the schema columns and the selected column kind's operators", () => {
    const { model } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    ensureOpen()

    expect(Array.from(composeColumn().options).map((option) => option.value)).toEqual([
      'income',
      'country',
      'signup_date',
      'active',
    ])
    // Default column = the first schema column (numeric), default operator =
    // that kind's first catalog entry.
    expect(composeColumn().value).toBe('income')
    expect(composeOperatorIds()).toEqual([
      'eq',
      'neq',
      'gt',
      'gte',
      'lt',
      'lte',
      'is-null',
      'is-not-null',
    ])

    fireEvent.change(composeColumn(), { target: { value: 'country' } })
    expect(composeOperatorIds()).toEqual(['eq', 'neq', 'contains', 'is-null', 'is-not-null'])

    fireEvent.change(composeColumn(), { target: { value: 'active' } })
    expect(composeOperatorIds()).toEqual(['is-true', 'is-false', 'is-null', 'is-not-null'])
  })

  it("resets the operator to the new kind's default when the column changes", () => {
    const { model } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    ensureOpen()

    fireEvent.change(composeOperator(), { target: { value: 'gt' } })
    expect(composeOperator().value).toBe('gt')

    fireEvent.change(composeColumn(), { target: { value: 'country' } })
    expect(composeOperator().value).toBe('eq')

    fireEvent.change(composeColumn(), { target: { value: 'active' } })
    expect(composeOperator().value).toBe('is-true')
    // A boolean `= true` operator takes no value, so the input is gone.
    expect(screen.queryByTestId('filter-compose-value')).toBeNull()
  })

  it('compiles a numeric operator+value into the exact predicate handed to setFilters', async () => {
    const { model, setFilters } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    ensureOpen()

    compose('income', 'gt', '50000')

    await waitFor(() => {
      expect(setFilters).toHaveBeenCalledWith([{ column: 'income', predicate: '> 50000' }])
    })
  })

  it('escapes LIKE metacharacters in a string contains predicate', async () => {
    const { model, setFilters } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    ensureOpen()

    compose('country', 'contains', '50%')

    await waitFor(() => {
      expect(setFilters).toHaveBeenCalledWith([
        { column: 'country', predicate: "LIKE '%50\\%%' ESCAPE '\\'" },
      ])
    })
  })

  it("compiles a temporal value with the column's literal keyword", async () => {
    const { model, setFilters } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    ensureOpen()

    compose('signup_date', 'gte', '2025-01-04')

    await waitFor(() => {
      expect(setFilters).toHaveBeenCalledWith([
        { column: 'signup_date', predicate: ">= DATE '2025-01-04'" },
      ])
    })
  })

  it('hides the value input for operators that take none', () => {
    const { model } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    ensureOpen()

    expect(screen.getByTestId('filter-compose-value')).toBeTruthy()
    fireEvent.change(composeOperator(), { target: { value: 'is-null' } })
    expect(screen.queryByTestId('filter-compose-value')).toBeNull()
  })

  it('clears only the value after a successful apply and keeps the selection', async () => {
    const { model, setFilters } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    ensureOpen()

    compose('country', 'contains', 'U')

    await waitFor(() => {
      expect(setFilters).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(composeValue().value).toBe('')
    })
    expect(composeColumn().value).toBe('country')
    expect(composeOperator().value).toBe('contains')
  })

  it('applies on Enter in the value input', async () => {
    const { model, setFilters } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    ensureOpen()

    fireEvent.change(composeColumn(), { target: { value: 'income' } })
    fireEvent.change(composeOperator(), { target: { value: 'gt' } })
    fireEvent.change(composeValue(), { target: { value: '50000' } })
    fireEvent.keyDown(composeValue(), { key: 'Enter' })

    await waitFor(() => {
      expect(setFilters).toHaveBeenCalledWith([{ column: 'income', predicate: '> 50000' }])
    })
  })
})

describe('FilterBar client-side rejection (ux-4 / ug-18)', () => {
  it('rejects an empty value inline without calling setFilters', () => {
    const { model, setFilters } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    ensureOpen()

    compose('income', 'gt')

    expect(setFilters).not.toHaveBeenCalled()
    const message = screen.getByTestId('filter-builder-error')
    expect(message.getAttribute('role')).toBe('alert')
    expect(message.textContent).toBe('Enter a value for this operator.')
    expect(message.textContent).not.toMatch(/\r|\n/)
    // The rejection names the column it is about, so a column-scoped locator
    // (tests/e2e/a11y.spec.ts) keeps its association instead of matching any
    // future error element in the bar.
    expect(message.getAttribute('data-col-name')).toBe('income')
  })

  it('rejects a non-numeric value for a numeric column inline', () => {
    const { model, setFilters } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    ensureOpen()

    compose('income', 'gt', 'abc')

    expect(setFilters).not.toHaveBeenCalled()
    expect(screen.getByTestId('filter-builder-error').textContent).toBe('That is not a number.')
  })

  it('rejects a malformed date inline', () => {
    const { model, setFilters } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    ensureOpen()

    compose('signup_date', 'eq', '2025-02-30')

    expect(setFilters).not.toHaveBeenCalled()
    expect(screen.getByTestId('filter-builder-error').textContent).toBe(
      'Enter a date as YYYY-MM-DD.',
    )
  })

  it('replaces the message on the next successful apply', async () => {
    const { model, setFilters } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    ensureOpen()

    compose('income', 'gt', 'abc')
    expect(screen.getByTestId('filter-builder-error')).toBeTruthy()

    compose('income', 'gt', '50000')
    await waitFor(() => {
      expect(setFilters).toHaveBeenCalledWith([{ column: 'income', predicate: '> 50000' }])
    })
    expect(screen.queryByTestId('filter-builder-error')).toBeNull()
  })
})

describe('FilterBar active filter rows (ug-18)', () => {
  it('pre-fills the current predicate and names the column', () => {
    const { model } = fakeModel(COLUMNS, [
      { column: 'income', predicate: '> 50000' },
      { column: 'country', predicate: "= 'US'" },
    ])
    render(<FilterBar model={model} />)
    ensureOpen()

    const rows = screen.getAllByTestId('filter-active-row')
    expect(rows.map((row) => row.getAttribute('data-col-name'))).toEqual(['income', 'country'])
    expect((control('filter-active-predicate', 'income') as HTMLInputElement).value).toBe('> 50000')
    expect((control('filter-active-predicate', 'country') as HTMLInputElement).value).toBe("= 'US'")
    // The label is the fixed column name, wired to the editable predicate.
    const label = document.querySelector(`label[for="${filterActivePredicateId('income')}"]`)
    expect(label?.textContent).toBe('income')
  })

  it("replaces one column's predicate through setFilters", async () => {
    const { model, setFilters } = fakeModel(COLUMNS, [
      { column: 'income', predicate: '> 50000' },
      { column: 'country', predicate: "= 'US'" },
    ])
    render(<FilterBar model={model} />)
    ensureOpen()

    fireEvent.change(control('filter-active-predicate', 'income'), {
      target: { value: '> 60000' },
    })
    fireEvent.click(control('filter-active-apply', 'income'))

    await waitFor(() => {
      expect(setFilters).toHaveBeenCalledWith([
        { column: 'country', predicate: "= 'US'" },
        { column: 'income', predicate: '> 60000' },
      ])
    })
  })

  it('removes the filter when the edited predicate is emptied', async () => {
    const { model, setFilters } = fakeModel(COLUMNS, [{ column: 'income', predicate: '> 50000' }])
    render(<FilterBar model={model} />)
    ensureOpen()

    fireEvent.change(control('filter-active-predicate', 'income'), { target: { value: '' } })
    fireEvent.click(control('filter-active-apply', 'income'))

    await waitFor(() => {
      expect(setFilters).toHaveBeenCalledWith([])
    })
  })

  it('removes one filter with its Remove button, keeping the others', async () => {
    const { model, setFilters } = fakeModel(COLUMNS, [
      { column: 'income', predicate: '> 50000' },
      { column: 'country', predicate: "= 'US'" },
    ])
    render(<FilterBar model={model} />)
    ensureOpen()

    fireEvent.click(control('filter-active-remove', 'income'))

    await waitFor(() => {
      expect(setFilters).toHaveBeenCalledWith([{ column: 'country', predicate: "= 'US'" }])
    })
  })

  it('applies an active-row edit on Enter', async () => {
    const { model, setFilters } = fakeModel(COLUMNS, [{ column: 'income', predicate: '> 50000' }])
    render(<FilterBar model={model} />)
    ensureOpen()

    const input = control('filter-active-predicate', 'income')
    fireEvent.change(input, { target: { value: 'IS NULL' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(setFilters).toHaveBeenCalledWith([{ column: 'income', predicate: 'IS NULL' }])
    })
  })
})

describe('FilterBar active-row prefill fidelity (ug-18 round 2)', () => {
  it('re-applies the predicate an untouched row DISPLAYS after a programmatic setFilters', async () => {
    const model = storeModel(COLUMNS)
    const setFilters = vi.spyOn(model, 'setFilters')
    render(<FilterBar model={model} />)

    // The validation panel's "Show only failing rows" (or a profile top-k
    // click) sets the filter list, not this component: no draft was ever typed.
    await act(async () => {
      await model.setFilters([{ column: 'income', predicate: '> 50000' }])
    })
    const input = control('filter-active-predicate', 'income') as HTMLInputElement
    expect(input.value).toBe('> 50000')
    setFilters.mockClear()

    // Finding 1: Apply on the untouched row must hand over the value it shows.
    // Before the fix the accepted predicate was displayed but `''` was sent, so
    // the filter silently disappeared.
    fireEvent.click(control('filter-active-apply', 'income'))
    await waitFor(() => {
      expect(setFilters).toHaveBeenLastCalledWith([{ column: 'income', predicate: '> 50000' }])
    })
    expect(model.filters).toEqual([{ column: 'income', predicate: '> 50000' }])

    // The second attempt is only dispatchable once the first has finished: the
    // bar is single-flight (`pending` disables every control and `applyList`
    // refuses a submit, ug-19). A user cannot press Enter mid-apply either —
    // the row's input is disabled then — so wait on the bar's own transition
    // back to idle rather than assume the first await already landed it.
    await waitFor(() => {
      expect((control('filter-active-apply', 'income') as HTMLButtonElement).disabled).toBe(false)
    })

    // Enter is the same submission path. Re-queried: the row is keyed by
    // column:predicate, so a wait that crosses a render must not reuse a node
    // captured before it.
    fireEvent.keyDown(control('filter-active-predicate', 'income'), { key: 'Enter' })
    await waitFor(() => {
      expect(setFilters).toHaveBeenCalledTimes(2)
    })
    expect(setFilters).toHaveBeenLastCalledWith([{ column: 'income', predicate: '> 50000' }])
    expect(model.filters).toEqual([{ column: 'income', predicate: '> 50000' }])
  })

  it('refreshes the draft when a programmatic replacement lands on the same column', async () => {
    const model = storeModel(COLUMNS)
    const setFilters = vi.spyOn(model, 'setFilters')
    render(<FilterBar model={model} />)
    await act(async () => {
      await model.setFilters([{ column: 'income', predicate: '> 50000' }])
    })

    // The user starts an edit…
    fireEvent.change(control('filter-active-predicate', 'income'), {
      target: { value: '> 60000' },
    })
    expect((control('filter-active-predicate', 'income') as HTMLInputElement).value).toBe('> 60000')

    // …and the bridge replaces the same column's predicate before they submit.
    // Finding 2: the row must show the accepted predicate again, and a stale
    // Apply must not overwrite the programmatic filter with the old draft.
    await act(async () => {
      await model.setFilters([{ column: 'income', predicate: '> 70000' }])
    })
    // (Re-queried: the row is keyed by column:predicate, so a replacement
    // mounts a fresh input — the value here is the seeded draft, not a
    // leftover DOM node.)
    expect((control('filter-active-predicate', 'income') as HTMLInputElement).value).toBe('> 70000')
    setFilters.mockClear()

    fireEvent.click(control('filter-active-apply', 'income'))
    await waitFor(() => {
      expect(setFilters).toHaveBeenLastCalledWith([{ column: 'income', predicate: '> 70000' }])
    })
    expect(model.filters).toEqual([{ column: 'income', predicate: '> 70000' }])
  })

  it('does not resurrect the draft of an earlier accepted apply over a replacement', async () => {
    const model = storeModel(COLUMNS)
    const setFilters = vi.spyOn(model, 'setFilters')
    render(<FilterBar model={model} />)
    await act(async () => {
      await model.setFilters([{ column: 'income', predicate: '> 50000' }])
    })

    // An accepted apply seeds the draft (`applyList` → sync).
    fireEvent.change(control('filter-active-predicate', 'income'), { target: { value: '> 60000' } })
    fireEvent.click(control('filter-active-apply', 'income'))
    await waitFor(() => {
      expect(model.filters).toEqual([{ column: 'income', predicate: '> 60000' }])
    })

    // A later programmatic replacement must win over that seeded draft.
    await act(async () => {
      await model.setFilters([{ column: 'income', predicate: '> 70000' }])
    })
    expect((control('filter-active-predicate', 'income') as HTMLInputElement).value).toBe('> 70000')
    setFilters.mockClear()
    fireEvent.click(control('filter-active-apply', 'income'))
    await waitFor(() => {
      expect(setFilters).toHaveBeenLastCalledWith([{ column: 'income', predicate: '> 70000' }])
    })
  })

  it('still removes the filter when the user explicitly empties the input', async () => {
    const model = storeModel(COLUMNS)
    render(<FilterBar model={model} />)
    await act(async () => {
      await model.setFilters([{ column: 'income', predicate: '> 50000' }])
    })

    const input = control('filter-active-predicate', 'income') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(control('filter-active-apply', 'income'))

    await waitFor(() => {
      expect(model.filters).toEqual([])
    })
  })
})

describe('FilterBar removal surfaces (ug-18 round 2)', () => {
  it('has exactly one removal control per filter in each state', () => {
    const { model } = fakeModel(COLUMNS, [
      { column: 'income', predicate: '> 50000' },
      { column: 'country', predicate: "= 'US'" },
    ])
    render(<FilterBar model={model} />)
    ensureOpen()

    // Expanded: each filter has one removal control — its active row's Remove.
    expect(removalControls()).toHaveLength(2)
    expect(screen.queryAllByTestId('filter-chip-remove')).toHaveLength(0)
    for (const row of screen.getAllByTestId('filter-active-row')) {
      expect(row.querySelectorAll('[data-testid="filter-active-remove"]')).toHaveLength(1)
    }
    // The body chips survive as a DISPLAY surface (other panels assert their
    // code text) but carry no remove button of their own.
    expect(
      screen.getAllByTestId('filter-chip').map((chip) => chip.querySelector('code')?.textContent),
    ).toEqual(['income > 50000', "country = 'US'"])

    // Collapsed: the header chips are the only removal surface; the rows are
    // gone. Still exactly one control per filter.
    toggleBar()
    expect(removalControls()).toHaveLength(2)
    expect(screen.getAllByTestId('filter-chip-remove')).toHaveLength(2)
    expect(screen.queryAllByTestId('filter-active-remove')).toHaveLength(0)
  })
})

describe('FilterBar removal guard and rollback (ug-18 round 2)', () => {
  it('ignores a removal while an apply is in flight (pending guard)', async () => {
    const { model, flush } = blockingModel(COLUMNS, [{ column: 'income', predicate: '> 50000' }])
    const setFilters = vi.spyOn(model, 'setFilters')
    render(<FilterBar model={model} />)

    // A second apply (an edit of the same row) is in flight and has not landed.
    fireEvent.change(control('filter-active-predicate', 'income'), { target: { value: '> 60000' } })
    fireEvent.click(control('filter-active-apply', 'income'))
    expect(setFilters).toHaveBeenCalledTimes(1)

    // Removal is refused while that apply is pending: the control is disabled,
    // and `applyList`'s guard drops a call that reaches it anyway.
    const remove = control('filter-active-remove', 'income') as HTMLButtonElement
    expect(remove.disabled).toBe(true)
    fireEvent.click(remove)
    expect(setFilters).toHaveBeenCalledTimes(1)

    // The in-flight apply is the only thing that lands — nothing was removed.
    await act(async () => {
      flush()
    })
    expect(setFilters).toHaveBeenCalledTimes(1)
    expect(model.filters).toEqual([{ column: 'income', predicate: '> 60000' }])

    // The guard is a gate, not a permanent block: removal works once idle.
    fireEvent.click(control('filter-active-remove', 'income'))
    await act(async () => {
      flush()
    })
    expect(model.filters).toEqual([])
  })

  it('leaves restoration to the model and frames the refusal once (single setFilters per attempt)', async () => {
    const previous = [
      { column: 'income', predicate: '> 50000' },
      { column: 'country', predicate: "= 'US'" },
    ]
    const { model, setFilters } = failingModel(COLUMNS, {
      filters: previous,
      failures: [
        new FilterApplyError(
          'refused-before-change',
          new Error(
            'Binder Error: Referenced column "nope" not found in FROM clause!\n' +
              'LINE 1: SELECT * FROM "assay_t1" WHERE "nope" = 1',
          ),
        ),
      ],
    })
    render(<FilterBar model={model} />)

    fireEvent.click(control('filter-active-remove', 'income'))

    const error = await screen.findByTestId('filter-error')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toBe(
      'The filter could not be applied: Binder Error: Referenced column "nope" not found in ' +
        'FROM clause. The previous filters are still in effect.',
    )
    expect(error.textContent).not.toMatch(/\r|\n/)
    // C02b — exactly ONE `setFilters` per attempt: the refusal is
    // all-before-commit and the model keeps the previous list effective, so
    // there is nothing for the bar to restore (C01 §7 single owner).
    expect(setFilters).toHaveBeenCalledTimes(1)
    expect(setFilters).toHaveBeenCalledWith([{ column: 'country', predicate: "= 'US'" }])
    expect(model.filters).toEqual(previous)
  })
})

describe('FilterBar SQL predicate escape hatch (ux-4 / ug-18)', () => {
  it('is a collapsed "SQL predicates" disclosure holding the per-column inputs', () => {
    const { model } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    ensureOpen()

    const disclosure = screen.getByTestId('filter-sql-disclosure')
    expect(disclosure.tagName).toBe('DETAILS')
    expect(disclosure.hasAttribute('open')).toBe(false)
    expect(disclosure.querySelector('summary')?.textContent).toBe('SQL predicates')
    // The hint and the per-column inputs live inside the disclosure.
    expect(disclosure.contains(screen.getByTestId('filter-hint'))).toBe(true)
    expect(disclosure.contains(screen.getByTestId('filter-columns'))).toBe(true)
    expect(screen.getByTestId('filter-hint').textContent).toContain('("column" <predicate>)')
    expect(control('filter-input', 'country').closest('details')).toBe(disclosure)
  })

  it('still emits the raw fragment through setFilters', async () => {
    const { model, setFilters } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    ensureOpen()

    fireEvent.change(control('filter-input', 'country'), { target: { value: "= 'US'" } })
    fireEvent.click(control('filter-apply', 'country'))

    await waitFor(() => {
      expect(setFilters).toHaveBeenCalledWith([{ column: 'country', predicate: "= 'US'" }])
    })
  })

  it('applies a fragment on Enter', async () => {
    const { model, setFilters } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    ensureOpen()

    const input = control('filter-input', 'income')
    fireEvent.change(input, { target: { value: 'IS NOT NULL' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(setFilters).toHaveBeenCalledWith([{ column: 'income', predicate: 'IS NOT NULL' }])
    })
  })
})

/**
 * UG-30 pin, extended by C02b: a rejected filter change renders ONE
 * single-line message. The FilterBar no longer restores anything itself — the
 * model owns the transaction, its single restoration attempt and the
 * `FilterApplyError.phase` classification (C01 §7), so the copy is derived
 * from the phase and the bar issues exactly one `setFilters` per attempt.
 */
describe('FilterBar engine-error framing (UG-30, C02b phases)', () => {
  it('renders a single-line, framed refusal and leaves restoration to the model', async () => {
    const { model, setFilters } = failingModel(COLUMNS, {
      failures: [
        new FilterApplyError(
          'refused-before-change',
          new Error(
            'Binder Error: Referenced column "nope" not found in FROM clause!\n' +
              'LINE 1: SELECT * FROM "assay_t1" WHERE "nope" = 1',
          ),
        ),
      ],
    })
    render(<FilterBar model={model} />)
    ensureOpen()

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
    // One attempt, no compensating restore: the refused list was never in
    // effect, so the model still publishes the previous (empty) list.
    expect(setFilters).toHaveBeenCalledTimes(1)
    expect(setFilters).toHaveBeenCalledWith([{ column: 'country', predicate: "= 'US'" }])
    expect(model.filters).toEqual([])
    // A refusal offers no recovery control: re-applying IS the recovery.
    expect(screen.queryByTestId('filter-error-retry')).toBeNull()
    expect(screen.queryByTestId('filter-error-clear')).toBeNull()
  })

  it('renders the reload-failure copy for an accepted apply whose view could not reload (case b)', async () => {
    const VIOLENT = 'VIOLENT_SENTINEL'
    const { model, setFilters, refresh } = failingModel(COLUMNS, {
      failures: [
        new FilterApplyError(
          'accepted-reload-failed',
          new Error(`${VIOLENT}: the filtered count failed to execute\nLINE 1: SELECT ...`),
        ),
      ],
    })
    render(<FilterBar model={model} />)
    ensureOpen()

    fireEvent.change(control('filter-input', 'country'), { target: { value: "= 'US'" } })
    fireEvent.click(control('filter-apply', 'country'))

    const error = await screen.findByTestId('filter-error')
    expect(error.getAttribute('role')).toBe('alert')
    // C01 §10 decision 5: applied, view not reloaded. Never a rollback claim.
    expect(error.textContent).toBe(FILTER_RELOAD_FAILED_MESSAGE)
    expect(error.textContent).not.toContain('previous filters')
    expect(error.textContent).not.toContain('still in effect')
    // The reload error is diagnostics only — `model.reloadError` is never
    // rendered, so the sentinel and any engine text stay out of the DOM.
    expect(document.body.textContent).not.toContain(VIOLENT)
    expect(document.body.textContent).not.toContain('LINE 1')
    expect(error.textContent).not.toMatch(/\r|\n/)
    // One attempt; the accepted list is the model's business.
    expect(setFilters).toHaveBeenCalledTimes(1)

    // The recovery is the model's own reload: one `refresh()`, no filter write,
    // and the alert clears once the view actually reloads.
    const retry = screen.getByTestId('filter-error-retry') as HTMLButtonElement
    expect(retry.textContent).toBe('Retry')
    fireEvent.click(retry)
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(screen.queryByTestId('filter-error')).toBeNull()
    })
    expect(setFilters).toHaveBeenCalledTimes(1)
  })

  it('states the unknown filter list when a legacy restore also failed (restore-failed)', async () => {
    const { model, setFilters } = failingModel(COLUMNS, {
      failures: [
        new FilterApplyError(
          'restore-failed',
          new Error(
            'Binder Error: Referenced column "nope" not found in FROM clause!\n' +
              'LINE 1: SELECT * FROM "assay_t1" WHERE "nope" = 1',
          ),
        ),
      ],
    })
    render(<FilterBar model={model} />)
    ensureOpen()

    fireEvent.change(control('filter-input', 'country'), { target: { value: "= 'US'" } })
    fireEvent.click(control('filter-apply', 'country'))

    const error = await screen.findByTestId('filter-error')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toBe(FILTER_RESTORE_FAILED_MESSAGE)
    // Neither list is claimed: no rollback promise may survive here.
    expect(error.textContent).not.toContain('still in effect')
    // No raw diagnostic, no engine vocabulary, no second line.
    expect(error.textContent).not.toContain('Binder Error')
    expect(error.textContent).not.toMatch(/\r|\n/)
    expect(document.body.textContent).not.toContain('LINE 1')
    // Exactly one attempt: the model's restore already failed, so a caller
    // retry would be a second guess at an unknown state.
    expect(setFilters).toHaveBeenCalledTimes(1)

    // The documented way out: Clear filters re-applies the empty list — the
    // one call that also clears the model's `filtersUnknown`.
    const clear = screen.getByTestId('filter-error-clear') as HTMLButtonElement
    expect(clear.textContent).toBe('Clear filters')
    fireEvent.click(clear)
    await waitFor(() => {
      expect(setFilters).toHaveBeenCalledTimes(2)
    })
    expect(setFilters).toHaveBeenLastCalledWith([])
  })
})

/**
 * C02b end-to-end (C01 §9.1 row 13): the FilterBar over the REAL
 * `GridViewportModel` and a provider double. Here the transaction, the
 * restoration and the phase classification are the production ones — the bar
 * only maps the outcome to copy. The pins:
 *
 * - an atomic provider refusal issues ONE list write and no restore (the
 *   refusal was all-before-commit, the published list never changed);
 * - a legacy provider (no `replaceFilters`) that rejects mid-sequence gets
 *   exactly ONE model-owned restore to the published list — the bar adds no
 *   second one — and reports `refused-before-change`;
 * - an accepted list whose reload fails reports `accepted-reload-failed`,
 *   keeps the accepted list, and records `reloadError` without rendering it.
 */
describe('FilterBar over the real model (C02b) — one owner of restoration', () => {
  interface ProviderLog {
    readonly lists: (readonly FilterSpec[])[]
    readonly legacyCalls: (FilterSpec | null)[]
    readonly rowCounts: number
  }

  /**
   * A provider double. `atomic: false` omits `replaceFilters` entirely, so the
   * model takes the documented legacy `filter(null)` + N x `filter(spec)`
   * sequence (the non-atomic fallback C02b must keep honest).
   */
  function providerDouble(options: {
    atomic: boolean
    refuse?: (specs: readonly FilterSpec[]) => boolean
    refuseLegacyCall?: (call: FilterSpec | null, index: number) => boolean
    failReloads?: number
  }): {
    provider: GridDataProvider
    log: ProviderLog
    current: () => readonly FilterSpec[]
    armReloadFailure: () => void
    /** Hold the next accepted list INSIDE the provider call (before publish). */
    holdNextReplace: () => () => void
  } {
    const log = {
      lists: [] as (readonly FilterSpec[])[],
      legacyCalls: [] as (FilterSpec | null)[],
      rowCounts: 0,
    }
    let current: FilterSpec[] = []
    let reloadFailures = options.failReloads ?? 0
    let replaceGate: Promise<void> | null = null
    const provider: GridDataProvider = {
      schema: async () => COLUMNS.map((column) => ({ ...column })),
      rowCount: async () => {
        log.rowCounts += 1
        if (reloadFailures > 0) {
          reloadFailures -= 1
          throw new Error('VIOLENT_SENTINEL: the filtered count failed')
        }
        return 0
      },
      fetchRange: async (range) => ({ startRow: range.startRow, rows: [] }),
      sort: async () => {},
      filter: async (spec) => {
        log.legacyCalls.push(spec)
        if (options.refuseLegacyCall?.(spec, log.legacyCalls.length - 1) === true) {
          throw new Error('VIOLENT_SENTINEL: legacy mid-sequence refusal')
        }
        current = spec === null ? [] : [...current, spec]
      },
    }
    if (options.atomic) {
      provider.replaceFilters = async (specs) => {
        log.lists.push([...specs])
        if (options.refuse?.(specs) === true) {
          throw new Error('VIOLENT_SENTINEL: atomic refusal')
        }
        current = [...specs]
        // Optional hold AFTER the provider committed but BEFORE the model
        // publishes: the window R-C01 rule 1 is about.
        if (replaceGate !== null) {
          const gate = replaceGate
          replaceGate = null
          await gate
        }
      }
    }
    return {
      provider,
      log,
      current: () => current,
      armReloadFailure: () => {
        reloadFailures = 1
      },
      holdNextReplace: () => {
        let release: () => void = () => {}
        replaceGate = new Promise<void>((resolve) => {
          release = resolve
        })
        return () => {
          release()
        }
      },
    }
  }

  it('an atomic refusal writes the list once, restores nothing, and says so', async () => {
    const { provider, log, current } = providerDouble({ atomic: true, refuse: () => true })
    const model = new GridViewportModel(provider)
    // One load so the bar has a schema to build inputs from; the refusal below
    // is the only request this test measures.
    await model.load()
    const countsAfterLoad = log.rowCounts
    const setFilters = vi.spyOn(model, 'setFilters')
    render(<FilterBar model={model} />)
    ensureOpen()

    fireEvent.change(control('filter-input', 'country'), { target: { value: "= 'US'" } })
    fireEvent.click(control('filter-apply', 'country'))

    const error = await screen.findByTestId('filter-error')
    expect(error.textContent).toBe(
      'The filter could not be applied: VIOLENT_SENTINEL: atomic refusal. ' +
        'The previous filters are still in effect.',
    )
    // One list write, no restore sequence, no second setFilters.
    expect(log.lists).toEqual([[{ column: 'country', predicate: "= 'US'" }]])
    expect(setFilters).toHaveBeenCalledTimes(1)
    expect(current()).toEqual([])
    expect(model.filters).toEqual([])
    // Refused before any change: no epoch was opened, so no scan happened.
    expect(log.rowCounts).toBe(countsAfterLoad)
  })

  it('a legacy mid-sequence refusal gets exactly one model restore to the published list', async () => {
    const published: FilterSpec = { column: 'income', predicate: '> 50000' }
    const { provider, log, current } = providerDouble({
      atomic: false,
      // Refuse the SECOND legacy call of the second request only: the first
      // request (seeding `published`) pushes `null` then one spec.
      refuseLegacyCall: (_spec, index) => index === 4,
    })
    const model = new GridViewportModel(provider)
    const setFilters = vi.spyOn(model, 'setFilters')
    await model.setFilters([published])
    expect(model.filters).toEqual([published])
    setFilters.mockClear()

    render(<FilterBar model={model} />)
    ensureOpen()
    fireEvent.change(control('filter-input', 'country'), { target: { value: "= 'US'" } })
    fireEvent.click(control('filter-apply', 'country'))

    const error = await screen.findByTestId('filter-error')
    expect(error.textContent).toBe(
      'The filter could not be applied: VIOLENT_SENTINEL: legacy mid-sequence refusal. ' +
        'The previous filters are still in effect.',
    )
    // The bar issued exactly one list write...
    expect(setFilters).toHaveBeenCalledTimes(1)
    expect(setFilters).toHaveBeenCalledWith([
      { column: 'income', predicate: '> 50000' },
      { column: 'country', predicate: "= 'US'" },
    ])
    // ...and the model issued exactly one restore, to the PUBLISHED list
    // (clear + the published spec), never to the refused list.
    expect(log.legacyCalls).toEqual([
      null,
      { column: 'income', predicate: '> 50000' }, // the seeding request
      null,
      { column: 'income', predicate: '> 50000' },
      { column: 'country', predicate: "= 'US'" }, // refused here
      null,
      { column: 'income', predicate: '> 50000' }, // the one restore
    ])
    expect(current()).toEqual([published])
    expect(model.filters).toEqual([published])
  })

  it('an accepted list whose reload fails keeps the list, offers Retry, and never renders reloadError', async () => {
    const { provider, log, armReloadFailure } = providerDouble({ atomic: true })
    const model = new GridViewportModel(provider)
    await model.load()
    armReloadFailure()
    render(<FilterBar model={model} />)
    ensureOpen()

    fireEvent.change(control('filter-input', 'country'), { target: { value: "= 'US'" } })
    fireEvent.click(control('filter-apply', 'country'))

    const error = await screen.findByTestId('filter-error')
    expect(error.textContent).toBe(FILTER_RELOAD_FAILED_MESSAGE)
    // Case (b): the provider and the published list hold the NEW list, and the
    // model records the reload diagnostic — which is never rendered.
    expect(log.lists).toEqual([[{ column: 'country', predicate: "= 'US'" }]])
    expect(model.filters).toEqual([{ column: 'country', predicate: "= 'US'" }])
    expect(model.reloadError).not.toBeNull()
    expect(model.filtersUnknown).toBe(false)
    expect(document.body.textContent).not.toContain('VIOLENT_SENTINEL')
    expect(document.body.textContent).not.toContain('LINE 1')

    // Retry reloads the view through the model and clears the alert: the
    // accepted list is untouched by the recovery.
    fireEvent.click(screen.getByTestId('filter-error-retry'))
    await waitFor(() => {
      expect(screen.queryByTestId('filter-error')).toBeNull()
    })
    expect(model.reloadError).toBeNull()
    expect(model.filters).toEqual([{ column: 'country', predicate: "= 'US'" }])
  })

  it('scans once per apply however many specs the list holds (no per-spec scan)', async () => {
    const { provider, log } = providerDouble({ atomic: true })
    const model = new GridViewportModel(provider)
    await model.load()
    const counts = log.rowCounts

    await model.setFilters([
      { column: 'income', predicate: '> 50000' },
      { column: 'country', predicate: "= 'US'" },
    ])

    // One atomic list write and ONE reload: the capability is not a loop of
    // per-spec applies, so a keypress costs one metadata count.
    expect(log.lists).toEqual([
      [
        { column: 'income', predicate: '> 50000' },
        { column: 'country', predicate: "= 'US'" },
      ],
    ])
    expect(log.rowCounts).toBe(counts + 1)
  })

  it('rapid requests in one tick: the loser writes nothing, the winner scans once', async () => {
    const { provider, log } = providerDouble({ atomic: true })
    const model = new GridViewportModel(provider)
    await model.load()
    const counts = log.rowCounts

    // Two requests in the same tick (the double-click / keypress burst shape).
    const first = model.setFilters([{ column: 'income', predicate: '> 50000' }])
    const second = model.setFilters([{ column: 'country', predicate: "= 'US'" }])
    await Promise.all([first, second])

    expect(log.lists).toEqual([[{ column: 'country', predicate: "= 'US'" }]])
    expect(log.rowCounts).toBe(counts + 1)
    expect(model.filters).toEqual([{ column: 'country', predicate: "= 'US'" }])
  })

  it('superseded accepted A never becomes effective; a newer refused B leaves the published list', async () => {
    const P: FilterSpec = { column: 'income', predicate: '> 50000' }
    const A: FilterSpec = { column: 'income', predicate: '> 70000' }
    const B: FilterSpec = { column: 'country', predicate: "= 'REFUSE'" }
    const { provider, log, current, holdNextReplace } = providerDouble({
      atomic: true,
      refuse: (specs) => specs.some((spec) => spec.predicate.includes('REFUSE')),
    })
    const model = new GridViewportModel(provider)
    await model.load()
    await model.setFilters([P])

    // Every published snapshot, to prove A is never observable.
    const snapshots: (readonly FilterSpec[])[] = []
    const unsubscribe = model.subscribe(() => {
      snapshots.push(model.filters)
    })

    const release = holdNextReplace()
    const acceptedA = model.setFilters([A])
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The provider holds A, but the model has not published it yet.
    expect(current()).toEqual([A])
    expect(model.filters).toEqual([P])

    // B supersedes A while A is parked inside the provider call.
    const refusedB = model.setFilters([B])
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()

    // R-C01 rule 1: A settles quietly and is restored to P (never published).
    await expect(acceptedA).resolves.toBeUndefined()
    // R-C01 rule 2: B is refused before changing anything. The refusal is
    // all-before-commit, so the provider still holds the published list — no
    // restore push is needed (and none may be issued).
    await expect(refusedB).rejects.toBeInstanceOf(FilterApplyError)
    await refusedB.catch((error: FilterApplyError) => {
      expect(error.phase).toBe('refused-before-change')
    })

    expect(log.lists).toEqual([[P], [A], [P], [B]])
    expect(current()).toEqual([P])
    expect(model.filters).toEqual([P])
    expect(model.filtersUnknown).toBe(false)
    // No intermediate snapshot ever read A: the superseded list was never
    // effective for the UI.
    expect(snapshots.some((list) => JSON.stringify(list) === JSON.stringify([A]))).toBe(false)
    unsubscribe()
  })
})

/**
 * ug-19 (UG-19) pin: the bar's EXISTING single-flight `pending` transition is
 * reported to the host through the optional `onPendingChange` prop, so the grid
 * can expose `aria-busy` + the footer `Filtering…` status. The callback is
 * reporting only — the apply/rollback path, the disabled controls and the error
 * copy below are unchanged.
 */
describe('FilterBar pending transition reporting (ug-19)', () => {
  it('reports true for the in-flight apply and false once it settles', async () => {
    const { model, flush } = blockingModel(COLUMNS)
    const onPendingChange = vi.fn()
    render(<FilterBar model={model} onPendingChange={onPendingChange} />)
    ensureOpen()

    compose('income', 'gt', '50000')
    expect(onPendingChange.mock.calls).toEqual([[true]])
    // The controls are disabled while the epoch is in flight (unchanged).
    expect((composeApply() as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      flush()
      for (let tick = 0; tick < 4; tick += 1) await Promise.resolve()
    })
    expect(onPendingChange.mock.calls).toEqual([[true], [false]])
  })

  it('reports false on a rejected apply too (the epoch ends on failure)', async () => {
    const { model } = failingModel(COLUMNS, { failures: [new Error('engine unavailable')] })
    const onPendingChange = vi.fn()
    render(<FilterBar model={model} onPendingChange={onPendingChange} />)
    ensureOpen()

    compose('income', 'gt', '50000')
    expect(onPendingChange.mock.calls).toEqual([[true]])

    await screen.findByTestId('filter-error')
    // One epoch: opened once, closed once — the rollback did not re-open it.
    expect(onPendingChange.mock.calls).toEqual([[true], [false]])
  })

  it('works without the optional callback (no host wiring, unchanged bar)', async () => {
    const { model, setFilters } = fakeModel(COLUMNS)
    render(<FilterBar model={model} />)
    ensureOpen()

    compose('country', 'eq', 'US')
    await waitFor(() => {
      expect(setFilters).toHaveBeenCalledWith([{ column: 'country', predicate: "= 'US'" }])
    })
  })
})

/**
 * CO-2 (ug-23) pins: the chip React key must be **injective** in `(column,
 * predicate)`. The old `` `${column}:${predicate}` `` join was not — column
 * `a:b` with predicate `c` and column `a` with predicate `b:c` both joined to
 * `a:b:c`, so two distinct active filters became the same React child (React
 * reconciles by key: one surface can be reused for the other, and the
 * duplicate-key warning is the only trace). Every chip key site — the
 * removable collapsed-header chips and the display-only expanded-body list —
 * uses the shared `filterChipKey` helper.
 */
describe('FilterBar chip identity — injective keys (CO-2, ug-23)', () => {
  // The two pairs collide under the old join and are distinct filters.
  const COLON_COLUMN: FilterSpec = { column: 'a:b', predicate: 'c' }
  const COLON_PREDICATE: FilterSpec = { column: 'a', predicate: 'b:c' }
  // Both are real, distinct columns (a quoted identifier may contain `:`), so
  // the bar can address them through its normal surfaces.
  const COLLIDING_COLUMNS = [
    ...COLUMNS,
    { name: 'a:b', type: 'VARCHAR' },
    { name: 'a', type: 'VARCHAR' },
  ]

  /** Every React duplicate-key warning emitted while `run` executes. */
  async function duplicateKeyWarnings(run: () => Promise<void>): Promise<unknown[][]> {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await run()
      return spy.mock.calls.filter((call) => String(call[0]).includes('same key'))
    } finally {
      spy.mockRestore()
    }
  }

  /** A chip's rendered `<column> <predicate>` label (not its × control). */
  function chipLabel(chip: Element): string {
    return chip.querySelector('code')?.textContent ?? ''
  }

  it('is injective on the colliding pair, where the old join was not', () => {
    // The bug, stated directly: the retired join maps both filters to one key.
    expect(`${COLON_COLUMN.column}:${COLON_COLUMN.predicate}`).toBe(
      `${COLON_PREDICATE.column}:${COLON_PREDICATE.predicate}`,
    )
    // The helper does not.
    expect(filterChipKey(COLON_COLUMN)).not.toBe(filterChipKey(COLON_PREDICATE))
    // …and it is still stable for the same filter (a key, not a random id).
    expect(filterChipKey({ ...COLON_COLUMN })).toBe(filterChipKey(COLON_COLUMN))
  })

  it('renders the colliding pair as two distinct header chips with duplicate-key-free keys', async () => {
    const model = storeModel(COLLIDING_COLUMNS)
    const warnings = await duplicateKeyWarnings(async () => {
      render(<FilterBar model={model} />)
      await act(async () => {
        await model.setFilters([COLON_COLUMN, COLON_PREDICATE])
      })
      toggleBar()
    })

    expect(screen.getByTestId('filter-toggle').getAttribute('aria-expanded')).toBe('false')
    const chips = screen.getAllByTestId('filter-chip')
    expect(chips).toHaveLength(2)
    // Two different chips, not one child rendered twice (the header chip's own
    // text also contains its × control, so compare the label, not the row).
    expect(chips.map(chipLabel)).toEqual(['a:b c', 'a b:c'])
    expect(chips.map((chip) => chip.getAttribute('data-col-name'))).toEqual(['a:b', 'a'])
    // React only logs this when two children share a key.
    expect(warnings).toEqual([])
  })

  it('removes each colliding filter independently from its own chip', async () => {
    const model = storeModel(COLLIDING_COLUMNS)
    render(<FilterBar model={model} />)
    await act(async () => {
      await model.setFilters([COLON_COLUMN, COLON_PREDICATE])
    })
    toggleBar()

    // Remove the FIRST filter through its own chip control.
    fireEvent.click(control('filter-chip-remove', 'a:b'))

    await waitFor(() => {
      expect(model.filters).toEqual([COLON_PREDICATE])
    })
    // A changed filter set force-opens the bar (uxc-4), so collapse again to
    // read the collapsed header chips.
    toggleBar()
    const remaining = screen.getAllByTestId('filter-chip')
    expect(remaining).toHaveLength(1)
    // Exactly the untouched filter survives — its own column, predicate and
    // removal control (not a reused node carrying the removed filter's props).
    expect(remaining[0] === undefined ? null : chipLabel(remaining[0])).toBe('a b:c')
    expect(remaining[0]?.getAttribute('data-col-name')).toBe('a')
    expect(control('filter-chip-remove', 'a').getAttribute('aria-label')).toBe(
      'Remove filter a b:c',
    )
    expect(screen.getByTestId('filter-toggle').textContent).toBe('Filters · 1 active: a')
  })

  it('keys the display-only expanded-body chip list injectively too', async () => {
    const model = storeModel(COLLIDING_COLUMNS)
    const warnings = await duplicateKeyWarnings(async () => {
      render(<FilterBar model={model} />)
      await act(async () => {
        await model.setFilters([COLON_COLUMN, COLON_PREDICATE])
      })
      ensureOpen()
    })

    // Expanded body: the display-only list renders both chips, separately.
    const body = screen.getByTestId('filter-chips')
    expect(Array.from(body.children).map((chip) => chipLabel(chip))).toEqual(['a:b c', 'a b:c'])
    expect(warnings).toEqual([])
  })
})
