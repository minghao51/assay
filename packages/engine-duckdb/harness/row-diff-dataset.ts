/**
 * The m6-2 row-diff dataset (engine-duckdb subject): two on-demand,
 * runtime-built dirty JSONL datasets (never committed — the m5-2 pattern),
 * the explicit key columns, and every expectation below derived with the
 * pinned DuckDB CLI (v1.5.5, `DUCKDB=/tmp/duckdb`) over the IDENTICAL plan
 * SQL the real m6-1 compiler emits, then round-trip checked through the
 * duckdb-wasm client by the conformance scenario.
 *
 * Derivation transcript (native CLI 1.5.5; the engine normalizes sample order
 * to ascending ordinal — the raw anti-join output order is engine-dependent,
 * so the pinned ordinals below are the sorted sets the executor presents):
 *
 *   BASE (rowCountA 132, rowCountB 260):
 *     added   130  ordinals 0..19      (B ids 1001..1130; samples b:0..b:19)
 *     removed   2  ordinals [130,131]  (A ids 201,202)
 *     changed 130  ordinals 0..19      (A ids 1..130; changed lists alternate
 *                                       ['val'] / ['score'])
 *     totals  {added:130, removed:2, changed:130}
 *   TOMBSTONE A#0 (row-delete base:rowdiff-anchor-v1#0):
 *     rowCountA 131; added 131 (B id 1 loses its match); removed 2; changed 129
 *   FIX A#1 (cell-set base:rowdiff-anchor-v1#1 score -> 1002):
 *     rowCountA 132; added 130; removed 2; changed 129
 *   CLAMPED added at K=500 -> 100 samples, count still 130.
 *
 * Side B is deliberately large (130 added rows) so the K-clamp pin is
 * non-vacuous: the plan K is 20, and a K=500 plan still reports the FULL
 * count 130 with samples stopping at the engine hard max 100.
 *
 * Privacy (ADR 0025): the rows are synthetic and committed nowhere; no file
 * names or dataset values are logged by the engine or the scenario.
 */
import { compileRowDiffPlan } from '@assay/diff'
import type {
  ConformanceHostileRowDiffPlan,
  ConformanceOverlayBase,
  ConformanceRowDiffDataset,
  ConformanceRowDiffExpectations,
  ConformanceRowDiffSample,
} from '@assay/testing'
import type { EditOp, RowId } from '@assay/domain'

export const ROW_DIFF_RELATION_A = 'assay_conf_rowdiff_a'
export const ROW_DIFF_RELATION_B = 'assay_conf_rowdiff_b'
export const ROW_DIFF_SAMPLE_LIMIT = 20
export const ROW_DIFF_HARD_MAX = 100
export const ROW_DIFF_OVER_MAX_SAMPLE_LIMIT = 500
export const ROW_DIFF_BASE_ANCHOR = 'rowdiff-anchor-v1'
export const ROW_DIFF_OVERLAY_ANCHOR = 'rowdiff-ov-1'

const A_ROW_COUNT = 132
const B_ROW_COUNT = 260

interface RowDiffRow {
  readonly id: number
  readonly val: string
  readonly score: number
}

/** Side A: ids 1..130 (val `a<i>`, score i) plus two unmatched ids 201/202. */
export function rowDiffARows(): RowDiffRow[] {
  const rows: RowDiffRow[] = []
  for (let i = 1; i <= 130; i++) rows.push({ id: i, val: `a${String(i)}`, score: i })
  rows.push({ id: 201, val: 'gone201', score: 201 })
  rows.push({ id: 202, val: 'gone202', score: 202 })
  return rows
}

/**
 * Side B: 130 added ids (1001..1130) FIRST, then the 130 matching ids whose
 * shared columns alternate a val difference (odd id) and a score difference
 * (even id).
 */
export function rowDiffBRows(): RowDiffRow[] {
  const rows: RowDiffRow[] = []
  for (let j = 1; j <= 130; j++) rows.push({ id: 1000 + j, val: `n${String(j)}`, score: j })
  for (let i = 1; i <= 130; i++) {
    rows.push({
      id: i,
      val: i % 2 === 1 ? `B${String(i)}` : `a${String(i)}`,
      score: i % 2 === 1 ? i : i + 1000,
    })
  }
  return rows
}

function toJsonl(rows: readonly RowDiffRow[]): Uint8Array {
  const lines = rows.map((row) => JSON.stringify(row))
  return new TextEncoder().encode(lines.join('\n') + '\n')
}

export function buildRowDiffAJsonl(): Uint8Array {
  return toJsonl(rowDiffARows())
}

export function buildRowDiffBJsonl(): Uint8Array {
  return toJsonl(rowDiffBRows())
}

export const ROW_DIFF_BASE: ConformanceOverlayBase = {
  baseAnchor: ROW_DIFF_BASE_ANCHOR,
  overlayAnchor: ROW_DIFF_OVERLAY_ANCHOR,
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'val', type: 'VARCHAR' },
    { name: 'score', type: 'BIGINT' },
  ],
  baseRowCount: A_ROW_COUNT,
}

/** The compiler options the subject/schema compile against. */
export const ROW_DIFF_SCHEMA = [
  { name: 'id', type: 'BIGINT' },
  { name: 'val', type: 'VARCHAR' },
  { name: 'score', type: 'BIGINT' },
] as const

const KEYS = ['id'] as const

