// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DISCLOSURE_REVISION,
  WEB_DISCLOSURE_BODY,
  WEB_DISCLOSURE_KEEP_ON_LABEL,
  WEB_DISCLOSURE_TURN_OFF_LABEL,
} from '@assay/telemetry'
import { TelemetryProvider } from './TelemetryContext'
import { TelemetryDisclosure } from './TelemetryDisclosure'
import type { WebTelemetryRuntime } from './runtime'

function fakeRuntime(overrides: Partial<WebTelemetryRuntime> = {}): WebTelemetryRuntime {
  let pending = true
  return {
    surface: 'web',
    hardOff: false,
    endpointConfigured: true,
    emit: vi.fn(),
    flush: vi.fn(async () => undefined),
    getPreference: () => 'on',
    setPreference: vi.fn(),
    isEnabledNow: () => true,
    shouldShowDisclosure: () => pending,
    markDisclosureShown: vi.fn(() => {
      pending = false
    }),
    dispose: vi.fn(),
    ...overrides,
  }
}

afterEach(cleanup)

describe('TelemetryDisclosure — byte-exact §6.3 render + consent actions', () => {
  it('renders the exact disclosure copy and both affordances', () => {
    const runtime = fakeRuntime()
    render(
      <TelemetryProvider runtime={runtime}>
        <TelemetryDisclosure onDismiss={() => undefined} />
      </TelemetryProvider>,
    )
    expect(screen.getByTestId('telemetry-disclosure-copy').textContent).toBe(WEB_DISCLOSURE_BODY)
    expect(screen.getByText(WEB_DISCLOSURE_KEEP_ON_LABEL)).toBeTruthy()
    expect(screen.getByText(WEB_DISCLOSURE_TURN_OFF_LABEL)).toBeTruthy()
  })

  it('records the disclosure shown and emits disclosure_shown once', () => {
    const runtime = fakeRuntime()
    render(
      <TelemetryProvider runtime={runtime}>
        <TelemetryDisclosure onDismiss={() => undefined} />
      </TelemetryProvider>,
    )
    expect(runtime.markDisclosureShown).toHaveBeenCalledTimes(1)
    expect(runtime.emit).toHaveBeenCalledWith('disclosure_shown', {
      disclosure_revision: DISCLOSURE_REVISION,
    })
  })

  it('does not re-emit when the disclosure was already recorded', () => {
    const runtime = fakeRuntime({ shouldShowDisclosure: () => false })
    render(
      <TelemetryProvider runtime={runtime}>
        <TelemetryDisclosure onDismiss={() => undefined} />
      </TelemetryProvider>,
    )
    expect(runtime.emit).not.toHaveBeenCalled()
  })

  it('"Turn it off" flips the preference and dismisses', () => {
    const runtime = fakeRuntime()
    const onDismiss = vi.fn()
    render(
      <TelemetryProvider runtime={runtime}>
        <TelemetryDisclosure onDismiss={onDismiss} />
      </TelemetryProvider>,
    )
    fireEvent.click(screen.getByTestId('telemetry-turn-off'))
    expect(runtime.setPreference).toHaveBeenCalledWith('off')
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('"Keep anonymous usage on" dismisses without flipping the preference', () => {
    const runtime = fakeRuntime()
    const onDismiss = vi.fn()
    render(
      <TelemetryProvider runtime={runtime}>
        <TelemetryDisclosure onDismiss={onDismiss} />
      </TelemetryProvider>,
    )
    fireEvent.click(screen.getByTestId('telemetry-keep-on'))
    expect(runtime.setPreference).not.toHaveBeenCalled()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
