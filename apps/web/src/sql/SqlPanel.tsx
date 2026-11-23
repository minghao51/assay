// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { viewNameForTableId } from '@assay/engine-duckdb'
import { bucketRowCount } from '@assay/telemetry'
import type { QueryKind } from '@assay/telemetry'
import { formatCell } from '../grid/format'
import { projectBatchToRows } from '../grid/provider'
import { engineErrorMessage } from '../edit/session'
import { engineClient } from '../lib/engine'
import { useTelemetry } from '../telemetry/TelemetryContext'
import { durationSince } from '../telemetry/emit'
import { SQL_PAGE_SIZE, composePageQuery, resultColumnNames, summarizePage } from './paged-query'
import { RunGuard } from './run-guard'
import { runGuarded } from './guarded-run'

/**
 * SQL editor + result pane (m2-4). A dependency-free textarea editor with a
 * Run control (Ctrl/Cmd+Enter) and Cancel; results render as ONE bounded
 * page at a time (`SQL_PAGE_SIZE` rows) with prev/next paging.
 *
 * Design decisions:
 *
 * - **Paging** is web-side SQL composition (`composePageQuery` — the engine
 *   `query()` op has no wire-level limit/offset, and this task must not
 *   change the engine). "Run" always starts at offset 0; prev/next re-run
 *   the *last executed* statement (a snapshot — editing the draft mid-paging
 *   does not silently retarget the pager until the next Run).
 * - **Cancel is UI-level abandonment.** The engine worker has no
 *   client-facing query interrupt: the FIFO OpChannel holds its single
 *   pending-query slot until the first batch arrives, and this task must not
 *   change the engine. So Cancel invalidates the run's generation token
 *   (`RunGuard`) and shows a cancelled state; the late result is discarded
 *   when it arrives (never rendered), while the query itself keeps running
 *   worker-side until completion. A follow-up Run still works — it queues
 *   behind the abandoned query on the worker's FIFO. A true interrupt /
 *   second-connection decision is m2-7; this is documented (not hidden) in
 *   the cancelled-state text.
 * - **Rendering is data-only.** SQL text, engine errors, and result cells
 *   are untrusted *content* (ADR 0007 spirit): everything renders through
 *   React text interpolation via `formatCell` — no `dangerouslySetInnerHTML`,
 *   no cell content ever executed. No SQL, results, or file names are ever
 *   logged (there is no logging here at all — ADR 0025).
 * - The hint shows both names: the app's table id (`t1`, engine-generated,
 *   already displayed by the app shell) and the SQL-facing view name
 *   (`"assay_t1"`, via the engine export `viewNameForTableId`) that raw
 *   queries must use.
 * - m3-5: composed one-click SQL arrives via `runRequest` (from the
 *   schema-tree / grid-header nested actions). The pane fills the editor
 *   with the exact composed statement — the user always sees what ran — and
 *   executes it through the same guarded path as a manual Run. A new request
 *   supersedes an in-flight run (`RunGuard.begin`), so the last action wins;
 *   paging then pages the composed statement like any manually run one.
 */

/** One composed SQL execution request from outside the pane (m3-5 actions). */
export interface SqlRunRequest {
  readonly sql: string
  /** Monotonic per-app counter; the pane runs a request when `seq` advances. */
  readonly seq: number
  /**
   * Dataset-session token captured when App composed the request (R-07). The
   * App-owned ledger rejects a request whose session has been replaced, so a
   * stale request can never run against a new dataset.
   */
  readonly session: number
}

interface SqlPanelProps {
  /** Engine-generated id of the opened table (safe to show and query). */
  readonly tableId: string
  /** Latest external run request, or `null` while there is none. */
  readonly runRequest: SqlRunRequest | null
  /**
   * Synchronous App-owned consumption claim (R-07). Called BEFORE the
   * external query is issued; `false` means this sequence was already
   * consumed in this session (StrictMode double effect, boundary retry,
   * close/reopen) and must run ZERO additional queries.
   */
  readonly claimRequest: (request: SqlRunRequest) => boolean
}

/** Run lifecycle of the pane (shown as the section's `data-state`). */
type RunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'done' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error'; readonly message: string }

