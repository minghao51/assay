// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { GridViewportModel } from '@assay/grid'
import { FilterBar, filterInputId } from './FilterBar'

/**
 * AR-W11 pins: distinct column names must produce distinct DOM ids. The old
 * `[^A-Za-z0-9_-] → -` mapping made `a.b` and `a-b` collide, so one label
 * pointed at the other column's input. Also pins the label↔input association
 * survives.
 */

/** Minimal model surface FilterBar reads (subscribe/getVersion/schema/filters). */
function fakeModel(columns: readonly { name: string; type: string }[]): GridViewportModel {
  return {
    subscribe: () => () => {},
    getVersion: () => 0,
    schema: columns,
    filters: [],
    setFilters: async () => {},
  } as unknown as GridViewportModel
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
})

describe('FilterBar id/label association (AR-W11)', () => {
  it('renders one input per column with a matching, unique label target', () => {
    const columns = [
      { name: 'a.b', type: 'VARCHAR' },
      { name: 'a-b', type: 'VARCHAR' },
    ]
    render(<FilterBar model={fakeModel(columns)} />)
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
