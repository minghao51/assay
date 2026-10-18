// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Diff report export (m6-4) — the pure CSV/JSON report builders plus the
 * destination/delivery glue, mirroring the m5-3 failure-report export and the
 * m4-5 export UX patterns (`../export/save-destination`).
 *
 * ## Report shape (documented; pinned by unit tests and the export e2e)
 *
 * The report is the on-screen report, verbatim: every schema-drift finding,
 * every column's rounded distribution metrics, and the row diff's exact
 * counts with its bounded samples, in the documented aspect order **schema
 * drift → profile deltas → row diff**. The JSON envelope deliberately mirrors
 * the CLI's `assay diff --format json` reference shape field-for-field where
 * a field is meaningful on this surface (m6-5 compares them):
 *
 *     report:               'assay-diff-report' (the format marker)
 *     baseViewOnly:         side A was the plain base view (no overlay ops)
 *     stale:                the row diff predates the latest dataset edits
 *     keys / keySource:     the resolved key set and how it was chosen
 *     inference:            the C2 disclosure (null for explicit keys)
 *     sampleLimit*:         requested K and the engine-clamped effective K
 *     schemaDrift[]:        aspect 1, the model's documented order
 *     columnDeltas[]:       aspect 2, profile-A column order, rounded
 *     rowDiff:              aspect 3 (counts + bounded samples)
 *     issues[]:             collected input issues (empty for well-formed)
 *     identical:            the verdict across the aspects that ran
 *
 * The web envelope differs from the CLI's in exactly two documented ways: it
 * carries **no file names** (ADR 0025 — the panel never names either file)
 * and it carries `stale` (the m5-3 freshness rule). Row-diff sample keys are
 * the anchor-free `base:<ordinal>` / `insert:<seq>` / `b:<ordinal>` forms —
 * the host's anchor fingerprint never leaves the app.
 *
 * ## Delivery (always a NEW file)
 *
 * The report is a report — never a rewrite of anything (ADR 0012). Delivery
 * reuses the m4-5 save-destination shape: the File System Access save picker
 * when a retained source identity can prove the picked destination is not the
 * opened source (same-entry → refused before any byte write), otherwise the
 * anchor-download fallback. An input-fallback session (no provable identity)
 * is download-only by construction. The result lines always say the opened
 * file is unchanged and use no banned overwrite/in-place language.
 */
import {
  projectAspect,
  projectColumnDelta,
  projectInference,
  projectIssue,
  projectSchemaFinding,
  roundReportMetric,
} from '@assay/diff'
import type {
  SaveDestination,
  SaveStrategy,
  WritableSaveDestination,
} from '../export/save-destination'
import { detectSaveCapabilities } from '../export/save-destination'
import type { DiffPanelReport, DiffSampleView } from './diff-model'

/** The two report formats. */
export type DiffReportFormat = 'csv' | 'json'

export interface DiffReportFormatInfo {
  readonly format: DiffReportFormat
  readonly label: string
  readonly extension: string
  readonly mimeType: string
}

export const DIFF_REPORT_FORMATS: readonly DiffReportFormatInfo[] = [
  { format: 'json', label: 'JSON', extension: 'json', mimeType: 'application/json' },
  { format: 'csv', label: 'CSV', extension: 'csv', mimeType: 'text/csv' },
]

export function diffReportFormatInfo(format: DiffReportFormat): DiffReportFormatInfo {
  return (
    DIFF_REPORT_FORMATS.find((candidate) => candidate.format === format) ?? DIFF_REPORT_FORMATS[0]
  )
}

/** Suggested file name — a new report file, never either source's name. */
export function diffReportFileName(format: DiffReportFormat): string {
  return `assay-diff-report.${diffReportFormatInfo(format).extension}`
}

/** Export-level metadata every report carries (self-describing file). */
export interface DiffReportExportMeta {
  /**
   * True when the exported row diff was computed before the dataset's latest
   * edits (the panel's stale banner). Exports reflect exactly what is on
   * screen — including staleness — and say so.
   */
  readonly stale: boolean
}

