/**
 * Failure-report export (m5-3) — the pure CSV/JSON report builders plus the
 * destination/delivery glue, mirroring the m4-5 export UX patterns and copy
 * rules (`../export/save-destination`, `../export/messages`).
 *
 * ## Report shape (documented; pinned by unit tests and the export e2e)
 *
 * The report is the on-screen report, verbatim: one entry per rule, in the
 * panel's severity order, with the SAME counts (failCount / frozen-integer
 * failPercent / dataset row count / sample counts / completeness), so the
 * file can never disagree with the screen. Sample row keys are exported in
 * the anchor-free `base:<ordinal>` / `insert:<seq>` form (the m4-3 anchor
 * token never leaves the app); sample values are the wire values — typed
 * and raw in JSON, rendered as canonical text in CSV.
 *
 * - **JSON** (`application/json`): a report envelope
 *   `{ report, contract: {name, version}, valid, stale, datasetRows, rules: [...] }`
 *   where each rule carries `sampleRowKeys: string[]` and `sampleValues`
 *   as the typed wire values (string/number/boolean/null — JSON needs no
 *   formula-injection guard; the m4-5 precedent exports JSONL/JSON raw).
 * - **CSV** (`text/csv`): one row per rule with the same fields; the two
 *   sample columns hold JSON-array TEXT (`["base:4","base:9"]`), and every
 *   STRING sample value is formula-injection-sanitized BEFORE embedding
 *   (leading `=`/`+`/`-`/`@`, or any tab/CR — the exact scalar trigger set
 *   of the engine's `formulaInjectionGuardSql`, mirrored here because the
 *   report is built client-side, not engine-side). The composed array cell
 *   always begins with `[`, which no spreadsheet evaluates as a formula
 *   introducer, so per-cell re-checking is unnecessary by construction.
 *
 * ## Delivery (always a NEW file)
 *
 * The report is a report — never a rewrite of anything (ADR 0012). Delivery
 * reuses the m4-5 save-destination patterns: the File System Access save
 * picker when a retained source identity can prove a picked destination is
 * not the opened source (same-entry → refused before any byte write), and
 * otherwise the anchor-download fallback. An input-fallback session (no
 * provable identity) is download-only by construction, exactly like the
 * dataset export path.
 */
import type {
  SaveDestination,
  SaveStrategy,
  WritableSaveDestination,
} from '../export/save-destination'
import { detectSaveCapabilities } from '../export/save-destination'
import type { ValidationReport } from './report-model'

/** The two report formats. */
export type ReportExportFormat = 'csv' | 'json'

export interface ReportExportFormatInfo {
  readonly format: ReportExportFormat
  readonly label: string
  readonly extension: string
  readonly mimeType: string
}

export const REPORT_EXPORT_FORMATS: readonly ReportExportFormatInfo[] = [
  { format: 'csv', label: 'CSV', extension: 'csv', mimeType: 'text/csv' },
  { format: 'json', label: 'JSON', extension: 'json', mimeType: 'application/json' },
]

export function reportFormatInfo(format: ReportExportFormat): ReportExportFormatInfo {
  return (
    REPORT_EXPORT_FORMATS.find((candidate) => candidate.format === format) ??
    REPORT_EXPORT_FORMATS[0]
  )
}

/** Suggested file name — a new report file, never the source's name. */
export function reportFileName(format: ReportExportFormat): string {
  return `assay-validation-report.${reportFormatInfo(format).extension}`
}

/** Verdict-level metadata every export carries (self-describing file). */
export interface ReportExportMeta {
  readonly contractName: string
  readonly contractVersion: number
  readonly valid: boolean
  /**
   * True when the exported verdict was computed before the dataset's latest
   * edits (the panel's stale banner). Exports reflect exactly what is on
   * screen — including staleness — and say so.
   */
  readonly stale: boolean
  readonly datasetRows: number
}

/** One export row: the panel row's counts + its anchor-free sample lists. */
export interface ReportExportRow {
  readonly ruleId: string
  readonly column: string | null
  readonly rule: string
  readonly failCount: number
  readonly failPercent: number
  readonly samplesReturned: number
  readonly samplesComplete: boolean
  readonly sampleRowKeys: readonly string[]
  /** Typed wire values (raw in JSON; text-rendered + sanitized in CSV). */
  readonly sampleValues: readonly (string | number | boolean | null)[]
}

/** Project a report into export rows (severity order preserved). */
export function buildReportExportRows(report: ValidationReport): readonly ReportExportRow[] {
  return report.rows.map((row) => ({
    ruleId: row.ruleId,
    column: row.column,
    rule: row.kind,
    failCount: row.failCount,
    failPercent: row.failPercent,
    samplesReturned: row.samples.length,
    samplesComplete: row.samplesComplete,
    sampleRowKeys: row.samples.map((sample) => sample.exportKey),
    sampleValues: row.samples.map((sample) => sample.value),
  }))
}

