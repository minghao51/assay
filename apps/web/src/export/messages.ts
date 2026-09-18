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
import type { EngineExportResult } from '@assay/engine-duckdb'
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

/** Cancelled-save line: nothing was written, and the app stays usable. */
export const EXPORT_CANCELLED_MESSAGE =
  'Export cancelled — no new file was written, and the opened file is unchanged.'

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
