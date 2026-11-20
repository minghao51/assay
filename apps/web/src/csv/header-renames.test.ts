// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type { EngineCsvSniff } from '@assay/engine-duckdb'
import {
  CSV_HEADER_HEAD_BYTES,
  decodeSniffedDialectChar,
  decodeSniffedNewLine,
  deriveHeaderRenames,
  headerReadObstacle,
  readHeaderRenames,
  renamedHeaderNames,
  scanHeaderRecord,
  sniffedDialect,
  trimHeaderName,
} from './header-renames'
import type { CsvHeaderDialect } from './header-renames'

/**
 * D3-1 — the single-record header scan and the rename rule, pinned against
 * evidence taken from the installed DuckDB v1.5.5 (`/tmp/duckdb`).
 *
 * Two classes of pin here:
 *
 * 1. **The rule table.** Every row of the module note's evidence table is a
 *    literal assertion: raw header fields in, the engine's own names out. If
 *    someone "simplifies" the zero-based empty name, the case-insensitive
 *    counter or the recursive re-suffix, a row of this table goes red.
 * 2. **Every limit.** Each bail-out is asserted with the reason AND with the
 *    absence of a list, because the row's contract is that a doubtful read
 *    shows nothing rather than something plausible.
 */

const COMMA: CsvHeaderDialect = {
  delimiter: ',',
  quote: '"',
  escape: '',
  newLineDelimiter: '\n',
}

/** The sniff payload's shape, reduced to what the derivation reads. */
function sniff(overrides: Partial<EngineCsvSniff> = {}): EngineCsvSniff {
  return {
    delimiter: ',',
    quote: '"',
    escape: '',
    newLineDelimiter: '\n',
    comment: '',
    skipRows: 0,
    hasHeader: true,
    columns: [
      { name: 'id', type: 'BIGINT' },
      { name: 'column1', type: 'VARCHAR' },
      { name: 'id_1', type: 'BIGINT' },
    ],
    dateFormat: null,
    timestampFormat: null,
    prompt: null,
    ...overrides,
  }
}

/** The engine's names for one header line, as `sniff_csv` reported them. */
function namesFor(fields: readonly string[]): string[] {
  const renamed = renamedHeaderNames(fields)
  if (renamed === null) throw new Error('the rule must terminate for this header')
  return renamed
}

describe('trimHeaderName', () => {
  it('trims the ASCII blank the reader trims, and nothing else', () => {
    expect(trimHeaderName(' a ')).toBe('a')
    expect(trimHeaderName('\tid\t')).toBe('id')
    expect(trimHeaderName('  ')).toBe('')
    // A name may hold internal spaces, and a non-breaking space is not blank.
    expect(trimHeaderName('a b')).toBe('a b')
    expect(trimHeaderName('\u00a0id')).toBe('\u00a0id')
  })
})

