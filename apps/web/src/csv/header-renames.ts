// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * D3-1 — the per-file header **rename list** for the CSV review (EW-03D §8 D3:
 * "accept DuckDB auto-renames … + explicit disclosure of the rename list
 * before adoption").
 *
 * The engine has no op that reports the raw header row, and this app package
 * must not grow one, so the only route to "which original name became which
 * name" is a bounded read of the file's own head on the main thread. That
 * route can disagree with the engine — a quoted delimiter, a quoted newline,
 * an unusual escape, a dialect guess this scanner reads differently — and **a
 * wrong rename list is worse than no list**: it would tell the reader a column
 * will be called something it will not be called.
 *
 * So this module never answers "probably". It is three steps:
 *
 * 1. {@link readHeaderRenames} reads at most {@link CSV_HEADER_HEAD_BYTES} of
 *    the picked file (`file.slice(0, cap).text()`) — a slice, never
 *    `file.text()` on the whole file. Nothing is cached, nothing is retained.
 * 2. {@link scanHeaderRecord} extracts **exactly one record** from that head,
 *    honouring the **sniffed** delimiter, quote, escape and record terminator.
 *    This is a single-record scanner, not a CSV parser: it produces the header
 *    field texts and stops at the first record terminator, with no rows, no
 *    field coercion, no types, no buffering past the window. Every shape it
 *    will not interpret with certainty ends the scan in a named limit.
 * 3. {@link deriveHeaderRenames} reconstructs the names the reader will give
 *    those fields (the rename rule below) and then **requires exact equality**
 *    with `sniff.columns[].name` — count, text and order. Anything short of
 *    exact equality is a limit, never a partial list.
 *
 * # The rename rule, from evidence
 *
 * Verified against the installed DuckDB v1.5.5 (`/tmp/duckdb`, the CLI control
 * the engine's WASM build matches for this surface) by reading
 * `sniff_csv(…, header = true).Columns` for one scratch header at a time:
 *
 * | header              | engine's names                            |
 * | ------------------- | ----------------------------------------- |
 * | `id,,id`            | `id`, `column1`, `id_1`                   |
 * | `,a,b`              | `column0`, `a`, `b`                       |
 * | `a,b,`              | `a`, `b`, `column2`                       |
 * | `id,id,id`          | `id`, `id_1`, `id_2`                      |
 * | `id,id,ID,ID`       | `id`, `id_1`, `ID_2`, `ID_3`              |
 * | ` a , b `           | `a`, `b` (names are trimmed)              |
 * | `" a ",b`           | `a`, `b` (trimmed after unquoting)        |
 * | `a,a_1,a`           | `a`, `a_1`, `a_1_1`                       |
 * | `x,x_1,x,x`         | `x`, `x_1`, `x_1_1`, `x_2`                |
 * | `column1,,x`        | `column1`, `column1_1`, `x`               |
 * | `"a,b",id,"line⏎one",id,` | `a,b`, `id`, `line⏎one`, `id_1`, `column4` |
 *
 * Three facts, none of them assumed: an empty name becomes `column{i}` with a
 * **zero-based** position ({@link renamedHeaderNames} — note `,a,b` ⇒
 * `column0`); a repeated name gets `_{n}` from a per-base counter that is
 * **case-insensitive** and shared by every spelling of that base; and a
 * suffixed candidate that is itself taken is deduplicated again, recursively
 * (`a,a_1,a` ⇒ `a_1_1`). Field text is trimmed of ASCII whitespace first, so
 * the emptiness test is on the trimmed name (`a,A,a` ⇒ `a`, `A_1`, `a_2`).
 *
 * The sniffed dialect had to be decoded before any of this could be scanned,
 * and that too is evidence rather than assumption: `sniff_csv` reports an
 * UNSET `Quote`/`Escape` as the literal seven characters `(empty)`
 * (`hex(Quote)` = `28656D70747929`) and reports `NewLineDelimiter` as ESCAPE
 * TEXT (`hex` = `5C6E` for an LF file, `5C725C6E` for CRLF), while `Delimiter`
 * arrives as a real character (`09` for a tab file). {@link sniffedDialect}
 * decodes exactly that, and the shipped review surface is where the `(empty)`
 * rendering was confirmed in-browser.
 *
 * The rule is encoded, not trusted: step 3 compares its output with the
 * engine's own `sniff.columns`, so a file whose naming this rule gets wrong
 * falls back to the behaviour sentence instead of showing a false pair.
 *
 * # Privacy (ADR 0025)
 *
 * Header text is file content. It is returned for the render path only: this
 * module logs nothing, throws nothing that carries a value, and the dialog
 * places it in text nodes (never a `data-*` attribute, never telemetry, never
 * an error string). The picked file's name is never read here at all.
 */
import type { EngineCsvSniff } from '@assay/engine-duckdb'
import { SNIFF_UNSET_TEXT } from './sniff-wire'

/**
 * The head read's bound: 64 KiB. A CSV header record is the first line of the
 * file, so this is orders of magnitude more than any real header needs while
 * staying a bounded slice the main thread can decode without a stall. A record
 * that does not complete inside the window yields
 * {@link CsvHeaderLimit} `'incomplete-record'`, never a partial read.
 */
export const CSV_HEADER_HEAD_BYTES = 65_536

/**
 * Every way this module declines to produce a list. Internal reasons — the
 * surface renders one fixed sentence for all of them (the limit is ours, not
 * the engine's) and nothing here is logged or attached to an error.
 */
export type CsvHeaderLimit =
  /** `hasHeader = false`: there is no header row, so nothing is renamed. */
  | 'no-header'
  /** The reader skips rows before the header, so the head's first record is not it. */
  | 'skipped-rows'
  /** The user declared `columns`, which replaces the reader's naming entirely. */
  | 'declared-columns'
  /** `getFile()`/`slice().text()` failed — the head could not be read at all. */
  | 'unreadable-file'
  /** No record terminator inside the window (or an empty head). */
  | 'incomplete-record'
  /** A quote opened a field and the window ended before it closed. */
  | 'unterminated-quote'
  /** An escape (or a doubling quote) sat on the window's last character. */
  | 'escape-at-window-edge'
  /** A shape this scanner will not read confidently (see {@link scanHeaderRecord}). */
  | 'ambiguous-shape'
  /** The record's field count differs from the disclosed column count. */
  | 'column-count'
  /** The reconstructed names differ from `sniff.columns` in text or order. */
  | 'name-mismatch'

/** One disclosed pair: the header field as the file wrote it, and its name. */
export interface CsvHeaderRename {
  /** The field's text with the reader's own trimming; `''` for an empty name. */
  readonly original: string
  /** The name the reader gives that column — always different from `original`. */
  readonly renamed: string
}

/**
 * The derivation's answer: a verified, complete list (possibly empty) or one
 * named reason there is none. There is no third, partial case by construction.
 */
export type CsvHeaderRenames =
  | { readonly kind: 'derived'; readonly renames: readonly CsvHeaderRename[] }
  | { readonly kind: 'unavailable'; readonly limit: CsvHeaderLimit }

/** The sniffed dialect subset the single-record scan reads with. */
export interface CsvHeaderDialect {
  readonly delimiter: string
  readonly quote: string
  readonly escape: string
  readonly newLineDelimiter: string
}

/** The head scan's answer: the record's fields, or one named limit. */
export type CsvHeaderScan =
  | { readonly kind: 'fields'; readonly fields: readonly string[] }
  | { readonly kind: 'limit'; readonly limit: CsvHeaderLimit }

/**
 * `sniff_csv` reports `NewLineDelimiter` as ESCAPE TEXT, not as bytes:
 * `hex(NewLineDelimiter)` is `5C6E` (`\` `n`, two characters) for an LF file
 * and `5C725C6E` for a CRLF file — the value is what `new_line = '…'` would be
 * written as. Everything else in the payload is a real character (`hex(Delimiter)`
 * is `09` for a tab file, `2C` for a comma; `hex(Quote)` is `22` for `"`).
 * The UNSET sentinel itself is documented once in `sniff-wire.ts`; an unset
 * `Quote`/`Escape` never reaches this map.
 */
const SNIFF_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  r: '\r',
  t: '\t',
  '\\': '\\',
}

