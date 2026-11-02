// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The minimal web Settings affordance (design §6.2, OQ6) — a header button
 * that opens a small dialog with the persistent anonymous-usage toggle. It
 * deliberately adds NO new workbench `<h2>` section (protects the ux-6 heading
 * map) and no other copy beyond the Settings labels.
 *
 * The toggle writes `localStorage['assay.telemetry']` through the runtime, so
 * turning telemetry off mid-session clears the buffer synchronously and blocks
 * later sends (§6.5). When `ASSAY_NO_TELEMETRY` was set at build time the
 * toggle is present but disabled (build-time hard-off, no override).
 */
import { useState } from 'react'
import { useTelemetry } from './TelemetryContext'

export function TelemetrySettings() {
  const telemetry = useTelemetry()
  const [open, setOpen] = useState(false)
  const [enabled, setEnabled] = useState(() => telemetry.getPreference() !== 'off')

  return (
    <div className="telemetry-settings">
      <button
        type="button"
        className="telemetry-settings-toggle"
        data-testid="settings-toggle"
        aria-expanded={open}
        aria-controls="telemetry-settings-dialog"
        onClick={() => {
          setOpen((previous) => !previous)
        }}
      >
        Settings
      </button>
      <section
        id="telemetry-settings-dialog"
        className="telemetry-settings-dialog"
        role="dialog"
        aria-modal="false"
        aria-labelledby="telemetry-settings-title"
        data-testid="settings-dialog"
        hidden={!open}
      >
        <p id="telemetry-settings-title" className="telemetry-settings-title">
          Settings
        </p>
        <label className="telemetry-settings-option">
          <input
            type="checkbox"
            data-testid="telemetry-toggle"
            checked={enabled}
            disabled={telemetry.hardOff}
            onChange={(event) => {
              const next = event.target.checked
              setEnabled(next)
              telemetry.setPreference(next ? 'on' : 'off')
            }}
          />{' '}
          Anonymous usage metadata
        </label>
        {telemetry.hardOff && (
          <p className="telemetry-settings-hard-off" data-testid="telemetry-hard-off">
            Disabled by build
          </p>
        )}
        <button
          type="button"
          className="telemetry-settings-close"
          data-testid="settings-close"
          onClick={() => {
            setOpen(false)
          }}
        >
          Close
        </button>
      </section>
    </div>
  )
}
