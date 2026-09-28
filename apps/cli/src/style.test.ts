// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for the q-4 color policy + human-report styling. Color is
 * opt-in (`FORCE_COLOR` > `NO_COLOR` > TTY), the identity style is exactly
 * the pre-q-4 bytes, and the machine (`--format json`) renderers never take a
 * style, so they cannot be colored.
 */
import { describe, expect, it } from 'vitest'
import type { EngineRowDiffResult } from '@assay/engine-duckdb/node'
import { buildDiffRowDiffReport, renderHumanDiffReport, renderHumanReport } from './report.js'
import type { DiffCommandReport, DiffReportMeta, ReportMeta, ValidationReport } from './report.js'
import { createReportStyle, plainStyle, shouldUseColor } from './style.js'

const ESC = '\u001b'

const VALIDATION_META: ReportMeta = {
  contractName: 'c',
  contractVersion: 1,
  datasetName: 'd.csv',
  format: 'csv',
  sampleLimitRequested: 20,
  sampleLimitEffective: 20,
}

const VALIDATION_REPORT: ValidationReport = {
  valid: false,
  rowCount: 2,
  rows: [
    {
      ruleId: 'columns[0].required',
      column: 'id',
      kind: 'required',
      label: 'Required (no NULLs)',
      failCount: 1,
      failPercent: 50,
      failing: true,
      outcome: 'row-samples',
      samples: [],
      samplesComplete: true,
    },
    {
      ruleId: 'dataset.max-rows',
      column: null,
      kind: 'max-rows',
      label: 'Maximum row count',
      failCount: 0,
      failPercent: 0,
      failing: false,
      outcome: 'dataset-fact',
      samples: [],
      samplesComplete: true,
    },
  ],
}

const DIFF_META: DiffReportMeta = {
  nameA: 'a.csv',
  nameB: 'b.csv',
  formatA: 'csv',
  formatB: 'csv',
  keys: ['id'],
  keySource: 'explicit',
  inference: null,
  sampleLimitRequested: 20,
  sampleLimitEffective: 20,
}

const ZERO_ROW_DIFF: EngineRowDiffResult = {
  rowCountA: 1,
  rowCountB: 1,
  aspects: [
    { aspect: 'added', count: 0, samples: [] },
    { aspect: 'removed', count: 0, samples: [] },
    { aspect: 'changed', count: 0, samples: [] },
  ],
}

const ISSUE_REPORT: DiffCommandReport = {
  diff: {
    schemaDrift: [],
    columnDeltas: [],
    issues: [
      { code: 'invalid-profile-input', message: 'profile side A is not usable', side: 'A' },
      { code: 'duplicate-column-name', message: "column 'x' appears twice", column: 'x' },
    ],
  },
  rowDiff: buildDiffRowDiffReport(ZERO_ROW_DIFF, true),
}

describe('shouldUseColor — pipe contract, then FORCE_COLOR/NO_COLOR on a TTY', () => {
  it('falls back to the stream TTY when neither env var is set', () => {
    expect(shouldUseColor({ isTTY: true, env: {} })).toBe(true)
    expect(shouldUseColor({ isTTY: false, env: {} })).toBe(false)
  })

  it('never colors a non-TTY, even with FORCE_COLOR (piped output wins)', () => {
    expect(shouldUseColor({ isTTY: false, env: { FORCE_COLOR: '1' } })).toBe(false)
    expect(shouldUseColor({ isTTY: false, env: { FORCE_COLOR: '3' } })).toBe(false)
    expect(shouldUseColor({ isTTY: false, env: { FORCE_COLOR: '' } })).toBe(false)
  })

  it('NO_COLOR disables on a TTY for ANY value, including the empty string', () => {
    expect(shouldUseColor({ isTTY: true, env: { NO_COLOR: '1' } })).toBe(false)
    expect(shouldUseColor({ isTTY: true, env: { NO_COLOR: 'anything' } })).toBe(false)
    expect(shouldUseColor({ isTTY: true, env: { NO_COLOR: '' } })).toBe(false)
  })

  it('FORCE_COLOR=0/false/empty disables a TTY; any other FORCE_COLOR beats NO_COLOR', () => {
    expect(shouldUseColor({ isTTY: true, env: { FORCE_COLOR: '0' } })).toBe(false)
    expect(shouldUseColor({ isTTY: true, env: { FORCE_COLOR: 'false' } })).toBe(false)
    // An empty FORCE_COLOR is an explicit off, not "unset".
    expect(shouldUseColor({ isTTY: true, env: { FORCE_COLOR: '' } })).toBe(false)
    expect(shouldUseColor({ isTTY: true, env: { FORCE_COLOR: '', NO_COLOR: '1' } })).toBe(false)
    // Any other explicit value wins over NO_COLOR (force-color precedence).
    expect(shouldUseColor({ isTTY: true, env: { FORCE_COLOR: '1', NO_COLOR: '1' } })).toBe(true)
    expect(shouldUseColor({ isTTY: true, env: { FORCE_COLOR: '3' } })).toBe(true)
  })
})

