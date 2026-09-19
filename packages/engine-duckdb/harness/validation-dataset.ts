/**
 * The m5-2 validation-execution dataset (engine-duckdb subject): an
 * on-demand, runtime-built dirty JSONL dataset (120 rows — the 1M-fixture
 * pattern, never committed), its contract in canonical YAML, and every
 * expectation below derived with the pinned DuckDB CLI (v1.5.5,
 * `DUCKDB=/tmp/duckdb`) over the IDENTICAL composed SQL the worker generates
 * (`composeValidationViewSql` over `assay_t1 = read_json_auto(<this JSONL>)`
 * + the real m5-1 compiler's plan for the binding relation
 * `assay_conf_validate_src`), then round-trip checked against the
 * duckdb-wasm 1.32 build through the real client. Derivation transcript
 * (counts per run; every run's summary agreed with every per-rule count):
 *
 *   contract rules (19): id required/unique; region required/allowed/regex;
 *   amount min/max-null-share; note required/allowed/regex; price
 *   min/max/min-distinct-share; tag required/allowed; ok required/allowed;
 *   dataset min-rows 100 / max-rows 125.
 *
 *   BASE (120 rows): unique 2 (ordinals 0,119 — the duplicated id 1);
 *   region.allowed 24 (XX ×20, x1 ×4); region.regex 4 (x1); amount.min 12
 *   (ordinals 9…119 step 10, values −10…−120); note.allowed 4 (o'brien ×3 +
 *   the DROP-bait payload); note.regex 1 (the payload); price.max 28 (the
 *   ten 999.5 rows plus i+0.5 > 100 for i ≥ 100); tag.allowed 110 ('bad');
 *   everything else 0.
 *
 *   FIX_ONE (edit region#4 'XX'→'SG'): region.allowed 23. VIOLATE_ONE (edit
 *   region#0 'SG'→'ZZ'): region.allowed 25. INSERT_VIOLATING (end insert,
 *   id 1 / region XX / amount −3 / note nope / price 500.5 / tag bad):
 *   rowCount 121 — unique 3 (the insert samples at ordinal 120 under its
 *   ins: key), region.allowed 25, region.regex 4, amount.min 13,
 *   note.allowed 5, price.max 29, tag.allowed 111. DELETE_UNTIL_MIN
 *   (tombstone base#0…#20): rowCount 99 — min-rows flips to 1, unique clears
 *   (both duplicate members deleted), region.allowed 20, region.regex 4,
 *   amount.min 10, note.allowed 3, price.max 27, tag.allowed 90.
 *   INSERT_UNTIL_MAX (six clean end inserts): rowCount 126 — max-rows flips
 *   to 1 and min-distinct-share flips to 1 (the repeated 50.5), everything
 *   else unchanged. FIX_ALL (an edit per violating cell; over-limit prices
 *   get distinct sub-100 values): EVERY rule 0, valid=true.
 *
 * Percents are the m5-2 written formula (integer half-up over
 * failCount/rowCount) — the scenario re-derives them from the formula and
 * the literals below were generated from it as well.
 *
 * Engine type reality (CLI 1.5.5, re-verified): DuckDB's JSON inference
 * widens a MIXED-SIGN integer column to HUGEINT (all-negative or
 * non-negative columns infer BIGINT; the dataset deliberately keeps both
 * signs — realistic dirt), so `amount` is reported HUGEINT and the plan
 * binds against that spelling. Through the wasm Arrow path its sample
 * values arrive as exact JS numbers (safe range), so the amount pins below
 * are numbers; the CLI's -json projection shows the same numbers.
 *
 * FIX_ALL pins every column rule at 0 (all violating cells edited; the
 * dataset row-count facts stay met at 120 rows), so the total verdict
 * flips to valid — the m5-3 exit-journey shape.
 *
 * Privacy (ADR 0025): the payload string below is DATA inside the staged
 * file, used to prove hostile-looking values validate correctly (they merely
 * fail the contract); it is never executed and never logged.
 */
