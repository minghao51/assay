// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for the m5-4 report model (pure half): the severity ordering
 * clauses, the canonical text renderings, the report builder's defensive
 * degradation, and renderer byte-determinism (same input ⇒ identical bytes).
 * The full-pipeline byte pins live in the integration tests.
 */
import { describe, expect, it } from 'vitest'
import {
  buildValidationReport,
  compareReportRules,
  displayRowKey,
  exportRowKey,
  renderHumanReport,
  renderJsonReport,
  ruleLabel,
  sampleValueText,
} from './report.js'
import type { ReportMeta, ValidationReportRow } from './report.js'
import { readCliVersion } from './version.js'
import type { EngineValidationPlan, EngineValidationResult } from '@assay/engine-duckdb/node'

/** A report row with only the ordering-relevant fields set. */
function row(overrides: Partial<ValidationReportRow>): ValidationReportRow {
  return {
    ruleId: 'columns[0].required',
    column: 'id',
    kind: 'required',
    label: ruleLabel('required'),
    failCount: 0,
    failPercent: 0,
    failing: false,
    outcome: 'row-samples',
    samples: [],
    samplesComplete: true,
    ...overrides,
  }
}

const META: ReportMeta = {
  contractName: 'c',
  contractVersion: 1,
  datasetName: 'd.csv',
  format: 'csv',
  sampleLimitRequested: 20,
  sampleLimitEffective: 20,
}

/** A two-rule plan fixture shared by the builder + renderer tests. */
const plan: EngineValidationPlan = {
  planKind: 'assay-validation-plan',
  planVersion: 1,
  contractName: 'c',
  contractVersion: 1,
  relation: 'r',
  sampleLimit: 20,
  rules: [
    {
      ruleId: 'columns[0].min',
      path: 'columns[0].min',
      kind: 'min',
      column: 'amount',
      outcome: 'row-samples',
      sql: 'SELECT 1',
    },
    {
      ruleId: 'dataset.max-rows',
      path: 'dataset.max-rows',
      kind: 'max-rows',
      column: null,
      outcome: 'dataset-fact',
      sql: 'SELECT 1',
    },
  ],
  summarySql: 'SELECT 1',
}

describe('severity ordering (the documented m5-3 clauses)', () => {
  it('1 — failing rules sort before passing rules', () => {
    const failing = row({ failCount: 1, failPercent: 1, failing: true })
    const passing = row({})
    expect(compareReportRules(failing, passing)).toBeLessThan(0)
    expect(compareReportRules(passing, failing)).toBeGreaterThan(0)
  })

  it('2 — dataset facts sort before row rules within each group', () => {
    const fact = row({ outcome: 'dataset-fact' })
    const rowRule = row({ outcome: 'row-samples' })
    expect(compareReportRules(fact, rowRule)).toBeLessThan(0)
    expect(compareReportRules(rowRule, fact)).toBeGreaterThan(0)
    // Within the FAILING group too: a passing fact still sorts by failing
    // first, but two failing rules put the fact first regardless of percent? —
    // no: failing is clause 1, fact is clause 2, percent is clause 3. A
    // failing fact with a LOWER percent still precedes the failing row rule.
    const failingFact = row({
      outcome: 'dataset-fact',
      failCount: 1,
      failPercent: 1,
      failing: true,
    })
    const failingRow = row({
      outcome: 'row-samples',
      failCount: 99,
      failPercent: 99,
      failing: true,
    })
    expect(compareReportRules(failingFact, failingRow)).toBeLessThan(0)
  })

  it('3 — higher frozen failPercent first', () => {
    const high = row({ failCount: 9, failPercent: 50, failing: true })
    const low = row({ failCount: 2, failPercent: 10, failing: true })
    expect(compareReportRules(high, low)).toBeLessThan(0)
    expect(compareReportRules(low, high)).toBeGreaterThan(0)
  })

  it('4 — ruleId ascending (code-unit order) is the total tiebreak', () => {
    const a = row({ ruleId: 'columns[1].allowed-values' })
    const b = row({ ruleId: 'columns[1].required' })
    expect(compareReportRules(a, b)).toBeLessThan(0)
    expect(compareReportRules(b, a)).toBeGreaterThan(0)
    const datasetMax = row({ ruleId: 'dataset.max-rows', outcome: 'dataset-fact' })
    const datasetMin = row({ ruleId: 'dataset.min-rows', outcome: 'dataset-fact' })
    expect(compareReportRules(datasetMax, datasetMin)).toBeLessThan(0)
    expect(compareReportRules(a, a)).toBe(0)
  })
})

