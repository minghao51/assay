/**
 * Data-engine conformance suite (docs/engineering/05-repository-structure.md §4).
 *
 * Mandate: every DataEngine implementation passes the same conformance suite,
 * so engines can evolve (or be added) without changing product behavior. The
 * suite is therefore **parameterized over a subject** — an
 * `EngineConformanceSubject` adapter that exposes the engine's client through
 * structural interfaces defined here. This package never imports an engine
 * implementation (dependency direction: implementations import `@assay/testing`
 * and provide the adapter — see engine-duckdb's browser harness for the
 * reference adapter).
 *
 * Scenarios (the engine surface Assay has today):
 *
 * 1. `lazy-boot` — constructing a client performs no work; the first use
 *    boots the engine and later calls share that boot.
 * 2. `file-lifecycle` — open → schema → fetchRange → rowCount → dispose,
 *    including post-dispose rejection with the disposed error and dispose
 *    idempotency.
 * 3. `error-classes` — invalid SQL, unknown table handles, and unsupported
 *    file formats reject with the engine's distinct error categories, and
 *    every one of those failures leaves the engine running (reusable).
 * 4. `window-clamping` — oversized `fetchRange` windows are **clamped** (not
 *    rejected) to the engine's window cap, tail windows stay correct, and
 *    invalid windows are rejected without materializing anything.
 * 5. `arrow-shape` — results are Apache Arrow tables (ADR 0020) whose schema
 *    and column values (NULL preserved as `null`) are readable through the
 *    Arrow vector API, for both `fetchRange` and `query`.
 * 6. `corrupt-file-rollback` — registration of a corrupt Parquet is lazy
 *    (succeeds), but binding its view must fail; the engine must roll the
 *    registration back (no phantom table/view left registered) and stay
 *    reusable for a subsequent good open.
 * 7. `mid-stream-error-reuse` — a query whose first record batch succeeds but
 *    whose later batches fail must reject as a query error, release the
 *    connection (cleanup), and leave the engine reusable.
 *
 * m2-2 adds filtered/sorted-window scenarios (the engine surface the grid's
 * sort/filter state drives; predicates are engine-SQL text per grid contracts
 * v1 / ADR 0029):
 *
 * 8. `window-filter-sort` — filtered windows return exactly the declared
 *    matching values; the filtered `rowCount` matches; sort asc/desc orders
 *    as declared; filter+sort compose; window clamping and validation still
 *    apply under filters; and the no-filter window stays in natural order
 *    (the grid's null-clear protocol: absent filters/sort = none).
 * 9. `predicate-error-reuse` — invalid or hostile filter probes reject with a
 *    *classified* engine error (operation/query category — never a crash or
 *    protocol error) and the engine stays ready and reusable; breakout
 *    probes (escape attempts) are contained: the registered view and its
 *    data survive untouched.
 *
 * m2-5 adds the profiling scenario (the surface m2-6's profile panel drives):
 *
 * 10. `profile-semantics` — `profile()` returns the declared exact stats on a
 *     purpose-built dataset: per-column kinds match the declared classifier
 *     contract; nullCount/distinctCount are exact; numeric min/max/mean/
 *     stddev/quantiles are exact (within the declared float tolerance);
 *     categorical top-k is exact including the declared tie order; a
 *     nulls-only column degrades to topK=[] without failing; profile type
 *     strings agree with `schema()`; an unknown handle rejects with a
 *     classified error and the engine stays reusable.
 *
 * m3-1 adds nested-data fidelity scenarios (the surfaces M3's cell preview,
 * inspector, and flatten/explode drive; expectations are pinned against the
 * host engine — engine-duckdb: DuckDB CLI + the identical duckdb-wasm build):
 *
 * 11. `nested-schema-fidelity` — `schema()` on the nested JSONL fixture
 *     reports the engine's full nested type strings exactly as pinned (they
 *     feed the m1-6 type tree and m3-4's composer), and `rowCount` matches.
 * 12. `nested-window-fidelity` — `fetchRange` over a table with struct/list
 *     columns delivers values **deep-equal** to the pinned expectations
 *     across the worker boundary (Arrow IPC): structs as records, lists as
 *     arrays, NULL preserved at every depth (struct field, list element,
 *     whole struct/list), 64-bit integers as exact numbers, timestamps as
 *     exact epoch-millisecond numbers.
 * 13. `nested-window-clamp` — with nested columns present, window semantics
 *     are unchanged: a >window-size request is clamped (not rejected) and
 *     arrives as one honest batch (`hasMore`), a validated offset window
 *     returns exactly its declared slice deep-equal, and invalid windows
 *     still reject with the operation category.
 *
 * m4-2 adds the edit-overlay scenarios (the surfaces M4's editing grid and
 * export dialog drive; ADR 0012 overlay materialization + export/rewrite):
 *
 * 14. `overlay-window-fidelity` — a scripted op sequence (edits, inserts at
 *     anchored/nested/dead positions, a delete, rename, cast, plus no-op and
 *     foreign-anchor replays) composed over the staged base delivers the
 *     pinned **effective schema** (post-rename, post-cast), the pinned live
 *     row count (tombstoned base rows excluded, live inserts added, filtered
 *     count included), and windows whose row order reproduces the domain's
 *     `effectiveRowIds` contract exactly — start rows first, base order,
 *     before/after chains nested depth-first, dead anchors degraded to the
 *     end — with every cell value pinned (host-engine-derived; engine-duckdb:
 *     DuckDB CLI 1.5.5 over the identical composed SQL), plus filter and
 *     sort over the effective (renamed) columns and a LIMIT/OFFSET slice.
 * 15. `export-round-trip` — `exportView` materializes the effective view
 *     into a NEW file per declared format with honest counts; the exported
 *     file is re-opened (through the engine for the formats the engine
 *     reads; through its Arrow IPC container for `arrow`, which the engine
 *     cannot re-open until the m1-4 arrow-reader deferral lands) and its
 *     content must equal the declared per-format expectations — in
 *     particular the CSV export must be **formula-injection-sanitized**
 *     (apostrophe-prefix convention) while the JSONL export keeps the raw
 *     content visible (both non-vacuously asserted).
 * 16. `source-immutability` — the staged source file's digest is captured
 *     before an edit+export session and re-checked after windows, counts,
 *     schema reads, and exports of every declared format: byte-identical
 *     (ADR 0012 — the source is never rewritten in place), and no export
 *     path ever equals the source path.
 * 17. `overlay-hostile-types-rejected` (m4-2 fix round) — hostile engine
 *     type expressions (base `columns[].type` and `column-cast.targetType`,
 *     incl. the review's `VARCHAR) AS "c" … ; CREATE TABLE …` payload) are
 *     rejected with the typed operation category, the injection's named
 *     side-effect table does not exist afterwards, and the engine stays
 *     reusable with the ordinary overlay surface intact.
 * 18. `overlay-insert-edits` (m4-2b defect fix) — a focused op sequence over
 *     the canonical overlay base inserts a row, edits a cell the insert left
 *     NULL, edits then reverts a second cell, and renames the edited columns:
 *     the composed effective schema, live count, window order/values and a
 *     CSV+JSONL export round-trip must show the folded **merged** values —
 *     the edit wins over the insert record's value, and a reverted edit falls
 *     back to the insert value. These are exactly the values the m4-2
 *     composer dropped (it read `InsertedRowRecord.values` only); the pins
 *     are host-engine-derived (engine-duckdb: DuckDB CLI 1.5.5 over the
 *     identical composed SQL).
 * 19. `overlay-cast-check` (m4-4b) — a validate-before-commit cast check
 *     (ADR 0012) over the **pre-cast** effective relation: all-convertible
 *     and all-NULL columns answer `false`; a bad value mid-dataset, a bad
 *     value only in an inserted row, and a bad value carried through a
 *     rename all answer `true`; invalid target spellings and unknown
 *     effective columns reject with the typed operation category and the
 *     engine stays usable. Expected classifications are host-engine-derived
 *     (engine-duckdb: DuckDB CLI 1.5.5 over the identical composed SQL).
 * 20. `validation-plan-execution` (m5-2) — the REAL m5-1 compiler turns the
 *     subject's contract into a plan against the engine's own schema(); the
 *     engine executes it over the **effective view**: exact per-rule
 *     counts/percent/samples (CLI-derived), overlay-interaction pins in all
 *     four directions (fix flips, violate flips, inserted violations appear
 *     under `ins:` keys, tombstoned violations disappear, row-count facts
 *     flip), the K clamp (failCount unaffected, samples engine-clamped;
 *     m5-2 round 3: any safe K ≥ 1 executes — a K past the hard max runs
 *     with samples clamped and the FULL failCount), hostile plans rejected
 *     with one typed error and no side effects (including the round-3
 *     comment-bearing pseudo-reference probes and a shape-valid plan whose
 *     counts exceed the dataset — the round-3 result-sanity guard), and
 *     the m5-0 type-vocabulary agreement (all 21 spellings against engine
 *     DESCRIBE output; the bare-DECIMAL caveat pinned).
 *
 * Environments: the scenario functions are environment-neutral (no DOM, no
 * Node APIs); the subject adapter decides how files are staged (OPFS in the
 * browser, temp files in Node) and which SQL drives engine-specific paths.
 * The suite's own logic is unit-tested in Node against an in-memory fake
 * engine (`engine-conformance.test.ts`); real engines prove themselves by
 * running the same scenarios in their harness (engine-duckdb: Playwright e2e).
 */
import { Vector, type Table } from 'apache-arrow'
import { CONTRACT_TYPE_VOCABULARY, parseContract } from '@assay/contracts'
import { compileContract } from '@assay/validation'
import { compileRowDiffPlan } from '@assay/diff'

// ---- Structural surface the suite exercises (implementations adapt to it) ----

/** A column as the engine reports it, with optional expected cell values. */
export interface ConformanceColumn {
  readonly name: string
  readonly type: string
  /**
   * Expected values of the first N rows, rendered with `String()` (null for
   * NULL). Omit to skip value assertions for this column (e.g. for types whose
   * JS rendering is engine-specific, like dates).
   */
  readonly values?: readonly (string | null)[]
}

/** The dataset the subject stages for the good-file scenarios. */
export interface ConformanceDataset {
  readonly columns: readonly ConformanceColumn[]
  readonly rowCount: number
}

/** The file-source seam, structurally (a `FileSystemFileHandle` satisfies it). */
export interface ConformanceFileSource {
  readonly name: string
  getFile(): Promise<unknown>
}

/** Opaque handle to a registered table. */
export interface ConformanceTableHandle {
  readonly kind: 'table'
  readonly id: string
}

/**
 * A requested half-open row window `[startRow, endRow)`, optionally narrowed
 * by `filters` and ordered by `sort` (m2-2). Absent (or empty) filters/sort
 * mean "no predicates"/"natural order" — the grid's null-clear protocol.
 */
export interface ConformanceWindow {
  readonly startRow: number
  readonly endRow: number
  readonly filters?: readonly ConformanceFilterSpec[]
  readonly sort?: readonly ConformanceSortSpec[]
}

/** One filter predicate: engine-defined SQL text on a column (grid v1, ADR 0029). */
export interface ConformanceFilterSpec {
  readonly column: string
  readonly predicate: string
}

/** One sort key with an explicit direction. */
export interface ConformanceSortSpec {
  readonly column: string
  readonly direction: 'asc' | 'desc'
}

/** An Arrow result: exactly one record batch, plus the honest truncation flag. */
export interface ConformanceBatchResult {
  readonly batch: Table
  readonly hasMore: boolean
}

// ---- Edit-overlay + export types (m4-2) ----
//
// Structural mirrors of the domain's edit-operations model (m4-1: `CellValue`,
// `InsertPosition`, `EditOp`, `OverlayBase` — same precedent as the profile
// mirrors above): the suite never imports `@assay/domain`; engine
// implementations whose clients take the domain types satisfy these
// structurally, and subjects build ops that are valid domain ops.

/** One overlay cell value (structural mirror of the domain's `CellValue`). */
export type ConformanceCellValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'text'; readonly text: string }

/** Where an overlay insert asks to appear (mirror of `InsertPosition`). */
export type ConformanceInsertPosition =
  | { readonly kind: 'start' }
  | { readonly kind: 'end' }
  | { readonly kind: 'before'; readonly rowId: string }
  | { readonly kind: 'after'; readonly rowId: string }

/**
 * The closed 8-kind edit-op vocabulary (mirror of the domain's `EditOp`).
 * Insert values are keyed by column; absent columns materialize as NULL.
 */
export type ConformanceEditOp =
  | {
      readonly kind: 'cell-set'
      readonly rowId: string
      readonly column: string
      readonly value: ConformanceCellValue
    }
  | { readonly kind: 'cell-revert'; readonly rowId: string; readonly column: string }
  | {
      readonly kind: 'row-insert'
      readonly rowId: string
      readonly position: ConformanceInsertPosition
      readonly values: ReadonlyMap<string, ConformanceCellValue>
    }
  | { readonly kind: 'row-uninsert'; readonly rowId: string }
  | { readonly kind: 'row-delete'; readonly rowId: string }
  | { readonly kind: 'row-restore'; readonly rowId: string }
  | { readonly kind: 'column-rename'; readonly from: string; readonly to: string }
  | { readonly kind: 'column-cast'; readonly column: string; readonly targetType: string }

/** The immutable base an overlay composes over (mirror of `OverlayBase`). */
export interface ConformanceOverlayBase {
  /** Opaque host token for the immutable base version. */
  readonly baseAnchor: string
  /** Opaque host token for the editing session (insert-id scope). */
  readonly overlayAnchor: string
  /** The base schema, in base order (unique names). */
  readonly columns: readonly { readonly name: string; readonly type: string }[]
  /** Rows in the base version. */
  readonly baseRowCount: number
}

/** The overlay a request composes over: base metadata + the op list. */
export interface ConformanceOverlay {
  readonly base: ConformanceOverlayBase
  readonly ops?: readonly ConformanceEditOp[]
}

/** A requested window over the composed effective view (m4-2). */
export interface ConformanceOverlayWindow {
  readonly startRow: number
  readonly endRow: number
  readonly filters?: readonly ConformanceFilterSpec[]
  readonly sort?: readonly ConformanceSortSpec[]
  /** Prepend the logical row-id column to the projection. */
  readonly includeRowIds?: boolean
}

/** Export formats of the m4-2 export/rewrite op. */
export type ConformanceExportFormat = 'parquet' | 'jsonl' | 'json' | 'csv' | 'arrow'

/** Result of the export op: generated destination path + honest counts. */
export interface ConformanceExportResult {
  readonly path: string
  readonly format: ConformanceExportFormat
  readonly rowCount: number
  readonly bytes: number
}

/** The client surface the conformance scenarios drive. */
export interface ConformanceEngineClient {
  /** Lifecycle state; the subject defines which strings mean idle/ready. */
  readonly status: string
  /** Boot the engine if needed; concurrent calls must share the boot. */
  ensureReady(): Promise<unknown>
  open(source: ConformanceFileSource): Promise<ConformanceTableHandle>
  schema(handle: ConformanceTableHandle): Promise<readonly ConformanceColumn[]>
  /** Total rows; with `options.filters` (m2-2), the filtered matching count. */
  rowCount(
    handle: ConformanceTableHandle,
    options?: { readonly filters?: readonly ConformanceFilterSpec[] },
  ): Promise<number>
  fetchRange(
    handle: ConformanceTableHandle,
    window: ConformanceWindow,
  ): Promise<ConformanceBatchResult>
  query(sql: string): Promise<ConformanceBatchResult>
  /** Full statistics profile of a registered table (m2-5). */
  profile(handle: ConformanceTableHandle): Promise<ConformanceDatasetProfile>
  /** Effective schema of the composed overlay — post-rename, post-cast (m4-2). */
  overlaySchema(
    handle: ConformanceTableHandle,
    overlay: ConformanceOverlay,
  ): Promise<readonly ConformanceColumn[]>
  /**
   * Live row count of the composed overlay (tombstones excluded, live
   * inserts added); `options.filters` narrows with the m2-2 grammar over
   * effective columns.
   */
  overlayRowCount(
    handle: ConformanceTableHandle,
    overlay: ConformanceOverlay,
    options?: { readonly filters?: readonly ConformanceFilterSpec[] },
  ): Promise<number>
  /**
   * Window over the composed effective view: edits visible, deletes
   * excluded, inserts at their anchored positions (the `effectiveRowIds`
   * order). `window.includeRowIds` prepends the logical row-id column.
   */
  fetchOverlayRange(
    handle: ConformanceTableHandle,
    overlay: ConformanceOverlay,
    window: ConformanceOverlayWindow,
  ): Promise<ConformanceBatchResult>
  /**
   * Validate-before-commit cast check (m4-4b, ADR 0012): over the given
   * **pre-cast** overlay state, report whether any non-NULL value of the
   * effective `column` cannot convert to `targetType`. `targetType` is
   * validated with the engine's strict type validator and `column` must be a
   * known effective column; an invalid target spelling or unknown column
   * rejects with a typed operation error (never a silent pass).
   */
  overlayCastCheck(
    handle: ConformanceTableHandle,
    overlay: ConformanceOverlay,
    request: { readonly column: string; readonly targetType: string },
  ): Promise<ConformanceCastCheckResult>
  /**
   * Validation execution (m5-2): execute a compiled m5-1 plan against the
   * effective view (absent `overlay`: the plain base view). The plan is the
   * real compiler's output; the result carries per-rule counts/percent/samples
   * keyed by ruleId, the effective row count, and the total verdict.
   */
  validate(
    handle: ConformanceTableHandle,
    plan: ConformanceValidationPlan,
    overlay?: ConformanceOverlay,
  ): Promise<ConformanceValidationResult>
  /**
   * Stage a comparison dataset file for a row diff (m6-2, checkpoint C3):
   * registers the file in the engine's comparison scratch slot (never the
   * source path) and returns an opaque comparison handle carrying the staged
   * view's schema. Only one comparison is staged at a time; re-staging
   * replaces it. An unreadable or unsupported file rejects with a classified
   * engine error.
   */
  stageComparison(source: ConformanceFileSource): Promise<ConformanceComparisonHandle>
  /**
   * Row-diff execution (m6-2): execute a compiled m6-1 plan with side A bound
   * to the table's effective view (base + the optional overlay, or the plain
   * base view when absent) and side B bound to the staged comparison. The
   * result carries both row counts and per-aspect exact counts plus bounded,
   * side-qualified samples.
   */
  diff(
    handle: ConformanceTableHandle,
    comparison: ConformanceComparisonHandle,
    plan: ConformanceRowDiffPlan,
    overlay?: ConformanceOverlay,
  ): Promise<ConformanceRowDiffResult>
  /**
   * Export/rewrite (m4-2): materialize the effective view (absent `overlay`:
   * the plain base view) into a NEW generated file — never the source path
   * (ADR 0012/0017).
   */
  exportView(
    handle: ConformanceTableHandle,
    request: { readonly format: ConformanceExportFormat; readonly overlay?: ConformanceOverlay },
  ): Promise<ConformanceExportResult>
  /** Terminal, idempotent; safe before the first boot. */
  dispose(): Promise<void>
}

