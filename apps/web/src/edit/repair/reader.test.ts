// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from 'vitest'
import type { OverlayBase } from '@assay/domain'
import { initialState } from '@assay/domain'
import type { EngineOverlay, EngineRangeResult } from '@assay/engine-duckdb'
import type { RepairPlan } from './plan'
import type { RepairReadRequest } from './reader'

/**
 * B1/ENG-2 — the preview read boundary, asserted by **request type**.
 *
 * The affected count must come from the typed `engine/repair-preview-count`
 * op, never from a host-composed statement through the generic `engine/query`
 * op. The fake client below makes that structural: it has no `query` method at
 * all (so the old path cannot run) and the count is answered only by
 * `repairPreviewCount`, whose call is recorded with the plan it received —
 * the op's request payload. The typed op's own wire shape
 * (`type: 'engine/repair-preview-count'`) is pinned in the engine package
 * (`packages/engine-duckdb/src/client.test.ts`), which owns the boundary.
 *
 * The examples stay `overlay-range` over the same snapshot, and `scanned`
 * stays the pure domain fold — both unchanged by this switch.
 */

const h = vi.hoisted(() => ({
  /** The typed count op's calls: the plan the reader sent. */
  countCalls: [] as {
    readonly overlay: EngineOverlay
    readonly plan: { readonly column: string; readonly trim?: string }
    readonly pairs: readonly (readonly [string, string])[]
  }[],
  /** The examples window's calls. */
  exampleCalls: [] as {
    readonly columns: readonly string[] | undefined
    readonly endRow: number | undefined
    readonly filters: readonly { readonly column: string; readonly predicate: string }[] | undefined
    readonly includeRowIds: boolean | undefined
  }[],
  /** The count the typed op answers. */
  affected: 0,
}))

function exampleBatch(
  rows: readonly { readonly rowId: string; readonly value: unknown }[],
): unknown {
  // The reader projects through `projectOverlayPage`, which reads the leading
  // `assay_row_id` column and the value column by index — the engine's own
  // first-`batch` shape, so no Arrow machinery is needed here.
  const ids = rows.map((row) => row.rowId)
  const values = rows.map((row) => row.value)
  return {
    numRows: rows.length,
    numCols: 2,
    getChildAt: (index: number) => {
      const source = index === 0 ? ids : values
      return { get: (rowIndex: number) => source[rowIndex] ?? null }
    },
  }
}

vi.mock('../../lib/engine', () => ({
  engineClient: {
    // The typed op — the ONLY count channel. No `query` member exists on this
    // fake, so a regression to the generic op fails this suite loudly.
    repairPreviewCount: async (
      _handle: unknown,
      overlay: EngineOverlay,
      plan: {
        readonly column: string
        readonly trim?: string
        readonly pairs: readonly (readonly [string, string])[]
      },
    ): Promise<number> => {
      h.countCalls.push({ overlay, plan, pairs: plan.pairs })
      return h.affected
    },
    fetchOverlayRange: async (
      _handle: unknown,
      _overlay: unknown,
      window: {
        readonly columns?: readonly string[]
        readonly endRow?: number
        readonly filters?: readonly { readonly column: string; readonly predicate: string }[]
        readonly includeRowIds?: boolean
      },
    ): Promise<EngineRangeResult> => {
      h.exampleCalls.push({
        columns: window.columns,
        endRow: window.endRow,
        filters: window.filters,
        includeRowIds: window.includeRowIds,
      })
      return {
        batch: exampleBatch([{ rowId: 'base:b1#0', value: 'SG' }]) as EngineRangeResult['batch'],
        hasMore: false,
      }
    },
  },
}))

const BASE: OverlayBase = {
  baseAnchor: 'b1',
  overlayAnchor: 'o1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'country', type: 'VARCHAR' },
  ],
  baseRowCount: 5,
}

const OVERLAY: EngineOverlay = { base: BASE, ops: [] }

const SNAPSHOT = { viewName: 'assay_t1', base: BASE, state: initialState(BASE) }

function request(): RepairReadRequest {
  return {
    handle: { kind: 'table', id: 't1' } as RepairReadRequest['handle'],
    overlay: OVERLAY,
    snapshot: SNAPSHOT,
  }
}

const PLAN: RepairPlan = {
  column: 'country',
  trim: ' ',
  mapping: new Map([
    ['US', 'United States'],
    ['SG', 'Singapore'],
  ]),
}

describe('readRepairPreview — the typed count op, the typed example window, the pure fold', () => {
  it('reads the affected count through engine/repair-preview-count (never a generic query)', async () => {
    h.countCalls = []
    h.exampleCalls = []
    h.affected = 2
    const { readRepairPreview } = await import('./reader')

    const read = await readRepairPreview(request(), PLAN)

    // Exactly one typed count call, carrying the plan as DATA in canonical
    // pair order (a `Map` is not the wire shape; sorted pairs are).
    expect(h.countCalls).toHaveLength(1)
    expect(h.countCalls[0]?.plan).toEqual({
      column: 'country',
      trim: ' ',
      pairs: [
        ['SG', 'Singapore'],
        ['US', 'United States'],
      ],
    })
    expect(h.countCalls[0]?.pairs).toEqual([
      ['SG', 'Singapore'],
      ['US', 'United States'],
    ])
    expect(h.countCalls[0]?.overlay).toBe(OVERLAY)
    expect(read.affected).toBe(2)
  })

  it('keeps the examples window and the scanned fold unchanged', async () => {
    h.countCalls = []
    h.exampleCalls = []
    h.affected = 2
    const { readRepairPreview } = await import('./reader')

    const read = await readRepairPreview(request(), PLAN)

    // The example read is still `overlay-range` with the plan's predicate
    // (the engine's own builder, so it cannot drift from the count), a stated
    // LIMIT and row ids.
    expect(h.exampleCalls).toHaveLength(1)
    expect(h.exampleCalls[0]?.columns).toEqual(['country'])
    expect(h.exampleCalls[0]?.endRow).toBe(10)
    expect(h.exampleCalls[0]?.includeRowIds).toBe(true)
    expect(h.exampleCalls[0]?.filters).toEqual([
      {
        column: 'country',
        predicate:
          'IS NOT NULL AND (trim("country", \' \'), "country") NOT IN ' +
          "(VALUES ('SG', 'Singapore'), ('US', 'United States')) AND " +
          "(trim(\"country\", ' ') IN ('SG', 'US') OR trim(\"country\", ' ') <> \"country\")",
      },
    ])
    // `scanned` is the pure domain fold over the same snapshot — no engine
    // call, so the two answers describe one relation by construction.
    expect(read.scanned).toBe(5)
    expect(read.exampleCap).toBe(10)
    expect(read.exampleRows).toEqual([{ rowId: 'base:b1#0', value: 'SG' }])
  })
})
