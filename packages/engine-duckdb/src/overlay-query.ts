// SPDX-License-Identifier: AGPL-3.0-or-later

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
 *     ) [WHERE <filters>] [ORDER BY <sort keys>[, "assay_key"]] — the
 *     `assay_key` tiebreak (and any ORDER BY at all) is composed only when
 *     live inserts exist (see "Sort/filter composition" below)
 *
 * - **Base branch**: the registered view with a computed base ordinal
 *   (`row_number() OVER () − 1` — the same single-threaded natural-order
 *   guarantee `LIMIT`/`OFFSET` grid windows already rely on in the wasm mvp
 *   bundle), tombstoned ordinals excluded via `NOT IN`, and per-column edit
 *   overlays as bounded `CASE … WHEN <ordinal> THEN <literal>` expressions
 *   (bounded by session activity, never by dataset size; a tombstoned
 *   ordinal's edit is **not** projected — m4-4b round 4). Renames rewrite
 *   the alias; casts rewrite the projection (`CAST(base AS <target>)`); a
 *   `text`-kind edit value becomes `CAST('<literal>' AS <column type>)` —
 *   the domain's engine-parseable literal cast, whose failure surfaces as a
 *   readable engine conversion error (never silent corruption).
 * - **Insert branches**: one SELECT per *live* inserted row, every value cast
 *   to the effective column type (absent columns materialize as NULL — the
 *   documented v1 rule); tombstoned inserts are omitted (their edits are
 *   kept in the state for `row-restore`, but never projected). Each cell's
 *   effective value **merges the folded `state.edits` for that insert id**
 *   over the insert record's value: a later `cell-set` wins, and a
 *   `cell-revert` removes the edit so the insert value stands again —
 *   exactly the domain's `overlayEdit` semantics (`column-rename` re-keys
 *   both maps, so an edit follows its renamed column). Before the m4-2b fix
 *   the branch read `InsertedRowRecord.values` only and silently dropped
 *   inserted-row edits.
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
 *   values) and apply over the composed relation; when live inserts exist,
 *   explicit sort keys are followed by `assay_key` as a deterministic
 *   tiebreak (and `assay_key` alone orders the effective view). With no
 *   live inserts the composed relation is just the filtered base branch —
 *   explicit sorts tie-break engine-ordered, exactly like base windows
 *   (the tiebreak is appended only for inserts; audit AR-E8). This is
 *   the pinned v1 combination surface: overlay windows support the same
 *   filter/sort grammar over the *effective* view.
 * - **Column-repair composition** (EW-04D §6.2; D16/D17 probe record; ADR
 *   0050): when the folded prefix carries `column-repair` records
 *   (`state.repairs` — the fold records the value-independent metadata), the
 *   window/export/schema relations gain **one stacked projection layer per
 *   repair**, earliest innermost, each `mₖ + xₖ + 1` arms emitted once (the
 *   exception arms read the base-ordinal machinery column, which the repair
 *   composition alone projects upward; inserts pass through via a NULL arm
 *   because their D17 literal rewrite already applied — the literal path
 *   *replaces* the wrap, never accompanies it). Multi-repair is never
 *   one-expression nesting: nesting duplicates the inner wrap into every
 *   outer arm (2.4 MB SQL at two repairs, OOM at three — U4), while stacked
 *   layers are additive `O(Σₖ (mₖ + xₖ + 1))`. Post-repair casts apply
 *   outside the wrap (per-segment collapse); pre-repair casts collapse into
 *   the wrap's input type. The schema op wraps too (D16a — wrapped
 *   `DESCRIBE` over `composeSourceSql`, bind-only), and the pending-cast
 *   check composes the **split form** for repair columns only (D16b —
 *   per-row trim + `TRY_CAST` + `IN`-membership, mapping constants hoisted
 *   out of row scope; a wrap-as-predicate is 100–200× more expensive, and
 *   repair-free columns keep the raw-arm shape that sees the domain's
 *   collapsed cast chain). Exports pay a published pre-apply budget
 *   (rows × pairs — U4 measured ~4 s at 2 M × 500 with no interrupt).
 *   Caps and refusals are typed and value-free throughout (D15 x ≤ 500).
 *
 * ## Session-bounded costs (PT-Q q-6, audit AR-E10)
 *
 * Every cost below is bounded by *session activity* (the folded op list),
 * never by dataset size — with the dataset-shaped caveats called out:
 *
 * - **Per-insert `UNION ALL` branches.** The composed relation has one branch
 *   per *live* inserted row, so branch count grows with the session's live
 *   inserts. Measured on the pinned DuckDB CLI 1.5.5 over a 100k-row base with
 *   trivial constant branches (window probe `LIMIT 100 OFFSET 0`): ~4 ms at
 *   0–1 branches, 21 ms at 500, 39 ms at 1 000, 611 ms at 10 000 — roughly
 *   linear in branch count once the base scan is amortized. In the shipped
 *   DuckDB-WASM 1.32.0 `mvp` bundle (the bundle `worker.ts` selects) the same
 *   probe measures ~85 ms at 250 branches, ~180 ms at 500, ~320 ms at 900, and
 *   **≥1000 branches abort the wasm module** (`_setThrew is not defined`, wasm
 *   stack exhaustion during planning). The composer therefore caps live-insert
 *   branches at {@link MAX_OVERLAY_LIVE_INSERT_BRANCHES} (500): half the
 *   observed hard-failure boundary, far above any realistic manual-insert
 *   session, and enforced by a typed value-free error carrying the remedy.
 * - **Base-edit grouping.** The pre-q-6 composer re-walked the whole edit map
 *   once per effective column — O(columns × edited rows) `parseRowId` calls per
 *   request. Base edits are now grouped by effective column once per compose,
 *   so the scan is O(edited rows) and each column is a map lookup. A Node
 *   micro-probe (200 columns × 5 000 edited cells) measured a replicated
 *   per-column scan at ~121 ms vs ~4 ms for the shipped composer (which also
 *   builds the SQL); behavior-identical, including ordinal order and the
 *   tombstone/foreign-anchor filtering (pinned by the composer byte tests).
 * - **`insertSortKeys` path sharing.** The insert-graph walk keeps one shared
 *   path stack and copies it only when a node's key is retained, instead of
 *   copying the accumulated prefix at every edge. Retained keys are still the
 *   output's own size — a degenerate chain of N inserts produces arrays of
 *   total length O(N²) — but bushy graphs no longer pay a full-prefix copy per
 *   edge. JS-only; never called at dataset scale.
 * - **Effective order is a sort, but only with live inserts.** When at least one
 *   live insert exists the window appends `ORDER BY "assay_key"`, which orders
 *   the *whole* effective relation on every request (live inserts change the
 *   order of base rows too). Measured in the `mvp` bundle with one constant
 *   insert: 12 ms on a 100k-row base, 45 ms at 1M, 200 ms at 5M, versus a
 *   ~2–4 ms row-group-skipped base window with no inserts and no `ORDER BY`.
 *   The insert count is session-bounded but this sort is dataset-shaped: a
 *   large session with even one insert sorts the entire effective view per
 *   window. Without live inserts no `ORDER BY` is composed, and the plain base
 *   window's deep-offset cost is documented in `window-query.ts`.
 *
 * Security invariants (mirroring `window-query.ts`): only engine-generated
 * view names and quoted identifiers enter identifier positions; cell values
 * reach SQL only as typed literals via `cellLiteralSql` (single-quote
 * escaped strings); host anchors reach SQL only inside string literals; the
 * CSV formula-injection guard composes from SQL functions, never by
 * concatenating data into the statement, and **scalar BLOB columns are
 * hex-encoded** on CSV export (raw BLOB bytes reach the CSV writer verbatim
 * and bypass the string guard — see `csvSafeExpression`). Engine type
 * expressions are
 * untrusted input: every effective `state.columns[].type` (base or
 * `column-cast` target) is validated as exactly one complete DuckDB type by
 * `assertValidEffectiveTypes` before it reaches a `CAST(x AS <type>)`
 * position, and `cellLiteralSql` re-validates its own type parameter
 * (`type-expr.ts`) — an unvalidated string can never be interpolated.
 */
import type { OverlayBase } from '@assay/domain'
import { baseRowId, isTextualRepairType, parseRowId, trimWithCodePoints } from '@assay/domain'
import type {
  CellValue,
  InsertedRowRecord,
  OverlayState,
  RepairStepRecord,
  RowId,
} from '@assay/domain'
import { quotedIdentifier, sqlStringLiteral } from './format-view.js'
import type { EngineExportFormat, EngineFilterSpec, EngineSortSpec } from './protocol.js'
import {
  isBlobLikeEngineType,
  isStringLikeEngineType,
  validateEngineTypeExpression,
} from './type-expr.js'
import { orderByClauseSql, whereClauseSql } from './window-query.js'

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

/**
 * Upper bound on live-insert `UNION ALL` branches in one composed relation
 * (PT-Q q-6 cap). Chosen from the measured DuckDB-WASM `mvp` window probe:
 * ~180 ms at 500 branches, ~320 ms at 900, and a wasm-module abort at ≥1000
 * (see the module header). 500 is half the observed hard-failure boundary and
 * far above any realistic manual-insert session.
 */
export const MAX_OVERLAY_LIVE_INSERT_BRANCHES = 500

/**
 * Per-repair base-branch exception-arm cap (EW-04D D15, accepted): a repair
 * whose exception set exceeds this refuses with a typed value-free error, the
 * same remedy shape as the live-insert cap. Exceptions are per repair layer
 * (`state.repairs[k]`), never per column.
 */
export const MAX_REPAIR_EXCEPTION_ARMS = 500

