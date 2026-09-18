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
  ConformanceExportResult,
  ConformanceFileSource,
  ConformanceHostileTypeProbe,
  ConformanceNestedDataset,
  ConformanceOverlayDataset,
  ConformanceOverlayInsertEditsDataset,
  EngineConformanceSubject,
} from '@assay/testing'
import { baseRowId, insertRowId } from '@assay/domain'
import type { CellValue, EditOp, OverlayBase } from '@assay/domain'
import { tableFromIPC } from 'apache-arrow'

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

/** Resolve an engine-generated OPFS-relative path to its file handle. */
async function opfsFileForPath(path: string): Promise<FileSystemFileHandle> {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  const fileName = segments.at(-1)
  if (fileName === undefined || segments.length === 0) {
    throw new Error(`invalid export path: ${JSON.stringify(path)}`)
  }
  let dir = await navigator.storage.getDirectory()
  for (const segment of segments.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(segment)
  }
  return dir.getFileHandle(fileName)
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

/**
 * m4-2 canonical overlay base (runtime-built JSONL, never committed data) —
 * five rows whose VARCHAR cells already carry the formula-injection trigger
 * forms (leading `=`, `+`, `@`, `-`, an embedded TAB), one NULL BIGINT, and
 * three **array** columns for the fix-round-2 shape probe: `tags` is a plain
 * `VARCHAR[]`, `codes` is cast to the fixed-size `VARCHAR[3]`, and `aliases`
 * (declared `STRING[]`) is cast to `VARCHAR[]` — before the shape-aware CSV
 * classification these all matched the string family and the export wrapped
 * them in `left()`, failing with the reviewer's Binder Error.
 */
const OVERLAY_BASE_ROWS = [
  {
    id: 1,
    region: 'SG',
    amount: 52000,
    note: '=SUM(A1:A2)',
    note_alias: '=SUM(A1:A2)',
    tags: ['x', 'y'],
    codes: ['a', 'b', 'c'],
    aliases: ['p', 'q'],
  },
  {
    id: 2,
    region: 'US',
    amount: 61000,
    note: '+CMD',
    note_alias: '+CMD',
    tags: ['solo'],
    codes: ['d', 'e', 'f'],
    aliases: ['r'],
  },
  {
    id: 3,
    region: 'SG',
    amount: null,
    note: 'has\ttab',
    note_alias: 'has\ttab',
    tags: [],
    codes: ['g', 'h', 'i'],
    aliases: ['s', 't', 'u'],
  },
  {
    id: 4,
    region: 'DE',
    amount: 48000,
    note: '@x',
    note_alias: '@x',
    tags: ['z', null],
    codes: ['j', 'k', 'l'],
    aliases: [],
  },
  {
    id: 5,
    region: 'US',
    amount: 75000,
    note: '-1+1',
    note_alias: '-1+1',
    tags: ['m', 'n'],
    codes: ['m', 'n', 'o'],
    aliases: ['v', 'w'],
  },
] as const

const OVERLAY_BASE: OverlayBase = {
  baseAnchor: 'conf-base-v1',
  overlayAnchor: 'conf-ov-1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'region', type: 'VARCHAR' },
    { name: 'amount', type: 'BIGINT' },
    { name: 'note', type: 'VARCHAR' },
    { name: 'note_alias', type: 'VARCHAR' },
    { name: 'tags', type: 'VARCHAR[]' },
    { name: 'codes', type: 'VARCHAR[]' },
    { name: 'aliases', type: 'STRING[]' },
  ],
  baseRowCount: 5,
}

function overlayCell(value: CellValue): CellValue {
  return value
}

/**
 * The scripted op sequence (domain ops): an edit per value kind (`text` =
 * the engine-parseable literal cast under the column's type; a string with
 * an embedded TAB), five inserts exercising every position kind — start,
 * after a base row, before a base row, an after-chain nested on an insert,
 * and a DEAD anchor (a tombstoned base row, degrading to the end) — a base
 * delete, the rename, the cast, a no-op replay, and a foreign-anchor op the
 * fold absorbs. State-changing ops never overlap the no-op/conflict ones.
 */