describe('renamedHeaderNames — the DuckDB v1.5.5 rule, from the evidence table', () => {
  const cases: readonly (readonly [readonly string[], readonly string[]])[] = [
    // The golden fixtures first: `dup-header.csv` is the D3 pin.
    [
      ['id', '', 'id'],
      ['id', 'column1', 'id_1'],
    ],
    // An empty name takes its ZERO-based position — `,a,b` is not `column1`.
    [
      ['', 'a', 'b'],
      ['column0', 'a', 'b'],
    ],
    [
      ['a', 'b', ''],
      ['a', 'b', 'column2'],
    ],
    [
      ['', '', ''],
      ['column0', 'column1', 'column2'],
    ],
    [
      ['id', 'id', 'id'],
      ['id', 'id_1', 'id_2'],
    ],
    // The counter is shared across spellings of one base name…
    [
      ['id', 'id', 'ID', 'ID'],
      ['id', 'id_1', 'ID_2', 'ID_3'],
    ],
    [
      ['a', 'A', 'a'],
      ['a', 'A_1', 'a_2'],
    ],
    [
      ['A', 'a', 'A'],
      ['A', 'a_1', 'A_2'],
    ],
    // …and a suffixed candidate that is taken is deduplicated again.
    [
      ['a', 'a_1', 'a'],
      ['a', 'a_1', 'a_1_1'],
    ],
    [
      ['a', 'a_1', 'a', 'a'],
      ['a', 'a_1', 'a_1_1', 'a_2'],
    ],
    [
      ['x', 'x_1', 'x', 'x'],
      ['x', 'x_1', 'x_1_1', 'x_2'],
    ],
    [
      ['a', 'a_2', 'a'],
      ['a', 'a_2', 'a_1'],
    ],
    // A generated name is an ordinary occupied name.
    [
      ['column1', '', 'x'],
      ['column1', 'column1_1', 'x'],
    ],
    [
      ['id', '', 'id', 'column1'],
      ['id', 'column1', 'id_1', 'column1_1'],
    ],
    // Names are trimmed before the emptiness and duplicate tests.
    [
      [' a ', ' b '],
      ['a', 'b'],
    ],
    [
      ['a ', 'a'],
      ['a', 'a_1'],
    ],
    // The quoted-newline fixture's header: quoted delimiter, quoted newline,
    // a duplicate and an empty name in one record.
    [
      ['a,b', 'id', 'line\none', 'id', ''],
      ['a,b', 'id', 'line\none', 'id_1', 'column4'],
    ],
    // Nothing to rename.
    [
      ['id', 'note'],
      ['id', 'note'],
    ],
    [[], []],
  ]

  it.each(cases)('%j ⇒ %j', (fields, expected) => {
    expect(namesFor(fields)).toEqual(expected)
  })

  it('keeps every name, so the count always equals the field count', () => {
    const fields = ['a', '', 'a', 'A', 'a_1', '']
    expect(namesFor(fields)).toHaveLength(fields.length)
  })

  it('terminates on a pathological nested-collision header instead of hanging', () => {
    // Each suffixed candidate is itself taken, so the rule walks one level
    // deeper per name (`a_1`, `a_1_1`, `a_1_1_1`, …); the depth guard turns
    // that into "no answer" instead of an unbounded walk.
    const taken = Array.from({ length: 80 }, (_, index) => `a${'_1'.repeat(index + 1)}`)
    expect(renamedHeaderNames(['a', ...taken, 'a'])).toBeNull()
  })
})

