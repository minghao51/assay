// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type { EditOp, TransformationHistory } from '@assay/domain'
import { DEFAULT_REPAIR_TRIM_CODE_POINTS, baseRowId } from '@assay/domain'
import {
  EMPTY_REPAIR_DRAFT,
  MAX_REPAIR_PREVIEW_EXAMPLES,
  parseMappingLine,
  parseRepairPlan,
  draftTrimSet,
  repairPlanFingerprint,
  repairPlanIsActive,
  repairOpFingerprint,
  repairPlanOp,
} from './plan'
import type { RepairPlan } from './plan'
import {
  REPAIR_MAPPING_SEPARATOR,
  REPAIR_REFUSAL_COLUMN_MISSING,
  REPAIR_REFUSAL_DUPLICATE_KEY,
  REPAIR_REFUSAL_MAPPING_LINE,
} from './copy'

/**
 * EW-04I plan capture. The literals below are asserted independently of
 * `copy.ts` (never imported) so a sentence change has to be a deliberate
 * two-file change, and the separator is pinned as the five characters the
 * helper copy tells the user to type.
 */

const PLAN: RepairPlan = {
  column: 'country',
  trim: DEFAULT_REPAIR_TRIM_CODE_POINTS,
  mapping: new Map([['SG', 'Singapore']]),
}

describe('parseMappingLine — the one-pair-per-line grammar', () => {
  it(`splits at the first "${REPAIR_MAPPING_SEPARATOR}" and never trims either side`, () => {
    expect(parseMappingLine('SG => Singapore')).toEqual(['SG', 'Singapore'])
    // Spaces are part of the value: the plan captures exact whole values.
    expect(parseMappingLine(' SG  =>  Singapore ')).toEqual([' SG ', ' Singapore '])
    // Only the FIRST separator splits, so a replacement may contain one.
    expect(parseMappingLine('a => b => c')).toEqual(['a', 'b => c'])
  })

  it('expresses the empty string on either side, and refuses a line without the separator', () => {
    expect(parseMappingLine(' => x')).toEqual(['', 'x'])
    expect(parseMappingLine('x => ')).toEqual(['x', ''])
    expect(parseMappingLine('SG')).toBeNull()
    expect(parseMappingLine('SG -> Singapore')).toBeNull()
    expect(parseMappingLine('SG=>Singapore')).toBeNull()
  })
})