describe('canonical text renderings', () => {
  it('sampleValueText: NULL is explicit, strings verbatim, booleans spelled, numbers shortest', () => {
    expect(sampleValueText(null)).toBe('NULL')
    expect(sampleValueText('')).toBe('')
    expect(sampleValueText('it\'s "quoted"')).toBe('it\'s "quoted"')
    expect(sampleValueText(true)).toBe('true')
    expect(sampleValueText(false)).toBe('false')
    expect(sampleValueText(0.5)).toBe('0.5')
    expect(sampleValueText(-120)).toBe('-120')
  })

  it('row keys: the anchor token is never rendered (display + export forms)', () => {
    expect(displayRowKey('base:#12')).toBe('base #12')
    expect(displayRowKey('base:anchor-v9#0')).toBe('base #0')
    expect(displayRowKey('ins:anchor#3')).toBe('insert #3')
    expect(displayRowKey('not-a-key')).toBe('unknown row')
    expect(exportRowKey('base:#12')).toBe('base:12')
    expect(exportRowKey('ins:anchor#3')).toBe('insert:3')
    expect(exportRowKey('not-a-key')).toBe('unknown')
  })

  it('ruleLabel: the documented label set, unknown degrades to Rule', () => {
    expect(ruleLabel('allowed-values')).toBe('Allowed values')
    expect(ruleLabel('max-null-share')).toBe('Maximum NULL share')
    expect(ruleLabel('mystery')).toBe('Rule')
  })
})

describe('buildValidationReport', () => {
  it('joins plan attribution onto results and severity-orders the rows', () => {
    const result: EngineValidationResult = {
      valid: false,
      rowCount: 10,
      rules: [
        // Plan order: min first (failing), max-rows second (passing).
        {
          ruleId: 'columns[0].min',
          outcome: 'row-samples',
          failCount: 2,
          failPercent: 20,
          sampleFailures: [],
        },
        {
          ruleId: 'dataset.max-rows',
          outcome: 'dataset-fact',
          failCount: 0,
          failPercent: 0,
          sampleFailures: [],
        },
      ],
    }
    const report = buildValidationReport(plan, result)
    expect(report.valid).toBe(false)
    expect(report.rowCount).toBe(10)
    expect(report.rows.map((row) => row.ruleId)).toEqual(['columns[0].min', 'dataset.max-rows'])
    expect(report.rows[0]).toMatchObject({
      column: 'amount',
      kind: 'min',
      label: 'Minimum bound',
      outcome: 'row-samples',
      failing: true,
      // The fixture result carries NO samples: the bounded-set gate reads
      // partial — exactly the honesty it exists for.
      samplesComplete: false,
    })
    expect(report.rows[1]).toMatchObject({ column: null, outcome: 'dataset-fact', failing: false })
  })

  it('marks the sample set partial when the count exceeds the returned samples', () => {
    const result: EngineValidationResult = {
      valid: false,
      rowCount: 100,
      rules: [
        {
          ruleId: 'columns[0].min',
          outcome: 'row-samples',
          failCount: 110,
          failPercent: 92,
          sampleFailures: [
            { rowKey: 'base:#0', value: -1 },
            { rowKey: 'base:#1', value: -2 },
          ],
        },
      ],
    }
    const report = buildValidationReport(plan, result)
    expect(report.rows[0]?.samplesComplete).toBe(false)
  })

  it('a FAILING dataset-fact is sample-complete with zero samples (facts never carry rows, m5-4)', () => {
    // `dataset.min-rows ≥ 1` over an empty dataset fails as an honest fact
    // violation (the m5-4 guard refinement made the shape reachable). Its
    // sample list is empty BY CONTRACT — the bounded-set gate must read
    // that as complete, never render a "… N more failures not shown" line
    // for samples that cannot exist.
    const result: EngineValidationResult = {
      valid: false,
      rowCount: 0,
      rules: [
        {
          ruleId: 'dataset.max-rows',
          outcome: 'dataset-fact',
          failCount: 1,
          failPercent: 0,
          sampleFailures: [],
        },
      ],
    }
    const report = buildValidationReport(plan, result)
    expect(report.rows[0]).toMatchObject({
      ruleId: 'dataset.max-rows',
      outcome: 'dataset-fact',
      failing: true,
      samplesComplete: true,
    })
    const rendered = renderHumanReport(report, META)
    expect(rendered).toContain('FAIL dataset.max-rows — Maximum row count — 1 of 0 rows (0%)')
    expect(rendered).not.toContain('more failures not shown')
  })

  it('degrades a result rule with no plan rule to an unknown row', () => {
    const result: EngineValidationResult = {
      valid: false,
      rowCount: 1,
      rules: [
        {
          ruleId: 'columns[9].mystery',
          outcome: 'row-samples',
          failCount: 1,
          failPercent: 100,
          sampleFailures: [],
        },
      ],
    }
    const report = buildValidationReport(plan, result)
    expect(report.rows[0]).toMatchObject({ kind: 'unknown', outcome: 'unknown', label: 'Rule' })
  })
})

