// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import type { ValidationProjection } from './validation-controller'
import {
  CANCELLED_STATUS,
  COMPILING_STATUS,
  COMPLETE_STATUS,
  FAILED_STATUS,
  NAVIGATION_FAILED_STATUS,
  ROW_NOT_IN_VIEW_STATUS,
  SELECT_CONTRACT_STATUS,
  describeCompileRefusal,
  describeContractFrame,
  describeValidationRule,
  describeValidationSample,
  describeValidationSummary,
  retainPreviousReport,
  validationStaleVisible,
  type ValidationRunOutcome,
} from './validation-presenter'

const report: ValidationProjection = {
  revision: 3,
  valid: false,
  rowCount: 12,
  rules: [
    {
      ruleId: 'value_required',
      failCount: 1,
      failPercent: 8.33,
      samples: [{ rowKey: 'b:6', value: null }],
    },
  ],
}

describe('validation presenter', () => {
  it('names every contract-compilation refusal', () => {
    expect(describeCompileRefusal('empty')).toBe('Contract is empty.')
    expect(describeCompileRefusal('parse-error')).toBe('Contract could not be parsed.')
    expect(describeCompileRefusal('compile-error')).toBe(
      'Contract does not bind to the effective schema.',
    )
    expect(describeCompileRefusal('too-large')).toBe('Contract exceeds the size limit.')
  })

  it('resets the report only for a newly loaded contract', () => {
    expect(describeContractFrame('loaded').resetReport).toBe(true)
    expect(describeContractFrame('loaded').status).toBe(
      'Contract selected. Validate the effective view when ready.',
    )
    expect(describeContractFrame('cancelled').resetReport).toBe(false)
    expect(describeContractFrame('cancelled').status).toBe('Contract selection cancelled.')
    expect(describeContractFrame('error').resetReport).toBe(false)
    expect(describeContractFrame('error').status).toBe(
      'Contract could not be read (empty, too large, or unavailable).',
    )
  })

  it('publishes only a current-generation outcome and RETAINS the previous report otherwise', () => {
    const published: ValidationRunOutcome = { kind: 'published', report }
    expect(retainPreviousReport(null, published)).toEqual({ report, status: COMPLETE_STATUS })

    // A failure keeps the PREVIOUS projection (never nulls it) and says so.
    const retained = retainPreviousReport(report, { kind: 'retained' })
    expect(retained.report).toBe(report)
    expect(retained.status).toBe(FAILED_STATUS)
    expect(retained.status).toContain('previous report')

    // A failure with no previous report stays empty (nothing to retain).
    expect(retainPreviousReport(null, { kind: 'retained' })).toEqual({
      report: null,
      status: FAILED_STATUS,
    })
  })

  it('computes staleness against the CURRENT revision', () => {
    expect(validationStaleVisible(report, 3)).toBe(false)
    expect(validationStaleVisible(report, 4)).toBe(true)
    expect(validationStaleVisible(null, 4)).toBe(false)
  })

  it('renders the summary, rule and sample lines verbatim', () => {
    expect(describeValidationSummary(report)).toBe('INVALID — 12 effective rows.')
    expect(describeValidationSummary({ ...report, valid: true })).toBe('VALID — 12 effective rows.')
    expect(describeValidationRule(report.rules[0]!)).toBe('value_required: 1 failures (8.33%).')
    expect(describeValidationSample(report.rules[0]!.samples[0]!)).toBe('Go to row b:6 — null')
  })

  it('keeps the fixed status lines stable (they are user-visible contract text)', () => {
    expect(COMPILING_STATUS).toBe('Compiling contract and validating the effective view…')
    expect(COMPLETE_STATUS).toBe('Validation complete.')
    expect(CANCELLED_STATUS).toBe('Validation cancelled; any late result will be ignored.')
    expect(SELECT_CONTRACT_STATUS).toBe('Select a local contract file…')
    expect(ROW_NOT_IN_VIEW_STATUS).toContain('Clear filters or re-validate')
    expect(NAVIGATION_FAILED_STATUS).toBe('Could not navigate to that logical row.')
  })
})
