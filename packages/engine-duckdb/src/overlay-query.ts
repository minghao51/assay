/**
 * SQL composition for overlay-aware windows/counts/schema and COPY-based
 * exports (m4-2) — the engine side of the ADR 0012 edit overlay.
 *
 * Composition model — **stateless**: every request carries the overlay (the
 * immutable base metadata + the op list) from the host; the worker folds the
 * ops with the domain's `foldOverlay` (the single source of truth for what a
 * log means) and composes SQL as a pure function of (base view, folded
 * state). Nothing overlay-related is stored in the worker: a worker restart
 * loses nothing, the same request always composes the same SQL (the domain's
 * "effective order is a function of the state alone" contract), and the host
 * stays the owner of the op log. The alternative (worker-side session state
 * updated per op) was rejected: it would duplicate the fold inside the
 * engine, break restart-safety, and hand the worker state the host owns.
 *
 * SQL shape — the effective view is one composed relation:
 *
 *     SELECT <effective projection> FROM (
 *       <base branch> UNION ALL <insert branch> UNION ALL …
 *     ) [WHERE <filters>] [ORDER BY <sort keys>, ] ORDER BY "assay_key"
 *
 * - **Base branch**: the registered view with a computed base ordinal
 *   (`row_number() OVER () − 1` — the same single-threaded natural-order
 *   guarantee `LIMIT`/`OFFSET` grid windows already rely on in the wasm mvp
 *   bundle), tombstoned ordinals excluded via `NOT IN`, and per-column edit
 *   overlays as bounded `CASE … WHEN <ordinal> THEN <literal>` expressions
 *   (bounded by session activity, never by dataset size). Renames rewrite
 *   the alias; casts rewrite the projection (`CAST(base AS <target>)`); a
 *   `text`-kind edit value becomes `CAST('<literal>' AS <column type>)` —
 *   the domain's engine-parseable literal cast, whose failure surfaces as a
 *   readable engine conversion error (never silent corruption).
 * - **Insert branches**: one SELECT per *live* inserted row, every value cast
 *   to the effective column type (absent columns materialize as NULL — the
 *   documented v1 rule); tombstoned inserts are omitted (their edits are
 *   kept in the state for `row-restore`, but never projected).
 * - **Ordering**: `effectiveRowIds` (domain `overlay.ts`) is reproduced
 *   exactly by an INTEGER-list sort key (`assay_key`), which DuckDB compares
 *   element-wise with prefix-smaller-first (verified against the pinned
 *   DuckDB CLI 1.5.5). Base row `o` gets `[0, o, 1]`; a node reached from a
 *   node with path P anchors before-children at `P + [0, seq]` and
 *   after-children at `P + [1, seq]`; an insert's key is its path + `[1]`;
 *   start/end groups root at `[−1, seq]` / `[1, seq]`; the documented
 *   degrade-to-end leftover sweep (dead anchors, cycles) is linearized
 *   worker-side in the exact visit order of `effectiveRowIds` as
 *   `[2, visitIndex]`. Only the O(inserts) graph is walked worker-side; base
 *   rows never leave SQL. The equivalence is pinned by conformance scenarios
 *   whose expected orders/values are derived from the pinned DuckDB CLI.
 * - **Sort/filter composition** (m2-2 grammar): filters and sorts reference
 *   *effective* column names (the grid sees renamed columns and edited
 *   values) and apply over the composed relation; explicit sort keys are
 *   followed by `assay_key` as a deterministic tiebreak (strictly stronger
 *   than base windows, where equal sort keys are engine-ordered). This is
 *   the pinned v1 combination surface: overlay windows support the same
 *   filter/sort grammar over the *effective* view.
 *
 * Security invariants (mirroring `window-query.ts`): only engine-generated
 * view names and quoted identifiers enter identifier positions; cell values
 * reach SQL only as typed literals via `cellLiteralSql` (single-quote
 * escaped strings); host anchors reach SQL only inside string literals; the
 * CSV formula-injection guard composes from SQL functions, never by
 * concatenating data into the statement.
 */
