// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GridViewportModel } from '@assay/grid'
import { App } from './App'
import type { ArrowTableLike } from './grid/provider'

/**
 * WF-06 — ready-state replacement lifecycle driven through the REAL `App`
 * composition root with only the picker/engine boundaries faked (the
 * `App.column-ops` posture). The gate, the intent machine, the candidate
 * preparation, the atomic adoption and every notice are real code.
 *
 * Copy is pinned as INDEPENDENT literals here (never imported from
 * `replace/messages.ts`), like the export/help precedent.
 *
 * Layer: RTL (happy-dom). The real-engine/browser legs live in
 * `tests/e2e/replace-guard.spec.ts`; the RTL-only legs (native picker
 * cancellation/refusal, supersession, the clipboard marker) are labelled
 * below because Playwright cannot dismiss an OS chooser.
 */

const APPROVED = {
  guardTitle: 'Replace this session?',
  guardStaged:
    'This session has staged changes that are not saved. Opening another dataset replaces the session, its staged edits, its undo history, and any validation or comparison results.',
  guardExport: 'Session changes are not saved automatically. Export a copy to keep them.',
  guardStays:
    'If you cancel the file chooser, or the file cannot be opened, this session stays as it is.',
  stay: 'Stay',
  export: 'Export a copy…',
  choose: 'Choose a replacement file…',
  pickerNotice: 'Nothing was opened. This session is unchanged.',
  progress: 'Opening the new file… The current session stays open until it is ready.',
  retry: 'Choose a different file…',
  busy: 'Finish the current opening first.',
  draft: 'Finish or cancel the cell you are editing first.',
  settling:
    'This session is still finishing a change. Replacement stays unavailable until it finishes.',
  cast: 'A column type check is still running. Replacement stays unavailable until it finishes.',
} as const

/** C10's cause sentences (our own closed vocabulary, never engine text). */
const UNSUPPORTED_CAUSE =
  'The file could not be opened. This file type is not supported — open a .parquet, .csv, .jsonl or .json file.'
const UNREADABLE_CAUSE =
  'The file could not be opened. The file could not be read. It may be corrupt, truncated, or not the format its name suggests.'
const FAILURE_SUFFIX = ' Nothing in this session changed.'

const SCHEMA_A = [
  { name: 'id', type: 'BIGINT' },
  { name: 'label', type: 'VARCHAR' },
]
const SCHEMA_B = [
  { name: 'order_id', type: 'BIGINT' },
  { name: 'region', type: 'VARCHAR' },
]

interface Pick {
  readonly file?: File
  readonly cancel?: boolean
  readonly getFileError?: Error
}

interface VirtualItem {
  index: number
  key: string
  start: number
  size: number
}

const h = vi.hoisted(() => ({
  /** The one virtual row this harness renders (happy-dom has no layout). */
  rows: [{ index: 0, key: '0', start: 0, size: 28 }] as VirtualItem[],
  /** Picks queued by each test; the picker resolves them in order. */
  picks: [] as Pick[],
  /** Pick requests, so a test can assert the chooser really opened. */
  pickRequests: 0,
  /** Open calls (candidate ids in order). */
  openCalls: [] as string[],
  nextTableId: 1,
  /** Rejects the NEXT `engine.open` with this message (T9). */
  openFailure: null as string | null,
  /** Rejects the NEXT `engine.schema` (T9b, after registration). */
  schemaFailure: null as string | null,
  /** Rejects the NEXT `engine.rowCount` (T9b). */
  rowCountFailure: null as string | null,
  /** Holds the next model `refresh()` until released (N4/N15). */
  refreshGate: null as Promise<void> | null,
  refreshCalls: 0,
  /** Emitted telemetry event names. */
  events: [] as string[],
}))

