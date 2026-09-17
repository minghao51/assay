/**
 * Record inspector lifecycle state machine + freshness policy (m3-3) — pure
 * and Node-tested, so the stale-record rule is pinned without a DOM (repo
 * convention: thin components over tested pure modules, like m2-6's
 * `profile-state.ts`).
 *
 * Delivery here is synchronous (the row is read from the grid model's cache
 * at open time), so unlike the SQL/profile runs there is no in-flight async
 * tail — but the same generation-guard discipline still applies, because the
 * *ground* under an open record can shift: an accepted sort/filter starts a
 * fresh data epoch (`GridViewportModel.refresh()`), and grid row identity is
 * POSITIONAL in v1 (the model exposes row indices, not row keys — logical
 * row identity is ADR 0011 territory). The policy below is therefore keyed
 * on the query state the record was opened under, and each open carries a
 * `RunGuard` token (the SQL pane's guard, imported not forked) so the
 * component's render path is gated on an explicit, testable generation.
 */
import type { RecordTreeNode } from './record-tree'

/** The grid query state a record was opened under. */
export interface RecordContext {
  /** Active sort (`null` = dataset order) at open time. */
  readonly sort: { readonly column: string; readonly direction: 'asc' | 'desc' } | null
  /** Active filters in model order at open time. */
  readonly filters: readonly { readonly column: string; readonly predicate: string }[]
  /** Total row count at open time (changes under filters / re-reads). */
  readonly totalRows: number
}

export type RecordInspectorState =
  | { readonly kind: 'closed' }
  | {
      readonly kind: 'open'
      /** The grid row position the record was read from. */
      readonly rowIndex: number
      /** The `RunGuard` token begun for this open (active ⇒ current). */
      readonly token: number
      /** The full-depth tree, built once at open (an immutable snapshot). */
      readonly tree: RecordTreeNode
      readonly context: RecordContext
    }

export type RecordInspectorEvent =
  | {
      readonly type: 'opened'
      readonly rowIndex: number
      readonly token: number
      readonly tree: RecordTreeNode
      readonly context: RecordContext
    }
  /** User closed the inspector (button / Escape). */
  | { readonly type: 'closed' }
  /** The grid's query state shifted under the open record (freshness rule). */
  | { readonly type: 'epoch-shifted' }

export function reduceRecordInspector(
  _state: RecordInspectorState,
  event: RecordInspectorEvent,
): RecordInspectorState {
  switch (event.type) {
    case 'opened':
      return {
        kind: 'open',
        rowIndex: event.rowIndex,
        token: event.token,
        tree: event.tree,
        context: event.context,
      }
    case 'closed':
    case 'epoch-shifted':
      return { kind: 'closed' }
  }
}

/**
 * The pinned freshness policy (m3-3): **an epoch shift closes the inspector —
 * it never re-resolves the position and never keeps a stale snapshot.**
 *
 * Rationale, pinned here so the e2e can point at it: after an accepted
 * sort/filter the model starts a new data epoch in which row index N is a
 * different record (or the same record somewhere else — nothing observable
 * distinguishes the cases). Re-resolving index N would silently swap the
 * record the user is reading; keeping the snapshot would render values that
 * may no longer exist at that position *as if current*. Both are dishonest;
 * closing is honest and cheap. The user re-opens deliberately (one click /
 * Enter) if they still want a record.
 *
 * `totalRows` is included so a re-read that changes the count (filter accept,
 * external refresh) also closes, even when sort/filters happen to match.
 */
export function recordContextShifted(opened: RecordContext, current: RecordContext): boolean {
  if (opened.totalRows !== current.totalRows) return true
  if ((opened.sort === null) !== (current.sort === null)) return true
  if (
    opened.sort !== null &&
    current.sort !== null &&
    (opened.sort.column !== current.sort.column || opened.sort.direction !== current.sort.direction)
  ) {
    return true
  }
  if (opened.filters.length !== current.filters.length) return true
  for (let index = 0; index < opened.filters.length; index++) {
    const before = opened.filters[index]!
    const after = current.filters[index]
    if (after === undefined) return true
    if (before.column !== after.column || before.predicate !== after.predicate) return true
  }
  return false
}
