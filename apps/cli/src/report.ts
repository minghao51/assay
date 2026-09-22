/**
 * The m5-4 validation report model + renderers.
 *
 * The CLI renders from the SAME frozen result contract the m5-3 web panel
 * renders from (`EngineValidationResult`: per-rule
 * `{ruleId, failCount, failPercent, sampleFailures}`, the exact BigInt
 * half-up `failPercent` computed by the engine's `failPercentFromCounts`).
 * The presentation semantics replicated here are the DOCUMENTED m5-3 report
 * semantics (its report-model module doc), re-implemented for this surface —
 * no web code is imported:
 *
 * 1. the severity ordering (see `compareReportRules`);
 * 2. the per-kind rule labels (`RULE_LABELS`);
 * 3. the canonical sample-value text (explicit `NULL`, verbatim strings,
 *    `true`/`false`, exact shortest number form);
 * 4. the anchor-free row-key discipline (the anchor token — here the empty
 *    base anchor — is never rendered; display `base #12`, export `base:12`).
 *
 * Byte stability is a contract (`--format json`): fixed key order, no
 * timestamps, `JSON.stringify(…, 2)` + trailing newline, so the same run is
 * byte-identical everywhere (pinned by integration tests).
 *
 * Honesty rules baked in: samples carry `samplesReturned` +
 * `samplesComplete` (the bounded-set gate — a partial list says so, in both
 * renderers, with the clamp spelled out); dataset values appear ONLY as
 * product content on stdout — sample rows, and the categorical new/vanished
 * category labels of schema-drift/profiling deltas (audit AR-C1) — never in
 * stderr; the human dataset line prints the file's BASENAME only
 * (byte-stable across machines, and file paths stay out of product output).
 */
import { basename } from 'node:path'
import { describeDiffIssue, roundForReport } from '@assay/diff'
import type {
  ColumnDistributionDelta,
  DiffIssue,
  DiffReport,
  KeyCandidateEvidence,
  SchemaDriftFinding,
} from '@assay/diff'
import { parseRowId } from '@assay/domain'
import type { RowId } from '@assay/domain'
import type {
  EngineValidationPlan,
  EngineValidationResult,
  EngineValidationSample,
} from '@assay/engine-duckdb/node'
import type {
  EngineRowDiffAspect,
  EngineRowDiffResult,
  EngineRowDiffSample,
} from '@assay/engine-duckdb/node'
import { VALIDATION_SAMPLE_HARD_MAX } from '@assay/engine-duckdb/node'

/** One per-rule report row, severity-ordered by {@link compareReportRules}. */
export interface ValidationReportRow {
  readonly ruleId: string
  /** Constrained column; `null` for dataset-level rules. */
  readonly column: string | null
  /** The plan rule kind (the m5-1 vocabulary), or `'unknown'` defensively. */
  readonly kind: string
  /** Human label (see {@link ruleLabel}); presentation only. */
  readonly label: string
  readonly failCount: number
  /** The engine's frozen integer half-up share — rendered, never recomputed. */
  readonly failPercent: number
  readonly failing: boolean
  readonly outcome: 'row-samples' | 'dataset-fact' | 'unknown'
  readonly samples: readonly EngineValidationSample[]
  /**
   * True when every violating row is in `samples` (the bounded-set gate).
   * A `dataset-fact` rule is ALWAYS sample-complete: facts carry no row
   * samples by contract (m5-4 — a fact is a boolean about the whole
   * dataset), so an empty sample list under a failing fact is the complete
   * set, never a partial one.
   */
  readonly samplesComplete: boolean
  /** declared-type rules only: the contract's expected type spelling. */
  readonly expectedType?: string
  /** declared-type rules only: the dataset's actual type spelling. */
  readonly actualType?: string
}

/** A full report: verdict + row count + the severity-ordered rows. */
export interface ValidationReport {
  readonly valid: boolean
  readonly rowCount: number
  readonly rows: readonly ValidationReportRow[]
}

/**
 * Build the severity-ordered report from a compiled plan and its executed
 * result. Plan/result misalignment degrades to `unknown` rows (defensive —
 * the compiler keys results by rule, so it cannot happen for real output).
 */
