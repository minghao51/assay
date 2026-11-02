// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * CO-4 (ug-23) **render** pin: the decided plain-language gloss must reach the
 * surface the user actually reads, not just the pure function. `EditToolbar`
 * renders `pendingChangesSummary(...)` into `data-testid="pending-changes"`,
 * so this pins the rendered line for a `row-uninsert` operation — the term can
 * no longer silently regress to the overlay's `row expunge`.
 *
 * Reachability note (honest scope): no web session path emits `row-uninsert`
 * today — the op exists in `@assay/domain` (and on the overlay wire) but the
 * toolbar only inserts rows, so the app cannot currently display this kind.
 * The pin is written against the real component on purpose: when a producer
 * lands, the copy is already pinned. `pendingChangesSummary`'s own unit pins
 * (`op-summary.test.ts`) cover the remaining kinds.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { EditOp } from '@assay/domain'
import { insertRowId } from '@assay/domain'
import { EditToolbar } from './EditToolbar'
import { pendingChangesSummary } from './op-summary'

afterEach(cleanup)

const uninsert: EditOp = { kind: 'row-uninsert', rowId: insertRowId('ov-1', 0) }

function renderSummary(ops: readonly EditOp[]): string {
  render(
    <EditToolbar onInsertRow={() => {}} pendingSummary={pendingChangesSummary(ops)} error={null} />,
  )
  return screen.getByTestId('pending-changes').textContent ?? ''
}

describe('EditToolbar pending summary — CO-4 (ug-23) gloss', () => {
  it('renders a row-uninsert as `undo row insert`, never `row expunge`', () => {
    expect(renderSummary([uninsert])).toBe('1 pending change: 1 undo row insert.')
  })

  it('renders the plural form and never leaks overlay vocabulary into the toolbar', () => {
    expect(renderSummary([uninsert, uninsert])).toBe('2 pending changes: 2 undo row inserts.')
    // Whole toolbar surface, not just the summary span: the domain term must not
    // reappear anywhere in the editing line the user reads.
    expect(screen.getByTestId('edit-toolbar').textContent ?? '').not.toMatch(/expunge/i)
  })
})