import type { OverlayBase } from '@assay/domain'
import { baseRowId, parseRowId } from '@assay/domain'
import type { CellValue, InsertedRowRecord, OverlayState, RowId } from '@assay/domain'
import { quotedIdentifier, sqlStringLiteral } from './format-view'
import type { EngineExportFormat, EngineFilterSpec, EngineSortSpec } from './protocol'
import { orderByClauseSql, whereClauseSql } from './window-query'

/**
 * Column names this composer reserves for its own machinery. A dataset
 * column using one of these names would collide with the composer's internal
 * ordinal / sort-key / row-id columns; composition fails with a clear error
 * instead of silently misbehaving (the host contract: these are
 * engine-namespaced and reserved, like the `assay_tN` view names).
 */
export const RESERVED_OVERLAY_COLUMN_NAMES: ReadonlySet<string> = new Set([
  'assay_overlay_ord',
  'assay_key',
  'assay_row_id',
])

/** The logical row-id column overlay windows add when requested. */
export const OVERLAY_ROW_ID_COLUMN = 'assay_row_id'

/** The sort-key column of the composed effective relation (never projected). */
export const OVERLAY_SORT_KEY_COLUMN = 'assay_key'

/** The base-ordinal alias inside the base branch (never projected). */
const ORDINAL_COLUMN = 'assay_overlay_ord'

/** Inputs every overlay composition shares: the registered view + the fold. */
export interface OverlayComposition {
  /** The engine-generated view name (`TableRegistry.viewNameForTableId`). */
  readonly viewName: string
  /** The immutable base metadata from the request (host tokens + schema). */
  readonly base: OverlayBase
  /** The folded overlay state (`foldOverlay(base, ops).state`). */
  readonly state: OverlayState
}

/** Window request inputs (m2-2 grammar over the effective view, m4-2). */
export interface OverlayWindowQuery extends OverlayComposition {
  /** Projection column names (effective); omit for all effective columns. */
  readonly columns?: readonly string[]
  /** Ordered predicates, AND-composed; omit/empty for no WHERE clause. */
  readonly filters?: readonly EngineFilterSpec[]
  /** Ordered sort keys; omit/empty for effective order (`assay_key`). */
  readonly sort?: readonly EngineSortSpec[]
  /** Pre-validated row count (from `validateRowWindow`). */
  readonly limit: number
  /** Pre-validated row offset (from `validateRowWindow`). */
  readonly offset: number
  /** Prepend the logical row-id column (`assay_row_id`) to the projection. */
  readonly includeRowIds?: boolean
}

// ---------------------------------------------------------------------------
// Insert ordering — the worker-side half of the effectiveRowIds equivalence
// ---------------------------------------------------------------------------

/**
 * Sort keys for every live inserted row, reproducing `effectiveRowIds`
 * (domain `overlay.ts`) exactly when DuckDB orders by the INTEGER-list
 * `assay_key` (see the module doc for the key grammar and its CLI
 * verification). The leftover sweep — live inserts unreachable from the
 * start/base/end sweeps (dead/foreign anchors, self-referencing chains) — is
 * linearized in the exact visit order of `effectiveRowIds`' leftover walk
 * (insert-sequence order, depth-first, visited-set guarded), so degenerate
 * anchors degrade to the end deterministically, exactly as documented there.
 *
 * O(inserts): only the insert graph is walked. `effectiveRowIds` sweeps all
 * base ordinals, but inserts only reference a bounded set of them, so the
 * base side of the walk reduces to iterating just the anchored ordinals.
 * Never called at dataset scale.
 */
