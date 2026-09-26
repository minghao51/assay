// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ERROR_BOUNDARY_COPY, ErrorBoundary } from './ErrorBoundary'

/**
 * AR-W4 pins: a throwing render subtree surfaces the boundary UI (both the
 * top-level `app` and the `grid` scope), the fallback copy is static and
 * contains no dynamic values (never the thrown message, dataset values, or
 * file names — ADR 0025), and the error is logged rather than swallowed.
 */

/** A render-path throw with a distinctive, value-looking message. */
function Boom(): never {
  throw new Error('dataset-value-should-not-render')
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // React logs caught render errors; keep the test output clean.
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  errorSpy.mockRestore()
})

describe('ErrorBoundary (AR-W4)', () => {
  it('renders children untouched when nothing throws', () => {
    render(
      <ErrorBoundary scope="app">
        <p data-testid="fine">ok</p>
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('fine')).toBeTruthy()
    expect(screen.queryByTestId('error-boundary-app')).toBeNull()
  })

  it('surfaces the app-scope fallback and logs the error (never renders it)', () => {
    render(
      <ErrorBoundary scope="app">
        <Boom />
      </ErrorBoundary>,
    )
    const fallback = screen.getByTestId('error-boundary-app')
    const copy = ERROR_BOUNDARY_COPY.app
    // Exact static copy — no interpolated error text or values.
    expect(fallback.textContent).toBe(
      `${copy.title}${copy.body}${copy.recovery}Reload the workbench`,
    )
    expect(fallback.textContent).not.toContain('dataset-value-should-not-render')
    expect(screen.getByTestId('error-boundary-reload')).toBeTruthy()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('surfaces the grid-scope fallback (the second boundary)', () => {
    render(
      <ErrorBoundary scope="grid">
        <Boom />
      </ErrorBoundary>,
    )
    const fallback = screen.getByTestId('error-boundary-grid')
    const copy = ERROR_BOUNDARY_COPY.grid
    expect(fallback.textContent).toBe(
      `${copy.title}${copy.body}${copy.recovery}Reload the workbench`,
    )
    expect(fallback.textContent).not.toContain('dataset-value-should-not-render')
    // The two scopes are distinct, honest copy.
    expect(copy.title).not.toBe(ERROR_BOUNDARY_COPY.app.title)
  })
})
