// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration-test dataset builders (m5-4) — runtime-built dirty files in
 * temp directories, NEVER committed (the m5-2 conformance discipline).
 *
 * `buildSmallDirty*` is a hand-checkable 6-row CSV whose expected report
 * bytes are pinned literally in the integration tests; `buildValidationRows`
 * rebuilds the m5-2 conformance dirty dataset (120 rows) on demand so the
 * cross-surface agreement test pins the SAME CLI-1.5.5-derived expectations
 * the engine conformance scenario pins (never imported from the harness —
 * rebuilt here, per the task boundary "rebuild it on-demand in the test").
 */

/** The 6-row small dirty dataset (CSV body). */
export const SMALL_DIRTY_CSV = [
  'id,region,amount,note',
  '1,SG,10,ok',
  '2,XX,25,ok',
  '3,SG,,it\'s "quoted"',
  '1,SG,7,ok',
  '5,SG,-3,fine',
  '6,ZZ,12,ok',
  '',
].join('\n')

/** The contract the small dirty dataset fails in exactly 3 of 8 rules. */
export const SMALL_DIRTY_CONTRACT = `format: v1
name: small-dirty
version: 1
columns:
  - name: id
    required: true
    unique: true
  - name: region
    required: true
    allowed-values: [SG, US, DE]
  - name: amount
    min: 0
  - name: note
    required: true
dataset:
  min-rows: 3
  max-rows: 100
`

/** A contract that binds nothing but the row-count facts (honest zero states). */
export const CLEAN_CONTRACT = `format: v1
name: clean-check
version: 3
columns:
  - name: id
    required: true
  - name: region
    required: true
    allowed-values: [SG, XX, ZZ]
dataset:
  min-rows: 1
  max-rows: 1000
`

/** A contract with a rule addressing a column the dataset does not have. */
export const BINDING_ERROR_CONTRACT = `format: v1
name: ghosty
version: 1
columns:
  - name: ghost_col
    required: true
  - name: region
    min: 1
`

/** A contract that violates the m5-0 range rule `min ≤ max` (line/column pins). */
export const MALFORMED_CONTRACT = `format: v1
name: bad
version: 1
columns:
  - name: id
    min: 5
    max: 1
`

/** A contract with a YAML syntax error (line/column pins). */
export const MALFORMED_YAML_CONTRACT = `format: v1
name: bad
version: 1
columns:
  - name: id
   min: [unclosed
`

/** A contract with an unknown rule key (the m5-0 unknown-key error). */
export const UNKNOWN_KEY_CONTRACT = `format: v1
name: bad
version: 1
columns:
  - name: id
    frobnicate: true
`

/** A contract whose only column rules bind (empty CSV infers all-VARCHAR). */
export const EMPTY_DATASET_CONTRACT = `format: v1
name: empty-check
version: 1
columns:
  - name: id
    required: true
  - name: amount
    regex: "^[0-9]+$"
dataset:
  max-rows: 1000
`

/** The m5-2 conformance contract (canonical YAML, verbatim structure). */
export const VALIDATION_CONTRACT = `format: v1
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

/** The m5-2 conformance dirty dataset: 120 deterministic rows. */
export function buildValidationRows(): Record<string, unknown>[] {
  const bait = "'; DROP TABLE assay_conf_injected; --"
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < 120; i++) {
    rows.push({
      id: i === 119 ? 1 : i + 1,
      region: i % 25 === 24 ? 'x1' : i % 5 === 4 ? 'XX' : 'SG',
      amount: i === 7 ? null : i % 10 === 9 ? -(i + 1) : i + 1,
      note:
        i === 11 || i === 37 || i === 83
          ? "o'brien"
          : i === 59
            ? bait
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

/** The dirty dataset as JSONL bytes (the engine conformance staging format). */
export function buildValidationJsonl(): string {
  return (
    buildValidationRows()
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n'
  )
}

/**
 * The m5-2 CLI-1.5.5-derived BASE per-rule fail counts (ruleId → count).
 * Derived with the pinned DuckDB CLI v1.5.5 over the identical composed view
 * + plan SQL (the m5-2 conformance dataset transcript); the agreement test
 * asserts the Node backend reproduces every count exactly.
 */
export const VALIDATION_BASE_COUNTS: ReadonlyArray<readonly [string, number]> = [
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

/** The m5-2 first-sample pins for key failing rules (rowKey, value). */
export const VALIDATION_FIRST_SAMPLES: ReadonlyArray<readonly [string, string, string | number]> = [
  ['columns[0].unique', 'base:#0', 1],
  ['columns[1].allowed-values', 'base:#4', 'XX'],
  ['columns[1].regex', 'base:#24', 'x1'],
  ['columns[2].min', 'base:#9', -10],
  ['columns[3].allowed-values', 'base:#11', "o'brien"],
  ['columns[3].regex', 'base:#59', "'; DROP TABLE assay_conf_injected; --"],
  ['columns[4].max', 'base:#11', 999.5],
  ['columns[5].allowed-values', 'base:#0', 'bad'],
]
