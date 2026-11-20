// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * EW-03I-b — the CSV review's option model (the pure half of the surface).
 *
 * The form is a set of plain text/select inputs; this module is the ONLY place
 * that turns it into an engine option object, and it does so through
 * `parseCsvOptions` — the engine package's total boundary validator (ADR 0049
 * items 2–3) — instead of re-deriving the vocabulary here:
 *
 * - an unknown, deferred or always-refused key is refused before dispatch;
 * - a value's shape (`header` boolean, `delim` string, `skip` non-negative
 *   safe integer, `sample_size` inside the inference budget, every declared
 *   type passing `validateEngineTypeExpression`) is decided by the engine
 *   module, not by this file;
 * - the typed reason is surfaced verbatim. It names the offending option KEY
 *   (configuration) and never a value (dataset content), which is what makes
 *   it safe to render and why no value is ever interpolated here.
 *
 * Contexts (ADR 0049 item 1): the review always parses as `'preview'`
 * (so `sample_size` is accepted), and adoption parses the same record as
 * `'open'` after {@link adoptionOptions} drops `sample_size` — the
 * preview-only option never rides `engine/open`.
 *
 * Two deliberate narrowings, stated rather than hidden:
 *
 * 1. A blank text field means "leave this to the reader". The vocabulary also
 *    allows an EMPTY STRING value (`quote=''` disables quoting, `comment=''`
 *    disables comments); the form cannot express that, because blank and
 *    empty are the same keystroke. No accepted ledger item requires it, and
 *    inventing an affordance for it is a product decision this row does not
 *    own.
 * 2. `Rows to skip first` and `Rows read to guess types` pass a non-numeric
 *    entry through as the raw STRING, so the engine vocabulary produces its
 *    own refusal ("must be a non-negative safe integer") instead of this
 *    module inventing a second message.
 *
 * B01 — a declared column name is never overwritten. The types textarea used
 * to assign `columns[name] = type` unconditionally, so a repeated name
 * (same type or not) silently kept only the LAST line: a declaration the user
 * made was lost with no notice. A repeat is now refused before dispatch with
 * a typed, value-free {@link CsvTypesRefusal} (1-based line, no name/type in
 * the sentence). Names stay case-sensitive and are compared after the same
 * trim the line grammar already applies; blank lines never lose their number.
 */
import { parseCsvOptions } from '@assay/engine-duckdb'
import type { EngineCsvEffectiveOptions, EngineCsvOptions } from '@assay/engine-duckdb'
import {
  CSV_REVIEW_TYPES_DUPLICATE_ERROR,
  CSV_REVIEW_TYPES_LINE_ERROR,
  CSV_REVIEW_TYPES_UNSUPPORTED_NAME_ERROR,
} from './copy'

/** A tri-state boolean option: left to the reader, or forced either way. */
export type CsvTriState = 'unset' | 'yes' | 'no'

/** The review form's raw input values (all strings; `''` = not set). */
export interface CsvReviewForm {
  readonly delim: string
  readonly header: CsvTriState
  readonly allVarchar: CsvTriState
  readonly sampleSize: string
  readonly nullstr: string
  readonly dateformat: string
  readonly quote: string
  readonly escape: string
  readonly comment: string
  readonly skip: string
  /** Declared column types, one `name: TYPE` per line. */
  readonly typesText: string
}

/** The empty form: every option left to the reader. */
export const EMPTY_CSV_REVIEW_FORM: CsvReviewForm = {
  delim: '',
  header: 'unset',
  allVarchar: 'unset',
  sampleSize: '',
  nullstr: '',
  dateformat: '',
  quote: '',
  escape: '',
  comment: '',
  skip: '',
  typesText: '',
}

/** One option the sample's read composed, already display-ready. */
export interface CsvEffectiveEntry {
  readonly key: string
  readonly label: string
  readonly value: string
}

/** The result of turning the form into an engine option record. */
export type CsvOptionRecordResult =
  | { readonly ok: true; readonly options: EngineCsvOptions }
  | { readonly ok: false; readonly reason: string }

/** `-1` and other signed/unsigned integer spellings become numbers. */
function numericField(value: string): number | string {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  // Every other spelling stays a string so the engine vocabulary refuses it
  // with its own sentence (never a second, locally invented one).
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : trimmed
}