export function buildValidationReport(
  plan: EngineValidationPlan,
  result: EngineValidationResult,
): ValidationReport {
  const planByRuleId = new Map<string, EngineValidationPlan['rules'][number]>()
  for (const rule of plan.rules) planByRuleId.set(rule.ruleId, rule)
  const rows: ValidationReportRow[] = result.rules.map((ruleResult) => {
    const planRule = planByRuleId.get(ruleResult.ruleId)
    const kind = planRule?.kind ?? 'unknown'
    const outcome =
      planRule?.outcome === 'dataset-fact' || planRule?.outcome === 'row-samples'
        ? planRule.outcome
        : ('unknown' as const)
    return {
      ruleId: ruleResult.ruleId,
      column: planRule?.column ?? null,
      kind,
      label: ruleLabel(kind),
      failCount: ruleResult.failCount,
      failPercent: ruleResult.failPercent,
      failing: ruleResult.failCount > 0,
      outcome,
      samples: ruleResult.sampleFailures,
      // The bounded-set gate: a row list shorter than the count is partial
      // — unless the rule is a dataset-fact, whose (empty) sample list is
      // complete by contract (facts never carry row samples).
      samplesComplete:
        outcome === 'dataset-fact' || ruleResult.failCount <= ruleResult.sampleFailures.length,
      ...(planRule?.expectedType === undefined ? {} : { expectedType: planRule.expectedType }),
      ...(planRule?.actualType === undefined ? {} : { actualType: planRule.actualType }),
    }
  })
  rows.sort(compareReportRules)
  return { valid: result.valid, rowCount: result.rowCount, rows }
}

/**
 * The severity ordering — the documented m5-3 order, replicated clause for
 * clause: (1) failing rules (`failCount > 0`) before passing rules; (2)
 * dataset-fact rules before row-samples rules within each group; (3) higher
 * frozen-integer `failPercent` first; (4) `ruleId` ascending in code-unit
 * order as the total tiebreak (the m5-0 error-path grammar).
 */
export function compareReportRules(a: ValidationReportRow, b: ValidationReportRow): number {
  // 1. Failing before passing.
  const aFailing = a.failCount > 0 ? 0 : 1
  const bFailing = b.failCount > 0 ? 0 : 1
  if (aFailing !== bFailing) return aFailing - bFailing
  // 2. Dataset facts before per-row rules.
  const aFact = a.outcome === 'dataset-fact' ? 0 : 1
  const bFact = b.outcome === 'dataset-fact' ? 0 : 1
  if (aFact !== bFact) return aFact - bFact
  // 3. Higher frozen share first.
  if (a.failPercent !== b.failPercent) return b.failPercent - a.failPercent
  // 4. ruleId ascending (code-unit order) — the total tiebreak.
  if (a.ruleId < b.ruleId) return -1
  if (a.ruleId > b.ruleId) return 1
  return 0
}

/** The per-kind labels (the documented m5-3 set); unknown kinds degrade. */
const RULE_LABELS: Readonly<Record<string, string>> = {
  'declared-type': 'Declared type',
  required: 'Required (no NULLs)',
  unique: 'Unique values',
  min: 'Minimum bound',
  max: 'Maximum bound',
  'allowed-values': 'Allowed values',
  regex: 'Pattern (RE2 full match)',
  'max-null-share': 'Maximum NULL share',
  'min-distinct-share': 'Minimum distinct share',
  'min-rows': 'Minimum row count',
  'max-rows': 'Maximum row count',
}

/** Label for a rule kind; unknown kinds degrade honestly. */
export function ruleLabel(kind: string): string {
  return RULE_LABELS[kind] ?? 'Rule'
}

/**
 * Canonical text rendering of a wire-normalized sample value: NULL renders as
 * the explicit text `NULL` (an empty string is a real value and the two must
 * stay distinguishable), strings verbatim, booleans `true`/`false`, numbers
 * through their exact shortest form.
 */