const OVERLAY_OPS: EditOp[] = [
  {
    kind: 'cell-set',
    rowId: baseRowId('conf-base-v1', 1),
    column: 'amount',
    value: overlayCell({ kind: 'text', text: '66000' }),
  },
  {
    kind: 'cell-set',
    rowId: baseRowId('conf-base-v1', 2),
    column: 'note',
    value: overlayCell({ kind: 'string', value: 'a\tb=victim' }),
  },
  {
    // Mirror the bait edit onto the NVARCHAR-aliased column (fix-round-2
    // warning: a byte-level round trip for a second textual spelling).
    kind: 'cell-set',
    rowId: baseRowId('conf-base-v1', 2),
    column: 'note_alias',
    value: overlayCell({ kind: 'string', value: 'a\tb=victim' }),
  },
  {
    kind: 'row-insert',
    rowId: insertRowId('conf-ov-1', 0),
    position: { kind: 'start' },
    values: new Map<string, CellValue>([
      ['id', overlayCell({ kind: 'text', text: '100' })],
      ['region', overlayCell({ kind: 'string', value: 'XX' })],
      ['amount', overlayCell({ kind: 'text', text: '9000' })],
      ['note', overlayCell({ kind: 'string', value: '-1+1' })],
      ['note_alias', overlayCell({ kind: 'string', value: '-1+1' })],
    ]),
  },
  {
    kind: 'row-insert',
    rowId: insertRowId('conf-ov-1', 1),
    position: { kind: 'after', rowId: baseRowId('conf-base-v1', 1) },
    values: new Map<string, CellValue>([
      ['id', overlayCell({ kind: 'number', value: 101 })],
      ['region', overlayCell({ kind: 'string', value: 'YY' })],
      ['note', overlayCell({ kind: 'string', value: '@x' })],
      ['note_alias', overlayCell({ kind: 'string', value: '@x' })],
    ]),
  },
  {
    kind: 'row-insert',
    rowId: insertRowId('conf-ov-1', 2),
    position: { kind: 'before', rowId: baseRowId('conf-base-v1', 4) },
    values: new Map<string, CellValue>([
      ['id', overlayCell({ kind: 'number', value: 102 })],
      ['region', overlayCell({ kind: 'string', value: 'ZZ' })],
    ]),
  },
  {
    kind: 'row-insert',
    rowId: insertRowId('conf-ov-1', 3),
    position: { kind: 'after', rowId: insertRowId('conf-ov-1', 2) },
    values: new Map<string, CellValue>([
      ['id', overlayCell({ kind: 'number', value: 103 })],
      ['region', overlayCell({ kind: 'string', value: 'W W' })],
      ['note', overlayCell({ kind: 'string', value: 'cr\rcarriage' })],
      ['note_alias', overlayCell({ kind: 'string', value: 'cr\rcarriage' })],
    ]),
  },
  {
    kind: 'row-insert',
    rowId: insertRowId('conf-ov-1', 4),
    position: { kind: 'after', rowId: baseRowId('conf-base-v1', 3) },
    values: new Map<string, CellValue>([
      ['id', overlayCell({ kind: 'text', text: '999' })],
      ['region', overlayCell({ kind: 'string', value: 'Q' })],
    ]),
  },
  { kind: 'row-delete', rowId: baseRowId('conf-base-v1', 3) },
  { kind: 'column-rename', from: 'amount', to: 'amount_eur' },
  { kind: 'column-cast', column: 'id', targetType: 'VARCHAR' },
  // m4-2 fix round: cast the bait column through DuckDB's TEXT alias. The
  // effective DECLARED type becomes TEXT (DESCRIBE reports VARCHAR), which is
  // exactly the spelling the exact-`'VARCHAR'` CSV guard missed — this op is
  // what makes the export-round-trip pin non-vacuous for the alias fix.
  { kind: 'column-cast', column: 'note', targetType: 'TEXT' },
  // m4-2 fix round 2 warning: pin a SECOND textual alias (NVARCHAR) on the
  // mirrored bait column, so the byte-level CSV round trip is not TEXT-only.
  { kind: 'column-cast', column: 'note_alias', targetType: 'NVARCHAR' },
  // m4-2 fix round 2: array casts. `codes` becomes a fixed-size
  // `VARCHAR[3]` and `aliases` a `VARCHAR[]` produced by `column-cast`;
  // `tags` stays a plain `VARCHAR[]`. The CSV guard must skip all three.
  { kind: 'column-cast', column: 'codes', targetType: 'VARCHAR[3]' },
  { kind: 'column-cast', column: 'aliases', targetType: 'VARCHAR[]' },
  // Absorbed by the fold (no-op replay + foreign anchor): state unchanged.
  {
    kind: 'cell-set',
    rowId: baseRowId('conf-base-v1', 1),
    column: 'amount',
    value: overlayCell({ kind: 'text', text: '66000' }),
  },
  {
    kind: 'cell-set',
    rowId: baseRowId('other-version', 0),
    column: 'region',
    value: overlayCell({ kind: 'string', value: 'X' }),
  },
]

