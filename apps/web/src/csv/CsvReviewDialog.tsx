// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * EW-03I-b — the CSV review surface (non-adopting preview, then adoption).
 *
 * A **native `<dialog>` opened with `showModal()`** — the Help/ReplaceGuard
 * pattern (UA top layer, UA focus scope, `Escape` arriving as the native
 * `cancel` event). No new modal library, no new focus-trap implementation, no
 * click-outside dismissal.
 *
 * What it is (ADR 0049 decisions 4/6/7; EW-03D §5/§6):
 *
 * - **Non-adopting.** It calls `engineClient.csvPreview` only. It never calls
 *   `open`, never writes a session table, never sets a phase and never touches
 *   a `TableRegistry`. `previewId` is display bookkeeping — no protocol op
 *   accepts it, so this surface cannot promote anything by accident.
 * - **Honest about a sample.** The rows are a bounded read with the applied cap
 *   stated, formatted through the grid's own cell formatter, with NULL rendered
 *   as NULL. A sample is never presented as a verdict (ADR 0049 item 6): the
 *   copy says what a sample is and that a failure past it is normal, and the
 *   whole surface is pinned by a negative assertion over the prohibited words
 *   (see `copy.ts`).
 * - **Adoption carries the reviewed set.** The one way out is
 *   {@link CsvReviewDialogProps.onAdopt}, which receives the *exact*
 *   `parsedCsvOptions` record the sample on screen was read with, minus
 *   `sample_size`. While those two disagree (a form edit, a refusal, a read in
 *   flight, a failed read) adoption is disabled and the surface says the sample
 *   is stale — so "adopt the reviewed options" cannot drift from "the options
 *   that produced the sample".
 * - **Abandonment is honest.** Closing says "stopped reviewing"; it drops the
 *   local state and every late result (a generation guard), and it claims
 *   nothing about the engine: there is no host-reachable release op, so one
 *   staged preview is retained until the next preview, an open or `dispose`
 *   (envelope §5a — a recorded deviation from ADR 0049 decision 4's "on
 *   abandonment" clause, carried in the changeset rather than papered over
 *   here).
 *
 * D3 note (behaviour disclosure, not a derived rename list). EW-03D's D3
 * wording prefers the rename LIST. Deriving it would mean splitting the header
 * line on the main thread using the sniffed delimiter/quote — which is a CSV
 * parser (quoted delimiters and quoted newlines are exactly the cases where a
 * naive head split disagrees with the engine, and the fixture set has no
 * `quoted-newline` shape at all). This row therefore discloses the rename
 * BEHAVIOUR plus the engine's post-rename names, and reports the deviation
 * rather than shipping a quietly weaker or unsound splitter.
 *
 * Privacy (ADR 0025): the picked file's name/path is never rendered, logged or
 * attached to an error. Sample values are rendered as text and nothing else —
 * cell text reaches no `console.*`, no error string and no telemetry field.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { engineErrorMessage } from '../edit/session'
