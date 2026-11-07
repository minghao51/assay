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
import { useRef, useState } from 'react'
import { useTelemetry } from './TelemetryContext'

export interface TelemetrySettingsProps {
  /**
   * rd-7 (D-03) modal-ownership seam: App needs to know this panel is open so
   * the header's Help control can be disabled while it is. Notification only —
   * the panel keeps its own open state and its standalone behaviour is
   * unchanged when the prop is omitted. No telemetry preference, event or copy
   * is involved.
   */
  readonly onOpenChange?: (open: boolean) => void
}

export function TelemetrySettings({ onOpenChange }: TelemetrySettingsProps = {}) {
  const telemetry = useTelemetry()
  const [open, setOpen] = useState(false)
  const [enabled, setEnabled] = useState(() => telemetry.getPreference() !== 'off')
  /**
   * rd-7: the toggle is the panel's opener, so closing the panel from its own
   * Close control returns focus there instead of dropping it to `<body>` when
   * the `hidden` body unmounts its focused button.
   */
  const toggleRef = useRef<HTMLButtonElement | null>(null)

  const changeOpen = (next: boolean): void => {
    setOpen(next)
    onOpenChange?.(next)
  }

  return (
    <div className="telemetry-settings">
      <button
        ref={toggleRef}
        type="button"
        className="telemetry-settings-toggle"
        data-testid="settings-toggle"
        aria-expanded={open}
        aria-controls="telemetry-settings-dialog"
        onClick={() => {
          changeOpen(!open)
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
            changeOpen(false)
            toggleRef.current?.focus()
          }}
        >
          Close
        </button>
      </section>
    </div>
  )
}
