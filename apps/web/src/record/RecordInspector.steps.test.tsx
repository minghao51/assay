// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GridViewportModel } from '@assay/grid'
import { RecordInspector } from './RecordInspector'
import type { RecordRequest } from './RecordInspector'

/**
 * ug-11 (UG-12) — row identity made visible, part (b): the dock's ◀ Prev /
 * ▶ Next stepping.
 *
 * Pins:
 * 1. the controls exist with the agreed accessible names and are **disabled**
 *    exactly at the dataset bounds or when the IMMEDIATE neighbour settled
 *    `error` (a `loading` neighbour stays enabled);
 * 2. a step asks the composition root for the immediate neighbour (N-1 / N+1,
 *    no skipping) and the dock re-points WITHOUT closing — the same
 *    `<section>` node keeps rendering, the title number advances, and the
 *    content is re-read through the existing request machinery;
 * 3. a `loading` neighbour is not dropped: the existing uxc-2 pending gesture
 *    opens it when the slot lands — and when that pending slot instead settles
 *    `error` the step is dropped through `onClosed` exactly once WITHOUT
 *    closing the dock (same `<section>`, still on row N, no stranded focus);
 * 4. focus is not stranded (the control the user pressed keeps focus across
 *    the re-point);
 * 5. stepping is O(1) against a large sparse cache: render + one interaction
 *    call `model.getRow` at most a small constant number of times, never a
 *    dataset-walking scan;
 * 6. the pending/stale label is 1-based too.
 *
 * The harness below is the App wiring in miniature: `onStep` receives the row
 * index and the request state advances with a fresh `seq` — exactly what
 * `App.stepRecord` → `navigateToRow` does.
 */

type RowStatus = 'ready' | 'loading' | 'error'

interface ControllableModel {
  readonly model: GridViewportModel
  setStatus(rowIndex: number, status: RowStatus): void
  notify(): void
  /** Number of `model.getRow` calls observed (the O(1) stepping pin). */
  getRowCalls(): number
  resetGetRowCalls(): void
}

const SCHEMA = [
  { name: 'id', type: 'BIGINT' },
  { name: 'label', type: 'VARCHAR' },
] as const

function controllableModel(
  totalRows: number,
  statuses: Record<number, RowStatus>,
  defaultStatus: RowStatus = 'ready',
): ControllableModel {
  let version = 0
  let getRowCalls = 0
  const slots = new Map<number, RowStatus>(Object.entries(statuses).map(([k, v]) => [Number(k), v]))
  const listeners = new Set<() => void>()
  const model = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getVersion: () => version,
    schema: SCHEMA,
    totalRows,
    sort: null,
    filters: [],
    getRow: (index: number) => {
      getRowCalls += 1
      const status = slots.get(index) ?? defaultStatus
      if (status === 'ready') {
        return { status, row: [index, `row-${String(index)}`], key: `base:anchor#${String(index)}` }
      }
      if (status === 'error') return { status, message: 'span failed' }
      return { status }
    },
  } as unknown as GridViewportModel
  return {
    model,
    setStatus: (rowIndex, status) => {
      slots.set(rowIndex, status)
    },
    notify: () => {
      version += 1
      for (const listener of listeners) listener()
    },
    getRowCalls: () => getRowCalls,
    resetGetRowCalls: () => {
      getRowCalls = 0
    },
  }
}

/** App wiring in miniature: a step advances the request with a fresh seq. */
function Harness({
  model,
  startRow,
  onStep,
  onClosed,
  overlayRevision = 0,
}: {
  readonly model: GridViewportModel
  readonly startRow: number
  readonly onStep: (rowIndex: number) => void
  /** Observed drops, in addition to the App-style request clear below. */
  readonly onClosed?: () => void
  readonly overlayRevision?: number
}) {
  const [live, setLive] = useState<RecordRequest | null>({ rowIndex: startRow, seq: 1 })
  return (
    <RecordInspector
      model={model}
      request={live}
      overlayRevision={overlayRevision}
      onClosed={() => {
        onClosed?.()
        setLive(null)
      }}
      onStep={(rowIndex) => {
        onStep(rowIndex)
        setLive((previous) => ({ rowIndex, seq: (previous?.seq ?? 0) + 1 }))
      }}
    />
  )
}

/** The visible title number of the open record. */
function titleNumber(): string | null {
  return screen.getByTestId('record-title-row').textContent
}

/** The value of one leaf in the open record's tree. */
function leafValue(key: string): string | null {
  const leaf = screen
    .getAllByTestId('record-node')
    .find((node) => node.getAttribute('data-node-key') === key)
  if (leaf === undefined) throw new Error(`no record node named ${key}`)
  return leaf.querySelector<HTMLElement>('[data-testid="record-node-value"]')?.textContent ?? null
}

afterEach(cleanup)

