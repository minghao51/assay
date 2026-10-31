// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * ug-6 / UG-10 — Undo/Redo keyboard shortcuts and the first-append History
 * cue, driven through the REAL App composition root with only the picker /
 * engine boundaries faked (the `App.section-summaries` posture).
 *
 * What this file pins:
 *
 * 1. **Shortcuts are real.** In the ready phase, one document-level keydown
 *    listener maps Ctrl/Cmd+Z → `handleUndo` and Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y
 *    → `handleRedo`. Each handled gesture `preventDefault()`s; outside the
 *    ready phase nothing is handled or prevented.
 * 2. **Native text undo wins.** A Ctrl+Z dispatched inside an `input`,
 *    `textarea`, `select` or a `contenteditable` node (including a nested
 *    child) is neither handled nor prevented — the History cursor does not
 *    move.
 * 3. **Lifecycle.** Unmounting App removes the listener (a later keydown is
 *    not prevented and does nothing).
 * 4. **ux-3 stays.** Exactly ONE visible Undo/Redo pair exists before and
 *    after a staged op; the shortcut adds no control, badge or toolbar item.
 * 5. **The cue is 0 → >0 only.** History auto-expands on the first appended
 *    operation, never re-opens after the user collapses it, and is not
 *    expanded by undo/redo or by opening another dataset.
 */

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

/** Row-id column + one data row (the overlay refresh shape the shell expects). */
function fakeOverlayBatch(): ArrowTableLike {
  const columns = [{ get: () => 'base:fv-1:0' }, { get: () => 1 }, { get: () => 'SG' }]
  return {
    numRows: 1,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
  }
}

interface VirtualItem {
  index: number
  key: string
  start: number
  size: number
}

const h = vi.hoisted(() => ({
  rows: [] as VirtualItem[],
  openCalls: 0,
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => h.rows,
    getTotalSize: () => h.rows.length * 28,
    scrollToIndex: vi.fn(),
  }),
}))

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } }> => ({
    source: { getFile: async () => new File(['id\n1\n'], 'history-shortcut.jsonl') },
  }),
}))

vi.mock('./lib/engine', () => {
  const handle = (): EngineTableHandle => {
    h.openCalls += 1
    return { kind: 'table', id: `t${String(h.openCalls)}` }
  }
  return {
    engineClient: {
      open: async () => handle(),
      schema: async () => FAKE_SCHEMA,
      rowCount: async () => 1,
      fetchRange: async () => ({ batch: fakeBatch(), hasMore: false }),
      overlaySchema: async () => FAKE_SCHEMA,
      overlayRowCount: async () => 1,
      fetchOverlayRange: async () => ({ batch: fakeOverlayBatch(), hasMore: false }),
    },
  }
})

beforeEach(() => {
  h.rows = [{ index: 0, key: 'row-0', start: 0, size: 28 }]
  h.openCalls = 0
})

afterEach(() => {
  cleanup()
})

