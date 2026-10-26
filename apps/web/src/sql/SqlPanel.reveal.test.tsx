// SPDX-License-Identifier: AGPL-3.0-or-later

import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqlRequestLedger } from '../App'
import { TelemetryProvider } from '../telemetry/TelemetryContext'
import type { WebTelemetryRuntime } from '../telemetry/runtime'
import { SqlPanel } from './SqlPanel'
import type { SqlRunRequest } from './SqlPanel'
import { SQL_PAGE_SIZE } from './paged-query'

/**
 * ug-1 / R-01–R-02 reveal pins (component level).
 *
 * An external `runRequest` (a nested one-click action) must reveal and focus
 * the outcome that belongs to THAT request sequence:
 *
 * - populated  → the named, focusable `.sql-result` scroll region;
 * - empty      → the `.sql-result-empty` status target;
 * - rejection  → the `.sql-error` alert target.
 *
 * A later sequence re-arms the reveal (and focuses its own outcome), while
 * manual Run / paging / typing must not steal focus. The mocked engine call
 * count + composed statements prove the sequence, not just a rendered row.
 */

const h = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('../lib/engine', () => ({
  engineClient: { query: h.query },
}))

function fakeRuntime(): WebTelemetryRuntime {
  return {
    surface: 'web',
    hardOff: false,
    endpointConfigured: true,
    emit: vi.fn(),
    flush: vi.fn(async () => undefined),
    getPreference: () => 'on',
    setPreference: vi.fn(),
    isEnabledNow: () => true,
    shouldShowDisclosure: () => false,
    markDisclosureShown: vi.fn(),
    dispose: vi.fn(),
  }
}

function result(rows: number) {
  const column = { get: () => 1 }
  return {
    batch: {
      numRows: rows,
      numCols: 1,
      getChildAt: () => column,
      schema: { fields: [{ name: 'id' }] },
    },
    hasMore: false,
  }
}

/** Every request is new for the pure reveal pins. */
const allowRequest = (): boolean => true

function renderPanel(
  runtime: WebTelemetryRuntime,
  runRequest: SqlRunRequest | null = null,
  claimRequest: (request: SqlRunRequest) => boolean = allowRequest,
) {
  return render(
    <TelemetryProvider runtime={runtime}>
      <SqlPanel tableId="t1" runRequest={runRequest} claimRequest={claimRequest} />
    </TelemetryProvider>,
  )
}

/** The composer-owned page wrap (proves the query actually ran). */
function pageSql(sql: string): string {
  return `SELECT * FROM (${sql}) AS _assay_page LIMIT 50 OFFSET 0`
}

afterEach(cleanup)
beforeEach(() => {
  h.query.mockReset()
})

