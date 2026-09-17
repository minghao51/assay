/**
 * Node-side proof of the data-engine conformance suite itself: the scenarios
 * run green against a *compliant in-memory fake engine* (proving the suite is
 * engine-agnostic and its logic sound), and each scenario detects a
 * deliberately non-compliant fake (proving the assertions bite). The
 * real-engine proof for engine-duckdb lives in the browser harness + e2e
 * (DuckDB-WASM cannot run under Node vitest).
 */
import {
  Bool,
  Field,
  Int64,
  List,
  Struct,
  Utf8,
  tableFromArrays,
  vectorFromArray,
} from 'apache-arrow'
import { describe, expect, it } from 'vitest'
import type { Table } from 'apache-arrow'
import {
  engineConformanceScenarioNames,
  normalizeArrowCell,
  runEngineConformanceScenario,
  runEngineConformanceScenarios,
} from './engine-conformance'
import type {
  ConformanceBatchResult,
  ConformanceCategoricalStats,
  ConformanceDatasetProfile,
  ConformanceEngineClient,
  ConformanceFileSource,
  ConformanceFilterSpec,
  ConformanceNumericStats,
  ConformanceScenarioName,
  ConformanceSortSpec,
  ConformanceTableHandle,
  ConformanceWindow,
  EngineConformanceSubject,
} from './engine-conformance'

/** Category-tagged errors so the fake can mirror the classification contract. */
class FakeOperationError extends Error {}
class FakeQueryError extends Error {}
class FakeDisposedError extends Error {}

/** Mutation knobs that make the fake non-compliant in one specific way. */
interface FakeMutations {
  /** createClient() returns an already-booted client (breaks laziness). */
  startReady?: boolean
  /** rowCount() lies about the total (breaks the lifecycle scenario). */
  rowCountDelta?: number
  /** Invalid windows resolve instead of rejecting. */
  acceptInvalidWindows?: boolean
  /** Oversized windows return everything instead of clamping to the cap. */
  ignoreWindowCap?: boolean
  /** Corrupt (shorter-than-good) bytes open successfully. */
  acceptCorruptFiles?: boolean
  /** Invalid SQL resolves instead of rejecting. */
  resolveFailingSql?: boolean
  /** Post-dispose rejections use a generic error, not the disposed category. */
  genericDisposeErrors?: boolean
  /** After the mid-stream failure the connection stays wedged. */
  wedgeAfterMidStreamFailure?: boolean
  /** m2-2: filtered windows silently ignore the filters (unfiltered rows). */
  ignoresFilters?: boolean
  /** m2-2: sorted windows silently ignore the sort (natural order). */
  ignoresSort?: boolean
  /** m2-2: filtered rowCount() lies with the unfiltered total. */
  liesAboutFilteredRowCount?: boolean
  /** m2-2: rejecting-filter probes resolve instead of rejecting. */
  resolvesRejectingFilters?: boolean
  /** m2-2: after a predicate error every later op fails (engine not reusable). */
  wedgedAfterPredicateError?: boolean
  /** m2-5: every nullCount is inflated by one. */
  liesAboutProfileNullCounts?: boolean
  /** m2-5: every distinctCount is inflated by one. */
  liesAboutProfileDistinctCounts?: boolean
  /** m2-5: the numeric mean is inflated by one. */
  liesAboutProfileNumericStats?: boolean
  /** m2-5: the categorical top-k is reversed (order contract broken). */
  liesAboutProfileTopK?: boolean
  /** m2-5: the first categorical column is misclassified as numeric (payload missing). */
  misclassifiesProfileKind?: boolean
  /** m2-5: profile() of an unknown handle resolves instead of rejecting. */
  profileUnknownHandleResolves?: boolean
  /** m3-1: the nested schema reports a degraded scalar type for the struct column. */
  liesAboutNestedSchemaType?: boolean
  /** m3-1: a nested struct leaf arrives corrupted (999 instead of the pinned value). */
  corruptsNestedValues?: boolean
  /** m3-1: nested windows report hasMore=true although the batch is complete. */
  liesAboutNestedHasMore?: boolean
}

const GOOD_DATASET = {
  rowCount: 5,
  columns: [
    { name: 'id', type: 'Int32', values: ['1', '2', '3', '4', '5'] },
    { name: 'label', type: 'Utf8', values: ['a', 'b', null, 'd', 'e'] },
    { name: 'note', type: 'Utf8' }, // no declared values (name-order assertion only)
  ],
}

const MAX_WINDOW_ROWS = 1000
const WIDE_ROW_COUNT = 1500
const FAILING_SQL = 'SELECT * FROM __no_such_table__'
const MID_STREAM_SQL = 'SELECT fail_after_first_batch()'
const SMOKE_SQL = 'SELECT 42 AS answer'
const SMOKE_VALUE = '42'

/**
 * m2-2 semantics the fake subject declares — consistent with the fake's own
 * filter/sort interpreter below (NULLs sort last in both directions).
 */
const WINDOW_SEMANTICS = [
  {
    label: 'filter id >= 3',
    filters: [{ column: 'id', predicate: '>= 3' }],
    expectColumn: 'id',
    expectValues: ['3', '4', '5'],
    expectRowCount: 3,
  },
  {
    label: 'sort label asc',
    sort: [{ column: 'label', direction: 'asc' }],
    expectColumn: 'label',
    expectValues: ['a', 'b', 'd', 'e', null],
    expectRowCount: 5,
  },
  {
    label: 'sort label desc',
    sort: [{ column: 'label', direction: 'desc' }],
    expectColumn: 'label',
    expectValues: ['e', 'd', 'b', 'a', null],
    expectRowCount: 5,
  },
  {
    label: 'filter label IS NOT NULL + sort label desc',
    filters: [{ column: 'label', predicate: 'IS NOT NULL' }],
    sort: [{ column: 'label', direction: 'desc' }],
    expectColumn: 'label',
    expectValues: ['e', 'd', 'b', 'a'],
    expectRowCount: 4,
  },
] as const