function fakeBatch(columns: readonly { name: string }[]): ArrowTableLike {
  const cells = columns.map((_, index) => ({ get: () => (index === 0 ? 1 : 'x') }))
  return {
    numRows: 1,
    numCols: cells.length,
    getChildAt: (index: number) => cells[index] ?? null,
  }
}

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => h.rows,
    getTotalSize: () => h.rows.length * 28,
    scrollToIndex: vi.fn(),
  }),
}))

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } } | null> => {
    h.pickRequests += 1
    const next = h.picks.shift()
    if (next === undefined || next.cancel === true) return null
    if (next.getFileError !== undefined) {
      return {
        source: {
          getFile: () => Promise.reject(next.getFileError),
        },
      }
    }
    const file = next.file ?? new File(['order_id,region\n1,SG\n'], 'replacement.csv')
    return { source: { getFile: async () => file } }
  },
}))

vi.mock('./lib/engine', () => {
  const engineClient = {
    open: async (): Promise<{ kind: 'table'; id: string }> => {
      if (h.openFailure !== null) {
        const message = h.openFailure
        h.openFailure = null
        throw new Error(message)
      }
      const id = `t${String(h.nextTableId)}`
      h.nextTableId += 1
      h.openCalls.push(id)
      return { kind: 'table', id }
    },
    schema: async (handle: { id: string }) => {
      if (h.schemaFailure !== null) {
        const message = h.schemaFailure
        h.schemaFailure = null
        throw new Error(message)
      }
      return handle.id === 't1' ? SCHEMA_A : SCHEMA_B
    },
    rowCount: async (): Promise<number> => {
      if (h.rowCountFailure !== null) {
        const message = h.rowCountFailure
        h.rowCountFailure = null
        throw new Error(message)
      }
      return 1
    },
    fetchRange: async (_handle: unknown, window: { startRow: number }) => ({
      batch: fakeBatch(window.startRow === 0 ? SCHEMA_A : SCHEMA_B),
      hasMore: false,
    }),
    overlaySchema: async () => SCHEMA_A,
    overlayRowCount: async () => 1,
    fetchOverlayRange: async () => ({ batch: fakeBatch(SCHEMA_A), hasMore: false }),
    overlayCastCheck: async () => ({ hasNonConvertibleValues: false }),
    dispose: async () => undefined,
  }
  return { engineClient }
})

vi.mock('./sql/SqlPanel', () => ({ SqlPanel: () => null }))
vi.mock('./profile/ProfilePanel', () => ({ ProfilePanel: () => null }))

/** Inert telemetry whose emitted event names are recorded for assertions. */
function fakeRuntime(): Record<string, unknown> {
  return {
    surface: 'web',
    hardOff: false,
    endpointConfigured: false,
    emit: (name: string) => {
      h.events.push(name)
    },
    flush: async () => undefined,
    getPreference: () => 'off',
    setPreference: () => undefined,
    isEnabledNow: () => false,
    shouldShowDisclosure: () => false,
    markDisclosureShown: () => undefined,
    dispose: () => undefined,
  }
}

/** Parse C10 into its classified cause and the raw detail disclosure. */
function failureText(): string {
  return screen.getByTestId('replace-error-text').textContent ?? ''
}

