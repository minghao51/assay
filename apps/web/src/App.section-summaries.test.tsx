// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyHistory, insertRowId } from '@assay/domain'
import type { EditOp, HistoryEntry, TransformationHistory } from '@assay/domain'
import type {
  EngineComparisonHandle,
  EngineDatasetProfile,
  EngineTableHandle,
  EngineValidationPlan,
} from '@assay/engine-duckdb'
import {
  App,
  comparisonSectionSummary,
  historySectionSummary,
  validationSectionSummary,
} from './App'
import type { DiffRunState } from './diff/DiffPanel'
import { buildDiffPanelReport } from './diff/diff-model'
import type { ArrowTableLike } from './grid/provider'
import type { ValidationReport, ValidationReportRow } from './validation/report-model'
import type { ValidationRunState } from './validation/ValidationPanel'

/**
 * ug-17 / UG-27 pins: state summaries on the shell-owned collapsed section
 * toggles.
 *
 * 1. **Copy per source (unit).** `Validation · <N> failing` counts the current
 *    verdict's FAILING RULES (`report.rows.filter(row => row.failing)`), and is
 *    absent in every non-verdict state; `Compare · <N> changed` comes from the
 *    current row-diff result's `changed.count`, absent in every non-result
 *    state; `History · <N> pending` is `activeOps(history).length` (the R-16
 *    count), absent at cursor 0 and after undoing back to 0. Singular and
 *    plural share the invariant adjective; a zero count is NEVER rendered.
 * 2. **Collapsed visibility (App).** The summary lives inside the managed
 *    toggle's text column, so it is visible while the body is `hidden` — driven
 *    through the real App composition root with only the picker/engine
 *    boundaries faked (the `App.section-purposes` posture).
 * 3. **A11y.** The toggle's accessible name stays exactly
 *    `Expand/Collapse <Title>`; the summary joins `aria-describedby` AFTER the
 *    R-14 purpose id only while it exists, and no summary element renders
 *    without it. Inner-disclosure sections (filters/profile/schema) never get a
 *    shell summary (Filters keeps its own `Filters · N active` idiom).
 *
 * Environment scoping mirrors the sibling App specs: the virtualizer is faked
 * so one grid row renders under happy-dom, and the engine boundary answers
 * every call these flows reach (open/schema/range + overlay refresh, validate,
 * diff staging/profile/row-diff).
 */

const FAKE_SCHEMA: readonly { name: string; type: string }[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'country', type: 'VARCHAR' },
  { name: 'amount', type: 'DOUBLE' },
]

const COMPARISON: EngineComparisonHandle = {
  kind: 'comparison',
  id: 'c1',
  schema: [...FAKE_SCHEMA],
}

const PROFILE: EngineDatasetProfile = {
  rowCount: 1,
  columns: FAKE_SCHEMA.map((column) => ({
    name: column.name,
    type: column.type,
    kind: column.type === 'VARCHAR' ? ('categorical' as const) : ('numeric' as const),
    nullCount: 0,
    distinctCount: 1,
  })),
}

function fakeBatch(): ArrowTableLike {
  const columns = [{ get: () => 1 }, { get: () => 'SG' }, { get: () => 10 }]
  return {
    numRows: 1,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
  }
}

/** Row-id column + one data row (the overlay refresh shape the shell expects). */
function fakeOverlayBatch(): ArrowTableLike {
  const columns = [
    { get: () => 'base:fv-1:0' },
    { get: () => 1 },
    { get: () => 'SG' },
    { get: () => 10 },
  ]
  return {
    numRows: 1,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
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
  /** Open calls: the dataset, then the staged comparison file. */
  openCalls: 0,
  /** How many planned validation rules the fake verdict reports as failing. */
  failingRules: 0,
  /** The fake row diff's `changed` aspect count. */
  changedCount: 0,
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
    source: { getFile: async () => new File(['id\n1\n'], 'section-summaries.jsonl') },
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
      rowCount: async () => 1,
      fetchRange: async () => ({ batch: fakeBatch(), hasMore: false }),
      overlaySchema: async () => FAKE_SCHEMA,
      overlayRowCount: async () => 1,
      fetchOverlayRange: async () => ({ batch: fakeOverlayBatch(), hasMore: false }),
      stageComparison: async () => COMPARISON,
      profile: async () => PROFILE,
      // The panel report is assembled by the REAL buildDiffPanelReport, so the
      // `changed` summary reads the executable report's count, not the wire.
      diff: async () => ({
        rowCountA: 1,
        rowCountB: 1,
        aspects: [
          { aspect: 'added' as const, count: 0, samples: [] },
          { aspect: 'removed' as const, count: 0, samples: [] },
          { aspect: 'changed' as const, count: h.changedCount, samples: [] },
        ],
      }),
      validate: async (_handle: EngineTableHandle, plan: EngineValidationPlan) => ({
        valid: h.failingRules === 0,
        rowCount: 1,
        rules: plan.rules.map((rule, index) => ({
          ruleId: rule.ruleId,
          outcome: rule.outcome,
          failCount: index < h.failingRules ? 1 : 0,
          failPercent: 0,
          sampleFailures: [],
        })),
      }),
    },
  }
})

