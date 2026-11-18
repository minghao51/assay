// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * EW-03I-b — the CSV review surface's copy (ADR 0049 decisions 6–7; EW-03D
 * §3/§5/§6/§8 accepted as a block).
 *
 * Constant-only, exactly like `replace/messages.ts`: nothing here interpolates
 * engine text, a filename, a path or a dataset value. The two composed
 * sentences are built explicitly and take only *engine configuration*
 * numbers (`rowCap`, `skipRows`) or the engine's own **value-free** option
 * refusal reason (which names an option KEY, never a value — `parseCsvOptions`
 * is total and bounded); cell values and the picked file's name reach no
 * string in this module.
 *
 * The truth constraints these strings carry are the ledger items the
 * post-R1 acceptance record accepted as a block, and each is pinned by a
 * literal in `CsvReviewDialog.test.tsx`:
 *
 * - **D6** — an empty field and a quoted empty field both read as NULL by
 *   default, and no setting separates them (`NULL_DEFAULT`, `NULL_DEFAULT_2`).
 * - **D5** — the sniffed date/timestamp types and format are disclosed and
 *   nothing infers a locale or a date order (`DATES`).
 * - **D3** — duplicate/empty header names are renamed by the reader, the
 *   names shown are the post-rename names, and the per-file rename LIST is
 *   disclosed from a verified head read (`HEADER_RENAMES*`): which original
 *   name became which name, before adoption. When that list cannot be derived
 *   safely the behaviour sentence stands alone with one honest limit
 *   sentence — never a partial or best-guess list (see `header-renames.ts`).
 * - **D14** — unsafe integers: a DOUBLE guess corrupts digits beyond 2^53,
 *   with the type/all-text escape offered and nothing forced (`UNSAFE_INTS`).
 * - **D13/D8** — no silent row-skip, and a sample is never an evaluation of
 *   the whole file (`NO_ROW_SKIP`, `SAMPLE_SCOPE`).
 * - **ADR 0049 item 1** — `sample_size` governs inference only and never rides
 *   the adoption open (`SAMPLE_SIZE_SCOPE`).
 * - **ADR 0049 item 7** — abandonment says "stopped reviewing", never
 *   "aborted", and never claims or implies an engine release (`STOPPED*`).
 *
 * PROHIBITED WORDING (ADR 0049 item 6, pinned by a negative assertion over the
 * whole rendered surface): a sample is never described as validated, checked,
 * verified or confirmed, and no success/✓ state accompanies it. For that
 * reason those four words — including their negations — appear nowhere in this
 * module: the sample copy says what a sample *is* ("not an evaluation of the
 * whole file") instead of negating a verdict nobody rendered.
 */

/** The one control label for both entry points (idle and ready). */
export const CSV_REVIEW_ACTION = 'Review CSV options…'

/** Idle-surface helper beside the entry control (discoverability, not a claim). */
export const CSV_REVIEW_IDLE_HELPER =
  'Choose a .csv file to see the dialect the reader guesses, the column types, and a bounded sample before anything is opened.'

/** The review dialog's accessible name and heading. */
export const CSV_REVIEW_TITLE = 'Review CSV options'

/** The non-adoption promise, stated at the top of the surface. */
export const CSV_REVIEW_SCOPE =
  'This review opens nothing. The file stays a candidate until you choose Open this file.'

/** Adopt control. */
export const CSV_REVIEW_ADOPT = 'Open this file'

/** What adoption does, per where the review was started from. */
export const CSV_REVIEW_ADOPT_HELPER_IDLE =
  'Opens the file with the options this sample used, over the whole file.'
export const CSV_REVIEW_ADOPT_HELPER_REPLACE =
  'Opens the file with the options this sample used and replaces this session.'

/** Stop control + the abandonment notices (ADR 0049 item 7). */
export const CSV_REVIEW_STOP = 'Stop reviewing'
export const CSV_REVIEW_STOPPED = 'You stopped reviewing. Nothing was opened.'
export const CSV_REVIEW_STOPPED_SESSION = 'This session is unchanged.'

/** Read options section. */
export const CSV_REVIEW_OPTIONS_HEADING = 'Read options'
export const CSV_REVIEW_OPTIONS_SCOPE =
  'Anything left unset stays the reader’s guess. An option the reader does not accept is refused here, before anything is read.'

/** One select control that can stay at the reader's own choice. */
export const CSV_REVIEW_UNSET_OPTION = 'Reader choice'
export const CSV_REVIEW_YES = 'Yes'
export const CSV_REVIEW_NO = 'No'

export const CSV_REVIEW_DELIM_LABEL = 'Delimiter'
export const CSV_REVIEW_DELIM_HELPER =
  'One character, for example ; or |. The reader accepts delim only; delimiter and separator are refused.'
export const CSV_REVIEW_HEADER_LABEL = 'First row is a header'
export const CSV_REVIEW_ALL_VARCHAR_LABEL = 'All columns as text'
export const CSV_REVIEW_SAMPLE_SIZE_LABEL = 'Rows read to guess types'
export const CSV_REVIEW_SAMPLE_SIZE_HELPER =
  'Inference only. 0 reads no rows; -1 (every row) is refused.'
export const CSV_REVIEW_NULLSTR_LABEL = 'Text that means NULL'
export const CSV_REVIEW_DATEFORMAT_LABEL = 'Date format'
export const CSV_REVIEW_QUOTE_LABEL = 'Quote character'
export const CSV_REVIEW_ESCAPE_LABEL = 'Escape character'
export const CSV_REVIEW_COMMENT_LABEL = 'Comment prefix'
export const CSV_REVIEW_SKIP_LABEL = 'Rows to skip first'
export const CSV_REVIEW_TYPES_LABEL = 'Column types'
export const CSV_REVIEW_TYPES_HELPER =
  'One column per line, as name: TYPE (for example id: BIGINT). A type the reader does not accept is refused before it is sent.'

/** Our own line-shape refusal: never echoes the typed line (it can name a header). */
export const CSV_REVIEW_TYPES_LINE_ERROR = 'Each line must read name: TYPE.'

/** Update-sample control and the staleness note. */
export const CSV_REVIEW_UPDATE_SAMPLE = 'Update sample'
export const CSV_REVIEW_SAMPLE_STALE =
  'These options changed after the sample was read. Choose Update sample so the sample and the disclosure match what Open this file would use.'
export const CSV_REVIEW_SAMPLE_LOADING = 'Reading the sample…'
export const CSV_REVIEW_SAMPLE_MISSING = 'No sample was requested.'

/** Sniff disclosure section (ADR 0049 item 6). */
export const CSV_REVIEW_SNIFF_HEADING = 'What the reader inferred from the head of the file'
export const CSV_REVIEW_SNIFF_NOTE =
  'These are the reader’s own settings and types, inferred from a sample of rows. They describe how the file will be read, not what it contains.'
export const CSV_REVIEW_SNIFF_DELIMITER = 'Delimiter'
export const CSV_REVIEW_SNIFF_QUOTE = 'Quote'
export const CSV_REVIEW_SNIFF_ESCAPE = 'Escape'
export const CSV_REVIEW_SNIFF_NEWLINE = 'Newline'
export const CSV_REVIEW_SNIFF_COMMENT = 'Comment prefix'
export const CSV_REVIEW_SNIFF_SKIP = 'Rows skipped before the first data row'
export const CSV_REVIEW_SNIFF_HEADER = 'First row is a header'
export const CSV_REVIEW_SNIFF_COLUMNS = 'Column names and types'
export const CSV_REVIEW_SNIFF_DATEFORMAT = 'Date format'
export const CSV_REVIEW_SNIFF_TIMESTAMPFORMAT = 'Timestamp format'
export const CSV_REVIEW_SNIFF_PROMPT_HEADING = 'The read_csv call for these settings'
export const CSV_REVIEW_SNIFF_PROMPT_NOTE =
  'Display text only. It names the reader’s staging name, not your file, and nothing here runs it.'
export const CSV_REVIEW_NONE_VALUE = 'None'

/** Effective-options disclosure: exactly what the sample's read composed. */
export const CSV_REVIEW_EFFECTIVE_HEADING = 'Options this sample used'
export const CSV_REVIEW_EFFECTIVE_NONE =
  'No option was set, so the read used the reader’s guess for every setting.'

/** A pre-dispatch refusal (the engine vocabulary's own value-free reason). */
export const CSV_REVIEW_REFUSAL_PREFIX = 'These options were not sent: '
export const CSV_REVIEW_REFUSAL_SUFFIX = ' The sample below is unchanged.'

/** The sample table. */
export const CSV_REVIEW_SAMPLE_HEADING = 'Bounded sample'
export const CSV_REVIEW_SAMPLE_MORE = 'The file holds more rows than this sample shows.'

/**
 * The sample's own boundary, from the response's applied cap (ADR 0049 item 6:
 * the cap is STATED, never implied). `rowCap` is engine configuration, not
 * dataset content.
 */
export function csvReviewSampleCap(rowCap: number): string {
  return `Sample cap: the first ${String(rowCap)} rows of the file.`
}

/**
 * D8/D13 carried: a sample is not the complete evaluation, and a failure past
 * it is normal rather than exceptional.
 */
export const CSV_REVIEW_SAMPLE_SCOPE =
  'A sample is not an evaluation of the whole file. A value the column type cannot take can appear past these rows, and that is normal: the dataset is read in full when it is opened, and such a row fails that read.'

/** Sample-table column header for the declared/engine type. */
export const CSV_REVIEW_COLUMN_TYPE_TITLE = 'Type'

/** How a NULL cell is rendered in the sample (never a blank cell). */
export const CSV_REVIEW_NULL_CELL = 'NULL'

/**
 * The sample's columns must agree with the disclosure the engine returned;
 * a mismatch is a reader deviation this surface refuses to paper over.
 */
export const CSV_REVIEW_COLUMN_MISMATCH =
  'The sample does not match the column list the reader reported, so it is not shown.'

/**
 * The ledger disclosures, rendered together below the sample. Every one is a
 * sentence the accepted record requires to be present before adoption.
 */
export const CSV_REVIEW_MEANING_HEADING = 'What the default settings mean'

/** D6 — empty and quoted-empty both read as NULL; no setting separates them. */
export const CSV_REVIEW_NULL_DEFAULT =
  'By default an empty field and a quoted empty field both read as NULL, and the reader has no setting that tells them apart.'
export const CSV_REVIEW_NULL_DEFAULT_2 =
  'Naming a text that means NULL replaces an empty field with that text instead; the two shapes still read the same.'

/** D5 — temporal types/format disclosed, never inferred from a locale. */
export const CSV_REVIEW_DATES =
  'A date or timestamp column keeps the type the reader guessed, and the guessed format is shown above. No locale or date-order inference is applied: only a date format set here overrides the guess.'

/**
 * D3 — the reader renames duplicate and empty header names. This sentence is
 * the FALLBACK when the per-file list cannot be derived safely, and the
 * statement of the rule the verified list is an instance of.
 */
export const CSV_REVIEW_HEADER_RENAMES =
  'The reader renames duplicate and empty header names on its own: an empty name becomes column1, column2, … and a repeated name gets a numeric suffix such as id_1. The names above are the names after those renames, and they are the names the opened dataset will have.'

/**
 * D3 — the verified per-file rename list. This lead-in replaces the fallback
 * sentence when the head read agreed with the engine exactly; the pairs that
 * follow are that file's own header names.
 */
export const CSV_REVIEW_HEADER_RENAMES_LIST =
  'The reader renames duplicate and empty header names on its own. This is what it renamed in this file’s header:'

/** One listed pair's separator (`<original> → <renamed>`), rendered as text. */
export const CSV_REVIEW_HEADER_RENAME_ARROW = '→'

/** How a listed pair shows an original header name that was empty. */
export const CSV_REVIEW_HEADER_RENAME_EMPTY = '(empty name)'

/** D3 — verified, and the reader renamed nothing in this file's header. */
export const CSV_REVIEW_HEADER_RENAMES_NONE =
  'The reader renamed nothing in this header: every name above is the name the file itself uses.'

/**
 * D3 — the honest limit. The engine never failed and is never blamed: this
 * surface declines to show a list it could not derive from the file's head
 * with certainty, because a wrong list would name a column wrongly.
 */
export const CSV_REVIEW_HEADER_RENAMES_UNAVAILABLE =
  'No per-file rename list is shown for this file: it could not be derived safely from the head of the file.'

/** D14 — unsafe integers, with the escape offered and nothing forced. */
export const CSV_REVIEW_UNSAFE_INTS =
  'A whole number column can be guessed as DOUBLE, and whole numbers above 2^53 lose precision that way: 9007199254740993 reads as 9007199254740992. Reading every column as text, or declaring an exact type for the column, keeps the digits; nothing here forces a type.'

/** D13 — no silent row-skip, on the refusal evidence. */
export const CSV_REVIEW_NO_ROW_SKIP =
  'Rows are never skipped silently. The row-dropping and reject-table options are refused, so a row the reader cannot parse fails the read instead of disappearing.'

/** ADR 0049 item 1 — inference only; `sample_size` never rides the adoption. */
export const CSV_REVIEW_SAMPLE_SIZE_SCOPE =
  'The number of rows read to guess types applies to this review only. It never applies to the opened dataset, which guesses its own types, so a column type can differ after opening.'

/** The dialog's close affordance is the STOP control; no second dismissal path. */
export const CSV_REVIEW_SAMPLE_TABLE_CAPTION = 'Bounded sample, read-only'
