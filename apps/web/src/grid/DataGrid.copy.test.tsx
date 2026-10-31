// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GridViewportModel } from '@assay/grid'
import type { OverlayState } from '@assay/domain'
import { DataGrid } from './DataGrid'

/**
 * ug-5 (UG-11) component pins: Ctrl/Cmd+C copies the focused non-editing
 * cell's DISPLAY text into the local clipboard and announces exactly one
 * value-free message through the existing single polite live region
 * (`onEditAnnounce`).
 *
 * The pins trace the contract one clause at a time:
 * 1. Ctrl+C / Cmd+C on a focused cell → one `writeText` with the exact
 *    display text (decimal decoded, nested preview bounded), the event's
 *    default prevented, and `Value copied.` announced.
 * 2. An open editor wins: a copy keydown inside the editor input is left to
 *    the browser (not prevented, no write), and the editor wrapper's NULL
 *    button cannot route a copy to the grid either.
 * 3. An empty/NULL cell writes nothing and announces the empty-cell message.
 * 4. A rejected `writeText` (denied/unavailable) announces the failure
 *    message — and the promise rejection is handled, so the test would fail
 *    on an unhandled rejection.
 * 5. A missing clipboard API announces the failure without throwing.
 * 6. Plain `c`, extra modifiers and a row-focused (no cell) target are not
 *    intercepted, so native copy keeps working.
 *
 * Privacy (ADR 0025): every announcement is asserted value-free — the copied
 * text never appears in the live region. No telemetry is involved.
 *
 * The virtualizer is faked (no layout in happy-dom) so the rendered window is
 * deterministic, following `DataGrid.keyboard.test.tsx`.
 */

interface VirtualItem {
  index: number
  key: string
  start: number
  size: number
}

const h = vi.hoisted(() => ({
  rows: [] as VirtualItem[],
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => h.rows,
    getTotalSize: () => h.rows.length * 28,
    scrollToIndex: vi.fn(),
  }),
}))

h.rows = [0, 1, 2].map((index) => ({
  index,
  key: `row-${String(index)}`,
  start: index * 28,
  size: 28,
}))

const SCHEMA: readonly { name: string; type: string }[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'name', type: 'VARCHAR' },
  { name: 'amount', type: 'DECIMAL(10,2)' },
  { name: 'meta', type: 'STRUCT("a" BIGINT)' },
]

/** Arrow `DecimalBigNum` for `DECIMAL(10,2)` unscaled 5_200_000 → `52000.00`. */
function decimalPayload(): Uint8Array {
  const payload = new Uint8Array(16)
  payload.set([0x80, 0x58, 0x4f, 0x00])
  return payload
}

function fakeModel(): GridViewportModel {
  return {
    subscribe: () => () => {},
    getVersion: () => 0,
    schema: SCHEMA,
    totalRows: 3,
    sort: null,
    filters: [],
    stats: {
      fetchCalls: 0,
      rowsRequested: 0,
      rowsReceived: 0,
      maxSpanRows: 0,
      cachedRows: 0,
      failedSpans: 0,
      fatalError: null,
    },
    getRow: (index: number) =>
      index >= 0 && index < 3
        ? {
            status: 'ready',
            // Row 2's `name` is NULL: the real fixture shape the empty-cell pin
            // exercises (customers.parquet row 3 has a NULL income).
            row: [
              index,
              index === 2 ? null : `name-${String(index)}`,
              decimalPayload(),
              { a: index },
            ],
            key: `base:${String(index)}`,
          }
        : { status: 'loading' },
    setSort: async () => {},
    setFilters: async () => {},
    observeViewport: () => {},
    retry: () => {},
  } as unknown as GridViewportModel
}

function fakeBooleanModel(): GridViewportModel {
  return {
    subscribe: () => () => {},
    getVersion: () => 0,
    schema: [{ name: 'flag', type: 'BOOLEAN' }],
    totalRows: 2,
    sort: null,
    filters: [],
    stats: {
      fetchCalls: 0,
      rowsRequested: 0,
      rowsReceived: 0,
      maxSpanRows: 0,
      cachedRows: 0,
      failedSpans: 0,
      fatalError: null,
    },
    getRow: (index: number) =>
      index >= 0 && index < 2
        ? { status: 'ready', row: [index % 2 === 0], key: `base:${String(index)}` }
        : { status: 'loading' },
    setSort: async () => {},
    setFilters: async () => {},
    observeViewport: () => {},
    retry: () => {},
  } as unknown as GridViewportModel
}

