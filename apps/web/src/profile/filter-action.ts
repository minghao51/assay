// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ug-16 — profile click-to-act planning, pure and Node-testable (the repo's
 * convention: thin components over a tested pure module).
 *
 * A profile statistic is **base-derived** (R-16): `profile(handle)` reads the
 * file as opened, while the grid and filters run on the overlay-effective
 * view. Before compiling a filter for a clicked statistic this module resolves
 * the profile's base column against the *current* effective schema
 * (`resolveProfileColumn`) and then compiles the operator+value with the
 * existing grid builder (`compileFilterInput`) against the **effective**
 * column's type — never the base type, never a coerced literal:
 *
 * - resolved → `apply` with the exact predicate the builder produced;
 * - renamed → `refuse` with the byte-exact copy naming both names;
 * - unresolved → `refuse` with the byte-exact generic copy;
 * - a builder rejection (e.g. the base value does not bind to a cast type) →
 *   `refuse` with the builder's own readable, value-free message.
 *
 * The caller (App) applies `apply` through `replaceColumnFilter` +
 * `GridViewportModel.setFilters`; `refuse` changes no filter state and makes no
 * engine call. Copy is value-free (column names are schema, never cell
 * values; ADR 0025) and is rendered as text only.
 */
import type { EditOp } from '@assay/domain'
import { classifyColumnType, compileFilterInput } from '../grid/filter-builder'
import { resolveProfileColumn } from '../edit/session'

/**
 * ug-16 design §4.3 — byte-exact renamed-column refusal (straight ASCII
 * quotes, em dash U+2014). Both names are schema vocabulary; no value, no
 * filename, no engine text.
 */
export function renamedColumnRefusal(base: string, current: string): string {
  return `This column is now "${current}" in the edited view. The profile still uses the file's original name, "${base}" — use "${current}" in Filters instead.`
}

/**
 * ug-16 design §4.3 — byte-exact generic refusal for a base column that does
 * not resolve on the edited view (e.g. a future column-drop, or a rename chain
 * whose end is gone).
 */
export const UNRESOLVED_COLUMN_REFUSAL =
  'This column is not in the edited view. The profile describes the file as opened — undo the change or re-open the file to filter by it.'

/** What the user clicked in the profile: a top-k value or the null count. */
export type ProfileFilterIntent =
  { readonly kind: 'value'; readonly value: string } | { readonly kind: 'null' }

/** The outcome of planning one profile click. */
export type ProfileFilterPlan =
  /** Apply this exact predicate to this (effective) column. */
  | { readonly kind: 'apply'; readonly column: string; readonly predicate: string }
  /** Apply nothing; show this single-line, value-free message. */
  | { readonly kind: 'refuse'; readonly message: string }

/**
 * Plan one profile click against the active ops and the effective schema.
 *
 * The profile's `baseColumn` is resolved first (renamed/unresolved refuse with
 * no filter), then the clicked intent is compiled with the grid's own builder
 * against the effective column type. A builder rejection is returned verbatim
 * in the refusal slot — no coercion, no remap, no engine call.
 */
export function planProfileFilter(
  baseColumn: string,
  intent: ProfileFilterIntent,
  ops: readonly EditOp[],
  effectiveSchema: readonly { readonly name: string; readonly type: string }[],
): ProfileFilterPlan {
  const resolution = resolveProfileColumn(baseColumn, ops, effectiveSchema)
  if (resolution.kind === 'renamed') {
    return { kind: 'refuse', message: renamedColumnRefusal(resolution.base, resolution.current) }
  }
  if (resolution.kind === 'unresolved') {
    return { kind: 'refuse', message: UNRESOLVED_COLUMN_REFUSAL }
  }

  const column = resolution.column
  const effective = effectiveSchema.find((entry) => entry.name === column)
  // The resolver only returns `resolved` for a name in this schema; the guard
  // keeps the module total if a caller passes an inconsistent pair.
  if (effective === undefined) return { kind: 'refuse', message: UNRESOLVED_COLUMN_REFUSAL }

  const profile = classifyColumnType(effective.type)
  const compiled =
    intent.kind === 'null'
      ? compileFilterInput(profile, 'is-null', '')
      : compileFilterInput(profile, 'eq', intent.value)
  if (!compiled.ok) return { kind: 'refuse', message: compiled.message }
  return { kind: 'apply', column, predicate: compiled.predicate }
}
