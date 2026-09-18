/**
 * Export format vocabulary (m4-5) — the exact set the merged engine surface
 * (`EngineExportFormat`, m4-2) can materialize. This module is pure display
 * metadata: which label to show, which extension the engine appends, and the
 * MIME type the download fallback hands the browser.
 *
 * Privacy (ADR 0025): labels/extensions are format vocabulary only — never
 * derived from the opened file's name.
 */
import type { EngineExportFormat } from '@assay/engine-duckdb'

/** Display metadata for one export format. */
export interface ExportFormatInfo {
  readonly format: EngineExportFormat
  readonly label: string
  /** Extension the engine appends to the generated scratch path. */
  readonly extension: string
  readonly mimeType: string
  /** One honest line about what the format preserves. */
  readonly description: string
}

/**
 * The engine's formats, in a stable display order. `arrow` is an Arrow IPC
 * *file* (`application/vnd.apache.arrow.file`), assembled worker-side because
 * the bundled DuckDB-WASM build has no Arrow COPY writer (m4-2).
 */
export const EXPORT_FORMATS: readonly ExportFormatInfo[] = [
  {
    format: 'parquet',
    label: 'Parquet',
    extension: 'parquet',
    mimeType: 'application/vnd.apache.parquet',
    description: 'Columnar binary; preserves column types exactly.',
  },
  {
    format: 'csv',
    label: 'CSV',
    extension: 'csv',
    mimeType: 'text/csv',
    description:
      'Text table; cells that could start a spreadsheet formula get a leading apostrophe.',
  },
  {
    format: 'jsonl',
    label: 'JSON Lines',
    extension: 'jsonl',
    mimeType: 'application/x-ndjson',
    description: 'One JSON object per line; values are written as they are.',
  },
  {
    format: 'json',
    label: 'JSON',
    extension: 'json',
    mimeType: 'application/json',
    description: 'A single JSON array; values are written as they are.',
  },
  {
    format: 'arrow',
    label: 'Arrow IPC',
    extension: 'arrow',
    mimeType: 'application/vnd.apache.arrow.file',
    description: 'An Arrow IPC file; values and types are written as they are.',
  },
]

/** Look up display metadata for an engine format. Total (falls back to the raw name). */
export function exportFormatInfo(format: EngineExportFormat): ExportFormatInfo {
  const info = EXPORT_FORMATS.find((candidate) => candidate.format === format)
  if (info !== undefined) return info
  // Defensive: the map covers the engine's union, so this is unreachable for a
  // typed caller — keep the fallback total rather than throwing in render.
  return {
    format,
    label: format,
    extension: format,
    mimeType: 'application/octet-stream',
    description: '',
  }
}