/**
 * A declared-types line this module refuses: a typed, value-free internal
 * outcome. `line` is 1-based over the textarea's own lines (blank lines are
 * skipped, never renumbered). Nothing here carries the name, the type or any
 * other text the user typed — a header name is dataset content (ADR 0025).
 */
export type CsvTypesRefusal =
  | { readonly code: 'malformed-line'; readonly line: number }
  | { readonly code: 'duplicate-column'; readonly line: number }
  | { readonly code: 'unsupported-column-name'; readonly line: number }

/** The one user sentence per refusal code — never interpolates anything. */
function typesRefusalMessage(refusal: CsvTypesRefusal): string {
  switch (refusal.code) {
    case 'malformed-line':
      return CSV_REVIEW_TYPES_LINE_ERROR
    case 'duplicate-column':
      return CSV_REVIEW_TYPES_DUPLICATE_ERROR
    case 'unsupported-column-name':
      return CSV_REVIEW_TYPES_UNSUPPORTED_NAME_ERROR
  }
}

/**
 * Parse the declared-types textarea into the vocabulary's `columns` map.
 * An empty box means "no declaration" (omitted, not an empty map — the
 * vocabulary refuses an empty map, and omitting is what "no declaration"
 * means). A malformed line and a repeated name are refused by this module
 * (the engine vocabulary has no line syntax to validate); neither refusal
 * echoes the line.
 *
 * The map is built with NO prototype (`Object.create(null)`), so a declared
 * name is always a literal own key: `constructor`, `toString` and every other
 * `Object.prototype` member are ordinary column names here, never inherited
 * lookups. That is name handling, not a security claim. `__proto__` is the
 * one exception this map cannot carry honestly — a plain object assignment for
 * that name reaches the inherited accessor, and the engine's validated copy of
 * the map drops the column — so it is refused instead of silently lost.
 */
function parseTypesText(
  text: string,
): { ok: true; columns: Record<string, string> } | { ok: false; refusal: CsvTypesRefusal } {
  // Null prototype: own-key-safe construction for every literal column name.
  const columns: Record<string, string> = Object.create(null) as Record<string, string>
  if (text.trim() === '') return { ok: true, columns }
  /** Every parsed name, in the order the lines declared it. */
  const declared = new Set<string>()
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? ''
    if (line === '') continue
    const lineNumber = index + 1
    const separator = line.indexOf(':')
    if (separator <= 0) return { ok: false, refusal: { code: 'malformed-line', line: lineNumber } }
    const name = line.slice(0, separator).trim()
    const type = line.slice(separator + 1).trim()
    if (name === '' || type === '') {
      return { ok: false, refusal: { code: 'malformed-line', line: lineNumber } }
    }
    if (name === '__proto__') {
      return { ok: false, refusal: { code: 'unsupported-column-name', line: lineNumber } }
    }
    // B01: a repeat is refused BEFORE the assignment — never a last-wins
    // overwrite that would drop the earlier declaration silently.
    if (declared.has(name)) {
      return { ok: false, refusal: { code: 'duplicate-column', line: lineNumber } }
    }
    declared.add(name)
    columns[name] = type
  }
  return { ok: true, columns }
}

/**
 * The raw option record the form expresses, BEFORE validation: exactly the
 * engine vocabulary's own keys (`delim`, `header`, `all_varchar`,
 * `columns`, `sample_size`, `nullstr`, `dateformat`, `quote`, `escape`,
 * `comment`, `skip`). Unset fields are absent — never present as `undefined`,
 * which structured clone would keep as a key the worker then refuses.
 */
export function formOptionRecord(
  form: CsvReviewForm,
):
  | { readonly ok: true; readonly record: Record<string, unknown> }
  | { readonly ok: false; readonly refusal: CsvTypesRefusal } {
  const record: Record<string, unknown> = {}
  const text = (key: string, value: string): void => {
    const trimmed = value.trim()
    if (trimmed !== '') record[key] = trimmed
  }
  text('delim', form.delim)
  text('nullstr', form.nullstr)
  text('dateformat', form.dateformat)
  text('quote', form.quote)
  text('escape', form.escape)
  text('comment', form.comment)
  const tri = (key: string, value: CsvTriState): void => {
    if (value === 'yes') record[key] = true
    if (value === 'no') record[key] = false
  }
  tri('header', form.header)
  tri('all_varchar', form.allVarchar)
  if (form.sampleSize.trim() !== '') record['sample_size'] = numericField(form.sampleSize)
  if (form.skip.trim() !== '') record['skip'] = numericField(form.skip)
  const types = parseTypesText(form.typesText)
  if (!types.ok) return { ok: false, refusal: types.refusal }
  if (Object.keys(types.columns).length > 0) record['columns'] = types.columns
  return { ok: true, record }
}

