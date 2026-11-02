// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The first-run telemetry disclosure (design §6.3, ADR 0037).
 *
 * Rendered by `App` only when `runtime.shouldShowDisclosure()` was true. The
 * body is the byte-exact §6.3 copy from `@assay/telemetry`; the two buttons
 * are the §6.3 affordances. On mount it records the disclosure as shown and
 * emits `disclosure_shown` (revision 1) — once per install: the runtime's
 * persisted flag makes the mount effect idempotent (StrictMode-safe).
 */
import { useEffect } from 'react'
import {
  DISCLOSURE_REVISION,
  WEB_DISCLOSURE_BODY,
  WEB_DISCLOSURE_KEEP_ON_LABEL,
  WEB_DISCLOSURE_TURN_OFF_LABEL,
} from '@assay/telemetry'
import { useTelemetry } from './TelemetryContext'

export interface TelemetryDisclosureProps {
  readonly onDismiss: () => void
}

export function TelemetryDisclosure({ onDismiss }: TelemetryDisclosureProps) {
  const telemetry = useTelemetry()

  useEffect(() => {
    // Only emit while the disclosure is genuinely pending: `markDisclosureShown`
    // persists the flag, so React StrictMode's second effect run is a no-op.
    if (!telemetry.shouldShowDisclosure()) return
    telemetry.markDisclosureShown()
    telemetry.emit('disclosure_shown', { disclosure_revision: DISCLOSURE_REVISION })
  }, [telemetry])

  return (
    <section
      className="telemetry-disclosure"
      role="dialog"
      aria-modal="true"
      aria-labelledby="telemetry-disclosure-title"
      data-testid="telemetry-disclosure"
    >
      <p id="telemetry-disclosure-title" className="visually-hidden">
        Telemetry disclosure
      </p>
      <pre className="telemetry-disclosure-copy" data-testid="telemetry-disclosure-copy">
        {WEB_DISCLOSURE_BODY}
      </pre>
      <div className="telemetry-disclosure-actions">
        <button
          type="button"
          className="telemetry-disclosure-action"
          data-testid="telemetry-keep-on"
          onClick={() => {
            onDismiss()
          }}
        >
          {WEB_DISCLOSURE_KEEP_ON_LABEL}
        </button>
        <button
          type="button"
          className="telemetry-disclosure-action"
          data-testid="telemetry-turn-off"
          onClick={() => {
            telemetry.setPreference('off')
            onDismiss()
          }}
        >
          {WEB_DISCLOSURE_TURN_OFF_LABEL}
        </button>
      </div>
    </section>
  )
}
