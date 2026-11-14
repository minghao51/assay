// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overlay-session helpers (m4-3/m4-4) — pure glue between the domain's
 * transformation history and the engine's stateless overlay protocol.
 *
 * The web composition root owns the *effects* (React state, grid refresh,
 * error surfacing); this module owns the *rules* so they are Node-tested
 * without a DOM:
 *
 * - `activeOps` is the engine-facing projection of a history: exactly the
 *   entries left of the undo/redo cursor, in order. The engine refolds them
 *   (`foldOverlay`) per request, so the grid always materializes the active
 *   prefix — undo/redo are cursor moves, never inverse-SQL bookkeeping.
 * - `overlaySnapshot` packages `{ base, ops }` into the engine's
 *   `EngineOverlay` as a **pass-through** of the active ops. m4-3 shipped a
 *   web-side projection here that folded inserted-row cell edits into their
 *   insert records, working around an m4-2 composer gap; m4-2b fixed the
 *   engine to merge the folded `state.edits` itself, so the projection is
 *   redundant and `overlaySnapshot` now hands the raw ops straight to the
 *   engine (m4-4 simplification — the engine fold is the single source of
 *   truth for op order, and `stateAtCursor` is by construction the fold of
 *   exactly these ops).
 * - `editOutcomeMessage` turns a typed `OpOutcome` into an honest, text-only
 *   message (or `null` for an applied op). No-op and conflict outcomes are
 *   surfaced, never swallowed: the brief forbids silently dropping an edit
 *   the user asked for.
 */
import type { EditOp, OpOutcome, OverlayBase, TransformationHistory } from '@assay/domain'
import type { EngineOverlay } from '@assay/engine-duckdb'

/** The ops left of the history cursor, in application order. */
export function activeOps(history: TransformationHistory): EditOp[] {
  return history.entries.slice(0, history.cursor).map((entry) => entry.op)
}

/**
 * WF-06 "dirty": is there an **applied** outcome in the active history
 * prefix? (v5 §2, adopted predicate.)
 *
 * Evaluated only on a settled history (`historyRef.current`) — the gate rows
 * G3/G4 precede it, so a commit in flight is refused before this runs. The
 * predicate must not use `entries.length` (undo-to-zero leaves entries),
 * `cursor > 0` or `activeOps().length` (logged no-ops count there), the
 * overlay revision (undo/redo/cursor moves bump it) or the history race tag.
 *
 * Case verdicts: undo back to zero ⇒ clean; a redo tail only ⇒ clean; a
 * logged no-op only ⇒ clean; a rolled-back or refused edit ⇒ clean; A→B→A ⇒
 * dirty (the adopted over-report: an applied op really did run).
 */
export function hasAppliedChanges(history: TransformationHistory): boolean {
  for (let index = 0; index < history.cursor; index += 1) {
    if (history.entries[index]?.outcome.status === 'applied') return true
  }
  return false
}

/**
 * Where a *base-derived* name lands on the current effective view (ug-16).
 *
 * `resolved` carries the name to use (the base name itself, or — for a rename
 * chain that ends on the base name again — the base name). `renamed` carries
 * both names so the refusal can name them; `unresolved` means the base name is
 * neither in the effective schema nor reachable through the active rename
 * chain (a future column-drop, or a chain whose intermediate name is gone).
 */
export type ProfileColumnResolution =
  | { readonly kind: 'resolved'; readonly column: string }
  | { readonly kind: 'renamed'; readonly base: string; readonly current: string }
  | { readonly kind: 'unresolved'; readonly base: string }

