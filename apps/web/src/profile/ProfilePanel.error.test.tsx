// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { TelemetryProvider } from '../telemetry/TelemetryContext'
import type { WebTelemetryRuntime } from '../telemetry/runtime'
import { ProfilePanel } from './ProfilePanel'

/**
 * UG-30 pin: a failed profile run renders ONE framed, single-line message
 * through the shared engine-error helper — the raw multi-line DuckDB
 * diagnostic (which echoes composed SQL) never reaches `profile-error`. The
 * pre-existing retry control and telemetry contract are untouched (see
 * `ProfilePanel.telemetry.test.tsx`).
 */

const HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }

const h = vi.hoisted(() => ({ profile: vi.fn() }))

vi.mock('../lib/engine', () => ({
  engineClient: { profile: h.profile },
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

function renderPanel() {
  return render(
    <TelemetryProvider runtime={fakeRuntime()}>
      <ProfilePanel handle={HANDLE} />
    </TelemetryProvider>,
  )
}

afterEach(cleanup)
beforeEach(() => {
  h.profile.mockReset()
})

describe('UG-30 — profile errors are framed and single-line', () => {
  it('reduces a multi-line engine diagnostic and names what did not change', async () => {
    h.profile.mockRejectedValue(
      new Error(
        'Out of Memory Error: failed to allocate 1.0 GiB\n' +
          'LINE 1: SELECT * FROM "assay_t1" GROUP BY "country"',
      ),
    )
    renderPanel()
    fireEvent.click(screen.getByTestId('profile-toggle'))
    fireEvent.click(screen.getByTestId('profile-run'))

    const error = await screen.findByTestId('profile-error')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toBe(
      'The profile could not be computed: Out of Memory Error: failed to allocate 1.0 GiB. ' +
        'The dataset and its staged changes are unchanged.',
    )
    expect(error.textContent).not.toMatch(/\r|\n/)
    expect(document.body.textContent).not.toContain('LINE 1')
    // The failure stays local and retryable.
    expect(screen.getByTestId('profile-retry')).toBeTruthy()
  })
})
