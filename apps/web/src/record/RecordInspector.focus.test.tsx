// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GridViewportModel } from '@assay/grid'
import { RecordInspector } from './RecordInspector'
import type { RecordRequest } from './RecordInspector'

/**
 * ux-a3 — the OPTIONAL record-open focus contract.
 *
 * Why: previously the inspector never moved focus, so after Enter/click on a
 * grid row a keyboard user had to walk the whole page again (the recorded
 * 18-Tab gap) to reach the panel they had just asked for. `RecordRequest`
 * gains `focusOnOpen`, set ONLY by explicit grid row activation in App.
 *
 * Pins:
 * 1. a flagged fresh open lands focus on the non-modal inspector container
 *    once the requested record is honestly on display;
 * 2. a request WITHOUT the flag keeps the historical no-focus-steal policy
 *    (validation/diff "Show row" jumps and the dock's Prev/Next step);
 * 3. Escape on the focused container closes and returns focus to the opener;
 * 4. a step (already-open panel), an overlay value reload, a model
 *    notification and an expansion never re-focus the panel;
 * 5. a gesture made on a still-loading row focuses when it lands — unless the
 *    user deliberately moved focus elsewhere in the meantime (then the record
 *    still opens and the focus request retires);
 * 6. an error/out-of-range/epoch-shifted pending gesture neither opens nor
 *    steals focus, and leaves no focus request behind.
 */

/** A fake grid row (the real opener) kept outside the inspector's subtree. */
function addOpener(label = 'grid row'): HTMLButtonElement {
  const opener = document.createElement('button')
  opener.textContent = label
  opener.dataset['testid'] = 'fake-grid-row'
  document.body.append(opener)
  return opener
}

function fakeModel(
  columns: readonly { name: string; type: string }[],
  cells: readonly unknown[],
  totalRows = 1,
): GridViewportModel {
  return {
    subscribe: () => () => {},
    getVersion: () => 0,
    schema: columns,
    totalRows,
    sort: null,
    filters: [],
    getRow: () => ({ status: 'ready', row: cells, key: 'base:anchor#0' }),
  } as unknown as GridViewportModel
}

interface ControllableModel {
  readonly model: GridViewportModel
  setSlot(slot: unknown): void
  setStructure(next: { sort?: unknown; totalRows?: number }): void
  notify(): void
}

/** Row slot + structural context that can be advanced between renders. */
function controllableModel(
  columns: readonly { name: string; type: string }[],
  initialSlot: unknown,
): ControllableModel {
  let version = 0
  let slot = initialSlot
  let sort: unknown = null
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
      return columns
    },
    get totalRows() {
      return totalRows
    },
    get sort() {
      return sort
    },
    get filters() {
      return []
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
      if (next.totalRows !== undefined) totalRows = next.totalRows
    },
    notify: () => {
      version += 1
      for (const listener of listeners) listener()
    },
  }
}

interface InspectorHarnessProps {
  readonly model: GridViewportModel
  readonly request: RecordRequest | null
  readonly overlayRevision?: number
  readonly onClosed?: () => void
}

function Inspector({
  model,
  request,
  overlayRevision = 0,
  onClosed = () => undefined,
}: InspectorHarnessProps) {
  return (
    <RecordInspector
      model={model}
      request={request}
      onClosed={onClosed}
      onStep={() => undefined}
      overlayRevision={overlayRevision}
    />
  )
}

