// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Structural validation for overlay payloads crossing the worker boundary
 * (m4-2). The overlay request carries the host's base metadata plus its op
 * list as plain structured-clone data; the worker is untrusted-boundary by
 * design (mirroring `parseEngineRequest`), so everything is re-validated
 * here before the domain fold ever sees it.
 *
 * What is checked here is *structure only* — the exact same policy the rest
 * of the protocol parser applies:
 * - ids/columns/names/anchors must be strings (semantic shape — canonical
 *   `RowId` grammar, unknown columns, foreign anchors — is the fold's job,
 *   which reports typed conflicts instead of rejecting the request);
 * - cell values must carry one of the five tagged kinds with a payload of
 *   the right type (`text` included — the engine-parseable literal cast);
 * - insert values must arrive as a real `Map<string, CellValue>` (the
 *   domain's `CellValueRecord` — structured clone preserves Maps, so hosts
 *   pass domain records verbatim; a plain object is a caller bug and is
 *   rejected rather than coerced);
 * - base column names must be unique (the host contract from
 *   `OverlayBase`) and `baseRowCount` a safe non-negative integer;
 * - **every engine type expression must be exactly one complete DuckDB type**
 *   (`type-expr.ts`): base `columns[].type` and `column-cast.targetType` are
 *   interpolated into SQL type positions by the composer, so an invalid
 *   spelling (statement separators, comments, unbalanced brackets, trailing
 *   tokens, …) rejects the whole payload here — the untrusted boundary — and
 *   again in the composer (`overlay-query.ts`). The m4-2 review's payload
 *   `VARCHAR) AS "c" FROM (...) ); CREATE TABLE assay_injected …` is rejected
 *   by this check.
 *
 * The returned objects are the *domain* types (`OverlayBase`, `EditOp[]`) —
 * the composer and fold consume them directly; no second mapping layer.
 */
import type { CellValue, EditOp, InsertPosition, OverlayBase, RowId } from '@assay/domain'
import { validateEngineTypeExpression } from './type-expr.js'

/** The overlay payload every overlay request carries (base + op list). */
export interface EngineOverlayPayload {
  readonly base: OverlayBase
  readonly ops: readonly EditOp[]
}

/** Parse one `CellValue` from boundary data; `null` when malformed. */
function parseCellValue(value: unknown): CellValue | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  switch (record['kind']) {
    case 'null':
      return { kind: 'null' }
    case 'boolean':
      return typeof record['value'] === 'boolean'
        ? { kind: 'boolean', value: record['value'] }
        : null
    case 'number':
      return typeof record['value'] === 'number' ? { kind: 'number', value: record['value'] } : null
    case 'string':
      return typeof record['value'] === 'string' ? { kind: 'string', value: record['value'] } : null
    case 'text':
      return typeof record['text'] === 'string' ? { kind: 'text', text: record['text'] } : null
    default:
      return null
  }
}

function isCellValueMap(value: unknown): value is ReadonlyMap<string, CellValue> {
  if (!(value instanceof Map)) return false
  for (const [key, cell] of value) {
    if (typeof key !== 'string') return false
    if (parseCellValue(cell) === null) return false
  }
  return true
}

function isStringRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, string> {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return fields.every((field) => typeof record[field] === 'string')
}

/**
 * Structural form of `validateEngineTypeExpression`: `true` exactly when the
 * string is one complete DuckDB type expression. Used by the payload parser
 * (a malformed type rejects the payload, the parser's never-throws contract),
 * by `assertValidOverlayTypes` (which surfaces the typed error), and by the
 * protocol parser for the standalone `engine/overlay-cast-check` target type.
 */
export function isEngineTypeExpression(value: unknown): value is string {
  try {
    validateEngineTypeExpression(value)
    return true
  } catch {
    return false
  }
}

/**
 * Validate every engine type expression an overlay carries — base column
 * types and `column-cast` target types — as exactly one complete DuckDB type.
 * Throws the typed `EngineTypeError` on the first invalid expression.
 *
 * `parseOverlayPayload` calls this indirectly through the per-field check
 * (returning `null` for the reject-and-drop boundary contract); the
 * main-thread client calls it directly so a hostile overlay fails fast with
 * a typed `EngineOperationError` instead of being silently dropped by the
 * worker (which would hang the caller). Both are the same validator, applied
 * at both sides of the untrusted boundary — the composer applies it a third
 * time as defence in depth (`overlay-query.ts`).
 */
export function assertValidOverlayTypes(payload: {
  readonly base: OverlayBase
  readonly ops?: readonly EditOp[]
}): void {
  for (const column of payload.base.columns) {
    validateEngineTypeExpression(column.type)
  }
  for (const op of payload.ops ?? []) {
    if (op.kind === 'column-cast') validateEngineTypeExpression(op.targetType)
  }
}

/**
 * Parse one op of the closed 9-kind union; `null` when malformed.
 * (Documented above: `row-uninsert`/`row-delete`/`row-restore` share the
 * `{ kind, rowId }` shape, so the switch falls through by design.)
 */
