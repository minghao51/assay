// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TelemetryProvider } from '../telemetry/TelemetryContext'
import type { WebTelemetryRuntime } from '../telemetry/runtime'
import { SqlPanel } from './SqlPanel'
import { SQL_PAGE_SIZE } from './paged-query'

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
  runRequest = null as null | { sql: string; seq: number },
) {
  render(
    <TelemetryProvider runtime={runtime}>
      <SqlPanel tableId="t1" runRequest={runRequest} />
    </TelemetryProvider>,
  )
}

afterEach(cleanup)
beforeEach(() => {
  h.query.mockReset()
  h.query.mockResolvedValue(result(SQL_PAGE_SIZE))
})

describe('SqlPanel telemetry — query_run (design §2/Appendix C)', () => {
  it('emits user_sql with a coarse row bucket on a successful run', async () => {
    const runtime = fakeRuntime()
    renderPanel(runtime)
    fireEvent.change(screen.getByTestId('sql-input'), { target: { value: 'SELECT 1' } })
    fireEvent.click(screen.getByTestId('sql-run'))
    await waitFor(() => {
      expect(runtime.emit).toHaveBeenCalledWith('query_run', {
        query_kind: 'user_sql',
        row_count_bucket: '1_1k',
        duration_bucket: 'lt_50ms',
        outcome: 'success',
      })
    })
  })

  it('emits nested_action for a composed external request', async () => {
    const runtime = fakeRuntime()
    renderPanel(runtime, { sql: 'SELECT 1', seq: 1 })
    await waitFor(() => {
      expect(runtime.emit).toHaveBeenCalledWith(
        'query_run',
        expect.objectContaining({ query_kind: 'nested_action' }),
      )
    })
  })

  it('emits paging when moving to the next page', async () => {
    const runtime = fakeRuntime()
    renderPanel(runtime)
    fireEvent.change(screen.getByTestId('sql-input'), { target: { value: 'SELECT 1' } })
    fireEvent.click(screen.getByTestId('sql-run'))
    await waitFor(() => {
      expect(screen.getByTestId('sql-page-next')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('sql-page-next'))
    await waitFor(() => {
      expect(runtime.emit).toHaveBeenCalledWith(
        'query_run',
        expect.objectContaining({ query_kind: 'paging' }),
      )
    })
  })

  it('emits cancelled when a running query is abandoned', async () => {
    let resolveQuery: ((value: unknown) => void) | undefined
    h.query.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQuery = resolve
        }),
    )
    const runtime = fakeRuntime()
    renderPanel(runtime)
    fireEvent.change(screen.getByTestId('sql-input'), { target: { value: 'SELECT 1' } })
    fireEvent.click(screen.getByTestId('sql-run'))
    fireEvent.click(screen.getByTestId('sql-cancel'))
    expect(runtime.emit).toHaveBeenCalledWith(
      'query_run',
      expect.objectContaining({ query_kind: 'user_sql', outcome: 'cancelled' }),
    )
    resolveQuery?.(result(1))
  })
})