describe('createReportStyle — identity when off, reset-terminated when on', () => {
  it('returns the shared identity style when disabled', () => {
    expect(createReportStyle(false)).toBe(plainStyle)
    expect(plainStyle.enabled).toBe(false)
    expect(plainStyle.fail('X')).toBe('X')
  })

  it('wraps each role in its own SGR code and an explicit reset', () => {
    const style = createReportStyle(true)
    expect(style.enabled).toBe(true)
    expect(style.fail('FAIL')).toBe(`${ESC}[31mFAIL${ESC}[0m`)
    expect(style.pass('PASS')).toBe(`${ESC}[32mPASS${ESC}[0m`)
    expect(style.warn('issue')).toBe(`${ESC}[33missue${ESC}[0m`)
    expect(style.count('3')).toBe(`${ESC}[36m3${ESC}[0m`)
  })
})

describe('human renderers — styling is additive; the default is byte-identical', () => {
  it('renderHumanDiffReport lists collected issues with the canonical renderer (q-4)', () => {
    const human = renderHumanDiffReport(ISSUE_REPORT, DIFF_META)
    expect(human).toContain(
      'issues: 2 issues\n' +
        '  invalid-profile-input [side A]: profile side A is not usable\n' +
        "  duplicate-column-name (column 'x'): column 'x' appears twice\n",
    )
    // The issue line is styled yellow when color is on.
    const colored = renderHumanDiffReport(ISSUE_REPORT, DIFF_META, createReportStyle(true))
    expect(colored).toContain(
      `${ESC}[33minvalid-profile-input [side A]: profile side A is not usable${ESC}[0m`,
    )
  })

  it('validate: colors FAIL/PASS and the failing count, default has no escapes', () => {
    expect(renderHumanReport(VALIDATION_REPORT, VALIDATION_META)).not.toContain(ESC)
    expect(renderHumanReport(VALIDATION_REPORT, VALIDATION_META)).toBe(
      renderHumanReport(VALIDATION_REPORT, VALIDATION_META, plainStyle),
    )
    const colored = renderHumanReport(VALIDATION_REPORT, VALIDATION_META, createReportStyle(true))
    expect(colored).toContain(`${ESC}[31mFAIL${ESC}[0m columns[0].required`)
    expect(colored).toContain(`${ESC}[36m1 of 2 rows (50%)${ESC}[0m`)
    expect(colored).toContain(`${ESC}[32mPASS${ESC}[0m dataset.max-rows`)
    expect(colored).toContain(`${ESC}[31mINVALID${ESC}[0m`)
  })

  it('diff: colors the verdict and section counts, default has no escapes', () => {
    expect(renderHumanDiffReport(ISSUE_REPORT, DIFF_META)).not.toContain(ESC)
    const colored = renderHumanDiffReport(ISSUE_REPORT, DIFF_META, createReportStyle(true))
    expect(colored).toContain(`${ESC}[32mIDENTICAL${ESC}[0m`)
    expect(colored).toContain(`${ESC}[36m0 added, 0 removed, 0 changed${ESC}[0m`)
  })
})