import type {
  EngineCsvEffectiveOptions,
  EngineCsvOptions,
  EngineCsvOptionsInput,
  EngineCsvPreviewResult,
  EngineCsvSniff,
  EngineFileSource,
} from '@assay/engine-duckdb'
import {
  CSV_REVIEW_ADOPT,
  CSV_REVIEW_ADOPT_HELPER_IDLE,
  CSV_REVIEW_ADOPT_HELPER_REPLACE,
  CSV_REVIEW_ALL_VARCHAR_LABEL,
  CSV_REVIEW_COLUMN_MISMATCH,
  CSV_REVIEW_COLUMN_TYPE_TITLE,
  CSV_REVIEW_COMMENT_LABEL,
  CSV_REVIEW_DATEFORMAT_LABEL,
  CSV_REVIEW_DATES,
  CSV_REVIEW_DELIM_HELPER,
  CSV_REVIEW_DELIM_LABEL,
  CSV_REVIEW_EFFECTIVE_HEADING,
  CSV_REVIEW_EFFECTIVE_NONE,
  CSV_REVIEW_ESCAPE_LABEL,
  CSV_REVIEW_HEADER_LABEL,
  CSV_REVIEW_HEADER_RENAMES,
  CSV_REVIEW_MEANING_HEADING,
  CSV_REVIEW_NO,
  CSV_REVIEW_NO_ROW_SKIP,
  CSV_REVIEW_NULL_DEFAULT,
  CSV_REVIEW_NULL_DEFAULT_2,
  CSV_REVIEW_NULLSTR_LABEL,
  CSV_REVIEW_OPTIONS_HEADING,
  CSV_REVIEW_OPTIONS_SCOPE,
  CSV_REVIEW_QUOTE_LABEL,
  CSV_REVIEW_REFUSAL_PREFIX,
  CSV_REVIEW_REFUSAL_SUFFIX,
  CSV_REVIEW_SAMPLE_HEADING,
  CSV_REVIEW_SAMPLE_LOADING,
  CSV_REVIEW_SAMPLE_MISSING,
  CSV_REVIEW_SAMPLE_MORE,
  CSV_REVIEW_SAMPLE_SCOPE,
  CSV_REVIEW_SAMPLE_SIZE_HELPER,
  CSV_REVIEW_SAMPLE_SIZE_LABEL,
  CSV_REVIEW_SAMPLE_SIZE_SCOPE,
  CSV_REVIEW_SAMPLE_STALE,
  CSV_REVIEW_SAMPLE_TABLE_CAPTION,
  CSV_REVIEW_SCOPE,
  CSV_REVIEW_SNIFF_COLUMNS,
  CSV_REVIEW_SNIFF_COMMENT,
  CSV_REVIEW_SNIFF_DATEFORMAT,
  CSV_REVIEW_SNIFF_DELIMITER,
  CSV_REVIEW_SNIFF_ESCAPE,
  CSV_REVIEW_SNIFF_HEADER,
  CSV_REVIEW_SNIFF_HEADING,
  CSV_REVIEW_SNIFF_NEWLINE,
  CSV_REVIEW_SNIFF_NOTE,
  CSV_REVIEW_SNIFF_PROMPT_HEADING,
  CSV_REVIEW_SNIFF_PROMPT_NOTE,
  CSV_REVIEW_SNIFF_QUOTE,
  CSV_REVIEW_SNIFF_SKIP,
  CSV_REVIEW_SNIFF_TIMESTAMPFORMAT,
  CSV_REVIEW_SKIP_LABEL,
  CSV_REVIEW_STOP,
  CSV_REVIEW_TITLE,
  CSV_REVIEW_TYPES_HELPER,
  CSV_REVIEW_TYPES_LABEL,
  CSV_REVIEW_UNSAFE_INTS,
  CSV_REVIEW_UNSET_OPTION,
  CSV_REVIEW_UPDATE_SAMPLE,
  CSV_REVIEW_YES,
  csvReviewSampleCap,
} from './copy'
import {
  EMPTY_CSV_REVIEW_FORM,
  adoptionOptions,
  effectiveOptionEntries,
  optionsFingerprint,
  previewOptions,
  wireCsvOptions,
} from './options'
import type { CsvEffectiveEntry, CsvReviewForm, CsvTriState } from './options'
import { displayBoolean, displayDialect, displayNullableText, toPreviewView } from './preview'
import type { CsvPreviewView } from './preview'

/**
 * The sample cap this row applies (ADR 0049 acceptance resolution 8 leaves the
 * number to the runtime row; `MAX_RANGE_ROWS` is 1000, so this stays well
 * inside it and inside the engine's own clamp). The cap the WORKER applied
 * arrives in the response (`rowCap`) and is what the UI states — this constant
 * only asks.
 */
export const CSV_PREVIEW_SAMPLE_ROWS = 50

/** Where the review was started from: no live session, or a ready replacement. */
export type CsvReviewMode = 'idle' | 'replace'

