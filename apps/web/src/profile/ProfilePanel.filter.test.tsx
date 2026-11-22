// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { ProfilePanel } from './ProfilePanel'

/**
 * ug-16 click-to-act component pins. The panel owns the affordances and the
 * refusal/error slots; App owns resolution + compilation + `setFilters`, so the
 * exact predicate handed to the model is pinned in
 * `App.profile-filter.test.tsx`. Here:
 *
 * 1. top-k rows and the null count are real `<button>` controls with
 *    accessible names naming the column and the action, and they report the
 *    profile's BASE column name (resolution happens in App, never here);
 * 2. the refusal slot is a single-line `role="status"`, byte-exact, additive —
 *    it never displaces the R-16 hint/note or the idle `profile-table-id`;
 * 3. the engine-rejection slot keeps the framed `filter` copy as an alert;
 * 4. a profile re-run clears the feedback (App also clears on click/undo/new
 *    data);
 * 5. the chart's existing `role="img"` text alternative is intact.
 *
 * Copy is pinned as literals, never imported from the component.
 */

const HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }

const RENAMED =
  'This column is now "nation" in the edited view. The profile still uses the file\'s original name, "country" — use "nation" in Filters instead.'

const PROFILE = {
  rowCount: 5,
  columns: [
    {
      name: 'country',
      type: 'VARCHAR',
      kind: 'categorical' as const,
      nullCount: 0,
      distinctCount: 3,
      categorical: {
        topK: [
          { value: 'SG', count: 2 },
          { value: 'US', count: 2 },
          { value: 'DE', count: 1 },
        ],
      },
    },
    {
      name: 'income',
      type: 'BIGINT',
      kind: 'numeric' as const,
      nullCount: 1,
      distinctCount: 4,
      numeric: {
        min: 48000,
        max: 75000,
        mean: 62875,
        stddev: 11972.2,
        quantiles: { p50: 56500, p90: 70800, p95: 72900, p99: 74580 },
      },
    },
  ],
}

const h = vi.hoisted(() => ({ profile: vi.fn() }))

vi.mock('../lib/engine', () => ({
  engineClient: { profile: h.profile },
}))

const NOOP_PROPS = {
  onFilterValue: () => undefined,
  onFilterNull: () => undefined,
  filterRefusal: null,
  filterError: null,
  filterPending: false,
  onClearFilterFeedback: () => undefined,
} as const

type Props = Partial<ComponentProps<typeof ProfilePanel>>

async function renderDone(overrides: Props = {}): Promise<void> {
  h.profile.mockResolvedValue(PROFILE)
  render(<ProfilePanel handle={HANDLE} stagedCount={0} {...NOOP_PROPS} {...overrides} />)
  fireEvent.click(screen.getByTestId('profile-toggle'))
  fireEvent.click(screen.getByTestId('profile-run'))
  await screen.findByTestId('profile-rowcount')
}

