// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { ProfilePanel } from './ProfilePanel'

/**
 * R-16 (ug-10) honesty pins — the panel labels what the numbers are and are
 * not, with byte-exact copy (em dash included):
 *
 * 1. the standing hint renders in EVERY expanded state (idle/zero, running,
 *    error, results) and never displaces the idle `profile-table-id` element
 *    that tests/e2e/profile-panel.spec.ts reads;
 * 2. the staged-changes note renders only while the active history has >= 1
 *    operation, with singular/plural grammar, and disappears on undo-to-0
 *    (the hint stays). A net-zero history (cast-then-revert) still counts as
 *    N>0 and the copy says "not reflected here", never "differs";
 * 3. no stale/re-run banner or edit-aware re-run copy exists in the panel —
 *    the file is immutable per session (ADR 0012) and re-running could not
 *    include staged edits.
 *
 * The strings below are deliberately literals, not imports from the
 * component: that is what makes them byte pins.
 */

const HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }

const FILTER_PROPS = {
  onFilterValue: () => undefined,
  onFilterNull: () => undefined,
  filterRefusal: null,
  filterError: null,
  filterPending: false,
  onClearFilterFeedback: () => undefined,
} as const

const HINT = 'Statistics describe the file as opened — staged changes are not included.'
const NOTE_ONE =
  '1 staged change is not reflected here — the grid uses the edited view. Validation must be run explicitly against the edited view.'
const NOTE_THREE =
  '3 staged changes are not reflected here — the grid uses the edited view. Validation must be run explicitly against the edited view.'

const PROFILE = {
  rowCount: 5,
  columns: [{ name: 'id', type: 'BIGINT', kind: 'other' as const, nullCount: 0, distinctCount: 5 }],
}

const h = vi.hoisted(() => ({ profile: vi.fn() }))

vi.mock('../lib/engine', () => ({
  engineClient: { profile: h.profile },
}))

type Mode = 'idle' | 'running' | 'error' | 'done'

async function renderState(mode: Mode, stagedCount: number): Promise<void> {
  if (mode === 'running') h.profile.mockReturnValue(new Promise(() => undefined))
  if (mode === 'error') h.profile.mockRejectedValue(new Error('engine down'))
  if (mode === 'done') h.profile.mockResolvedValue(PROFILE)

  render(<ProfilePanel handle={HANDLE} stagedCount={stagedCount} {...FILTER_PROPS} />)
  fireEvent.click(screen.getByTestId('profile-toggle'))
  expect(screen.getByTestId('profile-toggle').getAttribute('aria-expanded')).toBe('true')
  if (mode !== 'idle') fireEvent.click(screen.getByTestId('profile-run'))

  if (mode === 'running') await screen.findByTestId('profile-running')
  if (mode === 'error') await screen.findByTestId('profile-error')
  if (mode === 'done') await screen.findByTestId('profile-rowcount')
}

afterEach(cleanup)
beforeEach(() => {
  h.profile.mockReset()
})

describe('R-16 — standing hint in every expanded state', () => {
  for (const mode of ['idle', 'running', 'error', 'done'] as const) {
    it(`renders the byte-exact hint in the ${mode} state`, async () => {
      await renderState(mode, 0)

      expect(screen.getByTestId('profile-section').getAttribute('data-state')).toBe(mode)
      expect(screen.getByTestId('profile-standing-hint').textContent).toBe(HINT)
      // N=0: the hint stands alone; no note is invented.
      expect(screen.queryByTestId('profile-staged-note')).toBeNull()
    })
  }

  it('keeps the idle explanatory paragraph and its profile-table-id element', async () => {
    await renderState('idle', 0)

    expect(screen.getByTestId('profile-hint').textContent).toContain(
      'Compute per-column statistics',
    )
    expect(screen.getByTestId('profile-table-id').textContent).toBe(HANDLE.id)
    // The hint is additive: it does not replace the existing idle copy.
    expect(screen.getByTestId('profile-run')).toBeTruthy()
  })

  it('renders the note in every expanded state while ops are staged', async () => {
    for (const mode of ['idle', 'running', 'error', 'done'] as const) {
      h.profile.mockReset()
      await renderState(mode, 3)
      expect(screen.getByTestId('profile-staged-note').textContent).toBe(NOTE_THREE)
      cleanup()
    }
  })
})