/**
 * Error-category matchers. Engines classify their failures into operation
 * (bad handle/window/format — engine keeps running), query (the SQL failed —
 * engine keeps running), and disposed (used after dispose). The matchers keep
 * the suite decoupled from concrete error classes while still asserting the
 * *classification* contract (callers branch on these categories).
 */
export interface ConformanceErrorMatchers {
  operation(error: unknown): boolean
  query(error: unknown): boolean
  disposed(error: unknown): boolean
}

/** The adapter an engine implementation provides to run the suite. */
export interface EngineConformanceSubject {
  /** Engine identifier for reports (e.g. `engine-duckdb`). */
  readonly name: string
  /** A fresh, not-yet-booted client. */
  createClient(): ConformanceEngineClient
  /** True while the client has never been used (nothing booted yet). */
  isIdle(client: ConformanceEngineClient): boolean
  /** True once the engine completed its boot. */
  isReady(client: ConformanceEngineClient): boolean
  readonly errors: ConformanceErrorMatchers
  /** The known good dataset behind `stageGoodFile()`. */
  readonly dataset: ConformanceDataset
  /** Maximum rows a single `fetchRange` window may return (the engine cap). */
  readonly maxWindowRows: number
  /**
   * Row count of `stageWideFile()` — must exceed `maxWindowRows` so the
   * clamping scenario exercises the cap itself, not just the dataset end.
   */
  readonly wideRowCount: number
  /** Stage the known good dataset and return a source for `client.open()`. */
  stageGoodFile(): Promise<ConformanceFileSource>
  /** Stage the wide dataset (`wideRowCount` rows; runtime-built bytes). */
  stageWideFile(): Promise<ConformanceFileSource>
  /**
   * Stage the purpose-built profiling dataset (`profileDataset`, m2-5):
   * a numeric column with a null, duplicate-heavy categoricals, a count tie,
   * a nulls-only column — runtime-built bytes, never committed.
   */
  stageProfileFile(): Promise<ConformanceFileSource>
  /** Raw bytes of a valid Parquet file (the suite corrupts them itself). */
  goodParquetBytes(): Promise<Uint8Array>
  /** Stage arbitrary bytes under the given name (host decides the store). */
  stageBytes(bytes: Uint8Array, name: string): Promise<ConformanceFileSource>
  /** SQL the engine rejects (syntax or semantic error). */
  failingSql(): string
  /**
   * SQL that produces a successful first record batch and then fails on a
   * later batch (engine-specific mechanism; deterministic).
   */
  midStreamFailureSql(): string
  /** SQL returning exactly one row / one column with `smokeSqlValue`. */
  smokeSql(): string
  readonly smokeSqlValue: string
  /**
   * How many tables/views the engine currently holds registered for this
   * client (the registry probe the rollback scenario asserts against).
   * Return `null` if the engine cannot observe it — the scenario then skips
   * the probe rather than passing vacuously.
   */
  registeredTableCount(client: ConformanceEngineClient): Promise<number | null>
  /**
   * Declared filter/sort semantics over the good dataset (m2-2): each entry
   * names the filters/sort to apply (engine-SQL text per grid contracts v1),
   * the column whose rendered values to assert, the exact expected values
   * across the whole matching set in expected order (NULLs rendered as
   * `null`, engine null-ordering as declared), and the expected matching row
   * count. Preconditions the suite enforces: every `expectColumn` exists in
   * `dataset.columns` and every `expectRowCount` is ≤ `maxWindowRows`.
   */
  readonly windowSemantics: readonly ConformanceWindowSemantics[]
  /**
   * Exact profile expectations over `stageProfileFile()`'s dataset (m2-5),
   * verified against the host engine (engine-duckdb: DuckDB CLI 1.5.5).
   */
  readonly profileDataset: ConformanceProfileDataset
  /**
   * Filter probes that MUST reject with a classified engine error (operation
   * or query category — never a crash/protocol error), leaving the engine
   * ready and reusable. Covers invalid SQL text, references to non-dataset
   * columns, and quote-hostile identifier names (the identifier must stay an
   * identifier: an escape would have to "succeed" or crash instead).
   */
  readonly rejectingFilters: readonly ConformanceFilterSpec[]
  /**
   * Breakout probes (m2-2 injection containment): filter texts attempting to
   * escape the composed statement (e.g. extra `;`-separated statements).
   * Whatever the engine does with the statement — reject it, or run it as
   * harmless SQL on the user's own view — the registered view, its data, and
   * the engine must survive intact (the scenario verifies via the benign
   * filtered window/count and the registry probe).
   */
  readonly breakoutFilters: readonly ConformanceFilterSpec[]
  /**
   * The nested dataset behind `stageNestedFile()` (m3-1): the pinned schema
   * type strings, deep-equal window expectations, and the offset window the
   * clamp scenario replays. Expected values are derived from the host engine
   * (engine-duckdb: DuckDB CLI 1.5.5 cross-checked against the identical
   * duckdb-wasm build's Arrow output).
   */
  readonly nestedDataset: ConformanceNestedDataset
  /** Stage the nested dataset (`nestedDataset`; committed JSONL, m3-1). */
  stageNestedFile(): Promise<ConformanceFileSource>
  /**
   * The edit-overlay dataset behind `stageOverlayFile()` (m4-2): the base
   * metadata + the scripted op list, and the host-engine-pinned effective
   * expectations (schema, counts, full row order/values, slice, filter,
   * sort, per-format export checks). engine-duckdb derives every pin with
   * the DuckDB CLI 1.5.5 over the identical composed SQL (see the subject
   * adapter for the derivation). Runtime-built staging bytes with embedded
   * formula-injection bait cells (never committed as data).
   */
  readonly overlayDataset: ConformanceOverlayDataset
  /** Stage the overlay base dataset (`overlayDataset.base`). */
  stageOverlayFile(): Promise<ConformanceFileSource>
  /**
   * The inserted-row-edit dataset behind `stageOverlayInsertEditsFile()`
   * (m4-2b defect fix): a focused op sequence over the canonical overlay base
   * that edits cells of an **inserted** row (one the insert left NULL, one
   * overriding the insert's own value, one edited then reverted) and renames
   * the edited columns. Pins the merged effective schema/count/order/values
   * and the CSV+JSONL export round-trip; every pin is host-engine-derived
   * (engine-duckdb: DuckDB CLI 1.5.5 over the identical composed SQL).
   */
  readonly overlayInsertEdits: ConformanceOverlayInsertEditsDataset
  /** Stage the overlay base dataset (`overlayInsertEdits` composes over). */
  stageOverlayInsertEditsFile(): Promise<ConformanceFileSource>
  /**
   * The cast-conversion-check dataset behind `stageOverlayCastCheckFile()`
   * (m4-4b): the pre-cast base + ops plus the cases, invalid target
   * spellings, and unknown columns the `overlay-cast-check` scenario drives.
   */
  readonly overlayCastCheckDataset: ConformanceOverlayCastCheckDataset
  /** Stage the cast-check base dataset (`overlayCastCheckDataset`). */
  stageOverlayCastCheckFile(): Promise<ConformanceFileSource>
  /**
   * The m5-2 validation dataset behind `stageValidationFile()`: an on-demand
   * runtime-built dirty dataset (temp/OPFS, never committed), its contract
   * YAML, and CLI-derived expectations covering the base run, the empty-
   * overlay run, the overlay-interaction battery, the K-clamp truncation,
   * hostile plans, and the type-vocabulary agreement pins.
   */
  readonly validationDataset: ConformanceValidationDataset
  /** Stage the dirty validation dataset (`validationDataset`). */
  stageValidationFile(): Promise<ConformanceFileSource>
  /**
   * The m6-2 row-diff dataset behind `stageRowDiffFile()` /
   * `stageRowDiffComparisonFile()`: two runtime-built on-demand dirty files
   * (temp/OPFS, never committed), the explicit keys, and CLI-derived
   * expectations covering the base run, the overlay-interaction battery, the
   * K-clamp, hostile plans, and the staging failure paths.
   */
  readonly rowDiffDataset: ConformanceRowDiffDataset
  /** Stage side A of the row-diff pair (the main dataset). */
  stageRowDiffFile(): Promise<ConformanceFileSource>
  /** Stage side B of the row-diff pair (the comparison dataset). */
  stageRowDiffComparisonFile(): Promise<ConformanceFileSource>
  /**
   * A comparison file source whose bytes cannot be resolved (the staging
   * "missing file" path): `getFile()` rejects with a classified operation
   * error, so the scenario can assert the typed rejection and reuse.
   */
  readonly missingComparisonSource: ConformanceFileSource
  /**
   * Create (and clean up) a table with one column per m5-0 vocabulary
   * spelling and return its reported name/type pairs — the engine-side half
   * of the m5-0 type-vocabulary agreement pin. Implementations derive the
   * pairs from the same DESCRIBE surface `schema()` reports from.
   */
  vocabularySchema(client: ConformanceEngineClient): Promise<readonly ConformanceColumn[]>
  /**
   * Ground-truth probe for the cast-check agreement pin (m4-4b round 3):
   * apply `column-cast column -> targetType` to the pre-cast `overlay` and
   * attempt to materialize the committed effective view; resolve `true` when
   * that materialization fails with a conversion rejection, `false` when it
   * succeeds. The scenario asserts `overlayCastCheck` equals this outcome, so
   * the check can never disagree with what committing the cast would do.
   * Implementations treat only conversion-class failures (the operation/query
   * error category — in DuckDB-WASM's mvp bundle the opaque `_setThrew`
   * emscripten glue error) as a rejection; every other failure must propagate.
   */
  committedCastFails(
    client: ConformanceEngineClient,
    handle: ConformanceTableHandle,
    overlay: ConformanceOverlay,
    request: { readonly column: string; readonly targetType: string },
  ): Promise<boolean>
  /**
   * Hostile type-expression probes (m4-2 fix round): overlays whose base
   * column type or `column-cast` target is a SQL-injection-shaped string.
   * The `overlay-hostile-types-rejected` scenario requires a typed operation
   * rejection for each and asserts any named `injectedTable` absent.
   */
  readonly hostileTypeProbes: readonly ConformanceHostileTypeProbe[]
  /**
   * Whether a table/view with this name is currently registered — the
   * side-effect probe for hostile type payloads. Return `false` when the
   * engine cannot observe it.
   */
  tableExists(client: ConformanceEngineClient, name: string): Promise<boolean>
  /**
   * A stable content digest (e.g. sha-256 hex) of the staged file behind
   * `source` — the byte-identity probe the source-immutability scenario
   * asserts with. Must reflect the file's CURRENT bytes on every call.
   */
  sourceDigest(source: ConformanceFileSource): Promise<string>
  /**
   * A file source that re-opens a completed export through the engine's
   * ordinary `open()` path (its name carries the exported extension so the
   * engine picks the right reader). OPFS-backed in the browser.
   */
  exportedSource(result: ConformanceExportResult): Promise<ConformanceFileSource>
  /**
   * Read a completed export's bytes through its native container reader and
   * return the resulting Arrow table — the content check for formats the
   * engine cannot re-open yet (`arrow`; the m1-4 arrow-reader deferral).
   * Must reflect the file's CURRENT bytes.
   */
  readExportedArrowTable(result: ConformanceExportResult): Promise<ConformanceBatchResult>
}

/** One declared filter/sort expectation over the good dataset (see the subject field). */
export interface ConformanceWindowSemantics {
  /** Stable label (appears in scenario facts only). */
  readonly label: string
  readonly filters?: readonly ConformanceFilterSpec[]
  readonly sort?: readonly ConformanceSortSpec[]
  /** The column whose rendered values `expectValues` declares. */
  readonly expectColumn: string
  /** Expected values of `expectColumn` over the whole matching set, in order. */
  readonly expectValues: readonly (string | null)[]
  /** Expected number of matching rows (≤ `maxWindowRows`). */
  readonly expectRowCount: number
}

// ---- Profile types (m2-5) ----
//
// Structural mirrors of the engine's profile contract: a conformance client's
// `profile()` returns `ConformanceDatasetProfile`, and the subject declares
// the exact expectations in `ConformanceProfileDataset`. Categorical values
// are engine-rendered text (same ADR 0007-spirit contract as the engine
// types: rendered once, deterministically; NULLs never appear in top-k).

/** How the engine classified a profiled column. */
export type ConformanceProfileKind = 'numeric' | 'categorical' | 'other'

/** The numeric payload a `numeric` column must carry (m2-5). */
export interface ConformanceNumericStats {
  readonly min: number | null
  readonly max: number | null
  readonly mean: number | null
  readonly stddev: number | null
  readonly quantiles: {
    readonly p50: number | null
    readonly p90: number | null
    readonly p95: number | null
    readonly p99: number | null
  }
}

/** The categorical payload a `categorical` column must carry (m2-5). */
export interface ConformanceCategoricalStats {
  /** Ordered top-k: count descending, ties by value ascending (the contract). */
  readonly topK: readonly { readonly value: string; readonly count: number }[]
}

/** One column of a `profile()` result. */
export interface ConformanceColumnProfile {
  readonly name: string
  readonly type: string
  readonly kind: ConformanceProfileKind
  readonly nullCount: number
  readonly distinctCount: number
  readonly numeric?: ConformanceNumericStats
  readonly categorical?: ConformanceCategoricalStats
}

/** The `profile()` result shape the conformance client surface returns. */
export interface ConformanceDatasetProfile {
  readonly rowCount: number
  readonly columns: readonly ConformanceColumnProfile[]
}

/** One column's exact expectations in `ConformanceProfileDataset`. */
export interface ConformanceColumnProfileExpectation {
  readonly name: string
  readonly kind: ConformanceProfileKind
  readonly nullCount: number
  readonly distinctCount: number
  /** Required iff kind is 'numeric'; forbidden otherwise. */
  readonly numeric?: ConformanceNumericStats
  /** Required iff kind is 'categorical'; forbidden otherwise. */
  readonly categorical?: ConformanceCategoricalStats
}

/**
 * The exact profile expectations for `stageProfileFile()`'s dataset (m2-5),
 * verified against the host engine (engine-duckdb: DuckDB CLI 1.5.5).
 * Preconditions the suite enforces (fail loudly on misconfiguration, never
 * vacuously): at least one column; a column with nulls; a nulls-only column;
 * a categorical top-k whose first two entries tie on count (so the declared
 * tie order is pinned); payload/kind coherence.
 */
export interface ConformanceProfileDataset {
  readonly rowCount: number
  /** Absolute tolerance for numeric comparisons (engine float paths differ in the last ulp). */
  readonly numericTolerance?: number
  readonly columns: readonly ConformanceColumnProfileExpectation[]
}

// ---- Nested-fidelity types (m3-1) ----

/**
 * A JSON-shaped cell value: what `normalizeArrowCell` produces from an Arrow
 * cell and what the nested expectations declare. 64-bit integers and
 * timestamps must be pinned as exact (safe) JS numbers; NULL at any depth is
 * `null`.
 */
export type ConformanceNestedValue =
  | null
  | boolean
  | number
  | string
  | readonly ConformanceNestedValue[]
  | { readonly [key: string]: ConformanceNestedValue }

/** One nested column's deep-equal expectations for the fixture's leading rows. */
export interface ConformanceNestedColumnValues {
  readonly name: string
  /** Expected values of rows `[0, values.length)`, in order (null = NULL). */
  readonly values: readonly ConformanceNestedValue[]
}

/**
 * The nested dataset the m3-1 scenarios stage and pin (engine-duckdb: the
 * `fixtures/jsonl/nested.jsonl` golden fixture):
 *
 * - `schema` pins `schema()` exactly — name + full nested type string, in
 *   column order (these strings feed the m1-6 type tree and m3-4's composer).
 * - `columns` pins deep-equal values for rows `[0, N)` of selected columns
 *   across the Arrow IPC worker boundary (structs as records, lists as
 *   arrays, NULL preserved at every depth).
 * - `offsetWindow` is a validated mid-file window the clamp scenario replays
 *   to prove limit/offset semantics are unchanged with nested columns. Its
 *   end must be covered by the declared value rows (`columns[*].values.length ≥ endRow`).
 */
export interface ConformanceNestedDataset {
  readonly rowCount: number
  readonly schema: readonly ConformanceColumn[]
  readonly columns: readonly ConformanceNestedColumnValues[]
  readonly offsetWindow: ConformanceWindow
}

// ---- Edit-overlay dataset types (m4-2) ----

/** One effective column's pinned values for the whole effective row set. */
export interface ConformanceOverlayColumnValues {
  readonly name: string
  readonly values: readonly (string | null)[]
}

/** One declared filter/sort expectation over the effective view (m4-2). */
export interface ConformanceOverlaySemantics {
  /** Stable label (scenario facts/messages only). */
  readonly label: string
  readonly filters?: readonly ConformanceFilterSpec[]
  readonly sort?: readonly ConformanceSortSpec[]
  /** The effective column whose rendered values `expectValues` declares. */
  readonly expectColumn: string
  /** Expected values over the whole matching set, in expected order. */
  readonly expectValues: readonly (string | null)[]
  readonly expectRowCount: number
}

/**
 * One export check: a format to export with, how its content is verified,
 * and the pinned re-opened content (effective order, rendered values).
 */
export interface ConformanceExportCheck {
  readonly format: ConformanceExportFormat
  /**
   * `'engine'` — re-open the exported file through the engine's ordinary
   * `open()` path (the formats the engine reads back). `'arrow-container'`
   * — verify through the export's native Arrow IPC container (the engine
   * cannot re-open `.arrow` files yet: the m1-4 arrow-reader deferral).
   */
  readonly roundTrip: 'engine' | 'arrow-container'
  /** Expected row count (the export result's honest count). */
  readonly rowCount: number
  /** Expected re-opened columns: names + rendered values, in order. */
  readonly columns: readonly ConformanceOverlayColumnValues[]
}

