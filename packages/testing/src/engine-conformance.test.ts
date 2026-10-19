// SPDX-License-Identifier: AGPL-3.0-or-later

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
import { CONTRACT_TYPE_VOCABULARY } from '@assay/contracts'
import { compileRowDiffPlan } from '@assay/diff'
import type {
  ConformanceBatchResult,
  ConformanceBlobExportDataset,
  ConformanceCellValue,
  ConformanceCategoricalStats,
  ConformanceDatasetProfile,
  ConformanceEditOp,
  ConformanceEngineClient,
  ConformanceExportFormat,
  ConformanceExportResult,
  ConformanceFileSource,
  ConformanceFilterSpec,
  ConformanceComparisonHandle,
  ConformanceHostileRowDiffPlan,
  ConformanceHostileTypeProbe,
  ConformanceHostileValidationPlan,
  ConformanceInsertPosition,
  ConformanceNumericStats,
  ConformanceOverlay,
  ConformanceOverlayBase,
  ConformanceOverlayCastCheckDataset,
  ConformanceOverlayInsertEditsDataset,
  ConformanceOverlayWindow,
  ConformanceRowDiffDataset,
  ConformanceRowDiffExpectations,
  ConformanceRowDiffPlan,
  ConformanceRowDiffResult,
  ConformanceRowDiffSample,
  ConformanceScenarioName,
  ConformanceSortSpec,
  ConformanceTableHandle,
  ConformanceValidationDataset,
  ConformanceValidationPlan,
  ConformanceValidationResult,
  ConformanceValidationRuleExpectation,
  ConformanceValidationRuleResult,
  ConformanceValidationSample,
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
  /** m4-2: overlay cell edits are silently dropped (base values served). */
  skipsOverlayEdits?: boolean
  /** m4-2: insert positions are ignored — every live insert degrades to the end. */
  misordersOverlayInserts?: boolean
  /** m4-2: tombstoned base rows are served anyway (deletes not reflected). */
  keepsDeletedRows?: boolean
  /** m4-2: the effective schema is reported as the base schema (rename/cast invisible). */
  liesAboutOverlaySchema?: boolean
  /** m4-2: the overlay row count ignores tombstoned base rows. */
  liesAboutOverlayRowCount?: boolean
  /** m4-2: CSV exports skip the formula-injection sanitization. */
  skipsCsvSanitization?: boolean
  /** C1/S1: CSV exports sanitize values but write column NAMES verbatim. */
  skipsCsvHeaderGuard?: boolean
  /** m4-2: the export result's row count is inflated by one. */
  liesAboutExportRowCount?: boolean
  /** m4-2: exporting rewrites the staged source file (breaks byte-identity). */
  rewritesSourceFile?: boolean
  /** m4-2 fix round: hostile type expressions are accepted instead of rejected. */
  acceptsHostileTypes?: boolean
  /** m4-4b: the cast check always answers false (bad values silently pass). */
  castCheckAlwaysFalse?: boolean
  /** m4-4b: the cast check always answers true (false positives). */
  castCheckAlwaysTrue?: boolean
  /** m4-4b round 3: the committed-cast ground truth lies (never fails). */
  committedCastAlwaysSucceeds?: boolean
  /** m5-2: per-rule failCounts are inflated by one. */
  liesAboutValidationCounts?: boolean
  /** m5-2: sample failures are silently dropped (row-key channel broken). */
  dropsValidationSamples?: boolean
  /** m5-2: the engine's documented sample clamp is skipped. */
  skipsValidationClamp?: boolean
  /** m5-2: hostile validation plans are accepted instead of rejected. */
  acceptsHostilePlans?: boolean
  /** m6-2: per-aspect row-diff counts are inflated by one. */
  liesAboutRowDiffCounts?: boolean
  /** m6-2: hostile row-diff plans are accepted instead of rejected. */
  acceptsHostileRowDiffPlans?: boolean
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

/**
 * m4-2 overlay dataset the fake subject declares — the same probe shapes the
 * DuckDB subject pins over its runtime-built CSV, in miniature: leading-
 * formula bait cells in the BASE data (`=SUM(A1:A2)`, `-1+1`), baits and a
 * NULL introduced by edits/inserts, an anchored insert chain, a tombstoned
 * base row, a rename, and a cast. Expectations are hand-written literals
 * independent of the fake's fold/emission code below, so mutation knobs can
 * make the two disagree.
 */
const FAKE_OVERLAY_BASE = {
  baseAnchor: 'fake-base-v1',
  overlayAnchor: 'fake-ov-1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'label', type: 'VARCHAR' },
  ],
  baseRowCount: 4,
} as const

const FAKE_OVERLAY_OPS: readonly ConformanceEditOp[] = [
  // Edit introduces a bait cell (and covers the last-write-wins path).
  {
    kind: 'cell-set',
    rowId: 'base:fake-base-v1#1',
    column: 'label',
    value: { kind: 'string', value: '+CMD' },
  },
  {
    kind: 'row-insert',
    rowId: 'ins:fake-ov-1#0',
    position: { kind: 'start' },
    values: new Map([
      ['id', { kind: 'text', text: '50' }],
      ['label', { kind: 'string', value: '@start' }],
    ]),
  },
  {
    kind: 'row-insert',
    rowId: 'ins:fake-ov-1#1',
    position: { kind: 'after', rowId: 'base:fake-base-v1#0' },
    values: new Map([['id', { kind: 'number', value: 51 }]]),
  },
  { kind: 'row-delete', rowId: 'base:fake-base-v1#2' },
  { kind: 'column-rename', from: 'label', to: 'label_v2' },
  { kind: 'column-cast', column: 'id', targetType: 'VARCHAR' },
]

/** The fake's overlay base rows in natural order (mirrors FAKE_OVERLAY_BASE). */
const FAKE_OVERLAY_ROWS: readonly { id: number; label: string | null }[] = [
  { id: 1, label: '=SUM(A1:A2)' },
  { id: 2, label: 'b' },
  { id: 3, label: null },
  { id: 4, label: '-1+1' },
]

/** Exact m4-2 expectations (hand-written; see the block comment above). */
const FAKE_OVERLAY_DATASET = {
  base: FAKE_OVERLAY_BASE,
  ops: FAKE_OVERLAY_OPS,
  effectiveSchema: [
    { name: 'id', type: 'VARCHAR' },
    { name: 'label_v2', type: 'VARCHAR' },
  ],
  liveRowCount: 5,
  // ins#1 anchors `after base#0`, so it emits between base#0 and base#1
  // (the domain's `effectiveRowIds` emission order).
  rowIds: [
    'ins:fake-ov-1#0',
    'base:fake-base-v1#0',
    'ins:fake-ov-1#1',
    'base:fake-base-v1#1',
    'base:fake-base-v1#3',
  ],
  rowIdColumn: 'assay_row_id',
  columns: [
    { name: 'id', values: ['50', '1', '51', '2', '4'] },
    { name: 'label_v2', values: ['@start', '=SUM(A1:A2)', null, '+CMD', '-1+1'] },
  ],
  offsetWindow: { startRow: 1, endRow: 3 },
  filtered: {
    label: 'filter label_v2 IS NOT NULL',
    filters: [{ column: 'label_v2', predicate: 'IS NOT NULL' }],
    expectColumn: 'label_v2',
    expectValues: ['@start', '=SUM(A1:A2)', '+CMD', '-1+1'],
    expectRowCount: 4,
  },
  sorted: {
    label: 'sort id asc (VARCHAR after the cast — lexicographic)',
    sort: [{ column: 'id', direction: 'asc' }],
    expectColumn: 'id',
    expectValues: ['1', '2', '4', '50', '51'],
    expectRowCount: 5,
  },
  exports: [
    {
      format: 'csv',
      roundTrip: 'engine',
      rowCount: 5,
      columns: [
        { name: 'id', values: ['50', '1', '51', '2', '4'] },
        // Sanitized: every formula-trigger cell gains the apostrophe prefix.
        { name: 'label_v2', values: ["'@start", "'=SUM(A1:A2)", null, "'+CMD", "'-1+1"] },
      ],
    },
    {
      format: 'jsonl',
      roundTrip: 'engine',
      rowCount: 5,
      columns: [
        { name: 'id', values: ['50', '1', '51', '2', '4'] },
        { name: 'label_v2', values: ['@start', '=SUM(A1:A2)', null, '+CMD', '-1+1'] },
      ],
    },
    {
      format: 'parquet',
      roundTrip: 'engine',
      rowCount: 5,
      columns: [
        { name: 'id', values: ['50', '1', '51', '2', '4'] },
        { name: 'label_v2', values: ['@start', '=SUM(A1:A2)', null, '+CMD', '-1+1'] },
      ],
    },
    {
      format: 'arrow',
      roundTrip: 'arrow-container',
      rowCount: 5,
      columns: [
        { name: 'id', values: ['50', '1', '51', '2', '4'] },
        { name: 'label_v2', values: ['@start', '=SUM(A1:A2)', null, '+CMD', '-1+1'] },
      ],
    },
  ],
} as const

/**
 * The AR-E1 BLOB CSV-export dataset the fake subject declares, in miniature:
 * a base VARCHAR column cast to BLOB, plus a BLOB-typed inserted value. The
 * fake models a compliant engine's `hex()` rendering for CSV (the DuckDB
 * subject pins the same hex over the real engine, including the genuine
 * overlay-free base BLOB that the two-step export produces).
 */
const FAKE_BLOB_BASE: ConformanceOverlayBase = {
  baseAnchor: 'fake-blob-base-v1',
  overlayAnchor: 'fake-blob-ov-1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'cast_blob', type: 'VARCHAR' },
  ],
  baseRowCount: 2,
}

const FAKE_BLOB_ROWS: readonly { id: number; cast_blob: string | null }[] = [
  { id: 1, cast_blob: '=cmd|@SUM(1+1)' },
  { id: 2, cast_blob: 'safe' },
]

const FAKE_BLOB_EXPORT_DATASET: ConformanceBlobExportDataset = {
  base: FAKE_BLOB_BASE,
  ops: [
    { kind: 'column-cast', column: 'cast_blob', targetType: 'BLOB' },
    {
      kind: 'row-insert',
      rowId: 'ins:fake-blob-ov-1#0',
      position: { kind: 'start' },
      values: new Map([
        ['id', { kind: 'number', value: 3 }],
        ['cast_blob', { kind: 'string', value: '-1+1' }],
      ]),
    },
  ],
  rowCount: 3,
  columns: [
    { name: 'id', values: ['3', '1', '2'] },
    { name: 'cast_blob', values: ['2D312B31', '3D636D647C4053554D28312B3129', '73616665'] },
  ],
}

/**
 * The m4-2b inserted-row-edit dataset the fake subject declares, in
 * miniature: one inserted row whose `label` is overridden by a later
 * `cell-set` (the edit must win over the insert's own value), whose `id` is
 * edited then reverted (the insert value must stand again), followed by a
 * rename of the edited column. Expectations are hand-written literals
 * independent of the fake's fold/emission code, so the `skipsOverlayEdits`
 * mutation (which drops `state.edits`) makes the two disagree on the merged
 * `label_v2` value. The DuckDB subject pins the full NULL-materialization
 * shape over the same defect; the fake keeps the suite's logic honest.
 */
const FAKE_OVERLAY_INSERT_EDITS_DATASET: ConformanceOverlayInsertEditsDataset = {
  base: FAKE_OVERLAY_BASE,
  ops: [
    {
      kind: 'row-insert',
      rowId: 'ins:fake-ov-1#0',
      position: { kind: 'start' },
      values: new Map([
        ['id', { kind: 'number', value: 50 }],
        ['label', { kind: 'string', value: 'original' }],
      ]),
    },
    // Edit wins over the insert record's `label` value.
    {
      kind: 'cell-set',
      rowId: 'ins:fake-ov-1#0',
      column: 'label',
      value: { kind: 'string', value: '=SUM(A1:A2)' },
    },
    // Edit then revert: the insert value must stand again.
    {
      kind: 'cell-set',
      rowId: 'ins:fake-ov-1#0',
      column: 'id',
      value: { kind: 'number', value: 77 },
    },
    { kind: 'cell-revert', rowId: 'ins:fake-ov-1#0', column: 'id' },
    // Rename after the edit: the edit follows the renamed column.
    { kind: 'column-rename', from: 'label', to: 'label_v2' },
  ],
  effectiveSchema: [
    { name: 'id', type: 'BIGINT' },
    { name: 'label_v2', type: 'VARCHAR' },
  ],
  liveRowCount: 5,
  rowIds: [
    'ins:fake-ov-1#0',
    'base:fake-base-v1#0',
    'base:fake-base-v1#1',
    'base:fake-base-v1#2',
    'base:fake-base-v1#3',
  ],
  rowIdColumn: 'assay_row_id',
  columns: [
    // The reverted edit falls back to the insert's id 50.
    { name: 'id', values: ['50', '1', '2', '3', '4'] },
    // The retained edit wins over the insert's 'original'.
    { name: 'label_v2', values: ['=SUM(A1:A2)', '=SUM(A1:A2)', 'b', null, '-1+1'] },
  ],
  exports: [
    {
      format: 'csv',
      roundTrip: 'engine',
      rowCount: 5,
      columns: [
        { name: 'id', values: ['50', '1', '2', '3', '4'] },
        { name: 'label_v2', values: ["'=SUM(A1:A2)", "'=SUM(A1:A2)", 'b', null, "'-1+1"] },
      ],
    },
    {
      format: 'jsonl',
      roundTrip: 'engine',
      rowCount: 5,
      columns: [
        { name: 'id', values: ['50', '1', '2', '3', '4'] },
        { name: 'label_v2', values: ['=SUM(A1:A2)', '=SUM(A1:A2)', 'b', null, '-1+1'] },
      ],
    },
  ],
}

/**
 * The m4-4b cast-check dataset the fake subject declares, in miniature: a
 * base with all-numeric values (`num`, `ins_code`, `legacy`), one
 * mid-dataset bad value (`code`), an all-NULL column (`blank`), a rename
 * (`legacy` -> `renamed`) with a post-rename bad edit, and an inserted bad
 * `ins_code`. The cases cover the classifications a 1-row probe cannot:
 * a bad value mid-dataset, a bad value only in an inserted row, a bad value
 * after a rename, and the all-convertible/all-NULL `false` cases.
 */
