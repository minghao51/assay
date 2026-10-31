// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle, EngineValidationPlan } from '@assay/engine-duckdb'
import { App, rowJumpAnnouncementText } from './App'
import { fileVersionAnchor } from './edit/overlay-base'
import type { ArrowTableLike } from './grid/provider'

/**
 * ug-12 (UG-26) — the "Show row" jump is announced and lands focus.
 *
 * Pins:
 * 1. `rowJumpAnnouncementText` is byte-exact for a supplied display key and
 *    `null` without one (nothing to announce).
 * 2. Through the REAL App composition root (faked picker/engine boundaries
 *    only): validation's sample "Show row" writes exactly
 *    `Showing base #2 in the grid and record inspector` into the existing
 *    single polite live region (`edit-live-region`), opens the record
 *    inspector on that row, and leaves DOM focus plus the roving tab stop
 *    (`tabindex="0"`) on the target grid row — not on the panel button.
 *
 * The display key is the domain grammar (`base #2` / `insert #3`), never a raw
 * row index, the export form or a cell value (ADR 0025).
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
// The row-id column is what makes a sample's logical key resolvable against
// the effective view the jump resolves through.
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
  openCalls: 0,
  fileText: 'id\n1\n',
  lastModified: 1_700_000_000_000,
  /** The row key the fake contract's single failing rule reports. */
  sampleRowKey: '',
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => h.rows,
    getTotalSize: () => h.rows.length * 28,
    scrollToIndex: vi.fn(),
  }),
}))

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } }> => ({
    source: {
      getFile: async () => new File([h.fileText], 'ug12.jsonl', { lastModified: h.lastModified }),
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
        valid: false,
        rowCount: 3,
        // Only the first planned rule fails, with one sample whose logical key
        // is a base row the grid renders — the jump's input.
        rules: plan.rules.map((rule, index) => ({
          ruleId: rule.ruleId,
          outcome: rule.outcome,
          failCount: index === 0 ? 1 : 0,
          failPercent: index === 0 ? 33 : 0,
          sampleFailures: index === 0 ? [{ rowKey: h.sampleRowKey, value: 'US' }] : [],
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
  h.openCalls = 0
  h.sampleRowKey = baseRowKey(2)
})

afterEach(() => {
  cleanup()
})

describe('ug-12 — jump announcement copy', () => {
  it('states the display key byte-exactly and announces nothing without one', () => {
    expect(rowJumpAnnouncementText('base #12')).toBe(
      'Showing base #12 in the grid and record inspector',
    )
    expect(rowJumpAnnouncementText('insert #3')).toBe(
      'Showing insert #3 in the grid and record inspector',
    )
    // A jump with no caller-supplied label is not announced.
    expect(rowJumpAnnouncementText(undefined)).toBeNull()
    expect(rowJumpAnnouncementText()).toBeNull()
  })
})

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

/** Load a contract through the Validation panel's real hidden-input seam. */
async function loadContract(): Promise<void> {
  const yaml = [
    'format: v1',
    'name: row-jump-pin',
    'version: 1',
    'columns:',
    '  - name: id',
    '    type: BIGINT',
    '    required: true',
    'dataset:',
    '  min-rows: 1',
    '',
  ].join('\n')
  const input = screen.getByTestId('validation-contract-input') as HTMLInputElement
  Object.defineProperty(input, 'files', {
    value: [new File([yaml], 'contract.yaml')],
    configurable: true,
  })
  await act(async () => {
    fireEvent.change(input)
  })
  await screen.findByTestId('validation-contract-info')
}

/** Run the panel's real Validate click and wait for the verdict. */
async function validate(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('validation-run'))
  })
  await screen.findByTestId('validation-verdict')
}

describe('ug-12 — validation "Show row" announces and focuses the target row (App)', () => {
  it('writes the exact sentence to the single live region, focuses the row, opens the inspector', async () => {
    await open()
    await loadContract()
    await validate()

    // The sample list is populated from the fake verdict; its key is the
    // domain display grammar.
    const sample = await screen.findByTestId('validation-sample')
    expect(sample.querySelector('[data-testid="validation-sample-key"]')?.textContent).toBe(
      'base #2',
    )

    const live = screen.getByTestId('edit-live-region')
    expect(live.getAttribute('aria-live')).toBe('polite')
    // Before the jump: the single region is empty (no prior announcement).
    expect(live.textContent).toBe('')

    const jump = screen.getByTestId('validation-sample-jump')
    jump.focus()
    expect(document.activeElement).toBe(jump)

    await act(async () => {
      fireEvent.click(jump)
    })

    // Exactly one polite region, byte-exact sentence, value-free.
    expect(document.querySelectorAll('[data-testid="edit-live-region"]')).toHaveLength(1)
    await waitFor(() => {
      expect(live.textContent).toBe('Showing base #2 in the grid and record inspector')
    })
    expect(live.textContent).not.toContain('US')

    // Roving focus lands on the target row (not the button, not <body>) and
    // that row owns the grid's single tab stop.
    const target = document.querySelector<HTMLElement>(
      '[data-testid="grid-row"][data-row-index="2"]',
    )
    if (target === null) throw new Error('the target grid row is not rendered')
    await waitFor(() => {
      expect(document.activeElement).toBe(target)
    })
    expect(target.getAttribute('tabindex')).toBe('0')
    expect(document.querySelectorAll('[data-testid="grid-row"][tabindex="0"]')).toHaveLength(1)

    // The record inspector opened on the same row.
    const inspector = await screen.findByTestId('record-inspector')
    expect(inspector.querySelector('[data-testid="record-title-row"]')?.textContent).toBe('2')
  })
})
