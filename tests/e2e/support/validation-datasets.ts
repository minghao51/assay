import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * On-demand dirty datasets for the m5-3 web validation journeys (the m5-2
 * conformance pattern: runtime-built temp files, NEVER committed,
 * deterministic row-for-row). Every expected count below was derived with
 * the pinned DuckDB CLI (v1.5.5, `DUCKDB=/tmp/duckdb`) running the REAL
 * m5-1 compiler's plan for the binding relation `assay_validation_target`
 * over the identical JSONL, and cross-checked against the summary query:
 *
 * Dataset A (7 rows, contract `orders-basic` v1, 9 rules):
 *   columns[0].required   1  (order_id NULL at base ordinal 6)
 *   columns[0].unique     2  (1001 at ordinals 0 and 5)
 *   columns[1].allowed-values 1  ('emea' at ordinal 2 — case-sensitive)
 *   columns[2].max        1  (999 at ordinal 1)
 *   everything else 0; rowCount 7.
 *   failPercent (integer half-up): 2/7→29, 1/7→14.
 *   Fix journey: edit ordinals 5 (1001→1006), 6 (NULL→1009), 2
 *   ('emea'→'EMEA'), 1 (999→450) → every rule 0, valid.
 *
 * Dataset B (120 rows, contract `orders-audit` v2, 12 rules):
 *   columns[3].allowed-values  110  (tag 'bad'; samples clamped to 100 →
 *                                   PARTIAL sample set)
 *   columns[1].allowed-values  24   (region 'XX' ×23 + the formula-bait
 *                                   '=SUM(A1)' at ordinal 4)
 *   columns[2].max             12   (amount 999)
 *   everything else 0; rowCount 120.
 *   failPercent: 110/120→92, 24/120→20, 12/120→10.
 *   The m2-2 filter predicates the panel composes were CLI-verified to
 *   select exactly 24 and 12 rows.
 *
 * Privacy (ADR 0025): the bait string is DATA inside the staged file,
 * proving hostile-looking values fail a contract without executing; it is
 * never logged and appears only where the journeys assert report content.
 */

export interface ValidationDataset {
  /** Path of the staged dataset file (open through the app's open flow). */
  readonly dataPath: string
  /** Path of the staged contract YAML (imported through the panel). */
  readonly contractPath: string
}

const CONTRACT_A_YAML = `format: v1
name: orders-basic
version: 1
description: Basic quality rules for the orders sample
columns:
  - name: order_id
    type: BIGINT
    required: true
    unique: true
  - name: region
    type: VARCHAR
    required: true
    allowed-values: [EMEA, APAC, US]
  - name: amount
    type: BIGINT
    max: 500
dataset:
  min-rows: 5
`

const DATASET_A_ROWS: readonly string[] = [
  '{"order_id":1001,"region":"EMEA","amount":120}',
  '{"order_id":1002,"region":"APAC","amount":999}',
  '{"order_id":1003,"region":"emea","amount":80}',
  '{"order_id":1004,"region":"EMEA","amount":null}',
  '{"order_id":1005,"region":"US","amount":60}',
  '{"order_id":1001,"region":"EMEA","amount":40}',
  '{"order_id":null,"region":"APAC","amount":75}',
]

export const DATASET_A_BAIT = '=SUM(A1)'

const CONTRACT_B_YAML = `format: v1
name: orders-audit
version: 2
columns:
  - name: id
    type: BIGINT
    required: true
    unique: true
  - name: region
    type: VARCHAR
    required: true
    allowed-values: [SG, US]
  - name: amount
    type: BIGINT
    max: 500
  - name: tag
    type: VARCHAR
    required: true
    allowed-values: [good]
dataset:
  min-rows: 100
`

function datasetBRows(): readonly string[] {
  const rows: string[] = []
  for (let i = 0; i < 120; i++) {
    rows.push(
      JSON.stringify({
        id: i + 1,
        region: i === 4 ? DATASET_A_BAIT : i % 5 === 4 ? 'XX' : 'SG',
        amount: i % 10 === 9 ? 999 : i + 1,
        tag: i % 12 === 11 ? 'good' : 'bad',
      }),
    )
  }
  return rows
}

/** Stage dataset A + its contract into a fresh temp dir (never committed). */
export function writeValidationDatasetA(): ValidationDataset {
  const dir = mkdtempSync(path.join(tmpdir(), 'assay-m5-3-a-'))
  const dataPath = path.join(dir, 'orders-dirty-a.jsonl')
  const contractPath = path.join(dir, 'orders-basic.contract.yaml')
  writeFileSync(dataPath, DATASET_A_ROWS.join('\n') + '\n')
  writeFileSync(contractPath, CONTRACT_A_YAML)
  return { dataPath, contractPath }
}

/** Stage dataset B + its contract into a fresh temp dir (never committed). */
export function writeValidationDatasetB(): ValidationDataset {
  const dir = mkdtempSync(path.join(tmpdir(), 'assay-m5-3-b-'))
  const dataPath = path.join(dir, 'orders-dirty-b.jsonl')
  const contractPath = path.join(dir, 'orders-audit.contract.yaml')
  writeFileSync(dataPath, datasetBRows().join('\n') + '\n')
  writeFileSync(contractPath, CONTRACT_B_YAML)
  return { dataPath, contractPath }
}
