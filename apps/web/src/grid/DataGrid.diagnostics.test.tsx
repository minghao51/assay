// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GridViewportModel } from '@assay/grid'
import { DataGrid } from './DataGrid'

/**
 * ux-3 (UX-9) pin: the grid footer's request counters are diagnostics, so
 * they render inside a native `<details>` disclosure that is **collapsed by
 * default**. The counters stay observable without opening it — the shared e2e
 * reader (`tests/e2e/support/grid-stats.ts`) reads `textContent`, which is
 * independent of the disclosure state — and the live `grid-edit-error`/
 * `grid-command-error` text stays a sibling in the visible footer.
 *
 * The virtualizer is faked (no layout in happy-dom) so the grid reaches its
 * ready render deterministically.
 */

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => [],
    getTotalSize: () => 0,
    scrollToIndex: vi.fn(),
  }),
}))

function fakeModel(): GridViewportModel {
  return {
    subscribe: () => () => {},
    getVersion: () => 0,
    schema: [{ name: 'id', type: 'BIGINT' }],
    totalRows: 1,
    sort: null,
    filters: [],
    stats: {
      fetchCalls: 2,
      rowsRequested: 5,
      rowsReceived: 5,
      maxSpanRows: 5,
      cachedRows: 5,
      failedSpans: 0,
    },
    getRow: () => ({ status: 'loading' }),
    setSort: async () => {},
    setFilters: async () => {},
    observeViewport: () => {},
    retry: () => {},
  } as unknown as GridViewportModel
}

afterEach(cleanup)

/** The one grid diagnostics `<details>` in the rendered footer. */
function gridDetails(): HTMLDetailsElement {
  const details = document.querySelector<HTMLDetailsElement>('[data-testid="grid-diagnostics"]')
  if (details === null) throw new Error('grid diagnostics disclosure not rendered')
  return details
}

describe('DataGrid diagnostics disclosure (UX-9)', () => {
  it('renders the request counters in a collapsed-by-default details', () => {
    render(<DataGrid model={fakeModel()} onNestedAction={() => {}} />)

    const details = gridDetails()
    expect(details.tagName).toBe('DETAILS')
    expect(details.open).toBe(false)
    expect(details.hasAttribute('open')).toBe(false)
    expect(details.querySelector('summary')?.textContent).toBe('Diagnostics')

    // The counters are present (and readable) even while closed.
    expect(details.querySelector('[data-testid="grid-stats"]')?.textContent).toBe(
      'fetches=2 requested=5 received=5 maxSpan=5 cached=5',
    )
  })
})
