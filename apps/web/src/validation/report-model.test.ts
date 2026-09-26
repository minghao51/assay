// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { compileContract } from '@assay/validation'
import { parseContract } from '@assay/contracts'
import type { ContractV1 } from '@assay/contracts'
import type { EditOp, OverlayBase, RowId } from '@assay/domain'
import { foldOverlay } from '@assay/domain'
import type { EngineValidationPlan, EngineValidationResult } from '@assay/engine-duckdb'
import {
  buildValidationReport,
  compareReportRules,
  contractRuleCount,
  contractRuleFor,
  displayRowKey,
  exportRowKey,
  failureFilterPredicate,
  formatContractParseError,
  NOT_EXPRESSIBLE_FILTER_COPY,
  partialFilterCopy,
  resolveRowKeyIndex,
  sampleValueText,
} from './report-model'

/**
 * Unit pins for the m5-3 report model, driven by the REAL m5-1 compiler
 * (contract A of the e2e journeys: 9 declared rules over a 3-column orders
 * schema) and a hand-built engine result carrying the CLI-derived dataset A
 * counts. The plan/report seam is structural — the compiler's plan assigns
 * to the engine wire shape directly, exactly as the app's run path does.
 *
 * The two e2e journeys pin the same numbers end-to-end through the real
 * engine; these pins exist so a model regression fails in milliseconds with
 * a named expectation instead of a browser run.
 */

