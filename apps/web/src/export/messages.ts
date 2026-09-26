// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Honest, text-only export messaging (m4-5). Kept pure and Node-tested so the
 * wording — especially the ADR 0012 copy-vs-rewrite distinction — is pinned
 * independently of the React component.
 *
 * Rules encoded here:
 * - the opened source file is **never** modified; the result line always says
 *   so ("The opened file is unchanged") and never uses "overwrite", "save in
 *   place", or "update" language;
 * - the numbers shown come from the engine's returned `{ format, rowCount,
 *   bytes }` (m4-2) — nothing is estimated;
 * - failures are readable summaries, never raw multi-line engine SQL text.
 */
import type { EngineExportFormat, EngineExportResult } from '@assay/engine-duckdb'
import { exportFormatInfo } from './formats'
import type { SaveStrategy } from './save-destination'

/** The writable suffix used when bytes could not be saved. */
const UNKNOWN_SIZE = 'unknown size'

/**
 * Render a byte count for humans. Binary units; one decimal for KB+. Total:
 * non-finite/negative input renders `unknown size` rather than a lie.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return UNKNOWN_SIZE
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/** Pluralize a row count honestly ("1 row" / "6 rows"). */
export function formatRowCount(rowCount: number): string {
  const safe = Number.isFinite(rowCount) && rowCount >= 0 ? Math.floor(rowCount) : 0
  return `${String(safe)} ${safe === 1 ? 'row' : 'rows'}`
}

/**
 * Success line for one completed export. `strategy` distinguishes a file the
 * user chose through the File System Access picker from a browser download;
 * both are unambiguously **new files** and say the source is unchanged.
 */
export function exportSuccessMessage(result: EngineExportResult, strategy: SaveStrategy): string {
  const info = exportFormatInfo(result.format)
  const head = `Exported ${formatRowCount(result.rowCount)} as ${info.label} (${formatBytes(result.bytes)})`
  const where =
    strategy === 'file-system-access'
      ? 'to a new file.'
      : '— your browser is downloading it as a new file.'
  return `${head} ${where} The opened file is unchanged.`
}

/**
 * Formats the engine's open flow can actually read back
 * (`engine-duckdb` opens `.parquet`, `.csv`, `.jsonl` and `.json` — an
 * exported `.arrow` is rejected with "unsupported dataset format"). Only
 * these formats may suggest the re-open journey; suggesting it for arrow
 * promised a journey the app cannot deliver (m4-5 review finding).
 */
const REOPENABLE_FORMATS: readonly EngineExportFormat[] = ['parquet', 'csv', 'jsonl', 'json']

/**
 * The guidance shown under a successful export, per format. For the formats
 * the engine can read back, the normal open flow is the re-open journey. For
 * everything else (arrow today), the text must not promise a re-open: it
 * names the file an interchange format for other tools and states what the
 * app does open, so the guidance is never false.
 */
export function exportReopenGuidance(format: EngineExportFormat): string {
  if (REOPENABLE_FORMATS.includes(format)) {
    return 'To view it here, use “Open a data file…” and choose the file you wrote.'
  }
  const info = exportFormatInfo(format)
  return `${info.label} is an interchange format for other tools; Assay opens .parquet, .csv, .jsonl and .json files.`
}

/**
 * Same-source refusal (m4-5 fix round): the save picker returned the opened
 * file's own entry. The dialog shows this instead of doing any engine work
 * or byte write — writing an export to the opened file is exactly the
 * in-place rewrite ADR 0012 forbids, whatever the format.
 */
export const EXPORT_SAME_SOURCE_MESSAGE =
  'That is the opened file — writing the copy there would change the source. Choose a different name or location. Nothing was written, and the opened file is unchanged.'

/** Cancelled-save line: nothing was written, and the app stays usable. */
export const EXPORT_CANCELLED_MESSAGE =
  'Export cancelled — no new file was written, and the opened file is unchanged.'

/**
 * The extra honesty note describing how the current grid view differs from
 * what the copy holds, or `null` when the grid shows the dataset as-is (the
 * base line already covers that). Filtering and sorting are tracked
 * separately (m4-5 fix round 2): a sort-only view used to be told it saw a
 * "filtered/sorted subset" and referred to filters that do not exist. Each
 * state describes only what is actually active:
 *
 * - filter-only → a filtered subset; the copy ignores the view's filters;
 * - sort-only → the sorting is not applied to the copy (filters unmentioned);
 * - both → the filtered/sorted subset wording.
 */
export function exportViewSubsetNote(viewFiltered: boolean, viewSorted: boolean): string | null {
  if (viewFiltered && viewSorted) {
    return 'The grid currently shows a filtered/sorted subset of those rows; the copy ignores the view’s filters and sorting and contains every row.'
  }
  if (viewFiltered) {
    return 'The grid currently shows a filtered subset of those rows; the copy ignores the view’s filters and contains every row.'
  }
  if (viewSorted) {
    return 'The grid is currently sorted; that sorting is not applied to the copy — it contains every row in natural order.'
  }
  return null
}

/**
 * The opaque emscripten glue error the mvp DuckDB-WASM bundle can surface
 * (documented in `edit/session.ts`): not a readable message, so it degrades to
 * the caller's neutral fallback.
 */
const OPAQUE_GLUE_ERROR = /^_setThrew\b/

/**
 * First (summary) line of an export failure, text-only. The engine's export
 * errors carry the composed SQL across further lines; only the summary is
 * shown (the rest can echo dataset values and is not something the user asked
 * to see, ADR 0025). Never logged.
 */
export function exportErrorSummary(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const summary = raw.split('\n')[0]?.trim() ?? ''
  if (summary === '' || OPAQUE_GLUE_ERROR.test(summary)) {
    return 'the engine could not write the copy'
  }
  return summary
}

/**
 * Failure line for any export step (engine rejection, OPFS read/write, a save
 * picker that errored rather than being cancelled). Always states that the
 * opened source is unchanged, so a failure can never read as a partial write
 * to the source (ADR 0012).
 */
export function exportFailureMessage(error: unknown): string {
  return `Export failed: ${exportErrorSummary(error)}. No copy was written, and the opened file is unchanged.`
}
