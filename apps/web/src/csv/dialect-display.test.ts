// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  displayEffectiveDialectOption,
  displaySniffDialect,
  displaySniffText,
} from './dialect-display'

/**
 * B02 — the CSV dialect **display adapter** (ENG-3).
 *
 * Two classes of pin:
 *
 * 1. **The three display states.** `None` is reserved for a genuinely disabled
 *    setting (comments with no prefix, or an explicit empty-string option);
 *    a field the reader simply did not infer says `Not inferred`; a real value
 *    renders escaped. The old helper rendered the sniffer's literal sentinel
 *    `(empty)` on screen and said `None` for an unset field — both wrong.
 * 2. **The real payload.** A DuckDB CLI control (skipped when the pinned binary
 *    is absent, the `csv-options.test.ts` D15 pattern) proves what `sniff_csv`
 *    actually reports for quoting disabled, comments disabled, LF/CRLF and
 *    quoted newlines — `(empty)` is literal TEXT (`hex` = `28656D70747929`),
 *    `NewLineDelimiter` is ESCAPE TEXT — and that the adapter renders exactly
 *    those payloads as intended. The browser build is exercised by the e2e leg.
 *
 * The last block is a module-boundary pin: this adapter is display only and
 * must never become the parser's input.
 */

const DUCKDB_CLI = process.env['DUCKDB'] ?? '/tmp/duckdb'
const hasDuckDbCli = existsSync(DUCKDB_CLI)

/** The sniff columns this row's contract is about, read for one file. */
interface SniffRow {
  Delimiter: string
  Quote: string
  Escape: string
  NewLineDelimiter: string
  Comment: string
  DateFormat: string | null
  TimestampFormat: string | null
  DelimiterHex: string
  QuoteHex: string
  EscapeHex: string
  NewLineDelimiterHex: string
  CommentHex: string
}

const SENTINEL_HEX = '28656D70747929' // the seven characters `(empty)`

describe('displaySniffDialect — a value renders as the value, escaped for display', () => {
  it('renders a real character unchanged', () => {
    expect(displaySniffDialect('delimiter', ';')).toEqual({ state: 'value', text: ';' })
    expect(displaySniffDialect('quote', '"')).toEqual({ state: 'value', text: '"' })
    expect(displaySniffDialect('comment', '#')).toEqual({ state: 'value', text: '#' })
  })

  it('renders the sniffer escape TEXT of a record terminator legibly, unchanged', () => {
    // The payload, not the bytes: two characters `\` `n` for an LF file.
    expect(displaySniffDialect('newLineDelimiter', '\\n')).toEqual({
      state: 'value',
      text: '\\n',
    })
    expect(displaySniffDialect('newLineDelimiter', '\\r\\n')).toEqual({
      state: 'value',
      text: '\\r\\n',
    })
  })

  it('escapes control characters so a value cannot reflow the disclosure', () => {
    expect(displaySniffDialect('delimiter', '\t')).toEqual({ state: 'value', text: '\\t' })
    expect(displaySniffDialect('newLineDelimiter', '\n')).toEqual({ state: 'value', text: '\\n' })
    expect(displaySniffDialect('delimiter', '\r\n')).toEqual({ state: 'value', text: '\\r\\n' })
    expect(displaySniffDialect('quote', '\u0000')).toEqual({ state: 'value', text: '\\0' })
  })

  it('escapes a real newline inside a multi-character value (e.g. a comment prefix)', () => {
    expect(displaySniffDialect('comment', '//\n')).toEqual({ state: 'value', text: '//\\n' })
  })
})