const EFFECTIVE_ROW_IDS = [
  'ins:conf-ov-1#0',
  'base:conf-base-v1#0',
  'base:conf-base-v1#1',
  'ins:conf-ov-1#1',
  'base:conf-base-v1#2',
  'ins:conf-ov-1#2',
  'ins:conf-ov-1#3',
  'base:conf-base-v1#4',
  'ins:conf-ov-1#4',
] as const

const EFFECTIVE_ID = ['100', '1', '2', '101', '3', '102', '103', '5', '999'] as const
const EFFECTIVE_REGION = ['XX', 'SG', 'US', 'YY', 'SG', 'ZZ', 'W W', 'US', 'Q'] as const
const EFFECTIVE_AMOUNT = ['9000', '52000', '66000', null, null, null, null, '75000', null] as const
const EFFECTIVE_NOTE = [
  '-1+1',
  '=SUM(A1:A2)',
  '+CMD',
  '@x',
  'a\tb=victim',
  null,
  'cr\rcarriage',
  '-1+1',
  null,
] as const

/**
 * Effective-order array values, rendered exactly as the CSV export re-opens
 * them (`read_csv_auto` infers the rendered list text as VARCHAR). `tags` and
 * `aliases` are `VARCHAR[]`; `codes` is the fixed-size `VARCHAR[3]` the
 * `column-cast` produces. Insert branches carry no array values -> NULL.
 * Derived with the pinned DuckDB CLI 1.5.5 (see the dataset comment).
 */
const EFFECTIVE_TAGS_CSV = [
  null,
  '[x, y]',
  '[solo]',
  null,
  '[]',
  null,
  null,
  '[m, n]',
  null,
] as const
const EFFECTIVE_CODES_CSV = [
  null,
  '[a, b, c]',
  '[d, e, f]',
  null,
  '[g, h, i]',
  null,
  null,
  '[m, n, o]',
  null,
] as const
const EFFECTIVE_ALIASES_CSV = [
  null,
  '[p, q]',
  '[r]',
  null,
  '[s, t, u]',
  null,
  null,
  '[v, w]',
  null,
] as const

/** The CSV export sanitizes every trigger cell (apostrophe-prefix convention). */
const CSV_SANITIZED_NOTE = [
  "'-1+1",
  "'=SUM(A1:A2)",
  "'+CMD",
  "'@x",
  "'a\tb=victim",
  null,
  "'cr\rcarriage",
  "'-1+1",
  null,
] as const

/**
 * m4-2 overlay dataset pins — every expectation below was derived with the
 * pinned DuckDB CLI (v1.5.5, `DUCKDB=/tmp/duckdb`) over the IDENTICAL
 * composed SQL the worker generates (`composeOverlayWindowSql` and friends
 * over `assay_t1 = SELECT * FROM read_json_auto(<this JSONL>)`), then round-trip
 * checked cell-by-cell against the duckdb-wasm 1.32 build through Arrow IPC.
 * (The base file is JSONL, not CSV, so the array columns are inferred as
 * `VARCHAR[]`; the `codes`/`aliases` casts give the fixed-size and
 * cast-produced array spellings.)
 * Derivation transcript (control chars marked <TAB>/<CR>):
 *
 *   WITH eff AS (<the composed includeRowIds window, LIMIT 1000 OFFSET 0>)
 *   SELECT assay_row_id, id, region, amount_eur, note FROM eff;
 *
 *   ins:conf-ov-1#0 | 100 | XX | 9000 | -1+1
 *   base:conf-base-v1#0 | 1 | SG | 52000 | =SUM(A1:A2)
 *   base:conf-base-v1#1 | 2 | US | 66000 | +CMD
 *   ins:conf-ov-1#1 | 101 | YY | NULL | @x
 *   base:conf-base-v1#2 | 3 | SG | NULL | a<TAB>b=victim
 *   ins:conf-ov-1#2 | 102 | ZZ | NULL | NULL
 *   ins:conf-ov-1#3 | 103 | W W | NULL | cr<CR>carriage
 *   base:conf-base-v1#4 | 5 | US | 75000 | -1+1
 *   ins:conf-ov-1#4 | 999 | Q | NULL | NULL
 *
 * (start insert leads; the deleted base row #3 is gone; the after-chain
 * ins#2→ins#3 nests before base#4; the dead-anchor insert #4 degrades to
 * the end) — the effectiveRowIds equivalence pin. Counts (9; region='SG'
 * filtered: 2), the effective schema (id VARCHAR — the cast; amount_eur
 * BIGINT — the rename), the LIMIT 3 OFFSET 2 slice (rows [2,5)), the
 * amount_eur desc sort (NULLs last, assay_key tiebreak: 101,3,102,103,999),
 * and the per-format exports (CSV sanitized byte-level via `cat -A`:
 * every trigger cell prefixed with `\x27`, the CR cell quoted by the CSV
 * writer; JSONL/JSON/Parquet raw) were all captured from the same session.
 */