export function insertSortKeys(
  base: OverlayBase,
  state: OverlayState,
): Map<string, readonly number[]> {
  const beforeByAnchor = new Map<string, InsertedRowRecord[]>()
  const afterByAnchor = new Map<string, InsertedRowRecord[]>()
  const start: InsertedRowRecord[] = []
  const end: InsertedRowRecord[] = []
  for (const record of state.inserts.values()) {
    if (!record.live) continue
    switch (record.position.kind) {
      case 'start':
        start.push(record)
        break
      case 'end':
        end.push(record)
        break
      case 'before':
        bucketByAnchor(beforeByAnchor, record.position.rowId, record)
        break
      case 'after':
        bucketByAnchor(afterByAnchor, record.position.rowId, record)
        break
    }
  }
  const bySeq = (a: InsertedRowRecord, b: InsertedRowRecord): number => a.seq - b.seq
  start.sort(bySeq)
  end.sort(bySeq)
  for (const list of beforeByAnchor.values()) list.sort(bySeq)
  for (const list of afterByAnchor.values()) list.sort(bySeq)

  const keys = new Map<string, readonly number[]>()
  // Depth-first assignment mirroring `effectiveRowIds`' `emitChain`: the
  // visited-set guard (`keys.has`) makes degenerate chains and cycles
  // terminate; key order equals emission order (CLI-verified list
  // comparison).
  const visit = (path: readonly number[], record: InsertedRowRecord): void => {
    if (keys.has(record.id)) return
    keys.set(record.id, [...path, 1])
    for (const child of beforeByAnchor.get(record.id) ?? []) visit([...path, 0, child.seq], child)
    for (const child of afterByAnchor.get(record.id) ?? []) visit([...path, 1, child.seq], child)
  }

  for (const record of start) visit([-1, record.seq], record)
  const anchorOrdinals = new Set<number>()
  for (const anchor of beforeByAnchor.keys()) collectBaseOrdinal(base, anchor, anchorOrdinals)
  for (const anchor of afterByAnchor.keys()) collectBaseOrdinal(base, anchor, anchorOrdinals)
  for (const ordinal of [...anchorOrdinals].sort((a, b) => a - b)) {
    if (ordinal >= base.baseRowCount || state.deletedBase.has(ordinal)) continue
    const id = baseRowId(base.baseAnchor, ordinal)
    for (const child of beforeByAnchor.get(id) ?? []) visit([0, ordinal, 0, child.seq], child)
    for (const child of afterByAnchor.get(id) ?? []) visit([0, ordinal, 1, child.seq], child)
  }
  for (const record of end) visit([1, record.seq], record)
  const leftovers = [...state.inserts.values()]
    .filter((record) => record.live && !keys.has(record.id))
    .sort(bySeq)
  let visitIndex = 0
  for (const record of leftovers) visit([2, visitIndex++], record)
  return keys
}

function collectBaseOrdinal(base: OverlayBase, anchor: string, into: Set<number>): void {
  const parsed = parseRowId(anchor as RowId)
  if (parsed !== null && parsed.origin === 'base' && parsed.anchor === base.baseAnchor) {
    into.add(parsed.ordinal)
  }
}

function bucketByAnchor(
  map: Map<string, InsertedRowRecord[]>,
  anchor: string,
  record: InsertedRowRecord,
): void {
  const list = map.get(anchor)
  if (list === undefined) map.set(anchor, [record])
  else list.push(record)
}

// ---------------------------------------------------------------------------
// Value literals and the CSV formula-injection guard
// ---------------------------------------------------------------------------

/**
 * One `CellValue` as a typed SQL literal, cast under the column's *effective*
 * type so each UNION branch keeps the column's declared type exactly (a bare
 * literal could widen the branch type — e.g. a DOUBLE literal would silently
 * widen a BIGINT column). `text` is the domain's engine-parseable literal:
 * emitted as text and cast under the column's type, so a bad literal
 * surfaces as a readable engine conversion error at materialization (never
 * silent corruption). Boolean/number values landing on textual columns render
 * through the engine's own cast (documented v1 behavior).
 */
export function cellLiteralSql(value: CellValue, effectiveType: string): string {
  switch (value.kind) {
    case 'null':
      return `CAST(NULL AS ${effectiveType})`
    case 'boolean':
      return `CAST(${value.value ? 'TRUE' : 'FALSE'} AS ${effectiveType})`
    case 'number': {
      // Non-finite numbers cannot be materialized (and JSON cannot carry
      // them) — fail this op with a clear error instead of emitting SQL the
      // engine would reject with an opaque message.
      if (!Number.isFinite(value.value)) {
        throw new Error(`cell number ${String(value.value)} cannot be materialized`)
      }
      // String() of a JS number is its shortest round-trip form; DuckDB
      // parses integer and scientific-decimal literals exactly.
      return `CAST(${String(value.value)} AS ${effectiveType})`
    }
    case 'string':
      return `CAST(${sqlStringLiteral(value.value)} AS ${effectiveType})`
    case 'text':
      return `CAST(${sqlStringLiteral(value.text)} AS ${effectiveType})`
  }
}

