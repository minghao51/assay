// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * React context for the web telemetry runtime.
 *
 * `App` builds the real runtime once and provides it; components deeper in the
 * tree call `useTelemetry()` and emit after their operation settles. Component
 * tests that render a component standalone get the inert default runtime, so
 * there is never a network call or a storage read from an unprovided context.
 */
import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { WebTelemetryRuntime } from './runtime'

/** An inert runtime: every method is a no-op, nothing is ever sent. */
export const NOOP_TELEMETRY: WebTelemetryRuntime = {
  surface: 'web',
  hardOff: false,
  endpointConfigured: false,
  emit: () => undefined,
  flush: () => Promise.resolve(),
  getPreference: () => 'on',
  setPreference: () => undefined,
  isEnabledNow: () => false,
  shouldShowDisclosure: () => false,
  markDisclosureShown: () => undefined,
  dispose: () => undefined,
}

const TelemetryContext = createContext<WebTelemetryRuntime>(NOOP_TELEMETRY)

export interface TelemetryProviderProps {
  readonly runtime: WebTelemetryRuntime
  readonly children: ReactNode
}

export function TelemetryProvider({ runtime, children }: TelemetryProviderProps) {
  return <TelemetryContext.Provider value={runtime}>{children}</TelemetryContext.Provider>
}

/** The provided runtime, or the inert default outside a provider. */
export function useTelemetry(): WebTelemetryRuntime {
  return useContext(TelemetryContext)
}
