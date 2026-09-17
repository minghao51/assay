/**
 * The engine-duckdb adapter for the data-engine conformance suite in
 * `@assay/testing` (T1; docs/engineering/05-repository-structure.md §4).
 *
 * Dependency direction: implementations import the testing package — never
 * the reverse — so the suite stays engine-agnostic and a later engine
 * (engine-parquet) can run the same scenarios by providing its own subject.
 *
 * Host-specific behavior lives here, not in the suite:
 * - staging: good fixture, runtime-built wide CSV, and suite-corrupted bytes
 *   are staged into the origin's OPFS sandbox (ADR 0017 disposable-cache
 *   framing) and opened through their genuine FileSystemFileHandle — the
 *   same trick as the M1-4 sections of `main.ts`.
 * - SQL hooks: DuckDB-specific queries for the error, smoke, registry-probe,
 *   and mid-stream-failure scenarios.
 *
 * Privacy (ADR 0001/0025): details and facts produced here contain ids,
 * counts, and flags — never dataset contents or file names.
 */
import {
  DuckDbEngineClient,
  EngineDisposedError,
  EngineOperationError,
  EngineQueryError,
  MAX_RANGE_ROWS,
} from '../src/index'
import type {
  ConformanceBatchResult,
  ConformanceEngineClient,
  ConformanceErrorMatchers,
  ConformanceFileSource,
  ConformanceNestedDataset,
  EngineConformanceSubject,
} from '@assay/testing'

/** The customers.parquet golden fixture, as the DuckDB DESCRIBE reports it. */
const GOOD_DATASET = {
  rowCount: 5,
  columns: [
    { name: 'customer_id', type: 'BIGINT', values: ['1', '2', '3', '4', '5'] },
    { name: 'country', type: 'VARCHAR', values: ['SG', 'US', 'SG', 'DE', 'US'] },
    { name: 'income', type: 'BIGINT', values: ['52000', '61000', null, '48000', '75000'] },
    // DATE renders engine-specifically through Arrow (Temporal-typed), so the
    // suite asserts only its name/type here; values are checked for the rest.
    { name: 'signup_date', type: 'DATE' },
  ],
} as const

/** Rows of the runtime-built wide CSV; must exceed the window cap (suite precondition). */
const WIDE_ROW_COUNT = 1500

/**
 * The window cap the engine enforces — imported from the engine package so
 * the suite's clamp assertions cannot drift from the real limit.
 */
const MAX_WINDOW_ROWS = MAX_RANGE_ROWS

const FAILING_SQL = 'SELECT * FROM __assay_no_such_table__'
const SMOKE_SQL = 'SELECT 42 AS answer'
const SMOKE_VALUE = '42'

/**
 * m2-2 filter/sort semantics over the customers fixture (verified against
 * DuckDB 1.5.5): predicates are engine-SQL text per grid contracts v1.
 * DuckDB sorts NULLs last in BOTH directions (its default null order), which
 * the asc/desc entries pin explicitly; the income filter pins that NULL
 * never matches a comparison.
 */
const WINDOW_SEMANTICS = [
  {
    label: 'filter income > 50000 (NULL excluded)',
    filters: [{ column: 'income', predicate: '> 50000' }],
    expectColumn: 'income',
    expectValues: ['52000', '61000', '75000'],
    expectRowCount: 3,
  },
  {
    label: 'sort income asc (NULL last)',
    sort: [{ column: 'income', direction: 'asc' }],
    expectColumn: 'income',
    expectValues: ['48000', '52000', '61000', '75000', null],
    expectRowCount: 5,
  },
  {
    label: 'sort income desc (NULL last)',
    sort: [{ column: 'income', direction: 'desc' }],
    expectColumn: 'income',
    expectValues: ['75000', '61000', '52000', '48000', null],
    expectRowCount: 5,
  },
  {
    label: "filter country = 'US' + income desc",
    filters: [{ column: 'country', predicate: "= 'US'" }],
    sort: [{ column: 'income', direction: 'desc' }],
    expectColumn: 'income',
    expectValues: ['75000', '61000'],
    expectRowCount: 2,
  },
] as const

/**
 * Filter probes that must reject cleanly: a parser error, a binder error
 * (the quoted unknown identifier stays an identifier — deliberately NOT a
 * string literal), and a quote-hostile identifier whose embedded `;`/comment
 * characters can never terminate the composed statement because the name is
 * double-quote-escaped by the composer.
 */
const REJECTING_FILTERS = [
  { column: 'income', predicate: ')) FROM ( (' },
  { column: 'income', predicate: '> "__assay_no_such_column__"' },
  { column: 'in"come" ; DROP VIEW; --', predicate: '> 50000' },
] as const