function parseEditOp(value: unknown): EditOp | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const rowId = record['rowId']
  switch (record['kind']) {
    case 'cell-set': {
      const cell = parseCellValue(record['value'])
      if (typeof rowId !== 'string' || typeof record['column'] !== 'string' || cell === null) {
        return null
      }
      return { kind: 'cell-set', rowId: rowId as RowId, column: record['column'], value: cell }
    }
    case 'cell-revert':
      return typeof rowId === 'string' && typeof record['column'] === 'string'
        ? { kind: 'cell-revert', rowId: rowId as RowId, column: record['column'] }
        : null
    case 'row-insert': {
      if (typeof rowId !== 'string' || !isCellValueMap(record['values'])) return null
      const position = parseInsertPosition(record['position'])
      return position === null
        ? null
        : { kind: 'row-insert', rowId: rowId as RowId, position, values: record['values'] }
    }
    case 'row-uninsert':
    case 'row-delete':
    case 'row-restore':
      return typeof rowId === 'string'
        ? ({ kind: record['kind'], rowId: rowId as RowId } as EditOp)
        : null
    case 'column-rename':
      return isStringRecord(record, ['from', 'to'])
        ? { kind: 'column-rename', from: record['from'], to: record['to'] }
        : null
    case 'column-cast':
      if (!isStringRecord(record, ['column', 'targetType'])) return null
      if (!isEngineTypeExpression(record['targetType'])) return null
      return { kind: 'column-cast', column: record['column'], targetType: record['targetType'] }
    case 'column-repair': {
      // Bounded structural shape only (EW-04D §8): the column is a string,
      // the trim (when present) a string, and the mapping a real
      // `Map<string, string>` (structured clone preserves Maps, the same
      // policy as insert values — a plain object is a caller bug and is
      // rejected rather than coerced). Semantic bounds — the pair cap, the
      // 16-code-point trim cap, dead keys, textual-column gating — are the
      // fold's typed refusals (edit-ops.ts/overlay.ts), never re-decided
      // here; the parser rejects malformed structure and foreign kinds with
      // `null` like every other op arm.
      if (typeof record['column'] !== 'string') return null
      const rawTrim = record['trim']
      if (rawTrim !== undefined && rawTrim !== null && typeof rawTrim !== 'string') return null
      const rawMapping = record['mapping']
      if (!(rawMapping instanceof Map)) return null
      const mapping = new Map<string, string>()
      for (const [key, value] of rawMapping) {
        if (typeof key !== 'string' || typeof value !== 'string') return null
        mapping.set(key, value)
      }
      return typeof rawTrim === 'string'
        ? { kind: 'column-repair', column: record['column'], trim: rawTrim, mapping }
        : { kind: 'column-repair', column: record['column'], mapping }
    }
    default:
      return null
  }
}

function parseInsertPosition(value: unknown): InsertPosition | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record['kind'] === 'start') return { kind: 'start' }
  if (record['kind'] === 'end') return { kind: 'end' }
  if (
    (record['kind'] === 'before' || record['kind'] === 'after') &&
    typeof record['rowId'] === 'string'
  ) {
    return record['kind'] === 'before'
      ? { kind: 'before', rowId: record['rowId'] as RowId }
      : { kind: 'after', rowId: record['rowId'] as RowId }
  }
  return null
}

/**
 * Parse an overlay payload — the `{ base, ops }` shape the protocol's
 * `overlay` field carries — from boundary data. Returns `null` for anything
 * structurally malformed (the request is then ignored/rejected by the
 * protocol layer, like every other malformed request) — never a throw.
 */
export function parseOverlayPayload(value: unknown): EngineOverlayPayload | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const rawBase = record['base']
  if (typeof rawBase !== 'object' || rawBase === null) return null
  const baseRecord = rawBase as Record<string, unknown>
  if (
    !isStringRecord(baseRecord, ['baseAnchor', 'overlayAnchor']) ||
    typeof baseRecord['baseRowCount'] !== 'number' ||
    !Number.isSafeInteger(baseRecord['baseRowCount']) ||
    baseRecord['baseRowCount'] < 0
  ) {
    return null
  }
  const rawColumns = baseRecord['columns']
  if (!Array.isArray(rawColumns)) return null
  const columns = rawColumns.map((column) => {
    if (!isStringRecord(column, ['name', 'type'])) return null
    if (!isEngineTypeExpression(column['type'])) return null
    return { name: column['name'], type: column['type'] }
  })
  if (columns.some((column) => column === null)) return null
  const seen = new Set<string>()
  for (const column of columns) {
    if (seen.has(column!.name)) return null // host contract: unique base names
    seen.add(column!.name)
  }
  const rawOps = record['ops']
  if (rawOps !== undefined && !Array.isArray(rawOps)) return null
  const ops: EditOp[] = []
  for (const rawOp of rawOps ?? []) {
    const op = parseEditOp(rawOp)
    if (op === null) return null
    ops.push(op)
  }
  return {
    base: {
      baseAnchor: baseRecord['baseAnchor'],
      overlayAnchor: baseRecord['overlayAnchor'],
      baseRowCount: baseRecord['baseRowCount'],
      columns: columns as OverlayBase['columns'],
    },
    ops,
  }
}