/**
 * CSV formula-injection guard (AGENTS security rule; review-gate hard
 * requirement): wraps a column expression so any cell whose rendered text
 * could initiate a formula in a spreadsheet app is neutralized with the
 * **apostrophe-prefix convention** — a leading `'` marks the cell as text.
 * Documented trigger set (probed by the conformance suite): the rendered
 * text starts with `=`, `+`, `-`, `@`, TAB (0x09) or CR (0x0D), **or
 * contains TAB/CR anywhere** (embedded control characters can obfuscate a
 * leading initiator in spreadsheet parsers). NULL passes through as NULL.
 *
 * This runs **pre-export, inside the SELECT the COPY consumes** — not as a
 * post-COPY byte rewrite — because (1) rewriting CSV bytes would require
 * re-parsing quoted CSV and risks corrupting legitimate quoting, (2) the SQL
 * form is a pure, deterministic function of the query, and (3) it composes
 * with the overlay projection in one statement. It applies only to CSV
 * exports and only to columns whose effective type is VARCHAR — the only
 * renderings that can be formula-shaped (numbers/dates/booleans render as
 * numeric/temporal literals). The documented trade-off: a VARCHAR cell that
 * legitimately starts with `-` gains the prefix too.
 */
export function formulaInjectionGuardSql(expr: string): string {
  const triggers = `'=', '+', '-', '@', chr(9), chr(13)`
  return (
    `CASE WHEN ${expr} IS NULL THEN NULL ` +
    `WHEN contains(${expr}, chr(9)) OR contains(${expr}, chr(13)) ` +
    `OR left(${expr}, 1) IN (${triggers}) THEN chr(39) || ${expr} ` +
    `ELSE ${expr} END`
  )
}

// ---------------------------------------------------------------------------
// Composed relation parts
// ---------------------------------------------------------------------------

function assertNoReservedNames(columns: readonly { readonly name: string }[]): void {
  for (const column of columns) {
    if (RESERVED_OVERLAY_COLUMN_NAMES.has(column.name)) {
      throw new Error(
        `column name "${column.name}" is reserved by the engine overlay composer and cannot be composed`,
      )
    }
  }
}

/**
 * One effective column's base-branch expression: the base column (quoted,
 * original base name — position `effectiveIndex` corresponds to the base
 * column at the same index, since renames/casts never reorder), cast under
 * the effective type when a cast applies, wrapped in a bounded CASE that
 * overlays this row's cell edits (edits are keyed by the effective
 * (post-rename) column name; the fold re-keys them). `ordinalRef` is the
 * computed base-ordinal reference visible at the branch's SELECT level.
 */
function baseColumnExpr(
  base: OverlayBase,
  state: OverlayState,
  effectiveIndex: number,
  ordinalRef: string,
): string {
  const effective = state.columns[effectiveIndex]
  const baseColumn = base.columns[effectiveIndex]
  if (effective === undefined || baseColumn === undefined) {
    throw new Error(
      `overlay base metadata is inconsistent: effective column ${String(effectiveIndex)} has no base column`,
    )
  }
  const source = quotedIdentifier(baseColumn.name)
  const withCast =
    effective.type === baseColumn.type ? source : `CAST(${source} AS ${effective.type})`
  const edits: { ordinal: number; sql: string }[] = []
  for (const [rowId, rowEdits] of state.edits) {
    const parsed = parseRowId(rowId as RowId)
    if (parsed === null || parsed.origin !== 'base') continue
    if (parsed.anchor !== base.baseAnchor) continue // foreign anchor: absorbed by the fold
    const value = rowEdits.get(effective.name)
    if (value === undefined) continue
    edits.push({ ordinal: parsed.ordinal, sql: cellLiteralSql(value, effective.type) })
  }
  if (edits.length === 0) return withCast
  edits.sort((a, b) => a.ordinal - b.ordinal)
  const arms = edits.map((edit) => `WHEN ${ordinalRef} = ${String(edit.ordinal)} THEN ${edit.sql}`)
  return `CASE ${arms.join(' ')} ELSE ${withCast} END`
}

