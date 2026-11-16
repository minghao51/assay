// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Typed edit operations for the Assay edit overlay (m4-1; ADR 0012).
 *
 * These ops are the *entire* user-facing editing vocabulary: the web grid
 * (m4-3/m4-4) produces them, the transformation history logs them, and the
 * engine (m4-2) materializes their fold (see `overlay.ts`) as composed SQL
 * over the immutable base view — the base is never mutated in place
 * (ADR 0012). The union is closed and every op has a derivable inverse op
 * within this same union, which is what makes undo/redo expressible as log
 * entries rather than out-of-band commands ("inverses are true inverses" is
 * property-tested in `overlay.test.ts`).
 *
 * Value honesty (queue requirement): a `null` cell is *data*, not absence.
 * {@link CellValue} makes null a first-class tagged kind, so "set this cell
 * to NULL" and "no change to this cell" can never be confused at a JSON or
 * worker boundary. Deliberate v1 narrowing: values cover the scalar spaces a
 * grid cell edit produces; nested values (lists/structs) are out of scope
 * until M4 editing surfaces a need — engines keep rendering them read-only.
 *
 * **`column-repair` (EW-04D; ADR 0050).** One authored value function
 * `trim∘map` over a whole column (exact whole-value mapping, optionally
 * preceded by an edge trim over an explicit code-point set). Its effect is a
 * property of the *prefix* (EW-04D §6.2 forward position-order composition
 * over the cursor underlying value), so it has no inverse op list: an
 * applied repair logs `inverse: []` with the `AppliedNote`
 * `'undo-by-refold'`, and undo is the exact refold at the moved cursor
 * (ADR 0050). {@link OP_UNDO_MODE} is the explicit per-kind table that
 * declares, for every op kind, whether undo is an inverse list or a refold,
 * so a new kind cannot skip the declaration.
 *
 * Purity: this module is types + total pure helpers only — no React, no
 * browser APIs, no engine imports (docs/engineering/03 §3, lint-enforced).
 */
import type { RowId } from './row-identity.js'

/**
 * One cell value, tagged so "NULL" is data and absence is absence.
 *
 * - `{ kind: 'null' }` — the SQL/Arrow NULL: a real value a cell can hold.
 * - `boolean` / `number` / `string` — the JS-natural scalar spaces.
 * - `text` — an engine-parseable literal handed to the engine *as text* and
 *   cast engine-side under the column's type. This is the honest escape
 *   hatch for value spaces a JS number would corrupt (64-bit integers,
 *   decimals, dates/timestamps): the domain refuses to pretend they fit in a
 *   double. Engines map `text` to a typed literal of the column's type
 *   (m4-2); a value that fails the engine's cast surfaces as that op's
 *   materialization failure — validation is deliberately deferred to the
 *   engine, which owns the type space.
 */
export type CellValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'text'; readonly text: string }

/** The canonical NULL value (a cell that is genuinely NULL is *data*). */
export const NULL_VALUE: CellValue = { kind: 'null' }

/**
 * Structural equality for cell values, `Object.is` semantics on payloads:
 * `NaN` equals `NaN` (one canonical NaN per engine), `0` and `-0` differ
 * (they can serialize differently), kinds must match (`'text'` never equals
 * `'string'`). Used by the fold's no-op detection — see `overlay.ts`.
 *
 * Note (au3-12): a user-entered `-0` over a `0` base is therefore a real
 * edit here, but the engine's SQL number-literal renderer normalizes it to
 * `+0` at the single documented boundary (overlay-query.ts) — the edit
 * materializes and exports as `0` in every format (JSON.stringify(-0) is
 * also `'0'`). Genuine base-data `-0.0` round-trips untouched; only
 * user-entered literals normalize. */

export function cellValueEqual(a: CellValue, b: CellValue): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'null':
      return true
    case 'boolean':
      return a.value === (b as { readonly value: boolean }).value
    case 'number':
      return Object.is(a.value, (b as { readonly value: number }).value)
    case 'string':
      return a.value === (b as { readonly value: string }).value
    case 'text':
      return a.text === (b as { readonly text: string }).text
  }
}