/**
 * Resolve a base-derived column name against the *current* effective schema
 * (ug-16 design §4.1 — authoritative):
 *
 * 1. A name present in the effective schema resolves as itself. This is also
 *    what makes a rename chain that returns to the original name resolve with
 *    no refusal.
 * 2. Otherwise follow the active `column-rename` ops in order from the base
 *    name (`from` must match the current name exactly). If the chain lands on
 *    a name present in the effective schema, it is `renamed` with the current
 *    name known.
 * 3. Otherwise it is `unresolved`.
 *
 * The rule is evaluated per click from the active ops at the history cursor,
 * so undo/redo re-resolves: an undone rename makes the base name resolve
 * again. It never remaps silently — the caller refuses when the answer is not
 * `resolved` (design §3/§4.2).
 */
export function resolveProfileColumn(
  baseColumn: string,
  ops: readonly EditOp[],
  effectiveSchema: readonly { readonly name: string }[],
): ProfileColumnResolution {
  const effectiveNames = new Set(effectiveSchema.map((column) => column.name))
  if (effectiveNames.has(baseColumn)) return { kind: 'resolved', column: baseColumn }

  let current = baseColumn
  for (const op of ops) {
    if (op.kind !== 'column-rename') continue
    if (op.from === current) current = op.to
  }

  if (effectiveNames.has(current)) {
    return { kind: 'renamed', base: baseColumn, current }
  }
  return { kind: 'unresolved', base: baseColumn }
}

/**
 * Package the active overlay for one engine request: the raw active ops, in
 * order. The engine folds them with the same domain model the host used for
 * `stateAtCursor`, so the two agree by construction (m4-2b merged inserted-row
 * edits engine-side; the m4-3 projection is gone). `ops` is always present so
 * the wire payload is byte-stable.
 */
export function overlaySnapshot(base: OverlayBase, history: TransformationHistory): EngineOverlay {
  return { base, ops: activeOps(history) }
}

/** Human-readable reason fragments for the domain's typed non-applied outcomes. */
const NO_OP_TEXT: Record<string, string> = {
  'cell-value-unchanged': 'the cell already has that value',
  'cell-already-base': 'the cell already shows its base value',
  'row-already-deleted': 'the row is already deleted',
  'row-already-present': 'the row is already present',
  'rename-identity': 'the column already has that name',
  'cast-identity': 'the column already has that type',
}

const CONFLICT_TEXT: Record<string, string> = {
  'malformed-row-id': 'the row reference is malformed',
  'not-an-insert-id': 'a new row must use an insert id',
  'row-anchor-mismatch': 'the row belongs to a different file version',
  'insert-anchor-mismatch': 'the row belongs to a different editing session',
  'unknown-row': 'the row no longer exists',
  'row-deleted': 'the row was deleted',
  'unknown-column': 'the column does not exist',
  'rename-collision': 'a column with that name already exists',
  'insert-id-collision': 'the new-row id is already in use',
}

/**
 * Render one typed outcome as an honest message, or `null` when the op was
 * applied. Text only (ADR 0007 spirit): the string echoes *reasons* and, for
 * cell values, nothing — reasons are engine/domain vocabulary, never dataset
 * content, so this is safe for the accessibility alert and for logs alike.
 */
export function editOutcomeMessage(outcome: OpOutcome): string | null {
  switch (outcome.status) {
    case 'applied':
      return null
    case 'no-op':
      return `No change: ${NO_OP_TEXT[outcome.reason] ?? outcome.reason}.`
    case 'conflict':
      return `Cannot apply the edit: ${CONFLICT_TEXT[outcome.reason] ?? outcome.reason}.`
  }
}

/**
 * The mvp browser bundle surfaces some value-space cast failures through its
 * emscripten layer as the opaque `_setThrew is not defined` (the
 * `engine-duckdb` `op-channel` write-up documents that failure mode). A raw
 * glue error is not a readable engine message, so it — and an empty message —
 * degrade to a plain summary.
 */
const OPAQUE_GLUE_ERROR = /^_setThrew\b/

/**
 * Every line break an engine diagnostic may carry: `\n`, `\r\n`, `\r`, and
 * the Unicode separators some JS engines emit. UG-30's single-line guarantee
 * is enforced on this set, not just `\n`.
 */