/** Adapt a rendered web sample to the shared JSON projector's input shape. */
function projectExportSample(sample: DiffSampleView) {
  return { side: sample.side, exportKey: sample.exportKey, changedColumns: sample.changedColumns }
}

/** The `--format json`-shaped envelope (see the module doc). */
export function buildDiffReportJson(
  report: DiffPanelReport,
  meta: DiffReportExportMeta,
): Uint8Array<ArrayBuffer> {
  const payload = {
    report: 'assay-diff-report',
    baseViewOnly: report.baseViewOnly,
    stale: meta.stale,
    keys: [...report.keys],
    keySource: report.keySource,
    inference: projectInference(report.inference),
    sampleLimitRequested: report.sampleLimitRequested,
    sampleLimitEffective: report.sampleLimitEffective,
    schemaDrift: report.drift.map(projectSchemaFinding),
    columnDeltas: report.deltas.map(projectColumnDelta),
    rowDiff: {
      rowCountA: report.rowCountA,
      rowCountB: report.rowCountB,
      changedComparable: report.changedComparable,
      added: projectAspect({
        ...report.added,
        samples: report.added.samples.map(projectExportSample),
      }),
      removed: projectAspect({
        ...report.removed,
        samples: report.removed.samples.map(projectExportSample),
      }),
      changed: projectAspect({
        ...report.changed,
        samples: report.changed.samples.map(projectExportSample),
      }),
    },
    issues: report.issues.map(projectIssue),
    identical: report.identical,
  }
  return new TextEncoder().encode(JSON.stringify(payload, null, 2) + '\n')
}

/**
 * Formula-injection sanitization for scalar TEXT in the CSV report — the
 * client-side mirror of the engine's `formulaInjectionGuardSql` trigger set
 * (leading `=`, `+`, `-`, `@`, or any tab/CR ⇒ prefix an apostrophe). A
 * value that merely starts with `-` gains the prefix too — the documented,
 * accepted trade-off of the engine-side guard.
 */
export function csvFormulaSanitize(text: string): string {
  const triggers = ['=', '+', '-', '@']
  if (triggers.includes(text.charAt(0)) || text.includes('\t') || text.includes('\r')) {
    return `'${text}`
  }
  return text
}

