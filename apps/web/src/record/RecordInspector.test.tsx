// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { GridViewportModel } from '@assay/grid'
import { RECORD_TREE_DEFAULT_MAX_CHILDREN } from './record-tree'
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
