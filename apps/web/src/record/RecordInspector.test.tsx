// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

/**
 * uxc-2: a fake viewport model whose row slot and structural context can be
 * advanced between renders, mirroring the real model's notify-on-change
 * contract (`subscribe`/`getVersion`). Mutators only stage the change; the
 * caller wraps `notify()` in `act()` so React flushes the store update.
 */
interface ControllableModel {
  readonly model: GridViewportModel
  setSlot(slot: unknown): void
  setStructure(next: { sort?: unknown; filters?: unknown; totalRows?: number | null }): void
  notify(): void
}

function controllableModel(
  columns: readonly { name: string; type: string }[],
  initialSlot: unknown,
): ControllableModel {
  let version = 0
  let slot = initialSlot
  const schema: readonly { name: string; type: string }[] | null = columns
  let sort: unknown = null
  let filters: unknown = []
  let totalRows: number | null = 1
  const listeners = new Set<() => void>()
  const model = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getVersion: () => version,
    get schema(): readonly { name: string; type: string }[] | null {
      return schema
    },
    get totalRows(): number | null {
      return totalRows
    },
    get sort(): unknown {
      return sort
    },
    get filters(): unknown {
      return filters
    },
    getRow: () => slot,
  } as unknown as GridViewportModel
  return {
    model,
    setSlot: (next) => {
      slot = next
    },
    setStructure: (next) => {
      if (next.sort !== undefined) sort = next.sort
      if (next.filters !== undefined) filters = next.filters
      if (next.totalRows !== undefined) totalRows = next.totalRows
    },
    notify: () => {
      version += 1
      for (const listener of listeners) listener()
    },
  }
}

/**
 * Delegating build counter (f-3): end-state assertions cannot discriminate a
 * spurious freshness reload (the reload self-heals within the same act), so
 * the open-after-edit pin below counts `buildRecordTree` invocations through
 * this spy. Everything else keeps the real implementation.
 */
const buildCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('./record-tree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./record-tree')>()
  return {
    ...actual,
    buildRecordTree: (...args: Parameters<typeof actual.buildRecordTree>) => {
      buildCalls.count += 1
      return actual.buildRecordTree(...args)
    },
  }
})

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
        onStep={() => {}}
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
      onStep={() => {}}
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

describe('RecordInspector open-after-edit freshness (f-3)', () => {
  it('a new open gesture after an edit snapshots the current revision — no spurious reload', () => {
    buildCalls.count = 0
    const model = fakeModel([{ name: 'a', type: 'BIGINT' }], [1])
    // Stable request identities (the real app keeps the request object in
    // state; a fresh literal per render would re-fire the open effect).
    const firstGesture = { rowIndex: 0, seq: 1 }
    const { rerender } = render(
      <RecordInspector
        model={model}
        request={firstGesture}
        onClosed={() => {}}
        onStep={() => {}}
        overlayRevision={0}
      />,
    )
    expect(screen.getByTestId('record-inspector')).toBeTruthy()
    expect(buildCalls.count).toBe(1)

    // An edit lands while the record is open (revision 0 → 1, same gesture):
    // the reload effect legitimately rebuilds (its own freshness contract).
    buildCalls.count = 0
    rerender(
      <RecordInspector
        model={model}
        request={firstGesture}
        onClosed={() => {}}
        onStep={() => {}}
        overlayRevision={1}
      />,
    )
    expect(buildCalls.count).toBe(1)

    // THEN a new open gesture arrives at the SAME revision. The open effect
    // must snapshot the CURRENT revision (latest-value ref), so the freshness
    // check passes and the gesture builds exactly once. A ref frozen at the
    // mount-time revision snapshots 0 ≠ 1 and rebuilds through the reload
    // path — the regression this pins (count 2). The revision must change in
    // an EARLIER render than the gesture: bundling both into one render makes
    // the freshness check true regardless of the ref.
    buildCalls.count = 0
    rerender(
      <RecordInspector
        model={model}
        request={{ rowIndex: 0, seq: 2 }}
        onClosed={() => {}}
        onStep={() => {}}
        overlayRevision={1}
      />,
    )
    expect(buildCalls.count).toBe(1)
  })
})