/** The last successful projection plus the in-flight/failed bookkeeping. */
export interface CsvReviewState {
  /** The newest successful projection, or null before the first one settles. */
  readonly view: CsvPreviewView | null
  /** Fingerprint of the option set that produced `view`. */
  readonly viewFingerprint: string | null
  /** A preview read is in flight. */
  readonly loading: boolean
  /** The last read failed; its framed, value-free sentence. */
  readonly failure: string | null
}

const INITIAL_STATE: CsvReviewState = {
  view: null,
  viewFingerprint: null,
  loading: false,
  failure: null,
}

/**
 * The sample on screen belongs to the options currently in the form, and no
 * read is in flight or failed — the only state in which adoption is offered.
 */
export function reviewIsAdoptable(
  state: CsvReviewState,
  currentFingerprint: string | null,
): boolean {
  if (currentFingerprint === null) return false
  if (state.loading || state.failure !== null || state.view === null) return false
  return state.viewFingerprint === currentFingerprint
}

/**
 * True when a sample is shown that does NOT belong to the current options.
 * A read in flight is not "stale copy" — it has its own status line — so this
 * stays false while loading and describes exactly the settled mismatch case.
 */
export function reviewIsStale(state: CsvReviewState, currentFingerprint: string | null): boolean {
  if (state.view === null) return false
  if (state.loading) return false
  return currentFingerprint === null || state.viewFingerprint !== currentFingerprint
}

export interface CsvReviewDialogProps {
  readonly mode: CsvReviewMode
  /** The reviewed candidate (already known to be a `.csv` by the caller). */
  readonly source: EngineFileSource
  /**
   * The engine preview call. Injected so unit/RTL tests drive this surface
   * without an engine worker; `App` passes `engineClient.csvPreview`.
   */
  readonly requestPreview: (
    source: EngineFileSource,
    options?: EngineCsvOptionsInput,
    sampleRows?: number,
  ) => Promise<EngineCsvPreviewResult>
  /**
   * Adoption: receives the exact reviewed option set (`sample_size` removed —
   * ADR 0049 item 1). Called at most once per surface instance.
   */
  readonly onAdopt: (options: EngineCsvOptions) => void
  /** Abandonment (Stop, or Escape's native cancel). */
  readonly onStop: () => void
}

/** The dialog's sequential-navigation stops, in document order. */
function focusableStops(dialog: HTMLDialogElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  )
}

/** One labelled text input. */
function TextField(props: {
  readonly id: string
  readonly testId: string
  readonly label: string
  readonly helper?: string
  readonly value: string
  readonly maxLength?: number
  readonly placeholder?: string
  readonly onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="csv-review-field">
      <label htmlFor={props.id} className="csv-review-label">
        {props.label}
      </label>
      <input
        id={props.id}
        data-testid={props.testId}
        className="csv-review-input"
        type="text"
        value={props.value}
        maxLength={props.maxLength}
        placeholder={props.placeholder}
        onChange={(event) => {
          props.onChange(event.target.value)
        }}
      />
      {props.helper === undefined ? null : (
        <p className="csv-review-helper" data-testid={`${props.testId}-helper`}>
          {props.helper}
        </p>
      )}
    </div>
  )
}

/** One labelled tri-state select (reader choice / yes / no). */
function TriStateField(props: {
  readonly id: string
  readonly testId: string
  readonly label: string
  readonly value: CsvTriState
  readonly onChange: (value: CsvTriState) => void
}): React.JSX.Element {
  return (
    <div className="csv-review-field">
      <label htmlFor={props.id} className="csv-review-label">
        {props.label}
      </label>
      <select
        id={props.id}
        data-testid={props.testId}
        className="csv-review-select"
        value={props.value}
        onChange={(event) => {
          props.onChange(event.target.value as CsvTriState)
        }}
      >
        <option value="unset">{CSV_REVIEW_UNSET_OPTION}</option>
        <option value="yes">{CSV_REVIEW_YES}</option>
        <option value="no">{CSV_REVIEW_NO}</option>
      </select>
    </div>
  )
}

