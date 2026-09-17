/**
 * Pure SQL composition for the three nested-data operations (m3-4):
 *
 * - **flatten** — a STRUCT column replaced by one aliased child column per
 *   struct field (`flattenColumnSql`),
 * - **explode** — a LIST column turned into rows with a 1-based element
 *   position (`explodeColumnSql`),
 * - **path extraction** — a bracket path into nested columns
 *   (`pathExtractSql`).
 *
 * The composed statements run in the m2-4 SQL editor + result pane, which
 * wraps them as `SELECT * FROM (<this sql>) AS _assay_page LIMIT … OFFSET …`
 * — that is why every output alias is a *quoted* identifier (dotted names
 * like `"meta.src"` stay one column, never a qualifier/object pair). m3-5
 * wires the schema-tree/header click paths; this module only composes.
 *
 * Purity: no engine calls at runtime. Inputs are the app's parsed schema
 * (`EngineColumnSchema` type strings parsed by `schema/parseType.ts`); the
 * DuckDB CLI (v1.5.5) was used only to *derive and verify* the pinned
 * semantics, with the recorded evidence quoted in `nested-compose.test.ts`.
 *
 * Semantics decided against the CLI (all verified on DuckDB 1.5.5, evidence
 * in the test file):
 *
 * - **Explode construct:** FROM-clause `UNNEST(<list expr>) WITH ORDINALITY`
 *   (supported in 1.5.5) with a composer-owned row-source alias
 *   `_assay_explode`. It keeps the other columns (comma-join row context),
 *   exposes the 1-based element position as a column, and lets list-of-struct
 *   element fields be addressed through the alias (`u.ev.at` — verified).
 *   The SELECT-list `unnest` + `generate_subscripts` pairing was also
 *   verified to align element-wise, but the FROM-clause form expresses the
 *   same semantics with one construct and named ordinality.
 * - **NULL/empty lists:** a NULL list yields **one row with a NULL element
 *   (position 1)** — the parent row is not silently dropped from the result —
 *   while an **empty list yields zero rows** (its true cardinality; the
 *   parent row remains in the source grid). Without the CASE guard, DuckDB
 *   drops NULL-list rows entirely (verified — that silently loses rows).
 *   NULL *elements* inside a list explode to a NULL row (kept).
 * - **Qualification:** inside explode, the base columns are referenced
 *   view-qualified (`"assay_t1"."id"`) and the element/position alias-
 *   qualified (`"_assay_explode"."tags"`): the unnest alias puts same-named
 *   columns in one scope, and DuckDB rejects unqualified references with
 *   `Binder Error: Ambiguous reference` (verified) — or worse, could bind to
 *   the wrong side. Flatten/path have a single FROM source, so they compose
 *   unqualified, byte-style-compatible with the m2-2 window composer.
 * - **Fixed-size arrays** (a digit inside the parsed list `dimensions`, e.g.
 *   `DECIMAL(21,1)[3]`; plain `T[]` parses as `[]`) are rejected with an
 *   honest error: FROM-clause `UNNEST` answers
 *   `UNNEST requires a single list as input` for them (verified), while
 *   SELECT-list `unnest` happens to accept them — the construct-independent
 *   error avoids that trap.
 * - **Path indexing:** segments are **0-based** (the app-wide positional
 *   convention, like `fetchRange` offsets) and are converted to DuckDB's
 *   **1-based** list indexing (`[10,20,30][0]` is NULL, `[1]` is 10 —
 *   verified). Out-of-bounds indices compose to NULL reads, not errors
 *   (verified); a missing struct key is rejected loudly by the engine binder
 *   (`Could not find key … in struct`, verified), so the output alias mirrors
 *   the *emitted* (1-based) path — what you see is the SQL that ran.
 * - **Escaping (the security core):** every identifier (view, column, field)
 *   passes the engine's `quotedIdentifier` (double-quote doubling) before
 *   entering SQL, and every path field name enters as a single-quoted string
 *   literal with `''` doubling (`sqlStringLiteral` below — the same rule as
 *   the engine's `format-view.ts`). DuckDB does **not** process backslash
 *   escapes in literals (`SELECT 'a\'b'` is a parser error — verified), so
 *   doubling is the *only* escape and no other sequence can break out.
 *   Hostile names (embedded quotes, `;`, `--`, unicode, brackets) therefore
 *   stay inside identifier/literal context; the hostile-input probes in the
 *   test file pin each composed string byte-exactly and record real CLI
 *   executions for the fixture's names.
 */