/**
 * The review's option set: the form composed through the engine vocabulary for
 * the PREVIEW context, or the vocabulary's typed (value-free) refusal.
 */
export function previewOptions(form: CsvReviewForm): CsvOptionRecordResult {
  const built = formOptionRecord(form)
  if (!built.ok) return { ok: false, reason: typesRefusalMessage(built.refusal) }
  const parsed = parseCsvOptions(built.record, 'preview')
  return parsed.ok ? { ok: true, options: parsed.options } : { ok: false, reason: parsed.reason }
}

/**
 * The adoption set: exactly the reviewed options with `sample_size` removed
 * (ADR 0049 item 1 — inference input only, refused on `engine/open`). Values
 * are deep-copied so a request cannot alias the review's state.
 */
export function adoptionOptions(options: EngineCsvOptions): EngineCsvOptions {
  const adopted: EngineCsvOptions = {}
  if (options.header !== undefined) adopted.header = options.header
  if (options.delim !== undefined) adopted.delim = options.delim
  if (options.quote !== undefined) adopted.quote = options.quote
  if (options.escape !== undefined) adopted.escape = options.escape
  if (options.columns !== undefined) adopted.columns = { ...options.columns }
  if (options.all_varchar !== undefined) adopted.all_varchar = options.all_varchar
  if (options.nullstr !== undefined) adopted.nullstr = options.nullstr
  if (options.dateformat !== undefined) adopted.dateformat = options.dateformat
  if (options.comment !== undefined) adopted.comment = options.comment
  if (options.skip !== undefined) adopted.skip = options.skip
  return adopted
}

/** Canonical display order + labels for the effective-option disclosure. */
const EFFECTIVE_LABELS: readonly (readonly [keyof EngineCsvEffectiveOptions, string])[] = [
  ['header', 'First row is a header'],
  ['delim', 'Delimiter'],
  ['quote', 'Quote character'],
  ['escape', 'Escape character'],
  ['columns', 'Column types'],
  ['all_varchar', 'All columns as text'],
  ['nullstr', 'Text that means NULL'],
  ['dateformat', 'Date format'],
  ['comment', 'Comment prefix'],
  ['skip', 'Rows to skip first'],
  ['sample_size', 'Rows read to guess types'],
]

/** Render one raw option value without ever quoting it as dataset content. */
function displayOptionValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Record<string, string>)
      .map(([name, type]) => `${name}: ${type}`)
      .join(', ')
  }
  return ''
}

/**
 * The effective option set the engine composed, as display rows. Order is
 * fixed (the vocabulary's canonical order), so the disclosure cannot reorder
 * itself between previews.
 */
export function effectiveOptionEntries(options: EngineCsvEffectiveOptions): CsvEffectiveEntry[] {
  const entries: CsvEffectiveEntry[] = []
  for (const [key, label] of EFFECTIVE_LABELS) {
    const value = options[key]
    if (value === undefined) continue
    entries.push({ key, label, value: displayOptionValue(value) })
  }
  return entries
}

/**
 * A stable identity for one option set, used to decide whether the sample on
 * screen still belongs to the options in the form (a stale sample is never
 * presented as current, and adoption is blocked while stale). Key order is
 * canonical, so two identical sets always produce one string.
 */
export function optionsFingerprint(options: EngineCsvOptions): string {
  return JSON.stringify(adoptionOptions(options))
}

/**
 * The wire record for one option set: a fresh plain object, or `undefined` when
 * nothing is set — so the no-options request stays byte-identical to the
 * pre-EW-03I quick open (ADR 0049 "Neutral").
 */
export function wireCsvOptions(options: EngineCsvOptions): Record<string, unknown> | undefined {
  return Object.keys(options).length === 0 ? undefined : { ...options }
}
