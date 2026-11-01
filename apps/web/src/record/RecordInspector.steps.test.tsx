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
 *    exactly when no adjacent READY row exists in that direction (dataset
 *    bounds, or only loading/error neighbours);
 * 2. a step asks the composition root for the adjacent ready row (skipping a
 *    non-ready one) and the dock re-points WITHOUT closing — the same
 *    `<section>` node keeps rendering, the title number advances, and the
 *    content is re-read through the existing request machinery;
 * 3. focus is not stranded (the control the user pressed keeps focus across
 *    the re-point);
 * 4. the pending/stale label is 1-based too.
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
}

const SCHEMA = [
  { name: 'id', type: 'BIGINT' },
  { name: 'label', type: 'VARCHAR' },
] as const

function controllableModel(
  totalRows: number,
  statuses: Record<number, RowStatus>,
): ControllableModel {
  let version = 0
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
      const status = slots.get(index) ?? 'ready'
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
  }
}

/** App wiring in miniature: a step advances the request with a fresh seq. */
function Harness({
  model,
  startRow,
  onStep,
  overlayRevision = 0,
}: {
  readonly model: GridViewportModel
  readonly startRow: number
  readonly onStep: (rowIndex: number) => void
  readonly overlayRevision?: number
}) {
  const [live, setLive] = useState<RecordRequest | null>({ rowIndex: startRow, seq: 1 })
  return (
    <RecordInspector
      model={model}
      request={live}
      overlayRevision={overlayRevision}
      onClosed={() => {
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

  it('is disabled when the only neighbours are not ready (loading/error)', () => {
    const { model } = controllableModel(3, { 1: 'loading', 2: 'error' })
    render(<Harness model={model} startRow={0} onStep={() => {}} />)

    // No adjacent READY row forward, and none backward: both controls are
    // honestly disabled rather than stepping into a placeholder.
    expect(screen.getByTestId('record-next')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('record-prev')).toHaveProperty('disabled', true)
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

  it('skips rows that are not ready: 3 → 5 when row 4 is still loading', () => {
    const { model } = controllableModel(5, { 3: 'loading' })
    const onStep = vi.fn()
    render(<Harness model={model} startRow={2} onStep={onStep} />)

    expect(titleNumber()).toBe('3')
    act(() => {
      fireEvent.click(screen.getByTestId('record-next'))
    })

    // Index 3 is a loading placeholder: the step lands on index 4 (row 5).
    expect(onStep).toHaveBeenCalledWith(4)
    expect(titleNumber()).toBe('5')
    expect(leafValue('id')).toBe('4')
  })

  it('Prev steps backwards over a non-ready row and keeps focus on the control', () => {
    const { model } = controllableModel(5, { 2: 'error' })
    const onStep = vi.fn()
    render(<Harness model={model} startRow={3} onStep={onStep} />)

    const prev = screen.getByTestId('record-prev')
    prev.focus()
    expect(document.activeElement).toBe(prev)

    act(() => {
      fireEvent.click(prev)
    })

    // Index 2 failed: the previous READY row is index 1 (row 2).
    expect(onStep).toHaveBeenCalledWith(1)
    expect(titleNumber()).toBe('2')
    // Focus is not stranded on <body> after the re-point.
    expect(document.activeElement).toBe(prev)
    expect(document.activeElement).not.toBe(document.body)
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