/** Filter probes that must reject: bad SQL text, unknown column, hostile identifier. */
const REJECTING_FILTERS = [
  { column: 'id', predicate: ')) FROM ( (' },
  { column: 'nosuchcol', predicate: '> 1' },
  { column: 'id" ; DROP TABLE logs; --', predicate: '> 1' },
] as const

/** Breakout probes: escape attempts whose outcome must be contained. */
const BREAKOUT_FILTERS = [
  { column: 'id', predicate: '>= 0; DELETE FROM logs' },
  { column: 'label', predicate: "= 'a' OR 1=1" }, // valid SQL — matches everything, harmlessly
] as const

/**
 * m2-5 profile dataset rows the fake stages as `profile.csv` — the same
 * shapes the DuckDB subject's runtime-built CSV covers (numeric with a null,
 * duplicate-heavy categoricals, a count tie, a nulls-only column).
 */
const PROFILE_ROWS: readonly {
  score: number | null
  label: string | null
  flag: string | null
  empty: string | null
  when: string | null
  tier: string | null
}[] = [
  { score: 10, label: 'alpha', flag: 'true', empty: null, when: '2025-01-01', tier: 'gold' },
  { score: 20, label: 'alpha', flag: 'false', empty: null, when: '2025-01-02', tier: 'silver' },
  { score: 30, label: 'beta', flag: 'true', empty: null, when: '2025-01-01', tier: 'gold' },
  { score: null, label: 'beta', flag: 'false', empty: null, when: '2025-01-02', tier: 'silver' },
  { score: 50, label: 'alpha', flag: 'true', empty: null, when: '2025-01-01', tier: 'bronze' },
]

/** How the fake classifies each profile-dataset column (its mini-classifier). */
const PROFILE_KINDS = {
  score: 'numeric',
  label: 'categorical',
  flag: 'categorical',
  empty: 'categorical',
  when: 'categorical',
  tier: 'categorical',
} as const

/**
 * The fake subject's exact profile expectations — hand-written literals
 * (independent of the fake's computation code, so mutation knobs can make
 * the two disagree), with the same values the DuckDB CLI pins for the
 * equivalent DuckDB CSV (the datasets are deliberately identical).
 */
const PROFILE_DATASET = {
  rowCount: 5,
  numericTolerance: 1e-9,
  columns: [
    {
      name: 'score',
      kind: 'numeric',
      nullCount: 1,
      distinctCount: 4,
      numeric: {
        min: 10,
        max: 50,
        mean: 27.5,
        stddev: 17.07825127659933,
        quantiles: { p50: 25, p90: 44, p95: 47, p99: 49.4 },
      },
    },
    {
      name: 'label',
      kind: 'categorical',
      nullCount: 0,
      distinctCount: 2,
      categorical: {
        topK: [
          { value: 'alpha', count: 3 },
          { value: 'beta', count: 2 },
        ],
      },
    },
    {
      name: 'flag',
      kind: 'categorical',
      nullCount: 0,
      distinctCount: 2,
      categorical: {
        topK: [
          { value: 'true', count: 3 },
          { value: 'false', count: 2 },
        ],
      },
    },
    {
      name: 'empty',
      kind: 'categorical',
      nullCount: 5,
      distinctCount: 0,
      categorical: { topK: [] },
    },
    {
      name: 'when',
      kind: 'categorical',
      nullCount: 0,
      distinctCount: 2,
      categorical: {
        topK: [
          { value: '2025-01-01', count: 3 },
          { value: '2025-01-02', count: 2 },
        ],
      },
    },
    {
      name: 'tier',
      kind: 'categorical',
      nullCount: 0,
      distinctCount: 3,
      // gold/silver tie at count 2 — pinned value-ascending order.
      categorical: {
        topK: [
          { value: 'gold', count: 2 },
          { value: 'silver', count: 2 },
          { value: 'bronze', count: 1 },
        ],
      },
    },
  ],
} as const

/**
 * m3-1 nested dataset the fake subject declares — the same shapes the DuckDB
 * subject pins over `fixtures/jsonl/nested.jsonl`, in miniature: struct-of-
 * struct with a NULL leaf, NULL struct, empty/NULL lists of scalars, a
 * list-of-structs with NULL fields and a NULL element, 64-bit integers, and
 * the quoting-hostile key. Declared independently of the fake's builder rows
 * below, so a mutation knob can make the two disagree.
 */
const NESTED_DATASET = {
  rowCount: 4,
  schema: [
    { name: 'id', type: 'BIGINT' },
    { name: 'deep', type: 'STRUCT(a STRUCT(b STRUCT(c BIGINT)))' },
    { name: 'tags', type: 'VARCHAR[]' },
    { name: 'events', type: 'STRUCT("at" TIMESTAMP, ok BOOLEAN)[]' },
    { name: 'weird "quoted" key', type: 'BIGINT' },
  ],
  columns: [
    { name: 'id', values: [1, 2, 3, 4] },
    {
      name: 'deep',
      values: [{ a: { b: { c: 1 } } }, null, { a: { b: { c: null } } }, { a: { b: { c: 4 } } }],
    },
    { name: 'tags', values: [['x', null], [], null, ['solo']] },
    {
      name: 'events',
      values: [
        [{ at: 1740823200000, ok: true }, null],
        [{ at: 1740906000000, ok: null }],
        null,
        [{ at: 1741071600000, ok: false }],
      ],
    },
    { name: 'weird "quoted" key', values: [1, 2, 3, 4] },
  ],
  // Rows [1, 3): a NULL struct + a struct-with-NULL-fields event; both null-
  // list shapes.
  offsetWindow: { startRow: 1, endRow: 3 },
} as const

