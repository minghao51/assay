// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Validation panel presentation (D03b): the value-free status/state decisions
 * the desktop validation surface makes, extracted from the webview entry as a
 * DOM-free module with explicit inputs and outputs.
 *
 * Everything here is a pure projection: the webview's `ValidationPanel`
 * renders these strings and flags and nothing else. Keeping the decisions
 * here means the refusal/retention rules (previous report survives a failed
 * or superseded run) are unit-testable in Node, away from the browser.
 */
import type { ValidationProjection } from './validation-controller'
import { isValidationStale } from './validation-controller'

/**
 * The outcome the panel observes from one validation run: a published
 * projection (current generation) or nothing (failure or a superseded
 * generation — both retain the previous report).
 */
export type ValidationRunOutcome =
  | { readonly kind: 'published'; readonly report: ValidationProjection }
  | { readonly kind: 'retained' }

/** Status line for a contract-compilation refusal (never a run). */
export function describeCompileRefusal(
  kind: 'empty' | 'parse-error' | 'compile-error' | 'too-large',
): string {
  switch (kind) {
    case 'empty':
      return 'Contract is empty.'
    case 'parse-error':
      return 'Contract could not be parsed.'
    case 'compile-error':
      return 'Contract does not bind to the effective schema.'
    case 'too-large':
      return 'Contract exceeds the size limit.'
  }
}

/**
 * Status line for a correlated contract host frame. `loaded` also resets the
 * published report (a new contract's previous verdict is not this contract's
 * verdict); the cancelled/error lines leave the report untouched.
 */
export function describeContractFrame(kind: 'loaded' | 'cancelled' | 'error'): {
  readonly status: string
  readonly resetReport: boolean
} {
  switch (kind) {
    case 'loaded':
      return {
        status: 'Contract selected. Validate the effective view when ready.',
        resetReport: true,
      }
    case 'cancelled':
      return { status: 'Contract selection cancelled.', resetReport: false }
    case 'error':
      return {
        status: 'Contract could not be read (empty, too large, or unavailable).',
        resetReport: false,
      }
  }
}

/** The status line for a started run (before the engine answers). */
export const COMPILING_STATUS = 'Compiling contract and validating the effective view…'
export const COMPLETE_STATUS = 'Validation complete.'
/** A failed run keeps the previous report: the status says so explicitly. */
export const FAILED_STATUS = 'Validation failed. The previous report, if any, is unchanged.'
export const CANCELLED_STATUS = 'Validation cancelled; any late result will be ignored.'
export const SELECT_CONTRACT_STATUS = 'Select a local contract file…'
export const ROW_NOT_IN_VIEW_STATUS =
  'That logical row is not in the current grid view. Clear filters or re-validate.'
export const NAVIGATION_FAILED_STATUS = 'Could not navigate to that logical row.'

/**
 * Report retention on a run that did not publish: a failure or a superseded
 * generation returns the PREVIOUS projection unchanged. This is the single
 * statement of the retention rule; the panel publishes its result here.
 */
export function retainPreviousReport(
  previous: ValidationProjection | null,
  outcome: ValidationRunOutcome,
): { readonly report: ValidationProjection | null; readonly status: string } {
  return outcome.kind === 'published'
    ? { report: outcome.report, status: COMPLETE_STATUS }
    : { report: previous, status: FAILED_STATUS }
}

/** Whether the stale indicator is shown for the current revision. */
export function validationStaleVisible(
  report: ValidationProjection | null,
  revision: number,
): boolean {
  return isValidationStale(report, revision)
}

/** Summary line for a published validation report. */
export function describeValidationSummary(report: ValidationProjection): string {
  return `${report.valid ? 'VALID' : 'INVALID'} — ${report.rowCount} effective rows.`
}

/** Heading line for one rule of a published validation report. */
export function describeValidationRule(rule: ValidationProjection['rules'][number]): string {
  return `${rule.ruleId}: ${rule.failCount} failures (${rule.failPercent}%).`
}

/** Sample navigation button label (logical row key + the offending value). */
export function describeValidationSample(
  sample: ValidationProjection['rules'][number]['samples'][number],
): string {
  return `Go to row ${sample.rowKey} — ${String(sample.value)}`
}