/** Dispatch one cancelable keydown and return it (so `defaultPrevented` is readable). */
function pressKey(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

/** Open the faked dataset through the real flow and wait for ready. */
async function open(): Promise<void> {
  render(<App />)
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('schema-section')
  await waitFor(() => {
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
  })
}

/** Stage one operation (an inserted row) through the editing toolbar. */
async function insertRow(expectedItems?: number): Promise<void> {
  const before = document.querySelectorAll('[data-testid="history-item"]').length
  await act(async () => {
    fireEvent.click(screen.getByTestId('edit-insert-row'))
  })
  await waitFor(() => {
    expect(document.querySelectorAll('[data-testid="history-item"]').length).toBe(
      expectedItems ?? before + 1,
    )
  })
}

/** The visible history cursor line (inside the History panel). */
function cursorText(): string {
  return screen.getByTestId('history-cursor').textContent ?? ''
}

describe('ug-6 — Undo/Redo shortcuts (App)', () => {
  it('ready: Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo, and each handled event is prevented', async () => {
    await open()
    await insertRow()
    await insertRow()
    expect(cursorText()).toBe('Step 2 of 2 applied')

    // Ctrl+Z → undo the last cursor move.
    const undoEvent = pressKey({ key: 'z', ctrlKey: true })
    expect(undoEvent.defaultPrevented).toBe(true)
    await waitFor(() => {
      expect(cursorText()).toBe('Step 1 of 2 applied')
    })

    // Cmd+Shift+Z → redo it.
    const redoEvent = pressKey({ key: 'z', metaKey: true, shiftKey: true })
    expect(redoEvent.defaultPrevented).toBe(true)
    await waitFor(() => {
      expect(cursorText()).toBe('Step 2 of 2 applied')
    })

    // Ctrl+Y → the second redo convention (undo first so redo has work).
    pressKey({ key: 'z', ctrlKey: true })
    await waitFor(() => {
      expect(cursorText()).toBe('Step 1 of 2 applied')
    })
    const yEvent = pressKey({ key: 'y', ctrlKey: true })
    expect(yEvent.defaultPrevented).toBe(true)
    await waitFor(() => {
      expect(cursorText()).toBe('Step 2 of 2 applied')
    })
  })

  it('is inert outside the ready phase: no handling and no preventDefault', async () => {
    render(<App />)
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('idle')

    for (const init of [
      { key: 'z', ctrlKey: true },
      { key: 'z', ctrlKey: true, shiftKey: true },
      { key: 'y', ctrlKey: true },
    ]) {
      expect(pressKey(init).defaultPrevented).toBe(false)
    }
    // Nothing was staged by an inert shortcut.
    expect(document.querySelectorAll('[data-testid="history-item"]')).toHaveLength(0)
  })

  it('never hijacks native text undo inside an editable target', async () => {
    await open()
    await insertRow()
    expect(cursorText()).toBe('Step 1 of 1 applied')

    const textarea = document.createElement('textarea')
    const contentEditable = document.createElement('div')
    contentEditable.setAttribute('contenteditable', 'true')
    const nested = document.createElement('span')
    contentEditable.appendChild(nested)
    const select = document.createElement('select')
    const input = document.createElement('input')
    document.body.append(textarea, contentEditable, select, input)

    try {
      for (const target of [input, textarea, select, contentEditable, nested]) {
        const event = pressKey({ key: 'z', ctrlKey: true }, target)
        expect(event.defaultPrevented).toBe(false)
      }
      // The history cursor never moved: no undo ran for any editable target.
      expect(cursorText()).toBe('Step 1 of 1 applied')
    } finally {
      input.remove()
      textarea.remove()
      contentEditable.remove()
      select.remove()
    }
  })

  it('removes the document listener on unmount', async () => {
    const view = render(<App />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
    })
    view.unmount()

    // No listener left: the same gesture is now neither prevented nor handled.
    expect(pressKey({ key: 'z', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(document.querySelectorAll('[data-testid="history-item"]')).toHaveLength(0)
  })

  it('keeps exactly the single visible Undo/Redo pair (ux-3)', async () => {
    const pairs = (): void => {
      expect(screen.getAllByTestId('history-undo')).toHaveLength(1)
      expect(screen.getAllByTestId('history-redo')).toHaveLength(1)
      expect(screen.getAllByRole('button', { name: 'Undo', hidden: true })).toHaveLength(1)
      expect(screen.getAllByRole('button', { name: 'Redo', hidden: true })).toHaveLength(1)
    }

    await open()
    pairs()

    await insertRow()
    pairs()

    // The shortcut works through the existing pair — no duplicate control
    // appears anywhere in the shell when it fires.
    pressKey({ key: 'z', ctrlKey: true })
    await waitFor(() => {
      expect(cursorText()).toBe('Step 0 of 1 applied')
    })
    pairs()
  })
})

describe('ug-6 — History auto-expand cue (App)', () => {
  it('expands on the first appended op only and never re-opens after a collapse', async () => {
    await open()
    const toggle = screen.getByTestId('section-toggle-history')
    const body = (): Element | null => document.getElementById('section-history-content')

    // Collapsed default, no operations yet.
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(body()?.hasAttribute('hidden')).toBe(true)

    // First op (0 → 1): the body expands through the existing disclosure.
    await insertRow()
    await waitFor(() => {
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
    })
    expect(body()?.hasAttribute('hidden')).toBe(false)

    // User collapses History…
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(body()?.hasAttribute('hidden')).toBe(true)

    // …so the SECOND append must not re-open it (the cue is one-shot).
    await insertRow()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(body()?.hasAttribute('hidden')).toBe(true)

    // Undo/redo cursor moves never expand it either.
    pressKey({ key: 'z', ctrlKey: true })
    await waitFor(() => {
      expect(cursorText()).toBe('Step 1 of 2 applied')
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    pressKey({ key: 'z', ctrlKey: true, shiftKey: true })
    await waitFor(() => {
      expect(cursorText()).toBe('Step 2 of 2 applied')
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    // A new dataset resets the history but does NOT expand the section.
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })
    await waitFor(() => {
      expect(h.openCalls).toBe(2)
    })
    await waitFor(() => {
      expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
    })
    expect(document.querySelectorAll('[data-testid="history-item"]')).toHaveLength(0)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(body()?.hasAttribute('hidden')).toBe(true)
  })

  it('does not fire for a redo tail: undo to 0, then a fresh append after the cue', async () => {
    await open()
    await insertRow()
    await insertRow()
    const toggle = screen.getByTestId('section-toggle-history')
    await waitFor(() => {
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
    })
    await act(async () => {
      fireEvent.click(toggle)
    })

    // Undo everything: entries stay, cursor lands at 0. No expansion.
    pressKey({ key: 'z', ctrlKey: true })
    pressKey({ key: 'z', ctrlKey: true })
    await waitFor(() => {
      expect(cursorText()).toBe('Step 0 of 2 applied')
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    // The next append truncates the redo tail and must not expand History.
    await insertRow(1)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })
})