/**
 * One column of the effective schema. `type` is an **opaque portable string
 * in the engine's own type space** (e.g. DuckDB's `DESCRIBE` output) — the
 * domain never interprets or validates it; engines map it to their natives
 * (M4 queue: "type space as an opaque/portable string, not an engine enum").
 */
export interface ColumnSpec {
  readonly name: string
  readonly type: string
}

/**
 * Where a row-insert asks for its row to appear in the *effective* order.
 * Anchors reference logical row ids — never positions — so an insert keeps
 * its meaning under re-sort/re-filter. Resolution is deferred to emission
 * (`effectiveRowIds` in `overlay.ts`): an anchor that is not live at
 * emission time degrades deterministically to the end (documented there),
 * and the fold notes the degradation on the outcome at apply time.
 */
export type InsertPosition =
  | { readonly kind: 'start' }
  | { readonly kind: 'end' }
  | { readonly kind: 'before'; readonly rowId: RowId }
  | { readonly kind: 'after'; readonly rowId: RowId }

/** Columns absent from the map materialize as NULL (documented v1 rule). */
export type CellValueRecord = ReadonlyMap<string, CellValue>

/**
 * The closed vocabulary of edit operations (ADR 0012 overlay). `cell-revert`
 * and `row-restore` extend the queue's minimum five so that *every* applied
 * op has an inverse *within this union* — they are also genuine user
 * affordances ("revert this cell", "restore deleted row"), not machinery.
 */
export type EditOp =
  /** Set one cell of a live row to a value (which may be {@link NULL_VALUE}). */
  | {
      readonly kind: 'cell-set'
      readonly rowId: RowId
      readonly column: string
      readonly value: CellValue
    }
  /** Drop the overlay edit for one cell; the base value stands again. */
  | { readonly kind: 'cell-revert'; readonly rowId: RowId; readonly column: string }
  /** Insert a new row with the overlay-assigned id at the given position. */
  | {
      readonly kind: 'row-insert'
      readonly rowId: RowId
      readonly position: InsertPosition
      readonly values: CellValueRecord
    }
  /**
   * Expunge an inserted row *entirely* — record, cell edits and slot
   * allocation gone. This is the exact inverse of `row-insert` (derived for
   * undo; "inverses are true inverses" is property-tested against it).
   * UIs will usually expose `row-delete` instead, which keeps the record
   * restorable. Undoing an expunge is a small op list (re-insert + cell
   * edits) — see `OpApplication.inverse` in `overlay.ts`.
   */
  | { readonly kind: 'row-uninsert'; readonly rowId: RowId }
  /** Tombstone one live row (base or inserted); reversible via `row-restore`. */
  | { readonly kind: 'row-delete'; readonly rowId: RowId }
  /** Un-tombstone a deleted row; its cell edits and (for inserts) values are intact. */
  | { readonly kind: 'row-restore'; readonly rowId: RowId }
  /** Rename a column; accumulated edits and insert values are re-keyed. */
  | { readonly kind: 'column-rename'; readonly from: string; readonly to: string }
  /** Cast a column to a target type in the engine's type space (opaque string). */
  | { readonly kind: 'column-cast'; readonly column: string; readonly targetType: string }
  /**
   * Repair one whole text column with the composed value function
   * `trim∘map` (EW-04D §4.2, D11): an exact, simultaneous, whole-value
   * `mapping`, optionally preceded by an edge-only `trim` over an explicit
   * code-point set ({@link MAX_REPAIR_TRIM_CODE_POINTS} code points max;
   * never a default-`trim()` — NBSP and friends are *not* members unless the
   * plan says so). `NULL` never matches and is never produced; `''` is data
   * and matchable only as an explicit key; a non-matching value's passthrough
   * is its trimmed value. The column must be a textual spelling
   * ({@link isTextualRepairType}) — `trim()` on a non-text type is a Binder
   * Error and the string-*like* family is wider than the repairable set
   * (`ENUM` re-declares as `VARCHAR` under the wrap; D16/D17 probe §4.2).
   *
   * One history entry, one undo step (ADR 0050): `inverse: []` + the
   * `'undo-by-refold'` note on the applied outcome; undo/redo are the usual
   * cursor moves and the state is the refold of the active prefix.
   */
  | {
      readonly kind: 'column-repair'
      readonly column: string
      /**
       * Explicit edge-trim code-point set (applied *before* the mapping),
       * `1..{@link MAX_REPAIR_TRIM_CODE_POINTS}` code points. Absent ⇒ no
       * trim (the mapping matches raw values exactly). D1's recommended
       * default is {@link DEFAULT_REPAIR_TRIM_CODE_POINTS}.
       */
      readonly trim?: string
      /** Exact whole-value mapping applied to the (trimmed) value. */
      readonly mapping: ReadonlyMap<string, string>
    }

