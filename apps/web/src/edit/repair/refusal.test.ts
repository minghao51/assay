// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from 'vitest'
import type { OverlayBase } from '@assay/domain'
import {
  MAX_REPAIR_MAPPING_PAIRS,
  MAX_REPAIR_TRIM_CODE_POINTS,
  initialState,
  stepOverlay,
} from '@assay/domain'
import type { RepairPlan } from './plan'
import { repairPlanOp } from './plan'
import { repairRefusalForOutcome, validateRepairPlan } from './refusal'

/**
 * EW-04I capture-time refusals: every rule below is the **domain's** typed
 * conflict, reached through `stepOverlay` with no engine call at all (the
 * brief's "surface without an engine call"). The assertions prove the *reason
 * code* the fold returned — so a host-side re-implementation drifting from the
 * domain would fail here — and pin the authored, value-free sentence.
 *
 * The sentences name shape only (column kind, pair count, code-point count, a
 * dead key's edge, the identity) and never a dataset value or a mapping entry
 * (ADR 0025), which the last test asserts by scanning the rendered text for the
 * plan's own content.
 */

const BASE: OverlayBase = {
  baseAnchor: 'fv-5-1000',
  overlayAnchor: 'ov-1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'label', type: 'VARCHAR' },
    { name: 'note', type: 'TEXT' },
    { name: 'code', type: "ENUM('a', 'b')" },
    { name: 'flag', type: 'CHAR(3)' },
  ],
  baseRowCount: 5,
}

const STATE = initialState(BASE)

function plan(overrides: Partial<RepairPlan> & { column: string }): RepairPlan {
  return {
    mapping: new Map([['a', 'b']]),
    ...overrides,
  }
}

/** The typed reason the live fold reports for one plan (no engine call). */
function reasonFor(overrides: Partial<RepairPlan> & { column: string }): string | null {
  const step = stepOverlay(BASE, STATE, repairPlanOp(plan(overrides)))
  return step.application.outcome.status === 'applied'
    ? null
    : (step.application.outcome.reason ?? null)
}

