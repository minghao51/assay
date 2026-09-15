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

/** A requested half-open row window `[startRow, endRow)`. */
export interface ConformanceWindow {
  readonly startRow: number
  readonly endRow: number
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
  rowCount(handle: ConformanceTableHandle): Promise<number>
  fetchRange(
    handle: ConformanceTableHandle,
    window: ConformanceWindow,
  ): Promise<ConformanceBatchResult>
  query(sql: string): Promise<ConformanceBatchResult>
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