/**
 * The published export/full-scan envelope (EW-04D post-R1 acceptance, option
 * (a)): projected work = rows × mapping pairs. U4 measured ~4.0 s at the
 * envelope's corner (2 M rows × 500 pairs = 1e9 cell rewrites) on the shipped
 * `eh` bundle, and the cost is linear in rows × arms with no engine interrupt,
 * so an export whose projected work exceeds this refuses *before* it runs.
 * This is a pre-materialization budget, not an interrupt: nothing cancels a
 * query once composed.
 */
export const MAX_REPAIR_EXPORT_CELL_WORK = 1_000_000_000

/**
 * The composed export/full-scan exceeds the published envelope
 * ({@link MAX_REPAIR_EXPORT_CELL_WORK}): projected rows × mapping pairs over
 * the measured U4 cost line. **Value-free** (ADR 0025) and honest about what
 * it is: a pre-apply budget refusal, never an interrupt claim. The remedy is
 * the session-bounded one — undo repair(s) or materialize the edits into a
 * new base (export/rewrite) and re-open it.
 */
export class OverlayRepairExportBudgetError extends Error {
  constructor() {
    super(
      `the repair plan's projected export cost (rows × mapping pairs) exceeds the published budget of ${MAX_REPAIR_EXPORT_CELL_WORK.toLocaleString('en-US')} cell rewrites; undo repairs or export the edits to a new file and re-open it before repairing further`,
    )
    this.name = 'OverlayRepairExportBudgetError'
  }
}

/**
 * One repair layer's exception set exceeds the accepted per-layer cap
 * ({@link MAX_REPAIR_EXCEPTION_ARMS}). **Value-free** (ADR 0025): it names the
 * engine's own arm cap, never row counts or identifiers.
 */
export class OverlayRepairExceptionLimitError extends Error {
  constructor() {
    super(
      `a column repair composes more per-row exception arms than the engine composes in one wrap (limit ${MAX_REPAIR_EXCEPTION_ARMS} exception arms per repair); undo earlier row edits/deletes on the repaired column or export the edits to a new file and re-open it`,
    )
    this.name = 'OverlayRepairExceptionLimitError'
  }
}

/**
 * A live insert's merged value on a repaired column is `number`/`boolean`, so
 * the compose-time literal rewrite (D17) cannot apply to it: the TypeScript
 * rendering of such values diverges from the engine's own cast (`1e-7` vs
 * `1e-07`; D16/D17 probe §2.4), and re-applying the SQL wrap would cascade
 * (exactly-once violation). **Value-free** (ADR 0025).
 */
export class OverlayRepairInsertValueError extends Error {
  constructor() {
    super(
      'an inserted row holds a non-text value on a repaired column; the repair cannot be composed for it — enter the value as text or undo the column repair first',
    )
    this.name = 'OverlayRepairInsertValueError'
  }
}

/**
 * The folded overlay carries more live inserted rows than the composer's
 * per-request branch budget. **Value-free** (ADR 0025): the message names only
 * the engine's own branch cap — engine structure, not dataset content — and no
 * table name, SQL, cell value, or user row count. The remedy is the honest
 * session-bounded one: materialize the edits into a new base (export/rewrite)
 * and re-open it.
 */
export class OverlayLiveInsertLimitError extends Error {
  constructor() {
    super(
      `the edited view has more live inserts than the engine composes in one window (limit ${MAX_OVERLAY_LIVE_INSERT_BRANCHES} live-insert branches); export the edits to a new file and re-open it to continue`,
    )
    this.name = 'OverlayLiveInsertLimitError'
  }
}

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
  // comparison). The walk keeps ONE shared path stack and copies it only when
  // a node's key is retained (PT-Q q-6, AR-E10): recursion passes just the
  // edge tail (`[branch, seq]`), so each edge no longer copies the whole
  // accumulated prefix. The retained keys are unchanged — a chain still yields
  // O(inserts × depth) total key length, which is the output's own size.
  const path: number[] = []
  const visit = (record: InsertedRowRecord, tail: readonly number[]): void => {
    if (keys.has(record.id)) return
    const depth = path.length
    path.push(...tail)
    keys.set(record.id, [...path, 1])
    for (const child of beforeByAnchor.get(record.id) ?? []) visit(child, [0, child.seq])
    for (const child of afterByAnchor.get(record.id) ?? []) visit(child, [1, child.seq])
    path.length = depth
  }

  for (const record of start) visit(record, [-1, record.seq])
  const anchorOrdinals = new Set<number>()
  for (const anchor of beforeByAnchor.keys()) collectBaseOrdinal(base, anchor, anchorOrdinals)
  for (const anchor of afterByAnchor.keys()) collectBaseOrdinal(base, anchor, anchorOrdinals)
  for (const ordinal of [...anchorOrdinals].sort((a, b) => a - b)) {
    if (ordinal >= base.baseRowCount || state.deletedBase.has(ordinal)) continue
    const id = baseRowId(base.baseAnchor, ordinal)
    for (const child of beforeByAnchor.get(id) ?? []) visit(child, [0, ordinal, 0, child.seq])
    for (const child of afterByAnchor.get(id) ?? []) visit(child, [0, ordinal, 1, child.seq])
  }
  for (const record of end) visit(record, [1, record.seq])
  const leftovers = [...state.inserts.values()]
    .filter((record) => record.live && !keys.has(record.id))
    .sort(bySeq)
  let visitIndex = 0
  for (const record of leftovers) visit(record, [2, visitIndex++])
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
 * Reject a user-entered literal string carrying an **unpaired UTF-16
 * surrogate** (`\uD800`–`\uDFFF` with no valid pair). The engine wire encoder
 * (`TextEncoder` in the duckdb-wasm worker; N-API UTF-8 elsewhere) cannot
 * represent a lone surrogate and silently replaces it with U+FFFD, so the
 * edit would materialize — and export — a *different* value (the au3-13
 * defect, the same lossless-or-loud shape as the NUL path). Rejecting at
 * compose time keeps the failure loud and before any SQL reaches the engine.
 *
 * Only user-entered cell literals pass through this check; base-data
 * passthrough is deliberately untouched (a U+FFFD already in a source file is
 * a legitimate character and never reaches a literal builder). The thrown
 * message is **value-free** (ADR 0025): it names the defect and the remedy,
 * never the cell text.
 */
/**
 * Whether `text` carries no unpaired UTF-16 surrogate (see
 * {@link assertWellFormedCellText} for the pairing rules). Total and
 * non-throwing, so call sites can raise their own value-free error class.
 */
function isWellFormedCellText(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const paired = text.charCodeAt(index + 1)
      if (paired >= 0xdc00 && paired <= 0xdfff) {
        index += 1 // a well-formed surrogate pair: skip its low half
      } else {
        return false
      }
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

function assertWellFormedCellText(text: string): void {
  if (!isWellFormedCellText(text)) throw unpairedSurrogateError()
}

/** The value-free unpaired-surrogate rejection (see `assertWellFormedCellText`). */
function unpairedSurrogateError(): Error {
  return new Error(
    'cell text contains an unpaired surrogate and cannot be materialized losslessly; replace it with a valid character',
  )
}

/**
 * The value-free unpaired-surrogate rejection for a **repair's output** — a
 * mapping target (wrap arm or D17 rewrite) produced hostile text. Distinct
 * from {@link unpairedSurrogateError} so the guard's execution is observable
 * at the rewrite boundary (cellLiteralSql re-guards string kinds underneath;
 * the specific message is what makes that defence-in-depth layer pinnable).
 */
function repairUnpairedSurrogateError(): Error {
  return new Error(
    'the repaired value contains an unpaired surrogate and cannot be materialized losslessly; replace it with a valid character or undo the repair',
  )
}

/**
 * One `CellValue` as a typed SQL literal, cast under the column's *effective*
 * type so each UNION branch keeps the column's declared type exactly (a bare
 * literal could widen the branch type — e.g. a DOUBLE literal would silently
 * widen a BIGINT column). `text` is the domain's engine-parseable literal:
 * emitted as text and cast under the column's type, so a bad literal
 * surfaces as a readable engine conversion error at materialization (never
 * silent corruption). Boolean/number values landing on textual columns render
 * through the engine's own cast (documented v1 behavior). String/text values
 * are checked for well-formed UTF-16 first ({@link assertWellFormedCellText}):
 * an unpaired surrogate has no lossless representation on the wire.
 */
export function cellLiteralSql(value: CellValue, effectiveType: string): string {
  // The type string reaches SQL verbatim; validate it here as the last line
  // of defence (the wire boundary and the composer already did — a caller
  // reaching this directly must not bypass the validator).
  validateEngineTypeExpression(effectiveType)
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
      // `String(-0)` is `'0'`, so a user-entered `-0` normalizes to `+0` at
      // this literal boundary — the single normalization point (`JSON`/
      // `JSONL`/`CSV` all read the materialized value, and JSON.stringify(-0)
      // is `'0'` too), so every export agrees; pinned in overlay-query.test.ts.
      // String() of a JS number is its shortest round-trip form; DuckDB
      // parses integer and scientific-decimal literals exactly.
      return `CAST(${String(value.value)} AS ${effectiveType})`
    }
    case 'string':
      assertWellFormedCellText(value.value)
      return `CAST(${sqlStringLiteral(value.value)} AS ${effectiveType})`
    case 'text':
      assertWellFormedCellText(value.text)
      return `CAST(${sqlStringLiteral(value.text)} AS ${effectiveType})`
  }
}