/** One disclosure row (term + value). */
function SniffRow(props: {
  readonly testId: string
  readonly label: string
  readonly value: string
}): React.JSX.Element {
  return (
    <div className="csv-review-sniff-row">
      <dt>{props.label}</dt>
      <dd data-testid={props.testId}>{props.value}</dd>
    </div>
  )
}

/** The sniff disclosure (ADR 0049 item 6). */
function SniffDisclosure({ sniff }: { readonly sniff: EngineCsvSniff }): React.JSX.Element {
  return (
    <section aria-labelledby="csv-review-sniff-heading" data-testid="csv-review-sniff">
      <h3 id="csv-review-sniff-heading" className="csv-review-heading">
        {CSV_REVIEW_SNIFF_HEADING}
      </h3>
      <p className="csv-review-helper">{CSV_REVIEW_SNIFF_NOTE}</p>
      <dl className="csv-review-sniff">
        <SniffRow
          testId="csv-review-sniff-delimiter"
          label={CSV_REVIEW_SNIFF_DELIMITER}
          value={displayDialect(sniff.delimiter)}
        />
        <SniffRow
          testId="csv-review-sniff-quote"
          label={CSV_REVIEW_SNIFF_QUOTE}
          value={displayDialect(sniff.quote)}
        />
        <SniffRow
          testId="csv-review-sniff-escape"
          label={CSV_REVIEW_SNIFF_ESCAPE}
          value={displayDialect(sniff.escape)}
        />
        <SniffRow
          testId="csv-review-sniff-newline"
          label={CSV_REVIEW_SNIFF_NEWLINE}
          value={displayDialect(sniff.newLineDelimiter)}
        />
        <SniffRow
          testId="csv-review-sniff-comment"
          label={CSV_REVIEW_SNIFF_COMMENT}
          value={displayDialect(sniff.comment)}
        />
        <SniffRow
          testId="csv-review-sniff-skip"
          label={CSV_REVIEW_SNIFF_SKIP}
          value={String(sniff.skipRows)}
        />
        <SniffRow
          testId="csv-review-sniff-header"
          label={CSV_REVIEW_SNIFF_HEADER}
          value={displayBoolean(sniff.hasHeader)}
        />
        <SniffRow
          testId="csv-review-sniff-dateformat"
          label={CSV_REVIEW_SNIFF_DATEFORMAT}
          value={displayNullableText(sniff.dateFormat)}
        />
        <SniffRow
          testId="csv-review-sniff-timestampformat"
          label={CSV_REVIEW_SNIFF_TIMESTAMPFORMAT}
          value={displayNullableText(sniff.timestampFormat)}
        />
      </dl>
      <h4 className="csv-review-subheading">{CSV_REVIEW_SNIFF_COLUMNS}</h4>
      <ul className="csv-review-columns" data-testid="csv-review-sniff-columns">
        {sniff.columns.map((column, index) => (
          // The engine's own name/type pair, in the engine's own order; the
          // index is stable because the disclosure never reorders.
          <li key={`${String(index)}:${column.name}`} data-testid="csv-review-sniff-column">
            <span data-testid="csv-review-sniff-column-name">{column.name}</span>{' '}
            <span className="csv-review-type" data-testid="csv-review-sniff-column-type">
              {column.type}
            </span>
          </li>
        ))}
      </ul>
      {sniff.prompt === null ? null : (
        <>
          <h4 className="csv-review-subheading">{CSV_REVIEW_SNIFF_PROMPT_HEADING}</h4>
          <p className="csv-review-helper">{CSV_REVIEW_SNIFF_PROMPT_NOTE}</p>
          {/* Display text only: nothing in this app composes SQL from it. */}
          <pre className="csv-review-prompt" data-testid="csv-review-sniff-prompt">
            {sniff.prompt}
          </pre>
        </>
      )}
    </section>
  )
}