import { compileContract } from '@assay/validation'
import type { EngineSchema, ValidationPlan } from '@assay/validation'
import { parseContract } from '@assay/contracts'
import type { ContractV1 } from '@assay/contracts'
import type {
  ConformanceEditOp,
  ConformanceOverlayBase,
  ConformanceValidationDataset,
  ConformanceValidationExpectations,
  ConformanceValidationPlan,
  ConformanceValidationRuleExpectation,
  ConformanceValidationSample,
} from '@assay/testing'
import type { CellValue, EditOp, OverlayBase, RowId } from '@assay/domain'

export const VALIDATION_ROW_COUNT = 120
export const VALIDATION_BASE_ANCHOR = 'val-anchor-v1'
export const VALIDATION_OVERLAY_ANCHOR = 'val-ov-1'
export const VALIDATION_RELATION = 'assay_conf_validate_src'
export const VALIDATION_SAMPLE_LIMIT = 20
/** The engine's documented hard max (a plan with exactly this K executes). */
export const VALIDATION_HARD_MAX_SAMPLE_LIMIT = 100
/** A K past the hard max: the plan EXECUTES with samples clamped to 100 (m5-2 round-3: clamped, not rejected). */
export const VALIDATION_OVER_MAX_SAMPLE_LIMIT = 500
/** Reported samples under the hard-max plan: min(110 violations, 100). */
export const VALIDATION_EXPECTED_SAMPLES_AT_MAX = 100
/** A user-created (non-registered) view the survival probe binds against. */
export const VALIDATION_PRE_EXISTING_VIEW = 'review_existing'

/** The DROP-bait row value: hostile-looking DATA that must simply fail the contract. */
export const VALIDATION_BAIT_VALUE = "'; DROP TABLE assay_conf_injected; --"

/** The on-demand dirty dataset rows (deterministic; see the module doc). */
export function validationRows(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < VALIDATION_ROW_COUNT; i++) {
    rows.push({
      id: i === 119 ? 1 : i + 1,
      region: i % 25 === 24 ? 'x1' : i % 5 === 4 ? 'XX' : 'SG',
      amount: i === 7 ? null : i % 10 === 9 ? -(i + 1) : i + 1,
      note:
        i === 11 || i === 37 || i === 83
          ? "o'brien"
          : i === 59
            ? VALIDATION_BAIT_VALUE
            : i === 13 || i === 71
              ? 'it\'s "quoted"'
              : 'ok',
      price: i % 12 === 11 ? 999.5 : i + 0.5,
      tag: i % 12 === 11 ? 'good' : 'bad',
      ok: true,
    })
  }
  return rows
}

/** Runtime-built JSONL bytes (never committed). */
export function buildValidationJsonl(): Uint8Array {
  const lines = validationRows().map((row) => JSON.stringify(row))
  return new TextEncoder().encode(lines.join('\n') + '\n')
}

export const VALIDATION_BASE: ConformanceOverlayBase = {
  baseAnchor: VALIDATION_BASE_ANCHOR,
  overlayAnchor: VALIDATION_OVERLAY_ANCHOR,
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'region', type: 'VARCHAR' },
    // DuckDB's JSON inference widens mixed-sign integer columns to HUGEINT
    // (CLI 1.5.5-verified); this is the type the engine schema reports.
    { name: 'amount', type: 'HUGEINT' },
    { name: 'note', type: 'VARCHAR' },
    { name: 'price', type: 'DOUBLE' },
    { name: 'tag', type: 'VARCHAR' },
    { name: 'ok', type: 'BOOLEAN' },
  ],
  baseRowCount: VALIDATION_ROW_COUNT,
}

export const VALIDATION_CONTRACT_YAML = `format: v1
name: conf-validation
version: 1
columns:
  - name: id
    required: true
    unique: true
  - name: region
    required: true
    allowed-values: [SG, US, DE]
    regex: '^[A-Z]{2}$'
  - name: amount
    min: 0
    max-null-share: 0.05
  - name: note
    required: true
    allowed-values: ["ok", "it's \\"quoted\\"", "say \\"hi\\""]
    regex: '^[a-z ''";]*$'
  - name: price
    min: 0
    max: 100.0
    min-distinct-share: 0.9
  - name: tag
    required: true
    allowed-values: [good]
  - name: ok
    required: true
    allowed-values: [true]
dataset:
  min-rows: 100
  max-rows: 125
`