import { quotedIdentifier } from '@assay/engine-duckdb'
import type { DuckDbType } from '../schema/parseType'

/** One schema column: its name and its *parsed* DuckDB type tree. */
export interface NestedColumnSpec {
  readonly name: string
  readonly type: DuckDbType
}

/** Discriminated result: the composed SQL, or an honest reason it cannot be. */
export type ComposedSql =
  { readonly ok: true; readonly sql: string } | { readonly ok: false; readonly reason: string }

/** One segment of a bracket path: a struct/map field name or a list index. */
export type PathSegment = string | number

export interface ExplodeOptions {
  /**
   * Include the 1-based element-position column (`"<list>.pos"`)? Default
   * `true` — the position is what makes exploded rows explainable; opt out
   * explicitly when only the elements matter.
   */
  readonly withPosition?: boolean
}

/** The composer-owned row-source alias of the explode unnest (m2-4 `_assay_page` style). */
const EXPLODE_ALIAS = '_assay_explode'

/** Quote a SQL string literal (single-quote doubling) for path field names. */
function sqlStringLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'"
}

function viewIdentifier(viewName: string): string | null {
  if (viewName === '') return null
  return quotedIdentifier(viewName)
}

function notOk(reason: string): ComposedSql {
  return { ok: false, reason }
}

/**
 * Find a column by name and hand its parsed type to the continuation, or
 * explain that the column does not exist.
 */
function withColumnType(
  columns: readonly NestedColumnSpec[],
  name: string,
  onFound: (type: DuckDbType) => ComposedSql,
): ComposedSql {
  const column = columns.find((candidate) => candidate.name === name)
  if (column === undefined) {
    return notOk(`column "${name}" is not in the dataset schema`)
  }
  return onFound(column.type)
}

/**
 * Flatten a STRUCT column: `SELECT <other columns>, "<s>"."<f>" AS "<s>.<f>", …
 * FROM <view>`. The struct column itself is replaced by its fields (other
 * columns keep schema order; fields follow in declared order). Field names
 * come from the parsed type, so a flattened child grid mirrors the schema
 * tree exactly.
 *
 * Degenerate inputs (missing column, non-struct type, UNION, zero fields,
 * dotted-alias collision with an existing column) produce an honest error —
 * never a silent `SELECT *`.
 */
export function flattenColumnSql(
  viewName: string,
  columns: readonly NestedColumnSpec[],
  structColumn: string,
): ComposedSql {
  const view = viewIdentifier(viewName)
  if (view === null) return notOk('viewName must be a non-empty string')
  return withColumnType(columns, structColumn, (type) => {
    if (type.kind === 'union') {
      return notOk(`column "${structColumn}" is a UNION type; only STRUCT columns can be flattened`)
    }
    if (type.kind !== 'struct') {
      return notOk(`column "${structColumn}" is not a STRUCT column`)
    }
    if (type.fields.length === 0) {
      return notOk(`column "${structColumn}" has no fields to flatten`)
    }
    const structId = quotedIdentifier(structColumn)
    const others = columns.filter((column) => column.name !== structColumn)
    const aliases = type.fields.map((field) => `${structColumn}.${field.name}`)
    const collision = others.find((column) => aliases.includes(column.name))
    if (collision !== undefined) {
      return notOk(
        `flattening "${structColumn}" would produce an alias colliding with the existing column "${collision.name}"`,
      )
    }
    const projections = [
      ...others.map((column) => quotedIdentifier(column.name)),
      ...type.fields.map(
        (field) =>
          `${structId}.${quotedIdentifier(field.name)} AS ${quotedIdentifier(`${structColumn}.${field.name}`)}`,
      ),
    ]
    return { ok: true, sql: `SELECT ${projections.join(', ')} FROM ${view}` }
  })
}

/**
 * Explode a LIST column into rows: `SELECT <view-qualified other columns>,
 * "_assay_explode"."l" AS "l" [, "_assay_explode"."l.pos" AS "l.pos"]
 * FROM <view>, UNNEST(CASE WHEN <view>."l" IS NULL THEN [NULL] ELSE
 * <view>."l" END) [WITH ORDINALITY] AS "_assay_explode"("l" [, "l.pos"])`.
 *
 * Semantics (CLI-verified, see module comment): other columns are repeated
 * per element; the element column keeps the list column's name; the optional
 * position column is named `"<list>.pos"`; a NULL list yields one NULL row,
 * an empty list zero rows; NULL elements are kept. List-of-struct elements
 * keep their struct shape under the alias, so fields are reachable as
 * `"_assay_explode"."events".at` in downstream SQL (and the m3-2 preview
 * renders them in the grid).
 *
 * Degenerate inputs (missing column, non-list type, fixed-size array,
 * `"<list>.pos"` name collision) produce an honest error.
 */