/** The effective option set the sample's read actually composed. */
function EffectiveOptions({
  options,
}: {
  readonly options: EngineCsvEffectiveOptions
}): React.JSX.Element {
  const entries: CsvEffectiveEntry[] = effectiveOptionEntries(options)
  return (
    <section aria-labelledby="csv-review-effective-heading" data-testid="csv-review-effective">
      <h3 id="csv-review-effective-heading" className="csv-review-heading">
        {CSV_REVIEW_EFFECTIVE_HEADING}
      </h3>
      {entries.length === 0 ? (
        <p className="csv-review-helper" data-testid="csv-review-effective-none">
          {CSV_REVIEW_EFFECTIVE_NONE}
        </p>
      ) : (
        <dl className="csv-review-sniff">
          {entries.map((entry) => (
            <div className="csv-review-sniff-row" key={entry.key}>
              <dt>{entry.label}</dt>
              <dd data-testid={`csv-review-effective-${entry.key}`}>{entry.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

export function CsvReviewDialog({
  mode,
  source,
  requestPreview,
  onAdopt,
  onStop,
}: CsvReviewDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  const [form, setForm] = useState<CsvReviewForm>(EMPTY_CSV_REVIEW_FORM)
  const [state, setState] = useState<CsvReviewState>(INITIAL_STATE)
  /**
   * Generation guard for preview reads: every dispatch bumps it, so a late
   * result (a slow earlier read, or anything resolving after abandonment) is
   * dropped instead of overwriting newer state. Bumped again on unmount.
   */
  const generationRef = useRef(0)
  /** Adoption is exactly-once per surface instance (the guard below is sync). */
  const adoptedRef = useRef(false)
  /**
   * Latest callbacks in refs so the mount effect (open, Escape, focus return)
   * never re-runs with fresh inline identities from the parent.
   */
  const onStopRef = useRef(onStop)
  onStopRef.current = onStop

  /**
   * Abandonment, in the surface's own words: "stopped reviewing" drops the
   * candidate and every in-flight read. The generation bump happens HERE, not
   * only on unmount, because the parent reacts to `onStop` by removing this
   * surface in the same tick — a read that settles in that window must never
   * paint, and must never be adoptable.
   */
  const abandon = (): void => {
    generationRef.current += 1
    onStopRef.current()
  }
  /** The mount effect registers once; it reads the live `abandon` through this. */
  const abandonRef = useRef(abandon)
  abandonRef.current = abandon

  const parsed = previewOptions(form)
  const currentFingerprint = parsed.ok ? optionsFingerprint(parsed.options) : null
  const adoptable = reviewIsAdoptable(state, currentFingerprint)
  const stale = reviewIsStale(state, currentFingerprint)

  const runPreview = useCallback(
    (options: EngineCsvOptions): void => {
      const generation = generationRef.current + 1
      generationRef.current = generation
      setState((previous) => ({ ...previous, loading: true, failure: null }))
      const requestOptions: EngineCsvOptionsInput | undefined = wireCsvOptions(options)
      void (async () => {
        try {
          const result = await requestPreview(source, requestOptions, CSV_PREVIEW_SAMPLE_ROWS)
          if (generationRef.current !== generation) return
          setState({
            view: toPreviewView(result),
            viewFingerprint: optionsFingerprint(options),
            loading: false,
            failure: null,
          })
        } catch (error) {
          if (generationRef.current !== generation) return
          // The operation's own framing: the engine's honest first line where
          // the bundle carries one, a value-free summary where it does not
          // (never a classification from glue text — ADR 0048/EW-03D D10).
          setState((previous) => ({
            ...previous,
            loading: false,
            failure: engineErrorMessage('csv-preview', error),
          }))
        }
      })()
    },
    [requestPreview, source],
  )

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    titleRef.current?.focus()
    const cancel = (event: Event): void => {
      event.preventDefault()
      abandonRef.current()
    }
    dialog.addEventListener('cancel', cancel)
    const wrapTab = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const stops = focusableStops(dialog)
      const first = stops[0]
      const last = stops[stops.length - 1]
      if (first === undefined || last === undefined) return
      const current = document.activeElement
      const outside = current === null || !dialog.contains(current)
      if (event.shiftKey && (outside || current === first || current === titleRef.current)) {
        event.preventDefault()
        last.focus()
        return
      }
      if (!event.shiftKey && (outside || current === last)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', wrapTab)
    return () => {
      // Drop every in-flight read: nothing may land after abandonment.
      generationRef.current += 1
      document.removeEventListener('keydown', wrapTab)
      dialog.removeEventListener('cancel', cancel)
      if (dialog.open) dialog.close()
      if (opener !== null && opener !== document.body && opener.isConnected) {
        opener.focus()
        return
      }
      // Both entry controls are inline in the open-flow line: restore to the
      // one this surface was opened from, in either phase.
      for (const selector of [
        '[data-testid="csv-review-button"]',
        '[data-testid="csv-review-open"]',
        '[data-testid="open-button"]',
      ]) {
        const target = document.querySelector<HTMLElement>(selector)
        if (target === null) continue
        target.focus()
        return
      }
    }
  }, [])

  // The first read: the reader's own choices, with no option set. Runs once.
  const startedRef = useRef(false)
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    runPreview({})
  }, [runPreview])

  const update = (patch: Partial<CsvReviewForm>): void => {
    setForm((previous) => ({ ...previous, ...patch }))
  }

  const adopt = (): void => {
    if (adoptedRef.current || !adoptable) return
    adoptedRef.current = true
    // The exact reviewed set, `sample_size` removed (ADR 0049 item 1): the
    // adoption open never carries the inference input.
    onAdopt(adoptionOptions(parsed.ok ? parsed.options : {}))
  }

  return (
    <dialog
      ref={dialogRef}
      className="csv-review-dialog"
      aria-labelledby="csv-review-title"
      data-testid="csv-review"
    >
      <h2 id="csv-review-title" ref={titleRef} className="csv-review-title" tabIndex={-1}>
        {CSV_REVIEW_TITLE}
      </h2>
      <p className="csv-review-scope" data-testid="csv-review-scope">
        {CSV_REVIEW_SCOPE}
      </p>
      <div className="csv-review-body">
        <section aria-labelledby="csv-review-options-heading" data-testid="csv-review-options">
          <h3 id="csv-review-options-heading" className="csv-review-heading">
            {CSV_REVIEW_OPTIONS_HEADING}
          </h3>
          <p className="csv-review-helper" data-testid="csv-review-options-scope">
            {CSV_REVIEW_OPTIONS_SCOPE}
          </p>
          <div className="csv-review-fields">
            <TextField
              id="csv-review-delim"
              testId="csv-review-delim"
              label={CSV_REVIEW_DELIM_LABEL}
              helper={CSV_REVIEW_DELIM_HELPER}
              value={form.delim}
              maxLength={64}
              placeholder={state.view === null ? '' : displayDialect(state.view.sniff.delimiter)}
              onChange={(value) => {
                update({ delim: value })
              }}
            />
            <TriStateField
              id="csv-review-header"
              testId="csv-review-header"
              label={CSV_REVIEW_HEADER_LABEL}
              value={form.header}
              onChange={(value) => {
                update({ header: value })
              }}
            />
            <TriStateField
              id="csv-review-all-varchar"
              testId="csv-review-all-varchar"
              label={CSV_REVIEW_ALL_VARCHAR_LABEL}
              value={form.allVarchar}
              onChange={(value) => {
                update({ allVarchar: value })
              }}
            />
            <TextField
              id="csv-review-sample-size"
              testId="csv-review-sample-size"
              label={CSV_REVIEW_SAMPLE_SIZE_LABEL}
              helper={CSV_REVIEW_SAMPLE_SIZE_HELPER}
              value={form.sampleSize}
              onChange={(value) => {
                update({ sampleSize: value })
              }}
            />
            <TextField
              id="csv-review-nullstr"
              testId="csv-review-nullstr"
              label={CSV_REVIEW_NULLSTR_LABEL}
              value={form.nullstr}
              maxLength={64}
              onChange={(value) => {
                update({ nullstr: value })
              }}
            />
            <TextField
              id="csv-review-dateformat"
              testId="csv-review-dateformat"
              label={CSV_REVIEW_DATEFORMAT_LABEL}
              value={form.dateformat}
              maxLength={64}
              onChange={(value) => {
                update({ dateformat: value })
              }}
            />
            <TextField
              id="csv-review-quote"
              testId="csv-review-quote"
              label={CSV_REVIEW_QUOTE_LABEL}
              value={form.quote}
              maxLength={64}
              onChange={(value) => {
                update({ quote: value })
              }}
            />
            <TextField
              id="csv-review-escape"
              testId="csv-review-escape"
              label={CSV_REVIEW_ESCAPE_LABEL}
              value={form.escape}
              maxLength={64}
              onChange={(value) => {
                update({ escape: value })
              }}
            />
            <TextField
              id="csv-review-comment"
              testId="csv-review-comment"
              label={CSV_REVIEW_COMMENT_LABEL}
              value={form.comment}
              maxLength={64}
              onChange={(value) => {
                update({ comment: value })
              }}
            />
            <TextField
              id="csv-review-skip"
              testId="csv-review-skip"
              label={CSV_REVIEW_SKIP_LABEL}
              value={form.skip}
              onChange={(value) => {
                update({ skip: value })
              }}
            />
            <div className="csv-review-field csv-review-field-wide">
              <label htmlFor="csv-review-types" className="csv-review-label">
                {CSV_REVIEW_TYPES_LABEL}
              </label>
              <textarea
                id="csv-review-types"
                data-testid="csv-review-types"
                className="csv-review-textarea"
                rows={3}
                value={form.typesText}
                onChange={(event) => {
                  update({ typesText: event.target.value })
                }}
              />
              <p className="csv-review-helper" data-testid="csv-review-types-helper">
                {CSV_REVIEW_TYPES_HELPER}
              </p>
            </div>
          </div>
          {parsed.ok ? null : (
            <p role="alert" className="csv-review-refusal" data-testid="csv-review-refusal">
              {CSV_REVIEW_REFUSAL_PREFIX}
              {parsed.reason}
              {CSV_REVIEW_REFUSAL_SUFFIX}
            </p>
          )}
          <button
            type="button"
            className="csv-review-secondary"
            data-testid="csv-review-update"
            /* Only a refusal blocks a re-read: a read in flight must never
             * trap the surface, and every read is generation-guarded, so the
             * newest result wins and older ones are discarded. */
            disabled={!parsed.ok}
            onClick={() => {
              if (!parsed.ok) return
              runPreview(parsed.options)
            }}
          >
            {CSV_REVIEW_UPDATE_SAMPLE}
          </button>
        </section>

        {state.failure === null ? null : (
          <p role="alert" className="csv-review-failure" data-testid="csv-review-failure">
            {state.failure}
          </p>
        )}

        {state.view === null ? (
          <p className="csv-review-helper" data-testid="csv-review-sample-loading">
            {state.loading ? CSV_REVIEW_SAMPLE_LOADING : CSV_REVIEW_SAMPLE_MISSING}
          </p>
        ) : (
          <>
            {state.loading ? (
              <p className="csv-review-helper" data-testid="csv-review-sample-loading">
                {CSV_REVIEW_SAMPLE_LOADING}
              </p>
            ) : null}
            {stale ? (
              <p role="status" className="csv-review-stale" data-testid="csv-review-stale">
                {CSV_REVIEW_SAMPLE_STALE}
              </p>
            ) : null}
            <EffectiveOptions options={state.view.effectiveOptions} />
            <SniffDisclosure sniff={state.view.sniff} />
            <section aria-labelledby="csv-review-sample-heading" data-testid="csv-review-sample">
              <h3 id="csv-review-sample-heading" className="csv-review-heading">
                {CSV_REVIEW_SAMPLE_HEADING}
              </h3>
              {state.view.sampleMismatch ? (
                <p role="alert" data-testid="csv-review-sample-mismatch">
                  {CSV_REVIEW_COLUMN_MISMATCH}
                </p>
              ) : state.view.sample === null ? (
                <p className="csv-review-helper" data-testid="csv-review-sample-missing">
                  {CSV_REVIEW_SAMPLE_MISSING}
                </p>
              ) : (
                <>
                  <p className="csv-review-helper" data-testid="csv-review-sample-cap">
                    {csvReviewSampleCap(state.view.sample.rowCap)}
                  </p>
                  <p className="csv-review-helper" data-testid="csv-review-sample-scope">
                    {CSV_REVIEW_SAMPLE_SCOPE}
                  </p>
                  {state.view.sample.hasMore ? (
                    <p className="csv-review-helper" data-testid="csv-review-sample-more">
                      {CSV_REVIEW_SAMPLE_MORE}
                    </p>
                  ) : null}
                  <div className="csv-review-table-scroll">
                    <table className="csv-review-table" data-testid="csv-review-sample-table">
                      <caption className="csv-review-helper">
                        {CSV_REVIEW_SAMPLE_TABLE_CAPTION}
                      </caption>
                      <thead>
                        <tr>
                          {state.view.sample.columns.map((column, index) => (
                            <th key={`${String(index)}:${column.name}`} scope="col">
                              <span data-testid="csv-review-sample-column-name">{column.name}</span>
                              <span
                                className="csv-review-type"
                                data-testid="csv-review-sample-column-type"
                                title={CSV_REVIEW_COLUMN_TYPE_TITLE}
                              >
                                {column.type ?? ''}
                              </span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {state.view.sample.rows.map((row, rowIndex) => (
                          // Rows are the engine's own order and the sample is
                          // bounded, so a positional key is stable here.
                          <tr key={String(rowIndex)} data-testid="csv-review-sample-row">
                            {row.map((cell, cellIndex) => (
                              <td key={String(cellIndex)} data-testid="csv-review-sample-cell">
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>
          </>
        )}

        <section aria-labelledby="csv-review-meaning-heading" data-testid="csv-review-meanings">
          <h3 id="csv-review-meaning-heading" className="csv-review-heading">
            {CSV_REVIEW_MEANING_HEADING}
          </h3>
          <ul className="csv-review-meanings">
            <li data-testid="csv-review-meaning-null">
              {CSV_REVIEW_NULL_DEFAULT} {CSV_REVIEW_NULL_DEFAULT_2}
            </li>
            <li data-testid="csv-review-meaning-dates">{CSV_REVIEW_DATES}</li>
            <li data-testid="csv-review-meaning-renames">{CSV_REVIEW_HEADER_RENAMES}</li>
            <li data-testid="csv-review-meaning-unsafe-ints">{CSV_REVIEW_UNSAFE_INTS}</li>
            <li data-testid="csv-review-meaning-no-skip">{CSV_REVIEW_NO_ROW_SKIP}</li>
            <li data-testid="csv-review-meaning-sample-size">{CSV_REVIEW_SAMPLE_SIZE_SCOPE}</li>
          </ul>
        </section>
      </div>
      <div className="csv-review-actions">
        <p className="csv-review-helper" data-testid="csv-review-adopt-helper">
          {mode === 'replace' ? CSV_REVIEW_ADOPT_HELPER_REPLACE : CSV_REVIEW_ADOPT_HELPER_IDLE}
        </p>
        <button
          type="button"
          className="csv-review-secondary"
          data-testid="csv-review-stop"
          onClick={abandon}
        >
          {CSV_REVIEW_STOP}
        </button>{' '}
        <button
          type="button"
          className="csv-review-primary"
          data-testid="csv-review-adopt"
          disabled={!adoptable}
          onClick={adopt}
        >
          {CSV_REVIEW_ADOPT}
        </button>
      </div>
    </dialog>
  )
}