/** Explicit Arrow types for the fake's nested columns (nulls-rich shapes). */
const NESTED_DEEP_TYPE = new Struct([
  new Field('a', new Struct([new Field('b', new Struct([new Field('c', new Int64())]))])),
])
const NESTED_TAGS_TYPE = new List(new Field('tag', new Utf8(), true))
const NESTED_EVENTS_TYPE = new List(
  new Field(
    'event',
    new Struct([new Field('at', new Int64(), true), new Field('ok', new Bool(), true)]),
    true,
  ),
)

/** One in-memory row of the fake's nested dataset. */
interface FakeNestedRow {
  id: bigint
  deep: { a: { b: { c: bigint | null } } } | null
  tags: readonly (string | null)[] | null
  events: readonly ({ at: bigint | null; ok: boolean | null } | null)[] | null
  quoted: bigint
}

/** The fake's nested dataset in natural order (mirrors NESTED_DATASET). */
function nestedRows(corruptDeepLeaf = false): FakeNestedRow[] {
  const rows: FakeNestedRow[] = [
    {
      id: 1n,
      deep: { a: { b: { c: 1n } } },
      tags: ['x', null],
      events: [{ at: 1740823200000n, ok: true }, null],
      quoted: 1n,
    },
    {
      id: 2n,
      deep: null,
      tags: [],
      events: [{ at: 1740906000000n, ok: null }],
      quoted: 2n,
    },
    {
      id: 3n,
      deep: { a: { b: { c: null } } },
      tags: null,
      events: null,
      quoted: 3n,
    },
    {
      id: 4n,
      deep: { a: { b: { c: 4n } } },
      tags: ['solo'],
      events: [{ at: 1741071600000n, ok: false }],
      quoted: 4n,
    },
  ]
  if (corruptDeepLeaf) {
    rows[0] = { ...rows[0]!, deep: { a: { b: { c: 999n } } } }
  }
  return rows
}

/**
 * apache-arrow 17's `tableFromArrays` passes Vector columns through at
 * runtime (vectorFromArray returns them unchanged); its declared input type
 * omits Vector, so each vector is cast to the declared array arm.
 */
function asArrowColumn(vector: unknown): readonly unknown[] {
  return vector as readonly unknown[]
}

/** The fake's nested dataset as an Arrow table (declared order, NULL-safe). */
function nestedTable(start: number, end: number, corruptDeepLeaf = false): Table {
  const rows = nestedRows(corruptDeepLeaf).slice(start, end)
  return tableFromArrays({
    id: asArrowColumn(
      vectorFromArray(
        rows.map((row) => row.id),
        new Int64(),
      ),
    ),
    deep: asArrowColumn(
      vectorFromArray(
        rows.map((row) => row.deep),
        NESTED_DEEP_TYPE,
      ),
    ),
    tags: asArrowColumn(
      vectorFromArray(
        rows.map((row) => row.tags),
        NESTED_TAGS_TYPE,
      ),
    ),
    events: asArrowColumn(
      vectorFromArray(
        rows.map((row) => row.events),
        NESTED_EVENTS_TYPE,
      ),
    ),
    'weird "quoted" key': asArrowColumn(
      vectorFromArray(
        rows.map((row) => row.quoted),
        new Int64(),
      ),
    ),
  })
}

/** One in-memory row of the fake's good dataset. */
interface FakeRow {
  id: number
  label: string | null
  note: string
}

/** Mutable staging state shared between the fake subject and its clients. */
const subjectState = {
  staged: new Map<string, Uint8Array>(),
  goodBytes: new Uint8Array([80, 65, 82, 49, 1, 2, 3, 4]), // "PAR1" + payload
}

/**
 * In-memory fake engine that satisfies the *contract* the suite asserts:
 * lazy boot, classified errors, window clamping, Arrow batches (NULL-safe,
 * declared column order), registry rollback for corrupt bytes, and
 * post-mid-stream-failure reusability.
 */
class FakeEngineClient implements ConformanceEngineClient {
  status = 'idle'
  private nextTableId = 1
  /** tableId → staged file name for successfully opened tables. */
  private readonly registered = new Map<string, string>()
  private midStreamFailed = false
  /** Set by `wedgedAfterPredicateError`: a predicate error poisons the engine. */
  private predicateErrorSeen = false

  constructor(private readonly mutations: FakeMutations) {}

  async ensureReady(): Promise<unknown> {
    if (this.status === 'disposed') throw new FakeDisposedError('engine client was disposed')
    this.status = 'ready'
    return { version: 'fake-1.0.0' }
  }

  async open(source: ConformanceFileSource): Promise<ConformanceTableHandle> {
    await this.ensureReady()
    if (!/\.(parquet|csv|jsonl)$/.test(source.name)) {
      throw new FakeOperationError('unsupported dataset format')
    }
    const bytes = subjectState.staged.get(source.name)
    if (bytes === undefined) {
      throw new FakeOperationError('staged file missing')
    }
    // The suite corrupts by truncation, so "shorter than the good bytes" is
    // the fake's stand-in for "unreadable at view-bind time" — the fake rolls
    // the open back (nothing is registered) exactly like a compliant engine.
    if (!this.mutations.acceptCorruptFiles && bytes.length < subjectState.goodBytes.length) {
      throw new FakeOperationError('no magic bytes at end of file')
    }
    const tableId = `fake-t${this.nextTableId++}`
    this.registered.set(tableId, source.name)
    return { kind: 'table', id: tableId }
  }