describe('renderer determinism', () => {
  it('the same report renders byte-identical JSON and human output', () => {
    const report = buildValidationReport(plan, {
      valid: false,
      rowCount: 10,
      rules: [
        {
          ruleId: 'columns[0].min',
          outcome: 'row-samples',
          failCount: 2,
          failPercent: 20,
          sampleFailures: [],
        },
      ],
    })
    expect(renderJsonReport(report, META)).toBe(renderJsonReport(report, META))
    expect(renderHumanReport(report, META)).toBe(renderHumanReport(report, META))
    // Fixed key order (not sorted): report first, baseViewOnly second.
    const json = renderJsonReport(report, META)
    expect(json.indexOf('"report"')).toBeLessThan(json.indexOf('"baseViewOnly"'))
    expect(json.indexOf('"baseViewOnly"')).toBeLessThan(json.indexOf('"contract"'))
    // The producer build is stamped from the single CLI-version source.
    expect(json.indexOf('"report"')).toBeLessThan(json.indexOf('"reportVersion"'))
    expect(json.indexOf('"reportVersion"')).toBeLessThan(json.indexOf('"baseViewOnly"'))
    expect((JSON.parse(json) as { reportVersion: string }).reportVersion).toBe(readCliVersion())
    // Trailing newline, no timestamps, no paths anywhere in the payload.
    expect(json.endsWith('\n')).toBe(true)
    expect(json).not.toContain(META.datasetName)
    expect(json).toContain('"failPercent": 20')
  })

  it('the human renderer states the clamp when the sample list is partial', () => {
    const report: ValidationReportShape = {
      valid: false,
      rowCount: 120,
      rows: [
        {
          ruleId: 'columns[5].allowed-values',
          column: 'tag',
          kind: 'allowed-values',
          label: 'Allowed values',
          failCount: 110,
          failPercent: 92,
          failing: true,
          outcome: 'row-samples',
          samples: [
            { rowKey: 'base:#0', value: 'bad' },
            { rowKey: 'base:#1', value: 'bad' },
          ],
          samplesComplete: false,
        },
      ],
    }
    const clamped = renderHumanReport(report, {
      ...META,
      sampleLimitRequested: 500,
      sampleLimitEffective: 100,
    })
    expect(clamped).toContain('… 108 more failures not shown (sample limit 500 clamped to 100)')
    const unclamped = renderHumanReport(report, {
      ...META,
      sampleLimitRequested: 2,
      sampleLimitEffective: 2,
    })
    expect(unclamped).toContain('… 108 more failures not shown\n')
    expect(unclamped).not.toContain('clamped')
  })
})

/** Local alias so the fixture above reads as a full report. */
type ValidationReportShape = Parameters<typeof renderHumanReport>[0]
