// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GridViewportModel } from '@assay/grid'
import type {
  CellRange,
  ColumnSchema,
  FilterSpec,
  GridDataPage,
  GridDataProvider,
} from '@assay/grid'
import { WebviewDataGrid } from './data-grid'
import {
  FILTER_RELOAD_FAILED_MESSAGE,
  FILTER_RESTORE_FAILED_MESSAGE,
} from '../src/pure/filter-failure'

/**
 * C02c — the desktop filter bar's phase → copy migration, driven through the
 * real `WebviewDataGrid` toolbar and the real `GridViewportModel` transaction
 * (C01 §7, §9.1 assertions 15/16).
 *
 * The pins: the alert renders the phase's copy, never the raw `error.message`
 * (a refused apply is a single framed line, not the engine's multi-line
 * diagnostic); a case-(b) reload failure never claims a rollback and never
 * renders `model.reloadError` (the VIOLENT sentinel stays out of the DOM while
 * remaining available as diagnostics); a `restore-failed` state names the
 * unknown list and offers the Clear-filters affordance. All recovery is the
 * model's (`refresh()` / a clean `setFilters([])`) — the bar issues no
 * compensating filter write of its own.
 */

const SCHEMA: readonly ColumnSchema[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'label', type: 'VARCHAR' },
]

const VIOLENT = 'VIOLENT_RELOAD_SENTINEL'

/** A grid provider double with the exact failure modes each phase needs. */
class LegacyProvider implements GridDataProvider {
  readonly filterList: FilterSpec[] = []
  readonly filterCalls: (FilterSpec | null)[] = []
  /** Total `filter(null)` calls; at/after this ordinal a clear refuses. */
  failClearFrom: number | null = null
  /** Refuse any `filter()` push carrying this predicate. */
  refusePredicate: string | null = null
  /** Reject the next `rowCount()` with this object (a post-acceptance reload). */
  reloadError: Error | null = null
  private clearCalls = 0

  async schema(): Promise<ColumnSchema[]> {
    return [...SCHEMA]
  }

  async rowCount(): Promise<number> {
    if (this.reloadError !== null) {
      const error = this.reloadError
      this.reloadError = null
      throw error
    }
    return 2
  }

  async fetchRange(range: CellRange): Promise<GridDataPage> {
    const rows = [
      [1, 'alpha'],
      [2, 'beta'],
    ].slice(range.startRow, range.endRow)
    return { startRow: range.startRow, rows }
  }

  async sort(): Promise<void> {
    // The copy under test covers filters only; sort stays a no-op recording.
  }

  async filter(spec: FilterSpec | null): Promise<void> {
    this.filterCalls.push(spec)
    if (spec === null) {
      this.clearCalls += 1
      if (this.failClearFrom !== null && this.clearCalls >= this.failClearFrom) {
        throw new Error('the clear was refused')
      }
      this.filterList.length = 0
      return
    }
    if (this.refusePredicate !== null && spec.predicate === this.refusePredicate) {
      throw new Error('the predicate was refused')
    }
    this.filterList.push({ column: spec.column, predicate: spec.predicate })
  }
}

/** The atomic capability: refusal leaves the previous list in effect. */
class AtomicProvider extends LegacyProvider {
  refuseReplaceWith: Error | null = null

  async replaceFilters(specs: readonly FilterSpec[]): Promise<void> {
    if (this.refuseReplaceWith !== null) {
      const error = this.refuseReplaceWith
      this.refuseReplaceWith = null
      throw error
    }
    this.filterList.length = 0
    for (const spec of specs)
      this.filterList.push({ column: spec.column, predicate: spec.predicate })
  }
}

function query<T extends Element>(container: HTMLElement, selector: string): T {
  const element = container.querySelector<T>(selector)
  if (element === null) throw new Error(`missing ${selector}`)
  return element
}

