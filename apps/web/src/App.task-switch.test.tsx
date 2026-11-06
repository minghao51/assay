// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'
import { engineClient } from './lib/engine'

/**
 * rd-3/rd-4 — task switching must be presentation only.
 *
 * The shell groups the twelve sections into four tasks (UI-RD-01). This file
 * drives the REAL App and proves the load-bearing claim: switching tasks does
 * not remount a panel, does not lose local draft text, and performs ZERO extra
 * engine work (no open/schema/rowCount/fetch). The panels are already mounted
 * behind `hidden` bodies; task visibility is CSS at ≥1024px and nothing else.
 */

const FAKE_HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }

const FAKE_SCHEMA: readonly { name: string; type: string }[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'country', type: 'VARCHAR' },
]

function fakeBatch(): ArrowTableLike {
  const columns = [{ get: () => 1 }, { get: () => 'SG' }]
  return {
    numRows: 1,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
  }
}

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } }> => ({
    source: { getFile: async () => new File(['id\n1\n'], 'evidence.jsonl') },
  }),
}))

vi.mock('./lib/engine', () => ({
  engineClient: {
    open: vi.fn(async () => FAKE_HANDLE),
    schema: vi.fn(async () => FAKE_SCHEMA),
    rowCount: vi.fn(async () => 1),
    fetchRange: vi.fn(async () => ({ batch: fakeBatch(), hasMore: false })),
  },
}))

afterEach(cleanup)

async function open(): Promise<void> {
  render(<App />)
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('schema-section')
  // The below-fold panels resolve asynchronously; wait for one of them so the
  // identity assertions below compare a mounted panel, not `null`.
  await screen.findByTestId('sql-panel')
  await screen.findByTestId('diff-panel')
}

function engineCalls(): number {
  return (
    vi.mocked(engineClient.open).mock.calls.length +
    vi.mocked(engineClient.schema).mock.calls.length +
    vi.mocked(engineClient.rowCount).mock.calls.length +
    vi.mocked(engineClient.fetchRange).mock.calls.length
  )
}

function clickTasks(times: number): void {
  const order = ['check', 'change', 'prepare', 'explore'] as const
  for (let index = 0; index < times; index += 1) {
    const task = order[index % order.length] ?? 'explore'
    fireEvent.click(screen.getByTestId(`task-${task}`))
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('rd-3 — task switching preserves the session', () => {
  it('keeps the SQL draft and the mounted panels across eight task switches', async () => {
    await open()

    fireEvent.click(screen.getByTestId('section-toggle-sql'))
    const input = screen.getByTestId('sql-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'select 1 as one' } })
    expect(input.value).toBe('select 1 as one')

    const sqlPanel = screen.getByTestId('sql-panel')
    const diffPanel = screen.getByTestId('diff-panel')
    const callsBefore = engineCalls()

    clickTasks(8)

    // Same nodes: nothing remounted, so DiffPanel's B staging / key mode and
    // the SQL editor's local state cannot be dropped by a switch.
    expect(screen.getByTestId('sql-panel')).toBe(sqlPanel)
    expect(screen.getByTestId('diff-panel')).toBe(diffPanel)
    expect(screen.getByTestId('sql-input')).toBe(input)
    expect((screen.getByTestId('sql-input') as HTMLTextAreaElement).value).toBe('select 1 as one')

    // Zero extra engine work: no reopen, no schema/rowCount/fetch.
    expect(engineCalls()).toBe(callsBefore)
  })

  it('does not remount or re-run anything when the active task repeats', async () => {
    await open()
    const diffPanel = screen.getByTestId('diff-panel')
    const callsBefore = engineCalls()

    for (let index = 0; index < 4; index += 1) {
      fireEvent.click(screen.getByTestId('task-check'))
    }

    expect(screen.getByTestId('diff-panel')).toBe(diffPanel)
    expect(engineCalls()).toBe(callsBefore)
  })

  it('keeps exactly one checked task and the section groups intact', async () => {
    await open()
    fireEvent.click(screen.getByTestId('task-prepare'))

    const radios = screen.getAllByRole('radio')
    expect(radios.filter((radio) => radio.getAttribute('aria-checked') === 'true')).toHaveLength(1)
    expect(screen.getByTestId('task-prepare').getAttribute('aria-checked')).toBe('true')

    // All four groups remain in the DOM and exposed; `data-active` marks the
    // selected task. Conditional exposure of inactive groups is deferred, so
    // every section link stays reachable.
    for (const task of ['explore', 'check', 'change', 'prepare'] as const) {
      const group = screen.getByTestId(`section-nav-group-${task}`)
      expect(group.getAttribute('data-active')).toBe(task === 'prepare' ? 'true' : 'false')
    }
    expect(screen.getByTestId('section-nav-pipeline')).toBeTruthy()
  })

  it('resets the active task to Explore when a new dataset session starts', async () => {
    await open()
    fireEvent.click(screen.getByTestId('task-prepare'))
    expect(screen.getByTestId('task-prepare').getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })
    await screen.findByTestId('schema-section')

    expect(screen.getByTestId('task-explore').getAttribute('aria-checked')).toBe('true')
  })

  it('renders the context bar with neutral facts and no filename', async () => {
    await open()
    const bar = screen.getByTestId('dataset-context')
    expect(bar.textContent).toContain('Current dataset view')
    expect(bar.textContent).toContain('1 row × 2 columns')
    expect(bar.textContent).toContain('No staged operations')
    expect(bar.textContent).not.toContain('evidence.jsonl')
    expect(screen.getByTestId('context-state').getAttribute('role')).toBe('status')
  })
})
