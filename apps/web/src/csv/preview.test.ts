// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type { EngineCsvPreviewResult, EngineCsvSniff } from '@assay/engine-duckdb'
import type { ArrowTableLike } from '../grid/provider'
import {
  disclosureColumns,
  displayBoolean,
  displayDialect,
  displayNullableText,
  formatSampleCell,
  projectSampleBatch,
  toPreviewView,
} from './preview'

/**
 * EW-03I-b — the preview projection.
 *
 * The pins here are the honesty ones: the applied cap travels from the response
 * (never a local guess), a NULL cell reads as NULL instead of a blank, a
 * row/column disagreement between the batch and the disclosure withholds the
 * sample instead of drawing invented headers, and the display helpers make an
 * "unset" dialect string visible rather than blank.
 */

const SNIFF: EngineCsvSniff = {
  delimiter: ';',
  quote: '"',
  escape: '',
  newLineDelimiter: '\n',
  comment: '',
  skipRows: 0,
  hasHeader: true,
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'note', type: 'VARCHAR' },
    { name: 'amount', type: 'DOUBLE' },
  ],
  dateFormat: null,
  timestampFormat: null,
  prompt: "read_csv('preview_p1', delim = ';')",
}

/**
 * A structural Arrow batch: `columns` is one value per column, `get(index)`
 * returns that column's value for the row (a `null` entry is an Arrow NULL).
 */
function batch(columns: readonly (readonly unknown[])[]): ArrowTableLike {
  return {
    numRows: columns[0]?.length ?? 0,
    numCols: columns.length,
    getChildAt: (index: number) => {
      const values = columns[index]
      if (values === undefined) return null
      return { get: (rowIndex: number) => values[rowIndex] }
    },
  }
}

/** The real sample batch type (an `apache-arrow` `Table`). */
type SampleBatch = NonNullable<EngineCsvPreviewResult['sample']>['batch']

/**
 * A matrix double for the sample batch. The app deliberately keeps
 * `apache-arrow` out of its dependency tree (the projector reads only
 * `numRows`/`numCols`/`getChildAt`, the slice `ArrowTableLike` names), so the
 * test double is that same structural slice and the cast is confined here.
 */
function sampleBatch(columns: readonly (readonly unknown[])[]): SampleBatch {
  return batch(columns) as unknown as SampleBatch
}

function result(patch: Partial<EngineCsvPreviewResult> = {}): EngineCsvPreviewResult {
  return {
    previewId: 'p1',
    sniff: SNIFF,
    effectiveOptions: {},
    sample: {
      batch: sampleBatch([
        [1, 2],
        ['alpha', null],
        [10.5, 0],
      ]),
      hasMore: true,
      rowCap: 50,
    },
    ...patch,
  }
}

describe('disclosureColumns', () => {
  it('uses the sniff payload columns when nothing is declared', () => {
    expect(disclosureColumns(SNIFF, {})).toEqual([
      { name: 'id', type: 'BIGINT' },
      { name: 'note', type: 'VARCHAR' },
      { name: 'amount', type: 'DOUBLE' },
    ])
  })

  it('prefers a declared columns map, because that IS the scan naming', () => {
    expect(disclosureColumns(SNIFF, { columns: { a: 'VARCHAR' } })).toEqual([
      { name: 'a', type: 'VARCHAR' },
    ])
  })
})

describe('formatSampleCell', () => {
  it('renders NULL and undefined as the literal NULL, never a blank', () => {
    expect(formatSampleCell(null, 'VARCHAR')).toBe('NULL')
    expect(formatSampleCell(undefined, 'VARCHAR')).toBe('NULL')
  })

  it('formats ordinary values through the grid formatter', () => {
    expect(formatSampleCell(1, 'BIGINT')).toBe('1')
    expect(formatSampleCell('alpha', 'VARCHAR')).toBe('alpha')
    expect(formatSampleCell(true, 'BOOLEAN')).toBe('true')
  })
})

describe('projectSampleBatch', () => {
  it('projects agreed rows to display strings', () => {
    const projected = projectSampleBatch(result().sample!.batch, disclosureColumns(SNIFF, {}))
    expect(projected.agreed).toBe(true)
    expect(projected.rows).toEqual([
      ['1', 'alpha', '10.5'],
      ['2', 'NULL', '0'],
    ])
  })

  it('reports disagreement when the batch has more columns than disclosed', () => {
    const wide = batch([[1], ['a'], [2], ['extra']])
    const projected = projectSampleBatch(wide, disclosureColumns(SNIFF, {}))
    expect(projected.agreed).toBe(false)
  })

  it('reports disagreement when the batch has fewer columns than disclosed', () => {
    const narrow = batch([[1]])
    const projected = projectSampleBatch(narrow, disclosureColumns(SNIFF, {}))
    expect(projected.agreed).toBe(false)
  })
})

describe('toPreviewView', () => {
  it('carries the response cap and truncation flag through unchanged', () => {
    const view = toPreviewView(result())
    expect(view.previewId).toBe('p1')
    expect(view.columns).toHaveLength(3)
    expect(view.sample?.rowCap).toBe(50)
    expect(view.sample?.hasMore).toBe(true)
    expect(view.sampleMismatch).toBe(false)
  })

  it('withholds a sample that disagrees with the disclosure', () => {
    const view = toPreviewView(
      result({
        sample: {
          batch: sampleBatch([['id'], ['note']]),
          hasMore: false,
          rowCap: 50,
        },
      }),
    )
    expect(view.sample).toBeNull()
    expect(view.sampleMismatch).toBe(true)
  })

  it('keeps a null sample null (no sample requested)', () => {
    const view = toPreviewView(result({ sample: null }))
    expect(view.sample).toBeNull()
    expect(view.sampleMismatch).toBe(false)
  })

  it('projects declared columns as the sample header', () => {
    const view = toPreviewView(
      result({
        effectiveOptions: { columns: { only: 'VARCHAR' } },
        sample: { batch: sampleBatch([['x']]), hasMore: false, rowCap: 50 },
      }),
    )
    expect(view.sample?.columns).toEqual([{ name: 'only', type: 'VARCHAR' }])
    expect(view.sample?.rows).toEqual([['x']])
  })
})

describe('disclosure display helpers', () => {
  it('makes an unset dialect string an explicit None', () => {
    expect(displayDialect('')).toBe('None')
    expect(displayDialect(';')).toBe(';')
  })

  it('escapes control characters so a newline delimiter cannot reflow the disclosure', () => {
    expect(displayDialect('\n')).toBe('\\n')
    expect(displayDialect('\t')).toBe('\\t')
    expect(displayDialect('\r')).toBe('\\r')
  })

  it('never renders a boolean or a nullable text as blank', () => {
    expect(displayBoolean(true)).toBe('Yes')
    expect(displayBoolean(false)).toBe('No')
    expect(displayNullableText(null)).toBe('None')
    expect(displayNullableText('')).toBe('None')
    expect(displayNullableText('%Y-%m-%d')).toBe('%Y-%m-%d')
  })
})
