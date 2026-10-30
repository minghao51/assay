// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * R-16 (ug-10) wiring pins through the REAL App composition root with only the
 * picker/engine boundaries faked (the `App.column-ops` posture). The real
 * `ProfilePanel` is loaded through `preloadBottomPanels`, so these tests prove
 * the `stagedCount` prop is actually wired — not just that the panel accepts
 * one:
 *
 * 1. staging a rename through the real editing path makes the singular note
 *    appear, panel Undo removes it, and the idle `profile-table-id` element
 *    survives throughout;
 * 2. with results displayed, staging an edit neither flips the panel out of
 *    `done` nor issues another `engine/profile` request — the panel only adds
 *    the note (no stale banner, no auto-recompute).
 *
 * Copy is byte-pinned as literals, never imported from the component.
 */

const NOTE_ONE =
  '1 staged change is not reflected here — the grid uses the edited view. Validation must be run explicitly against the edited view.'

const FAKE_HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }

const FAKE_SCHEMA: readonly { name: string; type: string }[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'country', type: 'VARCHAR' },
  { name: 'income', type: 'BIGINT' },
]

const FAKE_PROFILE = {
  rowCount: 1,
  columns: [{ name: 'id', type: 'BIGINT', kind: 'other' as const, nullCount: 0, distinctCount: 1 }],
}

const h = vi.hoisted(() => ({ profile: vi.fn() }))

function fakeBaseBatch(): ArrowTableLike {
  const columns = [{ get: () => 1 }, { get: () => 'SG' }, { get: () => 52000 }]
  return {
    numRows: 1,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
  }
}

function fakeOverlayBatch(columnCount: number): ArrowTableLike {
  const columns = [
    { get: () => 'base:fv-1:0' },
    ...Array.from({ length: columnCount }, () => ({ get: () => null })),
  ]
  return {
    numRows: 1,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
  }
}

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } }> => ({
    source: { getFile: async () => new File(['id\n1\n'], 'r16.jsonl') },
  }),
}))

vi.mock('./lib/engine', () => {
  interface OverlayOp {
    readonly kind: string
    readonly from?: string
    readonly to?: string
  }
  interface Overlay {
    readonly base: unknown
    readonly ops?: readonly OverlayOp[]
  }
  const effectiveSchema = (overlay: Overlay): { name: string; type: string }[] => {
    let columns = FAKE_SCHEMA.map((column) => ({ ...column }))
    for (const op of overlay.ops ?? []) {
      if (op.kind === 'column-rename' && op.from !== undefined && op.to !== undefined) {
        columns = columns.map((column) =>
          column.name === op.from ? { name: op.to as string, type: column.type } : column,
        )
      }
    }
    return columns
  }
  return {
    engineClient: {
      open: async () => FAKE_HANDLE,
      schema: async () => FAKE_SCHEMA,
      rowCount: async () => 1,
      fetchRange: async () => ({ batch: fakeBaseBatch(), hasMore: false }),
      overlaySchema: async (_handle: unknown, overlay: Overlay) => effectiveSchema(overlay),
      overlayRowCount: async () => 1,
      fetchOverlayRange: async (_handle: unknown, overlay: Overlay) => ({
        batch: fakeOverlayBatch(effectiveSchema(overlay).length),
        hasMore: false,
      }),
      profile: h.profile,
    },
  }
})

afterEach(cleanup)
beforeEach(() => {
  h.profile.mockReset()
  h.profile.mockResolvedValue(FAKE_PROFILE)
})

async function openFixture(): Promise<void> {
  render(<App />)
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('schema-section')
  expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
}

function expandProfile(): void {
  fireEvent.click(screen.getByTestId('profile-toggle'))
  expect(screen.getByTestId('profile-toggle').getAttribute('aria-expanded')).toBe('true')
}

async function renameCountry(to: string): Promise<void> {
  const panel = within(screen.getByTestId('schema-panel'))
  await act(async () => {
    fireEvent.click(panel.getByRole('button', { name: 'Rename column country' }))
  })
  const input = panel.getByTestId('column-rename-input')
  await act(async () => {
    fireEvent.change(input, { target: { value: to } })
    fireEvent.keyDown(input, { key: 'Enter' })
  })
}

describe('R-16 — App wiring (real edit history → profile panel)', () => {
  it('shows the singular note after a staged edit, removes it on undo, and keeps the idle table id', async () => {
    await openFixture()
    expandProfile()

    // Idle, zero ops: the standing hint is present, the note is not.
    expect(screen.getByTestId('profile-table-id').textContent).toBe(FAKE_HANDLE.id)
    expect(screen.getByTestId('profile-standing-hint').textContent).toBe(
      'Statistics describe the file as opened — staged changes are not included.',
    )
    expect(screen.queryByTestId('profile-staged-note')).toBeNull()

    await renameCountry('nation')

    expect(screen.getByTestId('profile-staged-note').textContent).toBe(NOTE_ONE)
    // The idle body (and its e2e-read element) is not displaced by the copy.
    expect(screen.getByTestId('profile-table-id').textContent).toBe(FAKE_HANDLE.id)

    await act(async () => {
      fireEvent.click(screen.getByTestId('history-undo'))
    })

    expect(screen.queryByTestId('profile-staged-note')).toBeNull()
    expect(screen.getByTestId('profile-standing-hint').textContent).toBe(
      'Statistics describe the file as opened — staged changes are not included.',
    )
    expect(screen.getByTestId('profile-table-id').textContent).toBe(FAKE_HANDLE.id)
  })

  it('does not flip results or request another profile when an edit is staged', async () => {
    await openFixture()
    expandProfile()

    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-run'))
    })
    await screen.findByTestId('profile-rowcount')
    expect(screen.getByTestId('profile-section').getAttribute('data-state')).toBe('done')
    expect(h.profile).toHaveBeenCalledTimes(1)

    await renameCountry('nation')

    // No auto-recompute: results stay displayed, the request count is unchanged,
    // and the panel simply adds the honest note.
    expect(h.profile).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('profile-section').getAttribute('data-state')).toBe('done')
    expect(screen.getByTestId('profile-rowcount').textContent).toContain('1')
    expect(screen.getByTestId('profile-staged-note').textContent).toBe(NOTE_ONE)
    expect(screen.queryByRole('button', { name: /re-?run/i })).toBeNull()
    expect(screen.getByTestId('profile-panel').textContent).not.toMatch(/stale/i)
  })
})
