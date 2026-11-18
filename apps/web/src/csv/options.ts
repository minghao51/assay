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
 */
import { parseCsvOptions } from '@assay/engine-duckdb'
import type { EngineCsvEffectiveOptions, EngineCsvOptions } from '@assay/engine-duckdb'
import { CSV_REVIEW_TYPES_LINE_ERROR } from './copy'

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
 * Parse the declared-types textarea into the vocabulary's `columns` map.
 * An empty box means "no declaration" (omitted, not an empty map — the
 * vocabulary refuses an empty map, and omitting is what "no declaration"
 * means). A malformed line is refused by this module because the engine
 * vocabulary has no line syntax to validate; the refusal never echoes the
 * line (a header name is dataset content).
 */
function parseTypesText(
  text: string,
): { ok: true; columns: Record<string, string> } | { ok: false } {
  if (text.trim() === '') return { ok: true, columns: {} }
  const columns: Record<string, string> = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const separator = line.indexOf(':')
    if (separator <= 0) return { ok: false }
    const name = line.slice(0, separator).trim()
    const type = line.slice(separator + 1).trim()
    if (name === '' || type === '') return { ok: false }
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
): { readonly ok: true; readonly record: Record<string, unknown> } | { readonly ok: false } {
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
  if (!types.ok) return { ok: false }
  if (Object.keys(types.columns).length > 0) record['columns'] = types.columns
  return { ok: true, record }
}

/**
 * The review's option set: the form composed through the engine vocabulary for
 * the PREVIEW context, or the vocabulary's typed (value-free) refusal.
 */
export function previewOptions(form: CsvReviewForm): CsvOptionRecordResult {
  const built = formOptionRecord(form)
  if (!built.ok) return { ok: false, reason: CSV_REVIEW_TYPES_LINE_ERROR }
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