/**
 * Decode one sniffed single-character dialect value (`Quote`, `Escape`,
 * `Delimiter`) to the characters the scan must compare against. An unset value
 * decodes to `''` (no quoting / no escape character), never to `(empty)`.
 */
export function decodeSniffedDialectChar(reported: string): string {
  return reported === SNIFF_UNSET_TEXT ? '' : reported
}

/**
 * Decode the sniffer's escape-TEXT record terminator to real characters. A
 * sequence it does not define is kept verbatim, which can only make the scan
 * stricter (an unmatched terminator ends in `'incomplete-record'`).
 */
export function decodeSniffedNewLine(reported: string): string {
  if (reported === SNIFF_UNSET_TEXT) return ''
  let decoded = ''
  for (let index = 0; index < reported.length; index += 1) {
    const char = reported[index] ?? ''
    if (char !== '\\') {
      decoded += char
      continue
    }
    const next = reported[index + 1]
    const escape = next === undefined ? undefined : SNIFF_ESCAPES[next]
    if (next === undefined || escape === undefined) {
      decoded += next === undefined ? char : char + next
      if (next !== undefined) index += 1
      continue
    }
    decoded += escape
    index += 1
  }
  return decoded
}

/** The sniffed disclosure translated into what the single-record scan reads with. */
export function sniffedDialect(sniff: CsvHeaderDialect): CsvHeaderDialect {
  return {
    delimiter: decodeSniffedDialectChar(sniff.delimiter),
    quote: decodeSniffedDialectChar(sniff.quote),
    escape: decodeSniffedDialectChar(sniff.escape),
    newLineDelimiter: decodeSniffedNewLine(sniff.newLineDelimiter),
  }
}

