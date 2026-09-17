/**
 * Intent-level nested-data actions (m3-5) — the wiring layer between the two
 * click surfaces (m1-6 schema tree, m1-5 grid headers) and m3-4's pure SQL
 * composer.
 *
 * A surface never composes SQL itself: it emits a `NestedAction` describing
 * *what* the user wants ("flatten column meta", "extract path deep.a.b.c"),
 * and this module dispatches that intent through `nested-compose.ts` against
 * the app's parsed schema (`EngineColumnSchema` type strings parsed by
 * `schema/parseType.ts`) and the SQL-facing view name. The composed SQL is
 * then handed to the m2-4 SQL editor and executed there, so the user always
 * sees the statement that ran.
 *
 * Composition failures (`ComposedSql` `ok:false` — degenerate schema shapes
 * the UI's action gating cannot fully rule out, e.g. a zero-field STRUCT
 * column) are returned, never swallowed: the caller must surface `reason` as
 * a readable message. Security posture is inherited from the composer: every
 * identifier passes the engine's `quotedIdentifier`, path field names enter
 * as escaped single-quoted literals — hostile names stay in SQL context.
 */

import { explodeColumnSql, flattenColumnSql, pathExtractSql } from './nested-compose'
import type { ComposedSql, NestedColumnSpec, PathSegment } from './nested-compose'

/** One one-click nested operation, emitted by a schema-tree node or a grid header. */
export type NestedAction =
  | { readonly kind: 'flatten'; readonly column: string }
  | { readonly kind: 'explode'; readonly column: string }
  | { readonly kind: 'extract'; readonly path: readonly PathSegment[] }

/**
 * Compose the SQL for an action, or explain why it cannot be composed
 * (the reason must be surfaced, never dropped — see module comment).
 */
export function composeNestedAction(
  viewName: string,
  columns: readonly NestedColumnSpec[],
  action: NestedAction,
): ComposedSql {
  switch (action.kind) {
    case 'flatten':
      return flattenColumnSql(viewName, columns, action.column)
    case 'explode':
      return explodeColumnSql(viewName, columns, action.column)
    case 'extract':
      return pathExtractSql(viewName, action.path)
  }
}

/** Short visible verb rendered on an action button. */
export function nestedActionVerb(action: NestedAction): string {
  switch (action.kind) {
    case 'flatten':
      return 'Flatten'
    case 'explode':
      return 'Explode'
    case 'extract':
      return 'Extract path'
  }
}

/**
 * Full accessible name (and `title`) of an action button: announces what the
 * action does and on what — "Flatten struct column meta", "Extract path
 * deep.a.b.c". Purely display text (field names are untrusted content and
 * render as text only, ADR 0007 spirit).
 */
export function nestedActionLabel(action: NestedAction): string {
  switch (action.kind) {
    case 'flatten':
      return `Flatten struct column ${action.column}`
    case 'explode':
      return `Explode list column ${action.column}`
    case 'extract':
      return `Extract path ${action.path.join('.')}`
  }
}