const LINE_BREAK = /\r\n|[\r\n\v\f\u0085\u2028\u2029]/

/** The full raw engine/HTTP text (only ever rendered behind a disclosure). */
export function engineErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The first (summary) line of an engine/HTTP error, with the opaque glue
 * error and empty messages translated to `fallback`. Engine errors echo the
 * operation's SQL context across several lines; only the summary is surfaced
 * — the rest is the composed statement, which can carry other cells' values
 * and is neither readable nor something the user asked to see. The returned
 * string is guaranteed **single-line** (UG-30): no newline can survive into a
 * rendered error message. It is rendered as text (never HTML) and is never
 * logged (it can echo the value typed, ADR 0025).
 */
export function engineErrorLine(error: unknown, fallback: string): string {
  const summary = engineErrorDetail(error).split(LINE_BREAK)[0]?.trim() ?? ''
  if (summary === '' || OPAQUE_GLUE_ERROR.test(summary)) return fallback
  // A summary line can still carry a stray separator after trimming (e.g. a
  // trailing `\r`); collapse it so the guarantee is absolute.
  return summary.replace(/\s+/g, ' ')
}

/**
 * The operations that render engine failures. Each has its own framing so a
 * failure says both *what* failed and *what did not change* — the same engine
 * rejection previously read polished in one panel and raw in the next
 * (UG-30).
 */
export type EngineErrorOperation = 'open' | 'sql' | 'profile' | 'filter' | 'validation' | 'diff'

/** A summary rendered as a sentence fragment: no doubled or stacked punctuation. */
function fragment(summary: string): string {
  return summary.replace(/[.!?\u2026\s]+$/u, '')
}

/**
 * Per-operation framing. `validation`/`diff` carry only the unchanged-state
 * clause because their panels already prefix the operation (`Validation
 * failed:`, `The row diff failed:`) and append their own outcome sentence;
 * repeating the verb here would read as two failures. None of the strings may
 * contain the word "edit" for those read-only sessions (UG-25): the previous
 * copy was the edit-domain rejection message, which produced "Validation
 * failed: The engine rejected this edit…".
 */
const OPERATION_FRAMING: Record<EngineErrorOperation, (summary: string) => string> = {
  open: (summary) => `The file could not be opened. ${summary}`,
  sql: (summary) =>
    `The query could not run: ${fragment(summary)}. The dataset and its staged changes are unchanged.`,
  profile: (summary) =>
    `The profile could not be computed: ${fragment(summary)}. The dataset and its staged changes are unchanged.`,
  filter: (summary) =>
    `The filter could not be applied: ${fragment(summary)}. The previous filters are still in effect.`,
  validation: (summary) => `${fragment(summary)}. The previous validation view is unchanged.`,
  diff: (summary) => `${fragment(summary)}. The previous comparison view is unchanged.`,
}

/**
 * One engine failure as a single-line, framed, text-only message (UG-30).
 * The summary is the error's **first line**; `fallback` replaces an empty or
 * opaque-glue message so the alert is never blank and never echoes the
 * emscripten layer.
 */
export function engineErrorMessage(
  operation: EngineErrorOperation,
  error: unknown,
  fallback: string = 'the engine reported an error',
): string {
  return OPERATION_FRAMING[operation](engineErrorLine(error, fallback))
}

/**
 * Open-failure classes (UG-5). The open chain reports three human causes: a
 * format the engine does not read, a file it cannot read (corrupt, truncated,
 * mislabelled), and everything else — never the raw DuckDB diagnostic, which
 * moves behind the alert's technical-detail disclosure.
 */
export type OpenFailureCause = 'unsupported-format' | 'unreadable' | 'unknown'

/** The engine's own refusal for an extension it does not read. */
const UNSUPPORTED_FORMAT_SIGNAL = /unsupported (dataset )?(format|file type|extension)/i