const FAKE_CAST_CHECK_BASE: ConformanceOverlayBase = {
  baseAnchor: 'fake-cast-base-v1',
  overlayAnchor: 'fake-cast-ov-1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'num', type: 'VARCHAR' },
    { name: 'code', type: 'VARCHAR' },
    { name: 'ins_code', type: 'VARCHAR' },
    { name: 'blank', type: 'VARCHAR' },
    { name: 'legacy', type: 'VARCHAR' },
    { name: 'chain', type: 'VARCHAR' },
    { name: 'edited_chain', type: 'VARCHAR' },
    { name: 'blobby', type: 'VARCHAR' },
    { name: 'neighbor', type: 'VARCHAR' },
  ],
  baseRowCount: 4,
}

/** The fake's cast-check base rows in natural order (mirrors the base above). */
const FAKE_CAST_CHECK_ROWS: readonly Record<string, string | number | null>[] = [
  {
    id: 1,
    num: '10',
    code: '10',
    ins_code: '1',
    blank: null,
    legacy: '10',
    chain: 'true',
    edited_chain: '0',
    blobby: '1',
    neighbor: '10',
  },
  {
    id: 2,
    num: '20',
    code: '20',
    ins_code: '2',
    blank: null,
    legacy: '20',
    chain: 'false',
    edited_chain: '1',
    blobby: '2',
    neighbor: '20',
  },
  {
    id: 3,
    num: '30',
    code: 'bad',
    ins_code: '3',
    blank: null,
    legacy: '30',
    chain: 'true',
    edited_chain: '1',
    blobby: '3',
    neighbor: '30',
  },
  {
    id: 4,
    num: '40',
    code: '40',
    ins_code: '4',
    blank: null,
    legacy: '40',
    chain: 'false',
    edited_chain: '0',
    blobby: '4',
    neighbor: '40',
  },
]

const FAKE_CAST_CHECK_DATASET: ConformanceOverlayCastCheckDataset = {
  base: FAKE_CAST_CHECK_BASE,
  ops: [
    { kind: 'column-rename', from: 'legacy', to: 'renamed' },
    {
      kind: 'cell-set',
      rowId: 'base:fake-cast-base-v1#1',
      column: 'renamed',
      value: { kind: 'string', value: 'not-a-number' },
    },
    // The review's chain (`chain`), a prior-cast-plus-edit column
    // (`edited_chain`), and the symmetric false-positive column (`blobby`).
    { kind: 'column-cast', column: 'chain', targetType: 'BOOLEAN' },
    { kind: 'column-cast', column: 'edited_chain', targetType: 'BOOLEAN' },
    { kind: 'column-cast', column: 'blobby', targetType: 'BLOB' },
    {
      kind: 'cell-set',
      rowId: 'base:fake-cast-base-v1#0',
      column: 'edited_chain',
      value: { kind: 'text', text: 'true' },
    },
    {
      kind: 'row-insert',
      rowId: 'ins:fake-cast-ov-1#0',
      position: { kind: 'end' },
      values: new Map([
        ['id', { kind: 'number', value: 100 }],
        ['ins_code', { kind: 'string', value: 'oops' }],
      ]),
    },
  ],
  cases: [
    {
      label: 'all-convertible numeric column',
      column: 'num',
      targetType: 'BIGINT',
      hasNonConvertibleValues: false,
    },
    {
      label: 'bad value mid-dataset',
      column: 'code',
      targetType: 'BIGINT',
      hasNonConvertibleValues: true,
    },
    {
      label: 'bad value only in an inserted row',
      column: 'ins_code',
      targetType: 'BIGINT',
      hasNonConvertibleValues: true,
    },
    {
      label: 'bad value after a rename',
      column: 'renamed',
      targetType: 'BIGINT',
      hasNonConvertibleValues: true,
    },
    {
      label: 'all-NULL column',
      column: 'blank',
      targetType: 'BIGINT',
      hasNonConvertibleValues: false,
    },
    {
      label: 'prior cast A->B then check B->C (review chain)',
      column: 'chain',
      targetType: 'INTEGER',
      hasNonConvertibleValues: true,
    },
    {
      label: 'prior cast plus a same-column edit',
      column: 'edited_chain',
      targetType: 'INTEGER',
      hasNonConvertibleValues: true,
    },
    {
      label: 'prior cast intermediate fails but direct base cast succeeds',
      column: 'blobby',
      targetType: 'INTEGER',
      hasNonConvertibleValues: false,
    },
    {
      label: 'unaffected by a prior cast on a different column',
      column: 'neighbor',
      targetType: 'BIGINT',
      hasNonConvertibleValues: false,
    },
  ],
  // Agreement battery (m4-4b round 3), in miniature: the fake models the
  // committed cast with the same effective-value conversion the check uses,
  // so a one-sided mutation (`castCheckAlwaysFalse/True`) breaks agreement.
  agreements: [
    {
      label: 'all-convertible base, target INTEGER (commit succeeds)',
      ops: [],
      column: 'num',
      targetType: 'INTEGER',
      hasNonConvertibleValues: false,
    },
    {
      label: 'bad base value, target INTEGER (commit throws)',
      ops: [],
      column: 'code',
      targetType: 'INTEGER',
      hasNonConvertibleValues: true,
    },
    {
      label: 'prior cast plus an edit, target INTEGER (commit throws)',
      ops: [
        { kind: 'column-cast', column: 'chain', targetType: 'BOOLEAN' },
        {
          kind: 'cell-set',
          rowId: 'base:fake-cast-base-v1#0',
          column: 'chain',
          value: { kind: 'text', text: 'true' },
        },
      ],
      column: 'chain',
      targetType: 'INTEGER',
      hasNonConvertibleValues: true,
    },
    {
      // m4-4b round-4 shape: a prior cast, a cross-type edit, and a delete.
      // The dead edit is not part of the logical view, so both the check and
      // the committed materialization must answer false.
      label: 'prior cast plus edit plus row-delete, target INTEGER (commit succeeds)',
      ops: [
        { kind: 'column-cast', column: 'edited_chain', targetType: 'BOOLEAN' },
        {
          kind: 'cell-set',
          rowId: 'base:fake-cast-base-v1#2',
          column: 'edited_chain',
          value: { kind: 'text', text: 'nope' },
        },
        { kind: 'row-delete', rowId: 'base:fake-cast-base-v1#2' },
      ],
      column: 'edited_chain',
      targetType: 'INTEGER',
      hasNonConvertibleValues: false,
    },
  ],
  invalidTargetTypes: ['VARCHAR()', 'DECIMAL(1,2,3)', 'BIGINT; DROP TABLE fake_cast_probe'],
  unknownColumns: ['legacy', 'no_such_column'],
}

/** The m4-2 review's exact injection payload (finding 1). */
const FAKE_REVIEWER_PAYLOAD =
  'VARCHAR) AS "c" FROM (...) ); CREATE TABLE fake_injected AS SELECT 31337; --'

/**
 * Fake hostile type probes (m4-2 fix round): the same shapes the DuckDB
 * subject declares, in miniature. The fake's `overlaySchema` rejects them
 * with a typed operation error unless the `acceptsHostileTypes` mutation
 * makes it accept — proving the scenario's assertion bites.
 */
const FAKE_HOSTILE_TYPE_PROBES: readonly ConformanceHostileTypeProbe[] = [
  {
    label: 'hostile column-cast target type (review payload)',
    injectedTable: 'fake_injected',
    overlay: {
      base: FAKE_OVERLAY_BASE,
      ops: [{ kind: 'column-cast', column: 'label', targetType: FAKE_REVIEWER_PAYLOAD }],
    },
  },
  {
    label: 'hostile base column type',
    injectedTable: 'fake_base_injected',
    overlay: {
      base: {
        ...FAKE_OVERLAY_BASE,
        columns: FAKE_OVERLAY_BASE.columns.map((column) =>
          column.name === 'label' ? { name: column.name, type: FAKE_REVIEWER_PAYLOAD } : column,
        ),
      },
      ops: [],
    },
  },
]

/**
 * m5-2 validation dataset the fake subject declares, in miniature: a 6-row
 * typed table whose contract covers ALL eleven v1 rule kinds, plus the
 * overlay-interaction battery (fix/violate/insert/tombstone/row-count facts),
 * the K-clamp truncation, and hostile plans. The fake's `validate`
 * implementation evaluates the REAL compiled plan's ruleIds against these
 * typed rows (the fake has no SQL engine; the per-rule VALUES live in
 * {@link FAKE_VALIDATION_RULE_SEMANTICS}, keyed by the plan's ruleId
 * spellings, consistent with the declared contract below). All expectations
 * are hand-written literals independent of the evaluator, so mutation knobs
 * make the two disagree.
 */
const FAKE_VALIDATION_ROWS: readonly { id: number; label: string | null; flag: boolean }[] = [
  { id: 1, label: 'x', flag: true },
  { id: 2, label: 'x', flag: true },
  { id: 3, label: null, flag: true },
  { id: 4, label: 'x', flag: false },
  { id: -5, label: 'E', flag: true },
  { id: 2, label: 'x', flag: true },
]

const FAKE_VALIDATION_BASE: ConformanceOverlayBase = {
  baseAnchor: 'fake-val-v1',
  overlayAnchor: 'fake-val-ov-1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'label', type: 'VARCHAR' },
    { name: 'flag', type: 'BOOLEAN' },
  ],
  baseRowCount: 6,
}

/** The fake schema the contract binds against (schema() reports this). */
const FAKE_VALIDATION_SCHEMA = FAKE_VALIDATION_BASE.columns

/** The fake's documented sample clamp (mirrors the engine's hard max). */
const FAKE_VALIDATION_SAMPLE_MAX = 3

/** The binding name the fake plans use. */
const FAKE_VALIDATION_RELATION = 'fake_validation_src'

/** The view name the fake guard refuses to shadow (the assay_t1 analog). */
const FAKE_OWNED_VIEW = 'fake-owned-view'

/** The contract every fake plan is compiled from (canonical YAML). */
const FAKE_VALIDATION_CONTRACT_YAML = `format: v1
name: fake-validation
version: 1
columns:
  - name: id
    type: BIGINT
    required: true
    unique: true
    min: 0
  - name: label
    required: true
    allowed-values: [a, b]
    regex: '^[a-z]+$'
    max-null-share: 0.5
  - name: flag
    required: true
    allowed-values: [true]
dataset:
  min-rows: 5
  max-rows: 10
`

/** The fake's canonical row-id for a base ordinal. */
function fakeValKey(ordinal: number): string {
  return `base:${FAKE_VALIDATION_BASE.baseAnchor}#${String(ordinal)}`
}

/**
 * Per-rule semantics keyed by the plan's ruleId (the contract's meaning —
 * the fake evaluator cannot read SQL). These are the values the contract
 * above declares, in the plan's ruleId spelling.
 */
const FAKE_VALIDATION_RULE_SEMANTICS: Record<
  string,
  {
    readonly kind: string
    readonly column?: string
    readonly expectedType?: string
    readonly bound?: number
    readonly values?: readonly (string | number | boolean)[]
    readonly share?: number
  }
> = {
  'columns[0].type': { kind: 'declared-type', column: 'id', expectedType: 'BIGINT' },
  'columns[0].required': { kind: 'required', column: 'id' },
  'columns[0].unique': { kind: 'unique', column: 'id' },
  'columns[0].min': { kind: 'min', column: 'id', bound: 0 },
  'columns[1].required': { kind: 'required', column: 'label' },
  'columns[1].allowed-values': { kind: 'allowed-values', column: 'label', values: ['a', 'b'] },
  'columns[1].regex': { kind: 'regex', column: 'label' },
  'columns[1].max-null-share': { kind: 'max-null-share', column: 'label', share: 0.5 },
  'columns[2].required': { kind: 'required', column: 'flag' },
  'columns[2].allowed-values': { kind: 'allowed-values', column: 'flag', values: [true] },
  'dataset.min-rows': { kind: 'min-rows', bound: 5 },
  'dataset.max-rows': { kind: 'max-rows', bound: 10 },
}

/** A typed value row of the fake's effective validation view. */
interface FakeValRow {
  readonly key: string
  readonly cells: ReadonlyMap<string, string | number | boolean | null>
}

/**
 * The fake's effective validation rows under an overlay: base order minus
 * tombstones with edits overlaid, then live inserts in seq order with their
 * edits merged — the miniature of the composed effective relation. Values
 * stay TYPED (numbers compare numerically; booleans stay boolean).
 */
function fakeValidationRows(ops: readonly ConformanceEditOp[]): FakeValRow[] {
  const state = foldFakeOverlay(FAKE_VALIDATION_BASE, ops, {})
  const typed = (value: ConformanceCellValue | undefined): string | number | boolean | null => {
    if (value === undefined || value.kind === 'null') return null
    if (value.kind === 'boolean') return value.value
    if (value.kind === 'number') return value.value
    return value.kind === 'text' ? value.text : value.value
  }
  const rows: FakeValRow[] = []
  for (let ordinal = 0; ordinal < FAKE_VALIDATION_BASE.baseRowCount; ordinal++) {
    if (state.deletedBase.has(ordinal)) continue
    const key = fakeValKey(ordinal)
    const base = FAKE_VALIDATION_ROWS[ordinal]!
    const cells = new Map<string, string | number | boolean | null>([
      ['id', base.id],
      ['label', base.label],
      ['flag', base.flag],
    ])
    for (const [column, value] of state.edits.get(key) ?? []) {
      cells.set(column, typed(value))
    }
    rows.push({ key, cells })
  }
  const inserts = [...state.inserts.values()]
    .filter((record) => record.live)
    .sort((a, b) => a.seq - b.seq)
  for (const record of inserts) {
    const cells = new Map<string, string | number | boolean | null>()
    for (const column of FAKE_VALIDATION_BASE.columns) {
      const edit = state.edits.get(record.id)?.get(column.name)
      cells.set(
        column.name,
        edit !== undefined ? typed(edit) : typed(record.values.get(column.name)),
      )
    }
    rows.push({ key: record.id, cells })
  }
  return rows
}

/** The full-match regex the fake's label contract declares (`^[a-z]+$`). */
const FAKE_LABEL_REGEX = /^[a-z]+$/