const OVERLAY_DATASET: ConformanceOverlayDataset = {
  base: OVERLAY_BASE,
  ops: OVERLAY_OPS,
  effectiveSchema: [
    { name: 'id', type: 'VARCHAR' },
    { name: 'region', type: 'VARCHAR' },
    { name: 'amount_eur', type: 'BIGINT' },
    { name: 'note', type: 'VARCHAR' },
    { name: 'note_alias', type: 'VARCHAR' },
    { name: 'tags', type: 'VARCHAR[]' },
    { name: 'codes', type: 'VARCHAR[3]' },
    { name: 'aliases', type: 'VARCHAR[]' },
  ],
  liveRowCount: 9,
  rowIds: EFFECTIVE_ROW_IDS,
  rowIdColumn: 'assay_row_id',
  columns: [
    { name: 'id', values: EFFECTIVE_ID },
    { name: 'region', values: EFFECTIVE_REGION },
    { name: 'amount_eur', values: EFFECTIVE_AMOUNT },
    { name: 'note', values: EFFECTIVE_NOTE },
    { name: 'note_alias', values: EFFECTIVE_NOTE },
  ],
  offsetWindow: { startRow: 2, endRow: 5 },
  filtered: {
    label: "filter region = 'SG' over the effective view",
    filters: [{ column: 'region', predicate: "= 'SG'" }],
    expectColumn: 'region',
    expectValues: ['SG', 'SG'],
    expectRowCount: 2,
  },
  sorted: {
    label: 'sort amount_eur desc (renamed column; NULLs last, assay_key tiebreak)',
    sort: [{ column: 'amount_eur', direction: 'desc' }],
    expectColumn: 'amount_eur',
    expectValues: ['75000', '66000', '52000', '9000', null, null, null, null, null],
    expectRowCount: 9,
  },
  exports: [
    {
      format: 'csv',
      roundTrip: 'engine',
      rowCount: 9,
      columns: [
        // Re-opened via read_csv: id/amount_eur re-infer BIGINT — the
        // rendered values are identical to the effective view.
        { name: 'id', values: EFFECTIVE_ID },
        { name: 'region', values: EFFECTIVE_REGION },
        { name: 'amount_eur', values: EFFECTIVE_AMOUNT },
        { name: 'note', values: CSV_SANITIZED_NOTE },
        // The NVARCHAR-aliased, mirrored bait column is sanitized identically
        // (fix-round-2 warning: a second textual spelling, not just TEXT).
        { name: 'note_alias', values: CSV_SANITIZED_NOTE },
        // Array columns: the shape-aware guard skips them, so the export
        // succeeds and the re-opened CSV carries DuckDB's rendered list
        // literals verbatim (fix round 2). Insert rows have no arrays -> NULL.
        { name: 'tags', values: EFFECTIVE_TAGS_CSV },
        { name: 'codes', values: EFFECTIVE_CODES_CSV },
        { name: 'aliases', values: EFFECTIVE_ALIASES_CSV },
      ],
    },
    {
      format: 'jsonl',
      roundTrip: 'engine',
      rowCount: 9,
      columns: [
        { name: 'id', values: EFFECTIVE_ID },
        { name: 'region', values: EFFECTIVE_REGION },
        { name: 'amount_eur', values: EFFECTIVE_AMOUNT },
        // Raw content stays visible in JSONL — the non-vacuous counterpart
        // of the CSV sanitization pin (m4-5 pins the UI side), including the
        // mirrored NVARCHAR-aliased column.
        { name: 'note', values: EFFECTIVE_NOTE },
        { name: 'note_alias', values: EFFECTIVE_NOTE },
      ],
    },
    {
      format: 'json',
      roundTrip: 'engine',
      rowCount: 9,
      columns: [
        { name: 'id', values: EFFECTIVE_ID },
        { name: 'region', values: EFFECTIVE_REGION },
        { name: 'amount_eur', values: EFFECTIVE_AMOUNT },
        { name: 'note', values: EFFECTIVE_NOTE },
      ],
    },
    {
      format: 'parquet',
      roundTrip: 'engine',
      rowCount: 9,
      columns: [
        { name: 'id', values: EFFECTIVE_ID },
        { name: 'region', values: EFFECTIVE_REGION },
        { name: 'amount_eur', values: EFFECTIVE_AMOUNT },
        { name: 'note', values: EFFECTIVE_NOTE },
      ],
    },
    {
      format: 'arrow',
      roundTrip: 'arrow-container',
      rowCount: 9,
      columns: [
        { name: 'id', values: EFFECTIVE_ID },
        { name: 'region', values: EFFECTIVE_REGION },
        { name: 'amount_eur', values: EFFECTIVE_AMOUNT },
        { name: 'note', values: EFFECTIVE_NOTE },
      ],
    },
  ],
}