beforeEach(() => {
  h.picks = []
  h.pickRequests = 0
  h.openCalls = []
  h.nextTableId = 1
  h.openFailure = null
  h.schemaFailure = null
  h.rowCountFailure = null
  h.refreshGate = null
  h.refreshCalls = 0
  h.events = []
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Render and open the first dataset through the (idle) legacy open flow. */
async function openFirstDataset(): Promise<void> {
  h.picks = [{ file: new File(['id,label\n1,x\n'], 'first.csv') }]
  render(<App telemetry={fakeRuntime() as never} />)
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
  await screen.findByTestId('schema-section')
  await waitFor(() => {
    expect(screen.queryAllByTestId('grid-header-cell').length).toBeGreaterThan(0)
  })
  expect(h.openCalls).toEqual(['t1'])
}

/** Click the ready-state Open control (the gesture gate's only entry). */
async function clickReadyOpen(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
}

/**
 * The live dataset's effective column names — the observable identity signal
 * here, because this harness mocks the engine-calling SQL/Profile panels that
 * would otherwise render the engine handle id.
 */
function liveColumns(): string[] {
  return screen
    .queryAllByTestId('grid-header-cell')
    .map((cell) => cell.getAttribute('data-col-name') ?? '')
}

const COLUMNS_A = ['id', 'label']
const COLUMNS_B = ['order_id', 'region']

describe('WF-06 — clean session: choose, prepare, adopt once', () => {
  it('adopts a clean replacement synchronously and retires the previous app-local request', async () => {
    await openFirstDataset()
    // Open the record dock on the live session: it must not survive adoption.
    await waitFor(() => {
      expect(screen.queryByTestId('grid-row')?.getAttribute('data-status')).toBe('ready')
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('grid-row'))
    })
    await screen.findByTestId('record-inspector')

    const refresh = vi.spyOn(GridViewportModel.prototype, 'refresh')
    h.picks = [{ file: new File(['order_id,region\n1,SG\n'], 'orders.csv') }]
    await clickReadyOpen()
    await waitFor(() => {
      expect(h.openCalls).toEqual(['t1', 't2'])
    })
    // One synchronous adoption: no extra refresh, and the previous session's
    // record request is retired with it.
    expect(refresh).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.queryByTestId('record-inspector')).toBeNull()
    })
    expect(screen.getByTestId('record-hint').textContent).toBe(
      'Select a row to inspect it here — press Enter or double-click a row.',
    )
    expect(liveColumns()).toEqual(COLUMNS_B)
    // Exactly one completed open announcement for the adopted dataset.
    expect(h.events.filter((name) => name === 'dataset_opened')).toHaveLength(2)
  })

  it('does not open a guard for a clean session and preserves it when the chooser is cancelled', async () => {
    await openFirstDataset()
    const schemaSection = screen.getByTestId('schema-section')
    h.picks = [{ cancel: true }]
    await clickReadyOpen()

    // T1 → T6, RTL-only leg: Playwright cannot dismiss a native chooser, so
    // the picker module is the mocked seam here (v5 §9.1 "RTL-only").
    expect(h.pickRequests).toBe(2)
    expect(screen.queryByTestId('replace-guard')).toBeNull()
    await waitFor(() => {
      expect(screen.getByTestId('replace-notice').textContent).toBe(APPROVED.pickerNotice)
    })
    // Preservation: same live table, same mounted subtree, no reset.
    expect(liveColumns()).toEqual(COLUMNS_A)
    expect(screen.getByTestId('schema-section')).toBe(schemaSection)
    expect(h.openCalls).toEqual(['t1'])
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
  })
})

