// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  compileRowDiffPlan,
  describeRowDiffBindingError,
  diffDatasets,
  divergentColumnDeltas,
  diffReportIdentical,
  diffSampleDisplayKey,
  diffSampleExportKey,
  inferRowDiffKeys,
  projectAspect,
  projectColumnDelta,
  projectInference,
  projectIssue,
  projectSchemaFinding,
} from '@assay/diff'
import type {
  DatasetProfile,
  DiffReport,
  KeyInferenceResult,
  RowDiffAspect,
  SchemaDriftFinding,
} from '@assay/diff'

export const DIFF_SAMPLE_LIMIT = 100
export const DIFF_PLAN_RELATION_A = 'assay_vscode_diff_a'
export const DIFF_PLAN_RELATION_B = 'assay_vscode_diff_b'
export const DIFF_ASPECT_ORDER = [
  'schema-drift',
  'column-deltas',
  'added',
  'removed',
  'changed',
] as const

export interface DiffColumn {
  readonly name: string
  readonly type: string
  readonly nullable?: boolean
}
export interface DiffProfile extends DatasetProfile {
  readonly columns: DatasetProfile['columns']
}

/** Path-free identity passed from the host after a comparison has been staged. */
export interface StagedComparisonMetadata {
  readonly id: string
  readonly generation: number
  readonly basename: string
  readonly format: string
  readonly byteLength: number
}

/** Structural engine mirrors keep this pure controller independent of engine packages. */
export interface DiffSample {
  readonly side: 'A' | 'B'
  readonly rowKey: string
  readonly changedColumns?: readonly string[]
}
export interface DiffAspectResult {
  readonly aspect: RowDiffAspect
  readonly count: number
  readonly samples: readonly DiffSample[]
}
export interface EngineDiffResult {
  readonly rowCountA: number
  readonly rowCountB: number
  readonly aspects: readonly DiffAspectResult[]
}

export interface KeyDisclosure {
  readonly columns: readonly string[]
  readonly candidateDisclosure: string
  readonly outcomeDisclosure: string
  readonly evidence: KeyInferenceResult['candidates'][number]['evidence']
}
export interface DiffSampleView extends DiffSample {
  readonly displayKey: string
  readonly exportKey: string
}
export interface DiffAspectView {
  readonly aspect: RowDiffAspect
  readonly count: number
  readonly samplesReturned: number
  readonly samplesComplete: boolean
  readonly samples: readonly DiffSampleView[]
}
export interface DiffReportView {
  readonly drift: readonly SchemaDriftFinding[]
  readonly deltas: DiffReport['columnDeltas']
  readonly divergentDeltas: DiffReport['columnDeltas']
  readonly issues: DiffReport['issues']
  readonly keys: readonly string[]
  readonly keySource: 'explicit' | 'inferred'
  readonly inference: KeyDisclosure | null
  readonly sampleLimitRequested: number
  readonly sampleLimitEffective: number
  readonly baseViewOnly: boolean
  readonly stale: boolean
  readonly rowCountA: number
  readonly rowCountB: number
  readonly changedComparable: boolean
  readonly aspects: readonly [DiffAspectView, DiffAspectView, DiffAspectView]
  readonly identical: boolean
  readonly revision: number
}

export type KeyValidationError =
  'empty' | 'null-key' | 'empty-key' | 'duplicate-key' | 'unknown-column'
export type ConfirmKeysResult =
  | { readonly ok: true; readonly keys: readonly string[] }
  | { readonly ok: false; readonly error: KeyValidationError }