describe('R-16 — staged-changes note at 0/1/N', () => {
  it('omits the note at N=0 while the hint remains', async () => {
    await renderState('idle', 0)

    expect(screen.queryByTestId('profile-staged-note')).toBeNull()
    expect(screen.getByTestId('profile-standing-hint').textContent).toBe(HINT)
  })

  it('uses singular grammar at N=1', async () => {
    await renderState('idle', 1)

    expect(screen.getByTestId('profile-staged-note').textContent).toBe(NOTE_ONE)
  })

  it('uses plural grammar at N=3', async () => {
    await renderState('done', 3)

    expect(screen.getByTestId('profile-staged-note').textContent).toBe(NOTE_THREE)
    // The note sits inside the panel, not anywhere else in the document.
    expect(
      screen.getByTestId('profile-panel').contains(screen.getByTestId('profile-staged-note')),
    ).toBe(true)
  })

  it('removes the note when undo/redo returns the active history to 0', async () => {
    const { rerender } = render(<ProfilePanel handle={HANDLE} stagedCount={1} {...FILTER_PROPS} />)
    fireEvent.click(screen.getByTestId('profile-toggle'))
    expect(screen.getByTestId('profile-staged-note').textContent).toBe(NOTE_ONE)

    rerender(<ProfilePanel handle={HANDLE} stagedCount={0} {...FILTER_PROPS} />)
    expect(screen.queryByTestId('profile-staged-note')).toBeNull()
    expect(screen.getByTestId('profile-standing-hint').textContent).toBe(HINT)

    rerender(<ProfilePanel handle={HANDLE} stagedCount={1} {...FILTER_PROPS} />)
    expect(screen.getByTestId('profile-staged-note').textContent).toBe(NOTE_ONE)

    rerender(<ProfilePanel handle={HANDLE} stagedCount={0} {...FILTER_PROPS} />)
    expect(screen.queryByTestId('profile-staged-note')).toBeNull()
    expect(screen.getByTestId('profile-standing-hint').textContent).toBe(HINT)
  })

  it('keeps the note for a net-zero history (cast-then-revert) and never claims divergence', async () => {
    // Two active entries whose net effect equals base: N is the active-entry
    // count, not a difference measure — the copy stays true.
    await renderState('idle', 2)

    const note = screen.getByTestId('profile-staged-note').textContent ?? ''
    expect(note).toBe(
      '2 staged changes are not reflected here — the grid uses the edited view. Validation must be run explicitly against the edited view.',
    )
    expect(note).toContain('not reflected here')
    expect(note).not.toMatch(/differ|diverg|stale/i)
  })
})

describe('R-16 — no stale/re-run contract', () => {
  it('never renders stale/re-run copy in any state', async () => {
    for (const mode of ['idle', 'running', 'error', 'done'] as const) {
      h.profile.mockReset()
      await renderState(mode, 2)
      const text = screen.getByTestId('profile-panel').textContent ?? ''
      expect(text).not.toMatch(/stale/i)
      expect(text).not.toMatch(/re-?run(ning)?|recompute/i)
      // The only controls remain the idle trigger and the error retry.
      expect(screen.queryByRole('button', { name: /re-?run/i })).toBeNull()
      cleanup()
    }
  })

  it('source pin: the panel ships no "Profile is stale" banner and no re-run copy', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'apps', 'web', 'src', 'profile', 'ProfilePanel.tsx'),
      'utf8',
    )
    expect(source).not.toContain('Profile is stale')
    expect(source).not.toMatch(/\bre-?run(ning)?\b/i)
  })
})
