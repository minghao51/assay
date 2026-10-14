// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  formatFromName,
  neutralDatasetName,
  SUPPORTED_FILENAME_PATTERNS,
  type DatasetFormat,
} from './dataset-format'

const aliases: readonly (readonly [string, DatasetFormat])[] = [
  ['events.parquet', 'parquet'],
  ['events.CSV', 'csv'],
  ['events.jsonl', 'jsonl'],
  ['events.NDJSON', 'jsonl'],
  ['events.json', 'json'],
  ['events.arrow', 'arrow'],
  ['events.FEATHER', 'arrow'],
  ['events.ipc', 'arrow'],
]

describe('desktop dataset format bridge', () => {
  it.each(aliases)(
    'maps %s to %s case-insensitively',
    (filename: string, format: DatasetFormat) => {
      expect(formatFromName(filename)).toBe(format)
    },
  )

  it('returns undefined for unsupported filenames and extensions', () => {
    expect(formatFromName('notes.txt')).toBeUndefined()
    expect(formatFromName('events.parquet.bak')).toBeUndefined()
    expect(formatFromName('parquet')).toBeUndefined()
  })

  it('uses a neutral engine-detectable name and never retains the source name', () => {
    for (const format of ['parquet', 'csv', 'jsonl', 'json', 'arrow'] as const) {
      expect(neutralDatasetName(format)).toBe(`dataset.${format}`)
    }
    expect(neutralDatasetName('arrow')).not.toContain('events')
  })

  it('keeps contributed editor patterns in sync with supported aliases', () => {
    expect(SUPPORTED_FILENAME_PATTERNS).toEqual(
      aliases.map(([name]) => `*.${name.split('.').pop()!.toLowerCase()}`),
    )
  })
})