/**
 * The closed explicit code-point universe of a `column-repair` trim set is
 * whatever the plan declares — the D1 *recommended default* is the four
 * ASCII edge characters below (probes P4/D1: `String.prototype.trim()`'s
 * implicit set is wrong for repair — it strips NBSP and friends and keeps
 * tab/LF/CR — so the engine must always trim with the explicit set).
 */
export const DEFAULT_REPAIR_TRIM_CODE_POINTS = '\u0020\u0009\u000A\u000D'

/** Plan cap: at most this many mapping pairs in one `column-repair` (EW-04D §4.4). */
export const MAX_REPAIR_MAPPING_PAIRS = 500

/** Plan cap: at most this many code points in a `column-repair` trim set (EW-04D §4.4). */
export const MAX_REPAIR_TRIM_CODE_POINTS = 16

/**
 * The engine-declared column types a `column-repair` may target: exactly the
 * textual spellings whose values are text and whose `trim()` is total
 * (D16/D17 probe §4.2 constraint 1). Deliberately **narrower** than the
 * CSV guard's string-*like* family: `ENUM` renders as text but a repair's
 * `trim()` re-declares the column as `VARCHAR`, and `CHAR`/`BPCHAR` would
 * silently widen the declared type the same way — neither re-declaration is
 * accepted, so both are refused here. The type is the engine's declared
 * spelling (case-insensitive); the fold refuses anything else with the
 * typed `repair-column-not-text` conflict.
 */
const REPAIRABLE_TEXT_TYPE_SPELLINGS: ReadonlySet<string> = new Set(['VARCHAR', 'TEXT', 'STRING'])

/** Whether an engine-declared type is a textual repair target (see above). */
export function isTextualRepairType(type: string): boolean {
  return REPAIRABLE_TEXT_TYPE_SPELLINGS.has(type.toUpperCase())
}

/**
 * Strip the maximal prefix and suffix runs of characters from the explicit
 * `set` (edge-only, repeated, interior untouched) — the domain's trim∘map
 * trim half. Iterates by code point so astral set members work; never uses
 * `String.prototype.trim()` (its implicit set is not the plan's set). This
 * is the single implementation the engine's D17 literal rewrite shares with
 * the fold, so the TypeScript and SQL sides cannot drift.
 */
export function trimWithCodePoints(value: string, set: string): string {
  // `members` are single code points (`[...set]` iterates by code point), so
  // each member is one code unit or a surrogate pair — `startsWith` at the
  // scanning offset matches astral members exactly, including on the suffix
  // walk (a backward `codePointAt` would see the lone low surrogate half).
  const members = [...set]
  let start = 0
  let end = value.length
  while (start < end) {
    const member = members.find((candidate) => value.startsWith(candidate, start))
    if (member === undefined) break
    start += member.length
  }
  while (end > start) {
    const member = members.find(
      (candidate) =>
        end - candidate.length >= start && value.startsWith(candidate, end - candidate.length),
    )
    if (member === undefined) break
    end -= member.length
  }
  return value.slice(start, end)
}