describe('displaySniffDialect — the sentinel is never rendered literally', () => {
  it('says Not inferred for an unset quote/escape, never None (nothing was disabled)', () => {
    // `sniff_csv` reports no quote character for an unquoted file; the reader's
    // default quote still applies, so "None" would be a false claim.
    expect(displaySniffDialect('quote', '(empty)')).toEqual({
      state: 'not-inferred',
      text: 'Not inferred',
    })
    expect(displaySniffDialect('escape', '(empty)')).toEqual({
      state: 'not-inferred',
      text: 'Not inferred',
    })
  })

  it('never shows the literal sentinel text for any field', () => {
    const fields = ['delimiter', 'quote', 'escape', 'newLineDelimiter', 'comment'] as const
    for (const field of fields) {
      expect(displaySniffDialect(field, '(empty)').text).not.toBe('(empty)')
    }
  })

  it('says None for a comment with no prefix: comments are genuinely off', () => {
    // The sniffer never infers a comment prefix; the default read has none.
    expect(displaySniffDialect('comment', '(empty)')).toEqual({ state: 'disabled', text: 'None' })
  })

  it('says None only for an explicit empty-string option (quoting/escaping/comments off)', () => {
    expect(displaySniffDialect('quote', '(empty)', { quote: '' })).toEqual({
      state: 'disabled',
      text: 'None',
    })
    expect(displaySniffDialect('escape', '(empty)', { escape: '' })).toEqual({
      state: 'disabled',
      text: 'None',
    })
    expect(displaySniffDialect('comment', '(empty)', { comment: '' })).toEqual({
      state: 'disabled',
      text: 'None',
    })
    // The same raw payload with no option is an absent inference, not "off".
    expect(displaySniffDialect('quote', '(empty)', {}).state).toBe('not-inferred')
  })

  it('treats an explicit literal `(empty)` option as a VALUE, not the sentinel', () => {
    // A user may literally configure the comment prefix `(empty)`; the option
    // set disambiguates the wire text, so it is not decoded as "unset".
    expect(displaySniffDialect('comment', '(empty)', { comment: '(empty)' })).toEqual({
      state: 'value',
      text: '(empty)',
    })
  })

  it('treats an empty raw string as no evidence at all, not as None', () => {
    // The engine never sends `''`; an older/faked payload must not claim a
    // disabled setting either.
    expect(displaySniffDialect('quote', '')).toEqual({
      state: 'not-inferred',
      text: 'Not inferred',
    })
  })
})

describe('displaySniffText — an inferred format is not a disabled setting', () => {
  it('says Not inferred for a null or blank format', () => {
    expect(displaySniffText(null)).toEqual({ state: 'not-inferred', text: 'Not inferred' })
    expect(displaySniffText('')).toEqual({ state: 'not-inferred', text: 'Not inferred' })
  })

  it('renders a real format unchanged', () => {
    expect(displaySniffText('%Y-%m-%d')).toEqual({ state: 'value', text: '%Y-%m-%d' })
  })
})

describe('displayEffectiveDialectOption — an empty effective value is a disabled setting', () => {
  it('renders None for the empty string and the value otherwise', () => {
    expect(displayEffectiveDialectOption('')).toBe('None')
    expect(displayEffectiveDialectOption('"')).toBe('"')
    expect(displayEffectiveDialectOption('\t')).toBe('\\t')
  })
})