/** What a composed relation carries beyond the plain effective columns. */
interface RelationOptions {
  /** Include the `assay_key` sort-key column (only meaningful with inserts). */
  readonly withKey: boolean
  /** Include the logical row-id column (`assay_row_id`). */
  readonly withRowIds: boolean
  /** Apply the CSV formula-injection guard to VARCHAR columns (CSV export). */
  readonly sanitizeCsv: boolean
}

/**
 * The base branch of the composed relation: computed base ordinals over the
 * registered view (explicit base-column projection — never `SELECT *`, so
 * the ordinal alias cannot collide), tombstoned ordinals excluded, bounded
 * edit CASEs, renamed aliases, and the optional row-id/key columns.
 */
function baseBranchSql(
  base: OverlayBase,
  state: OverlayState,
  viewName: string,
  options: RelationOptions,
): string {
  assertNoReservedNames(state.columns)
  const baseColumns = base.columns.map((column) => quotedIdentifier(column.name)).join(', ')
  const inner =
    `SELECT ${baseColumns}, (row_number() OVER () - 1) AS ${ORDINAL_COLUMN} ` +
    `FROM ${quotedIdentifier(viewName)}`
  const exprs = state.columns.map((column, index) => {
    const raw = baseColumnExpr(base, state, index, ORDINAL_COLUMN)
    const guarded =
      options.sanitizeCsv && column.type === 'VARCHAR' ? formulaInjectionGuardSql(raw) : raw
    return `${guarded} AS ${quotedIdentifier(column.name)}`
  })
  if (options.withRowIds) {
    // The anchor is a host token: it reaches SQL only inside a string
    // literal (escaped), concatenated with the computed ordinal.
    const prefix = sqlStringLiteral(`base:${base.baseAnchor}#`)
    exprs.push(
      `${prefix} || CAST(${ORDINAL_COLUMN} AS VARCHAR) AS ${quotedIdentifier(OVERLAY_ROW_ID_COLUMN)}`,
    )
  }
  if (options.withKey) {
    exprs.push(`[0, ${ORDINAL_COLUMN}, 1] AS ${quotedIdentifier(OVERLAY_SORT_KEY_COLUMN)}`)
  }
  const tombstones = [...state.deletedBase].sort((a, b) => a - b)
  const tombstoneFilter =
    tombstones.length > 0
      ? ` WHERE ${ORDINAL_COLUMN} NOT IN (${tombstones.map(String).join(', ')})`
      : ''
  return `SELECT ${exprs.join(', ')} FROM (${inner})${tombstoneFilter}`
}

/**
 * One live insert's branch: every effective column cast to its effective
 * type (absent values NULL — the documented v1 rule), the logical row id as
 * a literal, and the insert's sort key from `insertSortKeys`.
 */
function insertBranchSql(
  state: OverlayState,
  record: InsertedRowRecord,
  key: readonly number[],
  options: RelationOptions,
): string {
  const exprs = state.columns.map((column) => {
    const value: CellValue | undefined = record.values.get(column.name)
    const literal = cellLiteralSql(value ?? { kind: 'null' }, column.type)
    // The CSV guard applies to insert branches too — a bait value in an
    // inserted row must be sanitized exactly like an edited base cell
    // (probed by the conformance suite's export round-trip).
    const guarded =
      options.sanitizeCsv && column.type === 'VARCHAR' ? formulaInjectionGuardSql(literal) : literal
    return `${guarded} AS ${quotedIdentifier(column.name)}`
  })
  if (options.withRowIds) {
    exprs.push(`${sqlStringLiteral(record.id)} AS ${quotedIdentifier(OVERLAY_ROW_ID_COLUMN)}`)
  }
  if (options.withKey) {
    exprs.push(`[${key.map(String).join(', ')}] AS ${quotedIdentifier(OVERLAY_SORT_KEY_COLUMN)}`)
  }
  return `SELECT ${exprs.join(', ')}`
}