/** The m4-2 overlay dataset a subject stages and pins (see the subject field). */
export interface ConformanceOverlayDataset {
  /** The immutable base metadata the ops compose over. */
  readonly base: ConformanceOverlayBase
  /** The scripted op list folded per request (stateless composition). */
  readonly ops: readonly ConformanceEditOp[]
  /** Effective schema: post-rename names, post-cast engine type strings. */
  readonly effectiveSchema: readonly ConformanceColumn[]
  /** Live row count: base − tombstones + live inserts. */
  readonly liveRowCount: number
  /**
   * The effective row order as logical row ids — the `effectiveRowIds`
   * emission order the engine's windows must reproduce exactly.
   */
  readonly rowIds: readonly string[]
  /** The row-id column's name in `includeRowIds` windows. */
  readonly rowIdColumn: string
  /** Every effective column's pinned values over the whole effective set. */
  readonly columns: readonly ConformanceOverlayColumnValues[]
  /** A LIMIT/OFFSET slice over the effective order. */
  readonly offsetWindow: { readonly startRow: number; readonly endRow: number }
  /** A filtered window over effective columns (m2-2 grammar). */
  readonly filtered: ConformanceOverlaySemantics
  /** A sorted window over effective columns (m2-2 grammar). */
  readonly sorted: ConformanceOverlaySemantics
  /** Per-format export checks (CSV must probe sanitization — see the scenario). */
  readonly exports: readonly ConformanceExportCheck[]
}

/**
 * The m4-2b inserted-row-edit dataset behind `stageOverlayInsertEditsFile()`:
 * a focused op sequence over the canonical overlay base that inserts a row,
 * edits a cell the insert left NULL, edits then reverts a second cell, and
 * renames the edited columns. The pins below are the folded **merged** values
 * the fixed composer must project (edit wins over the insert record's value;
 * a revert falls back to it) — the exact values the m4-2 composer dropped by
 * reading `InsertedRowRecord.values` only. Narrower than
 * {@link ConformanceOverlayDataset} on purpose: schema, live count, the
 * effective order/values, and the export round-trip are the surfaces this
 * defect touches.
 */
export interface ConformanceOverlayInsertEditsDataset {
  /** The immutable base metadata the ops compose over. */
  readonly base: ConformanceOverlayBase
  /** The scripted op list folded per request (stateless composition). */
  readonly ops: readonly ConformanceEditOp[]
  /** Effective schema: post-rename names, post-cast engine type strings. */
  readonly effectiveSchema: readonly ConformanceColumn[]
  /** Live row count: base − tombstones + live inserts. */
  readonly liveRowCount: number
  /** The effective row order as logical row ids (`effectiveRowIds` order). */
  readonly rowIds: readonly string[]
  /** The row-id column's name in `includeRowIds` windows. */
  readonly rowIdColumn: string
  /** Every pinned column's values over the whole effective set. */
  readonly columns: readonly ConformanceOverlayColumnValues[]
  /** Per-format export checks (CSV must probe the merged-edit sanitization). */
  readonly exports: readonly ConformanceExportCheck[]
}

/**
 * One declared cast-check case (m4-4b): the effective column to test over the
 * pre-cast state, the target type spelling, and the expected classification.
 */
export interface ConformanceOverlayCastCheckCase {
  /** Stable label (scenario facts/messages only — never dataset contents). */
  readonly label: string
  /** The effective (post-rename/cast) column to test. */
  readonly column: string
  /** The target type spelling the check converts to. */
  readonly targetType: string
  /** Expected `hasNonConvertibleValues`. */
  readonly hasNonConvertibleValues: boolean
}

/**
 * One agreement-battery case (m4-4b round 3): a self-contained pre-cast
 * overlay (the shared base + these ops), the effective column and target type
 * the host would check, and the classification both the check and the
 * committed cast must produce. The scenario asserts `overlayCastCheck` equals
 * the committed materialization (via the subject's `committedCastFails`
 * probe), so the check cannot silently disagree with what committing does.
 */
export interface ConformanceOverlayCastCheckAgreement {
  /** Stable label (scenario facts/messages only — never dataset contents). */
  readonly label: string
  /** The pre-cast op list (folded over the shared base) the check runs on. */
  readonly ops: readonly ConformanceEditOp[]
  /** The effective column to test. */
  readonly column: string
  /** The target type spelling the check converts to. */
  readonly targetType: string
  /** Expected `hasNonConvertibleValues` (equal to the committed outcome). */
  readonly hasNonConvertibleValues: boolean
}

/**
 * The m4-4b cast-conversion-check dataset behind
 * `stageOverlayCastCheckFile()`: a base dataset plus a scripted op sequence
 * (a rename, an edit, and an inserted bad value) whose **effective** relation
 * the check scans. The cases pin the surfaces a 1-row probe cannot cover:
 * a bad value mid-dataset, a bad value only in an inserted row, a bad value
 * after a rename, and the all-NULL/all-convertible `false` cases. The
 * `agreements` battery pins the check against the actually-committed cast for
 * (state, target) pairs the evaluator must not diverge on.
 */
export interface ConformanceOverlayCastCheckDataset {
  /** The immutable base metadata the ops compose over. */
  readonly base: ConformanceOverlayBase
  /** The scripted op list folded per request (the pre-cast state). */
  readonly ops: readonly ConformanceEditOp[]
  /** The cases the check must classify. */
  readonly cases: readonly ConformanceOverlayCastCheckCase[]
  /**
   * Agreement battery (m4-4b round 3): per-case pre-cast ops + target, each
   * asserting the check's boolean equals the committed cast's outcome.
   */
  readonly agreements: readonly ConformanceOverlayCastCheckAgreement[]
  /** Target spellings the validator must reject with a typed operation error. */
  readonly invalidTargetTypes: readonly string[]
  /** Effective column names that must reject as unknown with a typed error. */
  readonly unknownColumns: readonly string[]
}

/** Result of the cast check: a boolean only (never dataset values, ADR 0025). */
export interface ConformanceCastCheckResult {
  readonly hasNonConvertibleValues: boolean
}

// ---- Validation-execution types (m5-2) ----
//
// Structural mirrors of the m5-1 `ValidationPlan` (`@assay/validation`) and
// the engine's `EngineValidationResult` (the same precedent as the overlay
// and profile mirrors): the suite never imports an engine, and REAL compiled
// plans flow through these shapes because the scenario compiles the subject's
// contract with the real m5-1 compiler against the engine's own schema().

/** One compiled rule (mirror of the plan's `PlannedRule`). */
export interface ConformanceValidationRule {
  readonly ruleId: string
  readonly path: string
  readonly kind: string
  readonly column: string | null
  readonly outcome: string
  readonly sql: string
  readonly expectedType?: string
  readonly actualType?: string
}

/** A compiled validation plan (mirror of m5-1's `ValidationPlan`). */
export interface ConformanceValidationPlan {
  readonly planKind: string
  readonly planVersion: number
  readonly contractName: string
  readonly contractVersion: number
  readonly relation: string
  readonly sampleLimit: number
  readonly rules: readonly ConformanceValidationRule[]
  readonly summarySql: string
}

/** One sample failure: a logical row key + the offending value (wire-safe). */
export interface ConformanceValidationSample {
  readonly rowKey: string | null
  readonly value: string | number | boolean | null
}

/** Per-rule result (mirror of the engine's `EngineValidationRuleResult`). */
export interface ConformanceValidationRuleResult {
  readonly ruleId: string
  readonly failCount: number
  readonly failPercent: number
  readonly sampleFailures: readonly ConformanceValidationSample[]
}

/** Full validate result (mirror of the engine's `EngineValidationResult`). */
export interface ConformanceValidationResult {
  readonly valid: boolean
  readonly rowCount: number
  readonly rules: readonly ConformanceValidationRuleResult[]
}

/**
 * One rule's pinned expectations for one run: exact failCount/failPercent,
 * and either the FULL sample list (`samples`) or its first entry
 * (`firstSample`) for large violation sets. The scenario cross-checks every
 * declared `failPercent` literal against the documented integer half-up
 * formula over (failCount, rowCount), so the pins stay independent of the
 * engine's arithmetic.
 */
export interface ConformanceValidationRuleExpectation {
  readonly ruleId: string
  readonly failCount: number
  readonly failPercent: number
  readonly samples?: readonly ConformanceValidationSample[]
  readonly firstSample?: ConformanceValidationSample
}

/** One run's pinned expectations: verdict, effective row count, all rules. */
export interface ConformanceValidationExpectations {
  readonly valid: boolean
  readonly rowCount: number
  /** Exactly the plan's ruleIds, in plan order (full coverage — no gaps). */
  readonly rules: readonly ConformanceValidationRuleExpectation[]
}

/**
 * One overlay-interaction pin: the same plan re-validated over a scripted op
 * list. A battery must cover an edit that FIXES a violation (verdict flips
 * to clean), an edit that VIOLATES (flips to failing), an inserted violating
 * row APPEARING under its `ins:` row key, and a tombstoned row's violation
 * DISAPPEARING — the four pinned directions of the m5-2 done-when.
 */
export interface ConformanceValidationInteraction {
  readonly label: string
  readonly ops: readonly ConformanceEditOp[]
  readonly expectations: ConformanceValidationExpectations
}

/**
 * The engine clamp pin (m5-2 round-3 semantics: ANY safe K ≥ 1 executes —
 * over-max K is CLAMPED to the hard max, never rejected). A plan compiled
 * with exactly the hard max executes with samples stopping there, and a
 * plan compiled PAST the hard max also executes: its failCount is still the
 * rule's own FULL count (never corrupted by the clamp) and its reported
 * samples stop at min(expectFailCount, hardMax).
 */
export interface ConformanceValidationTruncation {
  readonly ruleId: string
  /** The engine's documented hard max; a plan with exactly this K executes. */
  readonly hardMax: number
  /** A K strictly past the hard max: the plan must EXECUTE, clamped. */
  readonly clampedSampleLimit: number
  /** The rule's fail count under the hard-max plan (≠ its sample bound). */
  readonly expectFailCount: number
  /** Reported samples under the clamped plan: min(expectFailCount, hardMax). */
  readonly expectSamples: number
  readonly expectFirstRowKey: string
  readonly expectFirstValue: string | number | boolean | null
}

/** One hostile plan probe (shape/semantics violation → one typed rejection). */
export interface ConformanceHostileValidationPlan {
  readonly label: string
  readonly plan: ConformanceValidationPlan
}

/**
 * The m5-2 validation dataset a subject stages and pins: a runtime-built
 * on-demand dirty file (never committed), its contract as canonical YAML,
 * and every expectation host-engine-derived (engine-duckdb: DuckDB CLI 1.5.5
 * over the identical composed view + plan SQL, cross-checked against the
 * duckdb-wasm build through the real client).
 */
export interface ConformanceValidationDataset {
  readonly contractYaml: string
  /** The binding name the plans are compiled against. */
  readonly planRelation: string
  /** The main plan's K. */
  readonly sampleLimit: number
  /** The overlay base metadata the interaction runs compose over. */
  readonly base: ConformanceOverlayBase
  /** The absent-overlay run (base view; row keys carry the empty anchor). */
  readonly baseExpectations: ConformanceValidationExpectations
  /** The empty-ops overlay run (same counts; session-anchored row keys). */
  readonly emptyOverlayExpectations: ConformanceValidationExpectations
  /** The overlay-interaction battery (see {@link ConformanceValidationInteraction}). */
  readonly interactions: readonly ConformanceValidationInteraction[]
  readonly truncation: ConformanceValidationTruncation
  /** Hostile plans that must each reject with one typed operation error. */
  readonly hostilePlans: readonly ConformanceHostileValidationPlan[]
  /**
   * Side-effect tables the hostile plans attempt to create (the review's
   * canary `CREATE TABLE` payloads among them); each is asserted absent
   * after the battery via a catalog listing query.
   */
  readonly injectedTables: readonly string[]
  /**
   * A binding name that already exists as a user-created (non-registered)
   * view: the m5-2 fix-round survival pin binds a plan to it, expects the
   * materialization failure, and asserts the user's view SURVIVES.
   */
  readonly preExistingViewName: string
  /** The vocabulary-probe column-name prefix (e.g. `v_`). */
  readonly vocabularyPrefix: string
  /** The documented bare-DECIMAL caveat: what DESCRIBE reports for it. */
  readonly decimalReportedType: string
}

/**
 * A hostile engine type-expression probe (m4-2 fix round). Type strings are
 * untrusted input the composer interpolates into SQL type positions; the
 * boundary must reject an injection-shaped spelling with a typed error and
 * never build a statement. `overlay` carries the hostile base column type or
 * `column-cast` target; `injectedTable`, when named, is the side-effect table
 * the payload attempts to create and the scenario asserts absent afterwards.
 */
export interface ConformanceHostileTypeProbe {
  /** Stable label (scenario facts/messages only — never dataset contents). */
  readonly label: string
  /** An overlay carrying the hostile type expression in one type position. */
  readonly overlay: ConformanceOverlay
  /** Table the payload attempts to create; asserted absent after the probe. */
  readonly injectedTable?: string
}

// ---- Row-diff execution types (m6-2) ----
//
// Structural mirrors of the m6-1 `RowDiffPlan` (`@assay/diff`) and the
// engine's `EngineRowDiffResult` (the same precedent as the validation
// mirrors): the suite never imports an engine, and REAL compiled plans flow
// through these shapes because the scenario compiles the subject's two
// schemas with the real m6-1 compiler.

/** The three row-diff aspects, in the compiler's documented order. */
export type ConformanceRowDiffAspect = 'added' | 'removed' | 'changed'

/** A compiled row-diff plan (mirror of m6-1's `RowDiffPlan`). */
export interface ConformanceRowDiffPlan {
  readonly planKind: string
  readonly planVersion: number
  readonly relationA: string
  readonly relationB: string
  readonly keys: readonly string[]
  readonly sampleLimit: number
  readonly sharedColumns: readonly string[]
  readonly addedSql: string
  readonly removedSql: string
  readonly changedSql: string
  readonly totalsSql: string
}

/**
 * One sampled row: a side-qualified row key. A-side keys are grid-resolvable
 * logical row ids (`base:<anchor>#<ordinal>`); B-side keys are the
 * report-only `b:<ordinal>` form (checkpoint C3). `changedColumns` is present
 * for the `changed` aspect only.
 */
export interface ConformanceRowDiffSample {
  readonly side: 'A' | 'B'
  readonly rowKey: string
  readonly changedColumns?: readonly string[]
}

/** Per-aspect result (mirror of the engine's `EngineRowDiffAspectResult`). */
export interface ConformanceRowDiffAspectResult {
  readonly aspect: ConformanceRowDiffAspect
  readonly count: number
  readonly samples: readonly ConformanceRowDiffSample[]
}

/** Full row-diff result (mirror of the engine's `EngineRowDiffResult`). */
export interface ConformanceRowDiffResult {
  readonly rowCountA: number
  readonly rowCountB: number
  readonly aspects: readonly ConformanceRowDiffAspectResult[]
}

/**
 * Opaque comparison handle returned by staging (m6-2): the comparison id plus
 * the staged view's DESCRIBE columns, so the scenario can compile the plan
 * against the engine's own schema for side B.
 */
export interface ConformanceComparisonHandle {
  readonly kind: 'comparison'
  readonly id: string
  readonly schema: readonly ConformanceColumn[]
}

/** One aspect's pinned expectation for one run. */
export interface ConformanceRowDiffAspectExpectation {
  readonly aspect: ConformanceRowDiffAspect
  readonly count: number
  /**
   * The exact expected samples (bounded by the plan K). Omit to assert only
   * the count (the overlay interactions pin counts; the base run pins the
   * full sample sets).
   */
  readonly samples?: readonly ConformanceRowDiffSample[]
}

/** One run's pinned expectations: both row counts and all three aspects. */
export interface ConformanceRowDiffExpectations {
  readonly rowCountA: number
  readonly rowCountB: number
  readonly aspects: readonly ConformanceRowDiffAspectExpectation[]
}

/**
 * One overlay-interaction pin: the same plan re-run with side A composed over
 * a scripted op list (side B stays the staged file). The battery must cover
 * an A-side edit that changes the row-diff verdict (fix or break).
 */
export interface ConformanceRowDiffInteraction {
  readonly label: string
  readonly ops: readonly ConformanceEditOp[]
  readonly expectations: ConformanceRowDiffExpectations
}

/**
 * The K-clamp pin (m6-2, the m5-2 pattern): a plan compiled PAST the hard max
 * EXECUTES with samples clamped to `min(K, hardMax)` while the aspect's exact
 * count is never corrupted by the outer limit.
 */
export interface ConformanceRowDiffTruncation {
  readonly aspect: ConformanceRowDiffAspect
  readonly hardMax: number
  readonly clampedSampleLimit: number
  /** The aspect's exact count (must exceed the hard max for a non-vacuous pin). */
  readonly expectCount: number
  /** Reported samples under the clamped plan: min(expectCount, hardMax). */
  readonly expectSamples: number
  readonly expectFirstRowKey: string
}

/** One hostile row-diff plan probe (shape/semantics violation → one typed rejection). */
export interface ConformanceHostileRowDiffPlan {
  readonly label: string
  readonly plan: ConformanceRowDiffPlan
}

/**
 * The m6-2 row-diff dataset a subject stages and pins: two runtime-built
 * on-demand dirty files (never committed), the explicit key columns, and
 * every expectation host-engine-derived (engine-duckdb: DuckDB CLI 1.5.5
 * over the identical plan SQL, cross-checked through the real client).
 */
export interface ConformanceRowDiffDataset {
  /** Side-A binding name the plans are compiled against. */
  readonly relationA: string
  /** Side-B binding name the plans are compiled against. */
  readonly relationB: string
  /** The explicit key columns (C2: a surface confirms them; never inferred here). */
  readonly keys: readonly string[]
  /** The overlay base metadata the interaction runs compose over (side A). */
  readonly base: ConformanceOverlayBase
  /** The main plan's K. */
  readonly sampleLimit: number
  /** The absent-overlay run (base view; row keys carry the empty anchor). */
  readonly baseExpectations: ConformanceRowDiffExpectations
  /** The overlay-interaction battery (effective-vs-file). */
  readonly interactions: readonly ConformanceRowDiffInteraction[]
  readonly truncation: ConformanceRowDiffTruncation
  /** Hostile plans that must each reject with one typed operation error. */
  readonly hostilePlans: readonly ConformanceHostileRowDiffPlan[]
  /**
   * Side-effect tables the hostile plans attempt to create; each is asserted
   * absent after the battery via a catalog listing query.
   */
  readonly injectedTables: readonly string[]
  /**
   * A binding name that already exists as a user-created (non-registered)
   * view: the survival pin binds a plan to it, expects the materialization
   * failure, and asserts the user's view SURVIVES.
   */
  readonly preExistingViewName: string
  /**
   * The comparison file name whose extension the engine cannot read
   * (staging failure path: unsupported file).
   */
  readonly unsupportedComparisonName: string
}

// ---- Results ----

/** Stable scenario identifiers (each runs independently, fresh client). */
export const engineConformanceScenarioNames = [
  'lazy-boot',
  'file-lifecycle',
  'error-classes',
  'window-clamping',
  'arrow-shape',
  'corrupt-file-rollback',
  'mid-stream-error-reuse',
  'window-filter-sort',
  'predicate-error-reuse',
  'profile-semantics',
  'nested-schema-fidelity',
  'nested-window-fidelity',
  'nested-window-clamp',
  'overlay-window-fidelity',
  'overlay-insert-edits',
  'overlay-cast-check',
  'export-round-trip',
  'source-immutability',
  'overlay-hostile-types-rejected',
  'validation-plan-execution',
  'row-diff-plan-execution',
] as const

