// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * EW-04I — the repair plan's **captured revision** and its staleness rule
 * (EW-04D §2, §3 item 3; U2).
 *
 * A preview is a fact about one *view*: the fold of a base version and a
 * history prefix. EW-04D §2 fixes exactly what a plan captures, and the
 * cast-path precedent (`useEditingSession`'s `historyRevision` check) fixes how
 * it is used — tag the preview, compare at render, and re-verify at the moment
 * of publication; never re-read a value and call it fresh.
 *
 * The tag carries:
 *
 * 1. **Identity** — `baseAnchor` + `overlayAnchor` (a different file version or
 *    editing session ⇒ stale: the survival boundary in `row-identity.ts`),
 * 2. **History position** — `cursor` plus the session's monotonic history
 *    revision (any op, undo, redo, cursor jump or reset ⇒ stale). The revision
 *    is the catch-all: every history activation bumps it, so it also covers
 *    the schema changes below,
 * 3. **Schema fingerprint** — the whole effective schema signature plus the
 *    target column's own name/type, so a `column-rename`/`column-cast` is
 *    legible as a staleness *reason* and not only as an opaque revision bump.
 *
 * What it deliberately does **not** carry — and never captures — is grid
 * filter/sort/paging state (EW-04D §2: "scope is whole-effective only";
 * re-sorting/re-filtering/paging **never** invalidates). A sort or filter
 * cannot make a preview stale because it is not part of the tag: that is the
 * mechanism, not a convention.
 *
 * Purity: comparisons only, no React, no engine, no I/O.
 */
import type { OverlayBase, OverlayState, TransformationHistory } from '@assay/domain'

/** The captured revision of one repair plan/preview. */
export interface RepairCaptureTag {
  readonly baseAnchor: string
  readonly overlayAnchor: string
  readonly cursor: number
  /** The session's monotonic history revision at capture. */
  readonly historyRevision: number
  /** The target column's effective name and declared type at capture. */
  readonly column: string
  readonly columnType: string
  /** The whole effective schema's signature at capture (ordered name:type). */
  readonly schemaSignature: string
}

/**
 * A stable signature for the effective schema: ordered `name:type` pairs
 * joined by a separator that cannot occur in an identifier/type. Compared as a
 * string; not a digest (ADR 0007 — no invented hashing).
 */
export function schemaSignature(state: OverlayState): string {
  return state.columns.map((column) => `${column.name}:${column.type}`).join('\u0000')
}

/**
 * Capture the tag for `column` from a live session view. Returns `null` when
 * the column is not in the effective schema (the caller refuses; a plan can
 * never target a column the fold does not have).
 */
export function repairCaptureTag(
  base: OverlayBase,
  history: TransformationHistory,
  state: OverlayState,
  historyRevision: number,
  column: string,
): RepairCaptureTag | null {
  const spec = state.columns.find((candidate) => candidate.name === column)
  if (spec === undefined) return null
  return {
    baseAnchor: base.baseAnchor,
    overlayAnchor: base.overlayAnchor,
    cursor: history.cursor,
    historyRevision,
    column,
    columnType: spec.type,
    schemaSignature: schemaSignature(state),
  }
}

/**
 * Whether a captured tag still describes the live session. Every field is
 * compared, so each captured fact is independently load-bearing: an anchor
 * change (new file version/session), a cursor move, any history activation
 * (the revision), a schema change, or a type change on the target column all
 * make the preview stale.
 */
export function captureIsStale(tag: RepairCaptureTag, current: RepairCaptureTag | null): boolean {
  if (current === null) return true
  return (
    tag.baseAnchor !== current.baseAnchor ||
    tag.overlayAnchor !== current.overlayAnchor ||
    tag.cursor !== current.cursor ||
    tag.historyRevision !== current.historyRevision ||
    tag.column !== current.column ||
    tag.columnType !== current.columnType ||
    tag.schemaSignature !== current.schemaSignature
  )
}

/**
 * What publication needs from the preview: the revision it was read under and
 * the complete affected count. Both are re-verified at append time — the
 * revision against the live session (U2) and the count against zero (U1) — so
 * a preview that drifted, or a plan that changes nothing, can never append an
 * entry.
 */
export interface RepairApplyGuard {
  readonly tag: RepairCaptureTag
  readonly affected: number
}