describe('RecordInspector Prev/Next stepping (ug-11)', () => {
  it('is disabled at the dataset bounds: no row before the first row', () => {
    const { model } = controllableModel(3, {})
    render(<Harness model={model} startRow={0} onStep={() => {}} />)

    expect(screen.getByTestId('record-prev')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('record-next')).toHaveProperty('disabled', false)
    // Agreed accessible names (the visible ◀/▶ glyphs are decoration).
    expect(screen.getByRole('button', { name: 'Previous row' })).toBe(
      screen.getByTestId('record-prev'),
    )
    expect(screen.getByRole('button', { name: 'Next row' })).toBe(screen.getByTestId('record-next'))
  })

  it('is disabled on the last row', () => {
    const { model } = controllableModel(3, {})
    render(<Harness model={model} startRow={2} onStep={() => {}} />)

    expect(screen.getByTestId('record-next')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('record-prev')).toHaveProperty('disabled', false)
  })

  it('disables an ERROR neighbour but keeps a LOADING neighbour enabled', () => {
    // INTERIOR fixture on purpose: the `error` neighbour (index 1) is not at a
    // dataset bound, so "disabled because the neighbour failed" cannot be
    // satisfied by "disabled because of the bound". A regression that SKIPS
    // PAST an error slot (returning index 0 here) flips Prev back to enabled
    // and fails this pin; the bound-only fixture this replaced could not tell
    // the two apart.
    const controllable = controllableModel(4, { 1: 'error', 3: 'loading' })
    const onStep = vi.fn()
    render(<Harness model={controllable.model} startRow={2} onStep={onStep} />)

    // Backward targets index 1, a failed span: no record can ever appear there.
    expect(screen.getByTestId('record-prev')).toHaveProperty('disabled', true)
    // Forward targets index 3, which is still loading: the pending gesture
    // opens it when it lands, so the control must not be dead. Index 3 is the
    // last row, so `enabled` also proves the bound check is what it claims to
    // be (a bound artefact would be `disabled`).
    expect(screen.getByTestId('record-next')).toHaveProperty('disabled', false)

    // The enabled side still steps to the IMMEDIATE neighbour, never past it.
    act(() => {
      fireEvent.click(screen.getByTestId('record-next'))
    })
    expect(onStep).toHaveBeenCalledTimes(1)
    expect(onStep).toHaveBeenCalledWith(3)
  })

  it('Next from row N opens N+1 in the SAME dock (title and content re-read)', () => {
    const { model } = controllableModel(5, {})
    const onStep = vi.fn()
    render(<Harness model={model} startRow={0} onStep={onStep} />)

    const inspector = screen.getByTestId('record-inspector')
    expect(titleNumber()).toBe('1')
    expect(leafValue('id')).toBe('0')

    act(() => {
      fireEvent.click(screen.getByTestId('record-next'))
    })

    expect(onStep).toHaveBeenCalledWith(1)
    // The dock was re-pointed, never closed: same section node, new content.
    expect(screen.getByTestId('record-inspector')).toBe(inspector)
    expect(inspector.getAttribute('aria-label')).toBe('Record inspector — row 2')
    expect(titleNumber()).toBe('2')
    expect(leafValue('id')).toBe('1')
  })

  it('Next on a loading neighbour keeps the pending gesture and opens it when the slot lands', () => {
    const controllable = controllableModel(3, { 1: 'loading' })
    const onStep = vi.fn()
    render(<Harness model={controllable.model} startRow={0} onStep={onStep} />)

    expect(titleNumber()).toBe('1')
    const next = screen.getByTestId('record-next')
    expect(next).toHaveProperty('disabled', false)

    act(() => {
      fireEvent.click(next)
    })

    // The immediate neighbour is requested (N+1, never a skip over it), and
    // the dock keeps showing the current record while that slot loads.
    expect(onStep).toHaveBeenCalledWith(1)
    expect(titleNumber()).toBe('1')
    expect(screen.getByTestId('record-inspector').getAttribute('data-row-index')).toBe('0')

    // uxc-2: the pending gesture resolves when the slot lands — no second
    // read path, no dropped step.
    act(() => {
      controllable.setStatus(1, 'ready')
      controllable.notify()
    })

    expect(titleNumber()).toBe('2')
    expect(screen.getByTestId('record-inspector').getAttribute('data-row-index')).toBe('1')
    expect(leafValue('id')).toBe('1')
  })

  it('drops a pending step that lands ERROR without closing the dock', () => {
    // The uxc-2 drop branch is routinely reached while the dock is OPEN: a
    // `loading` neighbour is a first-class step target, so its slot can settle
    // `error` under the pending gesture. Policy: the step is dropped through
    // `onClosed` (App clears the request) but the dock stays open on row N —
    // the same `<section>` node, the same record, no stranded focus. Routing
    // the drop through `close()` instead would unmount the section and lose
    // focus to <body>, which this leg catches.
    const controllable = controllableModel(3, { 1: 'loading' })
    const onStep = vi.fn()
    const onClosed = vi.fn()
    render(<Harness model={controllable.model} startRow={0} onStep={onStep} onClosed={onClosed} />)

    const inspector = screen.getByTestId('record-inspector')
    expect(titleNumber()).toBe('1')
    const next = screen.getByTestId('record-next')
    next.focus()
    expect(document.activeElement).toBe(next)

    act(() => {
      fireEvent.click(next)
    })
    // Pending on the loading neighbour: still on row 1, nothing dropped yet.
    expect(onStep).toHaveBeenCalledWith(1)
    expect(titleNumber()).toBe('1')
    expect(onClosed).not.toHaveBeenCalled()

    // The neighbour fails instead of landing: the step can never be satisfied.
    act(() => {
      controllable.setStatus(1, 'error')
      controllable.notify()
    })

    // Dropped exactly once, through the close callback…
    expect(onClosed).toHaveBeenCalledTimes(1)
    // …but the dock did NOT close: same section node, still showing row 1.
    expect(screen.getByTestId('record-inspector')).toBe(inspector)
    expect(inspector.getAttribute('data-row-index')).toBe('0')
    expect(inspector.getAttribute('aria-label')).toBe('Record inspector — row 1')
    expect(titleNumber()).toBe('1')
    expect(leafValue('id')).toBe('0')
    // No stranded focus: the dock is still mounted and the control the user
    // pressed still holds focus (a close() route would have dropped it).
    expect(document.contains(next)).toBe(true)
    expect(document.activeElement).toBe(next)

    // A later notification is not a second drop.
    act(() => {
      controllable.notify()
    })
    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('record-inspector')).toBe(inspector)
  })

  it('Prev steps to N-1 and keeps focus on the control', () => {
    const { model } = controllableModel(5, {})
    const onStep = vi.fn()
    render(<Harness model={model} startRow={3} onStep={onStep} />)

    const prev = screen.getByTestId('record-prev')
    prev.focus()
    expect(document.activeElement).toBe(prev)

    act(() => {
      fireEvent.click(prev)
    })

    // Immediate neighbour, no skipping: index 2 (row 3).
    expect(onStep).toHaveBeenCalledWith(2)
    expect(titleNumber()).toBe('3')
    expect(leafValue('id')).toBe('2')
    // Focus is not stranded on <body> after the re-point.
    expect(document.activeElement).toBe(prev)
    expect(document.activeElement).not.toBe(document.body)
  })

  it('never walks the dataset: a large sparse cache stays O(1) per render/click', () => {
    // 100,000 rows, every far slot `loading` (exactly what an uncached
    // viewport model reports). The old "scan to the next ready row" helper
    // would call getRow ~99,999 times per direction on this render.
    const controllable = controllableModel(100_000, { 0: 'ready' }, 'loading')
    const onStep = vi.fn()
    render(<Harness model={controllable.model} startRow={0} onStep={onStep} />)

    expect(titleNumber()).toBe('1')
    // Render: the open read + context + the two adjacent-slot checks — the
    // measured actual is 4, so this bound has no room for a doubling. This is
    // the load-bearing assertion: a dataset-walking helper blows it by ~four
    // orders of magnitude before any disabled-state check runs.
    expect(controllable.getRowCalls()).toBeLessThanOrEqual(6)
    // Bounds still disable Prev; the loading neighbour stays steppable.
    expect(screen.getByTestId('record-prev')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('record-next')).toHaveProperty('disabled', false)

    controllable.resetGetRowCalls()
    act(() => {
      fireEvent.click(screen.getByTestId('record-next'))
    })

    expect(onStep).toHaveBeenCalledWith(1)
    // One interaction: same constant bound (measured actual 4), independent of
    // totalRows, and tight enough that a doubling fails.
    expect(controllable.getRowCalls()).toBeLessThanOrEqual(6)
    // Still pending on the loading slot — nothing was scanned past it.
    expect(titleNumber()).toBe('1')
  })

  it('labels the stale/pending state with the same 1-based number', () => {
    const controllable = controllableModel(3, {})
    const request = { rowIndex: 1, seq: 1 }
    const { rerender } = render(
      <RecordInspector
        model={controllable.model}
        request={request}
        onClosed={() => {}}
        onStep={() => {}}
        overlayRevision={0}
      />,
    )
    expect(titleNumber()).toBe('2')

    // An overlay edit while the row refetches: the panel shows the explicit
    // pending state instead of stale values.
    controllable.setStatus(1, 'loading')
    act(() => {
      controllable.notify()
    })
    rerender(
      <RecordInspector
        model={controllable.model}
        request={request}
        onClosed={() => {}}
        onStep={() => {}}
        overlayRevision={1}
      />,
    )

    const stale = screen.getByTestId('record-inspector')
    expect(stale.getAttribute('data-stale')).toBe('true')
    expect(stale.getAttribute('aria-label')).toBe('Reloading record — row 2')
  })
})