describe('the sniffed dialect is option TEXT and is decoded before scanning', () => {
  it('decodes the sniffer unset marker, which is the literal text (empty)', () => {
    // `hex(Quote)` = 28656D70747929 on the installed build: seven characters.
    expect(decodeSniffedDialectChar('(empty)')).toBe('')
    expect(decodeSniffedDialectChar('"')).toBe('"')
    expect(decodeSniffedDialectChar(',')).toBe(',')
    // A real backslash quote is kept: only the unset MARKER is special.
    expect(decodeSniffedDialectChar('\\')).toBe('\\')
  })

  it('decodes the escape-TEXT record terminator to real characters', () => {
    // `hex(NewLineDelimiter)` = 5C6E / 5C725C6E on the installed build.
    expect(decodeSniffedNewLine('\\n')).toBe('\n')
    expect(decodeSniffedNewLine('\\n\\n')).toBe('\n\n')
    expect(decodeSniffedNewLine('\\r\\n')).toBe('\r\n')
    expect(decodeSniffedNewLine('\\t')).toBe('\t')
    expect(decodeSniffedNewLine('(empty)')).toBe('')
    // Already-real characters pass through unchanged (the RTL fakes' shape).
    expect(decodeSniffedNewLine('\n')).toBe('\n')
    // An unknown escape is kept verbatim, which can only tighten the scan.
    expect(decodeSniffedNewLine('\\x')).toBe('\\x')
    expect(decodeSniffedNewLine('\\')).toBe('\\')
  })

  it('does not accept display text in place of the decoded terminator (B02 boundary)', () => {
    // The display adapter renders the payload's escape text as the two visible
    // characters `\\n`. Feeding that text to the scan finds no record terminator
    // (the bytes hold a real LF), so the rename list would be silently lost —
    // which is exactly why the display adapter is not parser input.
    const head = 'id,,id\n1,x,2\n3,y,4\n'
    expect(
      scanHeaderRecord(head, {
        delimiter: ',',
        quote: '',
        escape: '',
        newLineDelimiter: '\\n',
      }),
    ).toEqual({ kind: 'limit', limit: 'incomplete-record' })
    // The decoded value is what the scan reads.
    expect(
      scanHeaderRecord(head, {
        delimiter: ',',
        quote: '',
        escape: '',
        newLineDelimiter: '\n',
      }),
    ).toEqual({ kind: 'fields', fields: ['id', '', 'id'] })
  })

  it('translates the whole sniffed dialect in one place', () => {
    expect(
      sniffedDialect({
        delimiter: ',',
        quote: '(empty)',
        escape: '(empty)',
        newLineDelimiter: '\\r\\n',
      }),
    ).toEqual({ delimiter: ',', quote: '', escape: '', newLineDelimiter: '\r\n' })
  })

  it('scans a header with the engine real payload: (empty) quote, escaped newline', () => {
    // Exactly what the shipped browser build reports for `dup-header.csv`.
    const result = deriveHeaderRenames({
      head: 'id,,id\n1,x,2\n3,y,4\n',
      sniff: sniff({
        delimiter: ',',
        quote: '(empty)',
        escape: '(empty)',
        newLineDelimiter: '\\n',
      }),
      declaredColumns: false,
    })
    expect(result).toEqual({
      kind: 'derived',
      renames: [
        { original: '', renamed: 'column1' },
        { original: 'id', renamed: 'id_1' },
      ],
    })
  })

  it('scans the quoted-newline fixture with the engine real payload', () => {
    const result = deriveHeaderRenames({
      head: '"a,b",id,"line\none",id,\n1,alpha,3,4,5\n2,beta,6,7,8\n',
      sniff: sniff({
        delimiter: ',',
        quote: '"',
        escape: '(empty)',
        newLineDelimiter: '\\n',
        columns: [
          { name: 'a,b', type: 'BIGINT' },
          { name: 'id', type: 'VARCHAR' },
          { name: 'line\none', type: 'BIGINT' },
          { name: 'id_1', type: 'BIGINT' },
          { name: 'column4', type: 'BIGINT' },
        ],
      }),
      declaredColumns: false,
    })
    expect(result).toEqual({
      kind: 'derived',
      renames: [
        { original: 'id', renamed: 'id_1' },
        { original: '', renamed: 'column4' },
      ],
    })
  })

  it('scans a CRLF file whose terminator the sniffer reports as escaped text', () => {
    expect(
      scanHeaderRecord('id,name\r\n1,a\r\n', {
        delimiter: ',',
        quote: '(empty)',
        escape: '(empty)',
        newLineDelimiter: decodeSniffedNewLine('\\r\\n'),
      }),
    ).toEqual({ kind: 'fields', fields: ['id', 'name'] })
  })
})