describe('WebviewDataGrid filter-failure copy (C02c)', () => {
  let container: HTMLElement
  let grid: WebviewDataGrid | null = null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    grid?.dispose()
    grid = null
    container.remove()
  })

  async function mount(provider: GridDataProvider): Promise<GridViewportModel> {
    const model = new GridViewportModel(provider)
    await model.load()
    grid = new WebviewDataGrid(model)
    grid.mount(container)
    return model
  }

  function applyFilter(predicate: string): HTMLButtonElement {
    const select = query<HTMLSelectElement>(container, 'select.assay-filter-column')
    const input = query<HTMLInputElement>(container, 'input.assay-filter-predicate')
    const apply = query<HTMLButtonElement>(container, 'button.assay-filter-apply')
    select.value = 'id'
    input.value = predicate
    apply.click()
    return apply
  }

  function errorRegion(): HTMLElement {
    return query<HTMLElement>(container, '.assay-grid-command-error')
  }

  function errorAction(): HTMLButtonElement {
    return query<HTMLButtonElement>(container, '.assay-grid-command-action')
  }

  it('accepted-reload-failed: applied-but-not-reloaded copy, no sentinel, Retry recovery', async () => {
    const provider = new AtomicProvider()
    const model = await mount(provider)
    provider.reloadError = new Error(
      `Binder Error: ${VIOLENT}\nLINE 1: SELECT * FROM "t" WHERE ("id" = 1)`,
    )

    applyFilter('= 1')
    await grid?.whenQuerySettled()

    const region = errorRegion()
    expect(region.hidden).toBe(false)
    expect(region.textContent).toBe(FILTER_RELOAD_FAILED_MESSAGE)
    // §9.1-16: neither the reload diagnostic nor any raw engine text reaches
    // the region; the accepted list stays the published one.
    expect(region.textContent).not.toContain(VIOLENT)
    expect(region.textContent).not.toContain('Binder Error')
    expect(region.textContent).not.toMatch(/\r|\n/)
    expect(region.textContent).not.toContain('previous filters')
    expect(model.filters).toEqual([{ column: 'id', predicate: '= 1' }])
    // Diagnostics stay on the model, never in the DOM.
    expect(model.reloadError).toContain(VIOLENT)

    const action = errorAction()
    expect(action.hidden).toBe(false)
    expect(action.textContent).toBe('Retry')
    expect(action.dataset.action).toBe('retry')

    // The recovery is the model's own reload: a successful refresh hides the
    // alert without issuing another filter write.
    action.click()
    await grid?.whenQuerySettled()
    expect(errorRegion().hidden).toBe(true)
    expect(errorAction().hidden).toBe(true)
    expect(model.reloadError).toBeNull()
    expect(model.filters).toEqual([{ column: 'id', predicate: '= 1' }])
    expect(provider.filterCalls).toEqual([])
  })

  it('refused-before-change: one framed sentence, not the raw multi-line diagnostic', async () => {
    const provider = new AtomicProvider()
    const model = await mount(provider)
    provider.refuseReplaceWith = new Error(
      `Binder Error: ${VIOLENT}\nLINE 1: SELECT * FROM "t" WHERE ("id" = 1)`,
    )

    applyFilter('= 1')
    await grid?.whenQuerySettled()

    const region = errorRegion()
    expect(region.hidden).toBe(false)
    expect(region.textContent).toBe(
      `The filter could not be applied: Binder Error: ${VIOLENT}. ` +
        'The previous filters are still in effect.',
    )
    // Only the summary line survives — the SQL tail never reaches the panel.
    expect(region.textContent).not.toContain('LINE 1')
    expect(region.textContent).not.toMatch(/\r|\n/)
    expect(model.filters).toEqual([])
    expect(model.filtersUnknown).toBe(false)
    expect(errorAction().hidden).toBe(true)
  })

  it('restore-failed: unknown-list copy with the explicit Clear-filters affordance', async () => {
    // No `replaceFilters`: the legacy sequence stays non-atomic, so a partial
    // apply whose restore also fails must report the unknown state.
    const provider = new LegacyProvider()
    const model = await mount(provider)

    applyFilter('= 1')
    await grid?.whenQuerySettled()
    expect(model.filters).toEqual([{ column: 'id', predicate: '= 1' }])

    // The second apply's clear succeeds, its push refuses, and the model's
    // single restore (`filter(null)`) refuses too.
    provider.failClearFrom = 3
    provider.refusePredicate = '= 2'
    applyFilter('= 2')
    await grid?.whenQuerySettled()

    const region = errorRegion()
    expect(region.hidden).toBe(false)
    expect(region.textContent).toBe(FILTER_RESTORE_FAILED_MESSAGE)
    expect(region.textContent).toContain('unknown')
    expect(region.textContent).not.toContain('still in effect')
    expect(region.textContent).not.toMatch(/\r|\n/)
    expect(model.filtersUnknown).toBe(true)
    expect(model.filters).toEqual([{ column: 'id', predicate: '= 1' }])

    const action = errorAction()
    expect(action.hidden).toBe(false)
    expect(action.textContent).toBe('Clear filters')
    expect(action.dataset.action).toBe('clear')

    // Clear is the documented recovery: a successful `setFilters([])` also
    // clears `filtersUnknown`.
    provider.failClearFrom = null
    action.click()
    await grid?.whenQuerySettled()
    expect(errorRegion().hidden).toBe(true)
    expect(model.filters).toEqual([])
    expect(model.filtersUnknown).toBe(false)
  })
})