const CONTRACT_A_YAML = `format: v1
name: orders-basic
version: 1
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

const SCHEMA_A = [
  { name: 'order_id', type: 'BIGINT' },
  { name: 'region', type: 'VARCHAR' },
  { name: 'amount', type: 'BIGINT' },
]

function parseA(): ContractV1 {
  const parsed = parseContract(CONTRACT_A_YAML)
  if (!parsed.ok)
    throw new Error(`fixture contract failed to parse: ${JSON.stringify(parsed.errors)}`)
  return parsed.contract
}

/** Compile contract A with the app's fixed relation + K. */
function planA(): EngineValidationPlan {
  const compiled = compileContract(parseA(), SCHEMA_A, {
    relation: 'assay_validation_target',
    sampleLimit: 100,
  })
  if (!compiled.ok)
    throw new Error(`fixture contract failed to compile: ${JSON.stringify(compiled.errors)}`)
  return compiled.plan
}

/** The CLI-derived dataset A base-view result (7 rows; summary agreed). */
function resultA(): EngineValidationResult {
  const sample = (rowKey: string, value: string | number | boolean | null) => ({ rowKey, value })
  return {
    valid: false,
    rowCount: 7,
    rules: [
      {
        outcome: 'row-samples',
        ruleId: 'columns[0].type',
        failCount: 0,
        failPercent: 0,
        sampleFailures: [],
      },
      {
        outcome: 'row-samples',
        ruleId: 'columns[0].required',
        failCount: 1,
        failPercent: 14,
        sampleFailures: [sample('base:anchor#6', null)],
      },
      {
        outcome: 'row-samples',
        ruleId: 'columns[0].unique',
        failCount: 2,
        failPercent: 29,
        sampleFailures: [sample('base:anchor#0', 1001), sample('base:anchor#5', 1001)],
      },
      {
        outcome: 'row-samples',
        ruleId: 'columns[1].type',
        failCount: 0,
        failPercent: 0,
        sampleFailures: [],
      },
      {
        outcome: 'row-samples',
        ruleId: 'columns[1].required',
        failCount: 0,
        failPercent: 0,
        sampleFailures: [],
      },
      {
        outcome: 'row-samples',
        ruleId: 'columns[1].allowed-values',
        failCount: 1,
        failPercent: 14,
        sampleFailures: [sample('base:anchor#2', 'emea')],
      },
      {
        outcome: 'row-samples',
        ruleId: 'columns[2].type',
        failCount: 0,
        failPercent: 0,
        sampleFailures: [],
      },
      {
        outcome: 'row-samples',
        ruleId: 'columns[2].max',
        failCount: 1,
        failPercent: 14,
        sampleFailures: [sample('base:anchor#1', 999)],
      },
      {
        outcome: 'dataset-fact',
        ruleId: 'dataset.min-rows',
        failCount: 0,
        failPercent: 0,
        sampleFailures: [],
      },
    ],
  }
}

const CONTRACT_A = parseA()

describe('buildValidationReport: severity ordering (the documented four clauses)', () => {
  const report = buildValidationReport(planA(), resultA(), CONTRACT_A)

  it('orders failing before passing, facts before row rules, share desc, ruleId asc', () => {
    expect(report.rows.map((row) => row.ruleId)).toEqual([
      // Failing: unique has the highest share (2/7 → 29); the three 14%
      // rules tie and break by ruleId ascending.
      'columns[0].unique',
      'columns[0].required',
      'columns[1].allowed-values',
      'columns[2].max',
      // Passing: dataset facts first (ruleId asc), then dataset.min-rows
      // (also a fact), then the remaining row-samples rule.
      'columns[0].type',
      'columns[1].type',
      'columns[2].type',
      'dataset.min-rows',
      'columns[1].required',
    ])
  })

  it('renders the frozen integer failPercent verbatim (never recomputed)', () => {
    const byId = new Map(report.rows.map((row) => [row.ruleId, row]))
    expect(byId.get('columns[0].unique')?.failPercent).toBe(29)
    expect(byId.get('columns[0].required')?.failPercent).toBe(14)
    expect(byId.get('columns[1].allowed-values')?.failPercent).toBe(14)
    expect(byId.get('columns[2].max')?.failPercent).toBe(14)
    expect(byId.get('dataset.min-rows')?.failPercent).toBe(0)
    // A misbehaving-engine share would be surfaced as-is, not corrected.
    const synthetic = buildValidationReport(planA(), { ...resultA(), rowCount: 3 }, null)
    expect(synthetic.rows[0]?.failPercent).toBe(29)
  })

  it('carries the verdict and the effective row count', () => {
    expect(report.valid).toBe(false)
    expect(report.rowCount).toBe(7)
  })

  it('labels rules from the kind vocabulary and keeps ids authoritative', () => {
    const byId = new Map(report.rows.map((row) => [row.ruleId, row]))
    expect(byId.get('columns[0].unique')?.label).toBe('Unique values')
    expect(byId.get('columns[2].max')?.label).toBe('Maximum bound')
    expect(byId.get('dataset.min-rows')?.label).toBe('Minimum row count')
    expect(byId.get('dataset.min-rows')?.column).toBeNull()
  })

  it('marks samples complete for every rule the CLI dataset fully returns', () => {
    for (const row of report.rows) expect(row.samplesComplete).toBe(true)
  })

  it('renders a valid zero-violation verdict honestly (0 across N rules)', () => {
    const clean: EngineValidationResult = {
      valid: true,
      rowCount: 7,
      rules: resultA().rules.map((rule) => ({
        ...rule,
        failCount: 0,
        failPercent: 0,
        sampleFailures: [],
      })),
    }
    const report = buildValidationReport(planA(), clean, CONTRACT_A)
    expect(report.valid).toBe(true)
    expect(report.rows.every((row) => row.failCount === 0 && row.samples.length === 0)).toBe(true)
  })

  it('renders the empty-dataset edge honestly (failPercent 0 by definition)', () => {
    const empty: EngineValidationResult = {
      valid: false,
      rowCount: 0,
      rules: [
        {
          outcome: 'dataset-fact',
          ruleId: 'dataset.min-rows',
          failCount: 1,
          failPercent: 0,
          sampleFailures: [],
        },
      ],
    }
    const plan = planA()
    const emptyPlan: EngineValidationPlan = {
      ...plan,
      rules: plan.rules.filter((r) => r.ruleId === 'dataset.min-rows'),
    }
    const report = buildValidationReport(emptyPlan, empty, CONTRACT_A)
    expect(report.rowCount).toBe(0)
    expect(report.rows[0]?.failPercent).toBe(0)
    expect(report.rows[0]?.failing).toBe(true)
  })
})

describe('filter-to-failures honesty (bounded sets + expressibility)', () => {
  const report = buildValidationReport(planA(), resultA(), CONTRACT_A)
  const byId = new Map(report.rows.map((row) => [row.ruleId, row]))

  it('offers a ready predicate for the five single-column rule kinds', () => {
    expect(byId.get('columns[0].required')?.filter).toEqual({ kind: 'ready', predicate: 'IS NULL' })
    expect(byId.get('columns[2].max')?.filter).toEqual({ kind: 'ready', predicate: '> 500' })
    expect(byId.get('columns[1].allowed-values')?.filter).toEqual({
      kind: 'ready',
      predicate: `IS NOT NULL AND "region" NOT IN ('EMEA', 'APAC', 'US')`,
    })
  })

  it('refuses unique honestly even when the sample set is complete', () => {
    expect(byId.get('columns[0].unique')?.filter).toEqual({ kind: 'not-expressible' })
  })

  it('marks passing rules clean (no control)', () => {
    expect(byId.get('columns[1].required')?.filter).toEqual({ kind: 'clean' })
    expect(byId.get('dataset.min-rows')?.filter).toEqual({ kind: 'clean' })
  })

  it('marks a partial sample set partial and renders the honest copy', () => {
    const result = resultA()
    const partial = result.rules.map((rule) =>
      rule.ruleId === 'columns[1].allowed-values'
        ? {
            ...rule,
            failCount: 110,
            failPercent: 92,
            sampleFailures: Array.from({ length: 100 }, (_, index) => ({
              rowKey: `base:anchor#${String(index)}`,
              value: 'XX',
            })),
          }
        : rule,
    )
    const report = buildValidationReport(planA(), { ...result, rules: partial }, CONTRACT_A)
    const row = report.rows.find((candidate) => candidate.ruleId === 'columns[1].allowed-values')
    expect(row?.samplesComplete).toBe(false)
    expect(row?.filter).toEqual({ kind: 'partial', samplesReturned: 100, failCount: 110 })
    expect(partialFilterCopy(100, 110)).toBe(
      'Sample is partial — 100 of 110 violations were returned, ' +
        'so filtering could hide unfound ones. Export the failure report instead.',
    )
  })

  it('pins the completeness bound exclusively: failCount = returned + 1 is already partial', () => {
    // The minimal realistic partial case (the engine clamps samples at 100,
    // so 101 failures is the first count a clamp would truncate). An
    // off-by-one like `failCount <= samples.length + 1` must fail here, not
    // only at distance-10 shapes.
    const result = resultA()
    const boundary = result.rules.map((rule) =>
      rule.ruleId === 'columns[1].allowed-values'
        ? {
            ...rule,
            failCount: 101,
            failPercent: 92,
            sampleFailures: Array.from({ length: 100 }, (_, index) => ({
              rowKey: `base:anchor#${String(index)}`,
              value: 'XX',
            })),
          }
        : rule,
    )
    const report = buildValidationReport(planA(), { ...result, rules: boundary }, CONTRACT_A)
    const row = report.rows.find((candidate) => candidate.ruleId === 'columns[1].allowed-values')
    expect(row?.samplesComplete).toBe(false)
    expect(row?.filter).toEqual({ kind: 'partial', samplesReturned: 100, failCount: 101 })
  })

  it('mirrors the compiler violation predicates through the same literal helpers', () => {
    const ref = contractRuleFor('columns[1].allowed-values', CONTRACT_A)
    expect(ref?.key).toBe('allowed-values')
    expect(failureFilterPredicate(ref!, 'region')).toBe(
      `IS NOT NULL AND "region" NOT IN ('EMEA', 'APAC', 'US')`,
    )
    // An empty allowed-values list fails every non-NULL value.
    const emptyList = contractRuleFor('columns[1].allowed-values', {
      ...CONTRACT_A,
      columns: CONTRACT_A.columns.map((entry) =>
        entry.name === 'region' ? { ...entry, allowedValues: [] } : entry,
      ),
    })
    expect(failureFilterPredicate(emptyList!, 'region')).toBe('IS NOT NULL')
    // Regex mirrors regexp_full_match; dataset rules have no contract entry.
    const regexContract = `format: v1
name: r
version: 1
columns:
  - name: region
    type: VARCHAR
    regex: '^[A-Z]{2}$'
`
    const parsed = parseContract(regexContract)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      const ref = contractRuleFor('columns[0].regex', parsed.contract)
      expect(failureFilterPredicate(ref!, 'region')).toBe(
        `IS NOT NULL AND NOT regexp_full_match("region", '^[A-Z]{2}$')`,
      )
    }
    expect(contractRuleFor('dataset.min-rows', CONTRACT_A)).toBeNull()
  })

  it('disables for aggregate semantics with pointed copy, not an approximation', () => {
    expect(NOT_EXPRESSIBLE_FILTER_COPY).toContain('no single-column filter')
  })
})