/**
 * The fake's honest rule evaluator: the plan's ruleId selects the declared
 * semantics; the effective rows produce {failCount, samples} per the
 * documented m5-1 semantics (NULL-passing value rules, full-match regex,
 * occurrence-counted unique, share facts, row-count bounds).
 */
function fakeEvaluateRule(
  ruleId: string,
  rows: readonly FakeValRow[],
): { readonly failCount: number; readonly samples: ConformanceValidationSample[] } {
  const semantics = FAKE_VALIDATION_RULE_SEMANTICS[ruleId]
  if (semantics === undefined) throw new FakeQueryError('fake validate: unknown rule semantics')
  if (semantics.kind === 'declared-type') {
    const schemaType = FAKE_VALIDATION_SCHEMA.find(
      (column) => column.name === semantics.column,
    )?.type
    return { failCount: schemaType === semantics.expectedType ? 0 : 1, samples: [] }
  }
  if (semantics.kind === 'min-rows' || semantics.kind === 'max-rows') {
    const count = rows.length
    const violated =
      semantics.kind === 'min-rows'
        ? count < (semantics.bound ?? 0)
        : count > (semantics.bound ?? 0)
    return { failCount: violated ? 1 : 0, samples: [] }
  }
  const column = semantics.column ?? ''
  if (semantics.kind === 'max-null-share') {
    const nulls = rows.filter((row) => row.cells.get(column) === null).length
    const share = rows.length === 0 ? 0 : nulls / rows.length
    return { failCount: share > (semantics.share ?? 0) ? 1 : 0, samples: [] }
  }
  if (semantics.kind === 'min-distinct-share') {
    const nonNull = rows.filter((row) => row.cells.get(column) !== null)
    const distinct = new Set(nonNull.map((row) => String(row.cells.get(column)))).size
    const violated = nonNull.length > 0 && distinct / nonNull.length < (semantics.share ?? 0)
    return { failCount: violated ? 1 : 0, samples: [] }
  }
  const samples: ConformanceValidationSample[] = []
  let failCount = 0
  if (semantics.kind === 'unique') {
    const occurrences = new Map<string, number>()
    for (const row of rows) {
      const value = row.cells.get(column) ?? null
      if (value === null) continue
      occurrences.set(String(value), (occurrences.get(String(value)) ?? 0) + 1)
    }
    for (const row of rows) {
      const value = row.cells.get(column) ?? null
      if (value !== null && (occurrences.get(String(value)) ?? 0) > 1) {
        failCount += 1
        samples.push({ rowKey: row.key, value })
      }
    }
    return { failCount, samples }
  }
  for (const row of rows) {
    const value = row.cells.get(column) ?? null
    let violated = false
    if (semantics.kind === 'required') violated = value === null
    else if (value !== null) {
      if (semantics.kind === 'min')
        violated = typeof value === 'number' && value < (semantics.bound ?? 0)
      else if (semantics.kind === 'max')
        violated = typeof value === 'number' && value > (semantics.bound ?? 0)
      else if (semantics.kind === 'allowed-values')
        violated = !(semantics.values ?? []).some((entry) => entry === value)
      else if (semantics.kind === 'regex')
        violated = typeof value === 'string' && !FAKE_LABEL_REGEX.test(value)
    }
    if (violated) {
      failCount += 1
      samples.push({ rowKey: row.key, value })
    }
  }
  return { failCount, samples }
}

/**
 * The fake's plan-shape guard (the mirror of the engine's boundary, m5-2
 * fix round + round 3): the m5-0 rule-id grammar, statement shape (comments
 * refused outright — the mirror of the engine's SQL-aware scan), relation
 * binding, and the safe-K domain (over-max K is clamped by the fake's
 * evaluator, never refused).
 */
function fakeAssertPlanValid(plan: ConformanceValidationPlan): void {
  if (plan.planKind !== 'assay-validation-plan' || plan.planVersion !== 1) {
    throw new FakeOperationError('unknown validation plan kind/version')
  }
  if (
    typeof plan.contractName !== 'string' ||
    typeof plan.relation !== 'string' ||
    plan.relation.length === 0 ||
    typeof plan.sampleLimit !== 'number' ||
    !Number.isSafeInteger(plan.sampleLimit) ||
    plan.sampleLimit < 1 ||
    !Array.isArray(plan.rules) ||
    typeof plan.summarySql !== 'string'
  ) {
    throw new FakeOperationError('malformed validation plan')
  }
  if (plan.relation === FAKE_OWNED_VIEW) {
    throw new FakeOperationError('validation plan relation collides with a registered view')
  }
  // A plan bound to a name that already exists as a user-created view fails
  // its materialization (the fake's catalog mirror; the survival probe).
  if (subjectState.createdViews.has(plan.relation)) {
    throw new FakeOperationError('validation binding name already exists in the catalog')
  }
  const quoted = `"${plan.relation}"`
  // The mirror of the engine's SQL-aware scan: track quoted regions; any
  // comment outside them is refused outright (the compiler emits none).
  const singleSelect = (sql: string): boolean => {
    if (!/^\s*select\b/i.test(sql)) return false
    let inSingle = false
    let inDouble = false
    for (let index = 0; index < sql.length; index++) {
      const character = sql[index]
      if (inSingle) {
        if (character === "'") inSingle = false
      } else if (inDouble) {
        if (character === '"') inDouble = false
      } else if (character === "'") {
        inSingle = true
      } else if (character === '"') {
        inDouble = true
      } else if (
        (character === '-' && sql[index + 1] === '-') ||
        (character === '/' && sql[index + 1] === '*')
      ) {
        return false
      } else if (character === ';' && sql.slice(index + 1).trim() !== '') {
        return false
      }
    }
    return !inSingle && !inDouble
  }
  for (const rule of [...plan.rules]) {
    if (typeof rule.ruleId !== 'string' || typeof rule.sql !== 'string') {
      throw new FakeOperationError('malformed validation rule')
    }
    // The m5-0 rule-id grammar (W1 mirror): failure-class interpolation can
    // only ever carry compiler-shaped ids.
    if (
      !/^(?:columns\[(?:0|[1-9][0-9]*)\]\.(?:type|required|unique|min|max|allowed-values|regex|max-null-share|min-distinct-share)|dataset\.(?:min-rows|max-rows))$/.test(
        rule.ruleId,
      )
    ) {
      throw new FakeOperationError('malformed validation rule id')
    }
    if (!singleSelect(rule.sql)) {
      throw new FakeOperationError(
        `rule '${rule.ruleId}' is not a single compiler-shaped SELECT query`,
      )
    }
    if (!rule.sql.includes(`FROM ${quoted}`)) {
      throw new FakeOperationError(
        `rule '${rule.ruleId}' does not bind its relation in the compiler FROM shape`,
      )
    }
  }
  if (!singleSelect(plan.summarySql)) {
    throw new FakeOperationError(
      'validation plan summary is not a single compiler-shaped SELECT query',
    )
  }
  if (plan.rules.length > 0 && !plan.summarySql.includes(`FROM ${quoted}`)) {
    throw new FakeOperationError(
      'validation plan summary does not bind its relation in the compiler FROM shape',
    )
  }
}

/** A hand-built hostile plan probe (structural mirror of the wire plan). */
function fakeHostilePlan(
  label: string,
  overrides: Partial<ConformanceValidationPlan>,
): ConformanceHostileValidationPlan {
  return {
    label,
    plan: {
      planKind: 'assay-validation-plan',
      planVersion: 1,
      contractName: 'conf',
      contractVersion: 1,
      relation: FAKE_VALIDATION_RELATION,
      sampleLimit: FAKE_VALIDATION_SAMPLE_MAX,
      rules: [
        {
          ruleId: 'columns[0].required',
          path: 'columns[0].required',
          kind: 'required',
          column: 'id',
          outcome: 'row-samples',
          sql: `SELECT 1 FROM "${FAKE_VALIDATION_RELATION}" AS "src"`,
        },
      ],
      summarySql: `SELECT 'columns[0].required' AS "rule_id" FROM "${FAKE_VALIDATION_RELATION}" AS "src"`,
      ...overrides,
    },
  }
}

/** The fake's per-rule expectation literals (base run; rowCount 6). */
const FAKE_VALIDATION_BASE_RULES: readonly ConformanceValidationRuleExpectation[] = [
  { ruleId: 'columns[0].type', failCount: 0, failPercent: 0 },
  { ruleId: 'columns[0].required', failCount: 0, failPercent: 0 },
  {
    ruleId: 'columns[0].unique',
    failCount: 2,
    failPercent: 33,
    samples: [
      { rowKey: fakeValKey(1), value: 2 },
      { rowKey: fakeValKey(5), value: 2 },
    ],
  },
  {
    ruleId: 'columns[0].min',
    failCount: 1,
    failPercent: 17,
    samples: [{ rowKey: fakeValKey(4), value: -5 }],
  },
  {
    ruleId: 'columns[1].required',
    failCount: 1,
    failPercent: 17,
    samples: [{ rowKey: fakeValKey(2), value: null }],
  },
  {
    // Five violations exceed the fake's documented clamp (3), so the
    // reported list is clamped — the first sample is what gets pinned here
    // (the full-list pin lives on the rules at or under the clamp).
    ruleId: 'columns[1].allowed-values',
    failCount: 5,
    failPercent: 83,
    firstSample: { rowKey: fakeValKey(0), value: 'x' },
  },
  {
    ruleId: 'columns[1].regex',
    failCount: 1,
    failPercent: 17,
    samples: [{ rowKey: fakeValKey(4), value: 'E' }],
  },
  { ruleId: 'columns[1].max-null-share', failCount: 0, failPercent: 0 },
  { ruleId: 'columns[2].required', failCount: 0, failPercent: 0 },
  {
    ruleId: 'columns[2].allowed-values',
    failCount: 1,
    failPercent: 17,
    samples: [{ rowKey: fakeValKey(3), value: false }],
  },
  { ruleId: 'dataset.min-rows', failCount: 0, failPercent: 0 },
  { ruleId: 'dataset.max-rows', failCount: 0, failPercent: 0 },
]

/**
 * The empty-overlay run's rules. The fake always keys rows by its declared
 * baseAnchor (it has no empty-anchor base mode — that distinction is pinned
 * by the real engine-duckdb subject), so its expectations are the same
 * literals as the base run.
 */
const FAKE_VALIDATION_EMPTY_OVERLAY_RULES: readonly ConformanceValidationRuleExpectation[] =
  FAKE_VALIDATION_BASE_RULES