describe('SqlPanel reveal (ug-1 / R-01–R-02)', () => {
  it('focuses the empty-result target with tabindex="-1" for an external request that returns no rows', async () => {
    h.query.mockResolvedValue(result(0))
    renderPanel(fakeRuntime(), { sql: 'SELECT * FROM empty_view', seq: 1, session: 1 })

    const empty = await screen.findByTestId('sql-result-empty')
    await waitFor(() => {
      expect(document.activeElement).toBe(empty)
    })

    expect(screen.queryByTestId('sql-result')).toBeNull()
    expect(empty.getAttribute('role')).toBe('status')
    // A bare <p> cannot receive programmatic focus; without this attribute
    // the reveal silently drops focus in a real browser (review drill).
    expect(empty.getAttribute('tabindex')).toBe('-1')
    expect((screen.getByTestId('sql-input') as HTMLTextAreaElement).value).toBe(
      'SELECT * FROM empty_view',
    )
    expect(h.query).toHaveBeenCalledTimes(1)
    expect(h.query).toHaveBeenCalledWith(pageSql('SELECT * FROM empty_view'))
  })

  it('focuses the execution-error target with tabindex="-1" for a rejected external request', async () => {
    h.query.mockRejectedValue(new Error('Catalog Error: Table does not exist'))
    renderPanel(fakeRuntime(), { sql: 'SELECT * FROM missing_view', seq: 1, session: 1 })

    const error = await screen.findByTestId('sql-error')
    await waitFor(() => {
      expect(document.activeElement).toBe(error)
    })

    expect(error.getAttribute('role')).toBe('alert')
    // Same programmatic-focus contract as the empty target.
    expect(error.getAttribute('tabindex')).toBe('-1')
    expect(error.textContent).toContain('Catalog Error: Table does not exist')
    expect((screen.getByTestId('sql-input') as HTMLTextAreaElement).value).toBe(
      'SELECT * FROM missing_view',
    )
    expect(h.query).toHaveBeenCalledTimes(1)
    expect(h.query).toHaveBeenCalledWith(pageSql('SELECT * FROM missing_view'))
  })

  it('re-arms the reveal for a newer sequence after an error (new target, not the old one)', async () => {
    h.query.mockRejectedValueOnce(new Error('first request failed'))
    const runtime = fakeRuntime()
    const { rerender } = renderPanel(runtime, { sql: 'SELECT broken', seq: 1, session: 1 })

    const error = await screen.findByTestId('sql-error')
    await waitFor(() => {
      expect(document.activeElement).toBe(error)
    })

    h.query.mockResolvedValueOnce(result(3))
    rerender(
      <TelemetryProvider runtime={runtime}>
        <SqlPanel
          tableId="t1"
          runRequest={{ sql: 'SELECT repaired', seq: 2, session: 1 }}
          claimRequest={allowRequest}
        />
      </TelemetryProvider>,
    )

    const region = await screen.findByTestId('sql-result')
    await waitFor(() => {
      expect(document.activeElement).toBe(region)
    })

    expect(screen.queryByTestId('sql-error')).toBeNull()
    expect(region.getAttribute('role')).toBe('region')
    expect(region.getAttribute('aria-label')).toBe('SQL result — rows 1–3')
    expect(region.getAttribute('tabindex')).toBe('0')
    expect((screen.getByTestId('sql-input') as HTMLTextAreaElement).value).toBe('SELECT repaired')
    expect(h.query).toHaveBeenCalledTimes(2)
    expect(h.query).toHaveBeenNthCalledWith(1, pageSql('SELECT broken'))
    expect(h.query).toHaveBeenNthCalledWith(2, pageSql('SELECT repaired'))
  })

  it('does not steal focus to the result on a manual Run', async () => {
    h.query.mockResolvedValue(result(2))
    renderPanel(fakeRuntime())

    fireEvent.change(screen.getByTestId('sql-input'), { target: { value: 'SELECT 42' } })
    const runButton = screen.getByTestId('sql-run')
    runButton.focus()
    fireEvent.click(runButton)

    const region = await screen.findByTestId('sql-result')
    await waitFor(() => {
      expect(screen.getByTestId('sql-status').textContent).toBe('Done')
    })

    expect(document.activeElement).toBe(runButton)
    expect(document.activeElement).not.toBe(region)
    expect(h.query).toHaveBeenCalledTimes(1)
    expect(h.query).toHaveBeenCalledWith(pageSql('SELECT 42'))
  })

  it('keeps focus off the result on unrelated typing/rerender and on paging', async () => {
    h.query.mockResolvedValue(result(SQL_PAGE_SIZE))
    const runtime = fakeRuntime()
    const request = { sql: 'SELECT page_one', seq: 1, session: 1 }
    const { rerender } = renderPanel(runtime, request)

    const region = await screen.findByTestId('sql-result')
    await waitFor(() => {
      expect(document.activeElement).toBe(region)
    })

    // Unrelated draft typing / rerender: the reveal effect depends only on
    // the settle state, so focus must stay on the revealed outcome.
    fireEvent.change(screen.getByTestId('sql-input'), { target: { value: 'SELECT typed' } })
    rerender(
      <TelemetryProvider runtime={runtime}>
        <SqlPanel tableId="t1" runRequest={request} claimRequest={allowRequest} />
      </TelemetryProvider>,
    )
    expect(document.activeElement).toBe(region)

    // Paging is a user-initiated run, not a reveal: after the next page
    // renders the result must not be focused programmatically.
    fireEvent.click(screen.getByTestId('sql-page-next'))
    await waitFor(() => {
      expect(h.query).toHaveBeenCalledTimes(2)
    })
    await screen.findByTestId('sql-result')
    expect(document.activeElement).not.toBe(screen.getByTestId('sql-result'))
    expect(h.query).toHaveBeenNthCalledWith(
      2,
      pageSql('SELECT page_one').replace('OFFSET 0', 'OFFSET 50'),
    )
  })
})