export function explodeColumnSql(
  viewName: string,
  columns: readonly NestedColumnSpec[],
  listColumn: string,
  options: ExplodeOptions = {},
): ComposedSql {
  const view = viewIdentifier(viewName)
  if (view === null) return notOk('viewName must be a non-empty string')
  return withColumnType(columns, listColumn, (type) => {
    if (type.kind !== 'list') {
      return notOk(`column "${listColumn}" is not a LIST column`)
    }
    // `[]` brackets are the variable-length list; a digit inside a bracket
    // (e.g. `[3]`) marks a fixed-size array.
    if (/\[\d+\]/.test(type.dimensions)) {
      return notOk(
        `column "${listColumn}" is a fixed-size array (${type.dimensions}); DuckDB UNNEST cannot explode it`,
      )
    }
    const withPosition = options.withPosition !== false
    const positionName = `${listColumn}.pos`
    if (withPosition && columns.some((column) => column.name === positionName)) {
      return notOk(
        `exploding "${listColumn}" would produce the position column "${positionName}", which already exists`,
      )
    }
    const qualifiedView = (name: string): string => `${view}.${quotedIdentifier(name)}`
    const qualifiedAlias = (name: string): string =>
      `${quotedIdentifier(EXPLODE_ALIAS)}.${quotedIdentifier(name)}`
    const listId = quotedIdentifier(listColumn)
    const element = `${qualifiedAlias(listColumn)} AS ${listId}`
    const projections = [
      ...columns
        .filter((column) => column.name !== listColumn)
        .map((column) => qualifiedView(column.name)),
      withPosition
        ? `${element}, ${qualifiedAlias(positionName)} AS ${quotedIdentifier(positionName)}`
        : element,
    ]
    // The CASE guard is what keeps NULL-list rows (as one NULL element):
    // a bare UNNEST drops them entirely (verified against the CLI).
    const listExpr = `CASE WHEN ${qualifiedView(listColumn)} IS NULL THEN [NULL] ELSE ${qualifiedView(listColumn)} END`
    const aliasColumns = withPosition ? `${listId}, ${quotedIdentifier(positionName)}` : listId
    const ordinality = withPosition ? ' WITH ORDINALITY' : ''
    return {
      ok: true,
      sql:
        `SELECT ${projections.join(', ')} FROM ${view}, ` +
        `UNNEST(${listExpr})${ordinality} AS ${quotedIdentifier(EXPLODE_ALIAS)}(${aliasColumns})`,
    }
  })
}

/**
 * Project one bracket path: `SELECT "col"['field'][1] AS "col.field[1]"
 * FROM <view>`. Segments are 0-based list indices / struct field names
 * (mixed paths compose); indices are converted to DuckDB's 1-based bracket
 * indexing, field names enter as escaped single-quoted literals, and the
 * output alias mirrors the emitted path byte-for-byte.
 *
 * The path is composed mechanically against the named view — no schema is
 * needed to compose, and the engine reports missing struct keys and
 * out-of-bounds behavior itself (see module comment). Segment-shape errors
 * (empty path, leading index, negative/non-integer index) are rejected here.
 */
export function pathExtractSql(
  viewName: string,
  pathSegments: readonly PathSegment[],
): ComposedSql {
  const view = viewIdentifier(viewName)
  if (view === null) return notOk('viewName must be a non-empty string')
  if (pathSegments.length === 0) return notOk('path must name a column')
  const [head, ...tail] = pathSegments
  if (typeof head !== 'string') {
    return notOk('path must start with a column name, not an index')
  }
  let expression = quotedIdentifier(head)
  let alias = head
  for (const segment of tail) {
    if (typeof segment === 'string') {
      expression += `[${sqlStringLiteral(segment)}]`
      alias += `.${segment}`
    } else {
      if (!Number.isSafeInteger(segment) || segment < 0) {
        return notOk(`list index must be a non-negative integer (got ${String(segment)})`)
      }
      const index = segment + 1 // app-side 0-based → DuckDB 1-based
      expression += `[${String(index)}]`
      alias += `[${String(index)}]`
    }
  }
  return { ok: true, sql: `SELECT ${expression} AS ${quotedIdentifier(alias)} FROM ${view}` }
}