/**
 * The whitespace the reader trims from each header name before naming it.
 * Deliberately the ASCII whitespace set the CSV reader treats as blank, not
 * JavaScript's `\s` (which also matches U+00A0 and friends and would trim a
 * name the reader keeps).
 */
const HEADER_TRIM = /^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g

/** A header field's text with the reader's trimming applied. */
export function trimHeaderName(text: string): string {
  return text.replace(HEADER_TRIM, '')
}

/** The comparison key the reader's duplicate test uses (it is case-insensitive). */
function nameKey(name: string): string {
  return name.toLowerCase()
}

/**
 * A nested-duplicate guard, not a semantic limit: each recursion appends at
 * least two characters and the used-name set is finite, so this can never be
 * reached by a header the reader would name — it exists so the scan of a
 * pathological input still terminates.
 */
const MAX_RENAME_DEPTH = 64

/**
 * The names the reader gives a header record's raw fields, in order — the rule
 * proved in the module note. Pure and total: the only non-termination route is
 * cut by {@link MAX_RENAME_DEPTH}, which then returns `null` (the caller turns
 * that into a limit rather than an approximate name).
 */
export function renamedHeaderNames(rawNames: readonly string[]): string[] | null {
  const used = new Set<string>()
  const counters = new Map<string, number>()
  const names: string[] = []
  for (let index = 0; index < rawNames.length; index += 1) {
    const trimmed = trimHeaderName(rawNames[index] ?? '')
    // An empty name is replaced by its zero-based position, not its ordinal:
    // the reader calls the FIRST column `column0` (see `,a,b` in the note).
    const base = trimmed === '' ? `column${String(index)}` : trimmed
    const name = uniqueName(base, used, counters, 0)
    if (name === null) return null
    names.push(name)
  }
  return names
}

