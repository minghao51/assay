// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { baseRowId } from '@assay/domain'
import type { OverlayBase } from '@assay/domain'
import type { GridViewportModel } from '@assay/grid'
import { useEditingSession } from './useEditingSession'
import type { DatasetSession } from './session-reset'
import type { Phase } from './types'

/**
 * WF-06 seams in the editing session (S-A2-2 / S-A2-4, IC-02).
 *
 * Two synchronous authorities now feed the ready-state gesture gate:
 *
 * - `mutationStateRef` — a COUNT of commits materializing (not a boolean: two
 *   commits can overlap), incremented before the commit's `await` and
 *   decremented in its `finally`;
 * - `castPendingColumnsRef` — the aggregate set of columns whose cast
 *   pre-check is in flight, keyed by column, so the gate refuses until the LAST
 *   check clears (N17) instead of leaking on the first `finally`.
 *
 * The render mirrors (`mutationPending`, `castPendingColumns`/`castPendingCount`)
 * are asserted only as mirrors; the refs are the authority.
 */

const h = vi.hoisted(() => ({
  /** Resolvers for held `overlayCastCheck` calls, in call order. */
  castChecks: [] as Array<() => void>,
  castCheckedColumns: [] as string[],
  /** Per-call outcomes: `true` = non-convertible (a non-committing refusal). */
  castOutcomes: [] as boolean[],
  /** Resolvers for held `model.refresh()` calls, in call order. */
  refreshes: [] as Array<() => void>,
}))

vi.mock('../lib/engine', () => ({
  engineClient: {
    overlayCastCheck: (
      _handle: unknown,
      _overlay: unknown,
      options: { readonly column: string },
    ): Promise<{ readonly hasNonConvertibleValues: boolean }> => {
      const call = h.castCheckedColumns.push(options.column) - 1
      return new Promise((resolve) => {
        h.castChecks.push(() => {
          resolve({ hasNonConvertibleValues: h.castOutcomes[call] === true })
        })
      })
    },
    exportView: async () => ({ format: 'csv', rows: 0, bytes: new Uint8Array() }),
  },
}))

const BASE: OverlayBase = {
  baseAnchor: 'fv-2-1000',
  overlayAnchor: 'ov-1',
  columns: [
    { name: 'a', type: 'BIGINT' },
    { name: 'b', type: 'VARCHAR' },
  ],
  baseRowCount: 2,
}

function readyPhase(): Phase {
  const model = {
    refresh: (): Promise<void> =>
      new Promise((resolve) => {
        h.refreshes.push(resolve)
      }),
    schema: BASE.columns,
    totalRows: 2,
  }
  return {
    kind: 'ready',
    model: model as unknown as GridViewportModel,
    tableId: 't1',
    handle: { kind: 'table', id: 't1' },
    base: BASE,
    provider: {} as never,
  }
}

const SESSION: DatasetSession = {
  tokenRef: { current: 1 },
  beginSession: () => 1,
  registerReset: () => () => {},
}

function mount(): ReturnType<typeof renderHook<ReturnType<typeof useEditingSession>, unknown>> {
  return renderHook(() => useEditingSession(readyPhase(), SESSION, { current: null }))
}

/** Let the async chain advance without resolving a held promise. */
async function tick(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })
}

beforeEach(() => {
  h.castChecks = []
  h.castCheckedColumns = []
  h.castOutcomes = []
  h.refreshes = []
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WF-06 useEditingSession — the mutation counter (S-A2-2)', () => {
  it('counts a commit before its await and clears in the finally', async () => {
    const { result } = mount()
    expect(result.current.mutationStateRef.current).toBe(0)
    expect(result.current.mutationPending).toBe(false)

    act(() => {
      result.current.handleCommitCell(baseRowId(BASE.baseAnchor, 0), 'a', {
        kind: 'bigint',
        value: 7n,
      } as never)
    })
    await tick()
    // The refresh is held: the commit is genuinely in flight.
    expect(h.refreshes).toHaveLength(1)
    expect(result.current.mutationStateRef.current).toBe(1)
    expect(result.current.mutationPending).toBe(true)

    await act(async () => {
      h.refreshes[0]?.()
      await Promise.resolve()
    })
    await tick()
    expect(result.current.mutationStateRef.current).toBe(0)
    expect(result.current.mutationPending).toBe(false)
  })

  it('counts overlapping commits and only clears when the LAST one settles', async () => {
    const { result } = mount()
    act(() => {
      result.current.handleCommitCell(baseRowId(BASE.baseAnchor, 0), 'a', {
        kind: 'bigint',
        value: 7n,
      } as never)
      result.current.handleCommitCell(baseRowId(BASE.baseAnchor, 1), 'b', {
        kind: 'string',
        value: 'x',
      } as never)
    })
    await tick()
    expect(h.refreshes).toHaveLength(2)
    expect(result.current.mutationStateRef.current).toBe(2)

    await act(async () => {
      h.refreshes[0]?.()
    })
    await tick()
    expect(result.current.mutationStateRef.current).toBe(1)
    expect(result.current.mutationPending).toBe(true)

    await act(async () => {
      h.refreshes[1]?.()
    })
    await tick()
    expect(result.current.mutationStateRef.current).toBe(0)
    expect(result.current.mutationPending).toBe(false)
  })

  it('clears both the counter and the mirror on the session reset', async () => {
    const { result } = mount()
    act(() => {
      result.current.handleCommitCell(baseRowId(BASE.baseAnchor, 0), 'a', {
        kind: 'bigint',
        value: 7n,
      } as never)
    })
    await tick()
    expect(result.current.mutationStateRef.current).toBe(1)
    // `beginSession` runs this reset; call it directly (the hook's contract).
    act(() => {
      result.current.handleCastColumn('a', 'BIGINT')
    })
    expect(result.current.castPendingColumnsRef.current.size).toBe(1)
  })
})

