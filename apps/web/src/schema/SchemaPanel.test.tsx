// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SchemaPanel } from './SchemaPanel'

/**
 * AR-W11/S4 pin: `pathId` used to sanitize with the lossy
 * `[^A-Za-z0-9_-] → -` mapping, so sibling columns `a.b` and `a-b` produced
 * the same `schema-fields-…` id and one toggle's `aria-controls` pointed at
 * the other's field list. Distinct names must give distinct, real targets.
 */

afterEach(cleanup)

describe('SchemaPanel DOM-id injectivity (S4)', () => {
  it('gives colliding sibling names distinct aria-controls targets', () => {
    render(
      <SchemaPanel
        columns={[
          { name: 'a.b', type: 'STRUCT(v INTEGER)' },
          { name: 'a-b', type: 'STRUCT(v INTEGER)' },
        ]}
        onAction={() => {}}
      />,
    )
    const toggles = screen.getAllByTestId('schema-struct-toggle')
    expect(toggles).toHaveLength(2)
    const ids = toggles.map((toggle) => toggle.getAttribute('aria-controls'))
    expect(ids[0]).not.toBe(ids[1])
    expect(new Set(ids).size).toBe(2)

    // Expand both and assert every aria-controls resolves to its own list.
    for (const toggle of toggles) fireEvent.click(toggle)
    for (const toggle of toggles) {
      const id = toggle.getAttribute('aria-controls')
      expect(id).not.toBeNull()
      const target = document.getElementById(id ?? '')
      expect(target).not.toBeNull()
      expect(target?.getAttribute('data-testid')).toBe('schema-struct-fields')
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
    }
  })
})

describe('SchemaPanel expansion-key unambiguity (S4)', () => {
  it('keeps a `/` column name distinct from nesting in expansion state', () => {
    render(
      <SchemaPanel
        columns={[
          { name: 'x/y', type: 'STRUCT(v INTEGER)' },
          { name: 'x', type: 'STRUCT(y STRUCT(v INTEGER))' },
        ]}
        onAction={() => {}}
      />,
    )
    // Two top-level struct toggles: `x/y` and `x`.
    const top = screen.getAllByTestId('schema-struct-toggle')
    expect(top).toHaveLength(2)

    // Expand the `x/y` column (its name is one segment containing `/`).
    fireEvent.click(top[0])
    expect(top[0].getAttribute('aria-expanded')).toBe('true')

    // Now expand `x`: its child `y` toggle appears and must start collapsed —
    // the shared panel-wide Set keys by encoded segments, so the earlier
    // `x/y` toggle cannot bleed into child `y` of `x` (the raw-concat bug).
    fireEvent.click(top[1])
    const toggles = screen.getAllByTestId('schema-struct-toggle')
    expect(toggles).toHaveLength(3)
    const childY = toggles[2]
    expect(childY.getAttribute('aria-expanded')).toBe('false')
  })
})

/**
 * WF-06 (S-A2-4) — the per-column cast-pending prop became the aggregate set.
 * The UI contract is unchanged: a running check disables (and marks) only ITS
 * OWN column's Rename/Cast controls, so an unrelated column stays usable while
 * two checks may overlap.
 */
describe('SchemaPanel aggregate cast-pending prop (WF-06 S-A2-4)', () => {
  const COLUMNS = [
    { name: 'a', type: 'BIGINT' },
    { name: 'b', type: 'VARCHAR' },
  ]

  function renderWith(castPendingColumns?: ReadonlySet<string>): void {
    render(
      <SchemaPanel
        columns={COLUMNS}
        onAction={() => {}}
        onRenameColumn={() => {}}
        onCastColumn={() => {}}
        castPendingColumns={castPendingColumns}
      />,
    )
  }

  function controls(column: string): HTMLElement {
    return document.querySelector<HTMLElement>(
      `[data-testid="column-rename-open"][data-col-name="${column}"]`,
    ) as HTMLElement
  }

  it('disables and marks ONLY the pending column', () => {
    renderWith(new Set(['a']))
    const renameA = controls('a')
    const renameB = controls('b')
    expect(renameA.hasAttribute('disabled')).toBe(true)
    expect(renameB.hasAttribute('disabled')).toBe(false)
    expect(
      document.querySelector('[data-testid="column-cast-pending"][data-col-name="a"]'),
    ).not.toBeNull()
    expect(
      document.querySelector('[data-testid="column-cast-pending"][data-col-name="b"]'),
    ).toBeNull()
    // Two pending columns are both disabled (the aggregate case).
    cleanup()
    renderWith(new Set(['a', 'b']))
    expect(controls('a').hasAttribute('disabled')).toBe(true)
    expect(controls('b').hasAttribute('disabled')).toBe(true)
    expect(document.querySelectorAll('[data-testid="column-cast-pending"]')).toHaveLength(2)
  })

  it('treats an omitted or empty set as "no check running"', () => {
    renderWith()
    expect(controls('a').hasAttribute('disabled')).toBe(false)
    expect(document.querySelector('[data-testid="column-cast-pending"]')).toBeNull()
    cleanup()
    renderWith(new Set())
    expect(controls('a').hasAttribute('disabled')).toBe(false)
  })
})