  async schema(handle: ConformanceTableHandle): Promise<readonly { name: string; type: string }[]> {
    this.requireRegistered(handle)
    if (this.isProfile(handle)) {
      return Object.entries(PROFILE_KINDS).map(([name, kind]) => ({
        name,
        type: kind === 'numeric' ? 'BIGINT' : 'VARCHAR',
      }))
    }
    if (this.isNested(handle)) {
      return NESTED_DATASET.schema.map((column) => ({
        name: column.name,
        type:
          this.mutations.liesAboutNestedSchemaType && column.name === 'deep'
            ? 'BIGINT'
            : column.type,
      }))
    }
    return GOOD_DATASET.columns.map((column) => ({ name: column.name, type: column.type }))
  }

  async rowCount(
    handle: ConformanceTableHandle,
    options?: { readonly filters?: readonly ConformanceFilterSpec[] },
  ): Promise<number> {
    this.requireRegistered(handle)
    if (this.mutations.wedgedAfterPredicateError && this.predicateErrorSeen) {
      throw new FakeQueryError('connection wedged after predicate error')
    }
    const base = this.isWide(handle)
      ? WIDE_ROW_COUNT
      : this.isNested(handle)
        ? NESTED_DATASET.rowCount
        : GOOD_DATASET.rowCount
    if (options?.filters === undefined || options.filters.length === 0) {
      return base + (this.mutations.rowCountDelta ?? 0)
    }
    if (this.mutations.liesAboutFilteredRowCount) {
      return base + (this.mutations.rowCountDelta ?? 0)
    }
    return this.applyFilters(datasetRows(), options.filters).length
  }

  async fetchRange(
    handle: ConformanceTableHandle,
    window: ConformanceWindow,
  ): Promise<ConformanceBatchResult> {
    this.requireRegistered(handle)
    if (this.mutations.wedgedAfterPredicateError && this.predicateErrorSeen) {
      throw new FakeQueryError('connection wedged after predicate error')
    }
    if (
      !isRowIndex(window.startRow) ||
      !isRowIndex(window.endRow) ||
      window.endRow < window.startRow
    ) {
      if (this.mutations.acceptInvalidWindows) {
        return { batch: emptyGoodTable(), hasMore: false }
      }
      throw new FakeOperationError('invalid row window')
    }
    const cap = this.mutations.ignoreWindowCap ? Number.MAX_SAFE_INTEGER : MAX_WINDOW_ROWS
    const end = Math.min(window.endRow, window.startRow + cap)
    if (this.isWide(handle)) {
      const ids = Array.from({ length: WIDE_ROW_COUNT }, (_, i) => i)
      return { batch: wideTable(ids.slice(window.startRow, end)), hasMore: false }
    }
    if (this.isNested(handle)) {
      return {
        batch: nestedTable(window.startRow, end, this.mutations.corruptsNestedValues === true),
        hasMore: this.mutations.liesAboutNestedHasMore === true,
      }
    }
    // m2-2: apply filters (AND), then sort (multi-key, NULLs last), then window.
    let rows = datasetRows()
    const filters = window.filters ?? []
    if (filters.length > 0 && !this.mutations.ignoresFilters) {
      try {
        rows = this.applyFilters(rows, filters)
      } catch (error) {
        if (this.mutations.resolvesRejectingFilters) {
          rows = datasetRows() // silently ignores the bad filter
        } else {
          this.predicateErrorSeen = true
          throw error
        }
      }
    }
    const sort = window.sort ?? []
    if (sort.length > 0 && !this.mutations.ignoresSort) {
      rows = this.applySort(rows, sort)
    }
    return { batch: rowsToTable(rows.slice(window.startRow, end)), hasMore: false }
  }

  async query(sql: string): Promise<ConformanceBatchResult> {
    await this.ensureReady()
    if (sql === FAILING_SQL) {
      if (this.mutations.resolveFailingSql) return { batch: wideTable([1]), hasMore: false }
      throw new FakeQueryError('Parser Error')
    }
    if (sql === MID_STREAM_SQL) {
      // Contract stand-in: the first batch succeeded (invisible at this API
      // level — the real engine's first-batch-ok is proven in the browser
      // e2e); the stream then failed. The fake models the observable part:
      // rejection as a query error + the reusability (or wedge) that follows.
      this.midStreamFailed = true
      throw new FakeQueryError('mid-stream failure')
    }
    if (sql === SMOKE_SQL) {
      if (this.mutations.wedgeAfterMidStreamFailure && this.midStreamFailed) {
        throw new FakeQueryError('connection wedged')
      }
      return { batch: tableFromArrays({ answer: [SMOKE_VALUE] }), hasMore: false }
    }
    throw new FakeQueryError('unknown SQL')
  }

  /**
   * m2-5: computes the profile from the fake's in-memory rows (the fake's
   * mini-engine), over the profile dataset for `profile.csv` opens and over
   * the good dataset otherwise — with the mutation knobs free to lie.
   */
  async profile(handle: ConformanceTableHandle): Promise<ConformanceDatasetProfile> {
    if (this.status === 'disposed') {
      if (this.mutations.genericDisposeErrors) throw new Error('client already closed')
      throw new FakeDisposedError('engine client was disposed')
    }
    if (!this.registered.has(handle.id)) {
      if (this.mutations.profileUnknownHandleResolves) {
        return { rowCount: 0, columns: [] }
      }
      throw new FakeOperationError(`unknown table handle: ${handle.id}`)
    }
    if (this.mutations.wedgedAfterPredicateError && this.predicateErrorSeen) {
      throw new FakeQueryError('connection wedged after predicate error')
    }
    const rows = this.isProfile(handle)
      ? PROFILE_ROWS
      : datasetRows().map((row) => ({ id: row.id, label: row.label, note: row.note }))
    const kinds = this.isProfile(handle)
      ? PROFILE_KINDS
      : ({ id: 'numeric', label: 'categorical', note: 'categorical' } as const)
    return { rowCount: rows.length, columns: computeFakeProfile(rows, kinds, this.mutations) }
  }

