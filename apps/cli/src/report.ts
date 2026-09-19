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
 * sample rows (the product), never in stderr; the human dataset line prints
 * the file's BASENAME only (byte-stable across machines, and file paths stay
 * out of product output).
 */
import { basename } from 'node:path'
import { parseRowId } from '@assay/domain'
import type { RowId } from '@assay/domain'
import type {
  EngineValidationPlan,
  EngineValidationResult,
  EngineValidationSample,
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