/**
 * The m5-2 failPercent definition (integer half-up) — used to generate the
 * pinned literals below from the CLI-derived counts; the scenario
 * cross-checks every literal against this same written formula.
 */
function pct(failCount: number, rowCount: number): number {
  return rowCount === 0 ? 0 : Math.floor((failCount * 200 + rowCount) / (2 * rowCount))
}

/** A base row key for the given anchor prefix ('' = the absent-overlay run). */
function key(anchor: string, ordinal: number): string {
  return `base:${anchor}#${String(ordinal)}`
}

const cell = (value: CellValue): CellValue => value

/** CLI-derived per-rule fail counts of one run (ruleId → count), BASE run. */
const BASE_COUNTS: ReadonlyArray<readonly [string, number]> = [
  ['columns[0].required', 0],
  ['columns[0].unique', 2],
  ['columns[1].required', 0],
  ['columns[1].allowed-values', 24],
  ['columns[1].regex', 4],
  ['columns[2].min', 12],
  ['columns[2].max-null-share', 0],
  ['columns[3].required', 0],
  ['columns[3].allowed-values', 4],
  ['columns[3].regex', 1],
  ['columns[4].min', 0],
  ['columns[4].max', 28],
  ['columns[4].min-distinct-share', 0],
  ['columns[5].required', 0],
  ['columns[5].allowed-values', 110],
  ['columns[6].required', 0],
  ['columns[6].allowed-values', 0],
  ['dataset.min-rows', 0],
  ['dataset.max-rows', 0],
]

/**
 * Sample pins per rule: the FULL list for sets at or under the plan K (20),
 * else only the first entry. `anchor` re-keys for the overlay runs.
 */
function samplePins(anchor: string): ReadonlyMap<string, ConformanceValidationSample[]> {
  const k = (ordinal: number): string => key(anchor, ordinal)
  const entries: ReadonlyArray<readonly [string, ConformanceValidationSample[]]> = [
    [
      'columns[0].unique',
      [
        { rowKey: k(0), value: 1 },
        { rowKey: k(119), value: 1 },
      ],
    ],
    ['columns[1].allowed-values', [{ rowKey: k(4), value: 'XX' }]],
    [
      'columns[1].regex',
      [
        { rowKey: k(24), value: 'x1' },
        { rowKey: k(49), value: 'x1' },
        { rowKey: k(74), value: 'x1' },
        { rowKey: k(99), value: 'x1' },
      ],
    ],
    [
      // amount is HUGEINT (mixed-sign JSON widening — module doc); through
      // the wasm Arrow path its samples arrive as exact JS numbers.
      'columns[2].min',
      Array.from({ length: 12 }, (_, index) => ({
        rowKey: k(9 + index * 10),
        value: -(10 + index * 10),
      })),
    ],
    [
      'columns[3].allowed-values',
      [
        { rowKey: k(11), value: "o'brien" },
        { rowKey: k(37), value: "o'brien" },
        { rowKey: k(59), value: VALIDATION_BAIT_VALUE },
        { rowKey: k(83), value: "o'brien" },
      ],
    ],
    ['columns[3].regex', [{ rowKey: k(59), value: VALIDATION_BAIT_VALUE }]],
    [
      'columns[4].max',
      Array.from({ length: 10 }, (_, index) => ({
        rowKey: k(11 + index * 12),
        value: 999.5,
      })),
    ],
    ['columns[5].allowed-values', [{ rowKey: k(0), value: 'bad' }]],
  ]
  return new Map(entries)
}