describe('WF-06 — dirty session: the native guard', () => {
  async function makeDirty(): Promise<void> {
    // Rename a column: one applied op in the active history prefix.
    const panel = within(screen.getByTestId('schema-panel'))
    await act(async () => {
      fireEvent.click(panel.getByRole('button', { name: 'Rename column label' }))
    })
    const input = panel.getByTestId('column-rename-input')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'tag' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    await waitFor(() => {
      expect(screen.getByTestId('section-summary-history').textContent).toBe('History · 1 pending')
    })
  }

  it('shows the byte-exact guard, and Stay preserves the live session', async () => {
    await openFirstDataset()
    await makeDirty()
    await clickReadyOpen()

    const guard = screen.getByTestId('replace-guard')
    expect(guard.tagName).toBe('DIALOG')
    expect(guard.getAttribute('aria-labelledby')).toBe('replace-guard-title')
    expect(screen.getByTestId('replace-guard-staged').textContent).toBe(APPROVED.guardStaged)
    expect(screen.getByTestId('replace-guard-export').textContent).toBe(APPROVED.guardExport)
    expect(screen.getByTestId('replace-guard-stays').textContent).toBe(APPROVED.guardStays)
    expect(screen.getByTestId('replace-stay').textContent).toBe(APPROVED.stay)
    expect(screen.getByTestId('replace-export').textContent).toBe(APPROVED.export)
    expect(screen.getByTestId('replace-choose').textContent).toBe(APPROVED.choose)
    // The guard never prints a pending-change count.
    expect((guard.textContent ?? '').includes('1 pending')).toBe(false)

    await act(async () => {
      fireEvent.click(screen.getByTestId('replace-stay'))
    })
    expect(screen.queryByTestId('replace-guard')).toBeNull()
    // T3: untouched live session (history text + table id + phase).
    expect(liveColumns()).toEqual(COLUMNS_A)
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
    expect(screen.getByTestId('section-summary-history').textContent).toBe('History · 1 pending')
    expect(h.pickRequests).toBe(1)
  })

  it('Escape is Stay (the native cancel event) and writes nothing', async () => {
    await openFirstDataset()
    await makeDirty()
    await clickReadyOpen()
    const guard = screen.getByTestId('replace-guard') as HTMLDialogElement
    await act(async () => {
      guard.dispatchEvent(new Event('cancel', { cancelable: true }))
    })
    expect(screen.queryByTestId('replace-guard')).toBeNull()
    expect(liveColumns()).toEqual(COLUMNS_A)
    expect(h.pickRequests).toBe(1)
  })

  it('export-first closes the guard, ends the intent and opens the existing exporter', async () => {
    await openFirstDataset()
    await makeDirty()
    await clickReadyOpen()
    await act(async () => {
      fireEvent.click(screen.getByTestId('replace-export'))
    })
    expect(screen.queryByTestId('replace-guard')).toBeNull()
    expect(screen.getByTestId('export-dialog')).not.toBeNull()
    // T4: the session is untouched and nothing auto-replaces afterwards.
    expect(liveColumns()).toEqual(COLUMNS_A)
    expect(screen.getByTestId('section-summary-history').textContent).toBe('History · 1 pending')
    expect(h.pickRequests).toBe(1)
    expect(h.openCalls).toEqual(['t1'])
  })

  it('choosing from the guard adopts the candidate (T5) and only then resets the session', async () => {
    await openFirstDataset()
    await makeDirty()
    await clickReadyOpen()
    h.picks = [{ file: new File(['order_id,region\n1,SG\n'], 'orders.csv') }]
    await act(async () => {
      fireEvent.click(screen.getByTestId('replace-choose'))
    })
    await waitFor(() => {
      expect(h.openCalls).toEqual(['t1', 't2'])
    })
    await waitFor(() => {
      expect(liveColumns()).toEqual(COLUMNS_B)
    })
    // The adopted session has no history and no guard-visible staged state.
    expect(screen.queryByTestId('section-summary-history')).toBeNull()
  })
})

