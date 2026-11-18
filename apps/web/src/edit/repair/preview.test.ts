// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type { RepairCaptureTag } from './capture'
import type { RepairPlan } from './plan'
import {
  assembleRepairPreview,
  previewExampleCapSentence,
  repairExampleFrom,
  repairValueText,
  type RepairPreviewRead,
} from './preview'

/**
 * EW-04I — preview projection: complete counts, `≤10` bounded examples and the
 * **stated** cap.
 *
 * Nothing here holds a row array: the read carries at most `exampleCap` rows,
 * the preview keeps exactly those, and the cap sentence always states both
 * numbers when the plan changes more rows than are shown (EW-04D §3: no silent
 * top-N). The before/after text is the stored text, so an edge-whitespace
 * difference is visible rather than collapsed by formatting.
 */

const TAG: RepairCaptureTag = {
  baseAnchor: 'fv-5-1000',
  overlayAnchor: 'ov-1',
  cursor: 0,
  historyRevision: 0,
  column: 'country',
  columnType: 'VARCHAR',
  schemaSignature: 'id:BIGINT\u0000country:VARCHAR',
}

const PLAN: RepairPlan = {
  column: 'country',
  trim: ' ',
  mapping: new Map([['SG', 'Singapore']]),
}

function read(overrides: Partial<RepairPreviewRead> = {}): RepairPreviewRead {
  return {
    scanned: 5,
    affected: 2,
    exampleCap: 10,
    exampleRows: [
      { rowId: 'base:fv-5-1000#0', value: 'SG' },
      { rowId: 'base:fv-5-1000#2', value: ' SG ' },
    ],
    ...overrides,
  }
}

describe('assembleRepairPreview — counts are complete, examples are bounded', () => {
  it('derives unaffected from the complete counts and keeps the plan’s identity', () => {
    const preview = assembleRepairPreview(PLAN, 'fp-1', TAG, read())
    expect(preview.counts).toEqual({ scanned: 5, affected: 2, unaffected: 3 })
    expect(preview.fingerprint).toBe('fp-1')
    expect(preview.tag).toBe(TAG)
    expect(preview.plan).toBe(PLAN)
    expect(preview.exampleCap).toBe(10)
    expect(preview.examples).toEqual([
      { rowId: 'base:fv-5-1000#0', before: 'SG', after: 'Singapore' },
      // The passthrough is the TRIMMED value (EW-04D §1).
      { rowId: 'base:fv-5-1000#2', before: ' SG ', after: 'Singapore' },
    ])
  })

  it('never exceeds the cap, even if a response over-delivers', () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      rowId: `base:fv-5-1000#${String(index)}`,
      value: 'SG',
    }))
    const preview = assembleRepairPreview(PLAN, 'fp-1', TAG, read({ exampleRows: rows }))
    expect(preview.examples).toHaveLength(10)
    expect(preview.exampleCap).toBe(10)
    // The complete count is untouched by the bounded read — that is the point.
    expect(preview.counts.affected).toBe(2)
  })

  it('a zero-affected plan carries no examples and never a negative unaffected', () => {
    const preview = assembleRepairPreview(PLAN, 'fp-0', TAG, read({ affected: 0, exampleRows: [] }))
    expect(preview.counts).toEqual({ scanned: 5, affected: 0, unaffected: 5 })
    expect(preview.examples).toEqual([])
    // Defensive: a response that claims more affected rows than scanned rows
    // must not render a negative "left as they are".
    const odd = assembleRepairPreview(PLAN, 'fp-2', TAG, read({ affected: 7, scanned: 5 }))
    expect(odd.counts.unaffected).toBe(0)
  })
})

describe('previewExampleCapSentence — the cap is stated, never implied', () => {
  function preview(affected: number, shown: number) {
    const rows = Array.from({ length: shown }, (_, index) => ({
      rowId: `base:fv-5-1000#${String(index)}`,
      value: 'SG',
    }))
    return assembleRepairPreview(
      PLAN,
      'fp',
      TAG,
      read({ scanned: 100, affected, exampleRows: rows }),
    )
  }

  it('states both numbers when the plan changes more rows than are shown', () => {
    expect(previewExampleCapSentence(preview(137, 10))).toBe(
      'Showing the first 10 of 137 changed rows.',
    )
  })

  it('says "all" when every changed row is shown', () => {
    expect(previewExampleCapSentence(preview(4, 4))).toBe('All 4 changed rows are shown.')
    expect(previewExampleCapSentence(preview(0, 0))).toBe('All 0 changed rows are shown.')
  })
})

describe('example text — exact, not prettified', () => {
  it('renders the stored text including edge and interior whitespace', () => {
    expect(repairValueText('  SG  ')).toBe('  SG  ')
    expect(repairValueText('a\tb')).toBe('a\tb')
    expect(repairValueText('')).toBe('')
  })

  it('renders NULL as NULL, never as an empty cell', () => {
    expect(repairValueText(null)).toBe('NULL')
    expect(repairValueText(undefined)).toBe('NULL')
  })

  it('a non-string value is shown unchanged rather than repaired from a guess', () => {
    expect(repairExampleFrom('base:fv-5-1000#1', 42, PLAN)).toEqual({
      rowId: 'base:fv-5-1000#1',
      before: '42',
      after: '42',
    })
  })
})