const FAKE_VALIDATION_DATASET: ConformanceValidationDataset = {
  contractYaml: FAKE_VALIDATION_CONTRACT_YAML,
  planRelation: FAKE_VALIDATION_RELATION,
  // The fake's own hard max (3): plans at or past it EXECUTE (m5-2 round-3
  // semantics — any safe K ≥ 1 is accepted and clamped to the hard max by
  // the fake's evaluator).
  sampleLimit: FAKE_VALIDATION_SAMPLE_MAX,
  base: FAKE_VALIDATION_BASE,
  baseExpectations: {
    valid: false,
    rowCount: 6,
    rules: FAKE_VALIDATION_BASE_RULES,
  },
  emptyOverlayExpectations: {
    valid: false,
    rowCount: 6,
    rules: FAKE_VALIDATION_EMPTY_OVERLAY_RULES,
  },
  interactions: [
    {
      label: 'fix-one: the negative id is edited into range (min flips to clean)',
      ops: [
        {
          kind: 'cell-set',
          rowId: fakeValKey(4),
          column: 'id',
          value: { kind: 'number', value: 9 },
        },
      ],
      expectations: {
        valid: false,
        rowCount: 6,
        rules: FAKE_VALIDATION_BASE_RULES.map((rule) =>
          rule.ruleId === 'columns[0].min'
            ? { ...rule, failCount: 0, failPercent: 0, samples: [] }
            : rule,
        ),
      },
    },
    {
      label: 'violate-one: a passing flag is flipped (allowed-values 1 -> 2)',
      ops: [
        {
          kind: 'cell-set',
          rowId: fakeValKey(0),
          column: 'flag',
          value: { kind: 'boolean', value: false },
        },
      ],
      expectations: {
        valid: false,
        rowCount: 6,
        rules: FAKE_VALIDATION_BASE_RULES.map((rule) =>
          rule.ruleId === 'columns[2].allowed-values'
            ? {
                ...rule,
                failCount: 2,
                failPercent: 33,
                samples: [
                  { rowKey: fakeValKey(0), value: false },
                  { rowKey: fakeValKey(3), value: false },
                ],
              }
            : rule,
        ),
      },
    },
    {
      label: 'insert-violating: a duplicated id arrives (unique 2 -> 3, under its ins: key)',
      ops: [
        {
          kind: 'row-insert',
          rowId: 'ins:fake-val-ov-1#0',
          position: { kind: 'end' },
          values: new Map([
            ['id', { kind: 'number' as const, value: 2 }],
            ['label', { kind: 'string' as const, value: 'b' }],
            ['flag', { kind: 'boolean' as const, value: true }],
          ]),
        },
      ],
      expectations: {
        valid: false,
        rowCount: 7,
        rules: FAKE_VALIDATION_BASE_RULES.map((rule) => {
          // Percents are pinned against the NEW row count (the formula runs
          // over failCount/rowCount of THIS run).
          if (rule.ruleId === 'columns[0].unique') {
            return {
              ...rule,
              failCount: 3,
              failPercent: 43,
              samples: [
                { rowKey: fakeValKey(1), value: 2 },
                { rowKey: fakeValKey(5), value: 2 },
                { rowKey: 'ins:fake-val-ov-1#0', value: 2 },
              ],
            }
          }
          const at7: Record<string, number> = {
            'columns[0].min': 14,
            'columns[1].required': 14,
            'columns[1].allowed-values': 71,
            'columns[1].regex': 14,
            'columns[2].allowed-values': 14,
          }
          if (rule.ruleId in at7) {
            return { ...rule, failPercent: at7[rule.ruleId] ?? rule.failPercent }
          }
          return rule
        }),
      },
    },
    {
      label: 'tombstone: the violating row is deleted (min and regex flip to clean)',
      ops: [{ kind: 'row-delete', rowId: fakeValKey(4) }],
      expectations: {
        valid: false,
        rowCount: 5,
        rules: FAKE_VALIDATION_BASE_RULES.map((rule) => {
          const at5: Record<string, number> = {
            'columns[0].unique': 40,
            'columns[1].required': 20,
            'columns[2].allowed-values': 20,
          }
          if (rule.ruleId in at5) {
            return { ...rule, failPercent: at5[rule.ruleId] ?? rule.failPercent }
          }
          if (rule.ruleId === 'columns[0].min')
            return { ...rule, failCount: 0, failPercent: 0, samples: [] }
          if (rule.ruleId === 'columns[1].regex')
            return { ...rule, failCount: 0, failPercent: 0, samples: [] }
          if (rule.ruleId === 'columns[1].allowed-values') {
            const ruleWithoutSamples = Object.fromEntries(
              Object.entries(rule).filter(([key]) => key !== 'samples'),
            ) as typeof rule
            return {
              ...ruleWithoutSamples,
              failCount: 4,
              failPercent: 80,
              firstSample: { rowKey: fakeValKey(0), value: 'x' },
            }
          }
          return rule
        }),
      },
    },
    {
      label: 'insert-until-max: five clean inserts push past max-rows (fact flips to failing)',
      ops: [0, 1, 2, 3, 4].map((seq): ConformanceEditOp => ({
        kind: 'row-insert',
        rowId: `ins:fake-val-ov-1#${String(seq)}`,
        position: { kind: 'end' },
        values: new Map([
          ['id', { kind: 'number' as const, value: 100 + seq }],
          ['label', { kind: 'string' as const, value: 'a' }],
          ['flag', { kind: 'boolean' as const, value: true }],
        ]),
      })),
      expectations: {
        valid: false,
        rowCount: 11,
        rules: FAKE_VALIDATION_BASE_RULES.map((rule) => {
          if (rule.ruleId === 'dataset.max-rows') return { ...rule, failCount: 1, failPercent: 9 }
          const at11: Record<string, number> = {
            'columns[0].unique': 18,
            'columns[0].min': 9,
            'columns[1].required': 9,
            'columns[1].allowed-values': 45,
            'columns[1].regex': 9,
            'columns[2].allowed-values': 9,
          }
          if (rule.ruleId in at11) {
            return { ...rule, failPercent: at11[rule.ruleId] ?? rule.failPercent }
          }
          return rule
        }),
      },
    },
    {
      label: 'delete-until-min: three deletes drop below min-rows (fact flips; unique clears)',
      ops: [
        { kind: 'row-delete', rowId: fakeValKey(0) },
        { kind: 'row-delete', rowId: fakeValKey(1) },
        { kind: 'row-delete', rowId: fakeValKey(2) },
      ],
      expectations: {
        valid: false,
        rowCount: 3,
        rules: FAKE_VALIDATION_BASE_RULES.map((rule) => {
          const at3: Record<string, number> = {
            'columns[0].min': 33,
            'columns[1].regex': 33,
            'columns[2].allowed-values': 33,
          }
          if (rule.ruleId in at3) {
            return { ...rule, failPercent: at3[rule.ruleId] ?? rule.failPercent }
          }
          if (rule.ruleId === 'dataset.min-rows') return { ...rule, failCount: 1, failPercent: 33 }
          if (rule.ruleId === 'columns[0].unique')
            return { ...rule, failCount: 0, failPercent: 0, samples: [] }
          if (rule.ruleId === 'columns[1].required')
            return { ...rule, failCount: 0, failPercent: 0, samples: [] }
          if (rule.ruleId === 'columns[1].allowed-values') {
            return {
              ...rule,
              failCount: 3,
              failPercent: 100,
              samples: [
                { rowKey: fakeValKey(3), value: 'x' },
                { rowKey: fakeValKey(4), value: 'E' },
                { rowKey: fakeValKey(5), value: 'x' },
              ],
            }
          }
          return rule
        }),
      },
    },
  ],
  truncation: {
    ruleId: 'columns[1].allowed-values',
    hardMax: FAKE_VALIDATION_SAMPLE_MAX,
    clampedSampleLimit: FAKE_VALIDATION_SAMPLE_MAX + 1,
    expectFailCount: 5,
    expectSamples: FAKE_VALIDATION_SAMPLE_MAX,
    expectFirstRowKey: fakeValKey(0),
    expectFirstValue: 'x',
  },
  hostilePlans: [
    fakeHostilePlan('wrong planKind', { planKind: 'assay-validation-plan-v2' }),
    fakeHostilePlan('sampleLimit below 1', { sampleLimit: 0 }),
    fakeHostilePlan('relation shadows a registered view', { relation: FAKE_OWNED_VIEW }),
    fakeHostilePlan('relation token smuggled outside the FROM shape', {
      rules: [
        {
          ruleId: 'columns[0].required',
          path: 'columns[0].required',
          kind: 'required',
          column: 'id',
          outcome: 'row-samples',
          sql: `SELECT 1 AS "c" WHERE "${FAKE_VALIDATION_RELATION}" IS NULL; CREATE TABLE fake_validation_injected AS SELECT 1`,
        },
      ],
    }),
    {
      label: 'canary CREATE TABLE without a relation occurrence',
      plan: {
        planKind: 'assay-validation-plan',
        planVersion: 1,
        contractName: 'conf',
        contractVersion: 1,
        relation: FAKE_VALIDATION_RELATION,
        sampleLimit: FAKE_VALIDATION_SAMPLE_MAX,
        rules: [
          {
            ruleId: 'columns[0].required',
            path: 'columns[0].required',
            kind: 'required',
            column: 'id',
            outcome: 'row-samples',
            sql: 'CREATE TABLE fake_review_injected AS SELECT 1',
          },
        ],
        summarySql: `SELECT 'columns[0].required' AS "rule_id" FROM "${FAKE_VALIDATION_RELATION}" AS "src"`,
      },
    },
    {
      label: 'canary CREATE TABLE with a compiler-shaped relation occurrence',
      plan: {
        planKind: 'assay-validation-plan',
        planVersion: 1,
        contractName: 'conf',
        contractVersion: 1,
        relation: FAKE_VALIDATION_RELATION,
        sampleLimit: FAKE_VALIDATION_SAMPLE_MAX,
        rules: [
          {
            ruleId: 'columns[0].required',
            path: 'columns[0].required',
            kind: 'required',
            column: 'id',
            outcome: 'row-samples',
            sql: `CREATE TABLE fake_review_injected AS SELECT * FROM "${FAKE_VALIDATION_RELATION}" AS "src" WHERE FALSE`,
          },
        ],
        summarySql: `SELECT 'columns[0].required' AS "rule_id" FROM "${FAKE_VALIDATION_RELATION}" AS "src"`,
      },
    },
    // m5-2 round 3, item 1: comment-bearing SQL is refused outright — the
    // reviewer's block-comment pseudo-reference and a `--` tail comment
    // each reject with one typed operation error, never executed.
    {
      label: 'block-comment pseudo-reference (review round-3 probe)',
      plan: {
        planKind: 'assay-validation-plan',
        planVersion: 1,
        contractName: 'conf',
        contractVersion: 1,
        relation: FAKE_VALIDATION_RELATION,
        sampleLimit: FAKE_VALIDATION_SAMPLE_MAX,
        rules: [
          {
            ruleId: 'columns[0].required',
            path: 'columns[0].required',
            kind: 'required',
            column: 'id',
            outcome: 'row-samples',
            sql: `SELECT 1 AS "c" /* FROM "${FAKE_VALIDATION_RELATION}" AS "src" */`,
          },
        ],
        summarySql: `SELECT 'columns[0].required' AS "rule_id" FROM "${FAKE_VALIDATION_RELATION}" AS "src"`,
      },
    },
    {
      label: 'line-comment tail',
      plan: {
        planKind: 'assay-validation-plan',
        planVersion: 1,
        contractName: 'conf',
        contractVersion: 1,
        relation: FAKE_VALIDATION_RELATION,
        sampleLimit: FAKE_VALIDATION_SAMPLE_MAX,
        rules: [
          {
            ruleId: 'columns[0].required',
            path: 'columns[0].required',
            kind: 'required',
            column: 'id',
            outcome: 'row-samples',
            sql: `SELECT 1 AS "c" FROM "${FAKE_VALIDATION_RELATION}" AS "src" -- tail`,
          },
        ],
        summarySql: `SELECT 'columns[0].required' AS "rule_id" FROM "${FAKE_VALIDATION_RELATION}" AS "src"`,
      },
    },
  ],
  injectedTables: ['fake_validation_injected', 'fake_review_injected'],
  preExistingViewName: 'fake_review_existing',
  vocabularyPrefix: 'v_',
  decimalReportedType: 'DECIMAL(18,3)',
}

// ── m6-2: row-diff fake fixture (the suite's miniature) ────────────────────
//
// The fake has no SQL engine: its `diff` computes added/removed/changed from
// typed rows with the plan's own keys/shared columns, and the scenario's
// expectations below are hand-written literals over the same fixture (the
// m5-2 fake pattern). One mutation knob (inflated counts) makes the two
// disagree so the suite's assertions bite under Node.

const FAKE_ROW_DIFF_BASE: ConformanceOverlayBase = {
  baseAnchor: 'fake-rd-v1',
  overlayAnchor: 'fake-rd-ov-1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'val', type: 'VARCHAR' },
    { name: 'score', type: 'BIGINT' },
  ],
  baseRowCount: 132,
}

const FAKE_ROW_DIFF_SCHEMA = FAKE_ROW_DIFF_BASE.columns

interface FakeRdRow {
  /** The logical row id (grid-resolvable for A-side rows). */
  readonly key: string
  readonly cells: ReadonlyMap<string, string | number | null>
}

/** Side-A base rows: ids 1..130 plus two unmatched (removed) rows 201/202. */
const FAKE_ROW_DIFF_A_BASE_ROWS: readonly {
  readonly id: number
  readonly val: string
  readonly score: number
}[] = [
  ...Array.from({ length: 130 }, (_, index) => ({
    id: index + 1,
    val: `a${String(index + 1)}`,
    score: index + 1,
  })),
  { id: 201, val: 'gone201', score: 201 },
  { id: 202, val: 'gone202', score: 202 },
]

/**
 * Side-B rows: 130 added ids (1001..1130) first, then the 130 matching ids
 * whose shared columns alternate val/score differences.
 */
const FAKE_ROW_DIFF_B_ROWS: readonly {
  readonly id: number
  readonly val: string
  readonly score: number
}[] = [
  ...Array.from({ length: 130 }, (_, index) => ({
    id: 1001 + index,
    val: `n${String(index + 1)}`,
    score: index + 1,
  })),
  ...Array.from({ length: 130 }, (_, index) => ({
    id: index + 1,
    val: index % 2 === 0 ? `B${String(index + 1)}` : `a${String(index + 1)}`,
    score: index % 2 === 0 ? index + 1 : index + 1001,
  })),
]

/** The fake's effective A rows under an overlay (base order minus tombstones). */
function fakeRowDiffARows(ops: readonly ConformanceEditOp[], anchor: string): FakeRdRow[] {
  const state = foldFakeOverlay(FAKE_ROW_DIFF_BASE, ops, {})
  const typed = (value: ConformanceCellValue | undefined): string | number | null => {
    if (value === undefined || value.kind === 'null') return null
    if (value.kind === 'boolean') return value.value ? 1 : 0
    if (value.kind === 'number') return value.value
    return value.kind === 'text' ? value.text : value.value
  }
  const rows: FakeRdRow[] = []
  for (let ordinal = 0; ordinal < FAKE_ROW_DIFF_BASE.baseRowCount; ordinal++) {
    if (state.deletedBase.has(ordinal)) continue
    const base = FAKE_ROW_DIFF_A_BASE_ROWS[ordinal]!
    const key = `base:${anchor}#${String(ordinal)}`
    const cells = new Map<string, string | number | null>([
      ['id', base.id],
      ['val', base.val],
      ['score', base.score],
    ])
    for (const [column, value] of state.edits.get(key) ?? []) cells.set(column, typed(value))
    rows.push({ key, cells })
  }
  return rows
}

function fakeRowDiffBRows(): FakeRdRow[] {
  return FAKE_ROW_DIFF_B_ROWS.map((row, ordinal) => ({
    key: `b:${String(ordinal)}`,
    cells: new Map<string, string | number | null>([
      ['id', row.id],
      ['val', row.val],
      ['score', row.score],
    ]),
  }))
}

/** The fake's honest row-diff evaluator over typed rows (no SQL). */
function fakeRowDiffResult(
  plan: ConformanceRowDiffPlan,
  aRows: readonly FakeRdRow[],
  bRows: readonly FakeRdRow[],
  liesAboutCounts: boolean,
): ConformanceRowDiffResult {
  const keyOf = (row: FakeRdRow): string =>
    plan.keys.map((key) => `${key}=${String(row.cells.get(key) ?? '\u0000null')}`).join('\u0001')
  const bByKey = new Map<string, number>()
  bRows.forEach((row, index) => {
    if (!bByKey.has(keyOf(row))) bByKey.set(keyOf(row), index)
  })
  const aKeys = new Set(aRows.map((row) => keyOf(row)))
  const added: ConformanceRowDiffSample[] = []
  bRows.forEach((row, index) => {
    if (!aKeys.has(keyOf(row))) added.push({ side: 'B', rowKey: `b:${String(index)}` })
  })
  const removed: ConformanceRowDiffSample[] = []
  const changed: ConformanceRowDiffSample[] = []
  aRows.forEach((row) => {
    const match = bByKey.get(keyOf(row))
    if (match === undefined) {
      removed.push({ side: 'A', rowKey: row.key })
      return
    }
    const other = bRows[match]!
    const changedColumns = plan.sharedColumns.filter(
      (column) => row.cells.get(column) !== other.cells.get(column),
    )
    if (changedColumns.length > 0) {
      changed.push({ side: 'A', rowKey: row.key, changedColumns })
    }
  })
  const limit = Math.min(plan.sampleLimit, 100)
  const clamp = (samples: ConformanceRowDiffSample[]): ConformanceRowDiffSample[] =>
    samples.slice(0, limit)
  const bump = liesAboutCounts ? 1 : 0
  return {
    rowCountA: aRows.length,
    rowCountB: bRows.length,
    aspects: [
      { aspect: 'added', count: added.length + bump, samples: clamp(added) },
      { aspect: 'removed', count: removed.length + bump, samples: clamp(removed) },
      { aspect: 'changed', count: changed.length + bump, samples: clamp(changed) },
    ],
  }
}