describe('WF-06 — refusals leave the intent at none and never touch the session', () => {
  it('G3 refuses an open editor (programmatic activation), focuses the editor and clears C13 on close', async () => {
    await openFirstDataset()
    // Open a cell editor without any blur: a scripted double click leaves the
    // text input open (`App.lifecycle`/DataGrid RTL pattern).
    fireEvent.doubleClick(screen.getAllByTestId('grid-cell')[0] as HTMLElement)
    await waitFor(() => {
      expect(screen.queryByTestId('grid-editor-input')).not.toBeNull()
    })

    await clickReadyOpen()
    expect(screen.queryByTestId('replace-guard')).toBeNull()
    expect(h.pickRequests).toBe(1)
    expect(screen.getByTestId('replace-draft-notice').textContent).toBe(APPROVED.draft)
    expect(document.activeElement?.getAttribute('data-testid')).toBe('grid-editor-input')

    // IC-01: Escape closes the editor and clears C13 with no second Open click.
    const editor = screen.getByTestId('grid-editor-input')
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Escape' })
    })
    expect(screen.queryByTestId('grid-editor-input')).toBeNull()
    await waitFor(() => {
      expect(screen.queryByTestId('replace-draft-notice')).toBeNull()
    })
    // The refusal never started an intent: the next Open proceeds.
    h.picks = [{ cancel: true }]
    await clickReadyOpen()
    expect(screen.queryByTestId('replace-guard')).toBeNull()
    expect(h.pickRequests).toBe(2)
    expect(liveColumns()).toEqual(COLUMNS_A)
  })

  it('G4 refuses while a commit is materializing (C15) and never self-advances', async () => {
    await openFirstDataset()
    // Hold the next model refresh so the commit stays in flight.
    let release: (() => void) | null = null
    h.refreshGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = GridViewportModel.prototype.refresh
    const refresh = vi
      .spyOn(GridViewportModel.prototype, 'refresh')
      .mockImplementation(async function (this: GridViewportModel) {
        h.refreshCalls += 1
        const gate = h.refreshGate
        h.refreshGate = null
        if (gate !== null) await gate
        return original.call(this)
      })
    const panel = within(screen.getByTestId('schema-panel'))
    await act(async () => {
      fireEvent.click(panel.getByRole('button', { name: 'Rename column label' }))
    })
    const input = panel.getByTestId('column-rename-input')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'tag' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(h.refreshCalls).toBeGreaterThan(0)

    await clickReadyOpen()
    expect(screen.queryByTestId('replace-guard')).toBeNull()
    expect(h.pickRequests).toBe(1)
    expect(screen.getByTestId('replace-settling-notice').textContent).toBe(APPROVED.settling)

    // Repeated gestures stay refused, and clearing the notice never opens a
    // guard or a picker by itself.
    await clickReadyOpen()
    expect(screen.getByTestId('replace-settling-notice')).not.toBeNull()
    await act(async () => {
      release?.()
    })
    await waitFor(() => {
      expect(screen.queryByTestId('replace-settling-notice')).toBeNull()
    })
    expect(screen.queryByTestId('replace-guard')).toBeNull()
    expect(h.pickRequests).toBe(1)
    expect(refresh).toHaveBeenCalled()
  })

  it('IC-03 disables the Open control while an intent or an owned modal is open', async () => {
    await openFirstDataset()
    const open = (): HTMLElement => screen.getByTestId('open-button')
    expect(open().hasAttribute('disabled')).toBe(false)

    // Modal-only truth case: the Export dialog owns the modal position.
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-open'))
    })
    expect(open().hasAttribute('disabled')).toBe(true)
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-close'))
    })
    expect(open().hasAttribute('disabled')).toBe(false)

    // Intent-only truth case: a held commit keeps the intent at `none` and the
    // control ENABLED (a refusal, not a state), which is the IC-03 contrast to
    // the guard/choosing states below.
    let release: (() => void) | null = null
    h.refreshGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = GridViewportModel.prototype.refresh
    vi.spyOn(GridViewportModel.prototype, 'refresh').mockImplementation(async function (
      this: GridViewportModel,
    ) {
      const gate = h.refreshGate
      h.refreshGate = null
      if (gate !== null) await gate
      return original.call(this)
    })
    const panel = within(screen.getByTestId('schema-panel'))
    await act(async () => {
      fireEvent.click(panel.getByRole('button', { name: 'Rename column label' }))
    })
    const input = panel.getByTestId('column-rename-input')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'tag' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(open().hasAttribute('disabled')).toBe(false)
    await act(async () => {
      release?.()
    })

    // Intent-only truth case: the guard is open, so Open is disabled.
    await clickReadyOpen()
    expect(screen.queryByTestId('replace-guard')).not.toBeNull()
    expect(open().hasAttribute('disabled')).toBe(true)
    await act(async () => {
      fireEvent.click(screen.getByTestId('replace-stay'))
    })
  })
})

