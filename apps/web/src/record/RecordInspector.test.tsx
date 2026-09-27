// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { GridViewportModel } from '@assay/grid'
import { encodePathSegment } from '../lib/dom-id'
import {
  buildRecordTree,
  collectBranchPaths,
  RECORD_TREE_DEFAULT_MAX_CHILDREN,
} from './record-tree'
import { RecordInspector } from './RecordInspector'

/**
 * AR-W8 inspector pin: a large list cell is capped with an honest truncation
 * note and a working expand affordance, so the cap is progressive disclosure
 * rather than data loss.
 */

function fakeModel(
  columns: readonly { name: string; type: string }[],
  cells: readonly unknown[],
): GridViewportModel {
  return {
    subscribe: () => () => {},
    getVersion: () => 0,
    schema: columns,
    totalRows: 1,
    sort: null,
    filters: [],
    getRow: () => ({ status: 'ready', row: cells, key: 'base:anchor#0' }),
  } as unknown as GridViewportModel
}

afterEach(cleanup)

describe('RecordInspector AR-W8 caps', () => {
  it('caps a large list, shows a truncation note, and expands on request', () => {
    const big = Array.from({ length: 300 }, (_, index) => index)
    const model = fakeModel([{ name: 'big', type: 'BIGINT[]' }], [big])
    render(
      <RecordInspector
        model={model}
        request={{ rowIndex: 0, seq: 1 }}
        onClosed={() => {}}
        overlayRevision={0}
      />,
    )
    expect(screen.getByTestId('record-inspector')).toBeTruthy()
    expect(screen.getByTestId('record-truncated').textContent).toContain('200 more not shown')
    const showAll = screen.getByTestId('record-show-all-values')

    // Expand the branch to render the (capped) children.
    act(() => {
      fireEvent.click(screen.getByTestId('record-expand-all'))
    })
    expect(screen.getAllByTestId('record-leaf')).toHaveLength(RECORD_TREE_DEFAULT_MAX_CHILDREN)

    // The affordance rebuilds with the expanded caps — no data loss.
    act(() => {
      fireEvent.click(showAll)
    })
    expect(screen.queryByTestId('record-truncated')).toBeNull()
    expect(screen.queryByTestId('record-show-all-values')).toBeNull()
    expect(screen.getAllByTestId('record-leaf')).toHaveLength(300)
  })
})

/**
 * S4 pins: the previous lossy id mapping and the raw `${path}/${key}` expansion
 * key both collapsed distinct record keys. Mirrors `FilterBar.test.tsx`'s
 * AR-W11 collision pin for the inspector's `record-node-…` ids and its
 * encoded-segment expansion keys.
 */
function renderInspector(
  columns: readonly { name: string; type: string }[],
  cells: readonly unknown[],
): void {
  const model = fakeModel(columns, cells)
  render(
    <RecordInspector
      model={model}
      request={{ rowIndex: 0, seq: 1 }}
      onClosed={() => {}}
      overlayRevision={0}
    />,
  )
}

function toggleForKey(key: string): HTMLElement {
  const toggle = screen
    .getAllByTestId('record-node-toggle')
    .find(
      (candidate) =>
        candidate.querySelector('[data-testid="record-node-key"]')?.textContent === key,
    )
  if (toggle === undefined) throw new Error(`no record-node toggle for key ${key}`)
  return toggle
}

describe('RecordInspector DOM-id injectivity (S4)', () => {
  it('gives colliding sibling names distinct, paired aria-controls targets', () => {
    renderInspector(
      [
        { name: 'a.b', type: 'STRUCT(v INTEGER)' },
        { name: 'a-b', type: 'STRUCT(v INTEGER)' },
      ],
      [{ v: 1 }, { v: 2 }],
    )
    const toggles = screen.getAllByTestId('record-node-toggle')
    expect(toggles).toHaveLength(2)
    const ids = toggles.map((toggle) => toggle.getAttribute('aria-controls'))
    expect(ids[0]).not.toBe(ids[1])
    expect(new Set(ids).size).toBe(2)

    for (const toggle of toggles) fireEvent.click(toggle)
    for (const toggle of toggles) {
      const id = toggle.getAttribute('aria-controls')
      expect(id).not.toBeNull()
      const target = document.getElementById(id ?? '')
      expect(target).not.toBeNull()
      expect(target?.getAttribute('data-testid')).toBe('record-children')
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
    }
  })

  it('keeps a `/` key distinct from nesting in expansion keys', () => {
    renderInspector(
      [
        { name: 'x/y', type: 'STRUCT(v INTEGER)' },
        { name: 'x', type: 'STRUCT(y STRUCT(v INTEGER))' },
      ],
      [{ v: 1 }, { y: { v: 2 } }],
    )

    // The pure path collector must not merge the two branches either.
    const paths = collectBranchPaths(
      buildRecordTree({ columns: ['x/y', 'x'], cells: [{ v: 1 }, { y: { v: 2 } }] }),
    )
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths).toContain(encodePathSegment('x/y'))
    expect(paths).toContain('x/y')

    const slashToggle = toggleForKey('x/y')
    const xToggle = toggleForKey('x')
    fireEvent.click(slashToggle)
    // A shared (unencoded) key would have expanded `x` too, revealing nested `y`.
    expect(slashToggle.getAttribute('aria-expanded')).toBe('true')
    expect(xToggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(xToggle)
    const yToggle = toggleForKey('y')
    expect(yToggle.getAttribute('aria-expanded')).toBe('false')
    expect(slashToggle.getAttribute('aria-controls')).not.toBe(
      yToggle.getAttribute('aria-controls'),
    )
  })
})