/** Quote an identifier the way the compiler does (the fake's own renderer). */
function fakeQuoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** Blank single-quoted string contents so pseudo-references cannot count. */
function fakeBlankStrings(sql: string): string {
  let out = ''
  let index = 0
  while (index < sql.length) {
    if (sql[index] !== "'") {
      out += sql[index]
      index += 1
      continue
    }
    out += "'"
    index += 1
    while (index < sql.length) {
      if (sql[index] === "'") {
        if (sql[index + 1] === "'") {
          out += '  '
          index += 2
          continue
        }
        out += "'"
        index += 1
        break
      }
      out += ' '
      index += 1
    }
  }
  return out
}

/** The fake's structural mirror of the engine's belt-1 gate. */
function fakeAssertRowDiffPlanValid(plan: ConformanceRowDiffPlan): void {
  if (plan.planKind !== 'assay-row-diff-plan') {
    throw new FakeOperationError('malformed row-diff plan')
  }
  if (plan.planVersion !== 1) throw new FakeOperationError('malformed row-diff plan')
  if (plan.relationA === plan.relationB) {
    throw new FakeOperationError('row-diff plan binds both sides to the same relation name')
  }
  if (plan.keys.length === 0) throw new FakeOperationError('row-diff plan has no key columns')
  const quotedA = fakeQuoteIdentifier(plan.relationA)
  const quotedB = fakeQuoteIdentifier(plan.relationB)
  const assertAspect = (sql: string, label: string): void => {
    const code = fakeBlankStrings(sql)
    if (code.includes('--') || code.includes('/*')) {
      throw new FakeOperationError(`row-diff ${label} query contains SQL comments`)
    }
    const separator = code.indexOf(';')
    if (separator >= 0 && code.slice(separator + 1).trim() !== '') {
      throw new FakeOperationError(`row-diff ${label} query is not a single SELECT`)
    }
    if (!/^\s*select\b/i.test(code)) {
      throw new FakeOperationError(`row-diff ${label} query is not a single SELECT`)
    }
    if (!code.includes(`FROM ${quotedA} AS "a"`)) {
      throw new FakeOperationError(`row-diff ${label} query does not bind side A`)
    }
    if (!code.includes(`FROM ${quotedB} AS "b"`)) {
      throw new FakeOperationError(`row-diff ${label} query does not bind side B`)
    }
  }
  assertAspect(plan.addedSql, 'added')
  assertAspect(plan.removedSql, 'removed')
  assertAspect(plan.changedSql, 'changed')
  if (!plan.addedSql.includes('"assay_count"') || !plan.changedSql.includes('"assay_changed"')) {
    throw new FakeOperationError('row-diff query is missing its reserved result columns')
  }
  const arms = fakeBlankStrings(plan.totalsSql).split('UNION ALL')
  if (arms.length !== 3) throw new FakeOperationError('row-diff totals is not three arms')
  arms.forEach((arm) => {
    if (!/^\s*select\b/i.test(arm)) {
      throw new FakeOperationError('row-diff totals arm is not a SELECT')
    }
  })
}

/** A valid compiler-shaped fake plan (mutated for the hostile probes). */
function fakeRowDiffPlan(): ConformanceRowDiffPlan {
  const result = compileRowDiffPlan(FAKE_ROW_DIFF_SCHEMA, FAKE_ROW_DIFF_SCHEMA, ['id'], {
    relationA: 'fake_rd_a',
    relationB: 'fake_rd_b',
    sampleLimit: 20,
  })
  if (!result.ok) throw new Error('fake row-diff plan failed to compile')
  return result.plan
}

const FAKE_ROW_DIFF_SAMPLE_LIMIT = 20

/** The 20 changed samples at the base run: alternating val/score. */
const FAKE_ROW_DIFF_BASE_CHANGED: readonly ConformanceRowDiffSample[] = Array.from(
  { length: 20 },
  (_, index) => ({
    side: 'A' as const,
    rowKey: `base:#${String(index)}`,
    changedColumns: index % 2 === 0 ? ['val'] : ['score'],
  }),
)

const FAKE_ROW_DIFF_BASE_EXPECTATIONS: ConformanceRowDiffExpectations = {
  rowCountA: 132,
  rowCountB: 260,
  aspects: [
    {
      aspect: 'added',
      count: 130,
      samples: Array.from({ length: 20 }, (_, index) => ({
        side: 'B' as const,
        rowKey: `b:${String(index)}`,
      })),
    },
    {
      aspect: 'removed',
      count: 2,
      samples: [
        { side: 'A', rowKey: 'base:#130' },
        { side: 'A', rowKey: 'base:#131' },
      ],
    },
    { aspect: 'changed', count: 130, samples: FAKE_ROW_DIFF_BASE_CHANGED },
  ],
}

const FAKE_ROW_DIFF_DATASET: ConformanceRowDiffDataset = {
  relationA: 'fake_rd_a',
  relationB: 'fake_rd_b',
  keys: ['id'],
  base: FAKE_ROW_DIFF_BASE,
  sampleLimit: FAKE_ROW_DIFF_SAMPLE_LIMIT,
  baseExpectations: FAKE_ROW_DIFF_BASE_EXPECTATIONS,
  interactions: [
    {
      label: 'tombstone A#0 (its B match becomes added)',
      ops: [{ kind: 'row-delete', rowId: 'base:fake-rd-v1#0' }],
      expectations: {
        rowCountA: 131,
        rowCountB: 260,
        aspects: [
          { aspect: 'added', count: 131 },
          { aspect: 'removed', count: 2 },
          { aspect: 'changed', count: 129 },
        ],
      },
    },
    {
      label: 'fix A#1 score (a changed row becomes unchanged)',
      ops: [
        {
          kind: 'cell-set',
          rowId: 'base:fake-rd-v1#1',
          column: 'score',
          value: { kind: 'number', value: 1002 },
        },
      ],
      expectations: {
        rowCountA: 132,
        rowCountB: 260,
        aspects: [
          { aspect: 'added', count: 130 },
          { aspect: 'removed', count: 2 },
          { aspect: 'changed', count: 129 },
        ],
      },
    },
  ],
  truncation: {
    aspect: 'added',
    hardMax: 100,
    clampedSampleLimit: 500,
    expectCount: 130,
    expectSamples: 100,
    expectFirstRowKey: 'b:0',
  },
  hostilePlans: (() => {
    const base = fakeRowDiffPlan()
    const plans: ConformanceHostileRowDiffPlan[] = [
      {
        label: 'wrong plan kind',
        plan: { ...base, planKind: 'not-a-row-diff-plan' },
      },
      {
        label: 'same relation on both sides',
        plan: { ...base, relationB: base.relationA },
      },
      {
        label: 'comment-bearing aspect query',
        plan: {
          ...base,
          addedSql: `SELECT 1 AS "assay_count" /* FROM "${base.relationA}" AS "a" */`,
        },
      },
      {
        label: 'string-masked pseudo-reference',
        plan: {
          ...base,
          addedSql: `SELECT 'FROM "${base.relationA}" AS "a"' AS "assay_side", 0 AS "assay_count", 'FROM "${base.relationB}" AS "b"' AS "x"`,
        },
      },
      {
        label: 'CREATE TABLE canary',
        plan: {
          ...base,
          removedSql: 'CREATE TABLE fake_rowdiff_injected AS SELECT 1',
        },
      },
      {
        label: 'multi-statement aspect query',
        plan: { ...base, addedSql: `${base.addedSql}; DROP TABLE canary` },
      },
      {
        label: 'aspect query drops its side-B binding',
        plan: { ...base, changedSql: base.changedSql.split('"b"').join('"z"') },
      },
      {
        label: 'totals is not three arms',
        plan: { ...base, totalsSql: base.totalsSql.split('\nUNION ALL\n')[0] as string },
      },
    ]
    return plans
  })(),
  injectedTables: ['fake_rowdiff_injected'],
  preExistingViewName: 'fake_rowdiff_existing',
  unsupportedComparisonName: 'comparison.xlsx',
}

/**
 * The fake's minimal mirror of `type-expr.ts`: rejects statement separators,
 * comments, and unbalanced/inverted brackets. Enough to reject the hostile
 * probes; the real validator's full grammar is pinned by the engine package's
 * own unit tests.
 */
function fakeValidateTypeExpression(type: string): void {
  if (type.length === 0) throw new FakeOperationError('empty engine type expression')
  if (type.includes(';') || type.includes('--') || type.includes('/*') || type.includes('*/')) {
    throw new FakeOperationError('invalid engine type expression')
  }
  let depth = 0
  for (const character of type) {
    if (character === '(') depth += 1
    else if (character === ')') {
      depth -= 1
      if (depth < 0) throw new FakeOperationError('invalid engine type expression')
    }
  }
  if (depth !== 0) throw new FakeOperationError('invalid engine type expression')
  // Empty argument lists (`VARCHAR()`, `DECIMAL()`, …) are malformed, and
  // DECIMAL/NUMERIC take 1–2 integer modifiers with 1 ≤ scale ≤ precision ≤ 38
  // (the real validator's closed-arity rules, mirrored just far enough for the
  // cast-check scenario's invalid spellings).
  if (/\(\s*\)/.test(type)) throw new FakeOperationError('invalid engine type expression')
  const decimal = /^DECIMAL\s*\(/i.exec(type)
  if (decimal !== null) {
    const match = /^DECIMAL\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)$/i.exec(type)
    const precision = match === null ? Number.NaN : Number(match[1])
    const scale = match === null || match[2] === undefined ? undefined : Number(match[2])
    if (
      match === null ||
      precision < 1 ||
      precision > 38 ||
      (scale !== undefined && (scale < 0 || scale > precision))
    ) {
      throw new FakeOperationError('invalid engine type expression')
    }
  }
}

/**
 * The fake's tiny `TRY_CAST(value AS target)` predicate: `true` when the
 * non-NULL text value converts. Only the spellings the cast-check dataset
 * declares are understood; anything else is a loud fake error.
 */
function fakeCastSucceeds(value: string, targetType: string): boolean {
  switch (targetType.trim().toUpperCase()) {
    case 'BIGINT':
    case 'INTEGER':
      return /^[+-]?\d+$/.test(value)
    case 'VARCHAR':
    case 'TEXT':
    case 'STRING':
      return true
    default:
      throw new FakeOperationError(`fake cannot convert to ${targetType}`)
  }
}

/** Validate every type expression an overlay carries (fake mirror). */
function fakeAssertTypesValid(overlay: ConformanceOverlay): void {
  for (const column of overlay.base.columns) fakeValidateTypeExpression(column.type)
  for (const op of overlay.ops ?? []) {
    if (op.kind === 'column-cast') fakeValidateTypeExpression(op.targetType)
  }
}

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

// ---- m4-2 fake overlay machinery (mini-fold + emission + sanitization) ----

/** One live/tombstoned overlay insert of the fake's mini-fold. */
interface FakeInsert {
  readonly id: string
  live: boolean
  readonly position: ConformanceInsertPosition
  readonly values: ReadonlyMap<string, ConformanceCellValue>
  readonly seq: number
}

/** The fake's folded overlay state (the domain fold in miniature). */
interface FakeOverlayState {
  readonly columns: { name: string; type: string }[]
  readonly edits: Map<string, Map<string, ConformanceCellValue>>
  readonly inserts: Map<string, FakeInsert>
  readonly deletedBase: Set<number>
}

/**
 * The fake's mini-fold: applies the (conflict-free, dataset-scripted) ops
 * left-to-right — last-write-wins edits, insert records with their seq,
 * tombstones, rename re-keying, cast type overrides. Mutation knobs make it
 * dishonest in exactly one way afterwards (the fold itself stays honest so
 * each knob is a single load-bearing break).
 */
function foldFakeOverlay(
  base: ConformanceOverlayBase,
  ops: readonly ConformanceEditOp[],
  mutations: FakeMutations,
): FakeOverlayState {
  const state: {
    columns: { name: string; type: string }[]
    edits: Map<string, Map<string, ConformanceCellValue>>
    inserts: Map<string, FakeInsert>
    deletedBase: Set<number>
  } = {
    columns: base.columns.map((column) => ({ ...column })),
    edits: new Map(),
    inserts: new Map(),
    deletedBase: new Set(),
  }
  for (const op of ops) {
    switch (op.kind) {
      case 'cell-set': {
        const inner = state.edits.get(op.rowId) ?? new Map<string, ConformanceCellValue>()
        inner.set(op.column, op.value)
        state.edits.set(op.rowId, inner)
        break
      }
      case 'cell-revert':
        state.edits.get(op.rowId)?.delete(op.column)
        break
      case 'row-insert': {
        const seq = Number(op.rowId.slice(op.rowId.lastIndexOf('#') + 1))
        state.inserts.set(op.rowId, {
          id: op.rowId,
          live: true,
          position: op.position,
          values: op.values,
          seq,
        })
        break
      }
      case 'row-uninsert':
        state.inserts.delete(op.rowId)
        state.edits.delete(op.rowId)
        break
      case 'row-delete': {
        const record = state.inserts.get(op.rowId)
        if (record !== undefined) {
          state.inserts.set(op.rowId, { ...record, live: false })
        } else {
          state.deletedBase.add(fakeBaseOrdinal(op.rowId))
        }
        break
      }
      case 'row-restore': {
        const record = state.inserts.get(op.rowId)
        if (record !== undefined) {
          state.inserts.set(op.rowId, { ...record, live: true })
        } else {
          state.deletedBase.delete(fakeBaseOrdinal(op.rowId))
        }
        break
      }
      case 'column-rename': {
        state.columns = state.columns.map((column) =>
          column.name === op.from ? { name: op.to, type: column.type } : column,
        )
        for (const [rowId, inner] of state.edits) {
          if (!inner.has(op.from)) continue
          const rekeyed = new Map<string, ConformanceCellValue>()
          for (const [column, value] of inner) {
            rekeyed.set(column === op.from ? op.to : column, value)
          }
          state.edits.set(rowId, rekeyed)
        }
        for (const [rowId, record] of state.inserts) {
          if (!record.values.has(op.from)) continue
          const rekeyed = new Map<string, ConformanceCellValue>()
          for (const [column, value] of record.values) {
            rekeyed.set(column === op.from ? op.to : column, value)
          }
          state.inserts.set(rowId, { ...record, values: rekeyed })
        }
        break
      }
      case 'column-cast':
        state.columns = state.columns.map((column) =>
          column.name === op.column ? { name: column.name, type: op.targetType } : column,
        )
        break
    }
  }
  // Mutation knobs: each degrades the folded state in exactly one way.
  if (mutations.skipsOverlayEdits) state.edits.clear()
  if (mutations.keepsDeletedRows) state.deletedBase.clear()
  return state
}

