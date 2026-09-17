import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { viewNameForTableId } from '@assay/engine-duckdb'
import { formatCell } from '../grid/format'
import { projectBatchToRows } from '../grid/provider'
import { engineClient } from '../lib/engine'
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
 */

interface SqlPanelProps {
  /** Engine-generated id of the opened table (safe to show and query). */
  readonly tableId: string
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
  return error instanceof Error ? error.message : String(error)
}

export function SqlPanel({ tableId }: SqlPanelProps) {
  const sqlTable = viewNameForTableId(tableId)
  const [draft, setDraft] = useState('')
  const [runState, setRunState] = useState<RunState>({ kind: 'idle' })
  const [page, setPage] = useState<PageResult | null>(null)
  const lastRunSql = useRef<string | null>(null)
  const guard = useRef(new RunGuard())

  const running = runState.kind === 'running'
  const runnable = composePageQuery(draft, { limit: SQL_PAGE_SIZE, offset: 0 }).ok

  /**
   * Execute the statement for one page. The async tail (begin a guard
   * token, deliver only while that token is active) is the pure helper
   * `runGuarded` — Node-pinned in `guarded-run.test.ts`: a cancelled or
   * superseded run's late result/rejection is discarded and can never
   * clobber the pane's current state.
   */
  const execute = (userSql: string, offset: number): void => {
    const composed = composePageQuery(userSql, { limit: SQL_PAGE_SIZE, offset })
    if (!composed.ok) {
      setRunState({ kind: 'error', message: composed.reason })
      return
    }
    lastRunSql.current = userSql
    setRunState({ kind: 'running' })
    setPage(null)
    runGuarded(guard.current, engineClient.query(composed.sql), {
      onResult: (result) => {
        setPage({
          columns: resultColumnNames(result.batch),
          rows: projectBatchToRows(result.batch),
          offset,
          truncatedInTransport: result.hasMore,
        })
        setRunState({ kind: 'done' })
      },
      onError: (cause: unknown) => {
        // Engine errors (EngineQueryError & co.) surface as readable alert
        // text; the pane (and engine) stay usable for the next run.
        setRunState({ kind: 'error', message: errorMessage(cause) })
      },
    })
  }

  const run = (): void => {
    if (running) return
    execute(draft, 0) // a fresh Run always starts at the first page
  }

  const cancel = (): void => {
    if (!running) return
    guard.current.invalidate() // the abandoned run's late result never renders
    setRunState({ kind: 'cancelled' })
  }

  const pageBy = (delta: number): void => {
    if (running || page === null || lastRunSql.current === null) return
    execute(lastRunSql.current, page.offset + delta * SQL_PAGE_SIZE)
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
      className="sql"
      data-testid="sql-panel"
      aria-label="SQL query"
      data-state={runState.kind}
    >
      <p className="sql-hint" data-testid="sql-hint">
        Query the opened table by its SQL name{' '}
        <code data-testid="sql-table-name">"{sqlTable}"</code> (the engine view for table{' '}
        <code data-testid="sql-table-id">{tableId}</code>) — e.g.{' '}
        <code data-testid="sql-hint-example">{`SELECT * FROM "${sqlTable}"`}</code>. Results are
        shown {String(SQL_PAGE_SIZE)} rows per page; press <kbd>Ctrl</kbd>+<kbd>Enter</kbd> (or{' '}
        <kbd>⌘</kbd>+<kbd>Enter</kbd>) to run.
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
        <p className="sql-error" role="alert" data-testid="sql-error">
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
            <p className="sql-result-empty" data-testid="sql-result-empty">
              {page.offset === 0
                ? 'The query returned no rows.'
                : 'No rows on this page — the result set ended before it.'}
            </p>
          ) : (
            <div className="sql-result" data-testid="sql-result">
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