describe('WF-06 — candidate failure keeps the live session (C10/C14)', () => {
  it('reports the classified cause and confines the raw diagnostic to the closed detail block', async () => {
    await openFirstDataset()
    const clipboardWrite = vi.fn(async () => undefined)
    const execCommand = vi.fn()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardWrite },
      configurable: true,
    })
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })

    const MARKER = 'Invalid Input Error: marker-9f3a no magic bytes'
    h.picks = [{ getFileError: new Error(MARKER) }]
    await clickReadyOpen()

    await waitFor(() => {
      expect(screen.queryByTestId('replace-error')).not.toBeNull()
    })
    // C10 is the classified, value-free sentence — never the raw diagnostic.
    expect(failureText()).toBe(UNREADABLE_CAUSE + FAILURE_SUFFIX)
    expect(failureText()).not.toContain('marker-9f3a')
    // IC-04: a CLOSED <details> whose only content block is the <pre>.
    const details = screen.getByTestId('replace-error-details') as HTMLDetailsElement
    expect(details.tagName).toBe('DETAILS')
    expect(details.open).toBe(false)
    expect(details.querySelectorAll('pre')).toHaveLength(1)
    expect(details.querySelector('pre')?.textContent).toBe(MARKER)
    expect(within(details).getByText('Technical detail')).not.toBeNull()
    // The announced alert text lives OUTSIDE the non-live details subtree.
    expect(screen.getByTestId('replace-error-text').getAttribute('role')).toBe('alert')
    expect(screen.getByTestId('replace-error-text').contains(details)).toBe(false)
    expect(document.title).not.toContain('marker-9f3a')
    // No app-initiated clipboard write anywhere in the failure flow.
    expect(clipboardWrite).not.toHaveBeenCalled()
    expect(execCommand).not.toHaveBeenCalled()

    // The live session is untouched and C11 re-enters choosing.
    expect(liveColumns()).toEqual(COLUMNS_A)
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('ready')
    expect(screen.getByTestId('replace-retry').textContent).toBe(APPROVED.retry)
    h.picks = [{ cancel: true }]
    await act(async () => {
      fireEvent.click(screen.getByTestId('replace-retry'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('replace-notice').textContent).toBe(APPROVED.pickerNotice)
    })
    expect(screen.queryByTestId('replace-error')).toBeNull()
    expect(liveColumns()).toEqual(COLUMNS_A)
  })

  it('maps an unsupported-format engine refusal to the unsupported cause', async () => {
    await openFirstDataset()
    h.picks = [{ file: new File(['x'], 'notes.txt') }]
    h.openFailure =
      'unsupported dataset format: this engine reads .parquet, .csv, .jsonl and .json files'
    await clickReadyOpen()
    await waitFor(() => {
      expect(screen.queryByTestId('replace-error')).not.toBeNull()
    })
    expect(failureText()).toBe(UNSUPPORTED_CAUSE + FAILURE_SUFFIX)
    expect(screen.getByTestId('replace-error-detail').textContent).toContain('unsupported')
    expect(liveColumns()).toEqual(COLUMNS_A)
  })

  it('keeps the live session when the candidate fails after registration (T9b)', async () => {
    await openFirstDataset()
    h.picks = [{ file: new File(['order_id,region\n1,SG\n'], 'orders.csv') }]
    h.schemaFailure = 'view materialization failed'
    await clickReadyOpen()
    await waitFor(() => {
      expect(screen.queryByTestId('replace-error')).not.toBeNull()
    })
    // The failure classification is cause-neutral for a non-read failure.
    expect(failureText()).toBe(
      'The file could not be opened. You can try another file.' + FAILURE_SUFFIX,
    )
    expect(liveColumns()).toEqual(COLUMNS_A)
    expect(h.openCalls).toEqual(['t1', 't2'])
  })
})