/** The 20 base changed samples: A ordinals 0..19, alternating changed columns. */
const BASE_CHANGED: readonly ConformanceRowDiffSample[] = Array.from(
  { length: 20 },
  (_, index) => ({
    side: 'A' as const,
    rowKey: `base:#${String(index)}`,
    changedColumns: index % 2 === 0 ? ['val'] : ['score'],
  }),
)

const BASE_EXPECTATIONS: ConformanceRowDiffExpectations = {
  rowCountA: A_ROW_COUNT,
  rowCountB: B_ROW_COUNT,
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
    { aspect: 'changed', count: 130, samples: BASE_CHANGED },
  ],
}

function rowDiffHostilePlans(): readonly ConformanceHostileRowDiffPlan[] {
  const compiled = compileRowDiffPlan([...ROW_DIFF_SCHEMA], [...ROW_DIFF_SCHEMA], [...KEYS], {
    relationA: ROW_DIFF_RELATION_A,
    relationB: ROW_DIFF_RELATION_B,
    sampleLimit: ROW_DIFF_SAMPLE_LIMIT,
  })
  if (!compiled.ok) throw new Error('row-diff hostile-plan base failed to compile')
  const base = compiled.plan
  const quotedA = `"${ROW_DIFF_RELATION_A}"`
  const quotedB = `"${ROW_DIFF_RELATION_B}"`
  return [
    {
      label: 'wrong plan kind',
      plan: { ...base, planKind: 'assay-row-diff-plan-v2' },
    },
    {
      label: 'wrong plan version',
      plan: { ...base, planVersion: 2 },
    },
    {
      label: 'same relation on both sides',
      plan: { ...base, relationB: ROW_DIFF_RELATION_A },
    },
    {
      label: 'comment-bearing aspect query',
      plan: {
        ...base,
        addedSql: base.addedSql.replace('SELECT', `SELECT /* FROM ${quotedA} AS "a" */`),
      },
    },
    {
      label: 'string-masked pseudo-reference',
      plan: {
        ...base,
        addedSql:
          `SELECT 'FROM ${quotedA} AS "a"' AS "assay_side", ` +
          `0 AS "assay_row_ordinal", 0 AS "assay_count", 'FROM ${quotedB} AS "b"' AS "x"`,
      },
    },
    {
      label: 'CREATE TABLE canary',
      plan: {
        ...base,
        removedSql: 'CREATE TABLE assay_conf_rowdiff_injected AS SELECT 1',
      },
    },
    {
      label: 'multi-statement aspect query',
      plan: {
        ...base,
        addedSql: `${base.addedSql}; CREATE TABLE assay_conf_rowdiff_injected AS SELECT 1`,
      },
    },
    {
      label: 'aspect query drops its side-A binding',
      plan: { ...base, removedSql: base.removedSql.split('"a"').join('"z"') },
    },
    {
      label: 'totals query is not three arms',
      plan: { ...base, totalsSql: base.totalsSql.split('\nUNION ALL\n')[0] as string },
    },
    {
      label: 'gutted reserved result columns',
      plan: { ...base, addedSql: base.addedSql.split('"assay_count"').join('"not_the_count"') },
    },
    {
      label: 'shape-valid plan whose added count exceeds side B',
      plan: {
        ...base,
        addedSql: base.addedSql.replace(
          'count(*) OVER () AS "assay_count"',
          'count(*) OVER () + 1000 AS "assay_count"',
        ),
      },
    },
  ]
}

/** The side-A overlay ops the interaction battery composes. */
export const ROW_DIFF_TOMBSTONE_OPS: readonly EditOp[] = [
  { kind: 'row-delete', rowId: `base:${ROW_DIFF_BASE_ANCHOR}#0` as RowId },
]

export const ROW_DIFF_FIX_OPS: readonly EditOp[] = [
  {
    kind: 'cell-set',
    rowId: `base:${ROW_DIFF_BASE_ANCHOR}#1` as RowId,
    column: 'score',
    value: { kind: 'number', value: 1002 },
  },
]

export const ROW_DIFF_DATASET: ConformanceRowDiffDataset = {
  relationA: ROW_DIFF_RELATION_A,
  relationB: ROW_DIFF_RELATION_B,
  keys: [...KEYS],
  base: ROW_DIFF_BASE,
  sampleLimit: ROW_DIFF_SAMPLE_LIMIT,
  baseExpectations: BASE_EXPECTATIONS,
  interactions: [
    {
      label: 'tombstone A#0 (its B match becomes added)',
      ops: ROW_DIFF_TOMBSTONE_OPS,
      expectations: {
        rowCountA: 131,
        rowCountB: B_ROW_COUNT,
        aspects: [
          { aspect: 'added', count: 131 },
          { aspect: 'removed', count: 2 },
          { aspect: 'changed', count: 129 },
        ],
      },
    },
    {
      label: 'fix A#1 score (a changed row becomes unchanged)',
      ops: ROW_DIFF_FIX_OPS,
      expectations: {
        rowCountA: A_ROW_COUNT,
        rowCountB: B_ROW_COUNT,
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
    hardMax: ROW_DIFF_HARD_MAX,
    clampedSampleLimit: ROW_DIFF_OVER_MAX_SAMPLE_LIMIT,
    expectCount: 130,
    expectSamples: ROW_DIFF_HARD_MAX,
    expectFirstRowKey: 'b:0',
  },
  hostilePlans: rowDiffHostilePlans(),
  injectedTables: ['assay_conf_rowdiff_injected'],
  preExistingViewName: 'assay_conf_rowdiff_existing',
  unsupportedComparisonName: 'comparison.xlsx',
}
