// SPDX-License-Identifier: AGPL-3.0-or-later

/** Dataset formats accepted by the desktop bridge. */
export type DatasetFormat = 'parquet' | 'csv' | 'jsonl' | 'json' | 'arrow'

/** The filename patterns contributed by the custom editor. */
export const SUPPORTED_FILENAME_PATTERNS: readonly string[] = [
  '*.parquet',
  '*.csv',
  '*.jsonl',
  '*.ndjson',
  '*.json',
  '*.arrow',
  '*.feather',
  '*.ipc',
]

const SUPPORTED_EXTENSIONS: ReadonlyMap<string, DatasetFormat> = new Map([
  ['.parquet', 'parquet'],
  ['.csv', 'csv'],
  ['.jsonl', 'jsonl'],
  ['.ndjson', 'jsonl'],
  ['.json', 'json'],
  ['.arrow', 'arrow'],
  ['.feather', 'arrow'],
  ['.ipc', 'arrow'],
])

/** Return only a format-derived filename; caller-supplied names never pass through. */
export function neutralDatasetName(format: DatasetFormat): string {
  return `dataset.${format}`
}

/** Map a file name to its supported dataset format, or undefined. */
export function formatFromName(name: string): DatasetFormat | undefined {
  const lower = name.toLowerCase()
  for (const [extension, format] of SUPPORTED_EXTENSIONS) {
    if (lower.endsWith(extension)) {
      return format
    }
  }
  return undefined
}
