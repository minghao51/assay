// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { TelemetryProvider } from '../telemetry/TelemetryContext'
import type { WebTelemetryRuntime } from '../telemetry/runtime'
import { ProfilePanel } from './ProfilePanel'

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

const HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }

afterEach(cleanup)
beforeEach(() => {
  h.profile.mockReset()
})

describe('ProfilePanel telemetry — profile_run (design §2/Appendix C)', () => {
  it('emits success with the column-count bucket', async () => {
    h.profile.mockResolvedValue({
      rowCount: 1,
      columns: [{ name: 'id', type: 'BIGINT', kind: 'other', nullCount: 0, distinctCount: 1 }],
    })
    const runtime = fakeRuntime()
    render(
      <TelemetryProvider runtime={runtime}>
        <ProfilePanel handle={HANDLE} />
      </TelemetryProvider>,
    )
    fireEvent.click(screen.getByTestId('profile-run'))
    await waitFor(() => {
      expect(runtime.emit).toHaveBeenCalledWith('profile_run', {
        column_count_bucket: '1_10',
        duration_bucket: 'lt_50ms',
        outcome: 'success',
      })
    })
  })

  it('emits error with the zero bucket', async () => {
    h.profile.mockRejectedValue(new Error('engine down'))
    const runtime = fakeRuntime()
    render(
      <TelemetryProvider runtime={runtime}>
        <ProfilePanel handle={HANDLE} />
      </TelemetryProvider>,
    )
    fireEvent.click(screen.getByTestId('profile-run'))
    await waitFor(() => {
      expect(runtime.emit).toHaveBeenCalledWith('profile_run', {
        column_count_bucket: 'zero',
        duration_bucket: 'lt_50ms',
        outcome: 'error',
      })
    })
  })
})
