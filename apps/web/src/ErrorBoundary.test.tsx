// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ERROR_BOUNDARY_COPY, ErrorBoundary } from './ErrorBoundary'

/**
 * AR-W4 + ug-7/R-06 pins: a throwing render subtree surfaces the matching
 * boundary UI scoped to the app, the grid, or one tool-section body. Fallback
 * copy is static and contains no dynamic values (never the thrown message,
 * dataset values, or file names — ADR 0025), Try again remounts the child and
 * preserves everything outside the boundary, and a deterministic fault stays
 * contained. Each scope carries exactly the action labels the spec names.
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

function PanelHarness({
  children,
  onClose = () => {},
}: {
  readonly children: ReactNode
  readonly onClose?: () => void
}) {
  return (
    <div id="section-demo-content">
      <ErrorBoundary scope="panel" sectionId="demo" onClose={onClose}>
        {children}
      </ErrorBoundary>
    </div>
  )
}

function GridHarness({ children }: { readonly children: ReactNode }) {
  return (
    <div id="section-grid-content">
      <ErrorBoundary scope="grid" sectionId="grid">
        {children}
      </ErrorBoundary>
    </div>
  )
}

describe('ErrorBoundary (AR-W4 / ug-7)', () => {
  it('renders children untouched when nothing throws', () => {
    render(
      <ErrorBoundary scope="app">
        <p data-testid="fine">ok</p>
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('fine')).toBeTruthy()
    expect(screen.queryByTestId('error-boundary-app')).toBeNull()
  })

  it('surfaces the unchanged app-scope fallback and logs the error (never renders it)', () => {
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
    // App scope is unchanged: no panel/grid retry or close actions.
    expect(screen.queryByTestId('error-boundary-retry')).toBeNull()
    expect(screen.queryByTestId('error-boundary-close')).toBeNull()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('renders the exact grid fallback with Try again primary and Reload secondary', () => {
    render(
      <GridHarness>
        <Boom />
      </GridHarness>,
    )
    const fallback = screen.getByTestId('error-boundary-grid')
    const copy = ERROR_BOUNDARY_COPY.grid
    expect(fallback.textContent).toBe(
      `${copy.title}${copy.body}${copy.recovery}Try againReload the workbench`,
    )
    expect(fallback.textContent).not.toContain('dataset-value-should-not-render')
    const actions = fallback.querySelectorAll('button')
    expect(Array.from(actions).map((button) => button.textContent)).toEqual([
      'Try again',
      'Reload the workbench',
    ])
    expect(screen.queryByTestId('error-boundary-close')).toBeNull()
  })

  it('renders the exact panel fallback with Try again and Close section', () => {
    const onClose = vi.fn()
    render(
      <PanelHarness onClose={onClose}>
        <Boom />
      </PanelHarness>,
    )
    const fallback = screen.getByTestId('error-boundary-panel')
    const copy = ERROR_BOUNDARY_COPY.panel
    expect(fallback.textContent).toBe(
      `${copy.title}${copy.body}${copy.recovery}Try againClose section`,
    )
    expect(fallback.textContent).not.toContain('dataset-value-should-not-render')
    expect(fallback.getAttribute('data-section')).toBe('demo')
    const actions = fallback.querySelectorAll('button')
    expect(Array.from(actions).map((button) => button.textContent)).toEqual([
      'Try again',
      'Close section',
    ])
    fireEvent.click(screen.getByTestId('error-boundary-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('recovers a transient panel fault in place, remounting and focusing a usable target', async () => {
    let broken = true
    function FlakyPanel() {
      if (broken) throw new Error('transient-panel-boom')
      return <button data-testid="panel-ok">Recovered</button>
    }
    render(
      <PanelHarness>
        <FlakyPanel />
      </PanelHarness>,
    )
    expect(screen.getByTestId('error-boundary-panel')).toBeTruthy()
    // Focus moved to reachable fallback content on failure.
    expect(document.activeElement).toBe(screen.getByTestId('error-boundary-panel'))

    broken = false
    fireEvent.click(screen.getByTestId('error-boundary-retry'))

    expect(await screen.findByTestId('panel-ok')).toBeTruthy()
    expect(screen.queryByTestId('error-boundary-panel')).toBeNull()
    // Focus moved to a usable target inside the recovered section.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('panel-ok'))
    })
  })

  it('keeps a deterministic panel fault contained and focuses the retained fallback', async () => {
    render(
      <PanelHarness>
        <Boom />
      </PanelHarness>,
    )
    fireEvent.click(screen.getByTestId('error-boundary-retry'))
    // The retry re-throws: no promise that remount fixes a deterministic fault.
    expect(await screen.findByTestId('error-boundary-panel')).toBeTruthy()
    expect(screen.queryByTestId('error-boundary-close')).toBeTruthy()
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('error-boundary-panel'))
    })
  })

  it('grid Try again remounts only the grid child and focuses a usable grid target', async () => {
    let broken = true
    function FlakyGrid() {
      if (broken) throw new Error('transient-grid-boom')
      return <button data-testid="grid-ok">Recovered grid</button>
    }
    render(
      <GridHarness>
        <FlakyGrid />
      </GridHarness>,
    )
    expect(screen.getByTestId('error-boundary-grid')).toBeTruthy()
    broken = false
    fireEvent.click(screen.getByTestId('error-boundary-retry'))
    expect(await screen.findByTestId('grid-ok')).toBeTruthy()
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('grid-ok'))
    })
  })
})