function fakeOverlay(): OverlayState {
  return {
    anchors: { baseAnchor: 'b', overlayAnchor: 'o' },
    columns: [],
    edits: new Map(),
    inserts: new Map(),
    deletedBase: new Set(),
    nextInsertSeq: 0,
  } as unknown as OverlayState
}

type ClipboardWrite = (text: string) => Promise<void>

/** Install a `navigator.clipboard.writeText` stub (happy-dom has none usable). */
function installClipboard(writeText: ClipboardWrite): ReturnType<typeof vi.fn> {
  const stub = vi.fn(writeText)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: stub },
  })
  return stub
}

let originalClipboard: PropertyDescriptor | undefined

beforeEach(() => {
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
})

afterEach(() => {
  cleanup()
  if (originalClipboard === undefined) {
    delete (navigator as unknown as { clipboard?: unknown }).clipboard
  } else {
    Object.defineProperty(navigator, 'clipboard', originalClipboard)
  }
})

function rowEl(index: number): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="grid-row"][data-row-index="${String(index)}"]`,
  )
  if (element === null) throw new Error(`row ${String(index)} not rendered`)
  return element
}

function cellEl(rowIndex: number, columnIndex: number): HTMLElement {
  const cells = rowEl(rowIndex).querySelectorAll<HTMLElement>('[data-testid="grid-cell"]')
  const element = cells[columnIndex]
  if (element === undefined)
    throw new Error(`cell ${String(rowIndex)}:${String(columnIndex)} missing`)
  return element
}

function focusElement(element: HTMLElement): void {
  act(() => {
    element.focus()
  })
}

/** Dispatch a real cancelable keydown; returns it so `defaultPrevented` is observable. */
function keyDown(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

function renderGrid(): { announce: ReturnType<typeof vi.fn> } {
  const announce = vi.fn()
  render(
    <DataGrid
      model={fakeModel()}
      onNestedAction={() => {}}
      onOpenRecord={() => {}}
      overlayState={fakeOverlay()}
      onCommitCell={() => {}}
      onEditAnnounce={announce}
    />,
  )
  return { announce }
}

/** Single boolean column: exercises the `<select>` editor and its NULL button. */
function renderBooleanGrid(): { announce: ReturnType<typeof vi.fn> } {
  const announce = vi.fn()
  render(
    <DataGrid
      model={fakeBooleanModel()}
      onNestedAction={() => {}}
      onOpenRecord={() => {}}
      overlayState={fakeOverlay()}
      onCommitCell={() => {}}
      onEditAnnounce={announce}
    />,
  )
  return { announce }
}

/** Flush the clipboard promise's microtask so the announcement has landed. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('DataGrid Ctrl/Cmd+C (ug-5)', () => {
  it('copies the focused decimal cell display text and announces exactly once', async () => {
    const writeText = installClipboard(() => Promise.resolve())
    const { announce } = renderGrid()

    focusElement(cellEl(0, 2))
    const event = keyDown(cellEl(0, 2), { key: 'c', ctrlKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(writeText).toHaveBeenCalledTimes(1)
    // The DISPLAY text the cell renders — never `String(rawValue)`.
    expect(writeText).toHaveBeenCalledWith('52000.00')
    await flush()
    expect(announce).toHaveBeenCalledTimes(1)
    expect(announce).toHaveBeenCalledWith('Value copied.')
    // The copied value never reaches the announcement (ADR 0025).
    expect(announce).not.toHaveBeenCalledWith(expect.stringContaining('52000.00'))
  })

  it('accepts Cmd+C and copies the bounded nested preview', async () => {
    const writeText = installClipboard(() => Promise.resolve())
    const { announce } = renderGrid()

    focusElement(cellEl(0, 3))
    const event = keyDown(cellEl(0, 3), { key: 'C', metaKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('{"a":0}')
    await flush()
    expect(announce).toHaveBeenCalledWith('Value copied.')
  })

  it('leaves the native copy alone inside an open text editor', async () => {
    const writeText = installClipboard(() => Promise.resolve())
    const { announce } = renderGrid()

    focusElement(cellEl(0, 1))
    keyDown(cellEl(0, 1), { key: 'Enter' })
    const editor = screen.getByTestId('grid-editor-input')
    expect(document.activeElement).toBe(editor)
    fireEvent.change(editor, { target: { value: 'draft-1234' } })

    // Ctrl+C inside the editor: the browser keeps it (no preventDefault, no
    // clipboard write, no announcement) — selection copy must still work, and
    // the editor stays open.
    const inside = keyDown(editor, { key: 'c', ctrlKey: true })
    expect(inside.defaultPrevented).toBe(false)
    expect(writeText).not.toHaveBeenCalled()
    expect(announce).not.toHaveBeenCalled()
    expect(screen.getByTestId('grid-editor-input')).toBe(editor)
  })

  it('does not copy from the editor wrapper controls (boolean NULL button)', async () => {
    // The boolean editor's `<select>` does not commit on blur, so the NULL
    // button inside the open `.grid-cell-editor` wrapper is reachable while an
    // edit is still open — the exact shape the wrapper guard covers. A copy
    // keydown delivered there must not fall through to the cell underneath.
    const writeText = installClipboard(() => Promise.resolve())
    const { announce } = renderBooleanGrid()

    focusElement(cellEl(0, 0))
    keyDown(cellEl(0, 0), { key: 'Enter' })
    const select = screen.getByTestId('grid-editor-boolean')
    expect(document.activeElement).toBe(select)

    const nullButton = screen.getByTestId('grid-editor-null')
    focusElement(nullButton)
    expect(screen.getByTestId('grid-editor-boolean')).toBe(select)
    const onNullButton = keyDown(nullButton, { key: 'c', metaKey: true })
    expect(onNullButton.defaultPrevented).toBe(false)
    expect(writeText).not.toHaveBeenCalled()
    expect(announce).not.toHaveBeenCalled()
  })

  it('writes nothing for a NULL cell and announces the empty-cell message', async () => {
    const writeText = installClipboard(() => Promise.resolve())
    const { announce } = renderGrid()

    focusElement(cellEl(2, 1))
    expect(screen.getByTestId('grid-cell-null')).toBeTruthy()
    const event = keyDown(cellEl(2, 1), { key: 'c', ctrlKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(writeText).not.toHaveBeenCalled()
    expect(announce).toHaveBeenCalledTimes(1)
    expect(announce).toHaveBeenCalledWith('Nothing to copy — this cell is empty.')
  })

  it('announces the failure and swallows the rejection when writeText is denied', async () => {
    installClipboard(() => Promise.reject(new Error('clipboard denied')))
    const { announce } = renderGrid()

    focusElement(cellEl(0, 1))
    keyDown(cellEl(0, 1), { key: 'c', ctrlKey: true })

    await waitFor(() => {
      expect(announce).toHaveBeenCalledWith('Copy failed — the clipboard is unavailable.')
    })
    // Only the failure message — never the cell value.
    expect(announce).toHaveBeenCalledTimes(1)
    expect(announce).not.toHaveBeenCalledWith(expect.stringContaining('name-0'))
  })

  it('announces the failure without throwing when the clipboard API is missing', async () => {
    // happy-dom exposes `clipboard` on the prototype, so shadow it explicitly.
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    const { announce } = renderGrid()

    focusElement(cellEl(0, 1))
    const event = keyDown(cellEl(0, 1), { key: 'c', ctrlKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(announce).toHaveBeenCalledWith('Copy failed — the clipboard is unavailable.')
  })

  it('does not intercept plain c, extra modifiers or a row-focused target', () => {
    const writeText = installClipboard(() => Promise.resolve())
    const { announce } = renderGrid()

    focusElement(cellEl(0, 1))
    expect(keyDown(cellEl(0, 1), { key: 'c' }).defaultPrevented).toBe(false)
    expect(
      keyDown(cellEl(0, 1), { key: 'c', ctrlKey: true, shiftKey: true }).defaultPrevented,
    ).toBe(false)
    expect(keyDown(cellEl(0, 1), { key: 'c', ctrlKey: true, altKey: true }).defaultPrevented).toBe(
      false,
    )

    // A row-focused row has no cell target: native copy (if any) stays intact.
    focusElement(rowEl(0))
    expect(keyDown(rowEl(0), { key: 'c', ctrlKey: true }).defaultPrevented).toBe(false)

    expect(writeText).not.toHaveBeenCalled()
    expect(announce).not.toHaveBeenCalled()
  })
})
