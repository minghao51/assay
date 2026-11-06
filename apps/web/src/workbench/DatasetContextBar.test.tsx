// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DatasetContextBar } from './DatasetContextBar'
import type { NextAction } from './next-action'

const OK: NextAction = {
  kind: 'export',
  state: 'Verdict is current — no violations',
  action: 'Export a copy…',
  tone: 'ok',
  secondaryReview: false,
}

function renderBar(overrides: Partial<React.ComponentProps<typeof DatasetContextBar>> = {}) {
  const onAction = vi.fn()
  const onSecondaryReview = vi.fn()
  const onBackToFindings = vi.fn()
  render(
    <DatasetContextBar
      rows={12}
      columns={10}
      stagedOperations={1}
      next={OK}
      onAction={onAction}
      onSecondaryReview={onSecondaryReview}
      jumpOrigin={false}
      onBackToFindings={onBackToFindings}
      {...overrides}
    />,
  )
  return { onAction, onSecondaryReview, onBackToFindings }
}

afterEach(cleanup)

describe('DatasetContextBar — neutral facts', () => {
  it('names the current dataset view, counts and staged operations', () => {
    renderBar()
    expect(screen.getByText('Current dataset view')).toBeTruthy()
    expect(screen.getByTestId('context-rows').textContent).toBe('12 rows × 10 columns')
    expect(screen.getByTestId('context-staged').textContent).toBe('1 staged operation')
  })

  it('pluralizes rows, columns and staged operations honestly', () => {
    renderBar({ rows: 1, columns: 1, stagedOperations: 0 })
    expect(screen.getByTestId('context-rows').textContent).toBe('1 row × 1 column')
    expect(screen.getByTestId('context-staged').textContent).toBe('No staged operations')
  })

  it('never renders a filename', () => {
    const { container } = render(
      <DatasetContextBar
        rows={12}
        columns={10}
        stagedOperations={0}
        next={OK}
        onAction={() => undefined}
        onSecondaryReview={() => undefined}
        jumpOrigin={false}
        onBackToFindings={() => undefined}
      />,
    )
    expect(container.textContent).not.toMatch(/\.(parquet|csv|jsonl|json)\b/i)
  })
})

describe('DatasetContextBar — one action and one status', () => {
  it('renders the state as a polite status and the action as a button', () => {
    renderBar()
    const state = screen.getByTestId('context-state')
    expect(state.getAttribute('role')).toBe('status')
    expect(state.textContent).toBe('Verdict is current — no violations')
    expect(screen.getByTestId('context-action').textContent).toBe('Export a copy…')
    expect(screen.queryByTestId('context-review')).toBeNull()
  })

  it('calls the existing handler exactly once', () => {
    const { onAction } = renderBar()
    fireEvent.click(screen.getByTestId('context-action'))
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('offers the secondary review only for the stale verdict', () => {
    const stale: NextAction = {
      kind: 'validate',
      state: 'Verdict stale — the session’s staged state changed after it was computed',
      action: 'Recheck',
      tone: 'stale',
      secondaryReview: true,
    }
    const { onSecondaryReview } = renderBar({ next: stale })
    const review = screen.getByTestId('context-review')
    expect(review.textContent).toBe('Review findings')
    fireEvent.click(review)
    expect(onSecondaryReview).toHaveBeenCalledTimes(1)
  })

  it('marks the tone on the state only', () => {
    renderBar()
    expect(screen.getByTestId('context-state').getAttribute('data-tone')).toBe('ok')
    expect(screen.getByTestId('context-action').getAttribute('data-tone')).toBeNull()
  })
})

describe('DatasetContextBar — return path', () => {
  it('shows the back chip only after a finding jump', () => {
    const { rerender } = render(
      <DatasetContextBar
        rows={12}
        columns={10}
        stagedOperations={0}
        next={OK}
        onAction={() => undefined}
        onSecondaryReview={() => undefined}
        jumpOrigin={false}
        onBackToFindings={() => undefined}
      />,
    )
    expect(screen.queryByTestId('context-back-to-findings')).toBeNull()
    rerender(
      <DatasetContextBar
        rows={12}
        columns={10}
        stagedOperations={0}
        next={OK}
        onAction={() => undefined}
        onSecondaryReview={() => undefined}
        jumpOrigin
        onBackToFindings={() => undefined}
      />,
    )
    expect(screen.getByTestId('context-back-to-findings').textContent).toBe('Back to findings')
  })

  it('calls the return handler', () => {
    const { onBackToFindings } = renderBar({ jumpOrigin: true })
    fireEvent.click(screen.getByTestId('context-back-to-findings'))
    expect(onBackToFindings).toHaveBeenCalledTimes(1)
  })
})
