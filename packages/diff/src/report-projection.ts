// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Canonical pure projections for diff reports shared by CLI and web. Object
 * construction order is intentional: JSON serialization is byte-stable and
 * is part of each surface's public report contract.
 */
import { displayRowKey, exportRowKey } from '@assay/domain'
import type { ColumnDistributionDelta } from './deltas.js'
import type { DiffIssue, DiffSide } from './issues.js'
import type { KeyCandidateEvidence } from './key-inference.js'
import { roundForReport } from './rounding.js'
import type { SchemaDriftFinding } from './schema-drift.js'

/** Round a report metric and normalize absent values to JSON null. */
export function roundReportMetric(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  return roundForReport(value)
}

/** Project one schema finding with fixed key order and rounded null shares. */
export function projectSchemaFinding(finding: SchemaDriftFinding): Record<string, unknown> {
  return {
    kind: finding.kind,
    column: finding.column,
    typeA: finding.typeA ?? null,
    typeB: finding.typeB ?? null,
    familyA: finding.familyA ?? null,
    familyB: finding.familyB ?? null,
    nullShareA: roundReportMetric(finding.nullShareA),
    nullShareB: roundReportMetric(finding.nullShareB),
  }
}

/** Project one distribution delta with fixed key order and rounded metrics. */
export function projectColumnDelta(delta: ColumnDistributionDelta): Record<string, unknown> {
  return {
    column: delta.column,
    typeA: delta.typeA,
    typeB: delta.typeB,
    kindA: delta.kindA,
    kindB: delta.kindB,
    numeric:
      delta.numeric === undefined
        ? null
        : {
            meanShiftStandardized: roundReportMetric(delta.numeric.meanShiftStandardized),
            varianceShiftStandardized: roundReportMetric(delta.numeric.varianceShiftStandardized),
            p50Shift: roundReportMetric(delta.numeric.p50Shift),
            p90Shift: roundReportMetric(delta.numeric.p90Shift),
          },
    categorical:
      delta.categorical === undefined
        ? null
        : {
            totalVariation: roundReportMetric(delta.categorical.totalVariation),
            newCategories: delta.categorical.newCategories.map((entry) => ({
              value: entry.value,
              count: entry.count,
            })),
            vanishedCategories: delta.categorical.vanishedCategories.map((entry) => ({
              value: entry.value,
              count: entry.count,
            })),
          },
  }
}

/** Project one collected input issue with fixed key order. */
export function projectIssue(issue: DiffIssue): Record<string, unknown> {
  return {
    code: issue.code,
    message: issue.message,
    side: issue.side ?? null,
    column: issue.column ?? null,
  }
}

/** Input shape for a projected row-diff sample. */
export interface ProjectSampleInput {
  readonly side: DiffSide
  readonly exportKey: string
  readonly changedColumns?: readonly string[] | null
}

/** Project one sample, collapsing absent and null changed-column lists. */
export function projectSample(sample: ProjectSampleInput): Record<string, unknown> {
  return sample.changedColumns === undefined || sample.changedColumns === null
    ? { side: sample.side, rowKey: sample.exportKey }
    : { side: sample.side, rowKey: sample.exportKey, changedColumns: [...sample.changedColumns] }
}

/** Input shape for a count and bounded samples in one row-diff aspect. */
export interface ProjectAspectInput {
  readonly count: number
  readonly samplesReturned: number
  readonly samplesComplete: boolean
  readonly samples: readonly ProjectSampleInput[]
}

/** Project one row-diff aspect, preserving the report's fixed key order. */
export function projectAspect(aspect: ProjectAspectInput): Record<string, unknown> {
  return {
    count: aspect.count,
    samplesReturned: aspect.samplesReturned,
    samplesComplete: aspect.samplesComplete,
    samples: aspect.samples.map(projectSample),
  }
}

/** The disclosed inference fields and machine-readable key evidence. */
export interface DiffInferenceInput {
  readonly columns: readonly string[]
  readonly candidateDisclosure: string
  readonly outcomeDisclosure: string
  readonly evidence: KeyCandidateEvidence
}

/** Project inference disclosure and evidence, or null for explicitly chosen keys. */
export function projectInference(
  inference: DiffInferenceInput | null,
): Record<string, unknown> | null {
  if (inference === null) return null
  const evidence = inference.evidence
  return {
    columns: [...inference.columns],
    candidateDisclosure: inference.candidateDisclosure,
    outcomeDisclosure: inference.outcomeDisclosure,
    evidence: {
      column: evidence.column,
      typeA: evidence.typeA,
      typeB: evidence.typeB,
      rowCountA: evidence.rowCountA,
      rowCountB: evidence.rowCountB,
      nullCountA: evidence.nullCountA,
      nullCountB: evidence.nullCountB,
      distinctCountA: evidence.distinctCountA,
      distinctCountB: evidence.distinctCountB,
    },
  }
}

/** Whether a column's distribution delta reports any defined non-zero signal. */
export function columnDeltaDiffers(delta: ColumnDistributionDelta): boolean {
  if (delta.numeric !== undefined) {
    for (const metric of [
      delta.numeric.meanShiftStandardized,
      delta.numeric.varianceShiftStandardized,
      delta.numeric.p50Shift,
      delta.numeric.p90Shift,
    ]) {
      if (metric !== null && Number.isFinite(metric) && metric !== 0) return true
    }
  }
  if (delta.categorical !== undefined) {
    const tv = delta.categorical.totalVariation
    if (tv !== null && Number.isFinite(tv) && tv !== 0) return true
    if (delta.categorical.newCategories.length > 0) return true
    if (delta.categorical.vanishedCategories.length > 0) return true
  }
  return false
}

/** The deltas whose distribution reports carry defined non-zero signals. */
export function divergentColumnDeltas(
  deltas: readonly ColumnDistributionDelta[],
): readonly ColumnDistributionDelta[] {
  return deltas.filter(columnDeltaDiffers)
}

/** Input aspects for the shared whole-report identity verdict. */
export interface DiffReportIdentityInput {
  readonly schemaDrift: readonly SchemaDriftFinding[]
  readonly columnDeltas: readonly ColumnDistributionDelta[]
  readonly addedCount: number
  readonly removedCount: number
  readonly changedCount: number
}

/** Whether all schema, profile, and row-diff aspects that ran are identical. */
export function diffReportIdentical(input: DiffReportIdentityInput): boolean {
  return (
    input.schemaDrift.length === 0 &&
    divergentColumnDeltas(input.columnDeltas).length === 0 &&
    input.addedCount === 0 &&
    input.removedCount === 0 &&
    input.changedCount === 0
  )
}

/** Stable marker identifying a serialized diff report. */
export const DIFF_REPORT_MARKER = 'assay-diff-report'

/** Anchor-free export key for a diff sample; B-side ordinal keys pass through. */
export function diffSampleExportKey(rowKey: string): string {
  if (rowKey.startsWith('b:')) return rowKey
  return exportRowKey(rowKey)
}

/** Anchor-free display key for a diff sample; B-side ordinal keys are rendered directly. */
export function diffSampleDisplayKey(rowKey: string): string {
  if (rowKey.startsWith('b:')) return `b #${rowKey.slice(2)}`
  return displayRowKey(rowKey)
}