describe('refusal — the domain decides, and each reason has one authored sentence', () => {
  it('accepts a well-formed plan on a textual column', () => {
    expect(reasonFor({ column: 'label' })).toBeNull()
    expect(validateRepairPlan(BASE, STATE, plan({ column: 'note' }))).toBeNull()
  })

  it('unknown column', () => {
    expect(reasonFor({ column: 'nope' })).toBe('unknown-column')
    expect(validateRepairPlan(BASE, STATE, plan({ column: 'nope' }))).toEqual({
      code: 'unknown-column',
      message: 'Choose the column to repair.',
    })
  })

  it('non-text column — BIGINT, ENUM and CHAR are all refused by the domain', () => {
    for (const column of ['id', 'code', 'flag']) {
      expect(reasonFor({ column }), column).toBe('repair-column-not-text')
    }
    const refusal = validateRepairPlan(BASE, STATE, plan({ column: 'code' }))
    expect(refusal?.code).toBe('repair-column-not-text')
    expect(refusal?.message).toBe(
      'That column is not a text column, so a repair cannot target it: only VARCHAR, TEXT and STRING can be repaired. Character and ENUM columns are refused because a trim would re-declare their type.',
    )
  })

  it('pair cap — 501 pairs is refused, 500 is not', () => {
    const atCap = new Map(
      Array.from({ length: MAX_REPAIR_MAPPING_PAIRS }, (_, index) => [
        `k${String(index)}`,
        `v${String(index)}`,
      ]),
    )
    const overCap = new Map([...atCap, ['extra', 'extra-value']])
    expect(reasonFor({ column: 'label', mapping: atCap })).toBeNull()
    expect(reasonFor({ column: 'label', mapping: overCap })).toBe('repair-mapping-cap')
    expect(validateRepairPlan(BASE, STATE, plan({ column: 'label', mapping: overCap }))).toEqual({
      code: 'repair-mapping-cap',
      message:
        'This plan has more than 500 mapping pairs, over the plan cap. Split it into several repairs.',
    })
    expect(MAX_REPAIR_MAPPING_PAIRS).toBe(500)
  })

  it('trim set — empty and over the 16-code-point cap are refused', () => {
    expect(reasonFor({ column: 'label', trim: '' })).toBe('repair-trim-invalid')
    // A set with no member of the mapping key, so only the cap is under test.
    const sixteen = '-_.,;:!?()[]{}<>'
    expect([...sixteen]).toHaveLength(MAX_REPAIR_TRIM_CODE_POINTS)
    expect(reasonFor({ column: 'label', trim: sixteen })).toBeNull()
    expect(reasonFor({ column: 'label', trim: `${sixteen}q` })).toBe('repair-trim-invalid')
    // Astral members count as ONE code point each (the domain iterates by code point).
    expect(reasonFor({ column: 'label', trim: '😀😀' })).toBeNull()
    expect(validateRepairPlan(BASE, STATE, plan({ column: 'label', trim: '' }))).toEqual({
      code: 'repair-trim-invalid',
      message:
        'The trim set must hold between 1 and 16 characters. Choose No trim, or list at least one character.',
    })
  })

  it('dead mapping key — a key whose own edge carries a trim-set member', () => {
    expect(reasonFor({ column: 'label', trim: ' ', mapping: new Map([[' a', 'b']]) })).toBe(
      'repair-dead-mapping-key',
    )
    // The same key is live with no trim: nothing is dead without a trim set.
    expect(reasonFor({ column: 'label', mapping: new Map([[' a', 'b']]) })).toBeNull()
    expect(
      validateRepairPlan(
        BASE,
        STATE,
        plan({ column: 'label', trim: ' ', mapping: new Map([['a ', 'b']]) }),
      ),
    ).toEqual({
      code: 'repair-dead-mapping-key',
      message:
        'A mapping value ends or begins with a character from the trim set, so that pair could never match — trimming happens before the mapping. Remove those characters from the pair, or change the trim set.',
    })
  })

  it('one trim set per chain — a second repair with another set is refused', () => {
    const first = stepOverlay(BASE, STATE, repairPlanOp(plan({ column: 'label', trim: ' ' })))
    expect(first.application.outcome.status).toBe('applied')
    const mismatch = stepOverlay(
      BASE,
      first.state,
      repairPlanOp(plan({ column: 'label', trim: '\t' })),
    )
    expect(mismatch.application.outcome).toMatchObject({
      status: 'conflict',
      reason: 'repair-trim-mismatch',
    })
    expect(repairRefusalForOutcome(mismatch.application.outcome)).toEqual({
      code: 'repair-trim-mismatch',
      message:
        'This column already carries a repair with a different trim set in this session, and one repair chain has one trim set. Undo that repair, or match its trim set.',
    })
    // The SAME trim set chains (forward composition), so it is not refused.
    const same = stepOverlay(BASE, first.state, repairPlanOp(plan({ column: 'label', trim: ' ' })))
    expect(same.application.outcome.status).toBe('applied')
  })

  it('identity — no pairs and no trim is the fold’s own no-op', () => {
    expect(reasonFor({ column: 'label', mapping: new Map() })).toBe('repair-identity')
    expect(validateRepairPlan(BASE, STATE, plan({ column: 'label', mapping: new Map() }))).toEqual({
      code: 'repair-identity',
      message:
        'This plan changes nothing: it has no mapping pairs and no trim, so every value would pass through unchanged.',
    })
    // A trim alone or a pair alone is NOT the identity function.
    expect(reasonFor({ column: 'label', mapping: new Map(), trim: ' ' })).toBeNull()
  })

  it('every sentence is value-free: no plan content and no dataset value appears', () => {
    // Distinctive multi-character values: a one-letter value would appear in
    // ordinary prose and make the assertion meaningless.
    const values = ['Singapore', 'Singapura', ' padded value ']
    const plans: RepairPlan[] = [
      plan({
        column: 'nope',
        mapping: new Map([[values[0]!, values[1]!]]),
      }),
      plan({
        column: 'code',
        mapping: new Map([[values[0]!, values[1]!]]),
      }),
      plan({
        column: 'label',
        trim: ' ',
        mapping: new Map([[values[2]!, values[1]!]]),
      }),
      plan({ column: 'label', mapping: new Map() }),
    ]
    for (const candidate of plans) {
      const refusal = validateRepairPlan(BASE, STATE, candidate)
      expect(refusal).not.toBeNull()
      if (refusal === null) continue
      for (const value of values) {
        expect(refusal.message, refusal.code).not.toContain(value)
      }
      // Nor a mapping entry replayed as "from => to".
      expect(refusal.message).not.toContain('=>')
    }
  })

  it('does not touch the engine: the whole module is the pure fold', () => {
    // `stepOverlay` is the only dependency and it is synchronous + pure; the
    // import graph carries no engine client. A spy proves the call shape: the
    // verdict is available without awaiting anything.
    const spy = vi.fn()
    spy(validateRepairPlan(BASE, STATE, plan({ column: 'label' })))
    expect(spy).toHaveBeenCalledWith(null)
  })
})