/**
 * Formula-injection sanitization for scalar TEXT in the CSV report — the
 * client-side mirror of the engine's `formulaInjectionGuardSql` trigger set
 * (leading `=`, `+`, `-`, `@`, or any tab/CR ⇒ prefix an apostrophe). A
 * legitimate value that merely starts with `-` gains the prefix too — the
 * documented, accepted trade-off of the engine-side guard.
 */
export function csvFormulaSanitize(text: string): string {
  const triggers = ['=', '+', '-', '@']
  if (triggers.includes(text.charAt(0)) || text.includes('\t') || text.includes('\r')) {
    return `'${text}`
  }
  return text
}

/**
 * One sample value as JSON text for the CSV array cell: strings are
 * sanitized first (see {@link csvFormulaSanitize}), then JSON-escaped, so
 * type fidelity survives (999 stays a number, null stays null, a string
 * containing quotes/commas stays one value).
 */
function csvSampleValueJson(value: string | number | boolean | null): string {
  if (typeof value === 'string') return JSON.stringify(csvFormulaSanitize(value))
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

/** Quote one CSV cell when needed (RFC 4180: quote/double-quote). */
function csvCell(text: string): string {
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

const CSV_HEADER = [
  'rule_id',
  'column',
  'rule',
  'fail_count',
  'fail_percent',
  'dataset_rows',
  'valid',
  'stale',
  'samples_returned',
  'samples_complete',
  'sample_row_keys',
  'sample_values',
] as const

/** Build the CSV report bytes (UTF-8, CRLF-free, trailing newline). */
export function buildReportCsv(
  rows: readonly ReportExportRow[],
  meta: ReportExportMeta,
): Uint8Array<ArrayBuffer> {
  const lines: string[] = [CSV_HEADER.join(',')]
  for (const row of rows) {
    const cells = [
      row.ruleId,
      row.column ?? '',
      row.rule,
      String(row.failCount),
      String(row.failPercent),
      String(meta.datasetRows),
      meta.valid ? 'true' : 'false',
      meta.stale ? 'true' : 'false',
      String(row.samplesReturned),
      row.samplesComplete ? 'true' : 'false',
      `[${row.sampleRowKeys.map((key) => JSON.stringify(key)).join(',')}]`,
      `[${row.sampleValues.map(csvSampleValueJson).join(',')}]`,
    ]
    lines.push(cells.map(csvCell).join(','))
  }
  return new TextEncoder().encode(lines.join('\n') + '\n')
}

/** Build the JSON report bytes (2-space indent, trailing newline). */
export function buildReportJson(
  rows: readonly ReportExportRow[],
  meta: ReportExportMeta,
): Uint8Array<ArrayBuffer> {
  const payload = {
    report: 'assay-validation-report',
    contract: { name: meta.contractName, version: meta.contractVersion },
    valid: meta.valid,
    stale: meta.stale,
    datasetRows: meta.datasetRows,
    rules: rows.map((row) => ({
      ruleId: row.ruleId,
      column: row.column,
      rule: row.rule,
      failCount: row.failCount,
      failPercent: row.failPercent,
      samplesReturned: row.samplesReturned,
      samplesComplete: row.samplesComplete,
      sampleRowKeys: [...row.sampleRowKeys],
      sampleValues: [...row.sampleValues],
    })),
  }
  return new TextEncoder().encode(JSON.stringify(payload, null, 2) + '\n')
}

/** Build the report bytes for one format (see the module doc). */
export function buildReportBytes(
  format: ReportExportFormat,
  report: ValidationReport,
  meta: ReportExportMeta,
): Uint8Array<ArrayBuffer> {
  const rows = buildReportExportRows(report)
  return format === 'csv' ? buildReportCsv(rows, meta) : buildReportJson(rows, meta)
}

// ---------------------------------------------------------------------------
// Destination + delivery (the m4-5 patterns, specialized to the report)
// ---------------------------------------------------------------------------

/** Save-picker entry point, injectable so tests never open a native dialog. */
export type ShowReportSavePicker = (options: { suggestedName: string }) => Promise<ReportSaveHandle>

/**
 * The writable slice of a picked save handle — structurally the same seam
 * the m4-5 `SaveFileHandle` uses; the DOM `FileSystemFileHandle` satisfies
 * it (its writable accepts at least as much as this narrow shape).
 */
export interface ReportSaveHandle {
  createWritable(): Promise<ReportWritable>
}

export interface ReportWritable {
  write(chunk: Uint8Array<ArrayBuffer>): Promise<void>
  close(): Promise<void>
}

export interface RequestReportDestinationDeps {
  readonly capabilities?: ReturnType<typeof detectSaveCapabilities>
  readonly showSaveFilePicker?: ShowReportSavePicker
  /**
   * Opened-source identity for the same-source refusal — same rule as the
   * m4-5 dataset export: present only for FSA-opened sessions; absent means
   * identity cannot be proven, so the picker is never offered and delivery
   * rides the anchor download (fail-closed by construction).
   */
  readonly sourceIdentity?: { readonly isSameEntry: (other: FileSystemHandle) => Promise<boolean> }
}

/** True for the DOMException a dismissed save picker raises. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Acquire a destination for the report. Resolves `null` on a dismissed
 * picker; `{ via: 'refused-source' }` when the picker returned the opened
 * source's own entry (refused before any byte write — the report must never
 * replace anything, least of all the data it describes).
 */
export async function requestReportDestination(
  format: ReportExportFormat,
  deps: RequestReportDestinationDeps = {},
): Promise<SaveDestination | null> {
  if (deps.sourceIdentity === undefined) return { via: 'download' }
  const capabilities = deps.capabilities ?? detectSaveCapabilities()
  if (!capabilities.fileSavePicker) return { via: 'download' }
  const pick: ShowReportSavePicker =
    deps.showSaveFilePicker ??
    ((options) => showSaveFilePicker({ suggestedName: options.suggestedName }))
  try {
    const handle = await pick({ suggestedName: reportFileName(format) })
    let sameEntry: boolean
    try {
      sameEntry = await deps.sourceIdentity.isSameEntry(handle as unknown as FileSystemHandle)
    } catch {
      sameEntry = true // identity unprovable → fail closed (m4-5 discipline)
    }
    if (sameEntry) return { via: 'refused-source' }
    return { via: 'file-system-access', handle }
  } catch (error) {
    if (isAbortError(error)) return null
    throw error
  }
}

/**
 * Deliver report bytes to a resolved destination. FSA sessions get a direct
 * write to the picked handle; everything else rides the anchor download
 * (reusing the m4-5 delivery helper). Resolves the strategy actually used,
 * so the result line can say honestly where the report went.
 */
export async function writeReportCopy(
  destination: WritableSaveDestination,
  content: { readonly bytes: Uint8Array<ArrayBuffer>; readonly format: ReportExportFormat },
): Promise<SaveStrategy> {
  if (destination.via === 'file-system-access') {
    const writable = await destination.handle.createWritable()
    await writable.write(content.bytes)
    await writable.close()
    return 'file-system-access'
  }
  const info = reportFormatInfo(content.format)
  deliverReportDownload(
    new Blob([content.bytes], { type: info.mimeType }),
    reportFileName(content.format),
  )
  return 'download'
}

/**
 * Hidden-anchor download — the same delivery contract as the m4-5
 * `downloadBlob` (which stays private to its module for the dataset export
 * path): object URL revoked on a generous timer after the click, so the
 * browser has certainly finished reading the blob.
 */
function deliverReportDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  globalThis.setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 30_000)
}