/** Quote one CSV cell when needed (RFC 4180: quote/double-quote). */
function csvCell(text: string): string {
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

/** One CSV cell value: strings are formula-sanitized; numbers/booleans stay raw. */
type CsvCell = string | number | boolean | null | undefined

/**
 * One CSV row. Only **string** cells are formula-sanitized (the m5-3
 * `report-export.ts` split): numeric metrics must stay numbers — a
 * sanitized `-0.5059…` would be prefixed with an apostrophe and exported as
 * text, corrupting every negative metric (AR-W3).
 */
function csvRow(cells: readonly CsvCell[]): string {
  return cells
    .map((cell) => {
      if (typeof cell === 'string') return csvCell(csvFormulaSanitize(cell))
      if (cell === null || cell === undefined) return ''
      return csvCell(String(cell))
    })
    .join(',')
}

const CSV_HEADER = ['section', 'column', 'kind', 'field', 'value'] as const

/** A JSON-array TEXT field for the CSV long format. */
function listText(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(csvFormulaSanitize(value))).join(',')}]`
}

/**
 * The CSV report — a flat, long-format rendering of the same report the JSON
 * carries (one `section,column,kind,field,value` row per reported datum), so
 * a spreadsheet user can pivot it. Every string field is
 * formula-injection-sanitized. The exact counts appear once per aspect.
 */
export function buildDiffReportCsv(
  report: DiffPanelReport,
  meta: DiffReportExportMeta,
): Uint8Array<ArrayBuffer> {
  const lines: string[] = [CSV_HEADER.join(',')]
  for (const finding of report.drift) {
    const fields: [string, CsvCell][] = [
      ['kind', finding.kind],
      ['typeA', finding.typeA ?? null],
      ['typeB', finding.typeB ?? null],
      ['familyA', finding.familyA ?? null],
      ['familyB', finding.familyB ?? null],
      ['nullShareA', roundReportMetric(finding.nullShareA)],
      ['nullShareB', roundReportMetric(finding.nullShareB)],
    ]
    for (const [field, value] of fields) {
      lines.push(csvRow(['schema-drift', finding.column, 'finding', field, value]))
    }
  }
  for (const delta of report.deltas) {
    const numeric = delta.numeric
    if (numeric !== undefined) {
      lines.push(
        csvRow([
          'column-delta',
          delta.column,
          'numeric',
          'meanShiftStandardized',
          roundReportMetric(numeric.meanShiftStandardized),
        ]),
      )
      lines.push(
        csvRow([
          'column-delta',
          delta.column,
          'numeric',
          'varianceShiftStandardized',
          roundReportMetric(numeric.varianceShiftStandardized),
        ]),
      )
      lines.push(
        csvRow([
          'column-delta',
          delta.column,
          'numeric',
          'p50Shift',
          roundReportMetric(numeric.p50Shift),
        ]),
      )
      lines.push(
        csvRow([
          'column-delta',
          delta.column,
          'numeric',
          'p90Shift',
          roundReportMetric(numeric.p90Shift),
        ]),
      )
    }
    const categorical = delta.categorical
    if (categorical !== undefined) {
      lines.push(
        csvRow([
          'column-delta',
          delta.column,
          'categorical',
          'totalVariation',
          roundReportMetric(categorical.totalVariation),
        ]),
      )
      lines.push(
        csvRow([
          'column-delta',
          delta.column,
          'categorical',
          'newCategories',
          listText(categorical.newCategories.map((entry) => entry.value)),
        ]),
      )
      lines.push(
        csvRow([
          'column-delta',
          delta.column,
          'categorical',
          'vanishedCategories',
          listText(categorical.vanishedCategories.map((entry) => entry.value)),
        ]),
      )
    }
  }
  for (const [kind, aspect] of [
    ['added', report.added],
    ['removed', report.removed],
    ['changed', report.changed],
  ] as const) {
    lines.push(csvRow(['row-diff', '', kind, 'count', aspect.count]))
    lines.push(csvRow(['row-diff', '', kind, 'samplesReturned', aspect.samplesReturned]))
    lines.push(csvRow(['row-diff', '', kind, 'samplesComplete', aspect.samplesComplete]))
    for (const sample of aspect.samples) {
      lines.push(csvRow(['row-diff-sample', '', kind, 'rowKey', sample.exportKey]))
      if (sample.changedColumns !== null) {
        lines.push(
          csvRow(['row-diff-sample', '', kind, 'changedColumns', listText(sample.changedColumns)]),
        )
      }
    }
  }
  lines.push(csvRow(['verdict', '', '', 'keys', listText(report.keys)]))
  lines.push(csvRow(['verdict', '', '', 'keySource', report.keySource]))
  lines.push(csvRow(['verdict', '', '', 'identical', report.identical]))
  lines.push(csvRow(['verdict', '', '', 'stale', meta.stale]))
  return new TextEncoder().encode(lines.join('\n') + '\n')
}

/** Build the report bytes for one format (see the module doc). */
export function buildDiffReportBytes(
  format: DiffReportFormat,
  report: DiffPanelReport,
  meta: DiffReportExportMeta,
): Uint8Array<ArrayBuffer> {
  return format === 'csv' ? buildDiffReportCsv(report, meta) : buildDiffReportJson(report, meta)
}

// ---------------------------------------------------------------------------
// Destination + delivery (the m4-5 patterns, specialized to the diff report)
// ---------------------------------------------------------------------------

/** Save-picker entry point, injectable so tests never open a native dialog. */
export type ShowDiffReportSavePicker = (options: {
  suggestedName: string
}) => Promise<DiffReportSaveHandle>

/** The writable slice of a picked save handle (DOM FileSystemFileHandle satisfies it). */
export interface DiffReportSaveHandle {
  createWritable(): Promise<DiffReportWritable>
}

export interface DiffReportWritable {
  write(chunk: Uint8Array<ArrayBuffer>): Promise<void>
  close(): Promise<void>
}

export interface RequestDiffReportDestinationDeps {
  readonly capabilities?: ReturnType<typeof detectSaveCapabilities>
  readonly showSaveFilePicker?: ShowDiffReportSavePicker
  /**
   * Opened-source identity for the same-source refusal — the m4-5 rule:
   * present only for FSA-opened sessions; absent means identity cannot be
   * proven, so the picker is never offered and delivery rides the anchor
   * download (fail-closed by construction).
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
export async function requestDiffReportDestination(
  format: DiffReportFormat,
  deps: RequestDiffReportDestinationDeps = {},
): Promise<SaveDestination | null> {
  if (deps.sourceIdentity === undefined) return { via: 'download' }
  const capabilities = deps.capabilities ?? detectSaveCapabilities()
  if (!capabilities.fileSavePicker) return { via: 'download' }
  const pick: ShowDiffReportSavePicker =
    deps.showSaveFilePicker ??
    ((options) => showSaveFilePicker({ suggestedName: options.suggestedName }))
  try {
    const handle = await pick({ suggestedName: diffReportFileName(format) })
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
 * (the m4-5 delivery helper's contract). Resolves the strategy actually
 * used, so the result line can say honestly where the report went.
 */
export async function writeDiffReportCopy(
  destination: WritableSaveDestination,
  content: { readonly bytes: Uint8Array<ArrayBuffer>; readonly format: DiffReportFormat },
): Promise<SaveStrategy> {
  if (destination.via === 'file-system-access') {
    const writable = await destination.handle.createWritable()
    await writable.write(content.bytes)
    await writable.close()
    return 'file-system-access'
  }
  const info = diffReportFormatInfo(content.format)
  deliverDownload(
    new Blob([content.bytes], { type: info.mimeType }),
    diffReportFileName(content.format),
  )
  return 'download'
}

/**
 * Hidden-anchor download — the same delivery contract as the m4-5
 * `downloadBlob`: object URL revoked on a generous timer after the click, so
 * the browser has certainly finished reading the blob.
 */
function deliverDownload(blob: Blob, fileName: string): void {
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
 * (finding / delta / row-diff totals), never estimated; both delivery
 * strategies are unambiguously NEW files and the line says the opened file is
 * unchanged (the m4-5 copy rule — a report export can no more rewrite the
 * source than a dataset export could).
 */
export function diffExportSuccessMessage(
  report: DiffPanelReport,
  format: DiffReportFormat,
  strategy: SaveStrategy,
): string {
  const info = diffReportFormatInfo(format)
  const head =
    `Exported the diff report (${String(report.drift.length)} schema findings, ` +
    `${String(report.deltas.length)} columns, ` +
    `${String(report.added.count)} added / ${String(report.removed.count)} removed / ` +
    `${String(report.changed.count)} changed rows) as ${info.label}`
  const where =
    strategy === 'file-system-access'
      ? 'to a new file.'
      : '— your browser is downloading it as a new file.'
  return `${head} ${where} The opened file is unchanged.`
}

export const DIFF_EXPORT_CANCELLED_MESSAGE =
  'Export cancelled — no new file was written, and the opened file is unchanged.'

export const DIFF_EXPORT_SAME_SOURCE_MESSAGE =
  'That is the opened file — writing the report there would change the source. ' +
  'Choose a different name or location. Nothing was written, and the opened file is unchanged.'

/**
 * Failure line for any report-export step. Always states that nothing was
 * written and the source is unchanged. The raw error text is reduced to its
 * first line and never echoed when empty (the m4-5 `exportErrorSummary`
 * discipline — engine errors can carry SQL across further lines).
 */
export function diffExportFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const summary = raw.split('\n')[0]?.trim() ?? ''
  return (
    `Export failed: ${summary === '' ? 'the report could not be written' : summary}. ` +
    'No file was written, and the opened file is unchanged.'
  )
}