/**
 * One `CellValue` as a **raw** SQL literal with no type wrapper (m4-4b cast
 * check): the committed cast composes `CAST(<this literal> AS target)` and
 * the check composes `TRY_CAST(<this literal> AS target)`, so both apply the
 * target conversion to the same raw value. Wrapping the literal in a cast to
 * the base column type first (the previous source projection) could throw
 * *before* the check's `TRY_CAST` — e.g. `CAST('hello' AS DOUBLE)` for a
 * string edit on a DOUBLE base — a check/commit disagreement (m4-4b round-3
 * finding). `number` values use the same `String()` round-trip form as
 * `cellLiteralSql`; strings stay single-quote escaped. String/text values take
 * the same well-formedness guard as `cellLiteralSql`
 * ({@link assertWellFormedCellText}), so the cast check cannot silently pass a
 * value the commit would corrupt.
 */
export function cellLiteralRawSql(value: CellValue): string {
  switch (value.kind) {
    case 'null':
      return 'NULL'
    case 'boolean':
      return value.value ? 'TRUE' : 'FALSE'
    case 'number': {
      if (!Number.isFinite(value.value)) {
        throw new Error(`cell number ${String(value.value)} cannot be materialized`)
      }
      return String(value.value)
    }
    case 'string':
      assertWellFormedCellText(value.value)
      return sqlStringLiteral(value.value)
    case 'text':
      assertWellFormedCellText(value.text)
      return sqlStringLiteral(value.text)
  }
}

/**
 * CSV formula-injection guard (AGENTS security rule; review-gate hard
 * requirement): wraps a column expression so any cell whose rendered text
 * could initiate a formula in a spreadsheet app is neutralized with the
 * **apostrophe-prefix convention** — a leading `'` marks the cell as text.
 * Documented trigger set (probed by the conformance suite): the rendered
 * text starts with `=`, `+`, `-`, `@`, TAB (0x09), LF (0x0A) or CR (0x0D),
 * **or contains TAB/LF/CR anywhere** (embedded control characters can
 * obfuscate a leading initiator in spreadsheet parsers; OWASP's mitigation
 * list includes LF alongside TAB/CR — the S1 audit finding). NULL passes
 * through as NULL.
 *
 * This runs **pre-export, inside the SELECT the COPY consumes** — not as a
 * post-COPY byte rewrite — because (1) rewriting CSV bytes would require
 * re-parsing quoted CSV and risks corrupting legitimate quoting, (2) the SQL
 * form is a pure, deterministic function of the query, and (3) it composes
 * with the overlay projection in one statement. It applies only to CSV
 * exports and only to columns whose **effective type classifies as the
 * canonical string family** (`type-expr.ts`: `VARCHAR`/`TEXT`/`STRING`/
 * `CHAR(n)`/`BPCHAR`/`CHARACTER [VARYING]`/`ENUM(…)` — the only renderings
 * that can be formula-shaped; numbers/dates/booleans render as
 * numeric/temporal literals). The m4-2 review caught an exact-`'VARCHAR'`
 * check here: a `column-cast` to DuckDB's `TEXT` alias left bait cells raw.
 * The second fix-round review then caught a shape bug: `VARCHAR[]`,
 * `VARCHAR[3]` and `LIST(VARCHAR)` matched the same check, so the guard
 * wrapped an **array** value in `left()`/`contains()` and DuckDB failed the
 * export with a binder error. Classification is now shape-aware
 * (`type-expr.ts`): only a *scalar* textual type is guarded; an array's
 * rendered form is the engine's list literal (`[a, b]`, `[]`) and is left
 * unguarded. That is safe for the CSV attack surface: a DuckDB-rendered list
 * literal always starts with `[`, and a spreadsheet never evaluates `[` as a
 * formula introducer (`=`/`+`/`-`/`@`; a leading `-` inside a list cannot
 * begin the cell because the cell begins with `[`). The documented trade-off
 * on the scalar path: a string cell that legitimately starts with `-` gains
 * the prefix too.
 */
export function formulaInjectionGuardSql(expr: string): string {
  const triggers = `'=', '+', '-', '@', chr(9), chr(10), chr(13)`
  return (
    `CASE WHEN ${expr} IS NULL THEN NULL ` +
    `WHEN contains(${expr}, chr(9)) OR contains(${expr}, chr(10)) OR contains(${expr}, chr(13)) ` +
    `OR left(${expr}, 1) IN (${triggers}) THEN chr(39) || ${expr} ` +
    `ELSE ${expr} END`
  )
}

/**
 * The CSV-export rendering policy for one projected column expression: the
 * **only** place the projection decides between the string guard and BLOB
 * hex encoding, applied identically to the base branch and every insert
 * branch so the two can never drift.
 *
 * - **Scalar textual** columns take the apostrophe-prefix guard.
 * - **Scalar BLOB** columns are `hex()`-encoded. DuckDB's CSV writer emits
 *   BLOB bytes **raw** (CLI 1.5.5: `COPY (SELECT '=cmd|@SUM(1+1)'::BLOB …)
 *   TO … (FORMAT CSV)` writes a live formula-leading cell), and raw bytes
 *   cannot be handed to the guard's `contains`/`left` (BLOB is not text — a
 *   Binder Error). Hex is `[0-9A-F]`-only, so no spreadsheet parser can read
 *   the cell as a formula, and `from_hex` recovers the bytes losslessly.
 * - Every other type (numbers, dates, booleans, arrays, structs) is left
 *   untouched: its CSV rendering cannot begin with a formula initiator.
 *
 * NULL passes through as NULL for every class (`hex(NULL)` is NULL).
 */
function csvSafeExpression(expr: string, type: string): string {
  if (isBlobLikeEngineType(type)) return `hex(${expr})`
  if (isStringLikeEngineType(type)) return formulaInjectionGuardSql(expr)
  return expr
}

/**
 * The CSV **header** form of one column name — the header is row 1 of any
 * spreadsheet, so a hostile column name (`=SUM(A2:A3)`, `+x`, `-x`, `@x`, or
 * a name carrying TAB/LF/CR anywhere) is a live formula unless guarded. The
 * policy is the identifier twin of {@link formulaInjectionGuardSql}: prefix
 * the apostrophe (SQL `chr(39) || name`) when the name triggers. Because the
 * name is a known composition-time string, the prefix is applied directly
 * and the guarded name interpolated as a string-literal SELECT alias.
 * Non-CSV exports never call this: there the name is a data key, not a
 * formula, and must stay byte-identical.
 *
 * Known, accepted corners: (1) guarding is not injective — `=cmd` and
 * `'=cmd` both guard to `'=cmd`, and DuckDB dedupes the colliding COPY
 * header to `'=cmd_1` silently (no error, no data loss) — the identifier
 * twin of the value-guard prefix collision; (2) `read_csv` cannot re-open
 * a CSV whose *header* carries quoted CR/LF (the auto-sniffer refuses the
 * file), so those guarded forms are pinned at the composed-SQL level, not
 * via a round-trip — pre-existing sniffer behavior, out of our control.
 *
 * Deliberate **no-BOM** policy: the exported CSV carries no UTF-8 BOM
 * (`\uFEFF`). Byte-stable golden/conformance fixtures and programmatic
 * consumers win over Excel's double-click encoding heuristic; a BOM is a
 * documented non-goal of this data-interchange format, never emitted.
 */
function csvHeaderGuardName(name: string): string {
  const startsWithTrigger =
    name.startsWith('=') || name.startsWith('+') || name.startsWith('-') || name.startsWith('@')
  const containsControl = name.includes('\t') || name.includes('\n') || name.includes('\r')
  return startsWithTrigger || containsControl ? `'${name}` : name
}

// ---------------------------------------------------------------------------
// Composed relation parts
// ---------------------------------------------------------------------------

function assertNoReservedNames(base: OverlayBase, state: OverlayState): void {
  // Both the **base** and **effective** column names are checked: a base
  // column named `assay_overlay_ord` that a rename overlay moves away would
  // still be projected by the base branch and shadow the generated ordinal,
  // corrupting the edit CASE arms. The doc's "fail with a clear error"
  // promise must hold for the base schema too, not only the effective one.
  for (const column of [...base.columns, ...state.columns]) {
    if (RESERVED_OVERLAY_COLUMN_NAMES.has(column.name)) {
      throw new Error(
        `column name "${column.name}" is reserved by the engine overlay composer and cannot be composed`,
      )
    }
  }
}

/**
 * Validate every effective column type before any of them is interpolated
 * into SQL (m4-2 fix round, defence in depth): `state.columns[].type` is the
 * post-cast effective schema, so this single check covers both hostile base
 * column types and hostile `column-cast` targets. Throws the typed
 * `EngineTypeError`; composition has produced no SQL by then. The wire
 * boundary already drops such payloads — this path exists so a future caller
 * (or a bug in the boundary) can never reach a `CAST(x AS …)` with an
 * unvalidated string.
 */
function assertValidEffectiveTypes(state: OverlayState): void {
  for (const column of state.columns) {
    validateEngineTypeExpression(column.type)
  }
}

/**
/** One base-row edit for an effective column: its ordinal and folded value. */
interface BaseColumnEdit {
  readonly ordinal: number
  readonly value: CellValue
}

