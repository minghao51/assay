// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Phase } from '../sessions/types'

export const APP_NAME = 'Assay' as const

/** The descriptive tagline — "data workbench" is the category, Assay is the product (ADR 0039). */
export const TAGLINE = 'The local-first data workbench' as const

/**
 * R-03 idle capability sentence (exact copy). The first-run screen states what
 * the product does, not where the project is in its milestone plan.
 */
export const IDLE_CAPABILITY =
  'Inspect, query, validate, compare, and repair local datasets.' as const

/** R-03 supported-format line (exact copy). Mirrors the picker's accept list. */
export const IDLE_FORMATS = 'Opens .parquet · .csv · .jsonl · .json' as const

/**
 * R-12 idle engine explanation and supporting sentence (exact copy). Static
 * text only: it names the engine and the local execution model as facts about
 * the product, not as live state — no connection/engine status, spinner,
 * benchmark, timing, memory or version claim, no engine-driven conditional and
 * no new network request or telemetry event (ADR 0025, ADR 0037). Both strings
 * are rendered on the idle screen only, beside the R-03 copy above.
 */
export const IDLE_ENGINE_LINE = 'Powered by DuckDB-WASM · local query execution' as const
export const IDLE_ENGINE_NOTE =
  'Dataset contents are processed locally. Edits are staged; export writes a copy.' as const

/** R-05 idle example action and helper (exact copy). */
export const IDLE_EXAMPLE_ACTION = 'Try with example data' as const
export const IDLE_EXAMPLE_HELPER = 'Explore nested fields with a small synthetic example.' as const

/**
 * ug-15/UG-6 idle drop affordance. The whole window accepts a drop in every
 * phase, but only the idle screen advertises it; the copy is value-free and
 * carries no filename or format-specific claim (ADR 0025).
 */
export const IDLE_DROP_HINT = 'Or drop a data file anywhere on this page' as const

/**
 * ug-15/UG-6 readable copy for a drop that carried no `File` (dragged text or
 * a page selection). It never echoes the `DataTransfer` contents and never
 * reaches the engine.
 */
export const DROP_WITHOUT_FILE =
  'That drop did not include a file. Drop a .parquet, .csv, .jsonl or .json file to open it.' as const

/**
 * Human copy for the open-flow status span (ux-2/UX-2). The machine token
 * lives on `data-phase`; these strings are the only visible copy, so raw
 * `phase.kind` values never reach the screen. `ready` folds its state into the
 * `table-info` line and `error` keeps its own `role="alert"` message, so both
 * render no status copy here.
 */
const OPEN_STATUS_COPY: Record<Phase['kind'], string | null> = {
  idle: 'No file open',
  opening: 'Opening…',
  ready: null,
  error: null,
}

export function openStatusCopy(kind: Phase['kind']): string | null {
  return OPEN_STATUS_COPY[kind]
}

/**
 * ug-21: accessible names for the opening-only affordances. Both are
 * value-free: the progress element is indeterminate (no percentage, bytes,
 * filename, or row count) and the cancel control states its action without
 * implying that the engine supports an interrupt. ADR 0025.
 */
export const OPEN_PROGRESS_LABEL = 'Opening progress' as const
export const OPEN_CANCEL_LABEL = 'Cancel opening' as const

/**
 * C03b session-fault recovery copy. One registered reset threw while the
 * dataset session was being closed/started: the generation is already
 * invalidated and every remaining reset was attempted, but the reset was
 * partial, so the app must not show that session as ready (and must not claim
 * the previous session was restored). The copy is fixed and value-free — no
 * error message, filename, column, row or cell value ever reaches it (ADR 0025).
 */
export const SESSION_FAULT_COPY =
  'This session could not be closed cleanly, so it was ended instead of shown. Reload the page to start a clean session.' as const

/**
 * The only affordance in the session-fault frame. A fresh page is the only
 * honest recovery: the app cannot prove which reset callbacks completed, and
 * there is no persisted state to repair.
 */
export const SESSION_FAULT_RELOAD_LABEL = 'Reload the page' as const

/**
 * Polite live-region announcement for a completed open (ux-2/UX-10). Row and
 * column counts are already public in the info line; the text never carries a
 * filename, path, cell value, or PII (ADR 0025).
 */
export function openAnnouncementText(rows: number, columns: number): string {
  const rowWord = rows === 1 ? 'row' : 'rows'
  const columnWord = columns === 1 ? 'column' : 'columns'
  return `Dataset opened · ${String(rows)} ${rowWord} · ${String(columns)} ${columnWord}`
}