function inspector(): HTMLElement {
  return screen.getByTestId('record-inspector')
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('RecordInspector — explicit open focus contract (ux-a3)', () => {
  it('lands focus on the inspector container for a flagged fresh open', () => {
    const opener = addOpener()
    opener.focus()
    render(
      <Inspector
        model={fakeModel([{ name: 'id', type: 'BIGINT' }], [1])}
        request={{ rowIndex: 0, seq: 1, focusOnOpen: true }}
      />,
    )

    expect(inspector().getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(inspector())
    expect(inspector().getAttribute('aria-label')).toBe('Record inspector — row 1')
  })

  it('keeps the no-focus-steal policy for a request without the flag', () => {
    const opener = addOpener()
    opener.focus()
    render(
      <Inspector
        model={fakeModel([{ name: 'id', type: 'BIGINT' }], [1])}
        request={{ rowIndex: 0, seq: 1 }}
      />,
    )

    expect(inspector()).toBeTruthy()
    expect(document.activeElement).toBe(opener)
    expect(document.activeElement).not.toBe(inspector())
  })

  it('Escape on the focused container closes and returns focus to the opener', () => {
    const opener = addOpener()
    opener.focus()
    const onClosed = vi.fn()
    const { rerender } = render(
      <Inspector
        model={fakeModel([{ name: 'id', type: 'BIGINT' }], [1])}
        request={{ rowIndex: 0, seq: 1, focusOnOpen: true }}
        onClosed={onClosed}
      />,
    )
    expect(document.activeElement).toBe(inspector())

    fireEvent.keyDown(inspector(), { key: 'Escape' })
    expect(onClosed).toHaveBeenCalledTimes(1)
    // The App clears the request on close; mirror that here.
    rerender(
      <Inspector
        model={fakeModel([{ name: 'id', type: 'BIGINT' }], [1])}
        request={null}
        onClosed={onClosed}
      />,
    )
    expect(screen.queryByTestId('record-inspector')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('does not re-focus on a step, even when the step request carries the flag', () => {
    const opener = addOpener()
    opener.focus()
    const model = fakeModel([{ name: 'id', type: 'BIGINT' }], [1], 3)
    const first: RecordRequest = { rowIndex: 0, seq: 1, focusOnOpen: true }
    const { rerender } = render(<Inspector model={model} request={first} />)
    expect(document.activeElement).toBe(inspector())

    // The user moves into the dock's own controls (as the Prev/Next buttons do
    // when pressed) and steps the dock to another row.
    const next = screen.getByTestId('record-next')
    next.focus()
    act(() => {
      rerender(<Inspector model={model} request={{ rowIndex: 1, seq: 2 }} />)
    })
    expect(inspector().getAttribute('data-row-index')).toBe('1')
    expect(document.activeElement).toBe(next)

    // Defensive: even a flagged step request (never produced by App) must not
    // pull focus out of the dock's own controls — focus is for a FRESH open.
    act(() => {
      rerender(<Inspector model={model} request={{ rowIndex: 0, seq: 3, focusOnOpen: true }} />)
    })
    expect(inspector().getAttribute('data-row-index')).toBe('0')
    expect(document.activeElement).toBe(next)
  })

  it('does not re-focus on an overlay reload, a model notification or an expansion', () => {
    const opener = addOpener()
    opener.focus()
    const model = fakeModel([{ name: 'id', type: 'BIGINT' }], [1])
    const request: RecordRequest = { rowIndex: 0, seq: 1, focusOnOpen: true }
    const { rerender } = render(<Inspector model={model} request={request} />)
    expect(document.activeElement).toBe(inspector())

    // A value edit reloads the open snapshot: focus stays where the user put it.
    opener.focus()
    act(() => {
      rerender(<Inspector model={model} request={request} overlayRevision={1} />)
    })
    expect(document.activeElement).toBe(opener)

    // An unrelated model notification (another span landing) must not re-focus.
    act(() => {
      rerender(<Inspector model={model} request={request} overlayRevision={1} />)
    })
    expect(document.activeElement).toBe(opener)

    // Expanding the tree is a user action inside the panel — never a focus
    // opportunity for the open request.
    act(() => {
      fireEvent.click(screen.getByTestId('record-expand-all'))
    })
    expect(document.activeElement).toBe(opener)
  })
})

describe('RecordInspector — pending explicit open and focus retirement (ux-a3)', () => {
  it('focuses when the requested loading row lands, if the user has not moved on', () => {
    const opener = addOpener()
    opener.focus()
    const pending = controllableModel([{ name: 'a', type: 'BIGINT' }], { status: 'loading' })
    render(<Inspector model={pending.model} request={{ rowIndex: 0, seq: 1, focusOnOpen: true }} />)
    expect(screen.queryByTestId('record-inspector')).toBeNull()
    expect(document.activeElement).toBe(opener)

    act(() => {
      pending.setSlot({ status: 'ready', row: [42], key: 'base:anchor#0' })
      pending.notify()
    })
    expect(inspector()).toBeTruthy()
    expect(document.activeElement).toBe(inspector())
  })

  it('opens without stealing focus late when the user deliberately moved on', () => {
    const opener = addOpener()
    opener.focus()
    const elsewhere = addOpener('elsewhere')
    const pending = controllableModel([{ name: 'a', type: 'BIGINT' }], { status: 'loading' })
    render(<Inspector model={pending.model} request={{ rowIndex: 0, seq: 1, focusOnOpen: true }} />)

    // While the row is still loading the user tabs off to another control.
    elsewhere.focus()
    expect(document.activeElement).toBe(elsewhere)

    act(() => {
      pending.setSlot({ status: 'ready', row: [42], key: 'base:anchor#0' })
      pending.notify()
    })
    // The record still opens honestly…
    expect(inspector()).toBeTruthy()
    expect(screen.getByTestId('record-node-value').textContent).toBe('42')
    // …but the focus request retires: no late focus steal.
    expect(document.activeElement).toBe(elsewhere)
  })

  it('drops a pending gesture that lands error, without stealing focus', () => {
    const opener = addOpener()
    opener.focus()
    const pending = controllableModel([{ name: 'a', type: 'BIGINT' }], { status: 'loading' })
    const onClosed = vi.fn()
    render(
      <Inspector
        model={pending.model}
        request={{ rowIndex: 0, seq: 1, focusOnOpen: true }}
        onClosed={onClosed}
      />,
    )

    act(() => {
      pending.setSlot({ status: 'error', message: 'row index 0 is outside the dataset' })
      pending.notify()
    })
    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('record-inspector')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('retires the focus request when the epoch shifts before the row lands', () => {
    const opener = addOpener()
    opener.focus()
    const pending = controllableModel([{ name: 'a', type: 'BIGINT' }], { status: 'loading' })
    render(<Inspector model={pending.model} request={{ rowIndex: 0, seq: 1, focusOnOpen: true }} />)

    // An accepted sort starts a fresh epoch: the same index now names a
    // different record, so the gesture is dropped — and no stale focus request
    // survives to fire on a later open.
    act(() => {
      pending.setStructure({ sort: { column: 'a', direction: 'asc' } })
      pending.setSlot({ status: 'ready', row: [42], key: 'base:anchor#0' })
      pending.notify()
    })
    expect(screen.queryByTestId('record-inspector')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
})