/**
 * Base-row edits grouped by effective (post-rename) column name, in ordinal
 * order. Composition calls this **once per compose** and every effective
 * column then does one map lookup — the pre-q-6 composer re-walked the whole
 * edit map per column (O(columns × edited rows) `parseRowId` calls; PT-Q q-6,
 * audit AR-E10). The filtered set and order are unchanged:
 *
 * - only edits whose row id is a base ordinal of **this** base anchor apply
 *   (foreign anchors are absorbed by the fold);
 * - a **tombstoned** ordinal's edit is dead: the row is already excluded from
 *   the effective view by the outer `WHERE … NOT IN (…)`, so its edit must not
 *   contribute a `CASE … THEN <literal>` arm. The bundled DuckDB-WASM 1.4.3
 *   projection evaluates an arm for a physically-present deleted row even
 *   though the outer filter excludes it (native 1.5.5 filters first), so a
 *   dead arm whose literal cannot convert to the pending cast target made the
 *   committed cast throw while the tombstone-filtered cast check answered
 *   `false` — a product-reachable check/commit disagreement (m4-4b round-4
 *   finding). Skipping dead edits is **composition-only**: the fold still
 *   retains them (m4-1), and a `row-restore` removes the ordinal from
 *   `state.deletedBase`, so the arms return automatically;
 * - each column's list is sorted ascending by ordinal.
 *
 * Shared by the effective projection (`cellLiteralSql` under the effective
 * type) and the m4-4b cast check (raw literals under its per-arm
 * `TRY_CAST`), so the two can never drift on *which* edits apply to a row.
 */
function groupBaseColumnEdits(
  base: OverlayBase,
  state: OverlayState,
): Map<string, BaseColumnEdit[]> {
  const grouped = new Map<string, BaseColumnEdit[]>()
  for (const [rowId, rowEdits] of state.edits) {
    const parsed = parseRowId(rowId as RowId)
    if (parsed === null || parsed.origin !== 'base') continue
    if (parsed.anchor !== base.baseAnchor) continue // foreign anchor: absorbed by the fold
    if (state.deletedBase.has(parsed.ordinal)) continue // dead row: outer WHERE excludes it
    for (const [effectiveName, value] of rowEdits) {
      const edits = grouped.get(effectiveName)
      if (edits === undefined) grouped.set(effectiveName, [{ ordinal: parsed.ordinal, value }])
      else edits.push({ ordinal: parsed.ordinal, value })
    }
  }
  for (const edits of grouped.values()) edits.sort((a, b) => a.ordinal - b.ordinal)
  return grouped
}

/**
 * The effective value of one inserted row's column: the folded `cell-set`
 * edit when the fold recorded one, else the insert record's value, else NULL
 * (the documented v1 absent-column rule). Shared by the effective insert
 * branch and the m4-4b cast check so both see the same merged value.
 */
function insertColumnValue(
  state: OverlayState,
  record: InsertedRowRecord,
  effectiveName: string,
): CellValue {
  return (
    state.edits.get(record.id)?.get(effectiveName) ??
    record.values.get(effectiveName) ?? { kind: 'null' }
  )
}

/**
 * One effective column's base-branch expression: the base column (quoted,
 * original base name — position `effectiveIndex` corresponds to the base
 * column at the same index, since renames/casts never reorder), cast under
 * the effective type when a cast applies, wrapped in a bounded CASE that
 * overlays this row's cell edits (edits are keyed by the effective
 * (post-rename) column name; the fold re-keys them). Tombstoned ordinals are
 * skipped by `groupBaseColumnEdits`, so a deleted row never contributes a dead
 * `CASE` arm. `ordinalRef` is the
 * computed base-ordinal reference visible at the branch's SELECT level;
 * `editIndex` is the per-compose grouping (so the edit map is scanned once per
 * request, not once per column).
 */
function baseColumnExpr(
  base: OverlayBase,
  state: OverlayState,
  effectiveIndex: number,
  ordinalRef: string,
  editIndex: ReadonlyMap<string, readonly BaseColumnEdit[]>,
  declaredTypeOverride?: string,
): string {
  const effective = state.columns[effectiveIndex]
  const baseColumn = base.columns[effectiveIndex]
  if (effective === undefined || baseColumn === undefined) {
    throw new Error(
      `overlay base metadata is inconsistent: effective column ${String(effectiveIndex)} has no base column`,
    )
  }
  const source = quotedIdentifier(baseColumn.name)
  // A repair column whose pending casts were made *after* the repair projects
  // under the wrap's input type here (the type at the last repair); the
  // post-repair cast chain applies outside the wrap (per-segment collapse,
  // D16/D17 probe §7.1 constraint 2). Every other column projects under its
  // effective type exactly as before.
  const declaredType = declaredTypeOverride ?? effective.type
  const withCast = declaredType === baseColumn.type ? source : `CAST(${source} AS ${declaredType})`
  const edits = editIndex.get(effective.name) ?? []
  if (edits.length === 0) return withCast
  const arms = edits.map(
    (edit) =>
      `WHEN ${ordinalRef} = ${String(edit.ordinal)} THEN ${cellLiteralSql(edit.value, declaredType)}`,
  )
  return `CASE ${arms.join(' ')} ELSE ${withCast} END`
}