/** The base ordinal of a `base:<anchor>#<ordinal>` id (shape trusted). */
function fakeBaseOrdinal(rowId: string): number {
  return Number(rowId.slice(rowId.lastIndexOf('#') + 1))
}

/** Renders one cell (base scalar or tagged overlay value) as output text. */
function fakeRenderCell(
  value: ConformanceCellValue | string | number | boolean | null,
): string | null {
  if (value === null) return null
  if (typeof value === 'object') {
    switch (value.kind) {
      case 'null':
        return null
      case 'boolean':
        return String(value.value)
      case 'number':
        return String(value.value)
      case 'string':
        return value.value
      case 'text':
        return value.text
    }
  }
  return String(value)
}

/**
 * The fake's effective rows: the domain's `effectiveRowIds` emission order in
 * miniature (start sweep, base ordinals minus tombstones with before/after
 * chains nested depth-first, end sweep, leftover sweep by seq), with cell
 * maps keyed by EFFECTIVE column names (base value at the same position,
 * edit overlaid). `misorder` collapses every insert position to the end —
 * the m4-2 misordering mutation.
 */
function fakeOverlayRows(
  base: ConformanceOverlayBase,
  state: FakeOverlayState,
  baseRows: readonly Record<string, string | number | null>[],
  misorder: boolean,
): { id: string; cells: ReadonlyMap<string, string | null> }[] {
  const beforeByAnchor = new Map<string, FakeInsert[]>()
  const afterByAnchor = new Map<string, FakeInsert[]>()
  const start: FakeInsert[] = []
  const end: FakeInsert[] = []
  for (const record of state.inserts.values()) {
    if (!record.live) continue
    const position = misorder ? ({ kind: 'end' } as const) : record.position
    if (position.kind === 'start') start.push(record)
    else if (position.kind === 'end') end.push(record)
    else if (position.kind === 'before') {
      const list = beforeByAnchor.get(position.rowId) ?? []
      list.push(record)
      beforeByAnchor.set(position.rowId, list)
    } else {
      const list = afterByAnchor.get(position.rowId) ?? []
      list.push(record)
      afterByAnchor.set(position.rowId, list)
    }
  }
  const bySeq = (a: FakeInsert, b: FakeInsert): number => a.seq - b.seq
  start.sort(bySeq)
  end.sort(bySeq)
  for (const list of beforeByAnchor.values()) list.sort(bySeq)
  for (const list of afterByAnchor.values()) list.sort(bySeq)

  const ordered: { id: string; baseOrdinal?: number; insert?: FakeInsert }[] = []
  const emitted = new Set<string>()
  const emitChain = (record: FakeInsert): void => {
    if (emitted.has(record.id)) return
    emitted.add(record.id)
    for (const child of beforeByAnchor.get(record.id) ?? []) emitChain(child)
    ordered.push({ id: record.id, insert: record })
    for (const child of afterByAnchor.get(record.id) ?? []) emitChain(child)
  }
  for (const record of start) emitChain(record)
  for (let ordinal = 0; ordinal < base.baseRowCount; ordinal++) {
    if (state.deletedBase.has(ordinal)) continue
    const id = `base:${base.baseAnchor}#${String(ordinal)}`
    for (const child of beforeByAnchor.get(id) ?? []) emitChain(child)
    ordered.push({ id, baseOrdinal: ordinal })
    for (const child of afterByAnchor.get(id) ?? []) emitChain(child)
  }
  for (const record of end) emitChain(record)
  for (const record of [...state.inserts.values()]
    .filter((r) => r.live && !emitted.has(r.id))
    .sort(bySeq)) {
    emitChain(record)
  }

  return ordered.map((entry) => {
    const cells = new Map<string, string | null>()
    state.columns.forEach((column, index) => {
      const baseName = base.columns[index]!.name
      const raw =
        entry.baseOrdinal === undefined
          ? (entry.insert!.values.get(column.name) ?? { kind: 'null' as const })
          : (baseRows[entry.baseOrdinal]?.[baseName] ?? null)
      const rendered = fakeRenderCell(raw as ConformanceCellValue | string | number | null)
      const edit = state.edits.get(entry.id)?.get(column.name)
      cells.set(column.name, edit === undefined ? rendered : fakeRenderCell(edit))
    })
    return { id: entry.id, cells }
  })
}

/**
 * The CSV formula-injection guard in miniature (the composed guard's exact
 * documented trigger set): leading `=`, `+`, `-`, `@`, or tab/LF/CR anywhere
 * gains the apostrophe prefix. `skip` is the m4-2 sanitization mutation.
 */
function fakeSanitizeCsvCell(value: string | null, skip: boolean): string | null {
  if (value === null || skip) return value
  if (
    ['=', '+', '-', '@'].includes(value.charAt(0)) ||
    value.includes('\t') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return `'${value}`
  }
  return value
}

/**
 * The CSV **header** guard in miniature (C1/S1): a column name is row 1 of a
 * spreadsheet, so it takes the same trigger policy as a value. Mirrors the
 * engine's `csvHeaderGuardName` (apostrophe prefix on trigger-leading names
 * and names carrying tab/LF/CR anywhere). Benign names are unchanged, so
 * existing benign-named export pins stay byte-identical.
 */
function fakeGuardCsvHeader(name: string): string {
  if (
    ['=', '+', '-', '@'].includes(name.charAt(0)) ||
    name.includes('\t') ||
    name.includes('\n') ||
    name.includes('\r')
  ) {
    return `'${name}`
  }
  return name
}

/** The DuckDB BLOB aliases whose CSV rendering is hex-encoded (AR-E1). */
function fakeIsBlobType(type: string): boolean {
  return ['BLOB', 'BYTEA', 'BINARY', 'VARBINARY'].includes(type.toUpperCase())
}

