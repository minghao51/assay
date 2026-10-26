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
 * Polite live-region announcement for a completed open (ux-2/UX-10). Row and
 * column counts are already public in the info line; the text never carries a
 * filename, path, cell value, or PII (ADR 0025).
 */
export function openAnnouncementText(rows: number, columns: number): string {
  const rowWord = rows === 1 ? 'row' : 'rows'
  const columnWord = columns === 1 ? 'column' : 'columns'
  return `Dataset opened · ${String(rows)} ${rowWord} · ${String(columns)} ${columnWord}`
}