/**
 * m4-2b inserted-row-edit dataset: a focused op sequence over the canonical
 * overlay base (`OVERLAY_BASE`) that reproduces the defect the m4-2 composer
 * had — `cell-set`/`cell-revert` on an **inserted** row, plus renames after
 * the edits. Three discriminating cases coexist in the single inserted row:
 *
 * - `region` is absent from the insert (NULL); the `cell-set` must materialize
 *   it, then the rename moves it to `region_code` (the reviewer's proven
 *   case: the old composer emitted `CAST(NULL AS VARCHAR)`).
 * - `note_alias` **is** carried by the insert (`'inserted-alias'`); the
 *   `cell-set` must win, then the rename moves it to `alias_v2`.
 * - `note` is inserted as `'original'`, edited to `'edited'`, then reverted:
 *   the insert value must stand again.
 *
 * Every pin below was derived with the pinned DuckDB CLI (v1.5.5,
 * `DUCKDB=/tmp/duckdb`) over the IDENTICAL composed SQL the worker generates
 * (`composeOverlayWindowSql` / `composeOverlayExportSelectSql` over
 * `assay_t1 = SELECT * FROM read_json_auto(<this JSONL>)`) and round-trip
 * checked against the duckdb-wasm build. Derivation transcript (control
 * chars marked <TAB>/<CR>):
 *
 *   -- effective window (includeRowIds), LIMIT 1000 OFFSET 0
 *   SELECT assay_row_id, id, region_code, amount, note, alias_v2 FROM eff;
 *
 *   ins:conf-ov-1#0     | 100 | XX | NULL  | original    | =SUM(A1:A2)
 *   base:conf-base-v1#0 | 1   | SG | 52000 | =SUM(A1:A2) | =SUM(A1:A2)
 *   base:conf-base-v1#1 | 2   | US | 61000 | +CMD        | +CMD
 *   base:conf-base-v1#2 | 3   | SG | NULL  | has<TAB>tab | has<TAB>tab
 *   base:conf-base-v1#3 | 4   | DE | 48000 | @x          | @x
 *   base:conf-base-v1#4 | 5   | US | 75000 | -1+1        | -1+1
 *
 *   -- CSV export reopened via read_csv_auto (sanitized: leading `'`):
 *   note/alias_v2: original, '=SUM(A1:A2), '+CMD, 'has<TAB>tab, '@x, '-1+1
 *   -- JSONL export reopened via read_json_auto: identical to the effective
 *   window (raw content stays visible).
 */