/**
 * The composed effective relation (the FROM body every overlay op reads):
 * the base branch UNION ALL one branch per live inserted row. The sort key
 * is included exactly when live inserts exist (their presence changes the
 * emission order from plain base order); branches are always built
 * consistently, so the union never mixes keyed and unkeyed shapes.
 */
export function composeSourceSql(
  composition: OverlayComposition,
  options: {
    readonly withRowIds: boolean
    readonly sanitizeCsv: boolean
    readonly withKey: boolean
  },
): string {
  const { base, state, viewName } = composition
  const liveInserts = [...state.inserts.values()].filter((record) => record.live)
  const withKey = options.withKey && liveInserts.length > 0
  const keys = withKey ? insertSortKeys(base, state) : undefined
  const relationOptions: RelationOptions = { ...options, withKey }
  const branches = [baseBranchSql(base, state, viewName, relationOptions)]
  for (const record of liveInserts) {
    branches.push(insertBranchSql(state, record, keys?.get(record.id) ?? [], relationOptions))
  }
  return branches.join(' UNION ALL ')
}

// ---------------------------------------------------------------------------
// Public composition surface
// ---------------------------------------------------------------------------

/**
 * `DESCRIBE SELECT …` over the effective projection — the effective schema
 * (post-rename names, post-cast DuckDB types). Insert values never change
 * the schema (each is cast to the effective column type), so the base branch
 * alone is described; a cast to a type string the engine rejects fails right
 * here as a readable binder error (declared-cast validation), while a
 * *value*-level cast failure surfaces on the first materializing op
 * (window/count/export) — both typed engine errors, never silent drift.
 */
export function composeOverlaySchemaSql(composition: OverlayComposition): string {
  assertNoReservedNames(composition.state.columns)
  const { base, state, viewName } = composition
  const exprs = state.columns.map((column, index) => {
    const raw = baseColumnExpr(base, state, index, ORDINAL_COLUMN)
    return `${raw} AS ${quotedIdentifier(column.name)}`
  })
  const inner =
    `SELECT ${base.columns.map((column) => quotedIdentifier(column.name)).join(', ')}, ` +
    `(row_number() OVER () - 1) AS ${ORDINAL_COLUMN} FROM ${quotedIdentifier(viewName)}`
  return `DESCRIBE SELECT ${exprs.join(', ')} FROM (${inner})`
}

/**
 * `SELECT count(*)::BIGINT …` over the composed effective relation,
 * optionally narrowed by filters on effective columns (m2-2 grammar).
 */
export function composeOverlayCountSql(
  composition: OverlayComposition,
  filters?: readonly EngineFilterSpec[],
): string {
  const source = composeSourceSql(composition, {
    withRowIds: false,
    sanitizeCsv: false,
    withKey: false,
  })
  const base = `SELECT count(*)::BIGINT AS row_count FROM (${source})`
  const where = whereClauseSql(filters)
  return where === null ? base : `${base} WHERE ${where}`
}

/**
 * The overlay window query (m2-2 grammar over the effective view): explicit
 * outer projection (never the sort key), filters over effective columns,
 * explicit sort keys with `assay_key` as the deterministic tiebreak (or
 * `assay_key` alone for effective order), then the pre-validated LIMIT/
 * OFFSET interpolated verbatim.
 */