/** {@link renamedHeaderNames}'s per-column step: keep a free name, else suffix it. */
function uniqueName(
  base: string,
  used: Set<string>,
  counters: Map<string, number>,
  depth: number,
): string | null {
  if (depth > MAX_RENAME_DEPTH) return null
  const key = nameKey(base)
  if (!used.has(key)) {
    used.add(key)
    return base
  }
  const next = (counters.get(key) ?? 0) + 1
  counters.set(key, next)
  const candidate = `${base}_${String(next)}`
  // A suffixed candidate can already be taken by another column's real name;
  // the reader deduplicates the candidate in turn (`a,a_1,a` ⇒ `a_1_1`).
  if (used.has(nameKey(candidate))) return uniqueName(candidate, used, counters, depth + 1)
  used.add(nameKey(candidate))
  return candidate
}

/** True when `text` at `index` starts with `token` (a bounded, in-window test). */
function matchesAt(text: string, index: number, token: string): boolean {
  return token !== '' && text.startsWith(token, index)
}

/**
 * Scan **exactly one record** out of the head, honouring the sniffed dialect.
 *
 * The shape is deliberately tiny and terminating: one forward pass, one
 * accumulator, no backtracking, no rows, no coercion. It ends in one of three
 * ways — a complete record (`fields`), a named limit it will not guess past,
 * or the end of the window (`'incomplete-record'`). Limits, each a shape where
 * a guess could disagree with the engine:
 *
 * - an empty sniffed delimiter or record terminator (`'ambiguous-shape'`);
 * - a quote character in the middle of an unquoted field (`'ambiguous-shape'`
 *   — the reader's rule there is not established, so it is not assumed);
 * - an escape character outside a quoted run (`'ambiguous-shape'` — the escape
 *   only applies inside quotes here);
 * - the window's last character being an escape character, or the first half
 *   of a doubled quote (`'escape-at-window-edge'`: the next character is
 *   outside the read, so whether the field continues is unknowable);
 * - a quoted run still open at the end (`'unterminated-quote'`).
 *
 * A quoted run swallows the record terminator (that is the whole point of the
 * quoted-newline fixture), and `escape === quote` is read as doubled-quote
 * escaping — both established on the engine, see the module note.
 */
export function scanHeaderRecord(head: string, dialect: CsvHeaderDialect): CsvHeaderScan {
  const { delimiter, quote, escape, newLineDelimiter } = dialect
  if (delimiter === '' || newLineDelimiter === '') {
    return { kind: 'limit', limit: 'ambiguous-shape' }
  }
  // `Blob.text()` is UTF-8 decode and drops one leading BOM; the extra strip
  // covers a decoder that does not, so a BOM'd file is not a needless limit.
  const text = head.startsWith('\uFEFF') ? head.slice(1) : head
  const doubledQuoteEscaping = quote !== '' && escape === quote
  const fields: string[] = []
  let field = ''
  let index = 0
  let inQuotes = false
  let atFieldStart = true

  while (index < text.length) {
    const char = text[index] ?? ''
    if (inQuotes) {
      if (escape !== '' && !doubledQuoteEscaping && char === escape) {
        const escaped = text[index + 1]
        if (escaped === undefined) return { kind: 'limit', limit: 'escape-at-window-edge' }
        field += escaped
        index += 2
        continue
      }
      if (char === quote) {
        if (doubledQuoteEscaping) {
          const next = text[index + 1]
          if (next === undefined) return { kind: 'limit', limit: 'escape-at-window-edge' }
          if (next === quote) {
            field += quote
            index += 2
            continue
          }
        }
        inQuotes = false
        index += 1
        atFieldStart = false
        continue
      }
      field += char
      index += 1
      continue
    }

    if (quote !== '' && char === quote) {
      if (!atFieldStart) return { kind: 'limit', limit: 'ambiguous-shape' }
      inQuotes = true
      atFieldStart = false
      index += 1
      continue
    }
    if (escape !== '' && !doubledQuoteEscaping && char === escape) {
      return { kind: 'limit', limit: 'ambiguous-shape' }
    }
    if (matchesAt(text, index, newLineDelimiter)) {
      fields.push(field)
      return { kind: 'fields', fields }
    }
    if (matchesAt(text, index, delimiter)) {
      fields.push(field)
      field = ''
      atFieldStart = true
      index += delimiter.length
      continue
    }
    field += char
    atFieldStart = false
    index += 1
  }

  return { kind: 'limit', limit: inQuotes ? 'unterminated-quote' : 'incomplete-record' }
}