/** Build the anchored expectations for one run from counts + patch overrides. */
function expectations(
  anchor: string,
  rowCount: number,
  counts: ReadonlyArray<readonly [string, number]>,
  overrides: ReadonlyMap<string, number> = new Map(),
  pinOverrides: ReadonlyMap<string, ConformanceValidationSample[]> = new Map(),
): ConformanceValidationExpectations {
  const pins = samplePins(anchor)
  const rules: ConformanceValidationRuleExpectation[] = counts.map(([ruleId, baseCount]) => {
    const failCount = overrides.get(ruleId) ?? baseCount
    // Sample pins are pinned for the run whose counts they describe (the
    // base counts). An explicit override always wins (e.g. the inserted
    // row's unique samples); a patched count without one drops the static
    // pin — it no longer describes the run — while an unpatched rule keeps
    // its anchored static pin (full list when every violation fits, else
    // the first sample).
    const baseCount0 = BASE_COUNTS.find(([id]) => id === ruleId)?.[1] ?? -1
    const patched = failCount !== baseCount0
    const override = pinOverrides.get(ruleId)
    const pin = override ?? (patched ? undefined : pins.get(ruleId))
    if (failCount === 0 || pin === undefined) {
      return { ruleId, failCount, failPercent: pct(failCount, rowCount) }
    }
    return {
      ruleId,
      failCount,
      failPercent: pct(failCount, rowCount),
      ...(pin.length === failCount ? { samples: pin } : { firstSample: pin[0] }),
    }
  })
  return { valid: rules.every((rule) => rule.failCount === 0), rowCount, rules }
}

/** The absent-overlay run: empty anchor in row keys. */
const BASE_EXPECTATIONS = expectations('', VALIDATION_ROW_COUNT, BASE_COUNTS)
/** The empty-ops overlay run: same counts, session-anchored row keys. */
const EMPTY_OVERLAY_EXPECTATIONS = expectations(
  VALIDATION_BASE_ANCHOR,
  VALIDATION_ROW_COUNT,
  BASE_COUNTS,
)

/** Interaction expectations = anchored base with count overrides. */
function interaction(
  label: string,
  ops: readonly ConformanceEditOp[],
  rowCount: number,
  overrides: ReadonlyArray<readonly [string, number]>,
  pinOverrides: ReadonlyMap<string, ConformanceValidationSample[]> = new Map(),
): {
  readonly label: string
  readonly ops: readonly ConformanceEditOp[]
  readonly expectations: ConformanceValidationExpectations
} {
  return {
    label,
    ops,
    expectations: expectations(
      VALIDATION_BASE_ANCHOR,
      rowCount,
      BASE_COUNTS,
      new Map(overrides),
      pinOverrides,
    ),
  }
}

const deleteUntilMinOps: EditOp[] = Array.from({ length: 21 }, (_, i) => ({
  kind: 'row-delete',
  rowId: `base:${VALIDATION_BASE_ANCHOR}#${String(i)}` as RowId,
}))

const insertUntilMaxOps: EditOp[] = Array.from({ length: 6 }, (_, seq) => ({
  kind: 'row-insert',
  rowId: `ins:${VALIDATION_OVERLAY_ANCHOR}#${String(seq)}` as RowId,
  position: { kind: 'end' },
  values: new Map<string, CellValue>([
    ['id', cell({ kind: 'number', value: 500 + seq })],
    ['region', cell({ kind: 'string', value: 'SG' })],
    ['amount', cell({ kind: 'number', value: 50 })],
    ['note', cell({ kind: 'string', value: 'ok' })],
    ['price', cell({ kind: 'number', value: 50.5 })],
    ['tag', cell({ kind: 'string', value: 'good' })],
    ['ok', cell({ kind: 'boolean', value: true })],
  ]),
}))