/**
 * uxc-2 pins: a click/Enter gesture on a still-loading row (the grid emits it
 * for every rendered row) must not be silently dropped. The gesture resolves
 * when the slot lands `ready`; an `error`/out-of-range slot or a structural
 * epoch shift while pending drops it instead of opening a different record.
 */
describe('RecordInspector click-while-fetching (uxc-2)', () => {
  it('opens once a still-loading row lands ready', () => {
    const pending = controllableModel([{ name: 'a', type: 'BIGINT' }], { status: 'loading' })
    const onClosed = vi.fn()
    render(
      <RecordInspector
        model={pending.model}
        request={{ rowIndex: 0, seq: 1 }}
        onClosed={onClosed}
        onStep={() => {}}
        overlayRevision={0}
      />,
    )
    // The gesture is held pending, not dropped: no panel yet, no close.
    expect(screen.queryByTestId('record-inspector')).toBeNull()
    expect(onClosed).not.toHaveBeenCalled()

    act(() => {
      pending.setSlot({ status: 'ready', row: [42], key: 'base:anchor#0' })
      pending.notify()
    })
    expect(screen.getByTestId('record-inspector')).toBeTruthy()
    expect(screen.getByTestId('record-node-value').textContent).toBe('42')
    expect(onClosed).not.toHaveBeenCalled()
  })

  it('drops a pending gesture when the slot settles error (out-of-range or failed span)', () => {
    const pending = controllableModel([{ name: 'a', type: 'BIGINT' }], { status: 'loading' })
    const onClosed = vi.fn()
    render(
      <RecordInspector
        model={pending.model}
        request={{ rowIndex: 0, seq: 1 }}
        onClosed={onClosed}
        onStep={() => {}}
        overlayRevision={0}
      />,
    )
    expect(onClosed).not.toHaveBeenCalled()

    act(() => {
      pending.setSlot({ status: 'error', message: 'row index 0 is outside the dataset' })
      pending.notify()
    })
    // The gesture is cleared through the close callback: nothing opens and it
    // cannot hang in App state forever.
    expect(screen.queryByTestId('record-inspector')).toBeNull()
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('drops an out-of-range gesture immediately', () => {
    const pending = controllableModel([{ name: 'a', type: 'BIGINT' }], {
      status: 'error',
      message: 'row index 99 is outside the dataset',
    })
    const onClosed = vi.fn()
    render(
      <RecordInspector
        model={pending.model}
        request={{ rowIndex: 99, seq: 1 }}
        onClosed={onClosed}
        onStep={() => {}}
        overlayRevision={0}
      />,
    )
    expect(screen.queryByTestId('record-inspector')).toBeNull()
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('drops a pending gesture when the epoch structurally shifts before the row lands', () => {
    const pending = controllableModel([{ name: 'a', type: 'BIGINT' }], { status: 'loading' })
    const onClosed = vi.fn()
    render(
      <RecordInspector
        model={pending.model}
        request={{ rowIndex: 0, seq: 1 }}
        onClosed={onClosed}
        onStep={() => {}}
        overlayRevision={0}
      />,
    )
    // An accepted sort starts a fresh epoch while the gesture is pending: the
    // same positional index now names a different record, so opening it would
    // be dishonest — the epoch-shift close rule, applied before the open.
    act(() => {
      pending.setStructure({ sort: { column: 'a', direction: 'asc' } })
      pending.setSlot({ status: 'ready', row: [42], key: 'base:anchor#0' })
      pending.notify()
    })
    expect(screen.queryByTestId('record-inspector')).toBeNull()
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('does not re-open or churn the token on repeat notifications for one gesture', () => {
    buildCalls.count = 0
    const pending = controllableModel([{ name: 'a', type: 'BIGINT' }], {
      status: 'ready',
      row: [7],
      key: 'base:anchor#0',
    })
    const request = { rowIndex: 0, seq: 1 }
    render(
      <RecordInspector
        model={pending.model}
        request={request}
        onClosed={() => {}}
        onStep={() => {}}
        overlayRevision={0}
      />,
    )
    expect(buildCalls.count).toBe(1)

    // Unrelated model activity (e.g. another span landing) re-runs the open
    // effect; the already-handled gesture must not open a second time and
    // reset the user's tree.
    buildCalls.count = 0
    act(() => {
      pending.notify()
    })
    expect(buildCalls.count).toBe(0)
    expect(screen.getAllByTestId('record-inspector')).toHaveLength(1)
  })
})