function column(name: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="profile-column"][data-col-name="${name}"]`,
  )
  if (element === null) throw new Error(`missing profile column ${name}`)
  return element
}

afterEach(cleanup)
beforeEach(() => {
  h.profile.mockReset()
})

describe('ug-16 — profile statistics are real controls', () => {
  it('renders each top-k row as a button naming the column and value, and reports the base column', async () => {
    const onFilterValue = vi.fn()
    await renderDone({ onFilterValue })

    const chart = within(column('country'))
    const sg = chart.getByRole('button', { name: 'Filter country to SG' })
    expect(sg.tagName).toBe('BUTTON')
    // Native buttons are keyboard reachable without a custom tabIndex.
    expect(sg.getAttribute('tabindex')).toBeNull()

    fireEvent.click(sg)
    expect(onFilterValue).toHaveBeenCalledTimes(1)
    // The BASE column name (the profile is base-derived); App resolves it.
    expect(onFilterValue).toHaveBeenCalledWith('country', 'SG')
  })

  it('renders the null count as a button naming the column and the null action', async () => {
    const onFilterNull = vi.fn()
    await renderDone({ onFilterNull })

    const income = within(column('income'))
    const nullCount = income.getByRole('button', { name: 'Filter income where null' })
    expect(nullCount.tagName).toBe('BUTTON')
    expect(nullCount.textContent).toBe('1')

    fireEvent.click(nullCount)
    expect(onFilterNull).toHaveBeenCalledTimes(1)
    expect(onFilterNull).toHaveBeenCalledWith('income')
  })

  it('keeps the chart’s role="img" text alternative and per-bar titles intact', async () => {
    await renderDone()

    const chart = within(column('country'))
    expect(
      chart.getByRole('img', {
        name: 'Bar chart of top values in column country: SG 2, US 2, DE 1 (3 of 3 distinct non-null values shown)',
      }),
    ).toBeTruthy()
    expect(chart.getAllByTestId('profile-topk-row')).toHaveLength(3)
    expect(chart.getByTestId('profile-topk-caption').textContent).toBe(
      'Top 3 of 3 distinct non-null values',
    )
  })

  it('does not call either bridge merely by rendering results', async () => {
    const onFilterValue = vi.fn()
    const onFilterNull = vi.fn()
    await renderDone({ onFilterValue, onFilterNull })

    expect(onFilterValue).not.toHaveBeenCalled()
    expect(onFilterNull).not.toHaveBeenCalled()
  })

  it('disables every filter control while an apply is in flight, names unchanged', async () => {
    const onFilterValue = vi.fn()
    const onFilterNull = vi.fn()
    await renderDone({ onFilterValue, onFilterNull, filterPending: true })

    const country = within(column('country'))
    const income = within(column('income'))
    const sg = country.getByRole('button', { name: 'Filter country to SG' }) as HTMLButtonElement
    const us = country.getByRole('button', { name: 'Filter country to US' }) as HTMLButtonElement
    const nullCount = income.getByRole('button', {
      name: 'Filter income where null',
    }) as HTMLButtonElement

    // Real native `disabled` (the FilterBar `pending` posture), not a custom
    // guard: the accessible names are the same, the controls just cannot start
    // a second attempt whose list an earlier rollback could supersede.
    expect(sg.disabled).toBe(true)
    expect(us.disabled).toBe(true)
    expect(nullCount.disabled).toBe(true)

    fireEvent.click(sg)
    fireEvent.click(nullCount)
    expect(onFilterValue).not.toHaveBeenCalled()
    expect(onFilterNull).not.toHaveBeenCalled()
  })

  it('re-enables the filter controls once the apply settles', async () => {
    h.profile.mockResolvedValue(PROFILE)
    const { rerender } = render(
      <ProfilePanel handle={HANDLE} stagedCount={0} {...NOOP_PROPS} filterPending />,
    )
    fireEvent.click(screen.getByTestId('profile-toggle'))
    fireEvent.click(screen.getByTestId('profile-run'))
    await screen.findByTestId('profile-rowcount')

    const button = (): HTMLButtonElement =>
      within(column('country')).getByRole('button', {
        name: 'Filter country to SG',
      }) as HTMLButtonElement
    expect(button().disabled).toBe(true)

    // The apply settled: App flips the pending prop, the same control is live.
    rerender(<ProfilePanel handle={HANDLE} stagedCount={0} {...NOOP_PROPS} filterPending={false} />)
    expect(button().disabled).toBe(false)
  })
})

describe('ug-16 — refusal and engine-rejection slots', () => {
  it('renders the byte-exact renamed refusal as a single-line status without displacing R-16 pins', async () => {
    await renderDone({ stagedCount: 1, filterRefusal: RENAMED })

    const refusal = screen.getByTestId('profile-filter-refusal')
    expect(refusal.getAttribute('role')).toBe('status')
    expect(refusal.textContent).toBe(RENAMED)
    expect(refusal.textContent).not.toMatch(/\r|\n/)
    expect(refusal.textContent).not.toContain('1 staged change')
    // Additive: the R-16 hint/note and the idle element's results-time body
    // survive, and the refusal sits inside the panel region.
    expect(screen.getByTestId('profile-standing-hint').textContent).toBe(
      'Statistics describe the file as opened — staged changes are not included.',
    )
    expect(screen.getByTestId('profile-staged-note').textContent).toBe(
      '1 staged change is not reflected here — the grid uses the edited view. Validation must be run explicitly against the edited view.',
    )
    expect(screen.getByTestId('profile-panel').contains(refusal)).toBe(true)
    expect(screen.getByTestId('profile-rowcount-value').textContent).toBe('5')
  })

  it('keeps the idle profile-table-id and the refusal slot independent', async () => {
    render(<ProfilePanel handle={HANDLE} stagedCount={0} {...NOOP_PROPS} filterRefusal={RENAMED} />)
    fireEvent.click(screen.getByTestId('profile-toggle'))

    expect(screen.getByTestId('profile-table-id').textContent).toBe(HANDLE.id)
    expect(screen.getByTestId('profile-filter-refusal').textContent).toBe(RENAMED)
    expect(screen.getByTestId('profile-standing-hint').textContent).toBe(
      'Statistics describe the file as opened — staged changes are not included.',
    )
  })

  it('renders the framed engine rejection as a separate alert (never in the value-free refusal slot)', async () => {
    await renderDone({
      filterError:
        'The filter could not be applied: engine unavailable. The previous filters are still in effect.',
    })

    const error = screen.getByTestId('profile-filter-error')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toBe(
      'The filter could not be applied: engine unavailable. The previous filters are still in effect.',
    )
    expect(screen.queryByTestId('profile-filter-refusal')).toBeNull()
  })

  it('clears the feedback when the profile is re-run', async () => {
    const onClearFilterFeedback = vi.fn()
    h.profile.mockResolvedValue(PROFILE)
    render(
      <ProfilePanel
        handle={HANDLE}
        stagedCount={0}
        {...NOOP_PROPS}
        filterRefusal={RENAMED}
        onClearFilterFeedback={onClearFilterFeedback}
      />,
    )
    fireEvent.click(screen.getByTestId('profile-toggle'))

    fireEvent.click(screen.getByTestId('profile-run'))
    expect(onClearFilterFeedback).toHaveBeenCalledTimes(1)
  })
})

/**
 * C02 parity / A3 (spec §3/§4): the panel renders the phase's ONE recovery
 * control beside its existing alert — the filter bar's exact elements and
 * classes, no new CSS, no new live region, and the sentence byte-identical.
 * The panel only reports the kind; App owns the dispatch and its guards.
 */
describe('C02 parity — the recovery control beside the filter alert', () => {
  const RELOAD =
    'The filters were applied, but the grid could not be reloaded. Retry to reload the view.'
  const RESTORE =
    'The filter could not be applied and the previous filters could not be restored. The filters now in effect are unknown: clear the filters or re-apply one to recover.'

  it('renders exactly one Retry button for a retry recovery and reports the kind', async () => {
    const onFilterRecover = vi.fn()
    await renderDone({
      filterError: RELOAD,
      filterRecovery: { kind: 'retry' },
      onFilterRecover,
    })

    const retries = screen.getAllByRole('button', { name: 'Retry' })
    expect(retries).toHaveLength(1)
    const retry = retries[0] as HTMLButtonElement
    expect(retry.tagName).toBe('BUTTON')
    expect(retry.getAttribute('type')).toBe('button')
    // The bar's own class — no new CSS, and the shared affordance looks alike.
    expect(retry.className).toBe('filter-error-retry')
    // The alert is unchanged: same sentence, same role.
    expect(screen.getByTestId('profile-filter-error').textContent).toBe(RELOAD)
    expect(screen.getByTestId('profile-filter-error').getAttribute('role')).toBe('alert')
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()

    fireEvent.click(retry)
    expect(onFilterRecover).toHaveBeenCalledTimes(1)
    expect(onFilterRecover).toHaveBeenCalledWith({ kind: 'retry' })
  })

  it('renders Clear filters for a clear recovery and reports the kind', async () => {
    const onFilterRecover = vi.fn()
    await renderDone({
      filterError: RESTORE,
      filterRecovery: { kind: 'clear' },
      onFilterRecover,
    })

    const clear = screen.getByRole('button', { name: 'Clear filters' }) as HTMLButtonElement
    expect(clear.getAttribute('type')).toBe('button')
    expect(clear.className).toBe('filter-error-clear')
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.getByTestId('profile-filter-error').textContent).toBe(RESTORE)
    expect(screen.getByTestId('profile-filter-error').getAttribute('role')).toBe('alert')

    fireEvent.click(clear)
    expect(onFilterRecover).toHaveBeenCalledTimes(1)
    expect(onFilterRecover).toHaveBeenCalledWith({ kind: 'clear' })
  })

  it('renders no recovery control when the phase offers none, alert unchanged', async () => {
    const onFilterRecover = vi.fn()
    await renderDone({ filterError: RELOAD, filterRecovery: null, onFilterRecover })

    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
    expect(screen.getByTestId('profile-filter-error').textContent).toBe(RELOAD)
    expect(onFilterRecover).not.toHaveBeenCalled()
  })
})