const OVERLAY_INSERT_EDITS_OPS: EditOp[] = [
  {
    kind: 'row-insert',
    rowId: insertRowId('conf-ov-1', 0),
    position: { kind: 'start' },
    values: new Map<string, CellValue>([
      ['id', overlayCell({ kind: 'number', value: 100 })],
      ['note', overlayCell({ kind: 'string', value: 'original' })],
      ['note_alias', overlayCell({ kind: 'string', value: 'inserted-alias' })],
    ]),
  },
  // The insert left `region` NULL: the edit must materialize it.
  {
    kind: 'cell-set',
    rowId: insertRowId('conf-ov-1', 0),
    column: 'region',
    value: overlayCell({ kind: 'string', value: 'XX' }),
  },
  // The edit must win over the insert record's own `note_alias` value.
  {
    kind: 'cell-set',
    rowId: insertRowId('conf-ov-1', 0),
    column: 'note_alias',
    value: overlayCell({ kind: 'string', value: '=SUM(A1:A2)' }),
  },
  // Edit then revert: the insert value must stand again.
  {
    kind: 'cell-set',
    rowId: insertRowId('conf-ov-1', 0),
    column: 'note',
    value: overlayCell({ kind: 'string', value: 'edited' }),
  },
  { kind: 'cell-revert', rowId: insertRowId('conf-ov-1', 0), column: 'note' },
  // Renames after the edits: the edits follow their renamed columns.
  { kind: 'column-rename', from: 'note_alias', to: 'alias_v2' },
  { kind: 'column-rename', from: 'region', to: 'region_code' },
]

const INSERT_EDITS_ROW_IDS = [
  'ins:conf-ov-1#0',
  'base:conf-base-v1#0',
  'base:conf-base-v1#1',
  'base:conf-base-v1#2',
  'base:conf-base-v1#3',
  'base:conf-base-v1#4',
] as const
const INSERT_EDITS_ID = ['100', '1', '2', '3', '4', '5'] as const
const INSERT_EDITS_REGION = ['XX', 'SG', 'US', 'SG', 'DE', 'US'] as const
const INSERT_EDITS_AMOUNT = [null, '52000', '61000', null, '48000', '75000'] as const
const INSERT_EDITS_NOTE = ['original', '=SUM(A1:A2)', '+CMD', 'has\ttab', '@x', '-1+1'] as const
const INSERT_EDITS_ALIAS = ['=SUM(A1:A2)', '=SUM(A1:A2)', '+CMD', 'has\ttab', '@x', '-1+1'] as const
const INSERT_EDITS_CSV_NOTE = [
  'original',
  "'=SUM(A1:A2)",
  "'+CMD",
  "'has\ttab",
  "'@x",
  "'-1+1",
] as const
// The inserted row's `alias_v2` is the *edited* `=SUM(A1:A2)` (not the
// reverted `note` value), sanitized to a leading apostrophe.
const INSERT_EDITS_CSV_ALIAS = [
  "'=SUM(A1:A2)",
  "'=SUM(A1:A2)",
  "'+CMD",
  "'has\ttab",
  "'@x",
  "'-1+1",
] as const

const OVERLAY_INSERT_EDITS_DATASET: ConformanceOverlayInsertEditsDataset = {
  base: OVERLAY_BASE,
  ops: OVERLAY_INSERT_EDITS_OPS,
  effectiveSchema: [
    { name: 'id', type: 'BIGINT' },
    { name: 'region_code', type: 'VARCHAR' },
    { name: 'amount', type: 'BIGINT' },
    { name: 'note', type: 'VARCHAR' },
    { name: 'alias_v2', type: 'VARCHAR' },
    { name: 'tags', type: 'VARCHAR[]' },
    { name: 'codes', type: 'VARCHAR[]' },
    { name: 'aliases', type: 'VARCHAR[]' },
  ],
  liveRowCount: 6,
  rowIds: INSERT_EDITS_ROW_IDS,
  rowIdColumn: 'assay_row_id',
  columns: [
    { name: 'id', values: INSERT_EDITS_ID },
    { name: 'region_code', values: INSERT_EDITS_REGION },
    { name: 'amount', values: INSERT_EDITS_AMOUNT },
    { name: 'note', values: INSERT_EDITS_NOTE },
    { name: 'alias_v2', values: INSERT_EDITS_ALIAS },
  ],
  exports: [
    {
      format: 'csv',
      roundTrip: 'engine',
      rowCount: 6,
      columns: [
        { name: 'id', values: INSERT_EDITS_ID },
        { name: 'region_code', values: INSERT_EDITS_REGION },
        { name: 'amount', values: INSERT_EDITS_AMOUNT },
        { name: 'note', values: INSERT_EDITS_CSV_NOTE },
        { name: 'alias_v2', values: INSERT_EDITS_CSV_ALIAS },
      ],
    },
    {
      format: 'jsonl',
      roundTrip: 'engine',
      rowCount: 6,
      columns: [
        { name: 'id', values: INSERT_EDITS_ID },
        { name: 'region_code', values: INSERT_EDITS_REGION },
        { name: 'amount', values: INSERT_EDITS_AMOUNT },
        { name: 'note', values: INSERT_EDITS_NOTE },
        { name: 'alias_v2', values: INSERT_EDITS_ALIAS },
      ],
    },
  ],
}