/**
 * Breakout probes (containment): an extra `;`-separated statement glued to a
 * predicate, and a valid-but-broad predicate (matches everything — the
 * harmless path; the user's own SQL on their own data is allowed to match).
 * Either way the view, its data, and the engine must survive untouched.
 */
const BREAKOUT_FILTERS = [
  { column: 'country', predicate: "= 'SG'; SELECT 42" },
  { column: 'country', predicate: "= 'SG' OR 1 = 1" },
] as const

/**
 * The m2-5 profiling dataset, built at runtime as CSV and staged via OPFS
 * (same pattern as the wide CSV). Its DuckDB-inferred schema and every stat
 * below were verified against DuckDB CLI 1.5.5:
 *
 * - `score` BIGINT (10, 20, 30, NULL, 50) — numeric with a null.
 * - `label` VARCHAR (alpha ×3, beta ×2) — duplicate-heavy categorical.
 * - `flag` BOOLEAN (true ×3, false ×2) — rendered text top-k ('true'/'false').
 * - `empty` VARCHAR, all NULL — the nulls-only column (topK=[]).
 * - `when` DATE (2025-01-01 ×3, 2025-01-02 ×2) — the temporal-as-categorical
 *   decision, pinned over DuckDB's rendered text form.
 * - `tier` VARCHAR (gold ×2, silver ×2, bronze ×1) — a count tie whose order
 *   pins the value-ascending tie-break.
 */
const PROFILE_CSV_ROWS = [
  '10,alpha,true,,2025-01-01,gold',
  '20,alpha,false,,2025-01-02,silver',
  '30,beta,true,,2025-01-01,gold',
  ',beta,false,,2025-01-02,silver',
  '50,alpha,true,,2025-01-01,bronze',
] as const

/** Exact expectations for PROFILE_CSV_ROWS (CLI-verified; see above). */
const PROFILE_DATASET = {
  rowCount: 5,
  // Same-engine determinism would allow 0; the tolerance keeps the suite
  // engine-portable (float paths may differ in the last ulp).
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
 * Mid-stream failure mechanism (deterministic): DuckDB evaluates vectorized
 * chunks of 2048 rows. The CASE yields `i` for every row of the first chunk
 * (rows 0–2047), so the worker's `streamFirstBatch` successfully receives and
 * transports batch one; pulling the *second* chunk raises `error()` inside
 * the engine — the worker's reader-cleanup path runs (`reader.cancel()` in
 * `finally`) and the typed query error reaches the client. The scenario then
 * proves the connection was released: the smoke query must still answer.
 */
const MID_STREAM_FAILURE_SQL =
  "SELECT CASE WHEN i < 2048 THEN i ELSE error('assay conformance mid-stream failure') END AS v FROM range(5000) AS t(i)"

/**
 * m3-1 nested dataset: the `fixtures/jsonl/nested.jsonl` golden fixture
 * (committed text; also copied byte-identical into the harness public dir).
 * Hand-authored synthetic rows covering every nested shape M3 exercises:
 * struct-of-struct depth 3 (`deep.a.b.c`, incl. a NULL leaf and two whole-
 * NULL structs), list-of-scalars incl. empty and NULL lists (`tags`),
 * list-of-structs with NULL fields and NULL elements (`events`), a NULL list
 * element inside `tags`, an all-NULL column (`hole`), unicode + embedded
 * quotes/escapes/backslashes in strings, scalar context columns, and the
 * quoting-hostile key `weird "quoted" key` on every row (the m3-4 injection
 * surface; see fixtures/jsonl/README.md — JSONL cannot carry comments).
 *
 * Pins below derived with the DuckDB CLI (v1.5.5) and cross-checked
 * cell-by-cell against the identical duckdb-wasm 1.32 build the engine runs,
 * through the same transport (Arrow IPC → apache-arrow vector API):
 *
 *   SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM
 *     read_json_auto('fixtures/jsonl/nested.jsonl', format='newline_delimited'));
 *   SELECT id, deep, meta, tags, hole,
 *     list_transform(events, e -> CASE WHEN e IS NULL THEN NULL ELSE epoch_us(e.at) END),
 *     list_transform(events, e -> CASE WHEN e IS NULL THEN NULL ELSE e.ok END)
 *   FROM read_json_auto('fixtures/jsonl/nested.jsonl', format='newline_delimited')
 *   ORDER BY id;
 *
 * Two honest engine-surface divergences are part of the pin:
 * - `deep.a.b.c`: CLI 1.5.5's JSON sniffer reports HUGEINT, the wasm engine
 *   BIGINT. The schema pin follows the engine under test (BIGINT); the value
 *   outputs are identical either way.
 * - `events.at`: the CLI's epoch_us() gives microseconds (1740823200000000
 *   for 2025-03-01T10:00:00Z), while apache-arrow surfaces a
 *   Timestamp(MICROSECOND) cell as epoch MILLISECONDS through `.get()` —
 *   the window pins below are those milliseconds (1740823200000).
 */
