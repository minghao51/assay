// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Dataset-file format detection from file names.
 *
 * Deliberately extension-based only: reading bytes to sniff a format would
 * mean loading (parts of) the dataset before the user has chosen to open it,
 * and `metadata()` must stay cheap (dispatch M1-3). Anything that does not
 * match a known extension is reported as `'unknown'` — sources stay
 * permissive; engines/validators decide later whether they can read a file.
 */

/** Canonical dataset formats Assay recognizes by file-name extension. */
export type DatasetFileFormat =
  'parquet' | 'jsonl' | 'json' | 'csv' | 'arrow' | 'feather' | 'unknown'

const FORMAT_BY_EXTENSION: Readonly<Record<string, DatasetFileFormat>> = {
  parquet: 'parquet',
  jsonl: 'jsonl',
  json: 'json',
  csv: 'csv',
  arrow: 'arrow',
  feather: 'feather',
}

/**
 * Detect the dataset format from a file name (case-insensitive extension).
 *
 * Rules: only the last extension is considered (`a.b.csv` → `'csv'`);
 * dot-files without a real extension (`.gitignore`) and names ending in a
 * dot (`data.`) are `'unknown'`; compressed names (`data.parquet.gz`) are
 * `'unknown'` — decompression is a later, explicit feature.
 */
export function detectFormatFromFileName(fileName: string): DatasetFileFormat {
  const lastDot = fileName.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === fileName.length - 1) {
    return 'unknown'
  }
  const extension = fileName.slice(lastDot + 1).toLowerCase()
  return FORMAT_BY_EXTENSION[extension] ?? 'unknown'
}