/**
 * Reader/IO failure text signals. DuckDB reports a corrupt Parquet file as
 * `Invalid Input Error: No magic bytes found at end of file`, a truncated or
 * mislabelled file through `IO Error`/`Invalid Input Error`/`CSV Error`/
 * `Could not read`, and a permission message explicitly. Every member names a
 * file-specific failure, and these signals are read from the engine's *detail
 * text* only — the human cause never echoes them. They are the fallback for
 * engine strings; a DOM exception's *name* is checked separately below,
 * because its message is generic (e.g. `NotFoundError`'s "A requested file or
 * directory could not be found…"). A bare `not found`, by contrast, is not
 * file evidence: DuckDB uses it for missing columns/tables too, so only the
 * file/path-shaped spellings (`no such file`, `file not found`, `path not
 * found`) count.
 *
 * `_setThrew` is deliberately NOT a member. It is the mvp bundle's opaque
 * emscripten glue failure (see `OPAQUE_GLUE_ERROR` above); the `engine-duckdb`
 * `op-channel` notes it can also surface on operation collisions, so it is not
 * evidence about the file. A corrupt fixture happens to produce it through the
 * WASM reader, but that is a fact about this bundle, not a classification: the
 * open chain also catches schema, row-count, view-materialization and panel
 * chunk failures (see `openDataFile`), and none of those is a file-read
 * failure. The opaque error therefore falls through to `unknown`, whose copy
 * claims nothing about the file.
 */
const UNREADABLE_SIGNAL =
  /no magic bytes|invalid input error|io error|could not (be )?(read|open)|failed to read|invalid parquet|not a parquet|corrupt|malformed|truncat|encoding error|not readable|permission|denied|no such file|file not found|path not found|unexpected end|(csv|json) error/i

/**
 * DOM file-read exception names. A `FileSystemFileHandle.getFile()` rejection
 * is a `DOMException` whose **name** carries the cause while its message is a
 * generic, non-file-shaped sentence ("A requested file or directory could not
 * be found at the time this operation was executed."). The text signals above
 * therefore cannot see it — the name can, and it is file-specific evidence
 * (unlike a bare `not found`, which DuckDB also uses for missing columns and
 * tables). `SecurityError` is included because the read is refused, so the
 * honest human cause is the same: the file could not be read.
 */
const DOM_FILE_READ_ERRORS: ReadonlySet<string> = new Set([
  'NotFoundError',
  'NotReadableError',
  'EncodingError',
  'SecurityError',
])

/**
 * Classify an open failure from its raw engine/DOM detail (UG-5) and, when the
 * caller has the exception itself, its `name`. `errorName` is optional so the
 * text-only callers keep working; when supplied it is authoritative for the
 * DOM file-read names, whose messages are generic.
 */
export function classifyOpenFailure(detail: string, errorName?: string): OpenFailureCause {
  if (UNSUPPORTED_FORMAT_SIGNAL.test(detail)) return 'unsupported-format'
  if (errorName !== undefined && DOM_FILE_READ_ERRORS.has(errorName)) return 'unreadable'
  if (UNREADABLE_SIGNAL.test(detail)) return 'unreadable'
  return 'unknown'
}

/**
 * The one-line human cause per open-failure class (UG-5; value-free).
 *
 * `unknown` is **cause-neutral on purpose**: the guarded open chain catches
 * failures from schema, row-count, view loading and panel imports as well as
 * from file reading, so it must not claim the file could not be read, was
 * corrupt, or was the wrong format. It states only what is true for every
 * caught stage (nothing opened; another file can be tried) — no diagnostic, no
 * blame.
 */
const OPEN_FAILURE_CAUSE: Record<OpenFailureCause, string> = {
  'unsupported-format':
    'This file type is not supported — open a .parquet, .csv, .jsonl or .json file.',
  unreadable:
    'The file could not be read. It may be corrupt, truncated, or not the format its name suggests.',
  unknown: 'You can try another file.',
}