const NESTED_DATASET: ConformanceNestedDataset = {
  rowCount: 12,
  schema: [
    { name: 'id', type: 'BIGINT' },
    { name: 'kind', type: 'VARCHAR' },
    { name: 'label', type: 'VARCHAR' },
    { name: 'score', type: 'BIGINT' },
    { name: 'deep', type: 'STRUCT(a STRUCT(b STRUCT(c BIGINT)))' },
    { name: 'meta', type: 'STRUCT(src VARCHAR, ver BIGINT)' },
    { name: 'tags', type: 'VARCHAR[]' },
    { name: 'events', type: 'STRUCT("at" TIMESTAMP, ok BOOLEAN)[]' },
    { name: 'hole', type: 'JSON' },
    { name: 'weird "quoted" key', type: 'BIGINT' },
  ],
  columns: [
    { name: 'id', values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
    {
      name: 'kind',
      values: [
        'alpha',
        'beta',
        'alpha',
        'gamma',
        'beta',
        'alpha',
        'gamma',
        'beta',
        'alpha',
        'gamma',
        'beta',
        'alpha',
      ],
    },
    {
      name: 'label',
      values: [
        'plain alpha row',
        'héllo → 世界 🚀',
        'quote " inside',
        'back\\slash and \t tab',
        'emoji 🎛️ knob',
        'newline \\n escape',
        'глубина depth',
        'nested "a.b" path',
        'синтетика only',
        "quote ' single",
        '「かぎ括弧」',
        'mixed ‽ interrog',
      ],
    },
    { name: 'score', values: [10, 20, null, 40, 50, 60, 70, 80, 90, null, 110, 120] },
    {
      name: 'deep',
      values: [
        { a: { b: { c: 1 } } },
        { a: { b: { c: 2 } } },
        { a: { b: { c: 3 } } },
        null,
        { a: { b: { c: 5 } } },
        { a: { b: { c: 6 } } },
        { a: { b: { c: null } } },
        { a: { b: { c: 8 } } },
        { a: { b: { c: -9 } } },
        { a: { b: { c: 10 } } },
        null,
        { a: { b: { c: 12 } } },
      ],
    },
    {
      name: 'meta',
      values: [
        { src: 'sensor-a', ver: 1 },
        { src: 'sensor-b', ver: 2 },
        { src: null, ver: 3 },
        { src: 'sensor-a', ver: 4 },
        null,
        { src: 'sensor-c', ver: 1 },
        { src: 'sensor-a', ver: 2 },
        { src: null, ver: 8 },
        { src: 'sensor-b', ver: 1 },
        { src: 'sensor-c', ver: 2 },
        { src: 'sensor-a', ver: 3 },
        null,
      ],
    },
    {
      name: 'tags',
      values: [
        ['x', 'y'],
        [],
        ['x', null, 'z'],
        null,
        ['repeat', 'repeat'],
        ['a', 'b', 'c', 'd'],
        ['solo'],
        ['x', 'y'],
        [],
        null,
        ['u', 'v'],
        ['x', null],
      ],
    },
    {
      name: 'events',
      values: [
        [
          { at: 1740823200000, ok: true },
          { at: 1740823500000, ok: false },
        ],
        [
          { at: 1740906000000, ok: true },
          { at: 1740907800000, ok: null },
        ],
        [
          { at: null, ok: true },
          { at: 1740988800000, ok: true },
        ],
        [{ at: 1741071600000, ok: false }, null],
        [
          { at: 1741154400000, ok: true },
          { at: 1741158000000, ok: true },
        ],
        [{ at: 1741237200000, ok: null }],
        [
          { at: 1741320000000, ok: true },
          { at: null, ok: null },
          { at: 1741322400000, ok: false },
        ],
        [
          { at: 1741402800000, ok: false },
          { at: 1741404000000, ok: false },
        ],
        [{ at: 1741485600000, ok: true }],
        null,
        [{ at: 1741654800000, ok: true }, null],
        [
          { at: 1741737600000, ok: null },
          { at: 1741738200000, ok: true },
        ],
      ],
    },
    {
      name: 'hole',
      values: [null, null, null, null, null, null, null, null, null, null, null, null],
    },
    { name: 'weird "quoted" key', values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  ],
  // Mid-file window rows [4, 7) = ids 5–7: exercises offset semantics over
  // nested columns, cutting through a whole-NULL `meta` (id 5), a regular
  // struct (id 6), and a NULL leaf inside `deep` plus a NULL `at` inside an
  // `events` element (id 7).
  offsetWindow: { startRow: 4, endRow: 7 },
}

const ERRORS: ConformanceErrorMatchers = {
  operation: (error) => error instanceof EngineOperationError,
  query: (error) => error instanceof EngineQueryError,
  disposed: (error) => error instanceof EngineDisposedError,
}

/** Stage bytes in the OPFS sandbox; the handle satisfies `EngineFileSource`. */
async function stageBytesInOpfs(bytes: Uint8Array, name: string): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory()
  const handle = await root.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  // The stream wants an ArrayBuffer-backed view (the suite's `Uint8Array` is
  // deliberately ArrayBufferLike so Node subjects can stage `Buffer`s); copy
  // once — these bytes are fixture-sized test data.
  const chunk = new Uint8Array(bytes.byteLength)
  chunk.set(bytes)
  await writable.write(chunk)
  await writable.close()
  return handle
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`fixture fetch failed: HTTP ${String(response.status)}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** Runtime-built wide CSV (`id` header + `wideRowCount` integer rows). */
function buildWideCsv(rowCount: number): Uint8Array {
  const lines = ['id']
  for (let row = 0; row < rowCount; row++) lines.push(String(row))
  return new TextEncoder().encode(lines.join('\n') + '\n')
}

/** Runtime-built profiling CSV (see PROFILE_DATASET for the exact contract). */
function buildProfileCsv(): Uint8Array {
  const lines = ['score,label,flag,empty,when,tier', ...PROFILE_CSV_ROWS]
  return new TextEncoder().encode(lines.join('\n') + '\n')
}

/** A genuine `FileSystemFileHandle` satisfies the suite's source seam. */
function asFileSource(handle: FileSystemFileHandle): ConformanceFileSource {
  return handle
}

export interface DuckDbConformanceSubjectOptions {
  /** URL the good Parquet fixture is served from (harness public dir). */
  goodFixtureUrl: string
  /** URL the nested JSONL fixture is served from (harness public dir, m3-1). */
  nestedFixtureUrl: string
}

export function createDuckDbConformanceSubject(
  options: DuckDbConformanceSubjectOptions,
): EngineConformanceSubject {
  const goodParquetBytes = async (): Promise<Uint8Array> => fetchBytes(options.goodFixtureUrl)
  const nestedJsonlBytes = async (): Promise<Uint8Array> => fetchBytes(options.nestedFixtureUrl)
  return {
    name: 'engine-duckdb',
    createClient: () => asConformanceClient(new DuckDbEngineClient()),
    isIdle: (client) => client.status === 'idle',
    isReady: (client) => client.status === 'ready',
    errors: ERRORS,
    dataset: GOOD_DATASET,
    maxWindowRows: MAX_WINDOW_ROWS,
    wideRowCount: WIDE_ROW_COUNT,
    stageGoodFile: async () => {
      const bytes = await goodParquetBytes()
      return asFileSource(await stageBytesInOpfs(bytes, 'assay-conformance-good.parquet'))
    },
    stageWideFile: async () => {
      const csv = buildWideCsv(WIDE_ROW_COUNT)
      return asFileSource(await stageBytesInOpfs(csv, 'assay-conformance-wide.csv'))
    },
    stageProfileFile: async () => {
      const csv = buildProfileCsv()
      return asFileSource(await stageBytesInOpfs(csv, 'assay-conformance-profile.csv'))
    },
    stageNestedFile: async () => {
      const jsonl = await nestedJsonlBytes()
      return asFileSource(await stageBytesInOpfs(jsonl, 'assay-conformance-nested.jsonl'))
    },
    nestedDataset: NESTED_DATASET,
    goodParquetBytes,
    stageBytes: async (bytes, name) => asFileSource(await stageBytesInOpfs(bytes, name)),
    failingSql: () => FAILING_SQL,
    midStreamFailureSql: () => MID_STREAM_FAILURE_SQL,
    smokeSql: () => SMOKE_SQL,
    smokeSqlValue: SMOKE_VALUE,
    windowSemantics: WINDOW_SEMANTICS,
    profileDataset: PROFILE_DATASET,
    rejectingFilters: REJECTING_FILTERS,
    breakoutFilters: BREAKOUT_FILTERS,
    // Registry probe: DuckDB holds one non-internal view per successful open
    // (the rollback scenario asserts 0 after a failed open, 1 after recovery).
    registeredTableCount: async (client) => {
      const result: ConformanceBatchResult = await client.query(
        'SELECT count(*)::BIGINT AS n FROM duckdb_views() WHERE internal = false',
      )
      const vector = result.batch.getChildAt(0)
      if (vector === null) return null
      const value: unknown = vector.get(0)
      const count = typeof value === 'bigint' ? Number(value) : value
      return typeof count === 'number' ? count : null
    },
  }
}

function asConformanceClient(client: DuckDbEngineClient): ConformanceEngineClient {
  return client
}