describe('sample text renderings', () => {
  it('renders NULL as an explicit marker, never an empty string', () => {
    expect(sampleValueText(null)).toBe('NULL')
    expect(sampleValueText('emea')).toBe('emea')
    expect(sampleValueText(999)).toBe('999')
    expect(sampleValueText(-5)).toBe('-5')
    expect(sampleValueText(true)).toBe('true')
    expect(sampleValueText(false)).toBe('false')
  })

  it('renders row keys anchor-free for display and export', () => {
    expect(displayRowKey('base:fv-123-456#2')).toBe('base #2')
    expect(displayRowKey('ins:ov-anchor#3')).toBe('insert #3')
    expect(exportRowKey('base:fv-123-456#2')).toBe('base:2')
    expect(exportRowKey('ins:ov-anchor#3')).toBe('insert:3')
    // The anchor fingerprint must never leak through an unparsable key.
    expect(displayRowKey('not-a-key')).toBe('unknown row')
    expect(exportRowKey('not-a-key')).toBe('unknown')
  })
})

describe('resolveRowKeyIndex (jump-to-row targeting)', () => {
  const base: OverlayBase = {
    baseAnchor: 'b-anchor',
    overlayAnchor: 'o-anchor',
    columns: SCHEMA_A,
    baseRowCount: 7,
  }

  it('fast path: an untouched base view resolves a base key to its ordinal', () => {
    const folded = foldOverlay(base, [])
    const resolution = resolveRowKeyIndex(base, folded.state, 'base:b-anchor#2')
    expect(resolution).toEqual({ kind: 'resolved', rowIndex: 2 })
  })

  it('resolves through tombstones and live inserts via the effective order', () => {
    const ops: EditOp[] = [
      { kind: 'row-delete', rowId: 'base:b-anchor#1' as RowId },
      {
        kind: 'row-insert',
        rowId: 'ins:o-anchor#0' as RowId,
        position: { kind: 'end' },
        values: new Map(),
      },
    ]
    const folded = foldOverlay(base, ops)
    // After deleting base #1: rows 0, 2..6 remain (inserts come after).
    expect(resolveRowKeyIndex(base, folded.state, 'base:b-anchor#0')).toEqual({
      kind: 'resolved',
      rowIndex: 0,
    })
    expect(resolveRowKeyIndex(base, folded.state, 'base:b-anchor#2')).toEqual({
      kind: 'resolved',
      rowIndex: 1,
    })
    expect(resolveRowKeyIndex(base, folded.state, 'ins:o-anchor#0')).toEqual({
      kind: 'resolved',
      rowIndex: 6,
    })
  })

  it('reports a deleted (tombstoned) or foreign key as missing — honestly', () => {
    const ops: EditOp[] = [{ kind: 'row-delete', rowId: 'base:b-anchor#1' as RowId }]
    const folded = foldOverlay(base, ops)
    expect(resolveRowKeyIndex(base, folded.state, 'base:b-anchor#1')).toEqual({ kind: 'missing' })
    expect(resolveRowKeyIndex(base, folded.state, 'not-a-key')).toEqual({ kind: 'missing' })
    expect(resolveRowKeyIndex(base, folded.state, 'base:b-anchor#99')).toEqual({ kind: 'missing' })
  })
})