describe('parseRepairPlan — the draft becomes the op payload', () => {
  it('parses one pair per line, skipping blank lines', () => {
    const parsed = parseRepairPlan({
      ...EMPTY_REPAIR_DRAFT,
      column: 'country',
      mappingText: 'SG => Singapore\n\nUS => United States\n',
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.plan.column).toBe('country')
    expect([...parsed.plan.mapping]).toEqual([
      ['SG', 'Singapore'],
      ['US', 'United States'],
    ])
    expect(parsed.plan.trim).toBeUndefined()
  })

  it('carries the domain default trim set verbatim (never String.prototype.trim())', () => {
    const parsed = parseRepairPlan({
      ...EMPTY_REPAIR_DRAFT,
      column: 'country',
      trimMode: 'default',
      mappingText: 'SG => Singapore',
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    // The exact four code points D1 recommends, in the domain's order.
    expect(parsed.plan.trim).toBe('\u0020\u0009\u000A\u000D')
    expect([...(parsed.plan.trim ?? '')]).toHaveLength(4)
    // String.prototype.trim() would also strip NBSP and keep nothing of the
    // default set's intent; the captured set is a value, not a mode.
    expect(draftTrimSet({ ...EMPTY_REPAIR_DRAFT, trimMode: 'default' })).toBe(
      DEFAULT_REPAIR_TRIM_CODE_POINTS,
    )
  })

  it('passes a custom set through untouched so the domain owns the cap', () => {
    const parsed = parseRepairPlan({
      ...EMPTY_REPAIR_DRAFT,
      column: 'country',
      trimMode: 'custom',
      customTrim: ' \u00a0',
      mappingText: 'SG => Singapore',
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    // An intentionally NBSP-including set: the surface never "corrects" it.
    expect(parsed.plan.trim).toBe(' \u00a0')
  })

  it('refuses a missing column, a malformed line and a repeated left-hand value', () => {
    const noColumn = parseRepairPlan({ ...EMPTY_REPAIR_DRAFT, mappingText: 'SG => Singapore' })
    expect(noColumn.ok).toBe(false)
    if (noColumn.ok) return
    expect(noColumn.refusal.code).toBe('column-missing')
    expect(noColumn.refusal.message).toBe('Choose the column to repair.')
    expect(noColumn.refusal.message).toBe(REPAIR_REFUSAL_COLUMN_MISSING)

    const badLine = parseRepairPlan({
      ...EMPTY_REPAIR_DRAFT,
      column: 'country',
      mappingText: 'SG => Singapore\nnonsense',
    })
    expect(badLine.ok).toBe(false)
    if (badLine.ok) return
    expect(badLine.refusal.code).toBe('mapping-line')
    expect(badLine.refusal.message).toBe(
      'Each line must read value => replacement. A line without => is refused.',
    )
    expect(badLine.refusal.message).toBe(REPAIR_REFUSAL_MAPPING_LINE)

    const duplicate = parseRepairPlan({
      ...EMPTY_REPAIR_DRAFT,
      column: 'country',
      mappingText: 'SG => Singapore\nSG => Singapura',
    })
    expect(duplicate.ok).toBe(false)
    if (duplicate.ok) return
    expect(duplicate.refusal.code).toBe('mapping-duplicate-key')
    expect(duplicate.refusal.message).toBe(
      'Two lines use the same left-hand value. Each value may appear in the mapping once.',
    )
    expect(duplicate.refusal.message).toBe(REPAIR_REFUSAL_DUPLICATE_KEY)
  })

  it('does not refuse an empty pair list — that is the domain identity rule', () => {
    const parsed = parseRepairPlan({ ...EMPTY_REPAIR_DRAFT, column: 'country' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.plan.mapping.size).toBe(0)
    expect(parsed.plan.trim).toBeUndefined()
  })
})

describe('repairPlanOp / fingerprint / already-active', () => {
  it('builds the domain op with the plan fields only', () => {
    const op = repairPlanOp(PLAN)
    expect(op).toEqual({
      kind: 'column-repair',
      column: 'country',
      trim: '\u0020\u0009\u000A\u000D',
      mapping: PLAN.mapping,
    })
  })

  it('fingerprints the plan by function, not by line order', () => {
    const a: RepairPlan = {
      column: 'country',
      mapping: new Map([
        ['SG', 'Singapore'],
        ['US', 'United'],
      ]),
    }
    const b: RepairPlan = {
      column: 'country',
      mapping: new Map([
        ['US', 'United'],
        ['SG', 'Singapore'],
      ]),
    }
    expect(repairPlanFingerprint(a)).toBe(repairPlanFingerprint(b))
    // Different column, different trim, different target: all distinct.
    expect(repairPlanFingerprint(a)).not.toBe(repairPlanFingerprint({ ...a, column: 'nation' }))
    expect(repairPlanFingerprint(a)).not.toBe(repairPlanFingerprint({ ...a, trim: ' ' }))
    expect(repairPlanFingerprint(a)).not.toBe(
      repairPlanFingerprint({ ...a, mapping: new Map([['SG', 'Singapura']]) }),
    )
  })

  it('identifies a logged repair op and ignores every other kind', () => {
    const op = repairPlanOp(PLAN)
    expect(repairOpFingerprint(op)).toBe(repairPlanFingerprint(PLAN))
    const other: EditOp = { kind: 'row-delete', rowId: baseRowId('fv-1-2', 0) }
    expect(repairOpFingerprint(other)).toBeNull()
  })

  it('counts only the ACTIVE prefix as already applied', () => {
    const op = repairPlanOp(PLAN)
    const fingerprint = repairPlanFingerprint(PLAN)
    const entry = {
      op,
      outcome: { status: 'applied', notes: ['undo-by-refold'] } as const,
      inverse: [],
    }
    const history: TransformationHistory = { entries: [entry], cursor: 1 }
    expect(repairPlanIsActive(history, fingerprint)).toBe(true)
    // Undone (the entry sits in the redo tail): the plan can be applied again.
    expect(repairPlanIsActive({ ...history, cursor: 0 }, fingerprint)).toBe(false)
    // An unrelated repair on the same column is a different plan.
    expect(repairPlanIsActive(history, repairPlanFingerprint({ ...PLAN, column: 'nation' }))).toBe(
      false,
    )
  })

  it('states the 10-example cap the preview applies', () => {
    expect(MAX_REPAIR_PREVIEW_EXAMPLES).toBe(10)
  })
})