describe('SqlPanel external request lifetime (R-07)', () => {
  const request: SqlRunRequest = { sql: 'SELECT nested', seq: 1, session: 1 }

  function claimer(ledger: ReturnType<typeof createSqlRequestLedger>, token: number) {
    return (candidate: SqlRunRequest): boolean => ledger.claim(candidate, token)
  }

  function panel(
    runtime: WebTelemetryRuntime,
    candidate: SqlRunRequest,
    claim: (request: SqlRunRequest) => boolean,
  ) {
    return (
      <TelemetryProvider runtime={runtime}>
        <SqlPanel tableId="t1" runRequest={candidate} claimRequest={claim} />
      </TelemetryProvider>
    )
  }

  it('runs an initial external request exactly once', async () => {
    h.query.mockResolvedValue(result(2))
    const ledger = createSqlRequestLedger()
    renderPanel(fakeRuntime(), request, claimer(ledger, 1))
    await waitFor(() => {
      expect(h.query).toHaveBeenCalledTimes(1)
    })
    expect(h.query).toHaveBeenCalledWith(pageSql('SELECT nested'))
  })

  it('runs zero additional queries on StrictMode double effect with the same sequence', async () => {
    h.query.mockResolvedValue(result(2))
    const ledger = createSqlRequestLedger()
    render(<StrictMode>{panel(fakeRuntime(), request, claimer(ledger, 1))}</StrictMode>)
    await waitFor(() => {
      expect(h.query).toHaveBeenCalledTimes(1)
    })
    await act(async () => {})
    expect(h.query).toHaveBeenCalledTimes(1)
  })

  it('runs zero additional queries when a true remount sees the same consumed sequence', async () => {
    h.query.mockResolvedValue(result(2))
    const ledger = createSqlRequestLedger()
    const claim = claimer(ledger, 1)
    const first = renderPanel(fakeRuntime(), request, claim)
    await waitFor(() => {
      expect(h.query).toHaveBeenCalledTimes(1)
    })

    // Boundary retry / close-reopen remounts the component with the same App
    // state. The App-owned ledger already consumed seq 1: no replay.
    first.unmount()
    renderPanel(fakeRuntime(), request, claim)
    await act(async () => {})
    expect(h.query).toHaveBeenCalledTimes(1)
    // The composed statement is still visible for an explicit manual Run.
    expect((screen.getByTestId('sql-input') as HTMLTextAreaElement).value).toBe('SELECT nested')
  })

  it('runs exactly one query for a genuinely new sequence', async () => {
    h.query.mockResolvedValue(result(2))
    const ledger = createSqlRequestLedger()
    const claim = claimer(ledger, 1)
    const runtime = fakeRuntime()
    const { rerender } = renderPanel(runtime, request, claim)
    await waitFor(() => {
      expect(h.query).toHaveBeenCalledTimes(1)
    })

    rerender(panel(runtime, { sql: 'SELECT newer', seq: 2, session: 1 }, claim))
    await waitFor(() => {
      expect(h.query).toHaveBeenCalledTimes(2)
    })
    expect(h.query).toHaveBeenNthCalledWith(2, pageSql('SELECT newer'))
  })

  it('rejects a stale-session request and runs the replacement session exactly once', async () => {
    h.query.mockResolvedValue(result(2))
    const ledger = createSqlRequestLedger()
    const claim = claimer(ledger, 2)
    const runtime = fakeRuntime()
    const stale = { sql: 'SELECT stale', seq: 9, session: 1 } as const

    const view = renderPanel(runtime, stale, claim)
    await act(async () => {})
    expect(h.query).not.toHaveBeenCalled()

    view.rerender(panel(runtime, { sql: 'SELECT fresh', seq: 10, session: 2 }, claim))
    await waitFor(() => {
      expect(h.query).toHaveBeenCalledTimes(1)
    })
    expect(h.query).toHaveBeenCalledWith(pageSql('SELECT fresh'))
  })

  it('never lets a late acknowledgment of an older sequence erase a newer claim', () => {
    const ledger = createSqlRequestLedger()
    expect(ledger.claim(request, 1)).toBe(true)
    const newer: SqlRunRequest = { sql: 'SELECT newer', seq: 2, session: 1 }
    expect(ledger.claim(newer, 1)).toBe(true)
    // A late remount/re-acknowledgment of the older sequence is not new and
    // cannot reset the ledger; the newer sequence stays consumed too.
    expect(ledger.claim(request, 1)).toBe(false)
    expect(ledger.claim(newer, 1)).toBe(false)
  })
})