export type ConformanceScenarioName = (typeof engineConformanceScenarioNames)[number]

/** Outcome of one scenario: pass/fail, a privacy-safe detail, and evidence. */
export interface ConformanceScenarioResult {
  readonly name: ConformanceScenarioName
  readonly passed: boolean
  /** Failure message (or `passed`); never contains dataset contents. */
  readonly detail: string
  /** Scenario-specific evidence (counts/flags) for reports and specs. */
  readonly facts: Readonly<Record<string, string | number | boolean>>
}

export interface EngineConformanceReport {
  readonly subject: string
  readonly results: readonly ConformanceScenarioResult[]
  readonly allPassed: boolean
}

// ---- Scenario helpers ----

function fail(message: string): never {
  throw new Error(message)
}

/**
 * Await a promise expected to reject. Returns the rejection reason, or `null`
 * when the promise resolved (callers turn that into a conformance violation).
 */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  return null
}

function expectCondition(condition: boolean, message: string): void {
  if (!condition) fail(message)
}

function expectEqual(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) {
    fail(`${what}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

/** Compares declared columns structurally (name + type, in order). */
function expectColumnsMatch(
  actual: readonly ConformanceColumn[],
  expected: readonly ConformanceColumn[],
): void {
  expectEqual(actual.length, expected.length, 'schema column count')
  for (let index = 0; index < expected.length; index++) {
    const actualColumn = actual[index]
    const expectedColumn = expected[index]
    if (actualColumn === undefined || expectedColumn === undefined) {
      fail(`schema column at index ${String(index)} missing`)
    }
    expectEqual(actualColumn!.name, expectedColumn!.name, `column ${String(index)} name`)
    expectEqual(actualColumn!.type, expectedColumn!.type, `column ${String(index)} type`)
  }
}

/**
 * How many rows the subject declared values for (all value-declaring columns
 * must agree — the window the Arrow-shape scenario reads).
 */
function declaredValueRowCount(columns: readonly ConformanceColumn[]): number {
  const lengths = new Set(
    columns.filter((column) => column.values !== undefined).map((column) => column.values!.length),
  )
  if (lengths.size > 1) {
    fail('subject misconfiguration: value-declaring columns must declare the same row count')
  }
  if (lengths.size === 0) {
    fail('subject misconfiguration: declare values for at least one column')
  }
  return lengths.values().next().value ?? 0
}

/** An Arrow column vector as returned by `Table.getChildAt`. */
type ConformanceVector = NonNullable<ReturnType<Table['getChildAt']>>

/**
 * Renders a cell through the Arrow vector API: null-preserving `String()`.
 * (Deliberately vector-based, not `table.get(row)`: row access builds a
 * struct proxy, while engines serve columns.)
 */
function renderCell(vector: ConformanceVector, row: number): string | null {
  const value: unknown = vector.get(row)
  return value === null || value === undefined ? null : String(value)
}

/**
 * Asserts the named column of `batch` renders exactly `expected` values in
 * order (NULL-safe, position-by-position) — the filtered/sorted window
 * assertion used by the m2-2 scenarios.
 */
function expectColumnValues(
  batch: Table,
  columnName: string,
  expected: readonly (string | null)[],
  label: string,
): void {
  const index = batch.schema.fields.findIndex((field) => field.name === columnName)
  if (index < 0) {
    fail(`${label}: the batch is missing column ${columnName}`)
  }
  const vector = batch.getChildAt(index)
  if (vector === null) {
    fail(`${label}: column ${columnName} has no vector`)
  }
  if (vector!.length !== expected.length) {
    fail(
      `${label}: column ${columnName} has ${String(vector!.length)} rows, expected ${String(expected.length)}`,
    )
  }
  for (let row = 0; row < expected.length; row++) {
    const actual = renderCell(vector!, row)
    if (actual !== expected[row]) {
      fail(
        `${label}: ${columnName}[${String(row)}]: expected ${String(expected[row])}, got ${String(actual)}`,
      )
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The compiler's identifier quoting for a binding name (double-quote doubling). */
function quotedRelationTokenFor(relation: string): string {
  return `"${relation.replaceAll('"', '""')}"`
}

/** Null-aware comparison of one numeric stat under the absolute tolerance. */
function expectStatEqual(
  actual: number | null | undefined,
  expected: number | null,
  tolerance: number,
  what: string,
): void {
  if (expected === null) {
    expectEqual(actual ?? null, null, what)
    return
  }
  if (typeof actual !== 'number' || !Number.isFinite(actual)) {
    fail(`${what}: expected ${String(expected)}, got ${String(actual)}`)
  }
  if (Math.abs(actual - expected) > tolerance) {
    fail(`${what}: expected ${String(expected)} (±${String(tolerance)}), got ${String(actual)}`)
  }
}

/**
 * Asserts a numeric payload block against its expectation (m2-5): presence,
 * null-aware stats, and all four declared quantile positions.
 */
function expectStatBlock(
  actual: ConformanceNumericStats | undefined,
  expected: ConformanceNumericStats,
  tolerance: number,
  label: string,
): void {
  expectCondition(actual !== undefined, `${label}: kind 'numeric' must carry a numeric payload`)
  expectStatEqual(actual!.min, expected.min, tolerance, `${label} min`)
  expectStatEqual(actual!.max, expected.max, tolerance, `${label} max`)
  expectStatEqual(actual!.mean, expected.mean, tolerance, `${label} mean`)
  expectStatEqual(actual!.stddev, expected.stddev, tolerance, `${label} stddev`)
  expectCondition(
    actual!.quantiles !== undefined,
    `${label}: the numeric payload must carry quantiles`,
  )
  expectStatEqual(actual!.quantiles.p50, expected.quantiles.p50, tolerance, `${label} p50`)
  expectStatEqual(actual!.quantiles.p90, expected.quantiles.p90, tolerance, `${label} p90`)
  expectStatEqual(actual!.quantiles.p95, expected.quantiles.p95, tolerance, `${label} p95`)
  expectStatEqual(actual!.quantiles.p99, expected.quantiles.p99, tolerance, `${label} p99`)
}

/** Windows that violate the window contract (caller bugs, never repaired). */
const INVALID_WINDOWS: readonly ConformanceWindow[] = [
  { startRow: -1, endRow: 5 },
  { startRow: 5, endRow: 2 },
  { startRow: 0, endRow: 1.5 },
]

/**
 * Normalizes one Arrow cell into its JSON-shaped value (`ConformanceNestedValue`,
 * m3-1). This is the traversal the window-fidelity scenario trusts: struct
 * cells arrive as records (field name → child value), list cells as an Arrow
 * `Vector` slice (read position-by-position), 64-bit integers and timestamps
 * as JS `bigint` (converted losslessly; anything beyond a safe integer is a
 * conformance failure, not a silent precision loss), and NULL at any depth as
 * `null`. An unexpected cell shape fails loudly — papering over it would let
 * a fidelity break pass as a match.
 *
 * Never mutates the underlying buffers; reads only through the vector API.
 */
export function normalizeArrowCell(value: unknown): ConformanceNestedValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') {
    const number = Number(value)
    if (!Number.isSafeInteger(number)) {
      fail(
        `cell bigint ${String(value)} exceeds the safe-integer range; it cannot be pinned exactly`,
      )
    }
    return number
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return value
  }
  if (value instanceof Vector) {
    const elements: ConformanceNestedValue[] = []
    for (let index = 0; index < value.length; index++) {
      elements.push(normalizeArrowCell(value.get(index)))
    }
    return elements
  }
  if (typeof value === 'object') {
    if (ArrayBuffer.isView(value)) fail('unexpected binary (typed-array) cell in a nested window')
    const record: Record<string, ConformanceNestedValue> = {}
    for (const [field, fieldValue] of Object.entries(value)) {
      record[field] = normalizeArrowCell(fieldValue)
    }
    return record
  }
  fail(`unexpected Arrow cell shape: ${typeof value}`)
}

/** Structural deep-equality over JSON-shaped cell values (array/object-aware). */
function nestedValuesEqual(
  actual: ConformanceNestedValue,
  expected: ConformanceNestedValue,
): boolean {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return false
    return (
      actual.length === expected.length &&
      actual.every((element, index) => nestedValuesEqual(element, expected[index]!))
    )
  }
  const actualIsObject = actual !== null && typeof actual === 'object'
  const expectedIsObject = expected !== null && typeof expected === 'object'
  if (actualIsObject || expectedIsObject) {
    if (!actualIsObject || !expectedIsObject) return false
    const actualKeys = Object.keys(actual).sort()
    const expectedKeys = Object.keys(expected).sort()
    if (actualKeys.length !== expectedKeys.length) return false
    if (actualKeys.some((key, index) => key !== expectedKeys[index])) return false
    const record = actual as Record<string, ConformanceNestedValue>
    const expectedRecord = expected as Record<string, ConformanceNestedValue>
    return actualKeys.every((key) => nestedValuesEqual(record[key]!, expectedRecord[key]!))
  }
  return actual === expected
}