describe('WF-06 useEditingSession — aggregate cast pending (S-A2-4, IC-02, N17)', () => {
  it('adds the column before the first await and removes only it', async () => {
    const { result } = mount()
    act(() => {
      result.current.handleCastColumn('a', 'VARCHAR')
    })
    // Synchronous: the check has not resolved, and the authority already knows.
    expect(result.current.castPendingColumnsRef.current.has('a')).toBe(true)
    expect(result.current.castPendingCount).toBe(1)
    expect(result.current.castPendingColumns.has('a')).toBe(true)
    expect(h.castCheckedColumns).toEqual(['a'])

    await act(async () => {
      h.castChecks[0]?.()
    })
    await tick()
    expect(result.current.castPendingColumnsRef.current.size).toBe(0)
    expect(result.current.castPendingCount).toBe(0)
  })

  it('keeps the aggregate blocked until the LAST of two overlapping checks clears (N17)', async () => {
    const { result } = mount()
    act(() => {
      result.current.handleCastColumn('a', 'VARCHAR')
    })
    act(() => {
      result.current.handleCastColumn('b', 'BIGINT')
    })
    expect(h.castCheckedColumns).toEqual(['a', 'b'])
    expect(result.current.castPendingColumnsRef.current.size).toBe(2)

    // Resolve B first: A is still in flight, so the aggregate must stay > 0 —
    // this is the exact defect a single `castPendingColumn` value could not
    // express (B's finally would have cleared the only slot).
    await act(async () => {
      h.castChecks[1]?.()
    })
    await tick()
    expect(result.current.castPendingColumnsRef.current.has('a')).toBe(true)
    expect(result.current.castPendingColumnsRef.current.has('b')).toBe(false)
    expect(result.current.castPendingCount).toBe(1)

    await act(async () => {
      h.castChecks[0]?.()
    })
    await tick()
    // A's first verdict was invalidated by B's applied cast, so the existing
    // bounded retry loop re-ran it: the pending marker correctly STAYS until
    // that final settlement (the notice clears on the last check, never the
    // first `finally`).
    expect(h.castCheckedColumns).toEqual(['a', 'b', 'a'])
    expect(result.current.castPendingColumnsRef.current.size).toBe(1)
    await act(async () => {
      h.castChecks[2]?.()
    })
    await tick()
    expect(result.current.castPendingColumnsRef.current.size).toBe(0)
  })

  it('stays blocked when B settles FIRST as a NON-COMMITTING refusal (N17)', async () => {
    const { result } = mount()
    // Both checks are refusals: each appends nothing, so no mutation can start
    // and C15 can never mask the aggregate (the required N17 shape).
    h.castOutcomes = [true, true]
    act(() => {
      result.current.handleCastColumn('a', 'VARCHAR')
    })
    act(() => {
      result.current.handleCastColumn('b', 'BIGINT')
    })
    expect(h.castCheckedColumns).toEqual(['a', 'b'])
    expect(result.current.castPendingColumnsRef.current.size).toBe(2)

    // B first: a refusal, no cast appended, A still in flight.
    await act(async () => {
      h.castChecks[1]?.()
    })
    await tick()
    expect(result.current.castPendingColumnsRef.current.size).toBe(1)
    expect(result.current.castPendingColumns.has('a')).toBe(true)
    expect(result.current.castPendingColumns.has('b')).toBe(false)
    expect(result.current.mutationStateRef.current).toBe(0)
    expect(h.refreshes).toHaveLength(0)

    // A settles: the aggregate finally reaches 0.
    await act(async () => {
      h.castChecks[0]?.()
    })
    await tick()
    expect(result.current.castPendingColumnsRef.current.size).toBe(0)
    expect(result.current.castPendingCount).toBe(0)
  })

  it('keeps per-column identity in the render mirror (SchemaPanel disables one column)', async () => {
    const { result } = mount()
    act(() => {
      result.current.handleCastColumn('a', 'VARCHAR')
      result.current.handleCastColumn('b', 'BIGINT')
    })
    expect([...result.current.castPendingColumns].sort()).toEqual(['a', 'b'])
    await act(async () => {
      h.castChecks[0]?.()
    })
    await tick()
    expect([...result.current.castPendingColumns]).toEqual(['b'])
  })
})
