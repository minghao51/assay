// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * B02 — the CSV review's **display adapter** for the `sniff_csv` dialect
 * payload (ENG-3; plan B02).
 *
 * The engine transports `sniff_csv`'s own TEXT evidence verbatim: an unset
 * `Quote`/`Escape`/`Comment` arrives as the literal seven characters
 * `(empty)`, and `NewLineDelimiter` arrives as ESCAPE TEXT (`\n`, `\r\n`). That
 * representation is deliberately kept on the wire — normalising it inside the
 * engine would make D3-1's per-file header scan see the sentinel shape as
 * `'ambiguous-shape'` and silently disable the rename list. So the sentinel is
 * interpreted HERE, once, for display.
 *
 * The three states this adapter distinguishes, and why:
 *
 * - **value** — the reader reported a real setting; control characters are
 *   escaped so a tab/newline cannot reflow the disclosure.
 * - **disabled** — the setting is genuinely OFF for this read: comments have no
 *   prefix configured (the reader has no comment prefix by default), or an
 *   empty-string option (`quote = ''`, `escape = ''`, `comment = ''`)
 *   explicitly turned it off. Only this state renders as `None`.
 * - **not-inferred** — the reader did not infer this setting from the sample
 *   (`Quote`/`Escape` `(empty)` with no explicit option, a null date/timestamp
 *   format). This is NOT "off": the reader's default still applies, so it must
 *   not claim `None`.
 *
 * # Not parser input
 *
 * Everything here is render text: `displaySniffDialect` returns a display
 * record and never a decoded value. The one decode the single-record header
 * scan may use lives in `header-renames.ts` (`sniffedDialect`), which imports
 * nothing from this module; a test pins that boundary, and
 * `header-renames.test.ts` pins that feeding display text into the scan fails
 * to read a record. Pure and total: no DOM, no logging, no values in errors
 * (nothing throws).
 */
import type { EngineCsvEffectiveOptions } from '@assay/engine-duckdb'
import { CSV_REVIEW_NONE_VALUE, CSV_REVIEW_NOT_INFERRED } from './copy'
import { SNIFF_UNSET_TEXT } from './sniff-wire'

/** The sniff payload's dialect fields (the effective-option set names them too). */
export type CsvDialectField = 'delimiter' | 'quote' | 'escape' | 'newLineDelimiter' | 'comment'

/** Why a field renders the text it does. */
export type CsvDialectDisplayState = 'value' | 'disabled' | 'not-inferred'

/** One field's display record: the reason and the exact text to render. */
export interface CsvDialectDisplay {
  readonly state: CsvDialectDisplayState
  readonly text: string
}

/**
 * The effective-option key that can DISABLE each field. `newLineDelimiter` has
 * no option in the closed vocabulary (a record terminator cannot be withdrawn),
 * so it can only ever be a value or not-inferred.
 */
const OPTION_KEY: Readonly<Record<CsvDialectField, keyof EngineCsvEffectiveOptions | null>> = {
  delimiter: 'delim',
  quote: 'quote',
  escape: 'escape',
  newLineDelimiter: null,
  comment: 'comment',
}

/**
 * Control characters escaped for display, so a dialect value cannot reflow or
 * inject a blank line into the disclosure. This is TEXT for a screen only.
 */
const DISPLAY_ESCAPES: Readonly<Record<string, string>> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\u0000': '\\0',
}

/** Escape the control characters a dialect value can carry, for display only. */
function escapeForDisplay(value: string): string {
  let escaped = ''
  for (const char of value) escaped += DISPLAY_ESCAPES[char] ?? char
  return escaped
}

/**
 * Display one sniffed dialect field.
 *
 * `effectiveOptions` is the option set the preview actually composed (it is
 * disclosed on the same response), and it is what makes "disabled" knowable: an
 * explicit empty string is the reader being told to turn the setting off. The
 * raw payload alone cannot distinguish "the reader has no quote character
 * inferred" from "quoting was disabled", so it must not claim either.
 */
export function displaySniffDialect(
  field: CsvDialectField,
  raw: string,
  effectiveOptions: EngineCsvEffectiveOptions = {},
): CsvDialectDisplay {
  const optionKey = OPTION_KEY[field]
  const effective = optionKey === null ? undefined : effectiveOptions[optionKey]
  const effectiveText = typeof effective === 'string' ? effective : undefined
  // An explicit literal `(empty)` option value is a REAL value, not the
  // sentinel — the effective set disambiguates it.
  const isSentinel = raw === SNIFF_UNSET_TEXT && effectiveText !== SNIFF_UNSET_TEXT
  if (!isSentinel) {
    // `''` is not a value the sniffer produces; it means "no evidence at all"
    // (a fake or an older payload), which is still not a disabled setting.
    if (raw === '') return { state: 'not-inferred', text: CSV_REVIEW_NOT_INFERRED }
    return { state: 'value', text: escapeForDisplay(raw) }
  }
  if (effectiveText === '') return { state: 'disabled', text: CSV_REVIEW_NONE_VALUE }
  // No comment prefix configured is the reader's own "comments off": the
  // sniffer never infers one, and the default read has none in effect.
  if (field === 'comment') return { state: 'disabled', text: CSV_REVIEW_NONE_VALUE }
  return { state: 'not-inferred', text: CSV_REVIEW_NOT_INFERRED }
}

/**
 * Display one nullable sniff TEXT field (`DateFormat`/`TimestampFormat`). A
 * null means the reader inferred no such format — an absent inference, never a
 * disabled setting, so it does not read as `None`.
 */
export function displaySniffText(value: string | null): CsvDialectDisplay {
  if (value === null || value === '')
    return { state: 'not-inferred', text: CSV_REVIEW_NOT_INFERRED }
  return { state: 'value', text: escapeForDisplay(value) }
}

/**
 * Display one EFFECTIVE dialect option value (what the read composed). Only
 * `quote`/`escape`/`comment` can be present as `''`, which is the reader being
 * told to turn that setting off — the one case that reads as `None` here.
 */
export function displayEffectiveDialectOption(value: string): string {
  return value === '' ? CSV_REVIEW_NONE_VALUE : escapeForDisplay(value)
}