  async dispose(): Promise<void> {
    this.status = 'disposed'
    this.registered.clear()
  }

  /** The fake subject's registry probe reads the live set (same class). */
  registeredCount(): number {
    return this.registered.size
  }

  private isWide(handle: ConformanceTableHandle): boolean {
    return this.registered.get(handle.id) === 'wide.csv'
  }

  private isNested(handle: ConformanceTableHandle): boolean {
    return this.registered.get(handle.id) === 'nested.jsonl'
  }

  private isProfile(handle: ConformanceTableHandle): boolean {
    return this.registered.get(handle.id) === 'profile.csv'
  }

  /** Typed column read: `undefined` means the column does not exist. */
  private columnValue(row: FakeRow, column: string): number | string | null | undefined {
    switch (column) {
      case 'id':
        return row.id
      case 'label':
        return row.label
      case 'note':
        return row.note
      default:
        return undefined
    }
  }

  /** AND-composition of the fake's tiny predicate language (see below). */
  private applyFilters(
    rows: readonly FakeRow[],
    filters: readonly ConformanceFilterSpec[],
  ): FakeRow[] {
    return rows.filter((row) =>
      filters.every((filter) => {
        const value = this.columnValue(row, filter.column)
        if (value === undefined) {
          // Unknown column — a binder-style error, classified as a query error.
          throw new FakeQueryError(`Binder Error: no such column ${filter.column}`)
        }
        return fakePredicateMatches(value, filter.predicate)
      }),
    )
  }

  /** Multi-key sort, later keys first (stable), NULLs last — like DuckDB. */
  private applySort(rows: readonly FakeRow[], sort: readonly ConformanceSortSpec[]): FakeRow[] {
    const sorted = [...rows]
    for (let index = sort.length - 1; index >= 0; index--) {
      const key = sort[index]!
      const factor = key.direction === 'desc' ? -1 : 1
      sorted.sort((a, b) => {
        const va = this.columnValue(a, key.column)
        const vb = this.columnValue(b, key.column)
        if (va === undefined || vb === undefined) return 0 // unknown column: keep order
        if (va === null) return vb === null ? 0 : 1
        if (vb === null) return -1
        if (va === vb) return 0
        return va < vb ? factor * -1 : factor
      })
    }
    return sorted
  }

  private requireRegistered(handle: ConformanceTableHandle): void {
    if (this.status === 'disposed') {
      if (this.mutations.genericDisposeErrors) {
        throw new Error('client already closed')
      }
      throw new FakeDisposedError('engine client was disposed')
    }
    if (!this.registered.has(handle.id)) {
      throw new FakeOperationError(`unknown table handle: ${handle.id}`)
    }
  }
}

function isRowIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** quantile_cont semantics on a pre-sorted list (linear interpolation). */
function quantileCont(sorted: readonly number[], q: number): number {
  const position = (sorted.length - 1) * q
  const lower = Math.floor(position)
  const upper = Math.min(lower + 1, sorted.length - 1)
  return sorted[lower]! + (position - lower) * (sorted[upper]! - sorted[lower]!)
}

