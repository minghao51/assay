// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// m6-3 — `assay diff` report model + renderers
//
// Aspect order, in BOTH outputs (the docs-07 honesty rule made visible):
// schema drift, then profile (distribution) deltas, then the key-based row
// diff. The report renders from the SAME `@assay/diff` model objects the web
// panel will render from, with every report-facing number passed through the
// package's single `roundForReport` convention, so the CLI JSON is the
// reference shape m6-5's cross-surface agreement compares against.
//
// Byte stability is a contract (`--format json`): fixed key order, no
// timestamps, no file paths (basenames only), `JSON.stringify(…, 2)` + a
// trailing newline. Dataset values appear ONLY as row-diff sample keys /
// changed-column names (the product); stderr never carries a value.
// ---------------------------------------------------------------------------

import { describeDiffIssue, roundForReport } from '@assay/diff'
import type {
  ColumnDistributionDelta,
  DiffIssue,
  DiffReport,
  KeyCandidateEvidence,
  SchemaDriftFinding,
} from '@assay/diff'
import type {
  EngineRowDiffAspect,
  EngineRowDiffResult,
  EngineRowDiffSample,
} from '@assay/engine-duckdb/node'
import { ROW_DIFF_SAMPLE_HARD_MAX } from '@assay/engine-duckdb/node'
import { displayRowKey, exportRowKey, REPORT_VERSION } from './report-shared.js'
import { plainStyle } from './style.js'
import type { ReportStyle } from './style.js'

/** The three row-diff aspects, in the compiler's documented order. */
export type DiffAspectName = EngineRowDiffAspect

/** One row-diff aspect: the exact count plus its bounded samples. */
export interface DiffAspectReport {
  readonly aspect: DiffAspectName
  /** The exact count over the full relations (never the sample bound). */
  readonly count: number
  readonly samplesReturned: number
  /** True when every differing row is in `samples` (count ≤ returned). */
  readonly samplesComplete: boolean
  readonly samples: readonly EngineRowDiffSample[]
}

/** The full row-diff aspect, assembled from the engine's `EngineRowDiffResult`. */
export interface DiffRowDiffReport {
  readonly rowCountA: number
  readonly rowCountB: number
  readonly added: DiffAspectReport
  readonly removed: DiffAspectReport
  readonly changed: DiffAspectReport
  /**
   * False when the two schemas share no NON-key column: `changed` is then
   * structurally empty (there is nothing to compare) and the report says so
   * rather than implying a clean comparison.
   */
  readonly changedComparable: boolean
}

/**
 * The inference disclosure the CLI must emit for `--infer` (checkpoint C2):
 * the chosen key columns, the candidate's verbatim disclosure, the outcome
 * disclosure, and the machine-readable evidence. Present iff `--infer` chose
 * the key; `null` for an explicit `--key` run — never a silent guess.
 */
export interface DiffInferenceDisclosure {
  readonly columns: readonly string[]
  readonly candidateDisclosure: string
  readonly outcomeDisclosure: string
  readonly evidence: KeyCandidateEvidence
}

/** Render metadata for the diff renderers (no dataset values allowed here). */
export interface DiffReportMeta {
  /** Side A file's BASENAME (never the full path — byte-stability). */
  readonly nameA: string
  readonly nameB: string
  readonly formatA: string
  readonly formatB: string
  /** The resolved key columns, in order (explicit or inferred top candidate). */
  readonly keys: readonly string[]
  readonly keySource: 'explicit' | 'inferred'
  readonly inference: DiffInferenceDisclosure | null
  /** The K the plan was compiled with (`--sample-limit` or the default). */
  readonly sampleLimitRequested: number
  /** The engine-clamped K the aspect queries actually carried. */
  readonly sampleLimitEffective: number
}

/** The assembled diff command report: the model aspects + the row diff. */
export interface DiffCommandReport {
  readonly diff: DiffReport
  readonly rowDiff: DiffRowDiffReport
}