describe('scanHeaderRecord — exactly one record, with the sniffed dialect', () => {
  it('reads a plain header and stops at the record terminator', () => {
    expect(scanHeaderRecord('id,,id\n1,x,2\n', COMMA)).toEqual({
      kind: 'fields',
      fields: ['id', '', 'id'],
    })
  })

  it('unquotes a quoted delimiter instead of splitting on it', () => {
    expect(scanHeaderRecord('"a,b",c\n1,2\n', COMMA)).toEqual({
      kind: 'fields',
      fields: ['a,b', 'c'],
    })
  })

  it('keeps a quoted newline inside its field — the fixture shape', () => {
    const head = '"a,b",id,"line\none",id,\n1,alpha,3,4,5\n'
    expect(scanHeaderRecord(head, COMMA)).toEqual({
      kind: 'fields',
      fields: ['a,b', 'id', 'line\none', 'id', ''],
    })
  })

  it('reads doubled-quote escaping when the sniff reports escape = quote', () => {
    expect(scanHeaderRecord('"a""b",c\n1,2\n', { ...COMMA, escape: '"' })).toEqual({
      kind: 'fields',
      fields: ['a"b', 'c'],
    })
  })

  it('reads a distinct escape character when the sniff reports one', () => {
    expect(scanHeaderRecord('"a\\"b",c\n1,2\n', { ...COMMA, escape: '\\' })).toEqual({
      kind: 'fields',
      fields: ['a"b', 'c'],
    })
  })

  it('treats every character literally when the sniff reports no quote', () => {
    expect(scanHeaderRecord('a"b,"c\n1,2\n', { ...COMMA, quote: '' })).toEqual({
      kind: 'fields',
      fields: ['a"b', '"c'],
    })
  })

  it('honours a sniffed CRLF terminator', () => {
    expect(scanHeaderRecord('id,name\r\n1,a\r\n', { ...COMMA, newLineDelimiter: '\r\n' })).toEqual({
      kind: 'fields',
      fields: ['id', 'name'],
    })
  })

  it('honours a sniffed multi-character delimiter', () => {
    expect(scanHeaderRecord('a;;b\n1;;2\n', { ...COMMA, delimiter: ';;' })).toEqual({
      kind: 'fields',
      fields: ['a', 'b'],
    })
  })

  it('strips one leading BOM from the head', () => {
    expect(scanHeaderRecord('\uFEFFid,name\n1,a\n', COMMA)).toEqual({
      kind: 'fields',
      fields: ['id', 'name'],
    })
  })

  it('is bounded: a head with no record terminator is incomplete, not partial', () => {
    expect(scanHeaderRecord('id,name', COMMA)).toEqual({
      kind: 'limit',
      limit: 'incomplete-record',
    })
    expect(scanHeaderRecord('', COMMA)).toEqual({ kind: 'limit', limit: 'incomplete-record' })
  })

  it('refuses a quoted run left open at the end of the window', () => {
    expect(scanHeaderRecord('"a,b,c\n1,2\n', COMMA)).toEqual({
      kind: 'limit',
      limit: 'unterminated-quote',
    })
  })

  it('refuses an escape on the window edge, where the next character is unknown', () => {
    expect(scanHeaderRecord('"a\\', { ...COMMA, escape: '\\' })).toEqual({
      kind: 'limit',
      limit: 'escape-at-window-edge',
    })
    // The first half of a doubled quote is the same unknowable edge.
    expect(scanHeaderRecord('"a"', { ...COMMA, escape: '"' })).toEqual({
      kind: 'limit',
      limit: 'escape-at-window-edge',
    })
  })

  it('refuses the shapes it will not interpret confidently', () => {
    // A quote in the middle of an unquoted field.
    expect(scanHeaderRecord('a"b,c\n1,2\n', COMMA)).toEqual({
      kind: 'limit',
      limit: 'ambiguous-shape',
    })
    // An escape character outside quotes.
    expect(scanHeaderRecord('a\\,b\n1,2\n', { ...COMMA, escape: '\\' })).toEqual({
      kind: 'limit',
      limit: 'ambiguous-shape',
    })
    // No delimiter or no terminator to scan with.
    expect(scanHeaderRecord('id,name\n', { ...COMMA, delimiter: '' })).toEqual({
      kind: 'limit',
      limit: 'ambiguous-shape',
    })
    expect(scanHeaderRecord('id,name\n', { ...COMMA, newLineDelimiter: '' })).toEqual({
      kind: 'limit',
      limit: 'ambiguous-shape',
    })
  })
})