/** Fix every violating cell (see the module doc for the derivation). */
export const VALIDATION_FIX_ALL_OPS: EditOp[] = [
  {
    kind: 'cell-set',
    rowId: key(VALIDATION_BASE_ANCHOR, 119) as RowId,
    column: 'id',
    value: cell({ kind: 'number', value: 999 }),
  },
  ...Array.from({ length: VALIDATION_ROW_COUNT }, (_, i) => i)
    .filter((i) => i % 5 === 4)
    .map(
      (i) =>
        ({
          kind: 'cell-set',
          rowId: key(VALIDATION_BASE_ANCHOR, i) as RowId,
          column: 'region',
          value: cell({ kind: 'string', value: 'US' }),
        }) as EditOp,
    ),
  ...Array.from({ length: VALIDATION_ROW_COUNT }, (_, i) => i)
    .filter((i) => i % 10 === 9)
    .map(
      (i) =>
        ({
          kind: 'cell-set',
          rowId: key(VALIDATION_BASE_ANCHOR, i) as RowId,
          column: 'amount',
          value: cell({ kind: 'number', value: 1 }),
        }) as EditOp,
    ),
  ...[11, 37, 59, 83].map(
    (i) =>
      ({
        kind: 'cell-set',
        rowId: key(VALIDATION_BASE_ANCHOR, i) as RowId,
        column: 'note',
        value: cell({ kind: 'string', value: 'ok' }),
      }) as EditOp,
  ),
  ...Array.from({ length: VALIDATION_ROW_COUNT }, (_, i) => i)
    .filter((i) => i % 12 === 11 || i >= 100)
    .map(
      (i) =>
        ({
          kind: 'cell-set',
          rowId: key(VALIDATION_BASE_ANCHOR, i) as RowId,
          column: 'price',
          value: cell({ kind: 'number', value: 50 + i * 0.001 }),
        }) as EditOp,
    ),
  ...Array.from({ length: VALIDATION_ROW_COUNT }, (_, i) => i)
    .filter((i) => i % 12 !== 11)
    .map(
      (i) =>
        ({
          kind: 'cell-set',
          rowId: key(VALIDATION_BASE_ANCHOR, i) as RowId,
          column: 'tag',
          value: cell({ kind: 'string', value: 'good' }),
        }) as EditOp,
    ),
]

/** A hand-built wire-shape plan (structural literal) for a hostile probe. */
function hostilePlan(overrides: Partial<ConformanceValidationPlan>): ConformanceValidationPlan {
  return {
    planKind: 'assay-validation-plan',
    planVersion: 1,
    contractName: 'hostile',
    contractVersion: 1,
    relation: VALIDATION_RELATION,
    sampleLimit: 20,
    rules: [],
    summarySql:
      'SELECT CAST(NULL AS VARCHAR) AS "rule_id", CAST(NULL AS BIGINT) AS "total_rows", ' +
      'CAST(NULL AS BIGINT) AS "fail_count" WHERE FALSE',
    ...overrides,
  }
}