/**
 * Assemble the row-diff report from the engine's result (the m6-2 result
 * contract), preserving the compiler's aspect order. `changedComparable`
 * comes from the plan's shared non-key columns (the caller knows it).
 */
export function buildDiffRowDiffReport(
  result: EngineRowDiffResult,
  changedComparable: boolean,
): DiffRowDiffReport {
  const byAspect = new Map(result.aspects.map((entry) => [entry.aspect, entry] as const))
  const aspect = (name: DiffAspectName): DiffAspectReport => {
    const entry = byAspect.get(name)
    const count = entry?.count ?? 0
    const samples = entry?.samples ?? []
    return {
      aspect: name,
      count,
      samplesReturned: samples.length,
      samplesComplete: count <= samples.length,
      samples,
    }
  }
  return {
    rowCountA: result.rowCountA,
    rowCountB: result.rowCountB,
    added: aspect('added'),
    removed: aspect('removed'),
    changed: aspect('changed'),
    changedComparable,
  }
}

/** Anchor-free display key for a row-diff sample (`base #12` / `b #3`). */
export function displayDiffRowKey(rowKey: string): string {
  if (rowKey.startsWith('b:')) return `b #${rowKey.slice(2)}`
  return displayRowKey(rowKey)
}

/** Anchor-free export key for a row-diff sample (`base:12` / `b:3`). */
export function exportDiffRowKey(rowKey: string): string {
  if (rowKey.startsWith('b:')) return rowKey
  return exportRowKey(rowKey)
}