/**
 * The open alert's single-line human cause (UG-5): the classified cause,
 * framed as an open failure. Never the raw engine diagnostic and never
 * filename-bearing (ADR 0025).
 *
 * `errorName` is the exception name the caller stored when it caught the
 * failure (App's `Phase['error'].errorName`). A `DOMException` from
 * `getFile()` keeps its cause in the NAME only — its message is a generic
 * sentence — so the stored name is authoritative and is used when supplied.
 * When it is absent (a text-only caller, or a plain `Error` open), the name is
 * derived from the exception here.
 */
export function openFailureMessage(error: unknown, errorName?: string): string {
  // `DOMException` extends `Error`, so a DOM file-read rejection keeps its
  // name here even though `engineErrorDetail` only reads the message.
  const name = errorName ?? (error instanceof Error ? error.name : '')
  const cause = OPEN_FAILURE_CAUSE[classifyOpenFailure(engineErrorDetail(error), name)]
  return OPERATION_FRAMING.open(cause)
}

/**
 * The value-free summary for "a value this column's type cannot accept".
 *
 * Two call sites must agree byte-for-byte: `engineErrorSummary`'s fallback
 * (an engine rejection that arrived without a usable message) and the
 * pre-commit cell-value check in `useEditingSession`, which refuses a value the
 * engine's `overlayCastCheck` proved non-convertible by throwing an error whose
 * summary IS this text. Sharing the constant is what keeps the two from
 * drifting into two different sentences for one failure class.
 */
export const COLUMN_TYPE_REJECTED_SUMMARY = "the column's type rejected the value"

/** The engine-error summary with the single-failure value-cast fallback. */
export function engineErrorSummary(error: unknown): string {
  return engineErrorLine(error, COLUMN_TYPE_REJECTED_SUMMARY)
}

/**
 * Render a single engine rejection as a readable, text-only alert message:
 * the new state was rejected, so it was rolled back and the previous view is
 * unchanged.
 */
export function engineRejectionMessage(error: unknown): string {
  return `The engine rejected this edit: ${engineErrorSummary(error)}. The previous view is unchanged.`
}

/**
 * Readable refusal for a cast the engine's pre-commit check proved would fail
 * to convert some of the column's values (m4-4 fix round). Names the column
 * and target type (schema vocabulary, never cell values) and states plainly
 * that nothing was applied, so the alert can never be mistaken for a
 * successful-but-odd commit.
 */
export function castRefusalMessage(column: string, targetType: string): string {
  return (
    `Cannot cast "${column}" to ${targetType}: ` +
    'some values cannot convert to that type. No cast was applied; the view is unchanged.'
  )
}

/**
 * Readable refusal for a cast whose pre-commit check kept being invalidated by
 * a concurrent same-table change (m4-4 fix round 2). The check never completed
 * against a state the append could trust, so nothing was applied — the user is
 * asked to retry rather than being handed a stale verdict.
 */
export function castRacedMessage(column: string, targetType: string): string {
  return (
    `Cannot cast "${column}" to ${targetType}: ` +
    'the view changed while the cast was being checked. No cast was applied; try again.'
  )
}

/** The effects a history commit needs from the composition root. */
export interface CommitEffects {
  /** Publish `history` as the active overlay (overlay ref + React state). */
  setActive(history: TransformationHistory): void
  /** Re-materialize the active overlay through a fresh data epoch. */
  refresh(): Promise<void>
  /**
   * Optional pre-activation check: prove the candidate overlay is acceptable
   * **before anything is published**. A rejection means "refused, nothing
   * applied" — the commit returns the rejection's framed message without ever
   * calling `setActive`, so the previous view stays on screen and no rollback
   * refresh is needed. Resolving means "commit as usual" (the refresh path and
   * its rollback are unchanged). The cell-edit value check
   * (`overlayCastCheck`) is the caller that needs this seam; the hook decides
   * which ops carry one.
   */
  validate?: () => Promise<void>
}