describe('deriveHeaderRenames — reconstruct, then require exact equality', () => {
  it('derives the list when the reconstruction matches the engine exactly', () => {
    expect(
      deriveHeaderRenames({ head: 'id,,id\n1,x,2\n', sniff: sniff(), declaredColumns: false }),
    ).toEqual({
      kind: 'derived',
      renames: [
        { original: '', renamed: 'column1' },
        { original: 'id', renamed: 'id_1' },
      ],
    })
  })

  it('derives the quoted-newline fixture: a quoted delimiter, newline, dup and empty', () => {
    const head = '"a,b",id,"line\none",id,\n1,alpha,3,4,5\n'
    const result = deriveHeaderRenames({
      head,
      sniff: sniff({
        columns: [
          { name: 'a,b', type: 'BIGINT' },
          { name: 'id', type: 'VARCHAR' },
          { name: 'line\none', type: 'BIGINT' },
          { name: 'id_1', type: 'BIGINT' },
          { name: 'column4', type: 'BIGINT' },
        ],
      }),
      declaredColumns: false,
    })
    expect(result).toEqual({
      kind: 'derived',
      renames: [
        { original: 'id', renamed: 'id_1' },
        { original: '', renamed: 'column4' },
      ],
    })
  })

  it('derives an empty list for a header with nothing to rename', () => {
    expect(
      deriveHeaderRenames({
        head: 'id,note\n1,alpha\n',
        sniff: sniff({
          columns: [
            { name: 'id', type: 'BIGINT' },
            { name: 'note', type: 'VARCHAR' },
          ],
        }),
        declaredColumns: false,
      }),
    ).toEqual({ kind: 'derived', renames: [] })
  })

  it('refuses a reconstruction that disagrees with the engine in a NAME', () => {
    expect(
      deriveHeaderRenames({
        head: 'id,,id\n1,x,2\n',
        // The engine said `id`, `column2`, `id_1` — one digit away from the
        // reconstruction. Nothing is shown.
        sniff: sniff({
          columns: [
            { name: 'id', type: 'BIGINT' },
            { name: 'column2', type: 'VARCHAR' },
            { name: 'id_1', type: 'BIGINT' },
          ],
        }),
        declaredColumns: false,
      }),
    ).toEqual({ kind: 'unavailable', limit: 'name-mismatch' })
  })

  it('refuses a reconstruction that disagrees with the engine in ORDER', () => {
    expect(
      deriveHeaderRenames({
        head: 'id,,id\n1,x,2\n',
        sniff: sniff({
          columns: [
            { name: 'id_1', type: 'BIGINT' },
            { name: 'column1', type: 'VARCHAR' },
            { name: 'id', type: 'BIGINT' },
          ],
        }),
        declaredColumns: false,
      }),
    ).toEqual({ kind: 'unavailable', limit: 'name-mismatch' })
  })

  it('refuses a field count that disagrees with the disclosed columns', () => {
    expect(
      deriveHeaderRenames({
        head: 'id,,id\n1,x,2\n',
        sniff: sniff({
          columns: [
            { name: 'id', type: 'BIGINT' },
            { name: 'column1', type: 'VARCHAR' },
          ],
        }),
        declaredColumns: false,
      }),
    ).toEqual({ kind: 'unavailable', limit: 'column-count' })
  })

  it('has no list when there is no header row to rename', () => {
    expect(
      deriveHeaderRenames({
        head: 'id,,id\n1,x,2\n',
        sniff: sniff({
          hasHeader: false,
          columns: [
            { name: 'column0', type: 'VARCHAR' },
            { name: 'column1', type: 'VARCHAR' },
            { name: 'column2', type: 'VARCHAR' },
          ],
        }),
        declaredColumns: false,
      }),
    ).toEqual({ kind: 'unavailable', limit: 'no-header' })
  })

  it('has no list when the reader skips rows before the header', () => {
    expect(
      deriveHeaderRenames({
        head: 'id,,id\n1,x,2\n',
        sniff: sniff({ skipRows: 1 }),
        declaredColumns: false,
      }),
    ).toEqual({ kind: 'unavailable', limit: 'skipped-rows' })
  })

  it('has no list when a declared column map replaces the reader names', () => {
    expect(
      deriveHeaderRenames({
        head: 'id,,id\n1,x,2\n',
        sniff: sniff(),
        declaredColumns: true,
      }),
    ).toEqual({ kind: 'unavailable', limit: 'declared-columns' })
  })

  it('carries every scanner limit straight through', () => {
    const head = 'id,name'
    expect(deriveHeaderRenames({ head, sniff: sniff(), declaredColumns: false })).toEqual({
      kind: 'unavailable',
      limit: 'incomplete-record',
    })
  })
})