/** Asserts one normalized cell deep-equals its expectation (path in the message). */
function expectNestedCellEqual(
  actual: ConformanceNestedValue,
  expected: ConformanceNestedValue,
  label: string,
): void {
  if (!nestedValuesEqual(actual, expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

/**
 * Asserts the named column of `batch` deep-equals `expected` cell-by-cell
 * (rows [0, expected.length)) through the Arrow vector API + normalizer.
 */
function expectNestedColumnValues(
  batch: Table,
  columnName: string,
  expected: readonly ConformanceNestedValue[],
  label: string,
): void {
  const index = batch.schema.fields.findIndex((field) => field.name === columnName)
  if (index < 0) {
    fail(`${label}: the batch is missing column ${columnName}`)
  }
  const vector = batch.getChildAt(index)
  if (vector === null) {
    fail(`${label}: column ${columnName} has no vector`)
  }
  if (vector!.length !== expected.length) {
    fail(
      `${label}: column ${columnName} has ${String(vector!.length)} rows, expected ${String(expected.length)}`,
    )
  }
  for (let row = 0; row < expected.length; row++) {
    const actual = normalizeArrowCell(vector!.get(row))
    expectNestedCellEqual(actual, expected[row]!, `${label} ${columnName}[${String(row)}]`)
  }
}

// ---- Scenarios ----

type ConformanceScenario = (
  subject: EngineConformanceSubject,
) => Promise<Record<string, string | number | boolean>>

const scenarios: Record<ConformanceScenarioName, ConformanceScenario> = {
  'lazy-boot': async (subject) => {
    const client = subject.createClient()
    expectCondition(
      subject.isIdle(client),
      `a freshly constructed client must be idle (status: ${client.status}) — constructing it must not boot the engine`,
    )
    await client.ensureReady()
    expectCondition(subject.isReady(client), 'the first use must boot the engine to ready')
    // A second call shares the already-completed boot and stays ready.
    await client.ensureReady()
    expectCondition(subject.isReady(client), 'a repeated ensureReady must keep the engine ready')
    return { idleBeforeFirstUse: true, readyAfterBoot: true, bootSharedOnSecondCall: true }
  },

  'file-lifecycle': async (subject) => {
    const client = subject.createClient()
    await client.ensureReady()
    const handle = await client.open(await subject.stageGoodFile())
    expectEqual(handle.kind, 'table', 'open must return a table handle')

    const schema = await client.schema(handle)
    expectColumnsMatch(schema, subject.dataset.columns)

    const rowCount = await client.rowCount(handle)
    expectEqual(rowCount, subject.dataset.rowCount, 'rowCount')

    const windowRows = declaredValueRowCount(subject.dataset.columns)
    expectCondition(
      subject.dataset.rowCount >= windowRows,
      'subject misconfiguration: dataset rowCount is smaller than the declared value rows',
    )
    const range = await client.fetchRange(handle, { startRow: 0, endRow: windowRows })
    expectEqual(range.batch.numRows, windowRows, 'first fetchRange window row count')

    // Dispose is terminal: subsequent operations reject with the disposed
    // error category, and a second dispose resolves (idempotent).
    await client.dispose()
    const rangeAfterDispose = await rejectionOf(
      client.fetchRange(handle, { startRow: 0, endRow: 1 }),
    )
    expectCondition(rangeAfterDispose !== null, 'fetchRange after dispose must reject')
    expectCondition(
      subject.errors.disposed(rangeAfterDispose),
      `fetchRange after dispose must reject with the disposed error category (got: ${errorMessage(rangeAfterDispose)})`,
    )
    const queryAfterDispose = await rejectionOf(client.query(subject.smokeSql()))
    expectCondition(
      queryAfterDispose !== null && subject.errors.disposed(queryAfterDispose),
      'query after dispose must reject with the disposed error category',
    )
    await client.dispose() // idempotent
    return {
      schemaColumns: schema.length,
      rowCount,
      windowRows,
      disposedFetchRangeRejected: true,
      disposedQueryRejected: true,
      secondDisposeResolved: true,
    }
  },

  'error-classes': async (subject) => {
    const client = subject.createClient()
    await client.ensureReady()

    // Invalid SQL → query-error category; engine stays ready afterwards.
    const queryError = await rejectionOf(client.query(subject.failingSql()))
    expectCondition(queryError !== null, 'invalid SQL must reject')
    expectCondition(
      subject.errors.query(queryError),
      `invalid SQL must reject with the query error category (got: ${errorMessage(queryError)})`,
    )
    expectCondition(subject.isReady(client), 'a failed query must leave the engine ready')

    // Unknown table handle → operation-error category; engine stays ready.
    const unknownHandle: ConformanceTableHandle = {
      kind: 'table',
      id: '__assay_conformance_no_such_table__',
    }
    const unknownHandleError = await rejectionOf(client.schema(unknownHandle))
    expectCondition(
      unknownHandleError !== null && subject.errors.operation(unknownHandleError),
      `schema() of an unknown handle must reject with the operation error category (got: ${errorMessage(unknownHandleError)})`,
    )

    // Unsupported file format (extension) → operation-error category; the
    // bytes are never read, and nothing is left registered.
    const bytes = await subject.goodParquetBytes()
    const unsupportedSource = await subject.stageBytes(bytes, 'assay-conformance-not-a-dataset.bin')
    const formatError = await rejectionOf(client.open(unsupportedSource))
    expectCondition(
      formatError !== null && subject.errors.operation(formatError),
      `open() of an unsupported format must reject with the operation error category (got: ${errorMessage(formatError)})`,
    )
    const registered = await subject.registeredTableCount(client)
    expectCondition(
      registered === null || registered === 0,
      `an unsupported-format open must not register anything (registered: ${String(registered)})`,
    )
    return {
      queryErrorTyped: true,
      unknownHandleRejected: true,
      unsupportedFormatRejected: true,
      engineReadyAfterErrors: true,
    }
  },

  'window-clamping': async (subject) => {
    expectCondition(
      subject.wideRowCount > subject.maxWindowRows,
      'subject misconfiguration: wideRowCount must exceed maxWindowRows so the cap itself is exercised',
    )
    const client = subject.createClient()
    await client.ensureReady()
    const handle = await client.open(await subject.stageWideFile())

    // An oversized window is clamped, not rejected: exactly maxWindowRows.
    const oversized = await client.fetchRange(handle, {
      startRow: 0,
      endRow: subject.wideRowCount + subject.maxWindowRows * 10,
    })
    expectEqual(
      oversized.batch.numRows,
      subject.maxWindowRows,
      'an oversized fetchRange window must be clamped to the window cap',
    )

    // A tail window clamps against the real end of the dataset, not the cap.
    const tailStart = subject.wideRowCount - 3
    const tail = await client.fetchRange(handle, {
      startRow: tailStart,
      endRow: tailStart + subject.maxWindowRows * 10,
    })
    expectEqual(
      tail.batch.numRows,
      3,
      'a clamped tail window must return exactly the remaining rows',
    )

    // Invalid windows are rejected with the operation category — never
    // silently repaired, never resolved.
    let invalidRejected = 0
    for (const window of INVALID_WINDOWS) {
      const error = await rejectionOf(client.fetchRange(handle, window))
      expectCondition(
        error !== null && subject.errors.operation(error),
        `invalid window ${JSON.stringify(window)} must reject with the operation error category (got: ${errorMessage(error)})`,
      )
      invalidRejected += 1
    }
    return { clampedRows: oversized.batch.numRows, tailRows: tail.batch.numRows, invalidRejected }
  },

  'arrow-shape': async (subject) => {
    const client = subject.createClient()
    await client.ensureReady()
    const handle = await client.open(await subject.stageGoodFile())
    const declared = subject.dataset.columns
    const declaredRows = declaredValueRowCount(declared)

    // fetchRange: the batch is an Arrow table — schema fields in declared
    // order, values readable through the vector API, NULL preserved as null.
    // (Type strings are a schema() contract — asserted against the engine's
    // own strings in `file-lifecycle`; Arrow type names would add an
    // engine-specific second spelling here, so only names are re-checked.)
    const range = await client.fetchRange(handle, { startRow: 0, endRow: declaredRows })
    const batch = range.batch
    expectEqual(batch.numCols, declared.length, 'Arrow column count')
    expectEqual(batch.numRows, declaredRows, 'Arrow row count')
    expectEqual(range.hasMore, false, 'a capped window must arrive as a single batch (hasMore)')
    for (let index = 0; index < declared.length; index++) {
      const field = batch.schema.fields[index]
      const expectedColumn = declared[index]!
      expectEqual(field?.name, expectedColumn.name, `Arrow field ${String(index)} name`)
      const values = expectedColumn.values
      if (values === undefined) continue
      const vector = batch.getChildAt(index)
      if (vector === null) {
        fail(`Arrow batch is missing declared column ${expectedColumn.name}`)
      }
      for (let row = 0; row < declaredRows; row++) {
        const actual = renderCell(vector, row)
        const expected = values[row]
        if (actual !== expected) {
          fail(
            `Arrow cell [${String(row)}] of column ${expectedColumn.name}: expected ${String(expected)}, got ${String(actual)}`,
          )
        }
      }
    }

    // query: same Arrow transport for ad-hoc SQL.
    const smoke = await client.query(subject.smokeSql())
    expectEqual(smoke.batch.numRows, 1, 'smoke query row count')
    const smokeVector = smoke.batch.getChildAt(0)
    if (smokeVector === null) fail('smoke query batch has no first column')
    expectEqual(
      renderCell(smokeVector, 0),
      subject.smokeSqlValue,
      'smoke query value read through the Arrow API',
    )
    return { columns: declared.length, rows: declaredRows, smokeValue: subject.smokeSqlValue }
  },

  'corrupt-file-rollback': async (subject) => {
    const client = subject.createClient()
    await client.ensureReady()

    // Build corrupt Parquet bytes at runtime: truncation removes the footer
    // (metadata + closing magic), which Parquet readers need before they can
    // bind a scan — so registration (lazy) succeeds but view creation must
    // fail. Corrupt fixtures are never committed to the repository.
    const good = await subject.goodParquetBytes()
    expectCondition(good.length >= 8, 'subject misconfiguration: good Parquet bytes are too small')
    const corrupt = good.slice(0, Math.floor(good.length / 2))

    const corruptSource = await subject.stageBytes(corrupt, 'assay-conformance-corrupt.parquet')
    const openError = await rejectionOf(client.open(corruptSource))
    expectCondition(openError !== null, 'opening a corrupt Parquet must reject')
    expectCondition(
      subject.errors.operation(openError),
      `opening a corrupt Parquet must reject with the operation error category (got: ${errorMessage(openError)})`,
    )

    // Rollback: the failed open must leave nothing registered (no phantom
    // table/view), and repeating the failure must not poison state either.
    const afterFailure = await subject.registeredTableCount(client)
    expectCondition(
      afterFailure === null || afterFailure === 0,
      `a failed open must roll the registration back (registered after failure: ${String(afterFailure)})`,
    )
    const repeatSource = await subject.stageBytes(corrupt, 'assay-conformance-corrupt-2.parquet')
    const repeatError = await rejectionOf(client.open(repeatSource))
    expectCondition(
      repeatError !== null && subject.errors.operation(repeatError),
      're-opening corrupt bytes must fail cleanly again',
    )

    // The engine is reusable for a subsequent good open, and the registry
    // holds exactly that one table.
    const handle = await client.open(await subject.stageGoodFile())
    const rowCount = await client.rowCount(handle)
    expectEqual(rowCount, subject.dataset.rowCount, 'rowCount after recovery')
    const afterGoodOpen = await subject.registeredTableCount(client)
    expectCondition(
      afterGoodOpen === null || afterGoodOpen === 1,
      `after the recovered open the registry must hold exactly one table (registered: ${String(afterGoodOpen)})`,
    )
    return {
      openRejected: true,
      registeredAfterFailedOpen: afterFailure ?? 'unobserved',
      repeatOpenRejected: true,
      goodOpenAfterFailure: true,
      registeredAfterGoodOpen: afterGoodOpen ?? 'unobserved',
    }
  },

  'mid-stream-error-reuse': async (subject) => {
    // Mechanism contract: `midStreamFailureSql()` produces a successful first
    // record batch and then fails on a later batch. The observable contract
    // under test: the query rejects with the *query* error category (not a
    // crash/protocol error), and the engine releases the connection so the
    // next query answers — cleanup happened, nothing is wedged.
    const client = subject.createClient()
    await client.ensureReady()
    const midStreamError = await rejectionOf(client.query(subject.midStreamFailureSql()))
    expectCondition(midStreamError !== null, 'the mid-stream failure query must reject')
    expectCondition(
      subject.errors.query(midStreamError),
      `a mid-stream failure must reject with the query error category (got: ${errorMessage(midStreamError)})`,
    )

    // Connection reusable: the smoke query answers with its declared value.
    let followUp: ConformanceBatchResult
    try {
      followUp = await client.query(subject.smokeSql())
    } catch (error) {
      fail(
        `the follow-up query after a mid-stream failure must answer (got: ${errorMessage(error)})`,
      )
    }
    const followUpVector = followUp.batch.getChildAt(0)
    if (followUpVector === null) fail('the follow-up batch has no first column')
    expectEqual(
      renderCell(followUpVector, 0),
      subject.smokeSqlValue,
      'the follow-up query after a mid-stream failure',
    )
    expectCondition(
      subject.isReady(client),
      'the engine must stay ready after a mid-stream failure',
    )
    return { midStreamRejected: true, followUpValue: subject.smokeSqlValue, engineReadyAfter: true }
  },

  'window-filter-sort': async (subject) => {
    // Subject preconditions (fail loudly on misconfiguration, never vacuously).
    const semantics = subject.windowSemantics
    expectCondition(
      semantics.length > 0,
      'subject misconfiguration: declare at least one window-semantics entry',
    )
    const declaredColumns = new Map(subject.dataset.columns.map((column) => [column.name, column]))
    for (const entry of semantics) {
      expectCondition(
        declaredColumns.has(entry.expectColumn),
        `subject misconfiguration: semantics entry "${entry.label}" names unknown column ${entry.expectColumn}`,
      )
      expectCondition(
        entry.expectRowCount >= 1 && entry.expectRowCount <= subject.maxWindowRows,
        `subject misconfiguration: semantics entry "${entry.label}" expects ${String(entry.expectRowCount)} rows — must be within 1…maxWindowRows so the whole matching set fits one window`,
      )
      expectCondition(
        entry.expectValues.length === entry.expectRowCount,
        `subject misconfiguration: semantics entry "${entry.label}" declares ${String(entry.expectValues.length)} values for ${String(entry.expectRowCount)} rows`,
      )
    }

    const client = subject.createClient()
    await client.ensureReady()
    const handle = await client.open(await subject.stageGoodFile())

    // Backward-compatibility baseline: with no filters/sort the window is the
    // natural-order dataset (the grid's null-clear protocol: absent = none).
    const baselineColumn = declaredColumns.get(semantics[0]!.expectColumn)!
    expectCondition(
      baselineColumn.values !== undefined,
      'subject misconfiguration: the first semantics entry column must declare natural-order values for the baseline check',
    )
    const naturalEnd = Math.min(subject.dataset.rowCount, subject.maxWindowRows)
    const natural = await client.fetchRange(handle, { startRow: 0, endRow: naturalEnd })
    expectColumnValues(
      natural.batch,
      baselineColumn.name,
      baselineColumn.values!.slice(0, naturalEnd),
      'natural-order baseline',
    )

    let filteredEntries = 0
    let invalidWindowWithFiltersRejected = false
    for (const entry of semantics) {
      const filters = entry.filters ?? []
      const sort = entry.sort ?? []
      const label = `[${entry.label}]`

      // The whole matching set, in the declared order, with the declared values.
      const whole = await client.fetchRange(handle, {
        startRow: 0,
        endRow: subject.maxWindowRows,
        ...(filters.length > 0 ? { filters } : {}),
        ...(sort.length > 0 ? { sort } : {}),
      })
      expectEqual(whole.batch.numRows, entry.expectRowCount, `${label} matching row count`)
      expectColumnValues(whole.batch, entry.expectColumn, entry.expectValues, label)

      // Row counts: filtered counts answer the filter; sort alone must not
      // change the total.
      if (filters.length > 0) {
        expectEqual(
          await client.rowCount(handle, { filters }),
          entry.expectRowCount,
          `${label} filtered rowCount`,
        )
        // Clamping/windowing still applies under filters: a window past the
        // matching set is empty; dropping the first match shifts values by one.
        // Both checks carry the entry's sort as well, so the expected values
        // stay the declared (filtered + sorted) order.
        const tail = await client.fetchRange(handle, {
          startRow: entry.expectRowCount,
          endRow: entry.expectRowCount + 5,
          filters,
          ...(sort.length > 0 ? { sort } : {}),
        })
        expectEqual(tail.batch.numRows, 0, `${label} window past the matching set`)
        const shifted = await client.fetchRange(handle, {
          startRow: 1,
          endRow: entry.expectRowCount + 1,
          filters,
          ...(sort.length > 0 ? { sort } : {}),
        })
        expectEqual(
          shifted.batch.numRows,
          entry.expectRowCount - 1,
          `${label} shifted window row count`,
        )
        expectColumnValues(
          shifted.batch,
          entry.expectColumn,
          entry.expectValues.slice(1),
          `${label} shifted`,
        )
        // Window validation is not bypassed by filters.
        const invalid = await rejectionOf(
          client.fetchRange(handle, { startRow: 5, endRow: 2, filters }),
        )
        expectCondition(
          invalid !== null && subject.errors.operation(invalid),
          `${label} an invalid window must still reject with filters present (got: ${errorMessage(invalid)})`,
        )
        invalidWindowWithFiltersRejected = true
        filteredEntries += 1
      } else {
        expectEqual(
          await client.rowCount(handle),
          subject.dataset.rowCount,
          `${label} unfiltered rowCount must ignore sort`,
        )
      }
    }
    return {
      entries: semantics.length,
      filteredEntries,
      naturalOrderPreserved: true,
      invalidWindowWithFiltersRejected,
    }
  },

  'predicate-error-reuse': async (subject) => {
    expectCondition(
      subject.rejectingFilters.length > 0,
      'subject misconfiguration: declare at least one rejecting filter probe',
    )
    const client = subject.createClient()
    await client.ensureReady()
    const handle = await client.open(await subject.stageGoodFile())

    // A benign filtered anchor (from the declared semantics) proves — before
    // and after the probes — that the view and its data survived untouched.
    const anchor = subject.windowSemantics.find(
      (entry) => entry.filters !== undefined && entry.filters.length > 0,
    )
    expectCondition(
      anchor !== undefined,
      'subject misconfiguration: declare at least one filtered window-semantics entry as the benign anchor',
    )
    const anchorFilters = anchor!.filters!
    const anchorEndRow = Math.min(anchor!.expectRowCount, subject.maxWindowRows)
    expectEqual(
      await client.rowCount(handle, { filters: anchorFilters }),
      anchor!.expectRowCount,
      'benign anchor rowCount (pre-probe)',
    )

    // Predicate/identifier failures must surface as a *classified* engine
    // error (operation or query category — the engine's own error surface,
    // never a crash, protocol, or disposed error) and must leave the engine
    // ready and reusable. User-authored SQL text is untrusted CONTENT: it is
    // rejected or run on the user's own view — it can never take the engine
    // down (ADR 0007 spirit).
    const classified = (error: unknown): boolean =>
      subject.errors.operation(error) || subject.errors.query(error)

    let rejectedProbes = 0
    for (const probe of subject.rejectingFilters) {
      const error = await rejectionOf(
        client.fetchRange(handle, {
          startRow: 0,
          endRow: subject.maxWindowRows,
          filters: [probe],
        }),
      )
      expectCondition(
        error !== null,
        `the rejecting probe (column ${probe.column}) must reject, not resolve`,
      )
      expectCondition(
        classified(error),
        `the rejecting probe (column ${probe.column}) must reject with a classified engine error (got: ${errorMessage(error)})`,
      )
      expectCondition(
        subject.isReady(client),
        `the engine must stay ready after a rejected probe (column ${probe.column})`,
      )
      rejectedProbes += 1
    }
    // The same classification applies on the metadata op.
    const countError = await rejectionOf(
      client.rowCount(handle, { filters: [subject.rejectingFilters[0]!] }),
    )
    expectCondition(
      countError !== null && classified(countError),
      `a rejecting filter on rowCount must reject with a classified engine error (got: ${errorMessage(countError)})`,
    )

    // Breakout probes (injection containment): whatever the engine does with
    // the statement — reject it, or run it as harmless SQL on the user's own
    // view — the engine and the registered data must survive intact.
    const registryBefore = await subject.registeredTableCount(client)
    let containedBreakouts = 0
    for (const probe of subject.breakoutFilters) {
      const outcome = await rejectionOf(
        client.fetchRange(handle, {
          startRow: 0,
          endRow: subject.maxWindowRows,
          filters: [probe],
        }),
      )
      expectCondition(
        subject.isReady(client),
        `the engine must stay ready after the breakout probe (predicate ${JSON.stringify(probe.predicate)})`,
      )
      expectEqual(
        await client.rowCount(handle, { filters: anchorFilters }),
        anchor!.expectRowCount,
        `view data must survive the breakout probe (predicate ${JSON.stringify(probe.predicate)})`,
      )
      if (outcome !== null) {
        expectCondition(
          classified(outcome),
          `a rejected breakout probe must be a classified engine error (got: ${errorMessage(outcome)})`,
        )
      }
      containedBreakouts += 1
    }
    const registryAfter = await subject.registeredTableCount(client)
    expectCondition(
      registryBefore === null || registryAfter === null || registryBefore === registryAfter,
      `the registry must be unchanged by the probes (before: ${String(registryBefore)}, after: ${String(registryAfter)})`,
    )

    // The benign anchor still answers with exactly its declared values.
    const anchorWindow = await client.fetchRange(handle, {
      startRow: 0,
      endRow: anchorEndRow,
      filters: anchorFilters,
    })
    expectEqual(
      anchorWindow.batch.numRows,
      anchor!.expectRowCount,
      'benign anchor window (post-probe)',
    )
    return {
      rejectedProbes,
      containedBreakouts,
      viewIntact: true,
      engineReusable: true,
    }
  },

  'profile-semantics': async (subject) => {
    // Subject preconditions (fail loudly on misconfiguration, never vacuously):
    // the profile dataset must cover the contract's interesting shapes.
    const dataset = subject.profileDataset
    expectCondition(
      dataset.rowCount >= 1,
      'subject misconfiguration: profileDataset.rowCount must be at least 1',
    )
    expectCondition(
      dataset.columns.length > 0,
      'subject misconfiguration: declare at least one profile column expectation',
    )
    expectCondition(
      Number.isFinite(dataset.numericTolerance ?? 0) && (dataset.numericTolerance ?? 0) >= 0,
      'subject misconfiguration: numericTolerance must be a non-negative finite number',
    )
    const tolerance = dataset.numericTolerance ?? 0
    let coversNulls = false
    let coversNullsOnly = false
    let coversTopKTie = false
    for (const expectation of dataset.columns) {
      expectCondition(
        Number.isSafeInteger(expectation.nullCount) &&
          expectation.nullCount >= 0 &&
          expectation.nullCount <= dataset.rowCount,
        `subject misconfiguration: column "${expectation.name}" has an out-of-range nullCount`,
      )
      expectCondition(
        Number.isSafeInteger(expectation.distinctCount) &&
          expectation.distinctCount >= 0 &&
          expectation.distinctCount <= dataset.rowCount,
        `subject misconfiguration: column "${expectation.name}" has an out-of-range distinctCount`,
      )
      if (expectation.nullCount > 0) coversNulls = true
      if (expectation.nullCount === dataset.rowCount) coversNullsOnly = true
      if (expectation.kind === 'numeric') {
        expectCondition(
          expectation.numeric !== undefined && expectation.categorical === undefined,
          `subject misconfiguration: numeric column "${expectation.name}" must declare numeric stats and no categorical payload`,
        )
      } else if (expectation.kind === 'categorical') {
        expectCondition(
          expectation.categorical !== undefined && expectation.numeric === undefined,
          `subject misconfiguration: categorical column "${expectation.name}" must declare a top-k and no numeric payload`,
        )
        const topK = expectation.categorical!.topK
        if (topK.length >= 2 && topK[0]!.count === topK[1]!.count) coversTopKTie = true
      } else {
        expectCondition(
          expectation.numeric === undefined && expectation.categorical === undefined,
          `subject misconfiguration: other-kind column "${expectation.name}" must declare no payload`,
        )
      }
    }
    expectCondition(
      coversNulls,
      'subject misconfiguration: the profile dataset must include a column with NULLs',
    )
    expectCondition(
      coversNullsOnly,
      'subject misconfiguration: the profile dataset must include a nulls-only column',
    )
    expectCondition(
      coversTopKTie,
      'subject misconfiguration: the profile dataset must include a top-k count tie (pins the declared tie order)',
    )

    const client = subject.createClient()
    await client.ensureReady()

    // Unknown handle → classified engine error, engine stays ready/reusable.
    const unknownHandle: ConformanceTableHandle = {
      kind: 'table',
      id: '__assay_conformance_no_such_table__',
    }
    const unknownError = await rejectionOf(client.profile(unknownHandle))
    expectCondition(unknownError !== null, 'profile() of an unknown handle must reject')
    expectCondition(
      subject.errors.operation(unknownError),
      `profile() of an unknown handle must reject with the operation error category (got: ${errorMessage(unknownError)})`,
    )
    expectCondition(
      subject.isReady(client),
      'the engine must stay ready after a profile of an unknown handle',
    )

    // The real profile: stage the purpose-built dataset and profile it.
    const handle = await client.open(await subject.stageProfileFile())
    const profile = await client.profile(handle)

    expectEqual(profile.rowCount, dataset.rowCount, 'profile rowCount')
    expectEqual(
      profile.columns.map((column) => column.name).join(','),
      dataset.columns.map((column) => column.name).join(','),
      'profile column names (order included)',
    )

    // Type strings must agree with schema() — one source of truth per engine.
    const schema = await client.schema(handle)
    const schemaTypes = new Map(schema.map((column) => [column.name, column.type]))

    for (let index = 0; index < dataset.columns.length; index++) {
      const expectation = dataset.columns[index]!
      const actual = profile.columns[index]
      if (actual === undefined) fail(`profile is missing column "${expectation.name}"`)
      const label = `[${expectation.name}]`
      expectEqual(actual!.name, expectation.name, `${label} name`)
      expectEqual(actual!.type, schemaTypes.get(expectation.name), `${label} type vs schema()`)
      expectEqual(actual!.kind, expectation.kind, `${label} kind`)
      expectEqual(actual!.nullCount, expectation.nullCount, `${label} nullCount`)
      expectEqual(actual!.distinctCount, expectation.distinctCount, `${label} distinctCount`)
      if (expectation.kind === 'numeric') {
        expectStatBlock(actual!.numeric, expectation.numeric!, tolerance, label)
      } else if (expectation.kind === 'categorical') {
        expectCondition(
          actual!.categorical !== undefined,
          `${label}: kind 'categorical' must carry a categorical payload`,
        )
        const topK = actual!.categorical!.topK
        expectEqual(
          topK.map((entry) => `${entry.value}:${String(entry.count)}`).join('|'),
          expectation
            .categorical!.topK.map((entry) => `${entry.value}:${String(entry.count)}`)
            .join('|'),
          `${label} top-k (order included; ties by value ascending)`,
        )
      } else {
        expectCondition(
          actual!.numeric === undefined && actual!.categorical === undefined,
          `${label}: kind 'other' must degrade gracefully (no payloads)`,
        )
      }
    }

    // The engine is reusable after profiling: a second profile answers again.
    const second = await client.profile(handle)
    expectEqual(second.rowCount, dataset.rowCount, 'second profile rowCount (reusability)')
    return {
      rowCount: profile.rowCount,
      columns: profile.columns.length,
      unknownHandleRejected: true,
      nullsOnlyColumn: true,
      topKTiePinned: true,
      reusableAfterProfile: true,
    }
  },

  'nested-schema-fidelity': async (subject) => {
    // Subject preconditions (fail loudly on misconfiguration, never vacuously).
    const dataset = subject.nestedDataset
    expectCondition(
      dataset.rowCount >= 1,
      'subject misconfiguration: nestedDataset.rowCount must be at least 1',
    )
    expectCondition(
      dataset.schema.length > 0,
      'subject misconfiguration: declare at least one nested schema column',
    )
    const schemaNames = new Set<string>()
    for (const column of dataset.schema) {
      expectCondition(
        !schemaNames.has(column.name),
        `subject misconfiguration: nested schema declares column "${column.name}" twice`,
      )
      schemaNames.add(column.name)
    }

    const client = subject.createClient()
    await client.ensureReady()
    const handle = await client.open(await subject.stageNestedFile())

    // The pinned contract: full nested type strings (e.g. STRUCT(a STRUCT(b
    // STRUCT(c BIGINT))), STRUCT("at" TIMESTAMP, ok BOOLEAN)[]) exactly as the
    // engine reports them — these feed the m1-6 type tree and m3-4's composer.
    const schema = await client.schema(handle)
    expectColumnsMatch(schema, dataset.schema)
    expectEqual(await client.rowCount(handle), dataset.rowCount, 'nested fixture rowCount')
    return { schemaColumns: schema.length, rowCount: dataset.rowCount }
  },

  'nested-window-fidelity': async (subject) => {
    // Subject preconditions: every declared column covers the same leading
    // window of the fixture, and its columns are all declared in the schema.
    const dataset = subject.nestedDataset
    expectCondition(
      dataset.columns.length > 0,
      'subject misconfiguration: declare at least one nested value column',
    )
    const schemaNames = new Set(dataset.schema.map((column) => column.name))
    const windowRows = dataset.columns[0]!.values.length
    for (const column of dataset.columns) {
      expectCondition(
        schemaNames.has(column.name),
        `subject misconfiguration: nested value column "${column.name}" is not declared in nestedDataset.schema`,
      )
      expectCondition(
        column.values.length === windowRows,
        `subject misconfiguration: nested value column "${column.name}" declares ${String(column.values.length)} rows, expected ${String(windowRows)}`,
      )
    }
    expectCondition(
      windowRows >= 1 && windowRows <= dataset.rowCount,
      'subject misconfiguration: nested value rows must be within 1…rowCount',
    )

    const client = subject.createClient()
    await client.ensureReady()
    const handle = await client.open(await subject.stageNestedFile())

    const range = await client.fetchRange(handle, { startRow: 0, endRow: windowRows })
    expectEqual(range.batch.numRows, windowRows, 'nested fidelity window row count')
    expectEqual(
      range.hasMore,
      false,
      'a window within the fixture must arrive as a single honest batch (hasMore)',
    )
    for (const column of dataset.columns) {
      expectNestedColumnValues(range.batch, column.name, column.values, '[nested fidelity]')
    }
    return {
      columns: dataset.columns.length,
      rows: windowRows,
      cells: dataset.columns.length * windowRows,
    }
  },

  'nested-window-clamp': async (subject) => {
    // Subject preconditions: the offset window is valid, inside the fixture,
    // and covered by the declared value rows (so its slice is checkable).
    const dataset = subject.nestedDataset
    const offset = dataset.offsetWindow
    expectCondition(
      Number.isSafeInteger(offset.startRow) &&
        Number.isSafeInteger(offset.endRow) &&
        offset.startRow >= 0 &&
        offset.endRow > offset.startRow &&
        offset.endRow <= dataset.rowCount,
      'subject misconfiguration: nestedDataset.offsetWindow must be a valid window inside the fixture',
    )
    expectCondition(
      dataset.columns.length > 0 && dataset.columns[0]!.values.length >= offset.endRow,
      'subject misconfiguration: nested value rows must cover offsetWindow.endRow',
    )

    const client = subject.createClient()
    await client.ensureReady()
    const handle = await client.open(await subject.stageNestedFile())

    // A >window-size request is clamped (not rejected) and arrives as one
    // honest batch: the whole fixture, hasMore=false (a capped window never
    // implies further pending rows for this surface).
    const oversized = await client.fetchRange(handle, {
      startRow: 0,
      endRow: dataset.rowCount + subject.maxWindowRows * 10,
    })
    expectEqual(
      oversized.batch.numRows,
      dataset.rowCount,
      'an oversized window over the nested fixture must clamp to the dataset (not the cap, not an error)',
    )
    expectEqual(oversized.hasMore, false, 'hasMore on the clamped nested window')

    // Validated limit/offset compose unchanged with nested columns: the
    // mid-file window returns exactly its declared slice, deep-equal.
    const offsetRows = offset.endRow - offset.startRow
    const window = await client.fetchRange(handle, offset)
    expectEqual(window.batch.numRows, offsetRows, 'nested offset window row count')
    expectEqual(window.hasMore, false, 'hasMore on the nested offset window')
    for (const column of dataset.columns) {
      expectNestedColumnValues(
        window.batch,
        column.name,
        column.values.slice(offset.startRow, offset.endRow),
        '[nested offset window]',
      )
    }

    // Window validation is not relaxed by nested columns either.
    let invalidRejected = 0
    for (const invalid of INVALID_WINDOWS) {
      const error = await rejectionOf(client.fetchRange(handle, invalid))
      expectCondition(
        error !== null && subject.errors.operation(error),
        `an invalid window must still reject over nested columns with the operation error category (got: ${errorMessage(error)})`,
      )
      invalidRejected += 1
    }
    return {
      oversizedRows: oversized.batch.numRows,
      offsetRows,
      invalidRejected,
    }
  },

  'overlay-window-fidelity': async (subject) => {
    // Subject preconditions (fail loudly on misconfiguration, never vacuously).
    const dataset = subject.overlayDataset
    expectCondition(
      dataset.base.baseRowCount >= 1,
      'subject misconfiguration: overlayDataset.base.baseRowCount must be at least 1',
    )
    expectCondition(
      dataset.ops.length > 0,
      'subject misconfiguration: overlayDataset.ops must script at least one op',
    )
    expectCondition(
      dataset.liveRowCount === dataset.rowIds.length,
      'subject misconfiguration: overlayDataset.liveRowCount must equal rowIds.length',
    )
    expectCondition(
      dataset.columns.length > 0,
      'subject misconfiguration: declare values for at least one effective column',
    )
    for (const column of dataset.columns) {
      expectCondition(
        column.values.length === dataset.rowIds.length,
        `subject misconfiguration: effective column "${column.name}" declares ${String(column.values.length)} values, expected ${String(dataset.rowIds.length)}`,
      )
    }
    const offset = dataset.offsetWindow
    expectCondition(
      Number.isSafeInteger(offset.startRow) &&
        Number.isSafeInteger(offset.endRow) &&
        offset.startRow >= 0 &&
        offset.endRow > offset.startRow &&
        offset.endRow <= dataset.liveRowCount,
      'subject misconfiguration: offsetWindow must be a valid window inside the effective row set',
    )
    for (const entry of [dataset.filtered, dataset.sorted]) {
      expectCondition(
        entry.expectValues.length === entry.expectRowCount,
        `subject misconfiguration: semantics entry "${entry.label}" declares ${String(entry.expectValues.length)} values for ${String(entry.expectRowCount)} rows`,
      )
      expectCondition(
        entry.expectRowCount >= 0 && entry.expectRowCount <= subject.maxWindowRows,
        `subject misconfiguration: semantics entry "${entry.label}" row count must fit one window`,
      )
    }
    expectCondition(
      (dataset.filtered.filters?.length ?? 0) > 0,
      'subject misconfiguration: the filtered semantics entry must declare at least one filter',
    )
    expectCondition(
      (dataset.sorted.sort?.length ?? 0) > 0,
      'subject misconfiguration: the sorted semantics entry must declare at least one sort key',
    )

    const client = subject.createClient()
    await client.ensureReady()
    const handle = await client.open(await subject.stageOverlayFile())

    // Effective schema: post-rename names, post-cast engine type strings.
    const schema = await client.overlaySchema(handle, dataset)
    expectColumnsMatch(schema, dataset.effectiveSchema)

    // Live counts: unfiltered (tombstones excluded, live inserts added) and
    // narrowed by the declared filter over effective columns.
    expectEqual(
      await client.overlayRowCount(handle, dataset),
      dataset.liveRowCount,
      'overlay live row count',
    )
    expectEqual(
      await client.overlayRowCount(handle, dataset, { filters: dataset.filtered.filters }),
      dataset.filtered.expectRowCount,
      `[${dataset.filtered.label}] filtered row count`,
    )

    // The full effective window, with row ids: order AND values pinned.
    const full = await client.fetchOverlayRange(handle, dataset, {
      startRow: 0,
      endRow: dataset.liveRowCount,
      includeRowIds: true,
    })
    expectEqual(full.batch.numRows, dataset.liveRowCount, 'full overlay window row count')
    expectColumnValues(full.batch, dataset.rowIdColumn, dataset.rowIds, '[overlay fidelity]')
    for (const column of dataset.columns) {
      expectColumnValues(full.batch, column.name, column.values, '[overlay fidelity]')
    }

    // LIMIT/OFFSET slices the effective order (never the base order).
    const sliceRows = offset.endRow - offset.startRow
    const slice = await client.fetchOverlayRange(handle, dataset, {
      startRow: offset.startRow,
      endRow: offset.endRow,
      includeRowIds: true,
    })
    expectEqual(slice.batch.numRows, sliceRows, 'overlay offset window row count')
    expectColumnValues(
      slice.batch,
      dataset.rowIdColumn,
      dataset.rowIds.slice(offset.startRow, offset.endRow),
      '[overlay offset]',
    )

    // Filter over effective (edited/renamed) values.
    const filtered = await client.fetchOverlayRange(handle, dataset, {
      startRow: 0,
      endRow: subject.maxWindowRows,
      filters: dataset.filtered.filters,
    })
    expectEqual(
      filtered.batch.numRows,
      dataset.filtered.expectRowCount,
      `[${dataset.filtered.label}] window rows`,
    )
    expectColumnValues(
      filtered.batch,
      dataset.filtered.expectColumn,
      dataset.filtered.expectValues,
      `[${dataset.filtered.label}]`,
    )

    // Sort over effective columns (renamed + cast), ties deterministic.
    const sorted = await client.fetchOverlayRange(handle, dataset, {
      startRow: 0,
      endRow: subject.maxWindowRows,
      sort: dataset.sorted.sort,
    })
    expectEqual(
      sorted.batch.numRows,
      dataset.sorted.expectRowCount,
      `[${dataset.sorted.label}] window rows`,
    )
    expectColumnValues(
      sorted.batch,
      dataset.sorted.expectColumn,
      dataset.sorted.expectValues,
      `[${dataset.sorted.label}]`,
    )

    return {
      schemaColumns: schema.length,
      liveRowCount: dataset.liveRowCount,
      filteredCount: dataset.filtered.expectRowCount,
      sliceRows,
      cells: dataset.columns.length * dataset.rowIds.length,
      sortedRows: dataset.sorted.expectRowCount,
    }
  },

  'overlay-insert-edits': async (subject) => {
    // m4-2b defect pin: cell edits on *inserted* rows must reach the composed
    // SQL. The subject's ops edit a cell the insert left NULL (materialized
    // where the broken composer emitted NULL), override a value the insert
    // record itself carried (the edit must win), edit-then-revert a third
    // (the insert value must stand), and rename the edited columns after the
    // fact. Windows, the live count, the effective schema and the export
    // round-trip all pin the merged values.
    const dataset = subject.overlayInsertEdits
    expectCondition(
      dataset.ops.length > 0,
      'subject misconfiguration: overlayInsertEdits.ops must script at least one op',
    )
    expectCondition(
      dataset.liveRowCount === dataset.rowIds.length,
      'subject misconfiguration: overlayInsertEdits.liveRowCount must equal rowIds.length',
    )
    expectCondition(
      dataset.columns.length > 0,
      'subject misconfiguration: declare values for at least one effective column',
    )
    for (const column of dataset.columns) {
      expectCondition(
        column.values.length === dataset.rowIds.length,
        `subject misconfiguration: effective column "${column.name}" declares ${String(column.values.length)} values, expected ${String(dataset.rowIds.length)}`,
      )
    }
    expectCondition(
      dataset.exports.length > 0,
      'subject misconfiguration: declare at least one export check',
    )
    const effectiveValues = new Map(dataset.columns.map((column) => [column.name, column.values]))
    const csvCheck = dataset.exports.find((check) => check.format === 'csv')
    expectCondition(
      csvCheck !== undefined,
      'subject misconfiguration: declare a csv export check (the formula-injection-sanitized format)',
    )
    const csvDiffers = csvCheck!.columns.some((column) => {
      const expected = effectiveValues.get(column.name)
      return (
        expected !== undefined && column.values.some((value, index) => value !== expected[index])
      )
    })
    expectCondition(
      csvDiffers,
      'subject misconfiguration: the csv export expectations must differ from the effective values somewhere — the sanitization pin would be vacuous',
    )

    const client = subject.createClient()
    await client.ensureReady()
    const handle = await client.open(await subject.stageOverlayInsertEditsFile())

    // Effective schema: the post-edit renames are visible, the merged values
    // do not change column types.
    const schema = await client.overlaySchema(handle, dataset)
    expectColumnsMatch(schema, dataset.effectiveSchema)
    expectEqual(
      await client.overlayRowCount(handle, dataset),
      dataset.liveRowCount,
      'insert-edit live row count',
    )

    // The full effective window with row ids: the inserted row's merged
    // values must appear (not the insert record's values, and not NULL).
    const full = await client.fetchOverlayRange(handle, dataset, {
      startRow: 0,
      endRow: dataset.liveRowCount,
      includeRowIds: true,
    })
    expectEqual(full.batch.numRows, dataset.liveRowCount, 'insert-edit window row count')
    expectColumnValues(full.batch, dataset.rowIdColumn, dataset.rowIds, '[overlay insert edits]')
    for (const column of dataset.columns) {
      expectColumnValues(full.batch, column.name, column.values, '[overlay insert edits]')
    }

    // Export round-trip: the merged values (incl. the edited-then-renamed
    // column) must survive the write/re-open for CSV (sanitized) and JSONL.
    let engineReopens = 0
    for (const check of dataset.exports) {
      const label = `[${check.format} insert-edit export]`
      const result = await client.exportView(handle, { format: check.format, overlay: dataset })
      expectEqual(result.format, check.format, `${label} format`)
      expectEqual(result.rowCount, check.rowCount, `${label} honest row count`)
      expectCondition(result.bytes > 0, `${label} byte size must be positive`)
      if (check.roundTrip === 'engine') {
        const reopened = await client.open(await subject.exportedSource(result))
        expectEqual(await client.rowCount(reopened), check.rowCount, `${label} re-opened row count`)
        const range = await client.fetchRange(reopened, { startRow: 0, endRow: check.rowCount })
        expectEqual(range.batch.numRows, check.rowCount, `${label} re-opened window rows`)
        for (const column of check.columns) {
          expectColumnValues(range.batch, column.name, column.values, `${label} round-trip`)
        }
        engineReopens += 1
      } else {
        const container = await subject.readExportedArrowTable(result)
        expectEqual(container.batch.numRows, check.rowCount, `${label} container rows`)
        for (const column of check.columns) {
          expectColumnValues(container.batch, column.name, column.values, `${label} container`)
        }
      }
    }

    return {
      schemaColumns: schema.length,
      liveRowCount: dataset.liveRowCount,
      cells: dataset.columns.length * dataset.rowIds.length,
      formats: dataset.exports.length,
      engineReopens,
      csvSanitizationProbed: csvDiffers,
    }
  },

  'overlay-cast-check': async (subject) => {
    // m4-4b: a host must be able to test a pending `column-cast` before
    // committing it (ADR 0012). The check composes over the **pre-cast**
    // effective relation, so a bad value anywhere — mid-dataset, in an
    // inserted row, or carried through a rename — is found; the 1-row probe
    // m4-4 shipped only saw row 0. Invalid target spellings and unknown
    // columns reject with the typed operation category.
    const dataset = subject.overlayCastCheckDataset
    expectCondition(
      dataset.cases.length > 0,
      'subject misconfiguration: declare at least one cast-check case',
    )
    expectCondition(
      dataset.cases.some((entry) => entry.hasNonConvertibleValues) &&
        dataset.cases.some((entry) => !entry.hasNonConvertibleValues),
      'subject misconfiguration: cast-check cases must cover both classifications',
    )
    expectCondition(
      dataset.invalidTargetTypes.length > 0,
      'subject misconfiguration: declare at least one invalid target spelling',
    )
    expectCondition(
      dataset.unknownColumns.length > 0,
      'subject misconfiguration: declare at least one unknown column',
    )
    expectCondition(
      dataset.agreements.length > 0,
      'subject misconfiguration: declare at least one agreement case',
    )
    expectCondition(
      dataset.agreements.some((entry) => entry.hasNonConvertibleValues) &&
        dataset.agreements.some((entry) => !entry.hasNonConvertibleValues),
      'subject misconfiguration: agreement cases must cover both classifications',
    )

    const client = subject.createClient()
    await client.ensureReady()
    const handle = await client.open(await subject.stageOverlayCastCheckFile())

    // Every case's column must be an effective column of the pre-cast state
    // (fail loudly on a misconfigured dataset instead of passing vacuously).
    const effective = new Set(
      (await client.overlaySchema(handle, dataset)).map((column) => column.name),
    )
    for (const entry of dataset.cases) {
      expectCondition(
        effective.has(entry.column),
        `subject misconfiguration: case "${entry.label}" names a non-effective column`,
      )
    }

    let convertible = 0
    let nonConvertible = 0
    for (const entry of dataset.cases) {
      const result = await client.overlayCastCheck(handle, dataset, {
        column: entry.column,
        targetType: entry.targetType,
      })
      expectEqual(
        result.hasNonConvertibleValues,
        entry.hasNonConvertibleValues,
        `[${entry.label}] hasNonConvertibleValues`,
      )
      if (entry.hasNonConvertibleValues) nonConvertible += 1
      else convertible += 1
    }

    // Agreement battery (m4-4b round 3): the check must answer exactly what
    // committing the pending cast does. For each case, compare the check's
    // boolean against the subject's committed-materialization probe — a
    // conversion rejection of the committed effective view means `true`.
    let agreed = 0
    for (const entry of dataset.agreements) {
      const preCast: ConformanceOverlay = { base: dataset.base, ops: entry.ops }
      const result = await client.overlayCastCheck(handle, preCast, {
        column: entry.column,
        targetType: entry.targetType,
      })
      expectEqual(
        result.hasNonConvertibleValues,
        entry.hasNonConvertibleValues,
        `[agreement ${entry.label}] hasNonConvertibleValues`,
      )
      const committedFails = await subject.committedCastFails(client, handle, preCast, {
        column: entry.column,
        targetType: entry.targetType,
      })
      expectEqual(
        result.hasNonConvertibleValues,
        committedFails,
        `[agreement ${entry.label}] the check must equal the committed cast outcome`,
      )
      agreed += 1
    }

    // Invalid target spellings reject with the typed operation category
    // (validated client-side — no request is posted).
    let invalidRejected = 0
    for (let index = 0; index < dataset.invalidTargetTypes.length; index++) {
      const error = await rejectionOf(
        client.overlayCastCheck(handle, dataset, {
          column: dataset.cases[0]!.column,
          targetType: dataset.invalidTargetTypes[index]!,
        }),
      )
      expectCondition(error !== null, `invalid target spelling ${String(index)} must be rejected`)
      expectCondition(
        subject.errors.operation(error),
        `invalid target spelling ${String(index)} must be the typed operation category (got: ${errorMessage(error)})`,
      )
      invalidRejected += 1
    }

    // Unknown effective columns reject the same way.
    let unknownRejected = 0
    for (const column of dataset.unknownColumns) {
      const error = await rejectionOf(
        client.overlayCastCheck(handle, dataset, { column, targetType: 'BIGINT' }),
      )
      expectCondition(error !== null, 'an unknown column must be rejected')
      expectCondition(
        subject.errors.operation(error),
        `an unknown column must be the typed operation category (got: ${errorMessage(error)})`,
      )
      unknownRejected += 1
    }

    // The engine stays usable after the rejections.
    const reusable = await client.overlayCastCheck(handle, dataset, {
      column: dataset.cases[0]!.column,
      targetType: dataset.cases[0]!.targetType,
    })
    expectEqual(
      reusable.hasNonConvertibleValues,
      dataset.cases[0]!.hasNonConvertibleValues,
      'engine reusable after rejected checks',
    )

    return {
      cases: dataset.cases.length,
      convertible,
      nonConvertible,
      agreements: agreed,
      invalidRejected,
      unknownRejected,
      engineReusable: true,
    }
  },

  'export-round-trip': async (subject) => {
    // Subject preconditions: at least one format; the CSV check must probe
    // sanitization non-vacuously (its expectations differ from the effective
    // values somewhere), and a declared JSONL check must pin the raw content
    // (its expectations equal the effective values exactly).
    const dataset = subject.overlayDataset
    expectCondition(
      dataset.exports.length > 0,
      'subject misconfiguration: declare at least one export check',
    )
    const formats = new Set(dataset.exports.map((check) => check.format))
    expectCondition(
      formats.size === dataset.exports.length,
      'subject misconfiguration: export checks must declare distinct formats',
    )
    const effectiveValues = new Map(dataset.columns.map((column) => [column.name, column.values]))
    const csvCheck = dataset.exports.find((check) => check.format === 'csv')
    expectCondition(
      csvCheck !== undefined,
      'subject misconfiguration: declare a csv export check (the formula-injection-sanitized format)',
    )
    const csvDiffers = csvCheck!.columns.some((column) => {
      const expected = effectiveValues.get(column.name)
      return (
        expected !== undefined && column.values.some((value, index) => value !== expected[index])
      )
    })
    expectCondition(
      csvDiffers,
      'subject misconfiguration: the csv export expectations must differ from the effective values somewhere — the formula-injection sanitization pin would be vacuous',
    )
    const jsonlCheck = dataset.exports.find((check) => check.format === 'jsonl')
    if (jsonlCheck !== undefined) {
      const identical = jsonlCheck.columns.every((column) => {
        const expected = effectiveValues.get(column.name)
        return (
          expected === undefined ||
          (column.values.length === expected.length &&
            column.values.every((value, index) => value === expected[index]))
        )
      })
      expectCondition(
        identical,
        'subject misconfiguration: the jsonl export expectations must equal the effective values — raw content must stay visible (no sanitization)',
      )
    }

    const client = subject.createClient()
    await client.ensureReady()
    const source = await subject.stageOverlayFile()
    const handle = await client.open(source)

    let engineReopens = 0
    let arrowVerified = 0
    for (const check of dataset.exports) {
      const label = `[${check.format} export]`
      const result = await client.exportView(handle, { format: check.format, overlay: dataset })
      expectEqual(result.format, check.format, `${label} format`)
      expectEqual(result.rowCount, check.rowCount, `${label} honest row count`)
      expectCondition(result.bytes > 0, `${label} byte size must be positive`)
      expectCondition(
        result.path !== source.name,
        `${label} the export destination must never be the source path`,
      )
      if (check.roundTrip === 'engine') {
        // Re-open the exported file through the engine's ordinary open path
        // and verify the pinned (per-format) content, effective order.
        const reopened = await client.open(await subject.exportedSource(result))
        expectEqual(await client.rowCount(reopened), check.rowCount, `${label} re-opened row count`)
        const range = await client.fetchRange(reopened, { startRow: 0, endRow: check.rowCount })
        expectEqual(range.batch.numRows, check.rowCount, `${label} re-opened window rows`)
        for (const column of check.columns) {
          expectColumnValues(range.batch, column.name, column.values, `${label} round-trip`)
        }
        engineReopens += 1
      } else {
        // The engine cannot re-open .arrow files yet (m1-4 deferral): the
        // exported bytes are verified through their native Arrow IPC
        // container instead — same content contract.
        const container = await subject.readExportedArrowTable(result)
        expectEqual(container.batch.numRows, check.rowCount, `${label} container rows`)
        for (const column of check.columns) {
          expectColumnValues(container.batch, column.name, column.values, `${label} container`)
        }
        arrowVerified += 1
      }
    }
    return {
      formats: dataset.exports.length,
      engineReopens,
      arrowVerified,
      csvSanitizationProbed: csvDiffers,
    }
  },

  'source-immutability': async (subject) => {
    // A full edit+export session over the staged source must leave the
    // source file byte-identical (ADR 0012: the base is never mutated in
    // place; exports are NEW generated files, never the source path).
    const dataset = subject.overlayDataset
    expectCondition(
      dataset.exports.length > 0,
      'subject misconfiguration: declare at least one export check so the session exports',
    )
    const source = await subject.stageOverlayFile()
    const digestBefore = await subject.sourceDigest(source)

    const client = subject.createClient()
    await client.ensureReady()
    const handle = await client.open(source)

    // Schema + counts + windows: the ordinary editing-session reads.
    await client.overlaySchema(handle, dataset)
    await client.overlayRowCount(handle, dataset)
    await client.fetchOverlayRange(handle, dataset, {
      startRow: 0,
      endRow: dataset.liveRowCount,
      includeRowIds: true,
    })
    await client.fetchOverlayRange(handle, dataset, {
      startRow: dataset.offsetWindow.startRow,
      endRow: dataset.offsetWindow.endRow,
    })
    await client.fetchOverlayRange(handle, dataset, {
      startRow: 0,
      endRow: subject.maxWindowRows,
      filters: dataset.filtered.filters,
      sort: dataset.sorted.sort,
    })

    // Exports of every declared format, each to its own generated destination.
    const destinations = new Set<string>()
    for (const check of dataset.exports) {
      const result = await client.exportView(handle, { format: check.format, overlay: dataset })
      expectCondition(
        result.path !== source.name,
        `[${check.format}] the export destination must never be the source path`,
      )
      destinations.add(result.path)
    }

    // The byte-identity assertion: source digest unchanged after everything.
    const digestAfter = await subject.sourceDigest(source)
    expectEqual(
      digestAfter,
      digestBefore,
      'the staged source file must be byte-identical after the edit+export session (ADR 0012: never rewritten in place)',
    )
    return {
      exports: dataset.exports.length,
      distinctDestinations: destinations.size,
      digestUnchanged: true,
    }
  },

  'overlay-hostile-types-rejected': async (subject) => {
    // The m4-2 review's finding 1: type strings reached SQL type positions
    // unvalidated, and a payload closed the position with
    // `VARCHAR) AS "c" … ; CREATE TABLE assay_injected …`. The boundary must
    // reject every injection-shaped spelling with a typed error and build no
    // statement; the named side-effect table must not exist afterwards.
    expectCondition(
      subject.hostileTypeProbes.length > 0,
      'subject misconfiguration: declare at least one hostile type-expression probe',
    )
    const client = subject.createClient()
    await client.ensureReady()
    const handle = await client.open(await subject.stageOverlayFile())

    let rejected = 0
    for (const probe of subject.hostileTypeProbes) {
      const error = await rejectionOf(client.overlaySchema(handle, probe.overlay))
      expectCondition(
        error !== null,
        `[${probe.label}] a hostile engine type expression must be rejected (no SQL may be composed)`,
      )
      expectCondition(
        subject.errors.operation(error),
        `[${probe.label}] the rejection must be the typed operation category (got: ${errorMessage(error)})`,
      )
      rejected += 1
      if (probe.injectedTable !== undefined) {
        const exists = await subject.tableExists(client, probe.injectedTable)
        expectCondition(
          !exists,
          `[${probe.label}] the injection's side-effect table must not exist after the rejected probe`,
        )
      }
    }

    // The engine must stay usable and the ordinary overlay surface unchanged.
    const schema = await client.overlaySchema(handle, subject.overlayDataset)
    expectColumnsMatch(schema, subject.overlayDataset.effectiveSchema)
    const liveRowCount = await client.overlayRowCount(handle, subject.overlayDataset)
    expectEqual(
      liveRowCount,
      subject.overlayDataset.liveRowCount,
      'hostile probes must not change the overlay surface',
    )
    return {
      probes: subject.hostileTypeProbes.length,
      rejected,
      injectedAbsent: true,
      engineReusable: true,
    }
  },

  /**
   * m5-2 validation execution: the REAL m5-1 compiler turns the subject's
   * contract (canonical YAML) into a plan against the engine's own schema();
   * the engine executes it against the effective view. Pins, all host-engine-
   * derived: per-rule counts/percent/samples on the base run and the empty-
   * overlay run; an overlay-interaction battery (an edit that FIXES a rule
   * flips its verdict, an edit that VIOLATES flips it, an inserted violating
   * row APPEARS under its `ins:` row key, a tombstoned row's violation
   * DISAPPEARS, and the dataset-level row-count facts flip too); the sample
   * hard max (a plan AT the hard max executes with failCount ≠ the sample
   * bound; m5-2 round 3: a plan PAST it also EXECUTES — samples clamped to
   * the hard max, failCount still the rule's FULL count); hostile plans —
   * including the fix round's canary probes (the review's
   * exact `CREATE TABLE <canary> AS SELECT 1`, with and without a relation
   * occurrence) and the round-3 comment-bearing pseudo-reference probes
   * plus a shape-valid plan whose counts exceed the dataset (the round-3
   * result-sanity guard) — each rejected with one typed operation error,
   * every canary table asserted absent via a catalog listing, and a plan
   * bound to an already-existing user view failing WITHOUT destroying that
   * view; the m5-0 type-vocabulary agreement (all 21 spellings
   * reported by the engine for columns created with those types; the bare
   * DECIMAL caveat pinned); and the engine reusable after all of it.
   */
  'validation-plan-execution': async (subject) => {
    const dataset = subject.validationDataset
    // Subject preconditions (fail loudly on misconfiguration, never vacuously).
    expectCondition(dataset.contractYaml.length > 0, 'subject misconfiguration: declare a contract')
    expectCondition(
      dataset.baseExpectations.rules.length > 0,
      'subject misconfiguration: declare base expectations for at least one rule',
    )
    expectCondition(
      dataset.baseExpectations.rules.some((rule) => rule.failCount > 0) &&
        dataset.baseExpectations.rules.some((rule) => rule.failCount === 0),
      'subject misconfiguration: the base expectations must include both failing and passing rules',
    )
    expectCondition(
      dataset.baseExpectations.rules.some(
        (rule) => rule.samples !== undefined || rule.firstSample !== undefined,
      ),
      'subject misconfiguration: pin samples for at least one base rule',
    )
    expectCondition(
      dataset.interactions.length >= 2,
      'subject misconfiguration: declare the overlay-interaction battery',
    )
    expectCondition(
      dataset.truncation.clampedSampleLimit > dataset.truncation.hardMax,
      'subject misconfiguration: the clamped K must be past the hard max',
    )
    expectCondition(
      dataset.truncation.expectFailCount > dataset.truncation.hardMax &&
        dataset.truncation.expectSamples ===
          Math.min(dataset.truncation.expectFailCount, dataset.truncation.hardMax),
      'subject misconfiguration: the hard-max run must be non-vacuous (violations exceed the bound)',
    )
    expectCondition(
      dataset.hostilePlans.length > 0,
      'subject misconfiguration: declare at least one hostile plan probe',
    )
    expectCondition(
      dataset.injectedTables.length > 0,
      'subject misconfiguration: declare the canary tables the hostile plans must not create',
    )
    // Every declared failPercent must equal the documented integer half-up
    // formula over (failCount, rowCount) — the written definition m5-4/m5-6
    // pin against. This keeps the pinned percents independent of the engine.
    // Exact BigInt intermediates (m5-2 fix round): the float form diverges
    // for large counts (failCount*200 + rowCount can leave the safe range).
    const specPercent = (failCount: number, rowCount: number): number =>
      rowCount === 0
        ? 0
        : Number((BigInt(failCount) * 200n + BigInt(rowCount)) / (2n * BigInt(rowCount)))
    const expectationsAreCoherent = (
      entry: ConformanceValidationExpectations,
      label: string,
    ): void => {
      for (const rule of entry.rules) {
        expectEqual(
          rule.failPercent,
          specPercent(rule.failCount, entry.rowCount),
          `[${label}] ${rule.ruleId} declared failPercent vs the documented half-up formula`,
        )
      }
    }
    expectationsAreCoherent(dataset.baseExpectations, 'base')
    expectationsAreCoherent(dataset.emptyOverlayExpectations, 'empty overlay')
    for (const interaction of dataset.interactions) {
      expectationsAreCoherent(interaction.expectations, interaction.label)
    }

    // Compile the contract against the engine's OWN schema (the real m5-1
    // compiler — the wire shapes the engine sees are compiler output).
    const parsed = parseContract(dataset.contractYaml)
    expectCondition(
      parsed.ok,
      `subject misconfiguration: the contract YAML must parse (${parsed.ok ? '' : (parsed.errors[0]?.message ?? 'unknown error')})`,
    )
    if (!parsed.ok) fail('unreachable')
    const client = subject.createClient()
    await client.ensureReady()
    const handle = await client.open(await subject.stageValidationFile())
    const schema = await client.schema(handle)
    const compiled = compileContract(parsed.contract, schema, {
      relation: dataset.planRelation,
      sampleLimit: dataset.sampleLimit,
    })
    expectCondition(
      compiled.ok,
      'subject misconfiguration: the contract must bind against the engine schema (compile errors above)',
    )
    if (!compiled.ok) fail('unreachable')
    const plan = compiled.plan

    /** Assert one run's result against its declared expectations. */
    const expectRun = (
      entry: ConformanceValidationExpectations,
      result: ConformanceValidationResult,
      label: string,
    ): void => {
      expectEqual(result.valid, entry.valid, `[${label}] total verdict`)
      expectEqual(result.rowCount, entry.rowCount, `[${label}] effective row count`)
      expectEqual(
        result.rules.length,
        entry.rules.length,
        `[${label}] one result per planned rule (plan order)`,
      )
      entry.rules.forEach((expected, index) => {
        const actual = result.rules[index]
        if (actual === undefined) fail(`[${label}] result ${String(index)} missing`)
        expectEqual(actual!.ruleId, expected.ruleId, `[${label}] rule ${String(index)} id`)
        expectEqual(
          actual!.failCount,
          expected.failCount,
          `[${label}] ${expected.ruleId} failCount`,
        )
        expectEqual(
          actual!.failPercent,
          expected.failPercent,
          `[${label}] ${expected.ruleId} failPercent`,
        )
        if (expected.samples !== undefined) {
          expectEqual(
            JSON.stringify(actual!.sampleFailures),
            JSON.stringify(expected.samples),
            `[${label}] ${expected.ruleId} samples (full list)`,
          )
        } else if (expected.firstSample !== undefined) {
          const first = actual!.sampleFailures[0]
          expectCondition(
            first !== undefined,
            `[${label}] ${expected.ruleId} must carry a first sample`,
          )
          expectEqual(
            JSON.stringify(first),
            JSON.stringify(expected.firstSample),
            `[${label}] ${expected.ruleId} first sample`,
          )
        }
      })
    }

    // 1. The base run (absent overlay): the plain base view.
    const baseResult = await client.validate(handle, plan)
    expectRun(dataset.baseExpectations, baseResult, 'base')

    // 2. The empty-ops overlay run: same plan, same counts, session-anchored
    // row keys (the m4-3 grammar over the live editing session).
    const emptyResult = await client.validate(handle, plan, { base: dataset.base, ops: [] })
    expectRun(dataset.emptyOverlayExpectations, emptyResult, 'empty overlay')

    // 3. The overlay-interaction battery: same plan, different effective data.
    let fixFlips = 0
    let violateFlips = 0
    const baseFails = new Map(
      dataset.baseExpectations.rules.map((rule) => [rule.ruleId, rule.failCount]),
    )
    for (const interaction of dataset.interactions) {
      const result = await client.validate(handle, plan, {
        base: dataset.base,
        ops: interaction.ops,
      })
      expectRun(interaction.expectations, result, interaction.label)
      for (const rule of interaction.expectations.rules) {
        const before = baseFails.get(rule.ruleId) ?? 0
        if (before > 0 && rule.failCount === 0) fixFlips += 1
        if (before === 0 && rule.failCount > 0) violateFlips += 1
      }
    }
    expectCondition(
      fixFlips >= 1 && violateFlips >= 1,
      `the interaction battery must pin a fix flip and a violate flip (got ${String(fixFlips)}/${String(violateFlips)})`,
    )

    // 4. The sample clamp (m5-2 round-3 semantics: ANY safe K ≥ 1 executes
    // — over-max K is CLAMPED, never refused): a plan compiled with exactly
    // the hard max executes — failCount is the rule's own count (not the
    // sample bound) and reported samples stop at the hard max — and a plan
    // compiled PAST the hard max ALSO executes: its samples stop at exactly
    // the hard max while its failCount is still the rule's FULL count (the
    // outer LIMIT bounds only the returned rows — never the count), and the
    // engine stays usable.
    const atMaxCompile = compileContract(parsed.contract, schema, {
      relation: dataset.planRelation,
      sampleLimit: dataset.truncation.hardMax,
    })
    expectCondition(atMaxCompile.ok, 'the hard-max plan must compile')
    if (!atMaxCompile.ok) fail('unreachable')
    const atMaxResult = await client.validate(handle, atMaxCompile.plan)
    const truncExpected = dataset.baseExpectations.rules.find(
      (rule) => rule.ruleId === dataset.truncation.ruleId,
    )
    expectCondition(
      truncExpected !== undefined,
      'hard-max rule must exist in the base expectations',
    )
    const truncActual = atMaxResult.rules.find((rule) => rule.ruleId === dataset.truncation.ruleId)
    expectCondition(truncActual !== undefined, 'hard-max rule missing from the result')
    expectEqual(
      truncActual!.failCount,
      dataset.truncation.expectFailCount,
      '[hard-max] failCount is not the sample bound',
    )
    expectEqual(
      truncActual!.failCount,
      truncExpected!.failCount,
      '[hard-max] failCount matches the base run',
    )
    expectEqual(
      truncActual!.sampleFailures.length,
      dataset.truncation.expectSamples,
      '[hard-max] samples stop at the hard max',
    )
    const truncFirst = truncActual!.sampleFailures[0]
    expectCondition(truncFirst !== undefined, '[hard-max] the sample list is non-empty')
    expectEqual(
      JSON.stringify(truncFirst),
      JSON.stringify({
        rowKey: dataset.truncation.expectFirstRowKey,
        value: dataset.truncation.expectFirstValue,
      }),
      '[hard-max] first sample',
    )
    const overCompile = compileContract(parsed.contract, schema, {
      relation: dataset.planRelation,
      sampleLimit: dataset.truncation.clampedSampleLimit,
    })
    expectCondition(overCompile.ok, 'the clamped-K plan must compile')
    if (!overCompile.ok) fail('unreachable')
    const overResult = await client.validate(handle, overCompile.plan)
    const overActual = overResult.rules.find((rule) => rule.ruleId === dataset.truncation.ruleId)
    expectCondition(overActual !== undefined, 'clamped-K rule missing from the result')
    expectEqual(
      overActual!.failCount,
      dataset.truncation.expectFailCount,
      "[clamped K] failCount is the rule's FULL count — never corrupted by the outer limit",
    )
    expectEqual(
      overActual!.sampleFailures.length,
      dataset.truncation.expectSamples,
      '[clamped K] samples stop exactly at the hard max',
    )
    expectCondition(subject.isReady(client), '[clamped K] the engine must stay ready')

    // 5. Hostile plans: each rejects with ONE typed operation error, leaves
    // no side-effect objects, and the engine stays reusable. The battery
    // includes the m5-2 fix round's canary probes (the review's exact
    // `CREATE TABLE <canary> AS SELECT 1`, with and without a relation
    // occurrence): each must be rejected BEFORE execution, and every canary
    // table is asserted absent via a catalog listing query afterwards.
    let hostileRejected = 0
    for (const probe of dataset.hostilePlans) {
      const error = await rejectionOf(
        client.validate(handle, probe.plan, { base: dataset.base, ops: [] }),
      )
      expectCondition(error !== null, `[${probe.label}] a hostile plan must be rejected`)
      expectCondition(
        subject.errors.operation(error),
        `[${probe.label}] the rejection must be the typed operation category (got: ${errorMessage(error)})`,
      )
      expectCondition(
        subject.isReady(client),
        `[${probe.label}] the engine must stay ready after the rejection`,
      )
      hostileRejected += 1
    }
    let canariesAbsent = true
    for (const canary of dataset.injectedTables) {
      if (await subject.tableExists(client, canary)) canariesAbsent = false
    }
    expectCondition(canariesAbsent, 'the hostile plan side-effect objects must not exist')

    // 6. Pre-existing-view survival (m5-2 fix round): a plan bound to a name
    // that already exists as a user-created view (created through user SQL,
    // not the registry — the shape the original unconditional `DROP VIEW
    // IF EXISTS` cleanup destroyed) fails its materialization with one
    // typed error, and the user's view MUST survive it.
    const probeRelation = dataset.preExistingViewName
    const probeQuoted = `"${probeRelation.replaceAll('"', '""')}"`
    const rebind = (sql: string): string =>
      sql.split(quotedRelationTokenFor(dataset.planRelation)).join(probeQuoted)
    const preExistingPlan: ConformanceValidationPlan = {
      ...plan,
      relation: probeRelation,
      rules: plan.rules.map((rule) => ({ ...rule, sql: rebind(rule.sql) })),
      summarySql: rebind(plan.summarySql),
    }
    await client.query(`CREATE VIEW ${probeQuoted} AS SELECT 42 AS v`)
    const surviveError = await rejectionOf(
      client.validate(handle, preExistingPlan, { base: dataset.base, ops: [] }),
    )
    expectCondition(
      surviveError !== null,
      'a plan bound to an existing view name must fail its materialization',
    )
    expectCondition(
      subject.errors.operation(surviveError),
      `[pre-existing view] the rejection must be the typed operation category (got: ${errorMessage(surviveError)})`,
    )
    expectCondition(
      await subject.tableExists(client, probeRelation),
      'the pre-existing user view must survive the failed validation',
    )
    await client.query(`DROP VIEW ${probeQuoted}`)

    // 6. The m5-0 type-vocabulary agreement: one engine column per spelling;
    // the reported type is the spelling itself — except bare DECIMAL, which
    // DuckDB reports parameterized (the documented m5-0 caveat).
    const vocabulary = await subject.vocabularySchema(client)
    expectEqual(
      vocabulary.length,
      CONTRACT_TYPE_VOCABULARY.length,
      'the vocabulary probe must create exactly one column per spelling',
    )
    const byName = new Map(vocabulary.map((column) => [column.name, column.type]))
    let agreed = 0
    for (const spelling of CONTRACT_TYPE_VOCABULARY) {
      const name = `${dataset.vocabularyPrefix}${spelling}`
      const reported = byName.get(name)
      expectCondition(reported !== undefined, `the vocabulary probe is missing column ${name}`)
      const expectedType = spelling === 'DECIMAL' ? dataset.decimalReportedType : spelling
      expectEqual(reported, expectedType, `vocabulary agreement for ${spelling}`)
      agreed += 1
    }

    // 7. The engine is reusable after everything (benign re-validate).
    const after = await client.validate(handle, plan)
    expectRun(dataset.baseExpectations, after, 'reuse')

    return {
      rules: plan.rules.length,
      rowCount: baseResult.rowCount,
      failingRules: dataset.baseExpectations.rules.filter((rule) => rule.failCount > 0).length,
      interactions: dataset.interactions.length,
      fixFlips,
      violateFlips,
      hardMaxSamples: truncActual!.sampleFailures.length,
      clampedKSamples: overActual!.sampleFailures.length,
      oversizeKClamped: true,
      hostileRejected,
      canariesAbsent,
      preExistingViewSurvived: true,
      vocabularyAgreed: agreed,
      engineReusable: true,
    }
  },

  /**
   * 21. `row-diff-plan-execution` (m6-2) — the REAL m6-1 compiler turns the
   *     subject's two schemas + explicit keys into a plan; the engine stages
   *     a comparison file and executes the plan with side A on the **effective
   *     view** (base-vs-base) and side B on the staged scratch view. Pins:
   *     exact per-aspect counts and bounded side-qualified samples
   *     (CLI-derived, incl. changed-column sets); per-aspect ≡ totals count
   *     agreement; the overlay-interaction battery (an A-side edit flips the
   *     row-diff counts); the K clamp (a plan past the hard max executes with
   *     samples clamped, count untouched); hostile plans rejected with one
   *     typed error and no side effects; the pre-existing-view survival pin;
   *     and the staging failure paths (missing + unsupported file).
   */
  'row-diff-plan-execution': async (subject) => {
    const dataset = subject.rowDiffDataset
    // Subject preconditions (fail loudly on misconfiguration, never vacuously).
    expectCondition(dataset.keys.length > 0, 'subject misconfiguration: declare key columns')
    expectCondition(
      dataset.baseExpectations.aspects.length === 3,
      'subject misconfiguration: declare all three base aspect expectations',
    )
    expectCondition(
      dataset.baseExpectations.aspects.some((aspect) => aspect.count > 0) &&
        dataset.baseExpectations.aspects.some((aspect) => aspect.samples !== undefined),
      'subject misconfiguration: the base expectations must be non-empty and pin samples',
    )
    expectCondition(
      dataset.interactions.length >= 1,
      'subject misconfiguration: declare the overlay-interaction battery',
    )
    expectCondition(
      dataset.truncation.clampedSampleLimit > dataset.truncation.hardMax &&
        dataset.truncation.expectCount > dataset.truncation.hardMax &&
        dataset.truncation.expectSamples ===
          Math.min(dataset.truncation.expectCount, dataset.truncation.hardMax),
      'subject misconfiguration: the clamp pin must be non-vacuous',
    )
    expectCondition(
      dataset.hostilePlans.length > 0,
      'subject misconfiguration: declare at least one hostile plan probe',
    )
    expectCondition(
      dataset.injectedTables.length > 0,
      'subject misconfiguration: declare the canary tables the hostile plans must not create',
    )

    const client = subject.createClient()
    await client.ensureReady()
    const handle = await client.open(await subject.stageRowDiffFile())
    const schemaA = await client.schema(handle)
    const comparison = await client.stageComparison(await subject.stageRowDiffComparisonFile())

    /** Compile the real m6-1 plan against the engine's own two schemas. */
    const compile = (sampleLimit: number): ConformanceRowDiffPlan => {
      const result = compileRowDiffPlan(schemaA, comparison.schema, dataset.keys, {
        relationA: dataset.relationA,
        relationB: dataset.relationB,
        sampleLimit,
      })
      expectCondition(
        result.ok,
        'subject misconfiguration: the plan must compile against the engine schemas',
      )
      if (!result.ok) fail('unreachable')
      return result.plan
    }
    const plan = compile(dataset.sampleLimit)

    /** Assert one run's result against its declared expectations. */
    const expectRun = (
      entry: ConformanceRowDiffExpectations,
      result: ConformanceRowDiffResult,
      label: string,
    ): void => {
      expectEqual(result.rowCountA, entry.rowCountA, `[${label}] side-A row count`)
      expectEqual(result.rowCountB, entry.rowCountB, `[${label}] side-B row count`)
      expectEqual(
        result.aspects.length,
        entry.aspects.length,
        `[${label}] one result per aspect (plan order)`,
      )
      entry.aspects.forEach((expected, index) => {
        const actual = result.aspects[index]
        if (actual === undefined) fail(`[${label}] aspect ${String(index)} missing`)
        expectEqual(actual!.aspect, expected.aspect, `[${label}] aspect ${String(index)} name`)
        expectEqual(actual!.count, expected.count, `[${label}] ${expected.aspect} count`)
        if (expected.samples !== undefined) {
          expectEqual(
            JSON.stringify(actual!.samples),
            JSON.stringify(expected.samples),
            `[${label}] ${expected.aspect} samples`,
          )
        }
      })
    }

    // 1. The base run (absent overlay): the plain base view.
    const baseResult = await client.diff(handle, comparison, plan)
    expectRun(dataset.baseExpectations, baseResult, 'base')

    // 2. The overlay-interaction battery: the same plan, side A composed over
    //    different op lists. At least one interaction must change the aspect
    //    counts (the A-side edit flips the row-diff verdict).
    let countFlips = 0
    const baseCounts = baseResult.aspects.map((aspect) => aspect.count).join(',')
    for (const interaction of dataset.interactions) {
      const result = await client.diff(handle, comparison, plan, {
        base: dataset.base,
        ops: interaction.ops,
      })
      expectRun(interaction.expectations, result, interaction.label)
      if (result.aspects.map((aspect) => aspect.count).join(',') !== baseCounts) countFlips += 1
    }
    expectCondition(
      countFlips >= 1,
      `the interaction battery must flip at least one aspect count (got ${String(countFlips)})`,
    )

    // 3. The K clamp (the m5-2 semantics applied to row diff): a plan compiled
    //    PAST the hard max EXECUTES — samples stop at the hard max while the
    //    aspect's exact count is the FULL count, never corrupted by the outer
    //    limit.
    const overPlan = compile(dataset.truncation.clampedSampleLimit)
    const overResult = await client.diff(handle, comparison, overPlan)
    const overAspect = overResult.aspects.find(
      (aspect) => aspect.aspect === dataset.truncation.aspect,
    )
    expectCondition(overAspect !== undefined, 'the clamped-K aspect is missing from the result')
    expectEqual(
      overAspect!.count,
      dataset.truncation.expectCount,
      '[clamped K] the aspect count is the FULL count — never corrupted by the outer limit',
    )
    expectEqual(
      overAspect!.samples.length,
      dataset.truncation.expectSamples,
      '[clamped K] samples stop exactly at the hard max',
    )
    expectEqual(
      overAspect!.samples[0]?.rowKey,
      dataset.truncation.expectFirstRowKey,
      '[clamped K] first sample row key',
    )
    expectCondition(subject.isReady(client), '[clamped K] the engine must stay ready')

    // 4. Hostile plans: each rejects with ONE typed operation error, leaves no
    //    side-effect objects, and the engine stays reusable.
    let hostileRejected = 0
    for (const probe of dataset.hostilePlans) {
      const error = await rejectionOf(client.diff(handle, comparison, probe.plan))
      expectCondition(error !== null, `[${probe.label}] a hostile plan must be rejected`)
      expectCondition(
        subject.errors.operation(error),
        `[${probe.label}] the rejection must be the typed operation category (got: ${errorMessage(error)})`,
      )
      expectCondition(
        subject.isReady(client),
        `[${probe.label}] the engine must stay ready after the rejection`,
      )
      hostileRejected += 1
    }
    let canariesAbsent = true
    for (const canary of dataset.injectedTables) {
      if (await subject.tableExists(client, canary)) canariesAbsent = false
    }
    expectCondition(canariesAbsent, 'the hostile plan side-effect objects must not exist')

    // 5. Pre-existing-view survival: a plan bound to a name that already
    //    exists as a user-created view fails its materialization with one
    //    typed error, and the user's view MUST survive it (the failed create
    //    never marks the view as op-created, so cleanup never drops it).
    const probeRelation = dataset.preExistingViewName
    const probeQuoted = `"${probeRelation.replaceAll('"', '""')}"`
    const sourceQuoted = `"${dataset.relationA.replaceAll('"', '""')}"`
    const rebind = (sql: string): string => sql.split(sourceQuoted).join(probeQuoted)
    const preExistingPlan: ConformanceRowDiffPlan = {
      ...plan,
      relationA: probeRelation,
      addedSql: rebind(plan.addedSql),
      removedSql: rebind(plan.removedSql),
      changedSql: rebind(plan.changedSql),
      totalsSql: rebind(plan.totalsSql),
    }
    await client.query(`CREATE VIEW ${probeQuoted} AS SELECT 42 AS v`)
    const surviveError = await rejectionOf(client.diff(handle, comparison, preExistingPlan))
    expectCondition(
      surviveError !== null,
      'a plan bound to an existing view name must fail its materialization',
    )
    expectCondition(
      subject.errors.operation(surviveError),
      `[pre-existing view] the rejection must be the typed operation category (got: ${errorMessage(surviveError)})`,
    )
    expectCondition(
      await subject.tableExists(client, probeRelation),
      'the pre-existing user view must survive the failed row diff',
    )
    await client.query(`DROP VIEW ${probeQuoted}`)

    // 6. Staging failure paths: an unsupported extension rejects with the
    //    typed operation category, and a file whose bytes cannot be resolved
    //    rejects too — the engine stays ready and the previously staged
    //    comparison is still usable afterwards.
    const unsupportedSource = await subject.stageBytes(
      new Uint8Array([1, 2, 3]),
      dataset.unsupportedComparisonName,
    )
    const unsupportedError = await rejectionOf(client.stageComparison(unsupportedSource))
    expectCondition(
      unsupportedError !== null && subject.errors.operation(unsupportedError),
      `[unsupported file] the rejection must be the typed operation category (got: ${errorMessage(unsupportedError)})`,
    )
    const missingError = await rejectionOf(client.stageComparison(subject.missingComparisonSource))
    expectCondition(
      missingError !== null && subject.errors.operation(missingError),
      `[missing file] the rejection must be the typed operation category (got: ${errorMessage(missingError)})`,
    )

    // 7. The engine is reusable after everything (benign re-run over the same
    //    still-staged comparison).
    const after = await client.diff(handle, comparison, plan)
    expectRun(dataset.baseExpectations, after, 'reuse')

    return {
      keys: dataset.keys.length,
      rowCountA: baseResult.rowCountA,
      rowCountB: baseResult.rowCountB,
      added: baseResult.aspects.find((aspect) => aspect.aspect === 'added')?.count ?? -1,
      removed: baseResult.aspects.find((aspect) => aspect.aspect === 'removed')?.count ?? -1,
      changed: baseResult.aspects.find((aspect) => aspect.aspect === 'changed')?.count ?? -1,
      interactions: dataset.interactions.length,
      countFlips,
      clampedCount: overAspect!.count,
      clampedSamples: overAspect!.samples.length,
      hostileRejected,
      canariesAbsent,
      preExistingViewSurvived: true,
      stagingFailuresRejected: true,
      engineReusable: true,
    }
  },
}

// ---- Runner ----

/**
 * Run the named scenarios (default: all) sequentially against `subject`.
 * Each scenario runs against fresh clients; clients a scenario created are
 * disposed afterwards, so scenarios stay independent and resources are
 * reclaimed even on failure. A scenario "passes" by completing without
 * throwing; any thrown error is reported as that scenario's failure detail.
 */
export async function runEngineConformanceScenarios(
  subject: EngineConformanceSubject,
  names?: readonly ConformanceScenarioName[],
): Promise<EngineConformanceReport> {
  const requested = names ?? engineConformanceScenarioNames
  const results: ConformanceScenarioResult[] = []
  for (const name of requested) {
    results.push(await runEngineConformanceScenario(subject, name))
  }
  return {
    subject: subject.name,
    results,
    allPassed: results.every((result) => result.passed),
  }
}

/** Run a single scenario (see `runEngineConformanceScenarios` for semantics). */
export async function runEngineConformanceScenario(
  subject: EngineConformanceSubject,
  name: ConformanceScenarioName,
): Promise<ConformanceScenarioResult> {
  const scenario = scenarios[name]
  if (scenario === undefined) {
    return { name, passed: false, detail: `unknown scenario: ${name}`, facts: {} }
  }
  // Track the clients the scenario creates so they can be disposed afterwards
  // (a scenario failure must not leak engines into the next scenario).
  const createdClients: ConformanceEngineClient[] = []
  const trackedSubject: EngineConformanceSubject = {
    ...subject,
    createClient(): ConformanceEngineClient {
      const client = subject.createClient()
      createdClients.push(client)
      return client
    },
  }
  try {
    const facts = await scenario(trackedSubject)
    return { name, passed: true, detail: 'passed', facts }
  } catch (error) {
    return { name, passed: false, detail: errorMessage(error), facts: {} }
  } finally {
    for (const client of createdClients) {
      await client.dispose().catch(() => undefined)
    }
  }
}
