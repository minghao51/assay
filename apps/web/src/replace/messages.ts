// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * WF-06 replacement-surface copy (C1–C16 of the reviewed v5 contract, exact).
 *
 * Constant-only by contract (§8.1 item 3): no module here interpolates engine
 * text, a filename, a path, a count or a dataset value. The one composed
 * sentence — C10 — is built in `App` from the **classified** cause of
 * `openFailureMessage` plus the constant suffix below; the raw engine
 * diagnostic never reaches it (it is confined to the collapsed C14 detail
 * block).
 *
 * Truth constraints carried by these strings (v5 §8): no autosave, no
 * persistence or "saved" promise, no timing promise (the waits the notices
 * describe are unbounded), and no filename/count anywhere.
 */

/** C1 — the guard's accessible name and title. */
export const REPLACE_GUARD_TITLE = 'Replace this session?'

/** C2 — guard body ¶1: what a replacement replaces (shown only when dirty). */
export const REPLACE_GUARD_BODY_STAGED =
  'This session has staged changes that are not saved. Opening another dataset replaces the session, its staged edits, its undo history, and any validation or comparison results.'

/** C3 — guard body ¶2: no autosave claim, and the export route. */
export const REPLACE_GUARD_BODY_EXPORT =
  'Session changes are not saved automatically. Export a copy to keep them.'

/** C4 — guard body ¶3: the structural promise (backed by T6/T9/T9b/T10). */
export const REPLACE_GUARD_BODY_STAYS =
  'If you cancel the file chooser, or the file cannot be opened, this session stays as it is.'

/** C5 — the guard's safe action. */
export const REPLACE_STAY_LABEL = 'Stay'

/** C6 — the guard's export-first action. */
export const REPLACE_EXPORT_LABEL = 'Export a copy…'

/** C7 — the guard's destructive action (the only way into `choosing`). */
export const REPLACE_CHOOSE_LABEL = 'Choose a replacement file…'

/** C8 — picker cancellation (T6): nothing opened, session unchanged. */
export const REPLACE_PICKER_NOTICE = 'Nothing was opened. This session is unchanged.'

/** C9 — while a candidate is prepared and the live session is still live. */
export const REPLACE_PROGRESS_TEXT =
  'Opening the new file… The current session stays open until it is ready.'

/** C9's `<progress>` accessible name (indeterminate; not a percentage). */
export const REPLACE_PROGRESS_LABEL = 'Opening progress'

/**
 * C10's constant tail. The head and cause are `openFailureMessage`'s own
 * sentence (the same classified, value-free cause the legacy open error
 * renders), so this row never composes a second classification.
 */
export const REPLACE_FAILURE_SUFFIX = ' Nothing in this session changed.'

/** C11 — retry re-enters `choosing` (never the destroy-first legacy flow). */
export const REPLACE_RETRY_LABEL = 'Choose a different file…'

/** C12 — a ready gesture arrived while another replacement intent is active. */
export const REPLACE_BUSY_NOTICE = 'Finish the current opening first.'

/** C13 — G3 refusal: an open cell editor (clean and dirty both). */
export const REPLACE_DRAFT_NOTICE = 'Finish or cancel the cell you are editing first.'

/** C14 — the collapsed technical-detail disclosure's summary. */
export const REPLACE_TECHNICAL_SUMMARY = 'Technical detail'

/** C15 — G4 refusal while a history commit is still materializing. */
export const REPLACE_SETTLING_NOTICE =
  'This session is still finishing a change. Replacement stays unavailable until it finishes.'

/** C16 — G4 refusal while at least one column cast pre-check is pending. */
export const REPLACE_CAST_NOTICE =
  'A column type check is still running. Replacement stays unavailable until it finishes.'
