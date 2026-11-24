// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * WF-03 subpart 3 (WFD-05 selection §1, 2026-11-23) — the idle-only welcome
 * block.
 *
 * App renders it inside its existing `phase.kind === 'idle'` region (the
 * uxv-4/R-12 insertion pattern), so it is present on the first-run screen and
 * absent in `opening`, `ready` and `error`. The block is presentational only:
 * it reads no session, engine, grid or telemetry state, owns no control and
 * makes no promise — **every line is an existing `lib/app.ts` constant**
 * (`IDLE_CAPABILITY`, `IDLE_FORMATS`, `IDLE_ENGINE_LINE`, `IDLE_ENGINE_NOTE`,
 * `IDLE_DROP_HINT`). Subpart 4 (new first-minute strings) is deferred, so this
 * file adds no literal copy; its own test pins that by scanning the source.
 *
 * The only non-constant input is `dropNotice`, the value-free "that drop did
 * not include a file" line App already classified (`DROP_WITHOUT_FILE`); it is
 * passed through, never composed here. Open, the CSV review entry and the
 * example data action stay in App's open-flow control block, above this
 * block's own copy: a failure never removes them, and nothing here is a second
 * way to open a file.
 *
 * The two-pane shell (ADR 0044) is untouched: this block only ever renders in
 * `idle`, where no workspace exists, and its root keeps the `idle-intro`
 * testid the existing idle legs (`App.open-status`, `App.drop`, the smoke and
 * drop-open specs) already pin.
 */

import {
  IDLE_CAPABILITY,
  IDLE_DROP_HINT,
  IDLE_ENGINE_LINE,
  IDLE_ENGINE_NOTE,
  IDLE_FORMATS,
} from '../lib/app'

export interface WelcomeBlockProps {
  /**
   * App's already-classified drop notice (`DROP_WITHOUT_FILE`) or `null`. The
   * block renders it verbatim as a `role="status"` line; it never builds copy
   * of its own.
   */
  readonly dropNotice?: string | null
}

export function WelcomeBlock({ dropNotice = null }: WelcomeBlockProps = {}) {
  return (
    <div className="idle-intro welcome-block" data-testid="idle-intro">
      {/*
        WF-03 subpart 2 (hierarchy by style and spacing only): one lead line,
        one metadata line, then the engine/privacy lines as a quieter note
        group, then the drop affordance. Same strings, same order, no heading,
        no new element that could become a landmark or a tab stop.
      */}
      <p className="welcome-block-lead" data-testid="idle-capability">
        {IDLE_CAPABILITY}
      </p>
      <p className="welcome-block-formats" data-testid="idle-formats">
        {IDLE_FORMATS}
      </p>
      {/*
        R-12: the engine explanation is static copy, not engine state — it
        reads nothing from the session, engine or telemetry. No live status,
        benchmark, memory or version claim and no new request/event.
      */}
      <p className="welcome-block-note-line" data-testid="idle-engine-line">
        {IDLE_ENGINE_LINE}
      </p>
      <p className="welcome-block-note" data-testid="idle-engine-note">
        {IDLE_ENGINE_NOTE}
      </p>
      <p className="idle-drop-hint welcome-block-drop" data-testid="idle-drop-hint">
        {IDLE_DROP_HINT}
      </p>
      {dropNotice !== null && (
        <p className="welcome-block-drop-notice" role="status" data-testid="drop-notice">
          {dropNotice}
        </p>
      )}
    </div>
  )
}