export const VALIDATION_DATASET: ConformanceValidationDataset = {
  contractYaml: VALIDATION_CONTRACT_YAML,
  planRelation: VALIDATION_RELATION,
  sampleLimit: VALIDATION_SAMPLE_LIMIT,
  base: VALIDATION_BASE,
  baseExpectations: BASE_EXPECTATIONS,
  emptyOverlayExpectations: EMPTY_OVERLAY_EXPECTATIONS,
  interactions: [
    interaction(
      'fix-one: region #4 edited XX->SG (allowed-values 24 -> 23)',
      [
        {
          kind: 'cell-set',
          rowId: key(VALIDATION_BASE_ANCHOR, 4) as RowId,
          column: 'region',
          value: cell({ kind: 'string', value: 'SG' }),
        },
      ],
      120,
      [['columns[1].allowed-values', 23]],
    ),
    interaction(
      'violate-one: region #0 edited SG->ZZ (allowed-values 24 -> 25)',
      [
        {
          kind: 'cell-set',
          rowId: key(VALIDATION_BASE_ANCHOR, 0) as RowId,
          column: 'region',
          value: cell({ kind: 'string', value: 'ZZ' }),
        },
      ],
      120,
      [['columns[1].allowed-values', 25]],
    ),
    interaction(
      'insert-violating: a duplicated id 1 arrives (unique 2 -> 3 under its ins: key)',
      [
        {
          kind: 'row-insert',
          rowId: `ins:${VALIDATION_OVERLAY_ANCHOR}#0` as RowId,
          position: { kind: 'end' },
          values: new Map<string, CellValue>([
            ['id', cell({ kind: 'number', value: 1 })],
            ['region', cell({ kind: 'string', value: 'XX' })],
            ['amount', cell({ kind: 'number', value: -3 })],
            ['note', cell({ kind: 'string', value: 'nope' })],
            ['price', cell({ kind: 'number', value: 500.5 })],
            ['tag', cell({ kind: 'string', value: 'bad' })],
            ['ok', cell({ kind: 'boolean', value: true })],
          ]),
        },
      ],
      121,
      [
        ['columns[0].unique', 3],
        ['columns[1].allowed-values', 25],
        ['columns[1].regex', 4],
        ['columns[2].min', 13],
        ['columns[3].allowed-values', 5],
        ['columns[4].max', 29],
        ['columns[5].allowed-values', 111],
      ],
      new Map([
        [
          'columns[0].unique',
          [
            { rowKey: key(VALIDATION_BASE_ANCHOR, 0), value: 1 },
            { rowKey: key(VALIDATION_BASE_ANCHOR, 119), value: 1 },
            { rowKey: `ins:${VALIDATION_OVERLAY_ANCHOR}#0`, value: 1 },
          ],
        ],
      ]),
    ),
    interaction(
      'tombstone: rows #0..#20 deleted (min-rows flips to 1; unique clears)',
      deleteUntilMinOps,
      99,
      [
        ['columns[0].unique', 0],
        ['columns[1].allowed-values', 20],
        ['columns[2].min', 10],
        ['columns[3].allowed-values', 3],
        ['columns[4].max', 27],
        ['columns[5].allowed-values', 90],
        ['dataset.min-rows', 1],
      ],
    ),
    interaction(
      'insert-until-max: six clean inserts (max-rows and min-distinct-share flip to 1)',
      insertUntilMaxOps,
      126,
      [
        ['columns[4].min-distinct-share', 1],
        ['dataset.max-rows', 1],
      ],
    ),
    interaction(
      'fix-all: every violating cell edited (all rules 0, verdict flips to valid)',
      VALIDATION_FIX_ALL_OPS as unknown as ConformanceEditOp[],
      120,
      // Every column rule lands at exactly 0 (the dataset row-count facts
      // stay met); the scenario counts one fix flip per rule that was
      // failing on the base run — 8 here, plus the tombstone run's unique.
      BASE_COUNTS.filter(([ruleId]) => !ruleId.startsWith('dataset.')).map(
        ([ruleId]) => [ruleId, 0] as const,
      ),
    ),
  ],
  truncation: {
    ruleId: 'columns[5].allowed-values',
    hardMax: VALIDATION_HARD_MAX_SAMPLE_LIMIT,
    clampedSampleLimit: VALIDATION_OVER_MAX_SAMPLE_LIMIT,
    expectFailCount: 110,
    expectSamples: VALIDATION_EXPECTED_SAMPLES_AT_MAX,
    expectFirstRowKey: key('', 0),
    expectFirstValue: 'bad',
  },
  hostilePlans: [
    { label: 'wrong planKind', plan: hostilePlan({ planKind: 'assay-validation-plan-v2' }) },
    { label: 'planVersion 2', plan: hostilePlan({ planVersion: 2 }) },
    { label: 'sampleLimit below 1', plan: hostilePlan({ sampleLimit: 0 }) },
    { label: 'relation with a NUL character', plan: hostilePlan({ relation: 'a\u0000b' }) },
    {
      label: 'relation shadows the registered base view',
      plan: hostilePlan({ relation: 'assay_t1' }),
    },
    {
      label: 'relation token smuggled outside the compiler FROM shape',
      plan: hostilePlan({
        rules: [
          {
            ruleId: 'columns[0].required',
            path: 'columns[0].required',
            kind: 'required',
            column: 'id',
            outcome: 'row-samples',
            sql: `SELECT 1 AS "total_rows" WHERE "${VALIDATION_RELATION}" IS NULL; CREATE TABLE assay_conf_injected AS SELECT 1`,
          },
        ],
      }),
    },
    {
      // The m5-2 fix round's canary probes — the review's exact payload,
      // with no relation occurrence: rejected at the static gate before any
      // SQL runs; the canary is asserted absent via catalog listing below.
      label: 'canary CREATE TABLE without a relation occurrence',
      plan: hostilePlan({
        rules: [
          {
            ruleId: 'columns[0].required',
            path: 'columns[0].required',
            kind: 'required',
            column: 'id',
            outcome: 'row-samples',
            sql: 'CREATE TABLE review_injected AS SELECT 1',
          },
        ],
      }),
    },
    {
      // The same canary wearing a compiler-shaped relation occurrence (a
      // CTAS whose FROM sits exactly in the compiler's rendering) — the
      // shape the original occurrence gate alone could not distinguish.
      label: 'canary CREATE TABLE with a compiler-shaped relation occurrence',
      plan: hostilePlan({
        rules: [
          {
            ruleId: 'columns[0].required',
            path: 'columns[0].required',
            kind: 'required',
            column: 'id',
            outcome: 'row-samples',
            sql: `CREATE TABLE review_injected AS SELECT * FROM "${VALIDATION_RELATION}" AS "src" WHERE FALSE`,
          },
        ],
      }),
    },
    // m5-2 round 3, item 1: comment-bearing SQL is refused outright. The
    // reviewer's exact probe — a block comment carrying the compiler's FROM
    // shape — must NOT read as a relation binding, and no comment-bearing
    // SQL may run; each probe rejects with one typed operation error.
    {
      label: 'block-comment pseudo-reference (review round-3 probe)',
      plan: hostilePlan({
        rules: [
          {
            ruleId: 'columns[0].required',
            path: 'columns[0].required',
            kind: 'required',
            column: 'id',
            outcome: 'row-samples',
            sql: `SELECT 1 AS "total_rows" /* FROM "${VALIDATION_RELATION}" AS "src" */`,
          },
        ],
      }),
    },
    {
      label: 'line-comment tail',
      plan: hostilePlan({
        rules: [
          {
            ruleId: 'columns[0].required',
            path: 'columns[0].required',
            kind: 'required',
            column: 'id',
            outcome: 'row-samples',
            sql: `SELECT 1 AS "total_rows" FROM "${VALIDATION_RELATION}" AS "src" -- tail`,
          },
        ],
      }),
    },
    {
      // m5-2 round 3, item 3: a shape-valid (but foreign, non-compiler)
      // plan whose reported count exceeds the dataset (121 "failures" over
      // 120 rows) cannot produce an out-of-contract result — the
      // result-sanity guard fails the op with one typed error (never a
      // failPercent > 100 response a client would hang on). The rule SQL is
      // deliberately compiler-shaped (single SELECT, FROM-bound, a
      // compiler-shaped summary) so the static gate passes and the plan
      // EXECUTES — the guard is what stops it. This probe is a DATASET-FACT
      // rule, so the m5-4 refined per-outcome bound (a fact fails at most
      // once) rejects it a fortiori; the row-count bound still covers
      // row-samples rules.
      label: 'shape-valid plan reporting more failures than rows',
      plan: hostilePlan({
        rules: [
          {
            ruleId: 'dataset.max-rows',
            path: 'dataset.max-rows',
            kind: 'max-rows',
            column: null,
            outcome: 'dataset-fact',
            sql: `SELECT 120 AS "total_rows", 121 AS "fail_count" FROM "${VALIDATION_RELATION}" AS "src" LIMIT 1`,
          },
        ],
        summarySql:
          `SELECT 'dataset.max-rows' AS "rule_id", "assay_n" AS "total_rows", "assay_n" AS "fail_count"\n` +
          `FROM (SELECT count(*) AS "assay_n" FROM "${VALIDATION_RELATION}" AS "src") AS "assay_rule_stats"`,
      }),
    },
  ],
  injectedTables: ['assay_conf_injected', 'review_injected'],
  preExistingViewName: VALIDATION_PRE_EXISTING_VIEW,
  vocabularyPrefix: 'v_',
  decimalReportedType: 'DECIMAL(18,3)',
}

/**
 * Compile the contract against an engine-reported schema (the real m5-1
 * compiler) — shared by the conformance scenario path and the harness's
 * validate journey section.
 */
export function compileValidationPlan(schema: EngineSchema, sampleLimit: number): ValidationPlan {
  const parsed = parseContract(VALIDATION_CONTRACT_YAML)
  if (!parsed.ok) {
    throw new Error(
      `validation harness contract failed to parse: ${String(parsed.errors[0]?.message)}`,
    )
  }
  const compiled = compileContract(parsed.contract as ContractV1, schema, {
    relation: VALIDATION_RELATION,
    sampleLimit,
  })
  if (!compiled.ok) {
    throw new Error(
      `validation harness contract failed to bind: ${String((compiled.errors[0] as { message?: string })?.message)}`,
    )
  }
  return compiled.plan
}

/** The overlay base as the domain type (for client.validate overlay runs). */
export const VALIDATION_OVERLAY_BASE: OverlayBase = VALIDATION_BASE