export function sampleValueText(value: string | number | boolean | null): string {
  if (value === null) return 'NULL'
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

/**
 * Anchor-free display form of a row key (the anchor token is host-derived and
 * never rendered). Unparsable keys cannot occur from the executor (it
 * guarantees resolvable keys) and degrade to `unknown row`.
 */
export function displayRowKey(rowKey: string): string {
  const parsed = parseRowId(rowKey as RowId)
  if (parsed === null) return 'unknown row'
  return parsed.origin === 'base'
    ? `base #${String(parsed.ordinal)}`
    : `insert #${String(parsed.seq)}`
}

/**
 * Anchor-free export form (`base:<ordinal>` / `insert:<seq>`) — stable enough
 * to join against the source data without carrying the anchor fingerprint.
 */
export function exportRowKey(rowKey: string): string {
  const parsed = parseRowId(rowKey as RowId)
  if (parsed === null) return 'unknown'
  return parsed.origin === 'base'
    ? `base:${String(parsed.ordinal)}`
    : `insert:${String(parsed.seq)}`
}

/** Render metadata for the report renderers (no dataset values allowed here). */
export interface ReportMeta {
  /** The contract's declared name (m5-0). */
  readonly contractName: string
  readonly contractVersion: number
  /** The dataset file's BASENAME (never the full path — byte-stability). */
  readonly datasetName: string
  readonly format: string
  /** The K the plan was compiled with (`--sample-limit` or the default). */
  readonly sampleLimitRequested: number
  /** The engine-clamped K the queries actually carried. */
  readonly sampleLimitEffective: number
}

/**
 * The human report. Line formats are part of the byte-pinned integration
 * contract. Dataset values appear ONLY as sample lines (`row — value`); the
 * truncation line names the clamp explicitly instead of pretending the list
 * is complete.
 */
export function renderHumanReport(report: ValidationReport, meta: ReportMeta): string {
  const lines: string[] = []
  lines.push(
    `dataset: ${meta.datasetName} (${meta.format}) — base view only (the raw file; no edits)`,
  )
  lines.push(`contract: ${meta.contractName} v${String(meta.contractVersion)}`)
  lines.push(`rows: ${String(report.rowCount)}`)
  lines.push(`rules: ${String(report.rows.length)}`)
  const failingCount = report.rows.filter((row) => row.failing).length
  for (const row of report.rows) {
    const what = row.column === null ? row.label : `${row.column} — ${row.label}`
    const head = row.failing
      ? `FAIL ${row.ruleId} — ${what} — ${String(row.failCount)} of ${String(report.rowCount)} rows (${String(row.failPercent)}%)`
      : `PASS ${row.ruleId} — ${what} — 0 violations`
    lines.push(head)
    for (const sample of row.samples) {
      lines.push(`     ${displayRowKey(sample.rowKey)} — ${sampleValueText(sample.value)}`)
    }
    if (row.failing && !row.samplesComplete) {
      lines.push(truncationLine(row.failCount, row.samples.length, meta))
    }
  }
  lines.push(
    report.valid
      ? `verdict: VALID — 0 violations across ${String(report.rows.length)} rules (${String(report.rowCount)} rows)`
      : `verdict: INVALID — ${String(failingCount)} of ${String(report.rows.length)} rules failing (${String(report.rowCount)} rows)`,
  )
  return lines.join('\n') + '\n'
}

/** The honest clamp line (only rendered when the sample list is partial). */
function truncationLine(failCount: number, returned: number, meta: ReportMeta): string {
  const clamped =
    meta.sampleLimitEffective < meta.sampleLimitRequested
      ? ` (sample limit ${String(meta.sampleLimitRequested)} clamped to ${String(VALIDATION_SAMPLE_HARD_MAX)})`
      : ''
  return `     … ${String(failCount - returned)} more failures not shown${clamped}`
}

/**
 * The `--format json` envelope — the m5-3 report-export shape (so a web
 * report and a CLI report compare field-for-field) plus the two CLI honesty
 * fields documented in `--help`:
 *
 *     report:         'assay-validation-report' (the format marker)
 *     baseViewOnly:   true — the CLI validated the RAW file, never an overlay
 *     contract:       { name, version }
 *     valid:          the total verdict
 *     stale:          always false on this surface (no editing session)
 *     datasetRows:    the validated row count
 *     rules[]:        severity-ordered; per rule ruleId, column, rule (kind),
 *                     label, failCount, failPercent (frozen integer),
 *                     samplesReturned, samplesComplete, sampleRowKeys
 *                     (anchor-free `base:<n>` forms), sampleValues (typed)
 *
 * Byte-stable: fixed key order, 2-space indent, trailing newline, no
 * timestamps, no paths.
 */
export function renderJsonReport(report: ValidationReport, meta: ReportMeta): string {
  const payload = {
    report: 'assay-validation-report',
    baseViewOnly: true,
    contract: { name: meta.contractName, version: meta.contractVersion },
    valid: report.valid,
    stale: false,
    datasetRows: report.rowCount,
    rules: report.rows.map((row) => ({
      ruleId: row.ruleId,
      column: row.column,
      rule: row.kind,
      label: row.label,
      failCount: row.failCount,
      failPercent: row.failPercent,
      samplesReturned: row.samples.length,
      samplesComplete: row.samplesComplete,
      sampleRowKeys: row.samples.map((sample) => exportRowKey(sample.rowKey)),
      sampleValues: row.samples.map((sample) => sample.value),
    })),
  }
  return JSON.stringify(payload, null, 2) + '\n'
}

/** The dataset's basename for the report meta (paths stay out of stdout). */
export function datasetDisplayName(datasetPath: string): string {
  return basename(datasetPath)
}

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
      ? ` (sample limit ${String(meta.sampleLimitRequested)} clamped to ${String(VALIDATION_SAMPLE_HARD_MAX)})`
      : ` (sample limit ${String(meta.sampleLimitRequested)})`
  return `    … ${String(remaining)} more ${aspect} rows not shown${clamp}`
}

