// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * ug-15 / UG-6 — drag-and-drop open through the REAL App composition root,
 * with only the picker/engine boundaries faked (the `App.open-status` posture).
 *
 * What this file pins:
 *
 * 1. An idle drop of a `File` enters `openDataFile` itself: the engine sees
 *    the dropped file, the picker is NEVER invoked (`pickerCalls === 0`), and
 *    the normal opening → ready phase transition completes.
 * 2. Window-level `dragover`/`drop` always `preventDefault()` (the browser's
 *    default would navigate away), but a drop while opening/ready is inert:
 *    no new engine open, no picker, no phase change.
 * 3. A drop with no `File` (dragged text) shows readable inline copy, stays
 *    idle, and never reaches the engine.
 * 4. A dropped unsupported file follows the same chain and lands in the
 *    existing classified `open-error` surface (no second error UI).
 * 5. The visible drop affordance renders on idle only and is real text.
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

const h = vi.hoisted(() => ({
  deferOpen: false,
  openError: false,
  openErrorMessage: 'unsupported dataset format: engine reads .parquet, .csv, .jsonl, .json',
  openResolvers: [] as Array<(value: unknown) => void>,
  openCalls: [] as Array<{ name: string; getFile: () => Promise<File> }>,
  pickerCalls: 0,
}))

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } }> => {
    h.pickerCalls += 1
    return { source: { getFile: async () => new File(['id\n1\n'], 'picked.jsonl') } }
  },
}))

vi.mock('./lib/engine', () => ({
  engineClient: {
    open: async (source: { name: string; getFile: () => Promise<File> }) => {
      h.openCalls.push(source)
      if (h.deferOpen) {
        await new Promise<unknown>((resolve) => h.openResolvers.push(resolve))
      }
      if (h.openError) throw new Error(h.openErrorMessage)
      return FAKE_HANDLE
    },
    schema: async () => FAKE_SCHEMA,
    rowCount: async () => 1,
    fetchRange: async () => ({ batch: fakeBatch(), hasMore: false }),
  },
}))

// The engine-calling panels are orthogonal to these pins (they have e2e
// coverage); SchemaPanel stays real because the ready phase focuses it.
vi.mock('./sql/SqlPanel', () => ({ SqlPanel: () => null }))
vi.mock('./profile/ProfilePanel', () => ({ ProfilePanel: () => null }))

afterEach(() => {
  cleanup()
  h.deferOpen = false
  h.openError = false
  h.openResolvers = []
  h.openCalls = []
  h.pickerCalls = 0
})

/** Open through the real picker path and wait for the ready UI. */
async function openThroughPicker(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('schema-section')
}

/** Dispatch a drop carrying `files` (may be empty) and return the event. */
async function dropFiles(files: File[]): Promise<Event> {
  const event = createEvent.drop(window, { dataTransfer: { files } })
  await act(async () => {
    fireEvent(window, event)
  })
  return event
}

describe('ug-15 — idle drag-and-drop open', () => {
  it('opens a dropped File through openDataFile with no picker call', async () => {
    render(<App />)

    // `dragover` must cancel the browser default that would navigate away.
    const dragOver = createEvent.dragOver(window)
    fireEvent(window, dragOver)
    expect(dragOver.defaultPrevented).toBe(true)

    const dropped = new File(['customer_id\n1\n'], 'dropped.csv', { type: 'text/csv' })
    const drop = await dropFiles([dropped])
    expect(drop.defaultPrevented).toBe(true)

    await screen.findByTestId('schema-section')
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
    // The SAME open chain consumed the dropped file; the picker never ran.
    expect(h.pickerCalls).toBe(0)
    expect(h.openCalls).toHaveLength(1)
    expect(h.openCalls[0]?.name).toBe('dropped.csv')
    expect(typeof h.openCalls[0]?.getFile).toBe('function')
    // The idle-only affordance leaves with the idle screen.
    expect(screen.queryByTestId('idle-drop-hint')).toBeNull()
  })

  it('ignores a drop while ready: no new open and the phase is unchanged', async () => {
    render(<App />)
    await openThroughPicker()
    expect(h.pickerCalls).toBe(1)
    expect(h.openCalls).toHaveLength(1)

    const drop = createEvent.drop(window, {
      dataTransfer: { files: [new File(['id\n2\n'], 'second.jsonl')] },
    })
    await act(async () => {
      fireEvent(window, drop)
    })

    expect(drop.defaultPrevented).toBe(true)
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
    expect(h.pickerCalls).toBe(1)
    expect(h.openCalls).toHaveLength(1)
    expect(screen.queryByTestId('idle-drop-hint')).toBeNull()
    expect(screen.getByTestId('schema-section')).toBeTruthy()
  })

  it('ignores a drop while opening and does not bump the open', async () => {
    h.deferOpen = true
    render(<App />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('opening')
    expect(h.openCalls).toHaveLength(1)

    const drop = createEvent.drop(window, {
      dataTransfer: { files: [new File(['id\n2\n'], 'second.jsonl')] },
    })
    await act(async () => {
      fireEvent(window, drop)
    })

    expect(drop.defaultPrevented).toBe(true)
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('opening')
    // The dropped file was not parked and consumed as a second open.
    expect(h.openCalls).toHaveLength(1)
    expect(h.pickerCalls).toBe(1)
    expect(screen.queryByTestId('idle-drop-hint')).toBeNull()
  })

  it('shows readable copy for a drop with no File and stays idle', async () => {
    render(<App />)
    expect(screen.getByTestId('idle-drop-hint').textContent).toBe(
      'Or drop a data file anywhere on this page',
    )

    const drop = await dropFiles([])

    expect(drop.defaultPrevented).toBe(true)
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('idle')
    expect(screen.getByTestId('drop-notice').textContent).toBe(
      'That drop did not include a file. Drop a .parquet, .csv, .jsonl or .json file to open it.',
    )
    // A no-file drop never reaches the picker or the engine.
    expect(h.pickerCalls).toBe(0)
    expect(h.openCalls).toHaveLength(0)
    expect(screen.getByTestId('idle-drop-hint')).toBeTruthy()
  })

  it('routes a dropped unsupported file into the existing classified open-error', async () => {
    h.openError = true
    render(<App />)

    const drop = createEvent.drop(window, {
      dataTransfer: { files: [new File(['not a dataset'], 'notes.txt', { type: 'text/plain' })] },
    })
    await act(async () => {
      fireEvent(window, drop)
    })

    expect(drop.defaultPrevented).toBe(true)
    const alert = await screen.findByTestId('open-error')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('error')
    expect(screen.getByTestId('open-error-cause').textContent).toBe(
      'The file could not be opened. This file type is not supported — ' +
        'open a .parquet, .csv, .jsonl or .json file.',
    )
    // The drop took the same chain, not a second error surface.
    expect(screen.getAllByTestId('open-error')).toHaveLength(1)
    expect(h.pickerCalls).toBe(0)
    expect(h.openCalls).toHaveLength(1)
    expect(h.openCalls[0]?.name).toBe('notes.txt')
    expect(screen.queryByTestId('idle-drop-hint')).toBeNull()
  })
})