/** Sample standard deviation (n−1); null under 2 values — the contract. */
function sampleStddev(values: readonly number[]): number | null {
  if (values.length < 2) return null
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

/** Top-k ordering contract: count descending, ties by value ascending. */
function topKOf(values: readonly string[]): { value: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
}

/**
 * The fake's mini profile engine: computes each column's stats from raw rows
 * (honest by default; mutation knobs make it lie in exactly one way).
 */
function computeFakeProfile(
  rows: readonly Record<string, number | string | null>[],
  kinds: Record<string, 'numeric' | 'categorical'>,
  mutations: FakeMutations,
): ConformanceDatasetProfile['columns'] {
  return Object.entries(kinds).map(([name, kind]) => {
    const values = rows.map((row) => row[name] ?? null)
    const nonNull = values.filter((value) => value !== null)
    // Built mutable first (mutation knobs may rewrite kind/payload), then
    // returned as the read-only conformance shape.
    const column: {
      name: string
      type: string
      kind: 'numeric' | 'categorical'
      nullCount: number
      distinctCount: number
      numeric?: ConformanceNumericStats
      categorical?: ConformanceCategoricalStats
    } = {
      name,
      type: kind === 'numeric' ? 'BIGINT' : 'VARCHAR',
      kind,
      nullCount: values.length - nonNull.length + (mutations.liesAboutProfileNullCounts ? 1 : 0),
      distinctCount:
        new Set(nonNull.map(String)).size + (mutations.liesAboutProfileDistinctCounts ? 1 : 0),
    }
    if (kind === 'numeric') {
      const numbers = nonNull.map(Number)
      const sorted = [...numbers].sort((a, b) => a - b)
      const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length
      column.numeric = {
        min: sorted[0] ?? null,
        max: sorted[sorted.length - 1] ?? null,
        mean: mean + (mutations.liesAboutProfileNumericStats ? 1 : 0),
        stddev: sampleStddev(numbers),
        quantiles: {
          p50: sorted.length > 0 ? quantileCont(sorted, 0.5) : null,
          p90: sorted.length > 0 ? quantileCont(sorted, 0.9) : null,
          p95: sorted.length > 0 ? quantileCont(sorted, 0.95) : null,
          p99: sorted.length > 0 ? quantileCont(sorted, 0.99) : null,
        },
      }
    } else {
      let topK = topKOf(nonNull.map(String))
      if (mutations.liesAboutProfileTopK) topK = [...topK].reverse()
      column.categorical = { topK }
    }
    if (mutations.misclassifiesProfileKind && name === 'label') {
      // Break the kind contract: flip the kind and drop the payload.
      column.kind = 'numeric'
      delete column.categorical
    }
    return column
  })
}

/** The fake's good dataset in natural order. */
function datasetRows(): FakeRow[] {
  const ids = GOOD_DATASET.columns[0]!.values!
  const labels = GOOD_DATASET.columns[1]!.values!
  return ids.map((id, index) => ({
    id: Number(id),
    label: labels[index] ?? null,
    note: `note-${String(index)}`,
  }))
}

/** The fake's tiny predicate language (fake stand-in for engine SQL). */
function fakePredicateMatches(value: unknown, predicate: string): boolean {
  if (predicate === 'IS NOT NULL') return value !== null
  // A valid-but-broad probe the breakout scenario tolerates (harmless match-all).
  const matchAll = /^=\s*'[^']*'\s+OR\s+1\s*=\s*1$/.exec(predicate)
  if (matchAll !== null) return true
  const comparison = /^(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(predicate)
  if (comparison === null) {
    throw new FakeQueryError('Parser Error: fake cannot interpret predicate')
  }
  if (typeof value !== 'number') return false // NULL never matches a comparison
  const operand = Number(comparison[2])
  switch (comparison[1]) {
    case '>=':
      return value >= operand
    case '<=':
      return value <= operand
    case '>':
      return value > operand
    case '<':
      return value < operand
    default:
      throw new FakeQueryError('Parser Error: fake cannot interpret predicate')
  }
}

/** The fake's good dataset as an Arrow table (declared column order, NULL-safe). */
function goodTable(start: number, end: number): Table {
  return rowsToTable(datasetRows().slice(start, end))
}

function rowsToTable(rows: readonly FakeRow[]): Table {
  return tableFromArrays({
    id: Int32Array.from(rows.map((row) => row.id)),
    label: rows.map((row) => row.label),
    note: rows.map((row) => row.note),
  })
}

function emptyGoodTable(): Table {
  return goodTable(0, 0)
}

function wideTable(ids: readonly number[]): Table {
  return tableFromArrays({ id: Int32Array.from(ids) })
}

function makeSubject(mutations: FakeMutations = {}): EngineConformanceSubject {
  subjectState.staged.clear()
  return {
    name: 'fake-engine',
    createClient: () => {
      const client = new FakeEngineClient(mutations)
      if (mutations.startReady) void client.ensureReady()
      return client
    },
    isIdle: (client) => client.status === 'idle',
    isReady: (client) => client.status === 'ready',
    errors: {
      operation: (error) => error instanceof FakeOperationError,
      query: (error) => error instanceof FakeQueryError,
      disposed: (error) => error instanceof FakeDisposedError,
    },
    dataset: GOOD_DATASET,
    maxWindowRows: MAX_WINDOW_ROWS,
    wideRowCount: WIDE_ROW_COUNT,
    stageGoodFile: async () => {
      const name = 'good.parquet'
      subjectState.staged.set(name, subjectState.goodBytes)
      return fileSource(name)
    },
    stageWideFile: async () => {
      const name = 'wide.csv'
      // Length is the fake's readability stand-in; content is irrelevant.
      subjectState.staged.set(name, new Uint8Array(WIDE_ROW_COUNT))
      return fileSource(name)
    },
    stageProfileFile: async () => {
      const name = 'profile.csv'
      // The fake computes profiles from its in-memory PROFILE_ROWS; the
      // staged bytes only matter for open-time readability checks.
      subjectState.staged.set(name, subjectState.goodBytes)
      return fileSource(name)
    },
    stageNestedFile: async () => {
      const name = 'nested.jsonl'
      // The fake serves nested windows from its in-memory nestedRows(); the
      // staged bytes only matter for open-time readability checks.
      subjectState.staged.set(name, subjectState.goodBytes)
      return fileSource(name)
    },
    nestedDataset: NESTED_DATASET,
    goodParquetBytes: async () => subjectState.goodBytes,
    stageBytes: async (bytes, name) => {
      subjectState.staged.set(name, bytes)
      return fileSource(name)
    },
    failingSql: () => FAILING_SQL,
    midStreamFailureSql: () => MID_STREAM_SQL,
    smokeSql: () => SMOKE_SQL,
    smokeSqlValue: SMOKE_VALUE,
    registeredTableCount: async (client) =>
      client instanceof FakeEngineClient ? client.registeredCount() : null,
    windowSemantics: WINDOW_SEMANTICS,
    profileDataset: PROFILE_DATASET,
    rejectingFilters: REJECTING_FILTERS,
    breakoutFilters: BREAKOUT_FILTERS,
  }
}

function fileSource(name: string): ConformanceFileSource {
  return { name, getFile: () => Promise.resolve({}) }
}

async function runOne(
  mutations: FakeMutations,
  name: ConformanceScenarioName,
): Promise<{ passed: boolean; detail: string }> {
  const result = await runEngineConformanceScenario(makeSubject(mutations), name)
  return { passed: result.passed, detail: result.detail }
}

describe('engine conformance suite (compliant fake engine)', () => {
  it('runs every scenario green against a contract-compliant in-memory engine', async () => {
    const report = await runEngineConformanceScenarios(makeSubject())
    expect(report.subject).toBe('fake-engine')
    expect(report.results.map((result) => result.name)).toEqual([...engineConformanceScenarioNames])
    expect(report.allPassed, JSON.stringify(report.results, null, 2)).toBe(true)
    for (const result of report.results) {
      expect(result.detail).toBe('passed')
      expect(Object.keys(result.facts).length).toBeGreaterThan(0)
    }
  })

  it('exposes scenario-level evidence (clamped rows, registry counts, follow-up value)', async () => {
    const subject = makeSubject()
    const clamping = await runEngineConformanceScenario(subject, 'window-clamping')
    expect(clamping.facts['clampedRows']).toBe(MAX_WINDOW_ROWS)
    expect(clamping.facts['tailRows']).toBe(3)
    const rollback = await runEngineConformanceScenario(subject, 'corrupt-file-rollback')
    expect(rollback.facts['registeredAfterFailedOpen']).toBe(0)
    expect(rollback.facts['registeredAfterGoodOpen']).toBe(1)
    const midStream = await runEngineConformanceScenario(subject, 'mid-stream-error-reuse')
    expect(midStream.facts['followUpValue']).toBe(SMOKE_VALUE)
  })

  it('exposes nested-fidelity evidence (schema columns, window cells, clamp rows)', async () => {
    const subject = makeSubject()
    const schema = await runEngineConformanceScenario(subject, 'nested-schema-fidelity')
    expect(schema.facts['schemaColumns']).toBe(NESTED_DATASET.schema.length)
    expect(schema.facts['rowCount']).toBe(NESTED_DATASET.rowCount)
    const fidelity = await runEngineConformanceScenario(subject, 'nested-window-fidelity')
    expect(fidelity.facts['columns']).toBe(NESTED_DATASET.columns.length)
    expect(fidelity.facts['rows']).toBe(4)
    expect(fidelity.facts['cells']).toBe(NESTED_DATASET.columns.length * 4)
    const clamp = await runEngineConformanceScenario(subject, 'nested-window-clamp')
    expect(clamp.facts['oversizedRows']).toBe(NESTED_DATASET.rowCount)
    expect(clamp.facts['offsetRows']).toBe(2)
    expect(clamp.facts['invalidRejected']).toBe(3)
  })
})

describe('engine conformance suite (detects non-compliant engines)', () => {
  it('lazy-boot: detects a client that boots on construction', async () => {
    const { passed, detail } = await runOne({ startReady: true }, 'lazy-boot')
    expect(passed).toBe(false)
    expect(detail).toContain('idle')
  })

  it('file-lifecycle: detects a lying rowCount', async () => {
    const { passed, detail } = await runOne({ rowCountDelta: 1 }, 'file-lifecycle')
    expect(passed).toBe(false)
    expect(detail).toContain('rowCount')
  })

  it('file-lifecycle: detects post-dispose rejections outside the disposed category', async () => {
    const { passed, detail } = await runOne({ genericDisposeErrors: true }, 'file-lifecycle')
    expect(passed).toBe(false)
    expect(detail).toContain('disposed error category')
  })

  it('error-classes: detects swallowed query errors', async () => {
    const { passed, detail } = await runOne({ resolveFailingSql: true }, 'error-classes')
    expect(passed).toBe(false)
    expect(detail).toContain('invalid SQL must reject')
  })

  it('window-clamping: detects a missing window cap', async () => {
    const { passed, detail } = await runOne({ ignoreWindowCap: true }, 'window-clamping')
    expect(passed).toBe(false)
    expect(detail).toContain('clamped to the window cap')
  })

  it('window-clamping: detects invalid windows resolving instead of rejecting', async () => {
    const { passed, detail } = await runOne({ acceptInvalidWindows: true }, 'window-clamping')
    expect(passed).toBe(false)
    expect(detail).toContain('invalid window')
  })

  it('arrow-shape: detects a batch whose columns are shuffled', async () => {
    // The fake always serves the declared column order, so a subject whose
    // declared order differs must make the scenario fail on field 0.
    const subject = makeSubject()
    const mismatched: EngineConformanceSubject = {
      ...subject,
      dataset: {
        rowCount: GOOD_DATASET.rowCount,
        columns: [GOOD_DATASET.columns[1]!, GOOD_DATASET.columns[0]!, GOOD_DATASET.columns[2]!],
      },
    }
    const result = await runEngineConformanceScenario(mismatched, 'arrow-shape')
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('Arrow field 0 name')
  })

  it('corrupt-file-rollback: detects engines that keep corrupt registrations', async () => {
    const { passed, detail } = await runOne({ acceptCorruptFiles: true }, 'corrupt-file-rollback')
    expect(passed).toBe(false)
    expect(detail).toContain('corrupt Parquet must reject')
  })

  it('mid-stream-error-reuse: detects a connection that stays wedged after cleanup', async () => {
    const { passed, detail } = await runOne(
      { wedgeAfterMidStreamFailure: true },
      'mid-stream-error-reuse',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('follow-up query')
  })

  it('window-filter-sort: detects filtered windows that ignore the filters', async () => {
    const { passed, detail } = await runOne({ ignoresFilters: true }, 'window-filter-sort')
    expect(passed).toBe(false)
    expect(detail).toContain('matching row count')
  })

  it('window-filter-sort: detects filtered rowCount that ignores the filters', async () => {
    const { passed, detail } = await runOne(
      { liesAboutFilteredRowCount: true },
      'window-filter-sort',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('filtered rowCount')
  })

  it('window-filter-sort: detects sorted windows that ignore the sort', async () => {
    const { passed, detail } = await runOne({ ignoresSort: true }, 'window-filter-sort')
    expect(passed).toBe(false)
    expect(detail).toContain('label[2]') // first natural-vs-sorted divergence
  })

  it('predicate-error-reuse: detects probes that resolve instead of rejecting', async () => {
    const { passed, detail } = await runOne(
      { resolvesRejectingFilters: true },
      'predicate-error-reuse',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('must reject, not resolve')
  })

  it('predicate-error-reuse: detects an engine that stops answering after a predicate error', async () => {
    const { passed, detail } = await runOne(
      { wedgedAfterPredicateError: true },
      'predicate-error-reuse',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('wedged') // the final anchor window can no longer be served
  })

  it('profile-semantics: detects inflated nullCounts', async () => {
    const { passed, detail } = await runOne(
      { liesAboutProfileNullCounts: true },
      'profile-semantics',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('nullCount')
  })

  it('profile-semantics: detects inflated distinctCounts', async () => {
    const { passed, detail } = await runOne(
      { liesAboutProfileDistinctCounts: true },
      'profile-semantics',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('distinctCount')
  })

  it('profile-semantics: detects a lying numeric mean', async () => {
    const { passed, detail } = await runOne(
      { liesAboutProfileNumericStats: true },
      'profile-semantics',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('mean')
  })

  it('profile-semantics: detects a reversed top-k order', async () => {
    const { passed, detail } = await runOne({ liesAboutProfileTopK: true }, 'profile-semantics')
    expect(passed).toBe(false)
    expect(detail).toContain('top-k')
  })

  it('profile-semantics: detects a misclassified column kind (payload contract broken)', async () => {
    const { passed, detail } = await runOne({ misclassifiesProfileKind: true }, 'profile-semantics')
    expect(passed).toBe(false)
    expect(detail).toContain('kind')
  })

  it('profile-semantics: detects profile() of an unknown handle resolving', async () => {
    const { passed, detail } = await runOne(
      { profileUnknownHandleResolves: true },
      'profile-semantics',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('must reject')
  })

  it('nested-schema-fidelity: detects a degraded nested type string', async () => {
    const { passed, detail } = await runOne(
      { liesAboutNestedSchemaType: true },
      'nested-schema-fidelity',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('column 1 type') // the `deep` struct column
  })

  it('nested-window-fidelity: detects a corrupted nested struct leaf', async () => {
    const { passed, detail } = await runOne(
      { corruptsNestedValues: true },
      'nested-window-fidelity',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('deep[0]')
  })

  it('nested-window-fidelity: detects a dishonest hasMore on a complete batch', async () => {
    const { passed, detail } = await runOne(
      { liesAboutNestedHasMore: true },
      'nested-window-fidelity',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('hasMore')
  })

  it('nested-window-clamp: detects a dishonest hasMore on the clamped window', async () => {
    const { passed, detail } = await runOne({ liesAboutNestedHasMore: true }, 'nested-window-clamp')
    expect(passed).toBe(false)
    expect(detail).toContain('hasMore on the clamped nested window')
  })

  it('nested-window-clamp: detects invalid windows resolving with nested columns present', async () => {
    const { passed, detail } = await runOne({ acceptInvalidWindows: true }, 'nested-window-clamp')
    expect(passed).toBe(false)
    expect(detail).toContain('invalid window')
  })
})

describe('normalizeArrowCell (m3-1 nested-fidelity traversal)', () => {
  it('normalizes scalars, bigints, records, vectors, and NULL at every depth', () => {
    expect(normalizeArrowCell(null)).toBe(null)
    expect(normalizeArrowCell(undefined)).toBe(null)
    expect(normalizeArrowCell(42)).toBe(42)
    expect(normalizeArrowCell('s')).toBe('s')
    expect(normalizeArrowCell(true)).toBe(true)
    expect(normalizeArrowCell(10n)).toBe(10)
    // Records (struct cells) recurse field-by-field.
    expect(normalizeArrowCell({ a: { b: { c: 1n } } })).toEqual({ a: { b: { c: 1 } } })
    expect(normalizeArrowCell({ src: null, ver: 3n })).toEqual({ src: null, ver: 3 })
    // Vectors (list cells) read position-by-position through the vector API.
    const ints = vectorFromArray([1n, null, 3n], new Int64())
    expect(normalizeArrowCell(ints)).toEqual([1, null, 3])
    const words = vectorFromArray(['x', null], new Utf8())
    expect(normalizeArrowCell(words)).toEqual(['x', null])
    // A full nested combination.
    const table = tableFromArrays({
      deep: asArrowColumn(vectorFromArray([{ a: { b: { c: 1n } } }, null], NESTED_DEEP_TYPE)),
      tags: asArrowColumn(vectorFromArray([['x', null], []], NESTED_TAGS_TYPE)),
      events: asArrowColumn(
        vectorFromArray([[{ at: 1740823200000n, ok: true }, null], null], NESTED_EVENTS_TYPE),
      ),
    })
    expect(normalizeArrowCell(table.getChildAt(0)!.get(0))).toEqual({ a: { b: { c: 1 } } })
    expect(normalizeArrowCell(table.getChildAt(0)!.get(1))).toBe(null)
    expect(normalizeArrowCell(table.getChildAt(1)!.get(0))).toEqual(['x', null])
    expect(normalizeArrowCell(table.getChildAt(1)!.get(1))).toEqual([])
    expect(normalizeArrowCell(table.getChildAt(2)!.get(0))).toEqual([
      { at: 1740823200000, ok: true },
      null,
    ])
    expect(normalizeArrowCell(table.getChildAt(2)!.get(1))).toBe(null)
  })

  it('fails loudly instead of losing precision or papering over odd shapes', () => {
    // Beyond safe-integer range: a silent Number() could compare equal to a
    // different value — the fidelity contract demands failure, not guessing.
    expect(() => normalizeArrowCell(9007199254740993n)).toThrow(/safe-integer/)
    expect(() => normalizeArrowCell(new Uint8Array([1, 2, 3]))).toThrow(/typed-array/)
    expect(() => normalizeArrowCell(Symbol.iterator as unknown as symbol)).toThrow(
      /unexpected Arrow cell shape/,
    )
  })
})