beforeEach(() => {
  h.rows = [{ index: 0, key: 'row-0', start: 0, size: 28 }]
  h.openCalls = 0
  h.failingRules = 0
  h.changedCount = 0
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// Unit pins: one per summary source (copy + presence rule).
// ---------------------------------------------------------------------------

/** One severity-ordered report row; only `failing` drives the summary count. */
function reportRow(
  ruleId: string,
  failing: boolean,
  failCount = failing ? 1 : 0,
): ValidationReportRow {
  return {
    ruleId,
    column: null,
    kind: 'required',
    label: 'Required (no NULLs)',
    failCount,
    failPercent: 0,
    failing,
    outcome: 'row-samples',
    samples: [],
    samplesComplete: false,
    filter: { kind: 'clean' },
  }
}

function verdict(rows: readonly ValidationReportRow[]): ValidationRunState {
  const report: ValidationReport = {
    valid: rows.every((row) => !row.failing),
    rowCount: 4,
    rows,
  }
  return { kind: 'verdict', report, revision: 0 }
}

function entry(seq: number): HistoryEntry {
  const op: EditOp = {
    kind: 'row-insert',
    rowId: insertRowId('ov-1', seq),
    position: { kind: 'end' },
    values: new Map(),
  }
  return { op, outcome: { status: 'applied', notes: [] }, inverse: [] }
}

function historyWith(count: number, cursor = count): TransformationHistory {
  return { entries: Array.from({ length: count }, (_, index) => entry(index)), cursor }
}

function diffRun(changed: number): DiffRunState {
  return {
    kind: 'result',
    report: buildDiffPanelReport({
      diff: { schemaDrift: [], columnDeltas: [], issues: [] },
      result: {
        rowCountA: 2,
        rowCountB: 2,
        aspects: [{ aspect: 'changed', count: changed, samples: [] }],
      },
      keys: ['id'],
      keySource: 'explicit',
      inference: null,
      sharedColumns: ['country'],
      sampleLimitRequested: 3,
      sampleLimitEffective: 3,
      baseViewOnly: true,
      revision: 0,
    }),
  }
}

describe('ug-17 — summary copy per source (unit)', () => {
  it('validation counts failing rules and is absent in every non-verdict state', () => {
    // Non-verdict states: idle/running/cancelled/failed/binding-errors.
    expect(validationSectionSummary({ kind: 'idle' })).toBeNull()
    expect(validationSectionSummary({ kind: 'running' })).toBeNull()
    expect(validationSectionSummary({ kind: 'cancelled' })).toBeNull()
    expect(validationSectionSummary({ kind: 'failed', message: 'nope' })).toBeNull()
    expect(validationSectionSummary({ kind: 'binding-errors', errors: [], revision: 0 })).toBeNull()

    // 0 failing rules → no summary ("0 failing" is never shown).
    expect(validationSectionSummary(verdict([reportRow('columns[0].type', false)]))).toBeNull()
    expect(
      validationSectionSummary(
        verdict([reportRow('columns[0].type', false), reportRow('columns[1].type', false)]),
      ),
    ).toBeNull()

    // 1 and 2 failing rules — byte-exact, invariant adjective.
    expect(validationSectionSummary(verdict([reportRow('columns[0].type', true)]))).toBe(
      'Validation · 1 failing',
    )
    expect(
      validationSectionSummary(
        verdict([reportRow('columns[0].type', true), reportRow('columns[1].type', true)]),
      ),
    ).toBe('Validation · 2 failing')
    // The count is RULES, not violating rows: one failing rule with 25
    // violating rows is still `1 failing`.
    expect(validationSectionSummary(verdict([reportRow('columns[0].unique', true, 25)]))).toBe(
      'Validation · 1 failing',
    )
    // Passing rules in the same report never inflate the count.
    expect(
      validationSectionSummary(
        verdict([
          reportRow('columns[0].unique', true),
          reportRow('columns[0].type', false),
          reportRow('dataset.min-rows', false),
        ]),
      ),
    ).toBe('Validation · 1 failing')
  })

  it('compare reads the row-diff result changed count and is absent otherwise', () => {
    expect(comparisonSectionSummary({ kind: 'idle' })).toBeNull()
    expect(comparisonSectionSummary({ kind: 'running' })).toBeNull()
    expect(comparisonSectionSummary({ kind: 'cancelled' })).toBeNull()
    expect(comparisonSectionSummary({ kind: 'failed', message: 'nope' })).toBeNull()
    expect(comparisonSectionSummary({ kind: 'binding-errors', errors: [], revision: 0 })).toBeNull()

    // 0 changed → no summary.
    expect(comparisonSectionSummary(diffRun(0))).toBeNull()
    expect(comparisonSectionSummary(diffRun(1))).toBe('Compare · 1 changed')
    expect(comparisonSectionSummary(diffRun(3))).toBe('Compare · 3 changed')
  })

  it('history counts the active ops at the cursor only, and is absent at 0', () => {
    expect(historySectionSummary(emptyHistory())).toBeNull()
    // Undo cursor at 0 with a redo tail: nothing is staged, nothing is pending.
    expect(historySectionSummary(historyWith(3, 0))).toBeNull()
    // Active prefix only: a cursor of 2 over 5 entries is `2 pending`, not 5.
    expect(historySectionSummary(historyWith(5, 2))).toBe('History · 2 pending')
    expect(historySectionSummary(historyWith(1))).toBe('History · 1 pending')
    expect(historySectionSummary(historyWith(4))).toBe('History · 4 pending')
  })
})

// ---------------------------------------------------------------------------
// App pins: real composition root, faked picker/engine boundaries only.
// ---------------------------------------------------------------------------

/** Open the faked fixture through the real flow and wait for the ready UI. */
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
    'name: summary-pin',
    'version: 1',
    'columns:',
    '  - name: id',
    '    type: BIGINT',
    '    required: true',
    '  - name: country',
    '    type: VARCHAR',
    '    allowed-values: [SG]',
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

/** Run the validation panel's real Validate click and wait for a verdict. */
async function validate(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('validation-run'))
  })
  await screen.findByTestId('validation-verdict')
}

