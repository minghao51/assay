// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Row-diff binding-error taxonomy (m6-1) — the m5-1 `BindingError`
 * discipline applied to the row-diff plan compiler.
 *
 * `compileRowDiffPlan` is **total**: any input — validated or hostile,
 * behind a cast or behind throwing getters — yields either a
 * {@link RowDiffPlan} or collected {@link RowDiffBindingError}s — never a
 * throw, never a silent skip. All independent binding errors are collected
 * (documented order in `row-diff-compile.ts`), each with a machine-readable
 * `code`, an actionable `message`, and attribution: which side and which
 * column, where one exists.
 *
 * Messages echo offending names **exactly** (the m5-0/m6-0 never-echo
 * lesson): a name is rendered as `'name'` with no truncation, rounding, or
 * re-formatting — a NUL-carrying name keeps its NUL in the message, a
 * case-collision names both spellings verbatim. Plain data — render it
 * however the surface wants ({@link describeRowDiffBindingError} for the
 * canonical one-liner).
 */

import type { DiffSide } from './issues.js'
import { readField } from './guards.js'

/** Machine-readable row-diff binding-failure classes (see {@link RowDiffBindingError}). */
export type RowDiffBindingErrorCode =
  /** Compile options are malformed (relation names, sample limit) or unreadable (throwing getters). */
  | 'invalid-options'
  /** A schema side is unusable (not a readable array, malformed entries, NUL in a name/type) — the m6-0 `validateSchema` verdict, re-typed for binding. */
  | 'invalid-schema-input'
  /** A schema side contains an exactly-duplicated column name: qualified references would be ambiguous, so the compile fails (a plan must bind deterministically — stricter than the m6-0 report model, which degrades first-wins). */
  | 'duplicate-schema-column'
  /** The key set itself is not a readable array of non-empty strings, or a key name carries NUL. */
  | 'invalid-keys-input'
  /** The key set contains the same column twice — exactly, or up to case (DuckDB identifiers are case-insensitive, so two case-variants cannot be distinct key columns). */
  | 'duplicate-key-column'
  /** An empty key set: the compiler requires explicit keys — an empty set is a caller error, never an implicit guess (checkpoint C2). */
  | 'empty-key-set'
  /** The two schemas share no column at all: nothing can be key-matched or change-compared. Collected alongside the per-key `missing-key-column` errors it explains. */
  | 'no-shared-columns'
  /** A chosen key column does not exist on one side (attribution says which); one error per missing (side, key). */
  | 'missing-key-column'
  /**
   * A key column exists on both sides but the type spellings are not
   * compatible under the documented policy (`keyTypesCompatible`): cross-
   * family, unclassifiable-with-different-spellings, or JSON (refused on
   * both sides — JSON equality is textual, which would make key matching
   * approximate; the m5-1 `unique`-on-JSON honesty precedent).
   */
  | 'key-type-mismatch'

/** One row-diff binding failure. Plain data; never a throw (see module doc). */
export interface RowDiffBindingError {
  readonly code: RowDiffBindingErrorCode
  readonly message: string
  /** Which side the problem belongs to, when attributable to one. */
  readonly side?: DiffSide
  /** The offending column, when the problem is attributable to one. */
  readonly column?: string
}

/**
 * Canonical one-line rendering, compiler-style and greppable. Total: the
 * error is read through the guarded accessors, so a hostile object
 * (throwing getters, behind a cast) renders with `(unreadable)` in place
 * of what cannot be read — building the rendering must never throw.
 */
export function describeRowDiffBindingError(error: RowDiffBindingError): string {
  const codeRead = readField(error, 'code')
  const messageRead = readField(error, 'message')
  const sideRead = readField(error, 'side')
  const columnRead = readField(error, 'column')
  const code = codeRead.ok && typeof codeRead.value === 'string' ? codeRead.value : '(unreadable)'
  const message =
    messageRead.ok && typeof messageRead.value === 'string' ? messageRead.value : '(unreadable)'
  const side = sideRead.ok && typeof sideRead.value === 'string' ? sideRead.value : undefined
  const column =
    columnRead.ok && typeof columnRead.value === 'string' ? columnRead.value : undefined
  const where = side === undefined ? '' : `[side ${side}] `
  const at = column === undefined ? '' : ` (column '${column}')`
  return `${where}${code}${at}: ${message}`
}
