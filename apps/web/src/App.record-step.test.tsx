// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle, EngineValidationPlan } from '@assay/engine-duckdb'
import { App } from './App'
import { fileVersionAnchor } from './edit/overlay-base'
import type { ArrowTableLike } from './grid/provider'

/**
 * ug-11 (UG-12) — the record dock's ◀ Prev / ▶ Next controls through the REAL
 * App composition root (only the picker/engine boundaries are faked).
 *
 * Pins the wiring, not just the component's own logic:
 * 1. a step opens the adjacent row in the SAME dock (title advances, the
 *    dock is never closed) and moves the grid through the EXISTING
 *    scroll-request path (`scrollToIndex`);
 * 2. the 1-based dock title agrees with the grid's row-number gutter;
 * 3. stepping announces NOTHING (ug-12's jump announcements are unchanged and
 *    are for panel "Show row" jumps only);
 * 4. Close still restores focus to the row that opened the dock — the pressed
 *    step button is never remembered as the opener.
 */

const FILE_TEXT = 'id\n1\n'
const LAST_MODIFIED = 1_700_000_000_000
const BASE_ANCHOR = fileVersionAnchor({ size: FILE_TEXT.length, lastModified: LAST_MODIFIED })

function baseRowKey(ordinal: number): string {
  return `base:${BASE_ANCHOR}#${String(ordinal)}`
}

const FAKE_SCHEMA: readonly { name: string; type: string }[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'country', type: 'VARCHAR' },
]

function column(values: readonly (number | string)[]) {
  return { get: (rowIndex: number) => values[rowIndex] ?? null }
}

function fakeBatch(): ArrowTableLike {
  return {
    numRows: 3,
    numCols: FAKE_SCHEMA.length,
    getChildAt: (index: number) =>
      index === 0 ? column([1, 2, 3]) : index === 1 ? column(['SG', 'SG', 'US']) : null,
  }
}

/** Row-id column + the two data columns (the overlay refresh shape). */
function fakeOverlayBatch(): ArrowTableLike {
  return {
    numRows: 3,
    numCols: FAKE_SCHEMA.length + 1,
    getChildAt: (index: number) => {
      if (index === 0) return column([baseRowKey(0), baseRowKey(1), baseRowKey(2)])
      if (index === 1) return column([1, 2, 3])
      if (index === 2) return column(['SG', 'SG', 'US'])
      return null
    },
  }
}

interface VirtualItem {
  index: number
  key: string
  start: number
  size: number
}

const h = vi.hoisted(() => ({
  rows: [] as VirtualItem[],
  scrollToIndex: vi.fn(),
  openCalls: 0,
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => h.rows,
    getTotalSize: () => h.rows.length * 28,
    scrollToIndex: h.scrollToIndex,
  }),
}))

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } }> => ({
    source: {
      getFile: async () => new File([FILE_TEXT], 'ug11.jsonl', { lastModified: LAST_MODIFIED }),
    },
  }),
}))

vi.mock('./lib/engine', () => {
  const handle = (): EngineTableHandle => {
    h.openCalls += 1
    return { kind: 'table', id: `t${String(h.openCalls)}` }
  }
  return {
    engineClient: {
      open: async () => handle(),
      schema: async () => FAKE_SCHEMA,
      rowCount: async () => 3,
      fetchRange: async () => ({ batch: fakeBatch(), hasMore: false }),
      overlaySchema: async () => FAKE_SCHEMA,
      overlayRowCount: async () => 3,
      fetchOverlayRange: async () => ({ batch: fakeOverlayBatch(), hasMore: false }),
      validate: async (_handle: EngineTableHandle, plan: EngineValidationPlan) => ({
        valid: true,
        rowCount: 3,
        rules: plan.rules.map((rule) => ({
          ruleId: rule.ruleId,
          outcome: rule.outcome,
          failCount: 0,
          failPercent: 0,
          sampleFailures: [],
        })),
      }),
    },
  }
})

beforeEach(() => {
  h.rows = [0, 1, 2].map((index) => ({
    index,
    key: `row-${String(index)}`,
    start: index * 28,
    size: 28,
  }))
  h.scrollToIndex.mockReset()
  h.openCalls = 0
})

afterEach(cleanup)

/** Open the faked dataset through the real open flow. */
async function open(): Promise<void> {
  render(<App />)
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('schema-section')
  await waitFor(() => {
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
  })
}

function gridRow(rowIndex: number): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="grid-row"][data-row-index="${String(rowIndex)}"]`,
  )
  if (element === null) throw new Error(`row ${String(rowIndex)} not rendered`)
  return element
}

/** One leaf's value in the open record tree. */
function leafValue(key: string): string | null {
  const leaf = screen
    .getAllByTestId('record-node')
    .find((node) => node.getAttribute('data-node-key') === key)
  if (leaf === undefined) throw new Error(`no record node named ${key}`)
  return leaf.querySelector<HTMLElement>('[data-testid="record-node-value"]')?.textContent ?? null
}

describe('ug-11 — record dock Prev/Next through App', () => {
  it('opens the row that was clicked, disables Prev, and steps Next into the same dock', async () => {
    await open()

    // Mimic a real row activation: the row is the focused element when the
    // dock opens (the grid's rows are the roving tab stop).
    gridRow(0).focus()
    await act(async () => {
      gridRow(0).click()
    })
    await screen.findByTestId('record-inspector')

    // 1-based title, and it agrees with the grid's 1-based gutter.
    expect(screen.getByTestId('record-title-row').textContent).toBe('1')
    expect(
      gridRow(0).querySelector('[data-testid="grid-row-number"]')?.getAttribute('data-row-number'),
    ).toBe('1')
    expect(screen.getByTestId('record-prev')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('record-next')).toHaveProperty('disabled', false)

    const inspector = screen.getByTestId('record-inspector')
    h.scrollToIndex.mockClear()
    // Focus the control first: a real pointer press focuses it, and this is
    // exactly the element that must NOT become the dock's remembered opener.
    const next = screen.getByTestId('record-next')
    next.focus()

    await act(async () => {
      fireEvent.click(next)
    })

    // The dock re-points (never closes) on row 2, with row 2's content.
    await waitFor(() => {
      expect(screen.getByTestId('record-title-row').textContent).toBe('2')
    })
    expect(screen.getByTestId('record-inspector')).toBe(inspector)
    expect(inspector.getAttribute('aria-label')).toBe('Record inspector — row 2')
    expect(leafValue('id')).toBe('2')
    // …through the existing scroll-request path, not a second one.
    expect(h.scrollToIndex).toHaveBeenCalledWith(1, { align: 'start' })
    // ug-12 is untouched: no announcement is invented for a step.
    expect(screen.getByTestId('edit-live-region').textContent).toBe('')

    // Stepping again reaches the last row, where Next is honestly disabled.
    await act(async () => {
      fireEvent.click(screen.getByTestId('record-next'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('record-title-row').textContent).toBe('3')
    })
    expect(leafValue('id')).toBe('3')
    expect(screen.getByTestId('record-next')).toHaveProperty('disabled', true)

    // Close still restores focus to the row that OPENED the dock (index 0),
    // never to the pressed step button and never to <body>.
    await act(async () => {
      fireEvent.click(screen.getByTestId('record-close'))
    })
    await waitFor(() => {
      expect(screen.queryByTestId('record-inspector')).toBeNull()
    })
    expect(document.activeElement).toBe(gridRow(0))
  })
})