describe('ug-17 — no summary at zero (App)', () => {
  it('renders no summary element after open and keeps the twelve purpose descriptions intact', async () => {
    await open()

    // Nothing staged/run: no summary anywhere (count 0 is never rendered).
    expect(document.querySelectorAll('[data-testid^="section-summary-"]')).toHaveLength(0)
    for (const id of ['validation', 'compare', 'history']) {
      expect(screen.queryByTestId(`section-summary-${id}`)).toBeNull()
      const toggle = screen.getByTestId(`section-toggle-${id}`)
      // R-14 description unchanged while no summary exists.
      expect(toggle.getAttribute('aria-describedby')).toBe(`section-${id}-purpose`)
      expect(toggle.getAttribute('aria-label')).toBe(`Expand ${SECTION_TITLE[id]!}`)
    }
    // Inner-disclosure sections never carry a shell summary (Filters owns its
    // own `Filters · N active` idiom — not duplicated here).
    for (const id of ['schema', 'filters', 'profile', 'record']) {
      expect(screen.queryByTestId(`section-summary-${id}`)).toBeNull()
    }
  })
})

const SECTION_TITLE: Readonly<Record<string, string>> = {
  validation: 'Validation',
  compare: 'Compare',
  history: 'History',
}

describe('ug-17 — history pending summary (App)', () => {
  it('renders inside the collapsed History toggle, joins aria-describedby, and disappears at 0 after undo', async () => {
    await open()
    const toggle = screen.getByTestId('section-toggle-history')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    await act(async () => {
      fireEvent.click(screen.getByTestId('edit-insert-row'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('edit-insert-row'))
    })

    const summary = await screen.findByTestId('section-summary-history')
    expect(summary.textContent).toBe('History · 2 pending')
    // Collapsed visibility: inside the managed toggle, not the hidden body.
    expect(toggle.contains(summary)).toBe(true)
    expect(summary.closest('[hidden]')).toBeNull()
    expect(document.getElementById('section-history-content')?.hasAttribute('hidden')).toBe(true)

    // A11y: stable id, purpose first then summary, name untouched.
    expect(summary.id).toBe('section-history-summary')
    expect(toggle.getAttribute('aria-describedby')).toBe(
      'section-history-purpose section-history-summary',
    )
    expect(screen.getByRole('button', { name: 'Expand History' })).toBe(toggle)

    // Undo once → 1 pending (still a summary, recomputed from the cursor).
    await act(async () => {
      fireEvent.click(screen.getByTestId('history-undo'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('section-summary-history').textContent).toBe('History · 1 pending')
    })

    // Undo back to 0 → the summary element is gone and the description is
    // exactly the R-14 purpose again.
    await act(async () => {
      fireEvent.click(screen.getByTestId('history-undo'))
    })
    await waitFor(() => {
      expect(screen.queryByTestId('section-summary-history')).toBeNull()
    })
    expect(toggle.getAttribute('aria-describedby')).toBe('section-history-purpose')
  })
})

describe('ug-17 — validation verdict summary (App)', () => {
  it('shows the failing-rule count while collapsed and drops it on a clean verdict', async () => {
    await open()
    const toggle = screen.getByTestId('section-toggle-validation')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('section-summary-validation')).toBeNull()

    await loadContract()
    h.failingRules = 2
    await validate()

    const summary = await screen.findByTestId('section-summary-validation')
    expect(summary.textContent).toBe('Validation · 2 failing')
    expect(toggle.contains(summary)).toBe(true)
    expect(summary.closest('[hidden]')).toBeNull()
    expect(toggle.getAttribute('aria-describedby')).toBe(
      'section-validation-purpose section-validation-summary',
    )
    expect(screen.getByRole('button', { name: 'Expand Validation' })).toBe(toggle)

    // A clean re-run reports 0 failing → no summary (not "0 failing").
    h.failingRules = 0
    await validate()
    await waitFor(() => {
      expect(screen.queryByTestId('section-summary-validation')).toBeNull()
    })
    expect(toggle.getAttribute('aria-describedby')).toBe('section-validation-purpose')
  })
})

describe('ug-17 — comparison summary (App)', () => {
  it('shows the changed count from a row diff, updates it on re-run, and drops it at 0', async () => {
    await open()
    const toggle = screen.getByTestId('section-toggle-compare')
    expect(screen.queryByTestId('section-summary-compare')).toBeNull()

    // Stage a comparison through the panel's real hidden-input seam.
    const input = screen.getByTestId('diff-comparison-input') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      value: [new File(['id,country,amount\n1,SG,10\n'], 'comparison.csv')],
      configurable: true,
    })
    await act(async () => {
      fireEvent.change(input)
    })
    await screen.findByTestId('diff-key-selection')

    // Explicit keys (no inference dependency), then run the real row diff.
    await act(async () => {
      fireEvent.change(screen.getByTestId('diff-key-manual-input'), {
        target: { value: 'id' },
      })
    })
    h.changedCount = 3
    await act(async () => {
      fireEvent.click(screen.getByTestId('diff-run'))
    })
    await screen.findByTestId('diff-verdict')

    const summary = await screen.findByTestId('section-summary-compare')
    expect(summary.textContent).toBe('Compare · 3 changed')
    expect(toggle.contains(summary)).toBe(true)
    expect(summary.closest('[hidden]')).toBeNull()
    expect(toggle.getAttribute('aria-describedby')).toBe(
      'section-compare-purpose section-compare-summary',
    )
    expect(screen.getByRole('button', { name: 'Expand Compare' })).toBe(toggle)

    // Re-run with a different count: the summary follows the CURRENT result.
    h.changedCount = 1
    await act(async () => {
      fireEvent.click(screen.getByTestId('diff-run'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('section-summary-compare').textContent).toBe('Compare · 1 changed')
    })

    // A zero-changed result shows no summary at all.
    h.changedCount = 0
    await act(async () => {
      fireEvent.click(screen.getByTestId('diff-run'))
    })
    await waitFor(() => {
      expect(screen.queryByTestId('section-summary-compare')).toBeNull()
    })
    expect(toggle.getAttribute('aria-describedby')).toBe('section-compare-purpose')
  })
})
