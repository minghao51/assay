// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { MAX_REPAIR_EXPORT_CELL_WORK, OverlayRepairExportBudgetError } from '@assay/engine-duckdb'
import {
  REPAIR_EXPORT_CELL_WORK_ENVELOPE,
  projectedRepairCellWork,
  repairBudgetRefusalFor,
} from './budget'

/**
 * EW-04I — the published export envelope, refused **pre-apply** (post-R1
 * acceptance D4 option (a)).
 *
 * The projection is the engine's own quantity (`rows × pairs`, summed over the
 * whole repair prefix), and the sentence it produces is pinned against the
 * engine's published refusal so the two cannot drift: the same envelope number,
 * the same "undo repairs or export the edits to a new file" remedy, and no
 * interrupt claim anywhere.
 */

describe('projectedRepairCellWork — rows × pairs', () => {
  it('multiplies and stays exact at the envelope corner', () => {
    expect(projectedRepairCellWork(5, 2)).toBe(10)
    expect(projectedRepairCellWork(2_000_000, 500)).toBe(1_000_000_000)
    expect(REPAIR_EXPORT_CELL_WORK_ENVELOPE).toBe(MAX_REPAIR_EXPORT_CELL_WORK)
    expect(MAX_REPAIR_EXPORT_CELL_WORK).toBe(1_000_000_000)
  })
})

describe('repairBudgetRefusalFor — the pre-apply refusal', () => {
  it('is silent at or under the envelope', () => {
    expect(repairBudgetRefusalFor(5, 0, 2)).toBeNull()
    expect(repairBudgetRefusalFor(1000, 0, 1)).toBeNull()
    // Exactly at the envelope is allowed: the engine refuses only ABOVE it.
    expect(repairBudgetRefusalFor(2_000_000, 0, 500)).toBeNull()
  })

  it('refuses above it, counting the whole prefix and not only the new plan', () => {
    expect(repairBudgetRefusalFor(2_000_001, 0, 500)).not.toBeNull()
    // 2M rows: 400 existing pairs + 400 new pairs = 1.6e9, over the envelope —
    // a projection that counted only the new plan (8e8) would have passed.
    expect(repairBudgetRefusalFor(2_000_000, 400, 400)).not.toBeNull()
    expect(repairBudgetRefusalFor(2_000_000, 200, 300)).toBeNull()
  })

  it('states the projection, the envelope and the remedy — and claims no interrupt', () => {
    const message = repairBudgetRefusalFor(2_000_000, 400, 400)
    expect(message).toBe(
      'This plan would cost 2000000 rows × 800 mapping pairs = 1,600,000,000 cell rewrites, ' +
        'over the published envelope of 1,000,000,000. Nothing was previewed or applied: export ' +
        'the edits to a new file and re-open it before repairing further.',
    )
    // No interrupt vocabulary anywhere (there is no cancel op).
    for (const word of ['interrupt', 'abort', 'cancel', 'stopped']) {
      expect(message?.toLowerCase()).not.toContain(word)
    }
    // The numbers are configuration, never dataset content.
    expect(message).not.toMatch(/Singapore|Connah/)
  })

  it('agrees with the engine’s own published refusal on the remedy and the bound', () => {
    const message = repairBudgetRefusalFor(2_000_000, 0, 800) ?? ''
    const engine = new OverlayRepairExportBudgetError().message
    // Same envelope number, rendered the same way.
    expect(engine).toContain('1,000,000,000')
    expect(message).toContain('1,000,000,000')
    // Same remedy clause, so a user is never told two different things.
    expect(engine).toContain('export the edits to a new file and re-open it')
    expect(message).toContain('export the edits to a new file and re-open it')
    // …and the same "not an interrupt" posture: the engine calls it a budget.
    expect(engine).toContain('exceeds the published budget')
    expect(message).toContain('over the published envelope')
  })
})