/** How undo of one op kind is performed (ADR 0050 resolution 2). */
export type OpUndoMode =
  /** The entry carries a derived inverse op list (every kind before EW-04D). */
  | 'inverse'
  /** The entry carries `inverse: []`; undo is the exact refold at the cursor. */
  | 'refold'

/**
 * The explicit per-kind undo-mode table (ADR 0050 acceptance resolution 2):
 * every `EditOp` kind must declare refoldable-or-inverse, so a future kind
 * cannot skip the declaration and silently inherit either behaviour. Only
 * prefix-function ops may be `'refold'` (resolution 3); `column-repair` is
 * the one member licensed by ADR 0050.
 */
export const OP_UNDO_MODE: Readonly<Record<EditOp['kind'], OpUndoMode>> = {
  'cell-set': 'inverse',
  'cell-revert': 'inverse',
  'row-insert': 'inverse',
  'row-uninsert': 'inverse',
  'row-delete': 'inverse',
  'row-restore': 'inverse',
  'column-rename': 'inverse',
  'column-cast': 'inverse',
  'column-repair': 'refold',
}

/**
 * Human-readable, deterministic description of one op — the m4-4 history
 * panel renders these directly. Descriptions intentionally include cell
 * values and row/column names: they are the user's own local UI.
 *
 * **Privacy invariant (ADR 0025, mechanical at the definition site):** the
 * output of this function (and of {@link formatCellValue}) embeds dataset
 * values, so it may be rendered to the local user and never logged,
 * persisted, telemetered, or transmitted — no field of an `EditOp` may ever
 * reach telemetry. Callers must treat the returned string as local UI
 * content, never as a log line. NULL renders as `NULL`, never
 * "empty"/"cleared" — a NULL cell is data.
 */
export function describeOp(op: EditOp): string {
  switch (op.kind) {
    case 'cell-set':
      return `set ${formatName(op.column)} on row ${op.rowId} to ${formatCellValue(op.value)}`
    case 'cell-revert':
      return `revert ${formatName(op.column)} on row ${op.rowId} to base value`
    case 'row-insert':
      return `insert row ${op.rowId} ${formatPosition(op.position)}`
    case 'row-uninsert':
      return `expunge inserted row ${op.rowId}`
    case 'row-delete':
      return `delete row ${op.rowId}`
    case 'row-restore':
      return `restore row ${op.rowId}`
    case 'column-rename':
      return `rename column ${formatName(op.from)} to ${formatName(op.to)}`
    case 'column-cast':
      return `cast column ${formatName(op.column)} to ${op.targetType}`
    case 'column-repair': {
      // Value-free for the plan payload (the mapping keys/targets are dataset
      // content — ADR 0025): the description carries the column name and the
      // plan's *shape* only, never a mapping entry or the trim characters.
      const parts: string[] = [`${op.mapping.size} mapping pairs`]
      if (op.trim !== undefined) parts.push('edge trim')
      return `repair column ${formatName(op.column)} (${parts.join(', ')})`
    }
  }
}

function formatName(name: string): string {
  return JSON.stringify(name)
}

/**
 * Render one cell value for local UI display. **Privacy invariant (ADR
 * 0025):** the result contains a dataset value; it is display-only and must
 * never be logged or transmitted (see {@link describeOp}).
 */
function formatCellValue(value: CellValue): string {
  switch (value.kind) {
    case 'null':
      return 'NULL'
    case 'boolean':
      return value.value ? 'true' : 'false'
    case 'number':
      return String(value.value)
    case 'string':
      return JSON.stringify(value.value)
    case 'text':
      return `text ${JSON.stringify(value.text)}`
  }
}

function formatPosition(position: InsertPosition): string {
  switch (position.kind) {
    case 'start':
      return 'at start'
    case 'end':
      return 'at end'
    case 'before':
      return `before row ${position.rowId}`
    case 'after':
      return `after row ${position.rowId}`
  }
}