/** Uppercase hex of a value's UTF-8 bytes (`hex()` in miniature). */
function fakeHexCell(value: string | null): string | null {
  if (value === null) return null
  return [...new TextEncoder().encode(value)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

/**
 * The fake's CSV cell policy: scalar BLOBs are hex-encoded, scalar text is
 * apostrophe-guarded. Mirrors the engine's `csvSafeExpression` (AR-E1).
 */
function fakeCsvCell(value: string | null, type: string, skipSanitize: boolean): string | null {
  if (fakeIsBlobType(type)) return fakeHexCell(value)
  return fakeSanitizeCsvCell(value, skipSanitize)
}

/**
 * The base rows a fake overlay composes over: the BLOB dataset has its own
 * base, everything else uses the canonical overlay rows.
 */
function fakeBaseRowsFor(
  base: ConformanceOverlayBase,
): readonly Record<string, string | number | null>[] {
  return base.baseAnchor === 'fake-blob-base-v1' ? FAKE_BLOB_ROWS : FAKE_OVERLAY_ROWS
}

/** The logical row-id column name overlay windows add when asked (m4-2). */
const ROW_ID_COLUMN = 'assay_row_id'

/** One exported (materialized) fake file, re-openable through `open()`. */
interface FakeExportFile {
  readonly columns: readonly string[]
  readonly types: readonly string[]
  readonly rows: readonly Record<string, string | null>[]
  readonly bytes: Uint8Array
}

/** A stored export as an Arrow table window (the re-open round-trip path). */
function exportTable(exported: FakeExportFile, start: number, end: number): Table {
  const slice = exported.rows.slice(start, end)
  const columns: Record<string, (string | null)[]> = {}
  for (const name of exported.columns) {
    columns[name] = slice.map((row) => row[name] ?? null)
  }
  return tableFromArrays(columns)
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
  /** Completed exports, re-openable through `open()` (m4-2). */
  exports: new Map<string, FakeExportFile>(),
  /**
   * Views the fake's `query()` has created via DDL (the m5-2 fix round's
   * pre-existing-view survival probe); the subject's `tableExists` reads it.
   */
  createdViews: new Set<string>(),
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
  /** Monotonic export sequence for generated destination names (m4-2). */
  private nextExportSeq = 1

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
    // Completed exports re-open through the ordinary open path (m4-2).
    const exported = subjectState.exports.get(source.name)
    if (exported !== undefined) {
      const tableId = `fake-t${this.nextTableId++}`
      this.registered.set(tableId, source.name)
      return { kind: 'table', id: tableId }
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
    if (this.isValidation(handle)) {
      return FAKE_VALIDATION_SCHEMA.map((column) => ({ ...column }))
    }
    if (this.isRowDiff(handle)) {
      return FAKE_ROW_DIFF_SCHEMA.map((column) => ({ ...column }))
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
    // Re-opened exports answer from the stored materialization (m4-2).
    const exported = this.exportedFile(handle)
    if (exported !== null) return exported.rows.length
    const base = this.isWide(handle)
      ? WIDE_ROW_COUNT
      : this.isNested(handle)
        ? NESTED_DATASET.rowCount
        : this.isValidation(handle)
          ? FAKE_VALIDATION_BASE.baseRowCount
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
    // Re-opened exports serve their stored (materialized) content (m4-2).
    const exported = this.exportedFile(handle)
    if (exported !== null) {
      return {
        batch: exportTable(exported, window.startRow, window.endRow),
        hasMore: false,
      }
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
    // DDL for the m5-2 fix round's survival probe: track created views so
    // the subject's `tableExists` can answer; DROP un-creates.
    const createView = /^CREATE VIEW "([^"]+)" AS/.exec(sql)
    if (createView !== null) {
      subjectState.createdViews.add(createView[1]!)
      return { batch: tableFromArrays({}), hasMore: false }
    }
    const dropView = /^DROP VIEW "([^"]+)"$/.exec(sql)
    if (dropView !== null) {
      subjectState.createdViews.delete(dropView[1]!)
      return { batch: tableFromArrays({}), hasMore: false }
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

  // ---- m4-2 overlay + export surface (stateless: every call carries ops) ----

  async overlaySchema(
    handle: ConformanceTableHandle,
    overlay: ConformanceOverlay,
  ): Promise<readonly { name: string; type: string }[]> {
    this.requireRegistered(handle)
    if (this.mutations.acceptsHostileTypes !== true) {
      // m4-2 fix round: the boundary rejects injection-shaped type strings
      // with a typed operation error (the fake mirror of the real validator).
      fakeAssertTypesValid(overlay)
    }
    if (this.mutations.liesAboutOverlaySchema) {
      // Rename/cast invisible: the base schema, verbatim.
      return overlay.base.columns.map((column) => ({ ...column }))
    }
    const state = foldFakeOverlay(overlay.base, overlay.ops ?? [], this.mutations)
    return state.columns.map((column) => ({ ...column }))
  }

  async overlayRowCount(
    handle: ConformanceTableHandle,
    overlay: ConformanceOverlay,
    options?: { readonly filters?: readonly ConformanceFilterSpec[] },
  ): Promise<number> {
    this.requireRegistered(handle)
    if (this.mutations.liesAboutOverlayRowCount) {
      // Tombstones ignored: base + live inserts (the fake dataset has one
      // delete, so this lies by exactly one row).
      const state = foldFakeOverlay(overlay.base, overlay.ops ?? [], this.mutations)
      let live = 0
      for (const record of state.inserts.values()) if (record.live) live += 1
      return overlay.base.baseRowCount + live
    }
    const rows = this.overlayRows(overlay)
    const filters = options?.filters ?? []
    if (filters.length === 0) return rows.length
    return rows.filter((row) =>
      filters.every((filter) => {
        const value = row.cells.get(filter.column)
        if (value === undefined) {
          throw new FakeQueryError(`Binder Error: no such column ${filter.column}`)
        }
        if (filter.predicate === 'IS NOT NULL') return value !== null
        throw new FakeQueryError('Parser Error: fake overlay predicates are IS NOT NULL only')
      }),
    ).length
  }

  async fetchOverlayRange(
    handle: ConformanceTableHandle,
    overlay: ConformanceOverlay,
    window: ConformanceOverlayWindow,
  ): Promise<ConformanceBatchResult> {
    this.requireRegistered(handle)
    if (
      !isRowIndex(window.startRow) ||
      !isRowIndex(window.endRow) ||
      window.endRow < window.startRow
    ) {
      throw new FakeOperationError('invalid row window')
    }
    const state = foldFakeOverlay(overlay.base, overlay.ops ?? [], this.mutations)
    let rows = fakeOverlayRows(
      overlay.base,
      state,
      fakeBaseRowsFor(overlay.base),
      this.mutations.misordersOverlayInserts === true,
    )
    // Filters over effective columns (the fake interprets its tiny language).
    for (const filter of window.filters ?? []) {
      rows = rows.filter((row) => {
        const value = row.cells.get(filter.column)
        if (value === undefined) {
          throw new FakeQueryError(`Binder Error: no such column ${filter.column}`)
        }
        if (filter.predicate === 'IS NOT NULL') return value !== null
        throw new FakeQueryError('Parser Error: fake overlay predicates are IS NOT NULL only')
      })
    }
    // Multi-key sort, later keys first (stable), NULLs last — like DuckDB.
    const sort = window.sort ?? []
    for (let index = sort.length - 1; index >= 0; index--) {
      const key = sort[index]!
      const factor = key.direction === 'desc' ? -1 : 1
      rows = [...rows].sort((a, b) => {
        const va = a.cells.get(key.column)
        const vb = b.cells.get(key.column)
        if (va === undefined || vb === undefined) return 0
        if (va === null) return vb === null ? 0 : 1
        if (vb === null) return -1
        if (va === vb) return 0
        return va < vb ? -1 * factor : factor
      })
    }
    const end = Math.min(window.endRow, window.startRow + MAX_WINDOW_ROWS)
    const slice = rows.slice(window.startRow, end)
    const names = state.columns.map((column) => column.name)
    const fields = window.includeRowIds === true ? [ROW_ID_COLUMN, ...names] : names
    const columns: Record<string, (string | null)[]> = {}
    for (const field of fields) {
      columns[field] =
        field === ROW_ID_COLUMN
          ? slice.map((row) => row.id)
          : slice.map((row) => row.cells.get(field) ?? null)
    }
    return { batch: tableFromArrays(columns), hasMore: false }
  }

  async overlayCastCheck(
    handle: ConformanceTableHandle,
    overlay: ConformanceOverlay,
    request: { readonly column: string; readonly targetType: string },
  ): Promise<{ readonly hasNonConvertibleValues: boolean }> {
    this.requireRegistered(handle)
    if (this.mutations.acceptsHostileTypes !== true) {
      fakeAssertTypesValid(overlay)
      fakeValidateTypeExpression(request.targetType)
    }
    const state = foldFakeOverlay(overlay.base, overlay.ops ?? [], this.mutations)
    if (!state.columns.some((column) => column.name === request.column)) {
      throw new FakeOperationError(`unknown overlay column: ${request.column}`)
    }
    // Mutation knobs: the two one-sided lies the scenario must catch.
    if (this.mutations.castCheckAlwaysFalse) return { hasNonConvertibleValues: false }
    if (this.mutations.castCheckAlwaysTrue) return { hasNonConvertibleValues: true }
    const baseRows = this.isCastCheck(handle) ? FAKE_CAST_CHECK_ROWS : FAKE_OVERLAY_ROWS
    const rows = fakeOverlayRows(overlay.base, state, baseRows, false)
    for (const row of rows) {
      const value = row.cells.get(request.column)
      if (value === undefined) {
        throw new FakeOperationError(`unknown overlay column: ${request.column}`)
      }
      if (value !== null && !fakeCastSucceeds(value, request.targetType)) {
        return { hasNonConvertibleValues: true }
      }
    }
    return { hasNonConvertibleValues: false }
  }

  /**
   * The fake's committed-cast probe (m4-4b round 3 agreement pin): apply the
   * pending cast to the overlay and report whether any non-NULL effective
   * value fails `fakeCastSucceeds`. Mirrors the fake's honest
   * `overlayCastCheck` model, so a one-sided mutation breaks agreement.
   */
  committedCastCheck(
    handle: ConformanceTableHandle,
    overlay: ConformanceOverlay,
    request: { readonly column: string; readonly targetType: string },
  ): boolean {
    const committed: ConformanceOverlay = {
      base: overlay.base,
      ops: [
        ...(overlay.ops ?? []),
        { kind: 'column-cast', column: request.column, targetType: request.targetType },
      ],
    }
    const state = foldFakeOverlay(committed.base, committed.ops ?? [], this.mutations)
    const baseRows = this.isCastCheck(handle) ? FAKE_CAST_CHECK_ROWS : FAKE_OVERLAY_ROWS
    const rows = fakeOverlayRows(committed.base, state, baseRows, false)
    for (const row of rows) {
      const value = row.cells.get(request.column)
      if (value !== undefined && value !== null && !fakeCastSucceeds(value, request.targetType)) {
        return true
      }
    }
    return false
  }

  /**
   * m5-2: validation execution over the fake's typed rows. The REAL compiled
   * plan is what arrives; its ruleIds select the declared semantics in
   * {@link FAKE_VALIDATION_RULE_SEMANTICS} (the fake has no SQL engine).
   * Mutation knobs lie in exactly one way each: inflated counts, dropped
   * samples, a skipped clamp, or a missing plan guard.
   */
  async validate(
    handle: ConformanceTableHandle,
    plan: ConformanceValidationPlan,
    overlay?: ConformanceOverlay,
  ): Promise<ConformanceValidationResult> {
    if (this.status === 'disposed') {
      if (this.mutations.genericDisposeErrors) throw new Error('client already closed')
      throw new FakeDisposedError('engine client was disposed')
    }
    this.requireRegistered(handle)
    if (this.mutations.acceptsHostilePlans !== true) {
      fakeAssertPlanValid(plan)
    }
    const rows = fakeValidationRows(overlay?.ops ?? [])
    const rules: ConformanceValidationRuleResult[] = plan.rules.map((rule) => {
      const evaluated = fakeEvaluateRule(rule.ruleId, rows)
      const failCount = evaluated.failCount + (this.mutations.liesAboutValidationCounts ? 1 : 0)
      const clamped =
        this.mutations.skipsValidationClamp || this.mutations.dropsValidationSamples
          ? evaluated.samples
          : evaluated.samples.slice(0, Math.min(plan.sampleLimit, FAKE_VALIDATION_SAMPLE_MAX))
      return {
        ruleId: rule.ruleId,
        failCount,
        failPercent: specPercentFormula(failCount, rows.length),
        sampleFailures: this.mutations.dropsValidationSamples ? [] : clamped,
      }
    })
    return {
      valid: rules.every((rule) => rule.failCount === 0),
      rowCount: rows.length,
      rules,
    }
  }

  /**
   * m6-2: stage a comparison file. The fake models the engine's typed
   * failure paths (unsupported extension, missing staged bytes) and returns
   * the comparison schema for plan compilation.
   */
  async stageComparison(source: ConformanceFileSource): Promise<ConformanceComparisonHandle> {
    await this.ensureReady()
    if (!/\.(parquet|csv|jsonl|json)$/.test(source.name)) {
      throw new FakeOperationError('unsupported comparison format')
    }
    const bytes = subjectState.staged.get(source.name)
    if (bytes === undefined) throw new FakeOperationError('staged comparison file missing')
    return { kind: 'comparison', id: 'fake-d1', schema: FAKE_ROW_DIFF_SCHEMA }
  }

  /**
   * m6-2: row-diff execution over the fake's typed rows. The REAL compiled
   * plan arrives; the fake validates its structure and evaluates the
   * added/removed/changed semantics with the plan's own keys/shared columns
   * (no SQL engine). One mutation knob inflates the counts.
   */
  async diff(
    handle: ConformanceTableHandle,
    comparison: ConformanceComparisonHandle,
    plan: ConformanceRowDiffPlan,
    overlay?: ConformanceOverlay,
  ): Promise<ConformanceRowDiffResult> {
    this.requireRegistered(handle)
    if (comparison.id !== 'fake-d1') throw new FakeOperationError('unknown comparison handle')
    if (this.mutations.acceptsHostileRowDiffPlans !== true) fakeAssertRowDiffPlanValid(plan)
    // A plan bound to a user-created view name fails its materialization
    // (the pre-existing-view survival pin).
    if (
      subjectState.createdViews.has(plan.relationA) ||
      subjectState.createdViews.has(plan.relationB)
    ) {
      throw new FakeOperationError('row-diff plan relation collides with an existing view')
    }
    const anchor = overlay === undefined ? '' : FAKE_ROW_DIFF_BASE.baseAnchor
    const aRows = fakeRowDiffARows(overlay?.ops ?? [], anchor)
    const bRows = fakeRowDiffBRows()
    return fakeRowDiffResult(plan, aRows, bRows, this.mutations.liesAboutRowDiffCounts === true)
  }

  async exportView(
    handle: ConformanceTableHandle,
    request: {
      readonly format: ConformanceExportFormat
      readonly overlay?: ConformanceOverlay
    },
  ): Promise<ConformanceExportResult> {
    this.requireRegistered(handle)
    const seq = this.nextExportSeq++
    const name = `fake-export-${String(seq)}.${request.format}`
    const sanitize = request.format === 'csv' && !this.mutations.skipsCsvSanitization
    const guardHeader = sanitize && this.mutations.skipsCsvHeaderGuard !== true
    let columns: readonly string[]
    let types: readonly string[]
    let materialized: Record<string, string | null>[]
    if (request.overlay === undefined) {
      // Overlay-free export over a re-opened export (the AR-E1 two-step base
      // BLOB leg): materialize the stored file directly from its own schema.
      const source = this.exportedFile(handle)
      if (source === null) {
        throw new FakeQueryError('fake overlay-free exports require a reopened export')
      }
      columns = guardHeader ? source.columns.map(fakeGuardCsvHeader) : source.columns
      types = source.types
      materialized = source.rows.map((row) => {
        const record: Record<string, string | null> = {}
        source.columns.forEach((column, index) => {
          const value = row[column] ?? null
          record[columns[index]!] = sanitize ? fakeCsvCell(value, types[index]!, false) : value
        })
        return record
      })
    } else {
      const state = foldFakeOverlay(request.overlay.base, request.overlay.ops ?? [], this.mutations)
      const rows = fakeOverlayRows(
        request.overlay.base,
        state,
        fakeBaseRowsFor(request.overlay.base),
        this.mutations.misordersOverlayInserts === true,
      )
      // C1/S1: the CSV header is a spreadsheet surface too — a hostile column
      // NAME takes the apostrophe guard exactly like a hostile value. Benign
      // names are unchanged, so existing benign-named export pins stay
      // byte-identical.
      columns = guardHeader
        ? state.columns.map((column) => fakeGuardCsvHeader(column.name))
        : state.columns.map((column) => column.name)
      types = state.columns.map((column) => column.type)
      materialized = rows.map((row) => {
        const record: Record<string, string | null> = {}
        state.columns.forEach((column, index) => {
          const value = row.cells.get(column.name) ?? null
          record[columns[index]!] = sanitize ? fakeCsvCell(value, column.type, false) : value
        })
        return record
      })
    }
    const bytes = new TextEncoder().encode(
      materialized.map((row) => columns.map((c) => row[c] ?? '').join(',')).join('\n'),
    )
    subjectState.exports.set(name, { columns, types, rows: materialized, bytes })
    if (this.mutations.rewritesSourceFile) {
      // The mutation: exporting rewrites the staged source in place.
      const sourceName = this.registered.get(handle.id)
      const staged = sourceName === undefined ? undefined : subjectState.staged.get(sourceName)
      if (staged !== undefined) {
        const mutated = new Uint8Array(staged.length + 1)
        mutated.set(staged)
        mutated[staged.length] = 35
        subjectState.staged.set(sourceName!, mutated)
      }
    }
    return {
      path: `assay-exports/${name}`,
      format: request.format,
      rowCount: materialized.length + (this.mutations.liesAboutExportRowCount ? 1 : 0),
      bytes: bytes.length,
    }
  }

  /** The folded + emitted overlay rows this client serves (knob-aware). */
  private overlayRows(overlay: ConformanceOverlay) {
    const state = foldFakeOverlay(overlay.base, overlay.ops ?? [], this.mutations)
    return fakeOverlayRows(
      overlay.base,
      state,
      fakeBaseRowsFor(overlay.base),
      this.mutations.misordersOverlayInserts === true,
    )
  }

  /** The stored export behind a handle, or `null` for staged datasets. */
  private exportedFile(handle: ConformanceTableHandle): FakeExportFile | null {
    const name = this.registered.get(handle.id)
    if (name === undefined) return null
    return subjectState.exports.get(name) ?? null
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

  private isCastCheck(handle: ConformanceTableHandle): boolean {
    return this.registered.get(handle.id) === 'overlay-cast-check.csv'
  }

  private isValidation(handle: ConformanceTableHandle): boolean {
    return this.registered.get(handle.id) === 'validation.jsonl'
  }

  private isRowDiff(handle: ConformanceTableHandle): boolean {
    return this.registered.get(handle.id) === 'rowdiff-a.jsonl'
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

/**
 * The documented m5-2 failPercent formula (integer half-up) — the fake
 * computes percents with the same written definition the scenario pins.
 */
function specPercentFormula(failCount: number, rowCount: number): number {
  return rowCount === 0 ? 0 : Math.floor((failCount * 200 + rowCount) / (2 * rowCount))
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
  subjectState.exports.clear()
  subjectState.createdViews.clear()
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
    overlayDataset: FAKE_OVERLAY_DATASET,
    stageOverlayFile: async () => {
      const name = 'overlay.csv'
      // Runtime-built base bytes with the formula-injection bait cells
      // (never committed data), matching FAKE_OVERLAY_ROWS.
      const lines = ['id,label']
      for (const row of FAKE_OVERLAY_ROWS) {
        lines.push(`${String(row.id)},${row.label ?? ''}`)
      }
      subjectState.staged.set(name, new TextEncoder().encode(lines.join('\n') + '\n'))
      return fileSource(name)
    },
    blobExportDataset: FAKE_BLOB_EXPORT_DATASET,
    stageBlobExportFile: async () => {
      const name = 'blob-export.jsonl'
      const lines = FAKE_BLOB_ROWS.map((row) =>
        JSON.stringify({ id: row.id, cast_blob: row.cast_blob }),
      )
      subjectState.staged.set(name, new TextEncoder().encode(lines.join('\n') + '\n'))
      return fileSource(name)
    },
    overlayInsertEdits: FAKE_OVERLAY_INSERT_EDITS_DATASET,
    stageOverlayInsertEditsFile: async () => {
      const name = 'overlay-insert-edits.csv'
      const lines = ['id,label']
      for (const row of FAKE_OVERLAY_ROWS) {
        lines.push(`${String(row.id)},${row.label ?? ''}`)
      }
      subjectState.staged.set(name, new TextEncoder().encode(lines.join('\n') + '\n'))
      return fileSource(name)
    },
    overlayCastCheckDataset: FAKE_CAST_CHECK_DATASET,
    stageOverlayCastCheckFile: async () => {
      const name = 'overlay-cast-check.csv'
      const header = FAKE_CAST_CHECK_BASE.columns.map((column) => column.name).join(',')
      const lines = [header]
      for (const row of FAKE_CAST_CHECK_ROWS) {
        lines.push(
          FAKE_CAST_CHECK_BASE.columns.map((column) => String(row[column.name] ?? '')).join(','),
        )
      }
      subjectState.staged.set(name, new TextEncoder().encode(lines.join('\n') + '\n'))
      return fileSource(name)
    },
    validationDataset: FAKE_VALIDATION_DATASET,
    stageValidationFile: async () => {
      const name = 'validation.jsonl'
      const lines = FAKE_VALIDATION_ROWS.map((row) => JSON.stringify(row))
      subjectState.staged.set(name, new TextEncoder().encode(lines.join('\n') + '\n'))
      return fileSource(name)
    },
    rowDiffDataset: FAKE_ROW_DIFF_DATASET,
    stageRowDiffFile: async () => {
      const name = 'rowdiff-a.jsonl'
      subjectState.staged.set(name, subjectState.goodBytes)
      return fileSource(name)
    },
    stageRowDiffComparisonFile: async () => {
      const name = 'rowdiff-comparison.jsonl'
      subjectState.staged.set(name, subjectState.goodBytes)
      return fileSource(name)
    },
    missingComparisonSource: {
      name: 'rowdiff-missing.jsonl',
      getFile: async () => {
        throw new FakeOperationError('staged comparison file missing')
      },
    },
    // The fake models a compliant engine's vocabulary probe: one column per
    // spelling, reported exactly as spelled — except bare DECIMAL, which the
    // engine reports parameterized (the documented m5-0 caveat).
    vocabularySchema: async () =>
      CONTRACT_TYPE_VOCABULARY.map((spelling) => ({
        name: `v_${spelling}`,
        type: spelling === 'DECIMAL' ? 'DECIMAL(18,3)' : spelling,
      })),
    committedCastFails: async (client, handle, overlay, request) => {
      if (mutations.committedCastAlwaysSucceeds === true) return false
      if (!(client instanceof FakeEngineClient)) {
        throw new Error('fake subject: unexpected client for the committed-cast probe')
      }
      return client.committedCastCheck(handle, overlay, request)
    },
    hostileTypeProbes: FAKE_HOSTILE_TYPE_PROBES,
    tableExists: async (_client, name) => subjectState.createdViews.has(name),
    sourceDigest: async (source) => {
      const bytes = subjectState.staged.get(source.name)
      if (bytes === undefined) throw new Error('fake digest: unstaged file')
      // FNV-1a: deterministic, changes when any byte changes.
      let hash = 0x811c9dc5
      for (const byte of bytes) {
        hash ^= byte
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      return hash.toString(16).padStart(8, '0')
    },
    exportedSource: async (result) => fileSource(result.path.split('/').pop() ?? result.path),
    readExportedArrowTable: async (result) => {
      const name = result.path.split('/').pop() ?? result.path
      const exported = subjectState.exports.get(name)
      if (exported === undefined) throw new Error('fake container read: unstaged export')
      return { batch: exportTable(exported, 0, exported.rows.length), hasMore: false }
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

  it('exposes overlay-fidelity, export, and immutability evidence (m4-2)', async () => {
    const subject = makeSubject()
    const overlay = await runEngineConformanceScenario(subject, 'overlay-window-fidelity')
    expect(overlay.facts['schemaColumns']).toBe(FAKE_OVERLAY_DATASET.effectiveSchema.length)
    expect(overlay.facts['liveRowCount']).toBe(FAKE_OVERLAY_DATASET.liveRowCount)
    expect(overlay.facts['filteredCount']).toBe(FAKE_OVERLAY_DATASET.filtered.expectRowCount)
    expect(overlay.facts['sliceRows']).toBe(2)
    expect(overlay.facts['cells']).toBe(
      FAKE_OVERLAY_DATASET.columns.length * FAKE_OVERLAY_DATASET.rowIds.length,
    )
    expect(overlay.facts['sortedRows']).toBe(FAKE_OVERLAY_DATASET.sorted.expectRowCount)
    const roundTrip = await runEngineConformanceScenario(subject, 'export-round-trip')
    expect(roundTrip.facts['formats']).toBe(FAKE_OVERLAY_DATASET.exports.length)
    expect(roundTrip.facts['engineReopens']).toBe(3)
    expect(roundTrip.facts['arrowVerified']).toBe(1)
    expect(roundTrip.facts['csvSanitizationProbed']).toBe(true)
    const immutable = await runEngineConformanceScenario(subject, 'source-immutability')
    expect(immutable.facts['exports']).toBe(FAKE_OVERLAY_DATASET.exports.length)
    expect(immutable.facts['distinctDestinations']).toBe(FAKE_OVERLAY_DATASET.exports.length)
    expect(immutable.facts['digestUnchanged']).toBe(true)
  })

  it('exposes inserted-row-edit evidence (m4-2b)', async () => {
    const subject = makeSubject()
    const result = await runEngineConformanceScenario(subject, 'overlay-insert-edits')
    expect(result.passed, result.detail).toBe(true)
    expect(result.facts['schemaColumns']).toBe(
      FAKE_OVERLAY_INSERT_EDITS_DATASET.effectiveSchema.length,
    )
    expect(result.facts['liveRowCount']).toBe(FAKE_OVERLAY_INSERT_EDITS_DATASET.liveRowCount)
    expect(result.facts['cells']).toBe(
      FAKE_OVERLAY_INSERT_EDITS_DATASET.columns.length *
        FAKE_OVERLAY_INSERT_EDITS_DATASET.rowIds.length,
    )
    expect(result.facts['formats']).toBe(FAKE_OVERLAY_INSERT_EDITS_DATASET.exports.length)
    expect(result.facts['engineReopens']).toBe(FAKE_OVERLAY_INSERT_EDITS_DATASET.exports.length)
    expect(result.facts['csvSanitizationProbed']).toBe(true)
  })

  it('exposes cast-check evidence (m4-4b)', async () => {
    const subject = makeSubject()
    const result = await runEngineConformanceScenario(subject, 'overlay-cast-check')
    expect(result.passed, result.detail).toBe(true)
    expect(result.facts['cases']).toBe(FAKE_CAST_CHECK_DATASET.cases.length)
    expect(result.facts['convertible']).toBe(4)
    expect(result.facts['nonConvertible']).toBe(5)
    expect(result.facts['agreements']).toBe(FAKE_CAST_CHECK_DATASET.agreements.length)
    expect(result.facts['invalidRejected']).toBe(FAKE_CAST_CHECK_DATASET.invalidTargetTypes.length)
    expect(result.facts['unknownRejected']).toBe(FAKE_CAST_CHECK_DATASET.unknownColumns.length)
    expect(result.facts['engineReusable']).toBe(true)
  })
})

describe('engine conformance suite (m5-2 validation execution)', () => {
  it('exposes validation evidence (rules, flips, clamp, hostile probes, vocabulary)', async () => {
    const subject = makeSubject()
    const result = await runEngineConformanceScenario(subject, 'validation-plan-execution')
    expect(result.passed, result.detail).toBe(true)
    expect(result.facts['rules']).toBe(Object.keys(FAKE_VALIDATION_RULE_SEMANTICS).length)
    expect(result.facts['failingRules']).toBe(6)
    expect(result.facts['interactions']).toBe(FAKE_VALIDATION_DATASET.interactions.length)
    expect(result.facts['fixFlips']).toBeGreaterThanOrEqual(1)
    expect(result.facts['violateFlips']).toBeGreaterThanOrEqual(1)
    expect(result.facts['hardMaxSamples']).toBe(FAKE_VALIDATION_SAMPLE_MAX)
    expect(result.facts['hostileRejected']).toBe(FAKE_VALIDATION_DATASET.hostilePlans.length)
    expect(result.facts['vocabularyAgreed']).toBe(CONTRACT_TYPE_VOCABULARY.length)
    expect(result.facts['engineReusable']).toBe(true)
  })

  it('validation-plan-execution: detects inflated failCounts', async () => {
    const { passed, detail } = await runOne(
      { liesAboutValidationCounts: true },
      'validation-plan-execution',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('failCount')
  })

  it('validation-plan-execution: detects dropped sample failures', async () => {
    const { passed, detail } = await runOne(
      { dropsValidationSamples: true },
      'validation-plan-execution',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('sample')
  })

  it('validation-plan-execution: detects a skipped sample clamp', async () => {
    const { passed, detail } = await runOne(
      { skipsValidationClamp: true },
      'validation-plan-execution',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('samples stop at the hard max')
  })

  it('validation-plan-execution: detects a missing hostile-plan guard', async () => {
    const { passed, detail } = await runOne(
      { acceptsHostilePlans: true },
      'validation-plan-execution',
    )
    expect(passed).toBe(false)
    // The skipped guard trips first at the over-max K probe (step 4) or at
    // the hostile-plan battery (step 5) — either is the guard's absence.
    expect(detail).toMatch(/must be rejected/)
  })
})

describe('engine conformance suite (m6-2 row-diff execution)', () => {
  it('exposes row-diff evidence (counts, flips, clamp, hostile probes, staging)', async () => {
    const subject = makeSubject()
    const result = await runEngineConformanceScenario(subject, 'row-diff-plan-execution')
    expect(result.passed, result.detail).toBe(true)
    expect(result.facts['keys']).toBe(FAKE_ROW_DIFF_DATASET.keys.length)
    expect(result.facts['rowCountA']).toBe(FAKE_ROW_DIFF_BASE_EXPECTATIONS.rowCountA)
    expect(result.facts['rowCountB']).toBe(FAKE_ROW_DIFF_BASE_EXPECTATIONS.rowCountB)
    expect(result.facts['added']).toBe(130)
    expect(result.facts['removed']).toBe(2)
    expect(result.facts['changed']).toBe(130)
    expect(result.facts['interactions']).toBe(FAKE_ROW_DIFF_DATASET.interactions.length)
    expect(result.facts['countFlips']).toBeGreaterThanOrEqual(1)
    expect(result.facts['clampedCount']).toBe(FAKE_ROW_DIFF_DATASET.truncation.expectCount)
    expect(result.facts['clampedSamples']).toBe(FAKE_ROW_DIFF_DATASET.truncation.expectSamples)
    expect(result.facts['hostileRejected']).toBe(FAKE_ROW_DIFF_DATASET.hostilePlans.length)
    expect(result.facts['canariesAbsent']).toBe(true)
    expect(result.facts['preExistingViewSurvived']).toBe(true)
    expect(result.facts['stagingFailuresRejected']).toBe(true)
    expect(result.facts['engineReusable']).toBe(true)
  })

  it('row-diff-plan-execution: detects inflated aspect counts', async () => {
    const { passed, detail } = await runOne(
      { liesAboutRowDiffCounts: true },
      'row-diff-plan-execution',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('count')
  })

  it('row-diff-plan-execution: detects a missing hostile-plan guard', async () => {
    const { passed, detail } = await runOne(
      { acceptsHostileRowDiffPlans: true },
      'row-diff-plan-execution',
    )
    expect(passed).toBe(false)
    expect(detail).toMatch(/must be rejected/)
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

  it('overlay-window-fidelity: detects dropped cell edits', async () => {
    const { passed, detail } = await runOne({ skipsOverlayEdits: true }, 'overlay-window-fidelity')
    expect(passed).toBe(false)
    expect(detail).toContain('label_v2[3]') // first edited-cell divergence ('+CMD' at base#1, index 3)
  })

  it('overlay-insert-edits: detects dropped edits on inserted rows (m4-2b)', async () => {
    // The m4-2 defect, in miniature: `skipsOverlayEdits` clears the folded
    // edits, so the inserted row falls back to its insert record value —
    // exactly what the old composer did. The scenario must fail on the
    // merged `label_v2` (insert's 'original' where the edit's bait belongs).
    const { passed, detail } = await runOne({ skipsOverlayEdits: true }, 'overlay-insert-edits')
    expect(passed).toBe(false)
    expect(detail).toContain('label_v2[0]')
  })

  it('overlay-window-fidelity: detects collapsed insert positions', async () => {
    const { passed, detail } = await runOne(
      { misordersOverlayInserts: true },
      'overlay-window-fidelity',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('assay_row_id[0]') // the start insert must lead
  })

  it('overlay-window-fidelity: detects tombstoned base rows served anyway', async () => {
    const { passed, detail } = await runOne({ keepsDeletedRows: true }, 'overlay-window-fidelity')
    expect(passed).toBe(false)
    expect(detail).toContain('row count')
  })

  it('overlay-window-fidelity: detects an invisible rename/cast in the effective schema', async () => {
    const { passed, detail } = await runOne(
      { liesAboutOverlaySchema: true },
      'overlay-window-fidelity',
    )
    expect(passed).toBe(false)
    // The cast is the first divergence (column 0: VARCHAR effective vs BIGINT
    // base); the rename shows at column 1 ('label' vs 'label_v2').
    expect(detail).toContain('column 0 type')
  })

  it('overlay-window-fidelity: detects a row count that ignores tombstones', async () => {
    const { passed, detail } = await runOne(
      { liesAboutOverlayRowCount: true },
      'overlay-window-fidelity',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('overlay live row count')
  })

  it('export-round-trip: detects CSV exports without formula-injection sanitization', async () => {
    const { passed, detail } = await runOne({ skipsCsvSanitization: true }, 'export-round-trip')
    expect(passed).toBe(false)
    expect(detail).toContain('[csv export] round-trip')
  })

  it('export-round-trip: detects CSV value sanitization with raw header NAMES (C1)', async () => {
    const { passed, detail } = await runOne({ skipsCsvHeaderGuard: true }, 'export-round-trip')
    expect(passed).toBe(false)
    expect(detail).toContain('csv header formula-injection guard missing')
  })

  it('export-round-trip: detects a lying export row count', async () => {
    const { passed, detail } = await runOne({ liesAboutExportRowCount: true }, 'export-round-trip')
    expect(passed).toBe(false)
    expect(detail).toContain('honest row count')
  })

  it('source-immutability: detects a source rewritten in place by the export', async () => {
    const { passed, detail } = await runOne({ rewritesSourceFile: true }, 'source-immutability')
    expect(passed).toBe(false)
    expect(detail).toContain('byte-identical')
  })

  it('overlay-hostile-types-rejected: detects an engine that accepts a hostile type expression', async () => {
    const { passed, detail } = await runOne(
      { acceptsHostileTypes: true },
      'overlay-hostile-types-rejected',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('must be rejected')
  })

  it('overlay-cast-check: detects a check that always answers false (bad values pass)', async () => {
    const { passed, detail } = await runOne({ castCheckAlwaysFalse: true }, 'overlay-cast-check')
    expect(passed).toBe(false)
    expect(detail).toContain('hasNonConvertibleValues')
  })

  it('overlay-cast-check: detects a check that always answers true (false positives)', async () => {
    const { passed, detail } = await runOne({ castCheckAlwaysTrue: true }, 'overlay-cast-check')
    expect(passed).toBe(false)
    expect(detail).toContain('hasNonConvertibleValues')
  })

  it('overlay-cast-check: detects a committed-cast ground truth that disagrees with the check', async () => {
    // The agreement pin is load-bearing on its own: a check that passes every
    // declared `cases` but disagrees with the actually-committed cast fails.
    const { passed, detail } = await runOne(
      { committedCastAlwaysSucceeds: true },
      'overlay-cast-check',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('committed cast')
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
