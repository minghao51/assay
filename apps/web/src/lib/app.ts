// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Phase } from '../sessions/types'

export const APP_NAME = 'Assay' as const

/** The descriptive tagline — "data workbench" is the category, Assay is the product (ADR 0039). */
export const TAGLINE = 'The local-first data workbench' as const

/** Keep in sync with the roadmap status (docs/product/03-execution-roadmap.md §4 and
 * docs/product/04-post-mvp-track.md). Honest as of 2026-09-22 (audit AR-W6): the MVP
 * (M0–M6) is complete; the post-MVP track is underway. */
export const SCAFFOLD_STATUS = 'MVP complete (M0–M6) — post-MVP track in progress' as const

export const NEXT_MILESTONE =
  'PT-0: launch readiness to gate G0 (then the D12-chosen engineering track)' as const

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
