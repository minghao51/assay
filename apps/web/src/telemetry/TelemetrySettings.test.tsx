// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TelemetryProvider } from './TelemetryContext'
import { TelemetrySettings } from './TelemetrySettings'
import type { WebTelemetryRuntime } from './runtime'

function fakeRuntime(overrides: Partial<WebTelemetryRuntime> = {}): WebTelemetryRuntime {
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
    ...overrides,
  }
}

afterEach(cleanup)

describe('TelemetrySettings — the persistent web toggle (design §6.2/OQ6)', () => {
  it('opens the dialog and flips the preference off', () => {
    const runtime = fakeRuntime()
    render(
      <TelemetryProvider runtime={runtime}>
        <TelemetrySettings />
      </TelemetryProvider>,
    )
    fireEvent.click(screen.getByTestId('settings-toggle'))
    const toggle = screen.getByTestId('telemetry-toggle') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    fireEvent.click(toggle)
    expect(runtime.setPreference).toHaveBeenCalledWith('off')
  })

  it('reflects an already-off preference on open', () => {
    const runtime = fakeRuntime({ getPreference: () => 'off' })
    render(
      <TelemetryProvider runtime={runtime}>
        <TelemetrySettings />
      </TelemetryProvider>,
    )
    fireEvent.click(screen.getByTestId('settings-toggle'))
    expect((screen.getByTestId('telemetry-toggle') as HTMLInputElement).checked).toBe(false)
  })

  it('disables the toggle under build-time hard off', () => {
    const runtime = fakeRuntime({ hardOff: true })
    render(
      <TelemetryProvider runtime={runtime}>
        <TelemetrySettings />
      </TelemetryProvider>,
    )
    fireEvent.click(screen.getByTestId('settings-toggle'))
    expect((screen.getByTestId('telemetry-toggle') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByTestId('telemetry-hard-off')).toBeTruthy()
  })
})