/** One row-diff aspect's human block (`added`, `removed`, or `changed`). */
function renderAspectLines(
  label: string,
  aspect: DiffAspectReport,
  meta: DiffReportMeta,
  notComparable = false,
): string[] {
  const lines: string[] = []
  const suffix = notComparable ? ' — no shared non-key columns to compare' : ''
  lines.push(`  ${label} (${String(aspect.count)}${suffix}):`)
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
 * diff (docs-07). The identical-files case is explicit and honest about the
 * scope of the identity claim: the row diff ran, so the identity holds at
 * row level too — and the verdict says exactly that (schema/profile identity
 * alone would not).
 */
export function renderHumanDiffReport(report: DiffCommandReport, meta: DiffReportMeta): string {
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
    lines.push(`schema drift: ${String(drift.length)} ${plural(drift.length, 'finding')}`)
    for (const finding of drift) lines.push(`  ${schemaFindingLine(finding)}`)
  }

  const deltas = report.diff.columnDeltas
  if (deltas.length === 0) {
    lines.push('profile deltas: none')
  } else {
    lines.push(`profile deltas: ${String(deltas.length)} ${plural(deltas.length, 'column')}`)
    for (const delta of deltas) lines.push(`  ${columnDeltaLine(delta)}`)
  }

  const { added, removed, changed } = report.rowDiff
  lines.push(
    `row diff: ${String(added.count)} added, ${String(removed.count)} removed, ${String(changed.count)} changed`,
  )
  lines.push(...renderAspectLines('added', added, meta))
  lines.push(...renderAspectLines('removed', removed, meta))
  lines.push(...renderAspectLines('changed', changed, meta, !report.rowDiff.changedComparable))

  const labels: string[] = []
  if (drift.length > 0) labels.push('schema drift')
  if (deltas.some(columnDeltaDiffers)) labels.push('profile deltas')
  if (added.count > 0 || removed.count > 0 || changed.count > 0) labels.push('row diff')
  if (labels.length === 0) {
    lines.push(
      `verdict: IDENTICAL — no differences found (row diff ran on keys: ${meta.keys.join(', ')}; schema/profile-level identity alone would not prove row identity)`,
    )
  } else {
    lines.push(`verdict: DIFFERENCES — ${labels.join(', ')}`)
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
  const identical =
    report.diff.schemaDrift.length === 0 &&
    !report.diff.columnDeltas.some(columnDeltaDiffers) &&
    added.count === 0 &&
    removed.count === 0 &&
    changed.count === 0
  const payload = {
    report: 'assay-diff-report',
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
