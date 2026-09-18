/**
 * Pending-change summary (m4-4) — the honest "what is staged?" line next to
 * the editing toolbar.
 *
 * The overlay *is* the preview (ADR 0012 staged changes): every edit is
 * applied to the effective view immediately and every op is visible in the
 * transformation-history panel and reversible through the cursor. There is
 * therefore no separate "commit to overlay" step to preview; what is useful
 * is a compact, honest count of the ops currently staged (the active history
 * prefix) so the user can see the session's shape at a glance before export
 * (the real commit, m4-5). This module owns the counting/labelling so it is
 * Node-tested; the toolbar owns the render.
 *
 * `describeOp` carries cell values for the history panel (local UI only);
 * this summary deliberately carries only *kinds and counts* — nothing
 * dataset-shaped ever leaves this function, which keeps the toolbar line
 * trivially safe if it is ever logged or copied.
 */
import type { EditOp } from '@assay/domain'

/** Singular human label per op kind (pluralized by `pendingChangesSummary`). */
const KIND_LABEL: Readonly<Record<EditOp['kind'], string>> = {
  'cell-set': 'cell edit',
  'cell-revert': 'cell revert',
  'row-insert': 'row insert',
  'row-uninsert': 'row expunge',
  'row-delete': 'row delete',
  'row-restore': 'row restore',
  'column-rename': 'column rename',
  'column-cast': 'column cast',
}

/** A deterministic kind → count map over a list of ops (every kind present). */
export function countOpsByKind(ops: readonly EditOp[]): Readonly<Record<EditOp['kind'], number>> {
  const counts: Record<EditOp['kind'], number> = {
    'cell-set': 0,
    'cell-revert': 0,
    'row-insert': 0,
    'row-uninsert': 0,
    'row-delete': 0,
    'row-restore': 0,
    'column-rename': 0,
    'column-cast': 0,
  }
  for (const op of ops) counts[op.kind] += 1
  return counts
}

/**
 * One readable line summarising the staged ops: `No pending changes.`, or
 * `3 pending changes: 2 cell edits, 1 column rename.` Kinds are listed in the
 * fixed `KIND_LABEL` order (never object-iteration order) so the string is
 * deterministic and testable.
 */
export function pendingChangesSummary(ops: readonly EditOp[]): string {
  if (ops.length === 0) return 'No pending changes.'
  const counts = countOpsByKind(ops)
  const parts: string[] = []
  for (const kind of Object.keys(KIND_LABEL) as EditOp['kind'][]) {
    const count = counts[kind]
    if (count === 0) continue
    const label = KIND_LABEL[kind]
    parts.push(`${String(count)} ${count === 1 ? label : `${label}s`}`)
  }
  const noun = ops.length === 1 ? 'change' : 'changes'
  return `${String(ops.length)} pending ${noun}: ${parts.join(', ')}.`
}