/**
 * The rename rule applied to one scanned record, then **verified** against the
 * engine's own column names. Pure: no file, no DOM, no logging — the head text
 * and the sniff payload are all it reads.
 *
 * The comparison is exact equality of the whole name list (length, text and
 * order). A count difference is reported as `'column-count'`, a text or order
 * difference as `'name-mismatch'`; both are limits, never a repaired list.
 */
export function deriveHeaderRenames(input: {
  readonly head: string
  readonly sniff: Pick<
    EngineCsvSniff,
    'delimiter' | 'quote' | 'escape' | 'newLineDelimiter' | 'skipRows' | 'hasHeader' | 'columns'
  >
  readonly declaredColumns: boolean
}): CsvHeaderRenames {
  const early = headerReadObstacle(input.sniff, input.declaredColumns)
  if (early !== null) return { kind: 'unavailable', limit: early }

  const scanned = scanHeaderRecord(
    input.head,
    sniffedDialect({
      delimiter: input.sniff.delimiter,
      quote: input.sniff.quote,
      escape: input.sniff.escape,
      newLineDelimiter: input.sniff.newLineDelimiter,
    }),
  )
  if (scanned.kind === 'limit') return { kind: 'unavailable', limit: scanned.limit }

  const renamed = renamedHeaderNames(scanned.fields)
  if (renamed === null) return { kind: 'unavailable', limit: 'ambiguous-shape' }

  const disclosed = input.sniff.columns.map((column) => column.name)
  if (renamed.length !== disclosed.length) return { kind: 'unavailable', limit: 'column-count' }
  for (let index = 0; index < disclosed.length; index += 1) {
    if (renamed[index] !== disclosed[index]) {
      return { kind: 'unavailable', limit: 'name-mismatch' }
    }
  }

  const renames: CsvHeaderRename[] = []
  for (let index = 0; index < scanned.fields.length; index += 1) {
    const original = trimHeaderName(scanned.fields[index] ?? '')
    const name = renamed[index] ?? ''
    // Only a name that actually changed is a rename; the rest of the header is
    // already on screen with its own name in the disclosure above.
    if (name !== original) renames.push({ original, renamed: name })
  }
  return { kind: 'derived', renames }
}

/**
 * The reasons that make reading the head pointless: there is no header row to
 * rename, the header is not the head's first record, or a declared column map
 * replaces the reader's naming. `null` means a head read can still decide.
 */
export function headerReadObstacle(
  sniff: Pick<EngineCsvSniff, 'skipRows' | 'hasHeader'>,
  declaredColumns: boolean,
): CsvHeaderLimit | null {
  if (!sniff.hasHeader) return 'no-header'
  if (sniff.skipRows > 0) return 'skipped-rows'
  if (declaredColumns) return 'declared-columns'
  return null
}

/**
 * The whole derivation for one preview: read the bounded head, scan its one
 * record, reconstruct and verify — or say why not. Total: a read failure is
 * `'unreadable-file'`, and this function never throws.
 *
 * `source` is the same structural file seam the engine takes (`name` +
 * `getFile()`), so the review passes exactly what it already holds.
 */
export async function readHeaderRenames(
  source: { getFile(): Promise<File> },
  sniff: Pick<
    EngineCsvSniff,
    'delimiter' | 'quote' | 'escape' | 'newLineDelimiter' | 'skipRows' | 'hasHeader' | 'columns'
  >,
  declaredColumns: boolean,
): Promise<CsvHeaderRenames> {
  const early = headerReadObstacle(sniff, declaredColumns)
  if (early !== null) return { kind: 'unavailable', limit: early }

  let head: string
  try {
    const file = await source.getFile()
    head = await file.slice(0, CSV_HEADER_HEAD_BYTES).text()
  } catch {
    // Deliberately value-free: no file name, no message, no cause (a thrown
    // DOMException can carry a path in some hosts).
    return { kind: 'unavailable', limit: 'unreadable-file' }
  }

  return deriveHeaderRenames({ head, sniff, declaredColumns })
}