/** Exact `-0`-normalized report rounding for a finite-or-null metric. */
function roundMetric(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  return roundForReport(value)
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

/** English pluralization helper for the human report (byte-pinned). */
function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`
}

/**
 * The columns whose distribution delta carries a defined non-zero signal —
 * the CLI's single "profile deltas" decision (q-4/AR-C6). The human count
 * and list, the JSON `identical` verdict, and the exit code all read THIS
 * list, so they cannot drift apart.
 */
export function divergentColumnDeltas(
  deltas: readonly ColumnDistributionDelta[],
): readonly ColumnDistributionDelta[] {
  return deltas.filter(columnDeltaDiffers)
}

/**
 * The one identity verdict over the aspects that ran — schema drift, any
 * non-zero profile delta, and the three row-diff counts. Shared by the human
 * and JSON verdicts and the exit code (q-4/AR-C6: previously computed
 * independently in two places).
 */
export function diffReportIdentical(report: DiffCommandReport): boolean {
  return (
    report.diff.schemaDrift.length === 0 &&
    divergentColumnDeltas(report.diff.columnDeltas).length === 0 &&
    report.rowDiff.added.count === 0 &&
    report.rowDiff.removed.count === 0 &&
    report.rowDiff.changed.count === 0
  )
}

/** One schema-drift finding as a human line (aspect order is the sort order). */
export function schemaFindingLine(finding: SchemaDriftFinding): string {
  switch (finding.kind) {
    case 'column-added':
      return `column-added: ${finding.column} — B ${finding.typeB ?? '?'}`
    case 'column-removed':
      return `column-removed: ${finding.column} — A ${finding.typeA ?? '?'}`
    case 'type-changed-same-family':
    case 'type-changed-cross-family':
    case 'type-changed-unclassifiable':
      return `${finding.kind}: ${finding.column} — ${finding.typeA ?? '?'} -> ${finding.typeB ?? '?'}`
    case 'nullability-changed':
      return `nullability-changed: ${finding.column} — null share A ${formatMetric(roundMetric(finding.nullShareA))} -> B ${formatMetric(roundMetric(finding.nullShareB))}`
  }
}

/** One column delta as a human line (see the module doc for the shapes). */
export function columnDeltaLine(delta: ColumnDistributionDelta): string {
  if (delta.numeric !== undefined) {
    const n = delta.numeric
    return (
      `${delta.column} — numeric: ` +
      `mean shift ${formatMetric(roundMetric(n.meanShiftStandardized))}, ` +
      `variance shift ${formatMetric(roundMetric(n.varianceShiftStandardized))}, ` +
      `p50 shift ${formatMetric(roundMetric(n.p50Shift))}, ` +
      `p90 shift ${formatMetric(roundMetric(n.p90Shift))}`
    )
  }
  if (delta.categorical !== undefined) {
    const c = delta.categorical
    return (
      `${delta.column} — categorical: ` +
      `total variation ${formatMetric(roundMetric(c.totalVariation))}, ` +
      `new: [${c.newCategories.map((entry) => entry.value).join(', ')}], ` +
      `vanished: [${c.vanishedCategories.map((entry) => entry.value).join(', ')}]`
    )
  }
  return `${delta.column} — ${delta.kindA} -> ${delta.kindB}: no comparable metrics`
}

/** A metric as report text: `n/a` for an undefined metric (`null`). */
function formatMetric(value: number | null): string {
  return value === null ? 'n/a' : String(value)
}

/** The honest clamp line for one partial aspect's sample list. */
function diffTruncationLine(
  aspect: DiffAspectName,
  count: number,
  returned: number,
  meta: DiffReportMeta,
): string {
  const remaining = count - returned
  const clamp =
    meta.sampleLimitEffective < meta.sampleLimitRequested
      ? ` (sample limit ${String(meta.sampleLimitRequested)} clamped to ${String(ROW_DIFF_SAMPLE_HARD_MAX)})`
      : ` (sample limit ${String(meta.sampleLimitRequested)})`
  return `    … ${String(remaining)} more ${aspect} rows not shown${clamp}`
}

/** One row-diff aspect's human block (`added`, `removed`, or `changed`). */
function renderAspectLines(
  label: string,
  aspect: DiffAspectReport,
  meta: DiffReportMeta,
  style: ReportStyle,
  notComparable = false,
): string[] {
  const lines: string[] = []
  const suffix = notComparable ? ' — no shared non-key columns to compare' : ''
  lines.push(`  ${label} (${style.count(String(aspect.count))}${suffix}):`)
  if (aspect.samples.length === 0) {
    lines.push('    none')
    return lines
  }
  for (const sample of aspect.samples) {
    const key = displayDiffRowKey(sample.rowKey)
    if (sample.changedColumns !== undefined && sample.changedColumns.length > 0) {
      lines.push(`    ${key} — changed: ${sample.changedColumns.join(', ')}`)
    } else {
      lines.push(`    ${key}`)
    }
  }
  if (!aspect.samplesComplete) {
    lines.push(diffTruncationLine(aspect.aspect, aspect.count, aspect.samples.length, meta))
  }
  return lines
}

/**
 * The human diff report. Aspect order is schema drift → profile deltas → row
 * diff (docs-07), then any collected input issues, then the verdict. The
 * "profile deltas" count and list carry only columns with a non-zero signal
 * (q-4/AR-C6), and the identical-files case is explicit and honest about the
 * scope of the identity claim: the row diff ran, so the identity holds at
 * row level too — and the verdict says exactly that (schema/profile identity
 * alone would not).
 */
export function renderHumanDiffReport(
  report: DiffCommandReport,
  meta: DiffReportMeta,
  style: ReportStyle = plainStyle,
): string {
  const lines: string[] = []
  lines.push(`a: ${meta.nameA} (${meta.formatA})`)
  lines.push(`b: ${meta.nameB} (${meta.formatB})`)
  lines.push(`rows: ${String(report.rowDiff.rowCountA)} -> ${String(report.rowDiff.rowCountB)}`)
  lines.push(
    `keys: ${meta.keys.join(', ')} (${meta.keySource === 'inferred' ? 'inferred — top candidate' : 'explicit'})`,
  )
  if (meta.inference !== null) {
    lines.push(`inference: ${meta.inference.candidateDisclosure}`)
    lines.push(`inference outcome: ${meta.inference.outcomeDisclosure}`)
  }

  const drift = report.diff.schemaDrift
  if (drift.length === 0) {
    lines.push('schema drift: none')
  } else {
    lines.push(
      `schema drift: ${style.count(String(drift.length))} ${plural(drift.length, 'finding')}`,
    )
    for (const finding of drift) lines.push(`  ${schemaFindingLine(finding)}`)
  }

  const divergent = divergentColumnDeltas(report.diff.columnDeltas)
  if (divergent.length === 0) {
    lines.push('profile deltas: none')
  } else {
    lines.push(
      `profile deltas: ${style.count(String(divergent.length))} ${plural(divergent.length, 'column')}`,
    )
    for (const delta of divergent) lines.push(`  ${columnDeltaLine(delta)}`)
  }

  const { added, removed, changed } = report.rowDiff
  lines.push(
    `row diff: ${style.count(`${String(added.count)} added, ${String(removed.count)} removed, ${String(changed.count)} changed`)}`,
  )
  lines.push(...renderAspectLines('added', added, meta, style))
  lines.push(...renderAspectLines('removed', removed, meta, style))
  lines.push(
    ...renderAspectLines('changed', changed, meta, style, !report.rowDiff.changedComparable),
  )

  const issues = report.diff.issues
  if (issues.length > 0) {
    lines.push(`issues: ${style.warn(String(issues.length))} ${plural(issues.length, 'issue')}`)
    for (const issue of issues) lines.push(`  ${style.warn(describeIssueLine(issue))}`)
  }

  const labels: string[] = []
  if (drift.length > 0) labels.push('schema drift')
  if (divergent.length > 0) labels.push('profile deltas')
  if (added.count > 0 || removed.count > 0 || changed.count > 0) labels.push('row diff')
  if (labels.length === 0) {
    lines.push(
      `verdict: ${style.pass('IDENTICAL')} — no differences found (row diff ran on keys: ${meta.keys.join(', ')}; schema/profile-level identity alone would not prove row identity)`,
    )
  } else {
    lines.push(`verdict: ${style.fail('DIFFERENCES')} — ${labels.join(', ')}`)
  }
  return lines.join('\n') + '\n'
}

/** A schema-drift finding projected for JSON (fixed keys; rounded shares). */
function schemaFindingJson(finding: SchemaDriftFinding): Record<string, unknown> {
  return {
    kind: finding.kind,
    column: finding.column,
    typeA: finding.typeA ?? null,
    typeB: finding.typeB ?? null,
    familyA: finding.familyA ?? null,
    familyB: finding.familyB ?? null,
    nullShareA: roundMetric(finding.nullShareA),
    nullShareB: roundMetric(finding.nullShareB),
  }
}

/** One column delta projected for JSON (rounded metrics; fixed keys). */
function columnDeltaJson(delta: ColumnDistributionDelta): Record<string, unknown> {
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
            meanShiftStandardized: roundMetric(delta.numeric.meanShiftStandardized),
            varianceShiftStandardized: roundMetric(delta.numeric.varianceShiftStandardized),
            p50Shift: roundMetric(delta.numeric.p50Shift),
            p90Shift: roundMetric(delta.numeric.p90Shift),
          },
    categorical:
      delta.categorical === undefined
        ? null
        : {
            totalVariation: roundMetric(delta.categorical.totalVariation),
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

/** One input issue projected for JSON (fixed keys). */
function issueJson(issue: DiffIssue): Record<string, unknown> {
  return {
    code: issue.code,
    message: issue.message,
    side: issue.side ?? null,
    column: issue.column ?? null,
  }
}

/** One row-diff sample projected for JSON (anchor-free export key). */
function sampleJson(sample: EngineRowDiffSample): Record<string, unknown> {
  return sample.changedColumns === undefined
    ? { side: sample.side, rowKey: exportDiffRowKey(sample.rowKey) }
    : {
        side: sample.side,
        rowKey: exportDiffRowKey(sample.rowKey),
        changedColumns: [...sample.changedColumns],
      }
}

/** One row-diff aspect projected for JSON. */
function aspectJson(aspect: DiffAspectReport): Record<string, unknown> {
  return {
    count: aspect.count,
    samplesReturned: aspect.samplesReturned,
    samplesComplete: aspect.samplesComplete,
    samples: aspect.samples.map(sampleJson),
  }
}

/**
 * The `--format json` envelope — the byte-stable reference shape for m6-5's
 * cross-surface agreement:
 *
 *     report:               'assay-diff-report' (the format marker)
 *     reportVersion:        the CLI package version that produced the report
 *     baseViewOnly:         true — the CLI diffed the RAW file (no overlay)
 *     a / b:                { name (basename), format }
 *     keys / keySource:     the resolved key set and how it was chosen
 *     inference:            the C2 disclosure (null for explicit keys)
 *     sampleLimit*:         requested K and the engine-clamped effective K
 *     schemaDrift[]:        aspect 1, in the model's documented order
 *     columnDeltas[]:       aspect 2, profile-A column order, rounded
 *     rowDiff:              aspect 3 (counts + bounded samples)
 *     issues[]:             collected input issues (empty for well-formed)
 *     identical:            the verdict across the aspects that ran
 *
 * Fixed key order, 2-space indent, trailing newline, no timestamps, no paths.
 */
export function renderJsonDiffReport(report: DiffCommandReport, meta: DiffReportMeta): string {
  const { added, removed, changed } = report.rowDiff
  const identical = diffReportIdentical(report)
  const payload = {
    report: 'assay-diff-report',
    reportVersion: REPORT_VERSION,
    baseViewOnly: true,
    a: { name: meta.nameA, format: meta.formatA },
    b: { name: meta.nameB, format: meta.formatB },
    keys: [...meta.keys],
    keySource: meta.keySource,
    inference:
      meta.inference === null
        ? null
        : {
            columns: [...meta.inference.columns],
            candidateDisclosure: meta.inference.candidateDisclosure,
            outcomeDisclosure: meta.inference.outcomeDisclosure,
            evidence: {
              column: meta.inference.evidence.column,
              typeA: meta.inference.evidence.typeA,
              typeB: meta.inference.evidence.typeB,
              rowCountA: meta.inference.evidence.rowCountA,
              rowCountB: meta.inference.evidence.rowCountB,
              nullCountA: meta.inference.evidence.nullCountA,
              nullCountB: meta.inference.evidence.nullCountB,
              distinctCountA: meta.inference.evidence.distinctCountA,
              distinctCountB: meta.inference.evidence.distinctCountB,
            },
          },
    sampleLimitRequested: meta.sampleLimitRequested,
    sampleLimitEffective: meta.sampleLimitEffective,
    schemaDrift: report.diff.schemaDrift.map(schemaFindingJson),
    columnDeltas: report.diff.columnDeltas.map(columnDeltaJson),
    rowDiff: {
      rowCountA: report.rowDiff.rowCountA,
      rowCountB: report.rowDiff.rowCountB,
      changedComparable: report.rowDiff.changedComparable,
      added: aspectJson(added),
      removed: aspectJson(removed),
      changed: aspectJson(changed),
    },
    issues: report.diff.issues.map(issueJson),
    identical,
  }
  return JSON.stringify(payload, null, 2) + '\n'
}

/**
 * The canonical one-line rendering of a collected diff issue, used for
 * surfacing inference/input problems on stderr without echoing values (the
 * issue text is authored by `@assay/diff`).
 */
export function describeIssueLine(issue: DiffIssue): string {
  return describeDiffIssue(issue)
}
