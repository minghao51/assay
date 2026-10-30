// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TelemetryProvider } from '../telemetry/TelemetryContext'
import type { WebTelemetryRuntime } from '../telemetry/runtime'
import { SqlPanel } from './SqlPanel'
import type { SqlRunRequest } from './SqlPanel'

/**
 * UG-30 pins for the SQL pane's TWO error paths: an engine rejection and the
 * client-side composition rejection. Both render through the shared
 * first-line-reducing framing helper, so no multi-line engine diagnostic can
 * reach `sql-error` and the alert always names what did not change.
 */

const h = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('../lib/engine', () => ({
  engineClient: { query: h.query },
}))

function fakeRuntime(): WebTelemetryRuntime {
  return {
    surface: 'web',
    hardOff: false,
    endpointConfigured: true,
    emit: vi.fn(),
    flush: vi.fn(async () => undefined),
    getPreference: () => 'on',
    setPreference: vi.fn(),
    isEnabledNow: () => true,
    shouldShowDisclosure: () => false,
    markDisclosureShown: vi.fn(),
    dispose: vi.fn(),
  }
}

const allowRequest = (): boolean => true

function renderPanel(runRequest: SqlRunRequest | null = null) {
  return render(
    <TelemetryProvider runtime={fakeRuntime()}>
      <SqlPanel tableId="t1" runRequest={runRequest} claimRequest={allowRequest} />
    </TelemetryProvider>,
  )
}

afterEach(cleanup)
beforeEach(() => {
  h.query.mockReset()
})

describe('UG-30 — SQL errors are framed and single-line', () => {
  it('reduces a multi-line engine diagnostic to its first line inside a framed message', async () => {
    h.query.mockRejectedValue(
      new Error(
        'Binder Error: Referenced column "nope" not found in FROM clause!\n' +
          'LINE 1: SELECT nope FROM "assay_t1"\n               ^',
      ),
    )
    renderPanel()
    fireEvent.change(screen.getByTestId('sql-input'), {
      target: { value: 'SELECT nope FROM "assay_t1"' },
    })
    fireEvent.click(screen.getByTestId('sql-run'))

    const error = await screen.findByTestId('sql-error')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toBe(
      'The query could not run: Binder Error: Referenced column "nope" not found in FROM clause. ' +
        'The dataset and its staged changes are unchanged.',
    )
    expect(error.textContent).not.toMatch(/\r|\n/)
    expect(error.textContent).not.toContain('LINE 1')
    expect(document.body.textContent).not.toContain('LINE 1')
  })

  it('frames the client-side composition rejection the same way', async () => {
    renderPanel({ sql: ';', seq: 1, session: 1 })

    const error = await screen.findByTestId('sql-error')
    expect(error.textContent).toBe(
      'The query could not run: Enter a SQL query to run. ' +
        'The dataset and its staged changes are unchanged.',
    )
    expect(error.textContent).not.toMatch(/\r|\n/)
    // No query was issued for a statement that cannot compose.
    await waitFor(() => {
      expect(h.query).not.toHaveBeenCalled()
    })
  })
})