describe('contract-level helpers', () => {
  it('counts declared rules (the count a successful compile plans)', () => {
    expect(contractRuleCount(CONTRACT_A)).toBe(9)
  })

  it('formats parse errors with line/column as report content', () => {
    const parsed = parseContract('format: v2\nname: x\n')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(formatContractParseError(parsed.errors[0])).toMatch(/^line 1, column 9: /)
    }
  })
})

describe('compareReportRules is a total order (mutation-resistant tiebreaks)', () => {
  const row = (
    overdides: Partial<Parameters<typeof compareReportRules>[0]>,
  ): Parameters<typeof compareReportRules>[0] => ({
    outcome: 'row-samples',
    ruleId: 'columns[0].required',
    column: 'c',
    kind: 'required',
    label: 'Required (no NULLs)',
    failCount: 1,
    failPercent: 14,
    failing: true,
    samples: [],
    samplesComplete: true,
    filter: { kind: 'ready', predicate: 'IS NULL' },
    ...overdides,
  })

  it('ranks failing over passing regardless of share', () => {
    expect(compareReportRules(row({ failCount: 1 }), row({ failCount: 0, failPercent: 99 }))).toBe(
      -1,
    )
  })
  it('ranks dataset facts over row rules within a group', () => {
    expect(compareReportRules(row({ outcome: 'dataset-fact' }), row({}))).toBe(-1)
  })
  it('breaks percent ties by ruleId ascending', () => {
    expect(
      compareReportRules(row({ ruleId: 'columns[1].a' }), row({ ruleId: 'columns[1].b' })),
    ).toBe(-1)
    expect(
      compareReportRules(row({ ruleId: 'columns[1].b' }), row({ ruleId: 'columns[1].a' })),
    ).toBe(1)
  })
  it('is reflexive', () => {
    expect(compareReportRules(row({}), row({}))).toBe(0)
  })
})
