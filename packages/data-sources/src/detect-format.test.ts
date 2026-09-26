// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'vitest'
import { detectFormatFromFileName } from './detect-format'

describe('detectFormatFromFileName', () => {
  test('maps every supported extension to its canonical format', () => {
    const cases: Array<[string, string]> = [
      ['data.parquet', 'parquet'],
      ['events.jsonl', 'jsonl'],
      ['config.json', 'json'],
      ['customers.csv', 'csv'],
      ['metrics.arrow', 'arrow'],
      ['table.feather', 'feather'],
    ]
    for (const [name, expected] of cases) {
      expect(detectFormatFromFileName(name), name).toBe(expected)
    }
  })

  test('is case-insensitive and only looks at the last extension', () => {
    expect(detectFormatFromFileName('DATA.PARQUET')).toBe('parquet')
    expect(detectFormatFromFileName('My-Table.CsV')).toBe('csv')
    expect(detectFormatFromFileName('2026.01.events.jsonl')).toBe('jsonl')
    expect(detectFormatFromFileName('archive.bak.csv')).toBe('csv')
  })

  test('reports unknown for missing, empty, or unrecognized extensions', () => {
    expect(detectFormatFromFileName('README')).toBe('unknown')
    expect(detectFormatFromFileName('.gitignore')).toBe('unknown') // dot-file, not an extension
    expect(detectFormatFromFileName('data.')).toBe('unknown') // trailing dot
    expect(detectFormatFromFileName('blob.bin')).toBe('unknown')
    // Compressed names are unknown until decompression exists as a feature.
    expect(detectFormatFromFileName('data.parquet.gz')).toBe('unknown')
  })
})
