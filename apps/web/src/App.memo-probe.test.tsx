// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * f-2 render-count probe (the q-1 count-based pattern): the four panel
 * boundaries must be **real** `React.memo` boundaries, not just stable props.
 *
 * Design. The panel implementations are mocked with counting stubs so a real
 * render of the sheet is observable, while the **production** memo wrappers
 * stay in place: `App.tsx` memoizes `SchemaPanel`/`RecordInspector` at the
 * composition root and `lib/bottom-panels.ts` memoizes the lazy
 * `ValidationPanel`/`DiffPanel` at the chunk seam. A stub that is not
 * re-invoked proves React bailed at the memo boundary. The stubs ignore
 * props and return `null` — only the invocation count is asserted, so this
 * file pins the boundary, not panel internals (those keep their own suites).
 *
 * Traces:
 * 1. **Edit commit** (Insert row → the editing session's history +
 *    `overlayRevision` move): the schema/validation/diff panels consume none
 *    of that state, so their counts must not move; the record inspector
 *    consumes `overlayRevision` (the m4-3 freshness signal), so it MUST
 *    re-render.
 * 2. **Unrelated App-local state** (open the export dialog): nothing any
 *    panel receives changes, so all four counts must hold — this is what
 *    catches an unstable `onClosed` inline closure (an unstable prop would
 *    force the inspector to re-render despite the memo).
 *
 * Non-vacuity (mutation-drilled in the task report): dropping any memo
 * wrapper, reverting `useStableColumns` (the schema array is re-projected on
 * every `model.refresh()`), reverting either lazy-session handler's
 * overlay-revision ref, or restoring the inspector's inline `onClosed` all
 * move a count the test asserts is frozen.
 */

/** Panel render counters shared with the hoisted mock factories. */
const h = vi.hoisted(() => ({
  renders: { schema: 0, validation: 0, diff: 0, inspector: 0 },
}))

const FAKE_HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }
const FAKE_SCHEMA: readonly { name: string; type: string }[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'country', type: 'VARCHAR' },
]

function fakeBaseBatch(): ArrowTableLike {
  const columns = [{ get: () => 'base:fv-1:0' }, { get: () => 1 }, { get: () => 'SG' }]
  return {
    numRows: 1,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
  }
}

/** One overlay row (id column + the base columns) for the post-edit read. */
function fakeOverlayBatch(): ArrowTableLike {
  const columns = [{ get: () => 'base:fv-1:0' }, { get: () => 1 }, { get: () => 'SG' }]
  return {
    numRows: 1,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
  }
}

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } }> => ({
    source: { getFile: async () => new File(['id\n1\n'], 'memo-probe.jsonl') },
  }),
}))

vi.mock('./lib/engine', () => ({
  engineClient: {
    open: async () => FAKE_HANDLE,
    schema: async () => FAKE_SCHEMA,
    rowCount: async () => 1,
    fetchRange: async () => ({ batch: fakeBaseBatch(), hasMore: false }),
    // Every `model.refresh()` (an edit commit) re-reads the effective schema
    // through the overlay surface. Returning a FRESH array each call is the
    // real provider behavior (`DuckDbGridProvider.schema()` maps) and is what
    // `useStableColumns` must neutralize for the memo to hold.
    overlaySchema: async () => FAKE_SCHEMA.map((column) => ({ ...column })),
    overlayRowCount: async () => 1,
    fetchOverlayRange: async () => ({ batch: fakeOverlayBatch(), hasMore: false }),
    dispose: async () => {},
  },
}))

vi.mock('./schema/SchemaPanel', () => ({
  SchemaPanel: () => {
    h.renders.schema += 1
    return null
  },
}))
vi.mock('./record/RecordInspector', () => ({
  RecordInspector: () => {
    h.renders.inspector += 1
    return null
  },
}))
vi.mock('./validation/ValidationPanel', () => ({
  ValidationPanel: () => {
    h.renders.validation += 1
    return null
  },
}))
vi.mock('./diff/DiffPanel', () => ({
  DiffPanel: () => {
    h.renders.diff += 1
    return null
  },
}))
vi.mock('./sql/SqlPanel', () => ({ SqlPanel: () => null }))
vi.mock('./profile/ProfilePanel', () => ({ ProfilePanel: () => null }))

afterEach(() => {
  cleanup()
  h.renders.schema = 0
  h.renders.validation = 0
  h.renders.diff = 0
  h.renders.inspector = 0
})

async function openReady(): Promise<void> {
  render(<App />)
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('edit-toolbar')
  expect(screen.getByTestId('open-status').textContent).toBe('ready')
}

describe('f-2 memoized panel boundaries', () => {
  it('an edit commit re-renders only the panel that consumes the changed state', async () => {
    await openReady()
    const before = { ...h.renders }
    // The open flow itself must have mounted every panel exactly once.
    expect(before.schema).toBe(1)
    expect(before.validation).toBe(1)
    expect(before.diff).toBe(1)
    expect(before.inspector).toBe(1)

    // Edit-commit trace: an insert moves the editing history + overlay
    // revision and re-projects the effective schema through a fresh epoch.
    await act(async () => {
      fireEvent.click(screen.getByTestId('edit-insert-row'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('pending-changes').textContent).toContain('1 pending change')
    })

    // The panels that consume none of that state bail at their memo
    // boundaries; their props stayed referentially stable.
    expect(h.renders.schema).toBe(before.schema)
    expect(h.renders.validation).toBe(before.validation)
    expect(h.renders.diff).toBe(before.diff)
    // The inspector consumes `overlayRevision` (the m4-3 freshness signal),
    // so it must re-render — memo must not swallow this.
    expect(h.renders.inspector).toBeGreaterThan(before.inspector)
  })

  it('unrelated App-local state (export dialog) re-renders no panel', async () => {
    await openReady()
    const before = { ...h.renders }

    await act(async () => {
      fireEvent.click(screen.getByTestId('export-open'))
    })
    expect(screen.getByTestId('export-open')).toBeTruthy()

    // Nothing any panel receives changed; in particular the inspector's
    // `onClosed` must be a stable callback, not a per-render closure.
    expect(h.renders.schema).toBe(before.schema)
    expect(h.renders.validation).toBe(before.validation)
    expect(h.renders.diff).toBe(before.diff)
    expect(h.renders.inspector).toBe(before.inspector)
  })
})
