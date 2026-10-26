// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TelemetryProvider } from '../telemetry/TelemetryContext'
import type { WebTelemetryRuntime } from '../telemetry/runtime'
import { SqlPanel } from './SqlPanel'
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

function renderPanel(
  runtime: WebTelemetryRuntime,
  runRequest: { sql: string; seq: number } | null = null,
) {
  return render(
    <TelemetryProvider runtime={runtime}>
      <SqlPanel tableId="t1" runRequest={runRequest} />
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
    renderPanel(fakeRuntime(), { sql: 'SELECT * FROM empty_view', seq: 1 })

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
    renderPanel(fakeRuntime(), { sql: 'SELECT * FROM missing_view', seq: 1 })

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
    const { rerender } = renderPanel(runtime, { sql: 'SELECT broken', seq: 1 })

    const error = await screen.findByTestId('sql-error')
    await waitFor(() => {
      expect(document.activeElement).toBe(error)
    })

    h.query.mockResolvedValueOnce(result(3))
    rerender(
      <TelemetryProvider runtime={runtime}>
        <SqlPanel tableId="t1" runRequest={{ sql: 'SELECT repaired', seq: 2 }} />
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
    const request = { sql: 'SELECT page_one', seq: 1 }
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
        <SqlPanel tableId="t1" runRequest={request} />
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