/**
 * m4-2 fix round: the review's exact injection payload (finding 1) plus a
 * base-column spelling of the same attack, both driven against the REAL
 * engine. With the fix the client rejects the overlay with a typed error
 * before any SQL is composed; the scenario additionally proves the
 * injection's side-effect tables never land in the DuckDB catalog.
 */
const HOSTILE_TYPE_PROBES: readonly ConformanceHostileTypeProbe[] = [
  {
    label: 'hostile column-cast target type (review payload)',
    injectedTable: 'assay_injected',
    overlay: {
      base: OVERLAY_BASE,
      ops: [
        {
          kind: 'column-cast',
          column: 'note',
          targetType:
            'VARCHAR) AS "c" FROM (...) ); CREATE TABLE assay_injected AS SELECT 31337; --',
        },
      ],
    },
  },
  {
    label: 'hostile base column type (same validator path)',
    injectedTable: 'assay_base_injected',
    overlay: {
      base: {
        ...OVERLAY_BASE,
        columns: OVERLAY_BASE.columns.map((column) =>
          column.name === 'note'
            ? {
                name: column.name,
                type: 'VARCHAR) ); CREATE TABLE assay_base_injected AS SELECT 31337; --',
              }
            : column,
        ),
      },
      ops: [],
    },
  },
]

/** Runtime-built overlay base JSONL (see OVERLAY_BASE_ROWS). */
function buildOverlayJsonl(): Uint8Array {
  const lines = OVERLAY_BASE_ROWS.map((row) => JSON.stringify(row))
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
    overlayDataset: OVERLAY_DATASET,
    stageOverlayFile: async () => {
      const jsonl = buildOverlayJsonl()
      return asFileSource(await stageBytesInOpfs(jsonl, 'assay-conformance-overlay.jsonl'))
    },
    overlayInsertEdits: OVERLAY_INSERT_EDITS_DATASET,
    stageOverlayInsertEditsFile: async () => {
      // Same canonical base bytes; a distinct OPFS name keeps the scenario's
      // staging self-describing and independent of the other scenarios.
      const jsonl = buildOverlayJsonl()
      return asFileSource(
        await stageBytesInOpfs(jsonl, 'assay-conformance-overlay-insert-edits.jsonl'),
      )
    },
    hostileTypeProbes: HOSTILE_TYPE_PROBES,
    tableExists: async (client, name) => {
      // Standard information_schema query; `name` is a trusted test constant
      // (single-quote escaped anyway, so this helper stays safe for any input).
      const escaped = name.replaceAll("'", "''")
      const result: ConformanceBatchResult = await client.query(
        `SELECT count(*)::BIGINT AS n FROM information_schema.tables WHERE table_name = '${escaped}'`,
      )
      const value: unknown = result.batch.getChildAt(0)?.get(0)
      const count = typeof value === 'bigint' ? Number(value) : value
      return typeof count === 'number' && count > 0
    },
    sourceDigest: async (source) => {
      const file = await (source as FileSystemFileHandle).getFile()
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    },
    exportedSource: async (result: ConformanceExportResult) =>
      asFileSource(await opfsFileForPath(result.path)),
    readExportedArrowTable: async (result: ConformanceExportResult) => {
      const handle = await opfsFileForPath(result.path)
      const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer())
      return { batch: tableFromIPC(bytes), hasMore: false }
    },
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
