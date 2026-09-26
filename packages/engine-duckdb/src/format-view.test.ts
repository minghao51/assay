// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  createViewSql,
  detectFileFormat,
  fileScanSql,
  quotedIdentifier,
  sqlStringLiteral,
} from './format-view'

describe('detectFileFormat (extension → DuckDB reader selection)', () => {
  it('maps the supported extensions case-insensitively', () => {
    expect(detectFileFormat('a.parquet')).toBe('parquet')
    expect(detectFileFormat('B.PARQUET')).toBe('parquet')
    expect(detectFileFormat('a.csv')).toBe('csv')
    expect(detectFileFormat('a.jsonl')).toBe('jsonl')
    expect(detectFileFormat('a.json')).toBe('json')
    expect(detectFileFormat('multi.part.name.CSV')).toBe('csv')
  })

  it('returns null for unknown, extension-less, and dot-file names', () => {
    expect(detectFileFormat('a.arrow')).toBeNull() // deferred, not silently wrong
    expect(detectFileFormat('a.feather')).toBeNull()
    expect(detectFileFormat('a.parquet.gz')).toBeNull() // compressed: later, explicit feature
    expect(detectFileFormat('blob.bin')).toBeNull()
    expect(detectFileFormat('noextension')).toBeNull()
    expect(detectFileFormat('.gitignore')).toBeNull()
    expect(detectFileFormat('trailing.')).toBeNull()
    expect(detectFileFormat('')).toBeNull()
  })
})

describe('SQL string building (engine-generated names only, but safe for any input)', () => {
  it('escapes identifiers and string literals', () => {
    expect(quotedIdentifier('plain')).toBe('"plain"')
    expect(quotedIdentifier('has "quote"')).toBe('"has ""quote"""')
    expect(sqlStringLiteral('plain')).toBe("'plain'")
    expect(sqlStringLiteral("it's")).toBe("'it''s'")
  })

  it('selects the lazy reader per format', () => {
    expect(fileScanSql('t1', 'parquet')).toBe("read_parquet('t1')")
    expect(fileScanSql('t2', 'csv')).toBe("read_csv('t2')")
    expect(fileScanSql('t3', 'jsonl')).toBe("read_json_auto('t3', format = 'newline_delimited')")
    expect(fileScanSql('t4', 'json')).toBe("read_json_auto('t4')")
  })

  it('builds a view bound to the generated names', () => {
    expect(createViewSql('assay_t1', 't1', 'parquet')).toBe(
      'CREATE VIEW "assay_t1" AS SELECT * FROM read_parquet(\'t1\')',
    )
    expect(createViewSql('assay_t2', 't2', 'jsonl')).toBe(
      "CREATE VIEW \"assay_t2\" AS SELECT * FROM read_json_auto('t2', format = 'newline_delimited')",
    )
  })
})