describe('the real sniffer payload (DuckDB CLI control; D15 comparison only)', () => {
  let root = ''
  function fixture(name: string, bytes: string): string {
    if (root === '') root = mkdtempSync(join(tmpdir(), 'assay-b02-'))
    const path = join(root, name)
    writeFileSync(path, bytes)
    return path
  }

  afterAll(() => {
    if (root !== '') rmSync(root, { recursive: true, force: true })
  })

  function sniff(path: string, optionsSql = ''): SniffRow {
    const args = optionsSql === '' ? '' : `, ${optionsSql}`
    const sql =
      'select Delimiter, Quote, Escape, NewLineDelimiter, Comment, DateFormat, TimestampFormat, ' +
      'hex(Delimiter) as DelimiterHex, hex(Quote) as QuoteHex, hex(Escape) as EscapeHex, ' +
      'hex(NewLineDelimiter) as NewLineDelimiterHex, hex(Comment) as CommentHex ' +
      `from sniff_csv('${path}'${args})`
    const out = execFileSync(DUCKDB_CLI, ['-json', '-c', sql], { encoding: 'utf8' })
    const rows = JSON.parse(out) as SniffRow[]
    const row = rows[0]
    if (row === undefined) throw new Error('sniff_csv returned no row')
    return row
  }

  it.skipIf(!hasDuckDbCli)(
    'reports (empty) as literal text and the terminator as escape text (unquoted LF)',
    () => {
      const path = fixture('plain.csv', 'a,b\n1,2\n')
      const row = sniff(path)
      expect(row.Delimiter).toBe(',')
      expect(row.Quote).toBe('(empty)')
      expect(row.Escape).toBe('(empty)')
      expect(row.Comment).toBe('(empty)')
      expect(row.NewLineDelimiter).toBe('\\n')
      // Not a NULL and not an empty string: the seven ASCII characters.
      expect(row.QuoteHex).toBe(SENTINEL_HEX)
      expect(row.EscapeHex).toBe(SENTINEL_HEX)
      expect(row.CommentHex).toBe(SENTINEL_HEX)
      expect(row.NewLineDelimiterHex).toBe('5C6E')
      // The two inferred-and-unset fields must NOT read as disabled…
      expect(displaySniffDialect('quote', row.Quote).state).toBe('not-inferred')
      expect(displaySniffDialect('escape', row.Escape).state).toBe('not-inferred')
      // …while comments with no prefix genuinely are off.
      expect(displaySniffDialect('comment', row.Comment)).toEqual({
        state: 'disabled',
        text: 'None',
      })
      expect(displaySniffDialect('newLineDelimiter', row.NewLineDelimiter).text).toBe('\\n')
      expect(displaySniffText(row.DateFormat).state).toBe('not-inferred')
    },
  )

  it.skipIf(!hasDuckDbCli)('reports a CRLF terminator as the escape text \\r\\n', () => {
    const path = fixture('plain-crlf.csv', 'a,b\r\n1,2\r\n')
    const row = sniff(path)
    expect(row.NewLineDelimiter).toBe('\\r\\n')
    expect(row.NewLineDelimiterHex).toBe('5C725C6E')
    expect(displaySniffDialect('newLineDelimiter', row.NewLineDelimiter).text).toBe('\\r\\n')
  })

  it.skipIf(!hasDuckDbCli)('reports the quote/escape characters for a quoted file', () => {
    const path = fixture('quoted.csv', 'a,b\n"x""y",2\n')
    const row = sniff(path)
    expect(row.Quote).toBe('"')
    expect(row.QuoteHex).toBe('22')
    expect(row.Escape).toBe('"')
    expect(displaySniffDialect('quote', row.Quote)).toEqual({ state: 'value', text: '"' })
    expect(displaySniffDialect('escape', row.Escape)).toEqual({ state: 'value', text: '"' })
  })

  it.skipIf(!hasDuckDbCli)('reports a quoted newline without changing the terminator', () => {
    const path = fixture('quoted-newline.csv', 'a,b\n"line1\nline2",2\n')
    const row = sniff(path)
    expect(row.NewLineDelimiter).toBe('\\n')
    expect(row.Quote).toBe('"')
    // The record terminator is the file's own, not the quoted newline's.
    expect(displaySniffDialect('newLineDelimiter', row.NewLineDelimiter).text).toBe('\\n')
  })

  it.skipIf(!hasDuckDbCli)(
    'reports the SAME (empty) quote whether quoting was disabled or merely not inferred',
    () => {
      // The payload cannot distinguish the two; only the effective option set
      // can, which is exactly why the adapter takes it.
      const path = fixture('plain-quote.csv', 'a,b\n1,2\n')
      const implicit = sniff(path)
      const disabled = sniff(path, "quote = ''")
      expect(disabled.Quote).toBe('(empty)')
      expect(disabled.QuoteHex).toBe(implicit.QuoteHex)
      expect(displaySniffDialect('quote', implicit.Quote, {}).state).toBe('not-inferred')
      expect(displaySniffDialect('quote', disabled.Quote, { quote: '' })).toEqual({
        state: 'disabled',
        text: 'None',
      })
    },
  )

  it.skipIf(!hasDuckDbCli)('reports a configured comment prefix as a real value', () => {
    const path = fixture('hash.csv', 'a,b\n1,2\n')
    const row = sniff(path, "comment = '#'")
    expect(row.Comment).toBe('#')
    expect(displaySniffDialect('comment', row.Comment, { comment: '#' })).toEqual({
      state: 'value',
      text: '#',
    })
  })
})

describe('module boundary — the display adapter is not parser input', () => {
  const CSV_DIR = resolve(process.cwd(), 'apps', 'web', 'src', 'csv')
  const displaySource = readFileSync(join(CSV_DIR, 'dialect-display.ts'), 'utf8')
  const scanSource = readFileSync(join(CSV_DIR, 'header-renames.ts'), 'utf8')
  /** The module specifiers a source file imports (static imports only). */
  function importsOf(source: string): string[] {
    return [...source.matchAll(/^import[^\n]*from\s+'([^']+)'/gm)].map((match) => match[1] ?? '')
  }

  it('the display adapter never imports the header scan or a decoder', () => {
    const imports = importsOf(displaySource)
    expect(imports).not.toContain('./header-renames')
    expect(imports).toEqual(
      expect.arrayContaining(['@assay/engine-duckdb', './copy', './sniff-wire']),
    )
    expect(imports).toHaveLength(3)
  })

  it('the header scan never imports the display adapter', () => {
    expect(importsOf(scanSource)).not.toContain('./dialect-display')
  })

  it('the wire sentinel has one source shared by both consumers', () => {
    expect(importsOf(displaySource)).toContain('./sniff-wire')
    expect(importsOf(scanSource)).toContain('./sniff-wire')
  })
})