/** One delivered, fully-projected page (the pane renders at most this). */
interface PageResult {
  readonly columns: readonly string[]
  readonly rows: readonly (readonly unknown[])[]
  readonly offset: number
  /** Engine `hasMore`: this page exceeded one Arrow batch (unreachable at `SQL_PAGE_SIZE`, surfaced honestly). */
  readonly truncatedInTransport: boolean
}

function errorMessage(error: unknown): string {
  // UG-30: every SQL failure is one framed single-line message; a multi-line
  // engine diagnostic (it echoes the composed statement) never reaches the
  // alert intact.
  return engineErrorMessage('sql', error)
}

export function SqlPanel({ tableId, runRequest, claimRequest }: SqlPanelProps) {
  const sqlTable = viewNameForTableId(tableId)
  const telemetry = useTelemetry()
  const [draft, setDraft] = useState('')
  const [runState, setRunState] = useState<RunState>({ kind: 'idle' })
  const [page, setPage] = useState<PageResult | null>(null)
  const lastRunSql = useRef<string | null>(null)
  const guard = useRef(new RunGuard())
  const startedAtRef = useRef<number | null>(null)
  /**
   * ug-1/R-01–R-02 reveal seam. A *successful nested action* (external
   * `runRequest`) records its sequence here when its run settles; the
   * effect below then scrolls the section into view and focuses the outcome
   * that was just rendered. Manual Run and paging pass `null`, so they never
   * move focus. The token is cleared after the one reveal, and the settle
   * callback only runs while the `RunGuard` token is active — a superseded
   * request can never reveal an older result.
   */
  const pendingRevealRef = useRef<number | null>(null)
  const sectionRef = useRef<HTMLElement | null>(null)
  const resultRef = useRef<HTMLDivElement | null>(null)
  const emptyRef = useRef<HTMLParagraphElement | null>(null)
  const errorRef = useRef<HTMLParagraphElement | null>(null)

  const running = runState.kind === 'running'
  const runnable = composePageQuery(draft, { limit: SQL_PAGE_SIZE, offset: 0 }).ok

  /**
   * Execute the statement for one page. The async tail (begin a guard
   * token, deliver only while that token is active) is the pure helper
   * `runGuarded` — Node-pinned in `guarded-run.test.ts`: a cancelled or
   * superseded run's late result/rejection is discarded and can never
   * clobber the pane's current state.
   */
  const execute = (
    userSql: string,
    offset: number,
    kind: QueryKind,
    revealSeq: number | null = null,
  ): void => {
    const composed = composePageQuery(userSql, { limit: SQL_PAGE_SIZE, offset })
    if (!composed.ok) {
      pendingRevealRef.current = revealSeq
      // The composition rejection is already a human sentence ("Enter a SQL
      // query to run."); the same framing keeps both SQL error paths one-line
      // and explicit about what did not change (UG-30).
      setRunState({ kind: 'error', message: errorMessage(composed.reason) })
      return
    }
    lastRunSql.current = userSql
    startedAtRef.current = Date.now()
    setRunState({ kind: 'running' })
    setPage(null)
    runGuarded(guard.current, engineClient.query(composed.sql), {
      onResult: (result) => {
        const rows = projectBatchToRows(result.batch)
        // Only a nested-action request arms a reveal; the token is
        // consumed by the post-render effect below.
        pendingRevealRef.current = revealSeq
        setPage({
          columns: resultColumnNames(result.batch),
          rows,
          offset,
          truncatedInTransport: result.hasMore,
        })
        setRunState({ kind: 'done' })
        // `query_run` (design §2/Appendix C): entry-point class + coarse
        // buckets only; SQL text and result cells never reach the payload.
        telemetry.emit('query_run', {
          query_kind: kind,
          row_count_bucket: bucketRowCount(rows.length),
          duration_bucket: durationSince(startedAtRef.current ?? Date.now()),
          outcome: 'success',
        })
      },
      onError: (cause: unknown) => {
        // Engine errors (EngineQueryError & co.) surface as readable alert
        // text; the pane (and engine) stay usable for the next run. A nested
        // action still reveals its own error target.
        pendingRevealRef.current = revealSeq
        setRunState({ kind: 'error', message: errorMessage(cause) })
        telemetry.emit('query_run', {
          query_kind: kind,
          row_count_bucket: 'zero',
          duration_bucket: durationSince(startedAtRef.current ?? Date.now()),
          outcome: 'error',
        })
      },
    })
  }

  const run = (): void => {
    if (running) return
    execute(draft, 0, 'user_sql') // a fresh Run always starts at the first page
  }

  /**
   * m3-5: run a composed external request when its `seq` advances. The
   * editor first shows the exact SQL (honesty: what ran is visible), then
   * the shared guarded execution path runs it — a request supersedes any
   * in-flight run, and engine errors surface like any other run's.
   * (`executeRef` is the latest-closure pattern: `execute` touches only
   * state setters and refs, so the effect can safely invoke the newest
   * closure.)
   */
  const executeRef = useRef(execute)
  executeRef.current = execute
  useEffect(() => {
    if (runRequest === null) return
    // Keep the composed statement visible even when the sequence was already
    // consumed (e.g. a boundary retry after the query settled); the user can
    // explicitly Run it again, but the remount itself is not permission to
    // replay it.
    setDraft(runRequest.sql)
    if (!claimRequest(runRequest)) return
    executeRef.current(runRequest.sql, 0, 'nested_action', runRequest.seq)
  }, [claimRequest, runRequest])

  /**
   * ug-1/R-01–R-02: after the matching request has rendered its outcome,
   * scroll the SQL section into view and focus that outcome. Depends only on
   * the settle state — not on draft edits or unrelated rerenders — and the
   * token is armed exclusively by an external request's settle (manual runs
   * and paging pass `null`). `scrollIntoView` is feature-checked because
   * happy-dom does not implement layout scrolling.
   */
  useEffect(() => {
    if (pendingRevealRef.current === null) return
    const target =
      runState.kind === 'error'
        ? errorRef.current
        : runState.kind === 'done' && page !== null
          ? page.rows.length === 0
            ? emptyRef.current
            : resultRef.current
          : null
    if (target === null) return
    pendingRevealRef.current = null
    const section = sectionRef.current
    if (section !== null && typeof section.scrollIntoView === 'function') {
      section.scrollIntoView({ block: 'start' })
    }
    target.focus()
  }, [runState, page])

  const cancel = (): void => {
    if (!running) return
    // Abandon the run first, exactly as before: the RunGuard token is
    // invalidated (so a late settlement never renders), the pane shows its
    // cancelled state, and `query_run` is emitted. Nothing below may change
    // that — a control the user has already pressed cannot depend on the
    // engine answering.
    guard.current.invalidate() // the abandoned run's late result never renders
    setRunState({ kind: 'cancelled' })
    telemetry.emit('query_run', {
      query_kind: 'user_sql',
      row_count_bucket: 'zero',
      duration_bucket: durationSince(startedAtRef.current ?? Date.now()),
      outcome: 'cancelled',
    })
    // THEN ask the engine to stop the compute (R-9/ADR 0052): the out-of-band
    // `engine/cancel-query` settles the parked query as a typed `cancelled`
    // result, and the worker's honest `cancelSent` boolean is deliberately
    // NOT turned into any claim here (the copy below is byte-identical and
    // promises nothing — copy freeze; Q4 is not selected). A cancel that is
    // refused (another op holds the lane) or throws cannot unwind the UI
    // state above, so it is swallowed rather than surfaced.
    try {
      void engineClient.cancelQuery().catch(() => undefined)
    } catch {
      // Synchronous refusal from the seam: the run is already abandoned.
    }
  }

  const pageBy = (delta: number): void => {
    if (running || page === null || lastRunSql.current === null) return
    execute(lastRunSql.current, page.offset + delta * SQL_PAGE_SIZE, 'paging')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      run()
    }
  }

  const summary = page === null ? null : summarizePage(page.offset, SQL_PAGE_SIZE, page.rows.length)

  const statusText =
    runState.kind === 'idle'
      ? 'Ready'
      : runState.kind === 'running'
        ? 'Running…'
        : runState.kind === 'done'
          ? 'Done'
          : runState.kind === 'cancelled'
            ? 'Cancelled'
            : 'Failed'

  return (
    <section
      ref={sectionRef}
      className="sql"
      data-testid="sql-panel"
      aria-label="SQL query"
      data-state={runState.kind}
    >
      <h2 className="visually-hidden">SQL</h2>
      <p className="sql-hint" data-testid="sql-hint">
        Query the opened table by its SQL name{' '}
        <code data-testid="sql-table-name">"{sqlTable}"</code> (the engine view for table{' '}
        <code data-testid="sql-table-id">{tableId}</code>) — e.g.{' '}
        <code data-testid="sql-hint-example">{`SELECT * FROM "${sqlTable}"`}</code>. Results are
        shown {String(SQL_PAGE_SIZE)} rows per page; press <kbd>Ctrl</kbd>+<kbd>Enter</kbd> (or{' '}
        <kbd>⌘</kbd>+<kbd>Enter</kbd>) to run. Queries read the file as opened — staged grid edits
        and grid filters are not part of this view.
      </p>
      <textarea
        id="sql-editor"
        className="sql-editor"
        data-testid="sql-input"
        aria-label="SQL query"
        spellCheck={false}
        autoComplete="off"
        rows={4}
        placeholder={`SELECT * FROM "${sqlTable}"`}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
        }}
        onKeyDown={onKeyDown}
      />
      <div className="sql-actions">
        <button
          type="button"
          className="sql-run"
          data-testid="sql-run"
          disabled={!runnable || running}
          onClick={run}
        >
          Run
        </button>
        <button
          type="button"
          className="sql-cancel"
          data-testid="sql-cancel"
          disabled={!running}
          onClick={cancel}
        >
          Cancel
        </button>
        <span className="sql-status" data-testid="sql-status">
          {statusText}
        </span>
      </div>
      {runState.kind === 'error' && (
        // Programmatic focus target for a nested action's execution error
        // (R-02); the alert role is the pre-existing visible contract.
        <p className="sql-error" role="alert" data-testid="sql-error" ref={errorRef} tabIndex={-1}>
          {runState.message}
        </p>
      )}
      {runState.kind === 'cancelled' && (
        <p className="sql-cancel-note" data-testid="sql-cancel-note">
          Cancelled. The engine has no query interrupt, so this query may still run to completion in
          the background (a following run queues behind it); its result is discarded and will not be
          shown.
        </p>
      )}
      {page !== null && summary !== null && (
        <>
          {page.rows.length === 0 ? (
            // Programmatic focus target for a nested action's empty result
            // (R-02); also the polite status for the outcome.
            <p
              className="sql-result-empty"
              data-testid="sql-result-empty"
              ref={emptyRef}
              tabIndex={-1}
              role="status"
            >
              {page.offset === 0
                ? 'The query returned no rows.'
                : 'No rows on this page — the result set ended before it.'}
            </p>
          ) : (
            <div
              className="sql-result"
              data-testid="sql-result"
              ref={resultRef}
              role="region"
              tabIndex={0}
              aria-label={`SQL result — ${summary.label}`}
            >
              <table className="sql-result-table">
                <thead>
                  <tr>
                    {page.columns.map((name, index) => (
                      <th key={index} scope="col" data-testid="sql-result-header">
                        {name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} data-testid="sql-result-row">
                      {row.map((cell, columnIndex) => (
                        <td key={columnIndex} data-testid="sql-result-cell">
                          {formatCell(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="sql-pager">
            <button
              type="button"
              data-testid="sql-page-prev"
              disabled={!summary.hasPrev || running}
              onClick={() => {
                pageBy(-1)
              }}
            >
              ← Previous
            </button>
            <span data-testid="sql-page-info">{summary.label}</span>
            <button
              type="button"
              data-testid="sql-page-next"
              disabled={summary.isFinalPage || running}
              onClick={() => {
                pageBy(1)
              }}
            >
              Next →
            </button>
          </div>
          {!summary.isEmpty && summary.isFinalPage && (
            <p className="sql-result-exhausted" data-testid="sql-result-exhausted">
              End of results — this page had fewer rows than a full page.
            </p>
          )}
          {page.truncatedInTransport && (
            <p className="sql-result-truncated" data-testid="sql-result-truncated">
              This page exceeded one Arrow batch — only its first batch was delivered by the engine.
            </p>
          )}
        </>
      )}
    </section>
  )
}