/**
 * The outcome of a history commit: `message` is `null` on success, and
 * `restoreFailed` is true only when the previous view could not be
 * re-materialized after a rejection (the double-failure case the alert must
 * attribute honestly and the host must offer a retry for).
 */
export interface CommitResult {
  readonly message: string | null
  readonly restoreFailed: boolean
}

/**
 * Commit one history against the engine's (re)materialization, rolling back to
 * the previous history when the new overlay is rejected.
 *
 * The repo's contract for a rejected state change is "the previous state stays
 * in effect" (`GridDataProvider.sort`/`filter`, the domain's typed
 * `Conflict`/`NoOp` outcomes). An engine value-space rejection (a bad DATE
 * cast, an out-of-range BIGINT, a `column-cast` whose values do not convert)
 * is the same class of event: the new overlay materializes to an error, so
 * this restores the previous overlay and re-materializes it, leaving the grid
 * renderable instead of all-loading.
 *
 * `setActive(next)` runs first so the provider reads the new overlay during
 * `refresh()`; on rejection `setActive(previous)` + a second `refresh()`
 * restore the prior effective view. **Double-failure honesty** (m4-3
 * carry-over): if that restore also rejects, the returned message names
 * *both* failures — it never claims only the value was rejected — and
 * `restoreFailed: true` tells the host to surface a retry affordance, so an
 * engine outage cannot leave the user with an unattributed alert and no way
 * back. Never throws.
 *
 * m4-4 fix round: the bounded `verify()` probe is gone. A cast whose values
 * cannot convert is now refused *before* the op is appended via the engine's
 * `overlayCastCheck` (see `handleCastColumn`), and every other value failure
 * rejects on the `refresh()` window read itself. A partial-window probe was a
 * false assurance: a bad value past row 0 could commit and brick the grid.
 *
 * R1-C: an optional `effects.validate` runs **before** `setActive` for the
 * commits that carry one (the cell-edit value check). Its rejection is refused
 * state, not a failed commit: nothing was activated, so there is nothing to
 * roll back and the existing rejection framing is already true. That is what
 * keeps a value the engine cannot convert from reaching the view at all — the
 * `refresh()` above only reads metadata (`schema()`/`rowCount()`), which never
 * evaluates the edited value.
 */
export async function commitWithRollback(
  previous: TransformationHistory,
  next: TransformationHistory,
  effects: CommitEffects,
): Promise<CommitResult> {
  if (effects.validate !== undefined) {
    try {
      await effects.validate()
    } catch (error) {
      // Refused before activation: the previous view was never replaced and no
      // refresh was needed, so the honest report is the rejection itself.
      return { message: engineRejectionMessage(error), restoreFailed: false }
    }
  }
  effects.setActive(next)
  try {
    await effects.refresh()
    return { message: null, restoreFailed: false }
  } catch (error) {
    effects.setActive(previous)
    let restoreError: unknown = null
    try {
      await effects.refresh()
    } catch (restoreFailure) {
      restoreError = restoreFailure
    }
    if (restoreError === null) {
      return { message: engineRejectionMessage(error), restoreFailed: false }
    }
    return {
      // Name both failures and attribute the engine/view, not a value claim:
      // an opaque glue error here describes an engine outage as much as a bad
      // cell, so the neutral fallback is the honest one. `restoreFailed` tells
      // the host to pair this with a retry, so rows can never sit in an
      // unattributed loading state.
      message:
        `The change could not be applied: ${engineErrorLine(error, 'the engine or view rejected it')}. ` +
        `Restoring the previous view also failed: ${engineErrorLine(restoreError, 'the engine or view was unavailable')}. ` +
        'Use Retry to reload the view.',
      restoreFailed: true,
    }
  }
}