export function validateConfirmedKeys(
  keys: readonly (string | null)[],
  columns: readonly DiffColumn[],
): ConfirmKeysResult {
  if (!Array.isArray(keys) || keys.length === 0) return { ok: false, error: 'empty' }
  const names = new Set(columns.map((column) => column.name))
  const seen = new Set<string>()
  const result: string[] = []
  for (const key of keys) {
    if (key === null || typeof key !== 'string') return { ok: false, error: 'null-key' }
    if (key.length === 0 || key.trim().length === 0) return { ok: false, error: 'empty-key' }
    const folded = key.toLowerCase()
    if (seen.has(folded)) return { ok: false, error: 'duplicate-key' }
    if (!names.has(key)) return { ok: false, error: 'unknown-column' }
    seen.add(folded)
    result.push(key)
  }
  return { ok: true, keys: result }
}

export function makeKeyDisclosure(
  candidate: KeyInferenceResult['candidates'][number],
  outcomeDisclosure: string,
): KeyDisclosure {
  return {
    columns: [...candidate.columns],
    candidateDisclosure: candidate.disclosure,
    outcomeDisclosure,
    evidence: candidate.evidence,
  }
}

export type DiffControllerState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'staging'; readonly id: string; readonly generation: number }
  | {
      readonly kind: 'staged'
      readonly metadata: StagedComparisonMetadata
      readonly schema: readonly DiffColumn[]
      readonly rowCount: number
      readonly comparison: DiffReport
      readonly inference: KeyInferenceResult
    }
  | { readonly kind: 'running'; readonly id: string; readonly generation: number }
  | { readonly kind: 'result'; readonly report: DiffReportView }
  | { readonly kind: 'refused'; readonly reason: 'busy' | 'unconfirmed' | 'invalid-keys' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string }

export function isCurrentDiffRequest(
  expected: { readonly id: string; readonly generation: number },
  actual: { readonly id: string; readonly generation: number },
): boolean {
  return expected.id === actual.id && expected.generation === actual.generation
}
/** Cancellation invalidates every pending frame by advancing the generation. */
export function cancelDiffGeneration(generation: number): number {
  return Number.isSafeInteger(generation) && generation >= 0 ? generation + 1 : 1
}
export type DiffRunDecision =
  | { readonly kind: 'run' }
  | { readonly kind: 'refused'; readonly reason: 'busy' | 'unconfirmed' | 'invalid-keys' }
export function decideDiffRun(
  state: DiffControllerState,
  confirmed: boolean,
  keys: readonly (string | null)[],
  columns: readonly DiffColumn[],
): DiffRunDecision {
  if (state.kind === 'running' || state.kind === 'staging')
    return { kind: 'refused', reason: 'busy' }
  if (!confirmed) return { kind: 'refused', reason: 'unconfirmed' }
  if (state.kind !== 'staged' || !validateConfirmedKeys(keys, columns).ok)
    return { kind: 'refused', reason: 'invalid-keys' }
  return { kind: 'run' }
}
/** B-side samples are intentionally display-only; only A logical ids navigate. */
export function selectDiffSampleNavigation(
  sample: DiffSampleView,
): { readonly kind: 'navigate'; readonly rowKey: string } | { readonly kind: 'display-only' } {
  return sample.side === 'A'
    ? { kind: 'navigate', rowKey: sample.rowKey }
    : { kind: 'display-only' }
}
export function isDiffStale(report: DiffReportView | null, revision: number): boolean {
  return report !== null && report.revision !== revision
}
export function canRunDiff(state: DiffControllerState, confirmed: boolean): boolean {
  return state.kind === 'staged' && confirmed
}