describe('headerReadObstacle', () => {
  it('names the three reasons a head read cannot decide, and nothing else', () => {
    expect(headerReadObstacle(sniff(), false)).toBeNull()
    expect(headerReadObstacle(sniff({ hasHeader: false }), false)).toBe('no-header')
    expect(headerReadObstacle(sniff({ skipRows: 3 }), false)).toBe('skipped-rows')
    expect(headerReadObstacle(sniff(), true)).toBe('declared-columns')
  })
})

describe('readHeaderRenames — the bounded head read', () => {
  /** A file-like seam recording what was sliced out of it. */
  function fakeFile(text: string): { getFile(): Promise<File>; slices: [number, number][] } {
    const slices: [number, number][] = []
    const file = new File([text], 'picked.csv')
    return {
      slices,
      getFile: () => {
        const sliced = file.slice.bind(file)
        Object.defineProperty(file, 'slice', {
          value: (start?: number, end?: number) => {
            slices.push([start ?? 0, end ?? file.size])
            return sliced(start, end)
          },
        })
        return Promise.resolve(file)
      },
    }
  }

  it('reads at most the documented 64 KiB bound, then derives', async () => {
    const source = fakeFile('id,,id\n1,x,2\n')
    expect(await readHeaderRenames(source, sniff(), false)).toEqual({
      kind: 'derived',
      renames: [
        { original: '', renamed: 'column1' },
        { original: 'id', renamed: 'id_1' },
      ],
    })
    expect(CSV_HEADER_HEAD_BYTES).toBe(65536)
    expect(source.slices).toEqual([[0, CSV_HEADER_HEAD_BYTES]])
  })

  it('reads nothing at all when there is no header row', async () => {
    const source = fakeFile('id,,id\n1,x,2\n')
    expect(await readHeaderRenames(source, sniff({ hasHeader: false }), false)).toEqual({
      kind: 'unavailable',
      limit: 'no-header',
    })
    expect(source.slices).toEqual([])
  })

  it('reads nothing at all when the reader skipped rows before the header', async () => {
    const source = fakeFile('   \nid,,id\n1,x,2\n')
    expect(await readHeaderRenames(source, sniff({ skipRows: 1 }), false)).toEqual({
      kind: 'unavailable',
      limit: 'skipped-rows',
    })
    expect(source.slices).toEqual([])
  })

  it('reports an unreadable file as a limit, never as an error carrying a name', async () => {
    const source = {
      getFile: () => Promise.reject(new Error('picked.csv could not be read')),
    }
    expect(await readHeaderRenames(source, sniff(), false)).toEqual({
      kind: 'unavailable',
      limit: 'unreadable-file',
    })
  })

  it('reports a failed head decode as a limit too', async () => {
    const source = {
      getFile: () =>
        Promise.resolve({
          slice: () => ({
            text: () => Promise.reject(new Error('picked.csv')),
          }),
        } as unknown as File),
    }
    expect(await readHeaderRenames(source, sniff(), false)).toEqual({
      kind: 'unavailable',
      limit: 'unreadable-file',
    })
  })

  it('keeps the quoted-newline record intact inside the boundary', async () => {
    const source = fakeFile('"a,b",id,"line\none",id,\n1,alpha,3,4,5\n')
    const sniffed = sniff({
      columns: [
        { name: 'a,b', type: 'BIGINT' },
        { name: 'id', type: 'VARCHAR' },
        { name: 'line\none', type: 'BIGINT' },
        { name: 'id_1', type: 'BIGINT' },
        { name: 'column4', type: 'BIGINT' },
      ],
    })
    expect(await readHeaderRenames(source, sniffed, false)).toEqual({
      kind: 'derived',
      renames: [
        { original: 'id', renamed: 'id_1' },
        { original: '', renamed: 'column4' },
      ],
    })
  })
})