/**
 * Honest result line for a delivered report. Counts are the export's own
 * (rule count), never estimated; both delivery strategies are unambiguously
 * NEW files and the line says the opened file is unchanged (the m4-5 copy
 * rule — a report export can no more rewrite the source than a dataset
 * export could).
 */
export function reportExportSuccessMessage(
  ruleCount: number,
  format: ReportExportFormat,
  strategy: SaveStrategy,
): string {
  const info = reportFormatInfo(format)
  const head = `Exported the failure report (${String(ruleCount)} rules) as ${info.label}`
  const where =
    strategy === 'file-system-access'
      ? 'to a new file.'
      : '— your browser is downloading it as a new file.'
  return `${head} ${where} The opened file is unchanged.`
}

export const REPORT_EXPORT_CANCELLED_MESSAGE =
  'Export cancelled — no new file was written, and the opened file is unchanged.'

export const REPORT_EXPORT_SAME_SOURCE_MESSAGE =
  'That is the opened file — writing the report there would change the source. ' +
  'Choose a different name or location. Nothing was written, and the opened file is unchanged.'

/**
 * Failure line for any report-export step. Always states that nothing was
 * written and the source is unchanged. The raw error text is reduced to its
 * first line and never echoed when empty (the m4-5 `exportErrorSummary`
 * discipline — engine errors can carry SQL across further lines).
 */
export function reportExportFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const summary = raw.split('\n')[0]?.trim() ?? ''
  return (
    `Export failed: ${summary === '' ? 'the report could not be written' : summary}. ` +
    'No file was written, and the opened file is unchanged.'
  )
}