/** What a composed relation carries beyond the plain effective columns. */
interface RelationOptions {
  /** Include the `assay_key` sort-key column (only meaningful with inserts). */
  readonly withKey: boolean
  /** Include the logical row-id column (`assay_row_id`). */
  readonly withRowIds: boolean
  /** Apply the CSV guard to scalar string-family columns (CSV export only). */
  readonly sanitizeCsv: boolean
  /**
   * Also project the base-ordinal machinery column (`assay_overlay_ord`; NULL
   * on insert branches) so repair wrap layers above the union can key their
   * exception arms. Repair compositions only — default off, so every
   * repair-free composition stays byte-identical and the machinery column
   * never leaks into a described relation.
   */
  readonly withOrdinal?: boolean
  /** Per-column declared-type override for repair wrap-input types (see `baseColumnExpr`). */
  readonly columnTypeOverrides?: ReadonlyMap<string, string>
  /**
   * Apply the D17 compose-time literal rewrite to insert branches of repaired
   * columns (window/export/schema). The count path composes without it: a
   * value transform never affects counts, and an invalid insert value must not
   * refuse a count that would otherwise answer.
   */
  readonly rewriteRepairs?: boolean
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
  assertNoReservedNames(base, state)
  const editIndex = groupBaseColumnEdits(base, state)
  const baseColumns = base.columns.map((column) => quotedIdentifier(column.name)).join(', ')
  const inner =
    `SELECT ${baseColumns}, (row_number() OVER () - 1) AS ${ORDINAL_COLUMN} ` +
    `FROM ${quotedIdentifier(viewName)}`
  const exprs = state.columns.map((column, index) => {
    const raw = baseColumnExpr(
      base,
      state,
      index,
      ORDINAL_COLUMN,
      editIndex,
      options.columnTypeOverrides?.get(column.name),
    )
    const guarded = options.sanitizeCsv ? csvSafeExpression(raw, column.type) : raw
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
  if (options.withOrdinal === true) {
    exprs.push(ORDINAL_COLUMN)
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
 *
 * The effective value for a column is the folded overlay edit when the fold
 * recorded one for this insert id, otherwise the insert record's value (m4-2b
 * fix). The domain's `stepOverlay` materializes `cell-set` into `state.edits`
 * (re-keyed by a later `column-rename`) and `cell-revert` by deleting that
 * entry, so consulting `state.edits` here reproduces `overlayEdit` exactly:
 * a reverted edit falls back to the insert value at the current fold position.
 * The old composer read `record.values` only and dropped these edits.
 */
function insertBranchSql(
  state: OverlayState,
  record: InsertedRowRecord,
  key: readonly number[],
  options: RelationOptions,
): string {
  const exprs = state.columns.map((column) => {
    const declaredType = options.columnTypeOverrides?.get(column.name) ?? column.type
    const merged = insertColumnValue(state, record, column.name)
    const literal = rewriteRepairsForInsertBranch(
      state,
      record,
      column.name,
      merged,
      declaredType,
      options,
    )
    // The CSV guard applies to insert branches too — a bait value in an
    // inserted row must be sanitized exactly like an edited base cell
    // (probed by the conformance suite's export round-trip). Classification
    // is the canonical string/BLOB family, not an exact `VARCHAR` spelling:
    // the m4-2 review found a `CAST(… AS TEXT)` column skipped the guard, and
    // a BLOB insert would otherwise write raw bytes. Repair compositions
    // sanitize above the wrap layers instead (the guard must see the
    // post-repair value), so this flag is never set together with repairs.
    const guarded = options.sanitizeCsv ? csvSafeExpression(literal, declaredType) : literal
    return `${guarded} AS ${quotedIdentifier(column.name)}`
  })
  if (options.withRowIds) {
    exprs.push(`${sqlStringLiteral(record.id)} AS ${quotedIdentifier(OVERLAY_ROW_ID_COLUMN)}`)
  }
  if (options.withKey) {
    exprs.push(`[${key.map(String).join(', ')}] AS ${quotedIdentifier(OVERLAY_SORT_KEY_COLUMN)}`)
  }
  if (options.withOrdinal === true) {
    exprs.push(`CAST(NULL AS BIGINT) AS ${ORDINAL_COLUMN}`)
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
    /** Repair machinery: see `RelationOptions` — repair compositions only. */
    readonly withOrdinal?: boolean
    readonly columnTypeOverrides?: ReadonlyMap<string, string>
    readonly rewriteRepairs?: boolean
  },
): string {
  const { base, state, viewName } = composition
  assertValidEffectiveTypes(state)
  const liveInserts = liveInsertRecords(state)
  assertLiveInsertBranchBudget(liveInserts.length)
  const withKey = options.withKey && liveInserts.length > 0
  const keys = withKey ? insertSortKeys(base, state) : undefined
  const relationOptions: RelationOptions = { ...options, withKey }
  const branches = [baseBranchSql(base, state, viewName, relationOptions)]
  for (const record of liveInserts) {
    branches.push(insertBranchSql(state, record, keys?.get(record.id) ?? [], relationOptions))
  }
  return branches.join(' UNION ALL ')
}

/**
 * The live inserted rows of a folded state (tombstoned inserts omitted), in
 * the folded map's order. The single source of the composer's branch count.
 */
function liveInsertRecords(state: OverlayState): InsertedRowRecord[] {
  return [...state.inserts.values()].filter((record) => record.live)
}

/**
 * Enforce the per-request live-insert branch budget (PT-Q q-6, audit AR-E10).
 * The count is the engine's own `UNION ALL` branch count — engine structure,
 * not dataset content — and the value-free {@link OverlayLiveInsertLimitError}
 * is thrown before any SQL is composed.
 */
function assertLiveInsertBranchBudget(liveInsertCount: number): void {
  if (liveInsertCount > MAX_OVERLAY_LIVE_INSERT_BRANCHES) {
    throw new OverlayLiveInsertLimitError()
  }
}

// ---------------------------------------------------------------------------
// Column-repair composition (EW-04D §6.2; D16/D17 probe record)
// ---------------------------------------------------------------------------

/**
 * One repaired column's composition plan, derived from the fold's
 * `state.repairs` (the value-independent half of the §6.2 rule) — the
 * composer evaluates exceptions without reading any values.
 */
interface RepairColumnPlan {
  /** Final effective (post-rename) column name — what the wrap re-projects. */
  readonly columnName: string
  /** The repair records in forward (prefix) order — earliest first. */
  readonly records: readonly RepairStepRecord[]
  /** The column's declared type at the LAST repair — the wrap's input type. */
  readonly inputType: string
  /** The column's final effective type — post-repair casts apply outside. */
  readonly finalType: string
}

/** Derive per-column repair plans from the folded state (O(repairs)). */
function repairPlansFor(state: OverlayState): ReadonlyMap<string, RepairColumnPlan> {
  const plans = new Map<string, RepairColumnPlan & { readonly records: RepairStepRecord[] }>()
  for (const record of state.repairs) {
    const column = state.columns[record.columnIndex]
    if (column === undefined) {
      throw new Error(
        `overlay base metadata is inconsistent: repair record column index ${String(record.columnIndex)} has no effective column`,
      )
    }
    const existing = plans.get(column.name)
    const records = existing === undefined ? [record] : [...existing.records, record]
    plans.set(column.name, {
      columnName: column.name,
      records,
      inputType: record.typeAtApply,
      finalType: column.type,
    })
  }
  return plans
}

/**
 * The exception ordinals of one repair record: base rows **not live** at the
 * repair's position, plus base rows that received an *applied* suffix value-op
 * on the repaired column (the per-row maskers). Insert ids are handled by the
 * D17 rewrite, never by exception arms. Sorted ascending; session-bounded.
 */
function repairExceptionOrdinals(base: OverlayBase, record: RepairStepRecord): readonly number[] {
  const ordinals = new Set<number>(record.deadOrdinalsAtApply)
  for (const rowId of record.maskedRows) {
    const parsed = parseRowId(rowId as RowId)
    if (parsed === null || parsed.origin !== 'base' || parsed.anchor !== base.baseAnchor) continue
    ordinals.add(parsed.ordinal)
  }
  return [...ordinals].sort((a, b) => a - b)
}

/** The trim set as a SQL string literal, after the lossless-text guard. */
function trimSetSql(trim: string): string {
  assertWellFormedCellText(trim)
  return sqlStringLiteral(trim)
}

/**
 * One repair's mapping CASE over `ref`: exact whole-value hits cast to the
 * repair's declared type, ELSE passthrough. With a trim, the operand and the
 * ELSE are the same explicit-set `trim(ref, …)` (the §1 shape — two `trim`
 * occurrences, never more); the operand is always the *trimmed* value, which
 * is why the fold refuses dead keys. Mapping text runs the surrogate guard:
 * a target is new user text and must be materializable losslessly.
 */
function repairMappingCaseSql(record: RepairStepRecord, ref: string): string {
  const arms = [...record.mapping].map(([from, to]) => {
    assertWellFormedCellText(from)
    assertWellFormedCellText(to)
    return `WHEN ${sqlStringLiteral(from)} THEN CAST(${sqlStringLiteral(to)} AS ${record.typeAtApply})`
  })
  if (arms.length === 0) {
    // Trim-only repair: the wrap is the trim itself (no CASE with zero arms).
    return record.trim !== undefined ? `trim(${ref}, ${trimSetSql(record.trim)})` : ref
  }
  const when = arms.join(' ')
  if (record.trim === undefined) return `CASE ${ref} ${when} ELSE ${ref} END`
  const setSql = trimSetSql(record.trim)
  const operand = `trim(${ref}, ${setSql})`
  return `CASE ${operand} ${when} ELSE ${operand} END`
}

/**
 * One repair's wrap expression over the layer input `ref`: the insert
 * pass-through arm (inserted rows carry their D17-rewritten literal — the
 * literal path *replaces* the wrap, never accompanies it, or application
 * cascades), one exception arm per masked/not-live ordinal (the underlying
 * cursor value, untransformed), and the mapping CASE as the ELSE. `m + x + 1`
 * arms (plus the machinery pass-through), emitted once per layer.
 */
function repairWrapExpressionSql(
  base: OverlayBase,
  record: RepairStepRecord,
  ref: string,
  hasLiveInserts: boolean,
): string {
  const exceptions = repairExceptionOrdinals(base, record)
  if (exceptions.length > MAX_REPAIR_EXCEPTION_ARMS) {
    throw new OverlayRepairExceptionLimitError()
  }
  const arms: string[] = []
  if (hasLiveInserts) {
    arms.push(`WHEN ${ORDINAL_COLUMN} IS NULL THEN ${ref}`)
  }
  for (const ordinal of exceptions) {
    arms.push(`WHEN ${ORDINAL_COLUMN} = ${String(ordinal)} THEN ${ref}`)
  }
  const mappingCase = repairMappingCaseSql(record, ref)
  // No exception arms and no inserts: the wrap is the mapping CASE alone —
  // a `CASE ELSE x END` with zero WHENs is never emitted.
  if (arms.length === 0) return mappingCase
  arms.push(`ELSE ${mappingCase}`)
  return `CASE ${arms.join(' ')} END`
}

/** The wrap's declared output type: `trim` types as `VARCHAR`, else the repair's declared type. */
function repairWrapDeclaredType(record: RepairStepRecord): string {
  return record.trim !== undefined ? 'VARCHAR' : record.typeAtApply
}

/**
 * The D17 compose-time literal rewrite for one live insert's merged value on
 * a repaired column: the surviving repairs (live at their position, no
 * applied suffix value-op) applied **forward and exactly once** to the
 * literal in TypeScript — one literal out, zero added arms. `NULL` stays
 * `NULL` (it never matches, and trim never produces it); `string`/`text`
 * kinds only — `number`/`boolean` render through the engine's own cast, whose
 * text diverges from `String()` (probe §2.4), so those refuse. `options`
 * without `rewriteRepairs` (the count path) leaves every branch untouched.
 */
function rewriteRepairsForInsertBranch(
  state: OverlayState,
  record: InsertedRowRecord,
  columnName: string,
  merged: CellValue,
  declaredType: string,
  options: RelationOptions,
): string {
  const plan = options.rewriteRepairs === true ? repairPlansFor(state).get(columnName) : undefined
  if (plan === undefined) return cellLiteralSql(merged, declaredType)
  const surviving = plan.records.filter(
    (entry) => entry.liveInsertIdsAtApply.has(record.id) && !entry.maskedRows.has(record.id),
  )
  if (surviving.length === 0) return cellLiteralSql(merged, declaredType)
  if (merged.kind === 'null') return cellLiteralSql(merged, declaredType)
  if (merged.kind !== 'string' && merged.kind !== 'text') {
    throw new OverlayRepairInsertValueError()
  }
  let text = merged.kind === 'string' ? merged.value : merged.text
  for (const entry of surviving) {
    const trimmed = entry.trim !== undefined ? trimWithCodePoints(text, entry.trim) : text
    text = entry.mapping.get(trimmed) ?? trimmed
  }
  // The rewritten value is new user text: the same surrogate guard as any
  // literal runs on the OUTPUT, not only the input (cellLiteralSql guards
  // string kinds again below — defence in depth at the literal boundary).
  if (!isWellFormedCellText(text)) throw repairUnpairedSurrogateError()
  return cellLiteralSql({ kind: 'string', value: text }, declaredType)
}

/**
 * The composed effective relation **with repair wraps applied**: the plain
 * `composeSourceSql` union when no repair is in the prefix (byte-identical to
 * composing it directly); otherwise the union with repaired columns projected
 * under their wrap-input types, then **one stacked projection layer per
 * repair** in forward prefix order (earliest innermost — each layer reads the
 * previous layer's output column; never one-expression nesting, which
 * duplicates the inner wrap into every outer arm and is falsified at two
 * repairs, U4/probe §4.2). Post-repair casts apply outside the wrap: the
 * column's last layer expression is wrapped in `CAST(… AS <final type>)` when
 * the wrap's declared type differs. The CSV guard sanitizes the post-repair
 * value, so it composes as one further outer projection when requested.
 *
 * Emitted size is additive: `O(Σₖ (mₖ + xₖ + 1))` arms and bytes, linear in
 * the repair prefix — never `O(∏ mₖ)`.
 */
function composeEffectiveSourceSql(
  composition: OverlayComposition,
  options: {
    readonly withRowIds: boolean
    readonly sanitizeCsv: boolean
    readonly withKey: boolean
  },
): string {
  const { base, state } = composition
  const plans = repairPlansFor(state)
  if (plans.size === 0) {
    return composeSourceSql(composition, options)
  }
  const liveInsertCount = liveInsertRecords(state).length
  const overrides = new Map<string, string>()
  for (const plan of plans.values()) {
    if (plan.inputType.toUpperCase() !== plan.finalType.toUpperCase()) {
      overrides.set(plan.columnName, plan.inputType)
    }
  }
  let sql = composeSourceSql(composition, {
    ...options,
    sanitizeCsv: false,
    withOrdinal: true,
    ...(overrides.size > 0 ? { columnTypeOverrides: overrides } : {}),
    rewriteRepairs: true,
  })
  const lastRecordPerColumn = new Map<string, RepairStepRecord>()
  for (const plan of plans.values()) {
    const last = plan.records[plan.records.length - 1]
    if (last !== undefined) lastRecordPerColumn.set(plan.columnName, last)
  }
  const carried: string[] = state.columns.map((column) => column.name)
  if (options.withRowIds) carried.push(OVERLAY_ROW_ID_COLUMN)
  if (options.withKey && liveInsertCount > 0) carried.push(OVERLAY_SORT_KEY_COLUMN)
  carried.push(ORDINAL_COLUMN)
  for (const record of state.repairs) {
    const column = state.columns[record.columnIndex]
    if (column === undefined) {
      throw new Error('overlay base metadata is inconsistent: repair record without column')
    }
    const ref = quotedIdentifier(column.name)
    let expression = repairWrapExpressionSql(base, record, ref, liveInsertCount > 0)
    if (lastRecordPerColumn.get(column.name) === record) {
      const plan = plans.get(column.name)
      const declared = repairWrapDeclaredType(record)
      if (plan !== undefined && plan.finalType.toUpperCase() !== declared.toUpperCase()) {
        expression = `CAST(${expression} AS ${plan.finalType})`
      }
    }
    const projections = carried.map((name) =>
      name === column.name ? `${expression} AS ${quotedIdentifier(name)}` : quotedIdentifier(name),
    )
    sql = `SELECT ${projections.join(', ')} FROM (${sql})`
  }
  if (options.sanitizeCsv) {
    // The formula-injection guard must see the post-repair value, so it
    // composes above the layers (never inside the wrap input).
    const projections = [
      ...state.columns.map(
        (column) =>
          `${csvSafeExpression(quotedIdentifier(column.name), column.type)} AS ${quotedIdentifier(column.name)}`,
      ),
    ]
    if (options.withRowIds) projections.push(quotedIdentifier(OVERLAY_ROW_ID_COLUMN))
    if (options.withKey && liveInsertCount > 0) {
      projections.push(quotedIdentifier(OVERLAY_SORT_KEY_COLUMN))
    }
    sql = `SELECT ${projections.join(', ')} FROM (${sql})`
  }
  return sql
}

/**
 * The published export budget (post-R1 acceptance option (a)): refuse before
 * composing when projected rows × mapping pairs exceeds
 * {@link MAX_REPAIR_EXPORT_CELL_WORK} — the U4-measured cost line (~4 s at
 * 2 M rows × 500 pairs on the shipped `eh` bundle, linear in rows × arms, no
 * engine interrupt). Projected rows are the rows the export actually
 * evaluates: base rows minus tombstones plus live inserts (the composer's
 * own branch count) — tombstoned rows are never projected, so they never pay.
 * Value-free; never claimed as an interrupt.
 */
function assertRepairExportBudget(composition: OverlayComposition): void {
  const totalPairs = composition.state.repairs.reduce((sum, record) => sum + record.mapping.size, 0)
  if (totalPairs === 0) return
  const liveInsertCount = liveInsertRecords(composition.state).length
  const rows = composition.base.baseRowCount - composition.state.deletedBase.size + liveInsertCount
  if (rows * totalPairs > MAX_REPAIR_EXPORT_CELL_WORK) {
    throw new OverlayRepairExportBudgetError()
  }
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
/**
 * `DESCRIBE SELECT …` over the composed effective relation — the effective
 * schema (post-rename names, post-cast DuckDB types), **wrapped** (D16(a),
 * accepted): the outer projection lists the effective columns over
 * `composeSourceSql`'s union (with `withRowIds: false`, `withKey: false`,
 * `sanitizeCsv: false` — the ordinal is created inside the base branch and
 * never projected), so the schema can only describe a relation the
 * materializing ops actually produce, and the engine enforces the
 * type-preservation argument per request instead of leaving it a proof
 * obligation. `DESCRIBE` is bind-only (probe: ~1 ms over a 2 M-row view), so
 * the wrap adds planning work only. With repairs in the prefix the described
 * relation includes the stacked repair layers, so the schema reports the
 * wrap's declared types (a repair never misdescribes a repair-free column).
 * A cast to a type string the engine rejects fails right here as a readable
 * binder error (declared-cast validation); a *value*-level cast failure
 * surfaces on the first materializing op — both typed engine errors, never
 * silent drift.
 */
export function composeOverlaySchemaSql(composition: OverlayComposition): string {
  assertNoReservedNames(composition.base, composition.state)
  assertValidEffectiveTypes(composition.state)
  const source = composeEffectiveSourceSql(composition, {
    withRowIds: false,
    sanitizeCsv: false,
    withKey: false,
  })
  const projection = composition.state.columns
    .map((column) => `${quotedIdentifier(column.name)} AS ${quotedIdentifier(column.name)}`)
    .join(', ')
  return `DESCRIBE SELECT ${projection} FROM (${source})`
}

/**
 * Existence check for a pending `column-cast` (m4-4b): does **any** non-NULL
 * value of the effective `column` fail to convert to `targetType`?
 *
 * The check answers exactly what the committed cast does. The domain
 * collapses a cast chain to a single direct `CAST(<value> AS final_type)` at
 * commit (`stepColumnCast` in `packages/domain/src/overlay.ts`), so for a
 * pending `column -> target` the committed effective view applies the target
 * conversion to each row's **raw** value: the un-cast base value for an
 * un-edited row, the raw edit literal for an overlaid cell, the raw
 * edit-or-insert value for an inserted row (absent columns are NULL). A
 * check that instead applied `TRY_CAST` to the composed relation's projected
 * value would either test the pre-cast intermediate type (the m4-4b round-2
 * false negative) or `CAST` each literal to the base column type first (the
 * round-3 finding: `CAST('hello' AS DOUBLE)` throws before the outer
 * `TRY_CAST` can absorb it, while the committed `CAST('hello' AS TEXT)`
 * succeeds).
 *
 * Structure: **per-arm `TRY_CAST` predicates** unioned as an existence
 * probe. The base branch scans the registered view once, with one predicate
 * arm per edited ordinal (`<ordinal> = o AND <raw literal> IS NOT NULL AND
 * TRY_CAST(<raw literal> AS target) IS NULL`) plus one arm over the un-edited
 * base column (`<ordinal> NOT IN (<edited>) AND <base> IS NOT NULL AND
 * TRY_CAST(<base> AS target) IS NULL`), tombstoned ordinals excluded. The
 * un-edited arm is **elided when it is provably empty** (see the note at the
 * omission site): every base value already has the base column's type, so an
 * arm that `TRY_CAST`s the base column to that same type can never fire. A
 * `cell-set` value check (target type = the effective type = the base type)
 * therefore composes **no per-row base predicate at all** — no
 * `TRY_CAST(<base> …)` and no `<ordinal> NOT IN (…)` arm — while a cast
 * pre-check (target type ≠ base type) keeps the full scan. What remains is one
 * predicate per edit plus the ordinal subquery (`row_number() OVER ()`) and the
 * `LIMIT 1` early exit, so the composed statement's *predicate* work is bounded
 * by the edits, not the row count (the ordinal subquery still enumerates the
 * base relation; eliding that is out of scope). Each
 * live insert contributes a FROM-less arm over its raw merged value. A
 * tombstoned ordinal's edit is skipped by `groupBaseColumnEdits`, exactly as in
 * the committed projection: the outer tombstone `WHERE` excludes the row, and
 * emitting the dead literal would give DuckDB-WASM 1.4.3 a value to evaluate
 * that the logical view never contains (m4-4b round-4 finding). No literal
 * is hard-cast to any type before its own `TRY_CAST`, so the check cannot
 * throw where the commit would succeed and cannot succeed where the commit
 * would throw. Edits, inserts, tombstones, renames, and prior casts are
 * handled via the same `groupBaseColumnEdits`/`insertColumnValue`/rename-aware
 * keying the effective composers use.
 *
 * Shape: `… LIMIT 1` keeps the existence probe early-exit and at most one
 * row; NULLs never count as failures (the `IS NOT NULL` guards), so all-NULL
 * and empty inputs answer `false`. `SELECT 1` (never a value) keeps dataset
 * contents out of the response (ADR 0025).
 *
 * The target type is untrusted host input interpolated into a SQL **type**
 * position, so it is validated here as exactly one complete DuckDB type
 * before any SQL is built (`type-expr.ts`, the same last-line-of-defence
 * discipline as `cellLiteralSql`); `column` must be an effective column of
 * the folded state, or composition fails with a typed unknown-column
 * rejection instead of a binder error. The effective schema types are
 * validated too (defence in depth, like the other composers).
 */
export function composeOverlayCastCheckSql(
  composition: OverlayComposition,
  column: string,
  targetType: string,
): string {
  validateEngineTypeExpression(targetType)
  const { base, state, viewName } = composition
  assertNoReservedNames(base, state)
  assertValidEffectiveTypes(state)
  const effectiveIndex = state.columns.findIndex((candidate) => candidate.name === column)
  if (effectiveIndex < 0) {
    throw new Error(`unknown overlay column: ${column}`)
  }
  const baseColumn = base.columns[effectiveIndex]
  if (baseColumn === undefined) {
    throw new Error(
      `overlay base metadata is inconsistent: effective column ${column} has no base column`,
    )
  }
  assertLiveInsertBranchBudget(liveInsertRecords(state).length)
  const repairRecords = state.repairs.filter((record) => record.columnIndex === effectiveIndex)
  if (repairRecords.length > 0) {
    return composeRepairCastCheckSql(
      base,
      state,
      viewName,
      column,
      effectiveIndex,
      baseColumn,
      targetType,
      repairRecords,
    )
  }
  return composeRepairFreeCastCheckSql(
    base,
    state,
    viewName,
    column,
    effectiveIndex,
    baseColumn,
    targetType,
  )
}

/**
 * The repair-free cast check — **byte-identical to the pre-repair composer**
 * (m4-4b). A repair-free column keeps the raw-arm shape because the domain
 * collapses its cast chain to one direct `CAST(<raw value> AS final_type)`,
 * and this raw-arm shape is the only one that sees the collapsed chain
 * (D16(b) scope qualifier; probe §3.1). Do not "simplify" it onto the split
 * form: that re-introduces the m4-4b round-3 defect class.
 */
function composeRepairFreeCastCheckSql(
  base: OverlayBase,
  state: OverlayState,
  viewName: string,
  column: string,
  effectiveIndex: number,
  baseColumn: { readonly name: string; readonly type: string },
  targetType: string,
): string {
  /** `<raw> IS NOT NULL AND TRY_CAST(<raw> AS target) IS NULL` — the raw
   *  value is non-NULL and the committed `CAST(<raw> AS target)` would throw. */
  const conversionFails = (raw: string): string =>
    `${raw} IS NOT NULL AND TRY_CAST(${raw} AS ${targetType}) IS NULL`
  const ordinal = ORDINAL_COLUMN
  const baseRef = quotedIdentifier(baseColumn.name)
  const edits = groupBaseColumnEdits(base, state).get(column) ?? []
  const editedOrdinals = edits.map((edit) => edit.ordinal)

  const arms = edits.map(
    (edit) =>
      `(${ordinal} = ${String(edit.ordinal)} AND ${conversionFails(cellLiteralRawSql(edit.value))})`,
  )
  // Provable elision of the un-edited base arm (R1-C): that arm can only find
  // a failure if some non-NULL base value does not convert to `targetType`.
  // When the folded effective column still carries its base type AND the check
  // targets that same type, every non-NULL base value already has it (NULLs
  // are excluded by the `IS NOT NULL` guard), so the arm is empty by
  // construction — only a pending cast (an effective/target type that differs
  // from the base type) can make base values fail. This is what keeps a
  // `cell-set` value check from composing a per-row base predicate: what
  // remains is one predicate per edit plus the ordinal subquery and `LIMIT 1`.
  // The subquery still enumerates the relation, so this bounds the *predicate*
  // work by the edits, not the whole statement's cost — eliding the ordinal
  // derivation is out of scope for this check. The elision requires at least one
  // edit arm so the remaining predicate is never empty: with no edits on the
  // column this function still answers the original "does the base column
  // convert?" question.
  const effectiveType = state.columns[effectiveIndex]?.type
  const baseArmProvablyEmpty =
    editedOrdinals.length > 0 && effectiveType === baseColumn.type && targetType === baseColumn.type
  if (!baseArmProvablyEmpty) {
    arms.push(
      editedOrdinals.length > 0
        ? `(${ordinal} NOT IN (${editedOrdinals.map(String).join(', ')}) AND ${conversionFails(baseRef)})`
        : `(${conversionFails(baseRef)})`,
    )
  }

  const baseColumns = base.columns.map((entry) => quotedIdentifier(entry.name)).join(', ')
  const inner =
    `SELECT ${baseColumns}, (row_number() OVER () - 1) AS ${ordinal} ` +
    `FROM ${quotedIdentifier(viewName)}`
  const tombstones = [...state.deletedBase].sort((a, b) => a - b)
  const tombstoneFilter =
    tombstones.length > 0 ? ` WHERE ${ordinal} NOT IN (${tombstones.map(String).join(', ')})` : ''
  const branches = [
    `SELECT 1 FROM (SELECT ${baseRef}, ${ordinal} FROM (${inner})${tombstoneFilter}) ` +
      `WHERE ${arms.join(' OR ')}`,
  ]
  for (const record of liveInsertRecords(state)) {
    // The insert value is a constant, so the arm needs no relation.
    branches.push(
      `SELECT 1 WHERE ${conversionFails(cellLiteralRawSql(insertColumnValue(state, record, column)))}`,
    )
  }
  return `${branches.join(' UNION ALL ')} LIMIT 1`
}

/**
 * One memoized per-signature segment of the repair chain (see
 * `composeRepairCastCheckSql`): the surviving layers' collapsed finite map
 * over the trimmed operand. `pairsSql` carries every collapsed (key →
 * target) pair; which pairs actually fail the pending conversion is decided
 * by the engine inside the semi-join, never host-side.
 */
interface Segment {
  readonly keysSql: readonly string[]
  readonly pairsSql: readonly string[]
  readonly operandOf: (raw: string) => string
}

/**
 * The repair-column cast check — the **split form** (D16(b), accepted; probe
/**
 * The repair-column cast check — the **split form** (D16(b), accepted; probe
 * §3.3). Once a value transform sits in the prefix, the committed conversion
 * of a pending cast is of the *repair output*, not of the raw value, so a
 * raw-arm check would answer the wrong question — and the literal reading
 * ("predicate over the wrapped value") is 100–200× more expensive as an
 * existence probe (CASE arms evaluate linearly in a filter, `IN (…)`
 * set-wise; `MATERIALIZED` does not rescue it). The split form is the same
 * question algebraically: per-row work is one trim + one `TRY_CAST` + hashed
 * set-membership; nothing m-shaped ever becomes a per-row CASE chain. It
 * keeps every m4-4b discipline — each value is `TRY_CAST`ed before any hard
 * cast, no literal is hard-cast to a type it is not committed under.
 *
 * **Per-layer exceptions (exact, not unioned).** A row the repair chain
 * excepts at *some* layers only does not fall back to the raw value: its
 * committed value is its **surviving sub-chain** applied to the raw source.
 * The composer classifies every edited/excepted base ordinal by its
 * exception signature across layers and collapses each distinct signature's
 * surviving sub-chain into one finite map (probe §3.5/probe18; the fold
 * guarantees one trim specification per column, which is what makes every
 * sub-chain exact from the fully-trimmed operand — keys are
 * trim-normalized because dead keys are refused). A row excepted at every
 * layer degenerates to the raw arm; a row excepted at none gets the full
 * chain. Unions of per-layer exception sets would answer the wrong question
 * (a row masked at layer 1 but repaired by layer 2 is `r₂(raw)`, not raw).
 *
 * **Mapped targets are conditional on actual matches.** A mapping constant
 * fails the pending conversion only when a projected row's operand actually
 * equals its key; a key no row holds must never fail the check (that was a
 * false-failure class). The failing set cannot be precomputed host-side
 * (conversion is the engine's — `TRY_CAST('5.5' AS BIGINT)` rounds), so the
 * failing keys are computed **by the engine** as a constant-relation
 * semi-join: `operand IN (SELECT k FROM (VALUES (k, t), …) WHERE
 * TRY_CAST(t) IS NULL)`. Rows only ever meet a set built from keys that
 * both match and fail — probe-measured mark-join membership is 0.034 s per
 * 200 k rows, the same two-orders-under-CASE class as the plain `IN` list.
 *
 * Edited non-exception rows keep a per-row arm over their raw literal
 * (bounded by edits, session-sized, never by the mapping). Empty-check
 * elision (R1-C generalized, probe §3.4): a textual target cannot fail on a
 * wrap whose declared type is text — every passthrough `TRY_CAST` is total,
 * and the semi-join's `TRY_CAST(t AS text)` never yields NULL, so the whole
 * statement is provably empty and the composer emits the empty check
 * instead of a scan.
 */
function composeRepairCastCheckSql(
  base: OverlayBase,
  state: OverlayState,
  viewName: string,
  column: string,
  _effectiveIndex: number,
  baseColumn: { readonly name: string; readonly type: string },
  targetType: string,
  repairRecords: readonly RepairStepRecord[],
): string {
  // A textual target cannot fail on a repair column: the wrap's declared type
  // is text (trim types as VARCHAR; a trim-less chain declares the textual
  // repair type), every mapping constant is a string, and exception rows'
  // raw literals are valid text too — TRY_CAST(text AS text) is total, and
  // the mapped-target semi-join's TRY_CAST never yields NULL either. The
  // provably-empty check is honest and free (probe §3.4).
  if (isTextualRepairType(targetType)) {
    return 'SELECT 1 WHERE FALSE LIMIT 1'
  }

  const conversionFails = (raw: string): string =>
    `${raw} IS NOT NULL AND TRY_CAST(${raw} AS ${targetType}) IS NULL`
  const ordinal = ORDINAL_COLUMN
  const baseRef = quotedIdentifier(baseColumn.name)
  const edits = groupBaseColumnEdits(base, state).get(column) ?? []
  const editsByOrdinal = new Map(edits.map((edit) => [edit.ordinal, edit]))

  // Per-signature sub-chain segments, memoized. `excepted` = layer indices
  // whose exceptions include the row; the segment collapses the SURVIVING
  // layers' forward composition into one finite map over the trimmed
  // operand. `pairsSql` carries every collapsed (key → target) pair; the
  // failing subset is selected by the engine inside the semi-join.
  const segmentCache = new Map<string, Segment>()
  const segmentFor = (exceptedIndices: readonly number[]): Segment => {
    const cacheKey = exceptedIndices.join('|')
    const cached = segmentCache.get(cacheKey)
    if (cached !== undefined) return cached
    const excepted = new Set(exceptedIndices)
    const chain = repairRecords.filter((_, index) => !excepted.has(index))
    const evalChain = (start: string): string => {
      let value = start
      for (const record of chain) {
        if (record.trim !== undefined) value = trimWithCodePoints(value, record.trim)
        const mapped = record.mapping.get(value)
        if (mapped !== undefined) value = mapped
      }
      return value
    }
    const keySet = new Set<string>()
    for (const record of chain) {
      for (const key of record.mapping.keys()) keySet.add(key)
    }
    const collapsed = new Map<string, string>()
    for (const key of keySet) {
      const final = evalChain(key)
      if (final !== key) collapsed.set(key, final)
    }
    const keysSql: string[] = []
    const pairsSql: string[] = []
    for (const [key, target] of collapsed) {
      assertWellFormedCellText(key)
      assertWellFormedCellText(target)
      keysSql.push(sqlStringLiteral(key))
      pairsSql.push(`(${sqlStringLiteral(key)}, ${sqlStringLiteral(target)})`)
    }
    const trim = chain[0]?.trim
    const segment: Segment = {
      keysSql,
      pairsSql,
      operandOf: (raw: string): string =>
        trim !== undefined ? `trim(${raw}, ${trimSetSql(trim)})` : raw,
    }
    segmentCache.set(cacheKey, segment)
    return segment
  }

  /**
   * The split predicate over one raw value source under one segment: the
   * committed value fails exactly when the trimmed operand passes through
   * (not a key) and fails `TRY_CAST`, OR it matches a key whose collapsed
   * target fails (the engine selects that subset — never an unconditional
   * per-target branch).
   */
  const splitPredicate = (raw: string, segment: Segment): string => {
    const operand = segment.operandOf(raw)
    const passthrough =
      `${operand} IS NOT NULL AND TRY_CAST(${operand} AS ${targetType}) IS NULL` +
      (segment.keysSql.length > 0 ? ` AND ${operand} NOT IN (${segment.keysSql.join(', ')})` : '')
    const mappedFails =
      segment.pairsSql.length > 0
        ? `${operand} IN (SELECT k FROM (VALUES ${segment.pairsSql.join(', ')}) AS p(k, t) ` +
          `WHERE TRY_CAST(t AS ${targetType}) IS NULL)`
        : null
    return mappedFails === null ? `(${passthrough})` : `(${passthrough} OR ${mappedFails})`
  }

  // Per-layer exception sets; an ordinal's signature lists the layers that
  // except it. Only ordinals carrying an exception are enumerated per-arm —
  // everything else shares the single full-chain conjunct.
  const layerExceptions = repairRecords.map(
    (record) => new Set(repairExceptionOrdinals(base, record)),
  )
  const signatureOf = (baseOrdinal: number): string =>
    layerExceptions
      .map((exceptions, index) => (exceptions.has(baseOrdinal) ? String(index) : null))
      .filter((part) => part !== null)
      .join('|')
  const anyException = new Set<number>()
  for (const exceptions of layerExceptions) {
    for (const exceptionOrdinal of exceptions) anyException.add(exceptionOrdinal)
  }

  const arms: string[] = []
  const editedOrdinals: number[] = []
  for (const edit of edits) {
    editedOrdinals.push(edit.ordinal)
    // Per-layer semantics: the edited row's own surviving sub-chain decides.
    const segment = segmentFor(
      signatureOf(edit.ordinal)
        .split('|')
        .filter((part) => part.length > 0)
        .map(Number),
    )
    arms.push(
      `(${ordinal} = ${String(edit.ordinal)} AND ` +
        `${splitPredicate(cellLiteralRawSql(edit.value), segment)})`,
    )
  }
  const exceptedUnedited = [...anyException]
    .filter((exceptionOrdinal) => !editsByOrdinal.has(exceptionOrdinal))
    .sort((a, b) => a - b)
  for (const exceptionOrdinal of exceptedUnedited) {
    const segment = segmentFor(
      signatureOf(exceptionOrdinal)
        .split('|')
        .filter((part) => part.length > 0)
        .map(Number),
    )
    arms.push(`(${ordinal} = ${String(exceptionOrdinal)} AND ${splitPredicate(baseRef, segment)})`)
  }
  // (1) Non-exception, un-edited base rows: the full chain applies.
  const skipOrdinals = [...new Set([...anyException, ...editedOrdinals])].sort((a, b) => a - b)
  const rowConjunct =
    (skipOrdinals.length > 0
      ? `${ordinal} NOT IN (${skipOrdinals.map(String).join(', ')}) AND `
      : '') + splitPredicate(baseRef, segmentFor([]))
  arms.push(`(${rowConjunct})`)

  const baseColumns = base.columns.map((entry) => quotedIdentifier(entry.name)).join(', ')
  const inner =
    `SELECT ${baseColumns}, (row_number() OVER () - 1) AS ${ordinal} ` +
    `FROM ${quotedIdentifier(viewName)}`
  const tombstones = [...state.deletedBase].sort((a, b) => a - b)
  const tombstoneFilter =
    tombstones.length > 0 ? ` WHERE ${ordinal} NOT IN (${tombstones.map(String).join(', ')})` : ''
  const branches = [
    `SELECT 1 FROM (SELECT ${baseRef}, ${ordinal} FROM (${inner})${tombstoneFilter}) ` +
      `WHERE ${arms.join(' OR ')}`,
  ]
  // (m) Mapped-target failures: conditional on actual matches, decided by
  // the engine. There is no unconditional per-target branch — a key no
  // projected row holds must never fail the check — and the failing subset
  // is the semi-join inside each split predicate above.
  for (const record of liveInsertRecords(state)) {
    const merged = insertColumnValue(state, record, column)
    const survivingChain = repairRecords.filter(
      (entry) => entry.liveInsertIdsAtApply.has(record.id) && !entry.maskedRows.has(record.id),
    )
    if (
      survivingChain.length > 0 &&
      merged.kind !== 'null' &&
      merged.kind !== 'string' &&
      merged.kind !== 'text'
    ) {
      // Same refusal the materializing ops compose: the window would refuse,
      // so the check must not answer a value it cannot commit.
      throw new OverlayRepairInsertValueError()
    }
    const raw = cellLiteralRawSql(merged)
    if (survivingChain.length === 0) {
      // Excepted at every layer (or before the chain): the raw value.
      branches.push(`SELECT 1 WHERE ${conversionFails(raw)}`)
    } else {
      // The inserted row's own surviving sub-chain decides (per-layer
      // exception semantics, D17 rewrite in TS mirrors this walk).
      const exceptedIndices = repairRecords
        .map((entry, index) => (survivingChain.includes(entry) ? null : Number(index)))
        .filter((index) => index !== null)
      const segment = segmentFor(exceptedIndices as number[])
      branches.push(`SELECT 1 WHERE ${splitPredicate(raw, segment)}`)
    }
  }
  return `${branches.join(' UNION ALL ')} LIMIT 1`
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
 * explicit sort keys — with `assay_key` appended as the deterministic
 * tiebreak only when live inserts exist (no-insert overlays keep base
 * window semantics: equal sort keys engine-ordered, audit AR-E8; without
 * explicit keys and without inserts no ORDER BY is added at all) — then the
 * pre-validated LIMIT/OFFSET interpolated verbatim.
 */
export function composeOverlayWindowSql(query: OverlayWindowQuery): string {
  const { columns, filters, sort, includeRowIds } = query
  const source = composeEffectiveSourceSql(query, {
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
 * (DuckDB-WASM's bundled build has no Arrow COPY writer, so Arrow IPC
 * *streams* are assembled worker-side from the streamed result (the web layer
 * advertises the stream MIME `application/vnd.apache.arrow.stream` — not the
 * feather-file MIME); the SELECT is byte-
 * identical to the COPY path's input, keeping the two formats honest
 * siblings).
 *
 * The projection is the **outer** SELECT above `composeSourceSql`'s
 * `UNION ALL` branches, so a CSV header alias applies uniformly to the base
 * and every insert branch (the branches already agree on raw column names,
 * and the alias is positional). For `csv` only, each projected column is
 * aliased to its apostrophe-guarded name (row 1 is a spreadsheet surface);
 * every other format projects the raw name verbatim so json/jsonl/parquet/
 * arrow bytes are unchanged — there a name is a data key, not a formula.
 */
export function composeOverlayExportSelectSql(
  composition: OverlayComposition,
  format: EngineExportFormat,
): string {
  // The export budget is a pre-apply refusal: projected rows × mapping pairs
  // over the published envelope refuses before any SQL is composed or run
  // (never claimed as an interrupt).
  assertRepairExportBudget(composition)
  const source = composeEffectiveSourceSql(composition, {
    withRowIds: false,
    sanitizeCsv: format === 'csv',
    withKey: true,
  })
  const projection = composition.state.columns
    .map((column) => {
      const reference = quotedIdentifier(column.name)
      if (format !== 'csv') return reference
      return `${reference} AS ${sqlStringLiteral(csvHeaderGuardName(column.name))}`
    })
    .join(', ')
  let sql = `SELECT ${projection} FROM (${source})`
  if ([...composition.state.inserts.values()].some((record) => record.live)) {
    sql += ` ORDER BY ${quotedIdentifier(OVERLAY_SORT_KEY_COLUMN)}`
  }
  return sql
}