export function buildDiffReport(input: {
  readonly comparison: DiffReport
  readonly result: EngineDiffResult
  readonly keys: readonly string[]
  readonly keySource: 'explicit' | 'inferred'
  readonly inference: KeyDisclosure | null
  readonly sharedColumns: readonly string[]
  readonly baseViewOnly: boolean
  readonly stale?: boolean
  readonly revision: number
  readonly sampleLimitRequested?: number
  readonly sampleLimitEffective?: number
}): DiffReportView {
  const aspectView = (name: RowDiffAspect): DiffAspectView => {
    const entry = input.result.aspects.find((aspect) => aspect.aspect === name)
    const samples = (entry?.samples ?? []).slice(0, DIFF_SAMPLE_LIMIT).map((sample) => ({
      ...sample,
      displayKey: diffSampleDisplayKey(sample.rowKey),
      exportKey: diffSampleExportKey(sample.rowKey),
    }))
    const count = entry?.count ?? 0
    return {
      aspect: name,
      count,
      samplesReturned: samples.length,
      samplesComplete: count <= samples.length,
      samples,
    }
  }
  const aspects: [DiffAspectView, DiffAspectView, DiffAspectView] = [
    aspectView('added'),
    aspectView('removed'),
    aspectView('changed'),
  ]
  return {
    drift: input.comparison.schemaDrift,
    deltas: input.comparison.columnDeltas,
    divergentDeltas: divergentColumnDeltas(input.comparison.columnDeltas),
    issues: input.comparison.issues,
    keys: [...input.keys],
    keySource: input.keySource,
    inference: input.inference,
    sampleLimitRequested: input.sampleLimitRequested ?? DIFF_SAMPLE_LIMIT,
    sampleLimitEffective: input.sampleLimitEffective ?? DIFF_SAMPLE_LIMIT,
    baseViewOnly: input.baseViewOnly,
    stale: input.stale ?? false,
    rowCountA: input.result.rowCountA,
    rowCountB: input.result.rowCountB,
    changedComparable: input.sharedColumns.length > 0,
    aspects,
    identical: diffReportIdentical({
      schemaDrift: input.comparison.schemaDrift,
      columnDeltas: input.comparison.columnDeltas,
      addedCount: aspects[0].count,
      removedCount: aspects[1].count,
      changedCount: aspects[2].count,
    }),
    revision: input.revision,
  }
}

/** Canonical report body; projection helpers preserve shared CLI/web field ordering. */
export function projectDiffReport(report: DiffReportView): Record<string, unknown> {
  return {
    report: 'assay-diff-report',
    baseViewOnly: report.baseViewOnly,
    keys: [...report.keys],
    keySource: report.keySource,
    inference: projectInference(report.inference),
    sampleLimitRequested: report.sampleLimitRequested,
    sampleLimitEffective: report.sampleLimitEffective,
    schemaDrift: report.drift.map(projectSchemaFinding),
    columnDeltas: report.deltas.map(projectColumnDelta),
    issues: report.issues.map(projectIssue),
    rowDiff: {
      rowCountA: report.rowCountA,
      rowCountB: report.rowCountB,
      changedComparable: report.changedComparable,
      added: projectAspect(projectAspectInput(report.aspects[0])),
      removed: projectAspect(projectAspectInput(report.aspects[1])),
      changed: projectAspect(projectAspectInput(report.aspects[2])),
    },
    identical: report.identical,
    stale: report.stale,
  }
}
function projectAspectInput(aspect: DiffAspectView) {
  return {
    count: aspect.count,
    samplesReturned: aspect.samplesReturned,
    samplesComplete: aspect.samplesComplete,
    samples: aspect.samples.map((sample) => ({
      side: sample.side,
      exportKey: sample.exportKey,
      changedColumns: sample.changedColumns,
    })),
  }
}

export function compileConfirmedDiff(
  keys: readonly string[],
  columnsA: readonly DiffColumn[],
  columnsB: readonly DiffColumn[],
) {
  return compileRowDiffPlan(columnsA, columnsB, keys, {
    relationA: DIFF_PLAN_RELATION_A,
    relationB: DIFF_PLAN_RELATION_B,
    sampleLimit: DIFF_SAMPLE_LIMIT,
  })
}
export function describeDiffCompileFailure(
  errors: Parameters<typeof describeRowDiffBindingError>[0],
): string {
  return describeRowDiffBindingError(errors)
}
export { diffDatasets, inferRowDiffKeys }
