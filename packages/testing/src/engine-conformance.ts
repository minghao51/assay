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
 * Environments: the scenario functions are environment-neutral (no DOM, no
 * Node APIs); the subject adapter decides how files are staged (OPFS in the
 * browser, temp files in Node) and which SQL drives engine-specific paths.
 * The suite's own logic is unit-tested in Node against an in-memory fake
 * engine (`engine-conformance.test.ts`); real engines prove themselves by
 * running the same scenarios in their harness (engine-duckdb: Playwright e2e).
 */
import type { Table } from 'apache-arrow'

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