export function composeOverlayWindowSql(query: OverlayWindowQuery): string {
  const { columns, filters, sort, includeRowIds } = query
  const source = composeSourceSql(query, {
    withRowIds: includeRowIds === true,
    sanitizeCsv: false,
    withKey: true,
  })
  let projection: string
  if (columns !== undefined) {
    projection = columns.map(quotedIdentifier).join(', ')
    if (includeRowIds === true) {
      projection = `${quotedIdentifier(OVERLAY_ROW_ID_COLUMN)}, ${projection}`
    }
  } else {
    const names = query.state.columns.map((column) => quotedIdentifier(column.name))
    if (includeRowIds === true) names.unshift(quotedIdentifier(OVERLAY_ROW_ID_COLUMN))
    projection = names.join(', ')
  }
  let sql = `SELECT ${projection} FROM (${source})`
  const where = whereClauseSql(filters)
  if (where !== null) sql += ` WHERE ${where}`
  const order = orderByClauseSql(sort)
  // Effective order is `assay_key` when inserts exist; explicit sort keys
  // always tiebreak by `assay_key` (deterministic total order).
  const hasInserts = [...query.state.inserts.values()].some((record) => record.live)
  if (order !== null) {
    sql += hasInserts
      ? ` ORDER BY ${order}, ${quotedIdentifier(OVERLAY_SORT_KEY_COLUMN)}`
      : ` ORDER BY ${order}`
  } else if (hasInserts) {
    sql += ` ORDER BY ${quotedIdentifier(OVERLAY_SORT_KEY_COLUMN)}`
  }
  return sql + ` LIMIT ${query.limit} OFFSET ${query.offset}`
}

/** Deterministic COPY options pinned for v1 exports (per format). */
const EXPORT_FORMAT_OPTIONS: ReadonlyMap<EngineExportFormat, string> = new Map([
  // ZSTD + the DuckDB default row-group size: same conventions as the
  // repository's own fixture generator (ADR 0038).
  ['parquet', 'FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880'],
  ['csv', "FORMAT CSV, HEADER true, DELIMITER ',', QUOTE '\"', ESCAPE '\"'"],
  // ARRAY false = newline-delimited JSON (JSONL); ARRAY true = one array.
  ['jsonl', 'FORMAT JSON, ARRAY false'],
  ['json', 'FORMAT JSON, ARRAY true'],
])

/** The file extension an exported destination carries for each format. */
export function exportFileExtension(format: EngineExportFormat): string {
  return format
}

/**
 * The COPY statement materializing the effective view (base + overlay) in
 * effective order — the export/rewrite op's SQL (ADR 0012: commit creates a
 * *new* file; the source is never written). The projection applies the CSV
 * formula-injection guard for `csv` exports. Row ids are *not* exported: a
 * written file is a new base version, and logical row ids are session-scoped
 * (the documented survival boundary). Returns `null` for `arrow`, which is
 * materialized by streaming the (identical) SELECT through Arrow IPC
 * instead — see `composeOverlayExportSelectSql` for why.
 */
export function composeOverlayExportSql(
  composition: OverlayComposition,
  format: EngineExportFormat,
  destination: string,
): string | null {
  if (format === 'arrow') return null
  const options = EXPORT_FORMAT_OPTIONS.get(format)
  if (options === undefined) {
    throw new Error(`unsupported export format: ${format}`)
  }
  return (
    `COPY (${composeOverlayExportSelectSql(composition, format)}) TO ` +
    `${sqlStringLiteral(destination)} (${options})`
  )
}

/**
 * The bare export SELECT (effective view, effective order, CSV guard
 * applied) — what the COPY wraps, and the statement the `arrow` path streams
 * (DuckDB-WASM's bundled build has no Arrow COPY writer, so Arrow IPC files
 * are assembled worker-side from the streamed result; the SELECT is byte-
 * identical to the COPY path's input, keeping the two formats honest
 * siblings).
 */
export function composeOverlayExportSelectSql(
  composition: OverlayComposition,
  format: EngineExportFormat,
): string {
  const source = composeSourceSql(composition, {
    withRowIds: false,
    sanitizeCsv: format === 'csv',
    withKey: true,
  })
  const projection = composition.state.columns
    .map((column) => quotedIdentifier(column.name))
    .join(', ')
  let sql = `SELECT ${projection} FROM (${source})`
  if ([...composition.state.inserts.values()].some((record) => record.live)) {
    sql += ` ORDER BY ${quotedIdentifier(OVERLAY_SORT_KEY_COLUMN)}`
  }
  return sql
}
