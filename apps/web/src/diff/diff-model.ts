// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Diff panel model (m6-4) — the pure half of the web dataset-comparison
 * panel: the staging/run key-selection state shapes, the assembled report
 * the panel and the exported report share, the documented display orderings,
 * and the canonical human renderings.
 *
 * Everything here is total and side-effect-free (Node-testable); the React
 * panel and the App wiring only consume it. Column names and sample row keys
 * are report content — dataset VALUES never enter this module except as
 * already-rendered categorical labels, and nothing here produces HTML (ADR
 * 0025). The one rounding convention is `@assay/diff`'s `roundForReport`,
 * applied once per rendered metric so the panel and the exported file can
 * never disagree with each other (m6-0's byte-agreement contract).
 *
 * ## Aspect order (the docs-07 honesty rule, made structural)
 *
 * The panel presents, in order: **schema drift → per-column distribution
 * deltas → key-based row diff**. The key-selection control and the row-diff
 * result render after the first two sections, so schema drift is always
 * visible before a row diff can be run (the m5-3 severity-ordering
 * discipline, applied to diff aspects).
 *
 * ## Zero-state wording (honest about what actually ran)
 *
 * `diffDatasets` compares schema and profile aggregates only; a row-only
 * difference is invisible to it (`hasSchemaOrProfileDifferences` means
 * exactly that). The panel therefore never claims dataset identity from the
 * schema/profile sections alone: before a row diff has run it says "no
 * schema or profile differences — row-level comparison has not run", and
 * only after a row diff returns 0/0/0 does it say "no differences" across
 * all three aspects. The exported `identical` flag follows the CLI exactly:
 * schema drift empty AND every column delta flat AND all three row-diff
 * counts zero.
 *
 * ## Row keys
 *
 * A-side diff samples carry the m4-3 logical row key grammar
 * (`base:<anchor>#<ordinal>` / `ins:<anchor>#<seq>`); the anchor token is
 * host-derived and never rendered or exported. B-side samples carry the
 * report-only `b:<ordinal>` form (checkpoint C3) — deliberately NOT a
 * logical row id, and the panel offers no jump affordance for them.
 */
import type {
  ColumnDistributionDelta,
  DatasetProfile,
  DiffIssue,
  DiffReport,
  KeyCandidateEvidence,
  RowDiffAspect,
  SchemaDriftFinding,
} from '@assay/diff'
import { roundForReport } from '@assay/diff'
import type {
  EngineDatasetProfile,
  EngineRowDiffResult,
  EngineRowDiffSample,
} from '@assay/engine-duckdb'
import { ROW_DIFF_SAMPLE_HARD_MAX } from '@assay/engine-duckdb'
import { displayRowKey, exportRowKey } from '../validation/report-model'

/** The sample bound the panel compiles plans with (the engine hard max). */
export const DIFF_SAMPLE_LIMIT = ROW_DIFF_SAMPLE_HARD_MAX

/**
 * Adapt the engine client's profile payload to the pure diff model's
 * structural mirror. The two shapes are identical; only the engine's
 * `readonly` column array differs from the model's mutable one, so this
 * copies the column list rather than casting (no `any`).
 */
export function toDiffProfile(profile: EngineDatasetProfile): DatasetProfile {
  return { rowCount: profile.rowCount, columns: profile.columns.map((column) => ({ ...column })) }
}

/** A-side plan relation binding (side A = the composed effective view). */
export const DIFF_PLAN_RELATION_A = 'assay_web_diff_a'
/** B-side plan relation binding (side B = the staged comparison). */
export const DIFF_PLAN_RELATION_B = 'assay_web_diff_b'

/** One row-diff sample as the panel renders it (anchor-free keys). */
export interface DiffSampleView {
  readonly side: 'A' | 'B'
  /** The engine's logical row key (never rendered raw — the anchor stays out). */
  readonly rowKey: string
  /** Anchor-free human form: `base #12` / `insert #3` / `b #3` / `unknown row`. */
  readonly displayKey: string
  /** Anchor-free export form: `base:12` / `insert:3` / `b:3` / `unknown`. */
  readonly exportKey: string
  /** Changed shared-column names for the `changed` aspect; `null` otherwise. */
  readonly changedColumns: readonly string[] | null
}

/** One row-diff aspect: the exact count plus its bounded sample set. */
export interface DiffAspectView {
  readonly aspect: RowDiffAspect
  readonly count: number
  readonly samplesReturned: number
  /** True when every differing row is in `samples` (count ≤ returned). */
  readonly samplesComplete: boolean
  readonly samples: readonly DiffSampleView[]
}

/** The C2 inference disclosure the panel runs an inferred key with. */
export interface DiffKeyDisclosure {
  readonly columns: readonly string[]
  readonly candidateDisclosure: string
  readonly outcomeDisclosure: string
  readonly evidence: KeyCandidateEvidence
}

/** The assembled diff report: the model aspects + the executed row diff. */
export interface DiffPanelReport {
  readonly drift: readonly SchemaDriftFinding[]
  readonly deltas: readonly ColumnDistributionDelta[]
  readonly issues: readonly DiffIssue[]
  readonly keys: readonly string[]
  readonly keySource: 'explicit' | 'inferred'
  readonly inference: DiffKeyDisclosure | null
  readonly sampleLimitRequested: number
  readonly sampleLimitEffective: number
  /** True when side A was the plain base view (no overlay ops). */
  readonly baseViewOnly: boolean
  readonly rowCountA: number
  readonly rowCountB: number
  readonly changedComparable: boolean
  readonly added: DiffAspectView
  readonly removed: DiffAspectView
  readonly changed: DiffAspectView
  readonly identical: boolean
  /** Overlay revision the row diff ran against (freshness signal). */
  readonly revision: number
}

/** Anchor-free display key for a diff sample (`base #12` / `b #3`). */
export function displayDiffRowKey(rowKey: string): string {
  if (rowKey.startsWith('b:')) return `b #${rowKey.slice(2)}`
  return displayRowKey(rowKey)
}

/** Anchor-free export key for a diff sample (`base:12` / `b:3`). */
export function exportDiffRowKey(rowKey: string): string {
  if (rowKey.startsWith('b:')) return rowKey
  return exportRowKey(rowKey)
}

/** Project one engine sample into its render/export view. */
export function diffSampleView(sample: EngineRowDiffSample): DiffSampleView {
  return {
    side: sample.side,
    rowKey: sample.rowKey,
    displayKey: displayDiffRowKey(sample.rowKey),
    exportKey: exportDiffRowKey(sample.rowKey),
    changedColumns: sample.changedColumns === undefined ? null : [...sample.changedColumns],
  }
}

/** One aspect (count + bounded samples), preserving the compiler's aspect order. */
function aspectView(result: EngineRowDiffResult, aspect: RowDiffAspect): DiffAspectView {
  const entry = result.aspects.find((candidate) => candidate.aspect === aspect)
  const samples = (entry?.samples ?? []).map(diffSampleView)
  const count = entry?.count ?? 0
  return {
    aspect,
    count,
    samplesReturned: samples.length,
    samplesComplete: count <= samples.length,
    samples,
  }
}

/** Assemble the three row-diff aspects from the engine's result. */
export function buildDiffAspectViews(result: EngineRowDiffResult): {
  readonly added: DiffAspectView
  readonly removed: DiffAspectView
  readonly changed: DiffAspectView
} {
  return {
    added: aspectView(result, 'added'),
    removed: aspectView(result, 'removed'),
    changed: aspectView(result, 'changed'),
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

/** The CLI's exact `identical` predicate, over the assembled aspects. */
export function diffReportIdentical(input: {
  readonly drift: readonly SchemaDriftFinding[]
  readonly deltas: readonly ColumnDistributionDelta[]
  readonly added: DiffAspectView
  readonly removed: DiffAspectView
  readonly changed: DiffAspectView
}): boolean {
  return (
    input.drift.length === 0 &&
    !input.deltas.some(columnDeltaDiffers) &&
    input.added.count === 0 &&
    input.removed.count === 0 &&
    input.changed.count === 0
  )
}

/** Input to {@link buildDiffPanelReport}. */
export interface BuildDiffPanelReportInput {
  readonly diff: DiffReport
  readonly result: EngineRowDiffResult
  readonly keys: readonly string[]
  readonly keySource: 'explicit' | 'inferred'
  readonly inference: DiffKeyDisclosure | null
  /** The plan's shared non-key columns; empty ⇒ `changed` is structurally empty. */
  readonly sharedColumns: readonly string[]
  readonly sampleLimitRequested: number
  readonly sampleLimitEffective: number
  readonly baseViewOnly: boolean
  readonly revision: number
}

/** Assemble the panel/export report from the model report + the row-diff result. */
export function buildDiffPanelReport(input: BuildDiffPanelReportInput): DiffPanelReport {
  const aspects = buildDiffAspectViews(input.result)
  return {
    drift: input.diff.schemaDrift,
    deltas: input.diff.columnDeltas,
    issues: input.diff.issues,
    keys: [...input.keys],
    keySource: input.keySource,
    inference: input.inference,
    sampleLimitRequested: input.sampleLimitRequested,
    sampleLimitEffective: input.sampleLimitEffective,
    baseViewOnly: input.baseViewOnly,
    rowCountA: input.result.rowCountA,
    rowCountB: input.result.rowCountB,
    changedComparable: input.sharedColumns.length > 0,
    added: aspects.added,
    removed: aspects.removed,
    changed: aspects.changed,
    identical: diffReportIdentical({
      drift: input.diff.schemaDrift,
      deltas: input.diff.columnDeltas,
      ...aspects,
    }),
    revision: input.revision,
  }
}

/** A metric as report text: `n/a` for an undefined (`null`) metric. */
export function formatDiffMetric(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a'
  return String(roundForReport(value))
}

/** One schema-drift finding as a human line (column + kind + types/shares). */
export function schemaFindingLine(finding: SchemaDriftFinding): string {
  switch (finding.kind) {
    case 'column-added':
      return `added column ${finding.column} (${finding.typeB ?? '?'})`
    case 'column-removed':
      return `removed column ${finding.column} (${finding.typeA ?? '?'})`
    case 'type-changed-same-family':
      return `type changed (same family): ${finding.column} — ${finding.typeA ?? '?'} → ${finding.typeB ?? '?'}`
    case 'type-changed-cross-family':
      return `type changed (cross family): ${finding.column} — ${finding.typeA ?? '?'} → ${finding.typeB ?? '?'}`
    case 'type-changed-unclassifiable':
      return `type changed (nested/unclassifiable): ${finding.column} — ${finding.typeA ?? '?'} → ${finding.typeB ?? '?'}`
    case 'nullability-changed':
      return `nullability changed: ${finding.column} — null share A ${formatDiffMetric(finding.nullShareA)} → B ${formatDiffMetric(finding.nullShareB)}`
  }
}

/**
 * One column's distribution delta as a human line. Numbers go through the
 * one report rounding convention; `n/a` marks a metric the profiles did not
 * determine (never a fabricated zero).
 */
export function columnDeltaLine(delta: ColumnDistributionDelta): string {
  if (delta.numeric !== undefined) {
    const n = delta.numeric
    return (
      `${delta.column} — numeric: ` +
      `mean shift ${formatDiffMetric(n.meanShiftStandardized)}, ` +
      `variance shift ${formatDiffMetric(n.varianceShiftStandardized)}, ` +
      `p50 shift ${formatDiffMetric(n.p50Shift)}, ` +
      `p90 shift ${formatDiffMetric(n.p90Shift)}`
    )
  }
  if (delta.categorical !== undefined) {
    const c = delta.categorical
    const newValues = c.newCategories.map((entry) => entry.value)
    const vanishedValues = c.vanishedCategories.map((entry) => entry.value)
    return (
      `${delta.column} — categorical: ` +
      `total variation ${formatDiffMetric(c.totalVariation)}, ` +
      `new: [${newValues.join(', ')}], ` +
      `vanished: [${vanishedValues.join(', ')}]`
    )
  }
  return `${delta.column} — ${delta.kindA} → ${delta.kindB}: no comparable metrics (kind changed)`
}

/** English pluralization for panel/export copy. */
export function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`
}

/**
 * The precise comparison caveat — says what the absence of schema/profile
 * differences does and does not prove (the docs-07 honesty rule). It renders
 * ALONE in the post-row-diff result state (`diff-schema-profile-none`): the
 * row diff has already run there, so the "Choose keys…" instruction would be
 * false.
 */
export const SCHEMA_PROFILE_DIFFERENCE_CAVEAT =
  'No schema or profile differences. This compares column structure and the ' +
  'stored profile aggregates only — a row-only difference would not appear ' +
  'here.'

/**
 * The documented zero-state copy for a schema/profile comparison BEFORE a row
 * diff has run — the caveat plus the next action. It renders only while no
 * row-diff result exists (`diff-schema-profile-zero`); once the row diff has
 * run, the result section renders {@link SCHEMA_PROFILE_DIFFERENCE_CAVEAT}
 * alone.
 */
export const SCHEMA_PROFILE_ZERO_STATE = `${SCHEMA_PROFILE_DIFFERENCE_CAVEAT} Choose keys below to run the row diff.`

/** The documented zero-state once a row diff has returned 0/0/0 everywhere. */
export function identicalZeroState(keys: readonly string[]): string {
  return (
    `No differences: schema, profile, and row-level comparison (keys: ${keys.join(', ')}) ` +
    'all agree. This is the exact-count result of every aspect that ran.'
  )
}

/**
 * The honest clamp line for a partial sample set. `requested` is the plan K;
 * `effective` is the engine-executed bound (`min(K, 100)`). Only rendered
 * when the sample list is partial — a complete list never needs a caveat.
 * Mirrors the CLI's wording so the two surfaces read the same.
 */
export function sampleClampText(
  count: number,
  returned: number,
  requested: number,
  effective: number,
): string {
  const clamp =
    effective < requested
      ? ` (sample limit ${String(requested)} clamped to 100)`
      : ` (sample limit ${String(requested)})`
  return `… ${String(count - returned)} more not shown${clamp}`
}
