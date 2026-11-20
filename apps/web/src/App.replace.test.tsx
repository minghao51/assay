// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GridViewportModel } from '@assay/grid'
import { App, openControlBlocked } from './App'
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
/** UG-5's cause-neutral sentence (the classified `unknown` cause). */
const NEUTRAL_CAUSE = 'The file could not be opened. You can try another file.'

const SCHEMA_A = [
  { name: 'id', type: 'BIGINT' },
  { name: 'label', type: 'VARCHAR' },
  // A BOOLEAN column: its editor has no blur handler, which is what makes the
  // G3-vs-C16 precedence proof meaningful (v5 §3.2.1).
  { name: 'flag', type: 'BOOLEAN' },
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
  /** For each picker call: was the guard `<dialog>` still open at that moment? */
  pickSawOpenGuard: [] as boolean[],
  /** The gate's inputs are read before any state write: notice presence at call. */
  gateSawNotice: [] as { draft: boolean; cast: boolean }[],
  /** Held cast pre-checks (N17): one resolver per column in call order. */
  castHold: false,
  castHeld: [] as Array<{
    column: string
    resolve: (result: { hasNonConvertibleValues: boolean }) => void
  }>,
  /** When set, the candidate's engine schema equals the live SCHEMA_A. */
  sameSchema: false,
  /** Parks the NEXT `engine.open` (the `opening-candidate` window). */
  upcomingOpenGate: null as Promise<void> | null,
  /** Counting dataset session (a non-adoption path must not reset anything). */
  beginCalls: 0,
  token: 0,
  resets: [] as Array<() => void>,
  session: null as Record<string, unknown> | null,
  /** Open calls (candidate ids in order). */
  openCalls: [] as string[],
  nextTableId: 1,
  /** Rejects the NEXT `engine.open` with this message (T9). */
  openFailure: null as string | null,
  /** Rejects the NEXT `engine.schema` (the candidate BASE read, pre-provider). */
  schemaFailure: null as string | null,
  /**
   * N9: fail the N-th `engine.schema` call made FOR THE CANDIDATE handle. Call 1
   * is the explicit base read in App; call 2 is `provider.schema()` inside
   * `GridViewportModel.load()` — i.e. a genuine provider/model-load rejection.
   */
  schemaFailureAtCandidateCall: null as number | null,
  candidateSchemaCalls: 0,
  /** Rejects the NEXT `engine.rowCount` (T9b). */
  rowCountFailure: null as string | null,
  /** Holds the next model `refresh()` until released (N4/N15). */
  refreshGate: null as Promise<void> | null,
  refreshCalls: 0,
  /** Emitted telemetry event names. */
  events: [] as string[],
}))

function fakeBatch(columns: readonly { name: string; type?: string }[]): ArrowTableLike {
  const value = (index: number): unknown => {
    if (index === 0) return 1
    // BOOLEAN column: a real boolean cell, so its boolean editor opens cleanly.
    if (columns[index]?.type === 'BOOLEAN') return true
    return 'x'
  }
  const cells = columns.map((_, index) => ({ get: () => value(index) }))
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
    const guard = document.querySelector<HTMLDialogElement>('[data-testid="replace-guard"]')
    h.pickSawOpenGuard.push(guard?.open === true)
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

/**
 * WF-06 (K14): a behaviourally identical dataset session that COUNTS
 * `beginSession`. Every per-domain slot (editing, validation, diff, pipeline,
 * app-local requests) is reset only through it, so "no adoption ⇒ no reset" is
 * a single observable proof for all of them.
 */
vi.mock('./sessions/session-reset', () => ({
  useDatasetSession: () => {
    if (h.session === null) {
      h.session = {
        tokenRef: {
          get current(): number {
            return h.token
          },
        },
        beginSession: () => {
          h.beginCalls += 1
          h.token += 1
          for (const reset of h.resets) reset()
          // C03b: the registry reports its value-free outcome; these pins never
          // inject a reset fault (the faulted-adoption journey lives in
          // `App.session-fault.test.tsx`).
          return { token: h.token, faults: [] }
        },
        registerReset: (reset: () => void) => {
          h.resets.push(reset)
          return () => {
            h.resets = h.resets.filter((registered) => registered !== reset)
          }
        },
      }
    }
    return h.session
  },
}))

/**
 * WF-06 (§3.2): record what the gate OBSERVED, so the "gate before any state
 * write" rule is testable — with notices cleared first, a pre-existing notice
 * would already be gone when the gate runs.
 */
vi.mock('./replace/gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./replace/gate')>()
  return {
    ...actual,
    evaluateReadyGesture: (input: Parameters<typeof actual.evaluateReadyGesture>[0]) => {
      h.gateSawNotice.push({
        draft: document.querySelector('[data-testid="replace-draft-notice"]') !== null,
        cast: document.querySelector('[data-testid="replace-cast-notice"]') !== null,
      })
      return actual.evaluateReadyGesture(input)
    },
  }
})

vi.mock('./lib/engine', () => {
  const engineClient = {
    open: async (): Promise<{ kind: 'table'; id: string }> => {
      if (h.openFailure !== null) {
        const message = h.openFailure
        h.openFailure = null
        throw new Error(message)
      }
      const gate = h.upcomingOpenGate
      if (gate !== null) {
        h.upcomingOpenGate = null
        await gate
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
      if (handle.id !== 't1') {
        h.candidateSchemaCalls += 1
        if (h.candidateSchemaCalls === h.schemaFailureAtCandidateCall) {
          throw new Error('provider read failed during model.load')
        }
      }
      return handle.id === 't1' || h.sameSchema ? SCHEMA_A : SCHEMA_B
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
    // N17: held cast pre-checks, resolved by the test in any order; the held
    // outcome can be committing (false) or non-committing (true).
    overlayCastCheck: (
      _handle: unknown,
      _overlay: unknown,
      options: { readonly column: string },
    ): Promise<{ hasNonConvertibleValues: boolean }> =>
      new Promise((resolve) => {
        if (h.castHold) {
          h.castHeld.push({ column: options.column, resolve })
          return
        }
        resolve({ hasNonConvertibleValues: false })
      }),
    dispose: async () => undefined,
  }
  return { engineClient }
})

// The SQL panel is deliberately REAL here (K14/item 9): its local draft is one
// of the adoption-disposable surfaces this file proves. Only the engine-calling
// Profile panel stays faked (unrelated to this row).
vi.mock('./profile/ProfilePanel', () => ({ ProfilePanel: () => null }))

/** Inert telemetry whose emitted event names are recorded for assertions. */
function fakeRuntime(options: { readonly disclosure?: boolean } = {}): Record<string, unknown> {
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
    shouldShowDisclosure: () => options.disclosure === true,
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
  h.pickSawOpenGuard = []
  h.gateSawNotice = []
  h.castHold = false
  h.castHeld = []
  h.sameSchema = false
  h.upcomingOpenGate = null
  h.beginCalls = 0
  h.token = 0
  h.resets = []
  h.session = null
  h.openCalls = []
  h.nextTableId = 1
  h.openFailure = null
  h.schemaFailure = null
  h.schemaFailureAtCandidateCall = null
  h.candidateSchemaCalls = 0
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

const COLUMNS_A = ['id', 'label', 'flag']
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
    // The guard's close path returns focus to the connected opener (the Open
    // control), never to `<body>`.
    expect(document.activeElement?.getAttribute('data-testid')).toBe('open-button')
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
    // N16 (user-copy half): a USER copy of the visible text is allowed and not
    // suppressed — no preventDefault, no onCopy handler, and the text stays
    // selectable (the stylesheet keeps `user-select: text`).
    const pre = details.querySelector('pre') as HTMLElement
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true })
    act(() => {
      pre.dispatchEvent(copyEvent)
    })
    expect(copyEvent.defaultPrevented).toBe(false)
    expect((pre as unknown as { oncopy: unknown }).oncopy).toBeNull()
    expect(window.getComputedStyle(pre).userSelect).not.toBe('none')

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

  it('keeps the live session when the candidate BASE schema read fails before the provider exists (T9b)', async () => {
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

/** Apply one rename so the live session is dirty (one applied history op). */
async function makeDirty(): Promise<void> {
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

/**
 * Drafts the adoption must discard (v5 §3.4 T8): the SQL pane's statement, the
 * filter compose fields and a column rename/cast draft. They are panel-local
 * state, preserved by Stay/cancel/failure and lost at adoption — the tool-panel
 * region is keyed by the dataset identity, so adoption remounts it once.
 */
function seedDrafts(): void {
  fireEvent.change(screen.getByTestId('sql-input'), {
    target: { value: 'SELECT 8675309 AS prior_session_marker' },
  })
  // A cast-selector draft on a different column (the panel allows one rename
  // draft and one cast draft at a time, one per column).
  const controls = within(screen.getByTestId('schema-panel'))
  fireEvent.click(controls.getByRole('button', { name: 'Cast column id' }))
  fireEvent.change(controls.getByTestId('column-cast-select'), { target: { value: 'VARCHAR' } })
  // The FilterBar's compose row is inside its own disclosure; open it first,
  // then write an unapplied draft (no Apply click — a draft is not a change).
  if (screen.getByTestId('filter-toggle').getAttribute('aria-expanded') !== 'true') {
    fireEvent.click(screen.getByTestId('filter-toggle'))
  }
  fireEvent.change(screen.getByTestId('filter-compose-value'), {
    target: { value: 'draft-value' },
  })
  const panel = within(screen.getByTestId('schema-panel'))
  fireEvent.click(panel.getByRole('button', { name: 'Rename column label' }))
  fireEvent.change(panel.getByTestId('column-rename-input'), {
    target: { value: 'label_draft' },
  })
}

function readDrafts(): {
  sql: string
  filter: string
  rename: string | null
  cast: string | null
} {
  const sql = screen.getByTestId('sql-input') as HTMLTextAreaElement
  // An absent compose field means the bar's disclosure closed (the remount); a
  // draft cannot survive it, so absence reads as the empty draft.
  const filter = screen.queryByTestId('filter-compose-value') as HTMLInputElement | null
  const rename = within(screen.getByTestId('schema-panel')).queryByTestId('column-rename-input')
  const cast = within(screen.getByTestId('schema-panel')).queryByTestId('column-cast-select')
  return {
    sql: sql.value,
    filter: filter?.value ?? '',
    rename: rename === null ? null : (rename as HTMLInputElement).value,
    // The selector's presence + value is the draft: it is only committed by
    // the explicit Cast control.
    cast: cast === null ? null : (cast as HTMLSelectElement).value,
  }
}

const SEEDED_DRAFTS = {
  sql: 'SELECT 8675309 AS prior_session_marker',
  filter: 'draft-value',
  rename: 'label_draft',
  cast: 'VARCHAR',
}

describe('WF-06 — adoption-disposable drafts (T8/§3.4)', () => {
  it('preserves SQL/filter/rename drafts across Stay (T3) and resets nothing', async () => {
    await openFirstDataset()
    expect(h.beginCalls).toBe(1)
    // T3 is the DIRTY path's Stay: one applied rename, then the drafts.
    await makeDirty()
    seedDrafts()
    expect(readDrafts()).toEqual(SEEDED_DRAFTS)

    await clickReadyOpen()
    expect(screen.getByTestId('replace-guard')).not.toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('replace-stay'))
    })
    expect(readDrafts()).toEqual(SEEDED_DRAFTS)
    // No adoption ⇒ NO session reset (the single proof for every slot: editing,
    // validation, diff, pipeline and the app-local requests).
    expect(h.beginCalls).toBe(1)
  })

  it('preserves the same drafts across a picker cancel (T6)', async () => {
    await openFirstDataset()
    seedDrafts()
    h.picks = [{ cancel: true }]
    await clickReadyOpen()
    await waitFor(() => {
      expect(screen.getByTestId('replace-notice')).not.toBeNull()
    })
    expect(readDrafts()).toEqual(SEEDED_DRAFTS)
    expect(h.beginCalls).toBe(1)
  })

  it('preserves the same drafts across a candidate failure (T9/T9b)', async () => {
    await openFirstDataset()
    seedDrafts()
    h.picks = [{ getFileError: new Error('Invalid Input Error: no magic bytes') }]
    await clickReadyOpen()
    await waitFor(() => {
      expect(screen.queryByTestId('replace-error')).not.toBeNull()
    })
    expect(readDrafts()).toEqual(SEEDED_DRAFTS)
    expect(h.beginCalls).toBe(1)

    // T9b (post-registration): the provider/`model.load` rejection keeps them
    // too — one retained candidate table may exist (ADR 0047), the session is
    // untouched.
    h.rowCountFailure = 'view materialization failed'
    h.picks = [{ file: new File(['id,label\n1,x\n'], 'again.csv') }]
    await act(async () => {
      fireEvent.click(screen.getByTestId('replace-retry'))
    })
    await waitFor(() => {
      expect(screen.queryByTestId('replace-error')).not.toBeNull()
    })
    expect(readDrafts()).toEqual(SEEDED_DRAFTS)
    expect(h.beginCalls).toBe(1)
  })

  it('discards every draft when a replacement is adopted (T8)', async () => {
    await openFirstDataset()
    seedDrafts()
    // Same column shape on the candidate, so "the draft is gone" cannot be
    // confused with "the column disappeared".
    h.sameSchema = true
    h.picks = [{ file: new File(['id,label\n2,y\n'], 'same-shape.csv') }]
    await clickReadyOpen()
    await waitFor(() => {
      expect(h.openCalls).toEqual(['t1', 't2'])
    })
    await waitFor(() => {
      expect(readDrafts()).toEqual({ sql: '', filter: '', rename: null, cast: null })
    })
    // The remount is the adoption's (one reset), not a preparation one.
    expect(h.beginCalls).toBe(2)
    // The panel is back in its idle controls for the same column.
    expect(
      within(screen.getByTestId('schema-panel')).getByRole('button', {
        name: 'Rename column label',
      }),
    ).toBeTruthy()
  })

  it('proves the panel region does NOT remount during candidate preparation (T7)', async () => {
    await openFirstDataset()
    seedDrafts()
    // Park the candidate's `engine.open`, so the whole `opening-candidate`
    // window is stable: the draft state must be untouched and no reset may have
    // run yet (the ready subtree did not remount during preparation).
    let release: () => void = () => undefined
    h.upcomingOpenGate = new Promise<void>((resolve) => {
      release = () => {
        resolve()
      }
    })
    h.picks = [{ file: new File(['id,label\n2,y\n'], 'held.csv') }]
    await clickReadyOpen()
    await waitFor(() => {
      expect(screen.queryByTestId('replace-progress')).not.toBeNull()
    })
    expect(readDrafts()).toEqual(SEEDED_DRAFTS)
    expect(h.beginCalls).toBe(1)
    h.upcomingOpenGate = null
    release()
    await waitFor(() => {
      expect(h.beginCalls).toBe(2)
    })
  })
})

/** Drain the resolved-promise hops of an async chain (no timers). */
async function flush(ticks = 32): Promise<void> {
  await act(async () => {
    for (let index = 0; index < ticks; index += 1) await Promise.resolve()
  })
}

/** Open a column's cast editor and submit it (the check may park). */
async function startCast(column: string, target = 'VARCHAR'): Promise<void> {
  const panel = within(screen.getByTestId('schema-panel'))
  await act(async () => {
    fireEvent.click(panel.getByRole('button', { name: `Cast column ${column}` }))
  })
  await act(async () => {
    fireEvent.change(panel.getByTestId('column-cast-select'), { target: { value: target } })
  })
  await act(async () => {
    fireEvent.click(panel.getByTestId('column-cast-commit'))
  })
}

describe('WF-06 — N17: the aggregate cast set, non-committing B first', () => {
  it('stays refused while ANY check is pending, and clears only when the LAST settles', async () => {
    await openFirstDataset()
    h.castHold = true
    await startCast('id')
    await startCast('label')
    expect(h.castHeld.map((held) => held.column)).toEqual(['id', 'label'])
    expect(document.querySelectorAll('[data-testid="column-cast-pending"]')).toHaveLength(2)

    // Both pending: Open is refused with C16 and no picker/guard appears.
    await clickReadyOpen()
    expect(screen.getByTestId('replace-cast-notice').textContent).toBe(APPROVED.cast)
    expect(screen.queryByTestId('replace-guard')).toBeNull()
    const picksBefore = h.pickRequests
    expect(h.pickRequests).toBe(picksBefore)

    // Resolve B FIRST as a NON-COMMITTING outcome (a refusal appends nothing,
    // so no mutation starts and C15 cannot take precedence): A is still in
    // flight, so the aggregate must stay blocked.
    await act(async () => {
      h.castHeld.find((held) => held.column === 'label')?.resolve({ hasNonConvertibleValues: true })
    })
    await flush()
    expect(document.querySelectorAll('[data-testid="column-cast-pending"]')).toHaveLength(1)
    expect(screen.getByTestId('replace-cast-notice')).not.toBeNull()
    await clickReadyOpen()
    expect(screen.queryByTestId('replace-guard')).toBeNull()
    expect(h.pickRequests).toBe(picksBefore)

    // Resolve A (also non-committing): count 0, C16 clears, and the next Open
    // proceeds into the picker.
    await act(async () => {
      h.castHeld.find((held) => held.column === 'id')?.resolve({ hasNonConvertibleValues: true })
    })
    await flush()
    expect(document.querySelectorAll('[data-testid="column-cast-pending"]')).toHaveLength(0)
    await waitFor(() => {
      expect(screen.queryByTestId('replace-cast-notice')).toBeNull()
    })
    h.picks = [{ cancel: true }]
    await clickReadyOpen()
    expect(h.pickRequests).toBe(picksBefore + 1)
    await waitFor(() => {
      expect(screen.getByTestId('replace-notice').textContent).toBe(APPROVED.pickerNotice)
    })
  })

  it('runs the gate BEFORE any notice state write (§3.2)', async () => {
    await openFirstDataset()
    h.castHold = true
    await startCast('id')
    await clickReadyOpen()
    expect(screen.getByTestId('replace-cast-notice')).not.toBeNull()

    // The gate's own observation: on a second gesture, C16 must still be in the
    // DOM when `evaluateReadyGesture` runs. Clearing notices first (the round-1
    // defect) would make this false.
    const callsBefore = h.gateSawNotice.length
    await clickReadyOpen()
    expect(h.gateSawNotice[callsBefore]).toEqual({ draft: false, cast: true })

    // Leave no parked check behind.
    await act(async () => {
      h.castHeld.find((held) => held.column === 'id')?.resolve({ hasNonConvertibleValues: true })
    })
    await flush()
  })
})

describe('WF-06 — T5 closes the guard before the picker, and N9 provider rejection', () => {
  it('closes the guard dialog synchronously before the gate re-run and the picker (T5)', async () => {
    await openFirstDataset()
    await makeDirty()
    h.picks = [{ file: new File(['order_id,region\n1,SG\n'], 'orders.csv') }]
    await clickReadyOpen()
    const guard = screen.getByTestId('replace-guard') as HTMLDialogElement
    expect(guard.open).toBe(true)

    // Observe only the guard's own pick (the idle open's pick is not the case).
    h.pickSawOpenGuard = []
    await act(async () => {
      fireEvent.click(screen.getByTestId('replace-choose'))
    })
    // The picker recorded whether the guard dialog was still open at call time.
    expect(h.pickSawOpenGuard).toEqual([false])
    await waitFor(() => {
      expect(h.openCalls).toEqual(['t1', 't2'])
    })
    expect(h.beginCalls).toBe(2)
  })

  it('keeps the live session when the candidate BASE row count fails before the provider exists (T9b)', async () => {
    await openFirstDataset()
    expect(h.beginCalls).toBe(1)
    h.picks = [{ file: new File(['order_id,region\n1,SG\n'], 'orders.csv') }]
    // A post-registration failure at the BASE-metadata stage: `engine.open`
    // succeeded and `engine.schema` succeeded, then the explicit pre-provider
    // `engineClient.rowCount` read fails. One retained candidate table (ADR 0047).
    h.rowCountFailure = 'view materialization failed'
    await clickReadyOpen()
    await waitFor(() => {
      expect(screen.queryByTestId('replace-error')).not.toBeNull()
    })
    expect(failureText()).toBe(NEUTRAL_CAUSE + FAILURE_SUFFIX)
    expect(liveColumns()).toEqual(COLUMNS_A)
    expect(h.openCalls).toEqual(['t1', 't2'])
    expect(h.beginCalls).toBe(1)
  })

  it('keeps the live session when a PROVIDER read inside model.load() rejects (N9)', async () => {
    await openFirstDataset()
    expect(h.beginCalls).toBe(1)
    h.picks = [{ file: new File(['order_id,region\n1,SG\n'], 'orders.csv') }]
    // The REQUIRED N9 injection: fail the SECOND `engine.schema` call made for
    // the candidate handle. Call 1 is App's explicit base read; call 2 is
    // `DuckDbGridProvider.schema()` awaited by `GridViewportModel.load()` — so
    // the failure really comes from the provider/model load, after
    // `engineClient.open` succeeded and after the provider was constructed.
    h.schemaFailureAtCandidateCall = 2
    await clickReadyOpen()
    await waitFor(() => {
      expect(screen.queryByTestId('replace-error')).not.toBeNull()
    })
    expect(h.candidateSchemaCalls).toBe(2)
    expect(failureText()).toBe(NEUTRAL_CAUSE + FAILURE_SUFFIX)
    expect(liveColumns()).toEqual(COLUMNS_A)
    expect(h.openCalls).toEqual(['t1', 't2'])
    expect(h.beginCalls).toBe(1)
  })
})

/**
 * K17 (v5 §3.2/§7, IC-03): the Open control is unusable while ANY owned surface
 * is open — in **every** phase, so the idle-phase legacy open cannot run behind
 * Help, the first-run telemetry disclosure, Export or Settings.
 */
describe('WF-06 — K17: no open path behind an owned modal (all phases)', () => {
  it('pins the predicate across every phase and owned surface', () => {
    const modals = ['help', 'disclosure', 'replace', 'export', 'settings'] as const
    const phases = ['idle', 'opening', 'ready', 'error'] as const
    for (const phase of phases) {
      // No modal, no intent, not opening → usable.
      expect(openControlBlocked({ phase, intentActive: false, openModal: null })).toBe(
        phase === 'opening',
      )
      for (const openModal of modals) {
        expect(openControlBlocked({ phase, intentActive: false, openModal })).toBe(true)
        expect(openControlBlocked({ phase, intentActive: true, openModal: null })).toBe(true)
      }
    }
  })

  it('disables Open in idle behind the disclosure, Help and Settings — and starts nothing', async () => {
    // The genuine first-run state: the disclosure is a native modal on mount.
    render(<App telemetry={fakeRuntime({ disclosure: true }) as never} />)
    const open = (): HTMLElement => screen.getByTestId('open-button')
    expect(screen.getByTestId('telemetry-disclosure')).not.toBeNull()
    expect(open().hasAttribute('disabled')).toBe(true)
    await act(async () => {
      fireEvent.click(open())
    })
    expect(h.pickRequests).toBe(0)
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('idle')

    // Dismissing the disclosure restores the control.
    fireEvent.click(screen.getByTestId('telemetry-keep-on'))
    expect(screen.queryByTestId('telemetry-disclosure')).toBeNull()
    expect(open().hasAttribute('disabled')).toBe(false)

    // Help (a native modal) in the idle phase.
    fireEvent.click(screen.getByTestId('help-open'))
    expect(screen.getByTestId('workbench-help')).not.toBeNull()
    expect(open().hasAttribute('disabled')).toBe(true)
    await act(async () => {
      fireEvent.click(open())
    })
    expect(h.pickRequests).toBe(0)
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('idle')
    fireEvent.click(screen.getByTestId('help-close'))
    expect(open().hasAttribute('disabled')).toBe(false)

    // Settings (a non-modal owned surface) in the idle phase.
    fireEvent.click(screen.getByTestId('settings-toggle'))
    expect(screen.getByTestId('settings-dialog')).not.toBeNull()
    expect(open().hasAttribute('disabled')).toBe(true)
    await act(async () => {
      fireEvent.click(open())
    })
    expect(h.pickRequests).toBe(0)
    expect(screen.getByTestId('open-status').getAttribute('data-phase')).toBe('idle')
    fireEvent.click(screen.getByTestId('settings-toggle'))
    expect(open().hasAttribute('disabled')).toBe(false)

    // Export owns a slot in the modal priority but lives inside the READY
    // subtree, so `openModal === 'export'` is unreachable in `idle`: the
    // predicate table above covers that cell, and the ready-phase case is
    // pinned by the IC-03 test.
    expect(screen.queryByTestId('export-open')).toBeNull()
  })
})

/**
 * Round-2 review CRITICAL 1 — C15/C16 are lifecycle-derived (K40/v5 §3.7).
 *
 * A refusal for a HIGHER-priority reason (G3 editor, G1 modal) must not clear a
 * pending-work notice: C16 may only disappear when `castPendingCount` reaches
 * zero, and C15 only when the mutation counter does. C13 stays gesture-scoped.
 */
describe('WF-06 — C15/C16 lifecycle independence from refusals', () => {
  /** Open the BOOLEAN cell editor (the kind with no blur handler). */
  async function openBooleanEditor(): Promise<void> {
    const cells = screen.getAllByTestId('grid-cell')
    await act(async () => {
      fireEvent.doubleClick(cells[2] as HTMLElement)
    })
    await waitFor(() => {
      expect(screen.queryByTestId('grid-editor-boolean')).not.toBeNull()
    })
  }

  it('keeps C16 across a G3 refusal and its C13 clear, until the cast resolves (N17-repair)', async () => {
    await openFirstDataset()
    h.castHold = true
    await startCast('id')
    expect(h.castHeld.map((held) => held.column)).toEqual(['id'])
    // Lifecycle-derived: C16 is live as soon as its own observable is live,
    // before any gesture.
    expect(screen.getByTestId('replace-cast-notice').textContent).toBe(APPROVED.cast)

    await openBooleanEditor()
    await clickReadyOpen()
    // G3 wins the gate order: C13 shows and NO picker/guard appears.
    expect(screen.getByTestId('replace-draft-notice').textContent).toBe(APPROVED.draft)
    expect(screen.queryByTestId('replace-guard')).toBeNull()
    expect(h.pickRequests).toBe(1)
    // …and the higher-priority refusal did NOT clear C16.
    expect(screen.getByTestId('replace-cast-notice')).not.toBeNull()
    expect(document.activeElement?.getAttribute('data-testid')).toBe('grid-editor-boolean')

    // Closing the editor clears C13 — and C16 is STILL there (its own
    // observable is still live).
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('grid-editor-boolean'), { key: 'Escape' })
    })
    await waitFor(() => {
      expect(screen.queryByTestId('replace-draft-notice')).toBeNull()
    })
    expect(screen.getByTestId('replace-cast-notice')).not.toBeNull()

    // The cast settles: C16 clears with it, and only then does Open proceed.
    await act(async () => {
      h.castHeld.find((held) => held.column === 'id')?.resolve({ hasNonConvertibleValues: true })
    })
    await waitFor(() => {
      expect(screen.queryByTestId('replace-cast-notice')).toBeNull()
    })
    h.picks = [{ cancel: true }]
    await clickReadyOpen()
    expect(h.pickRequests).toBe(2)
    await waitFor(() => {
      expect(screen.getByTestId('replace-notice').textContent).toBe(APPROVED.pickerNotice)
    })
  })

  it('an unrelated modal (G1) cannot clear C16 either', async () => {
    await openFirstDataset()
    h.castHold = true
    await startCast('label')
    expect(screen.getByTestId('replace-cast-notice')).not.toBeNull()

    // Export owns the modal position; the cast check is still pending.
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-open'))
    })
    expect(screen.getByTestId('export-dialog')).not.toBeNull()
    expect(screen.getByTestId('replace-cast-notice')).not.toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-close'))
    })
    expect(screen.getByTestId('replace-cast-notice')).not.toBeNull()

    await act(async () => {
      h.castHeld.find((held) => held.column === 'label')?.resolve({ hasNonConvertibleValues: true })
    })
    await waitFor(() => {
      expect(screen.queryByTestId('replace-cast-notice')).toBeNull()
    })
  })

  it('derives C15 from the mutation counter and lets it win over C16', async () => {
    await openFirstDataset()

    // 1. Park a commit (rename a column): C15 is live from its own counter.
    let release: () => void = () => undefined
    h.refreshGate = new Promise<void>((resolve) => {
      release = () => {
        resolve()
      }
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
      fireEvent.click(panel.getByRole('button', { name: 'Rename column id' }))
    })
    const input = panel.getByTestId('column-rename-input')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'identifier' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    await waitFor(() => {
      expect(screen.getByTestId('replace-settling-notice')).not.toBeNull()
    })

    // 2. A cast check started while the commit is in flight: C15 wins, so C16
    //    must NOT render even though `castPendingCount > 0`.
    h.castHold = true
    await startCast('label')
    expect(h.castHeld.map((held) => held.column)).toEqual(['label'])
    expect(screen.getByTestId('replace-settling-notice')).not.toBeNull()
    expect(screen.queryByTestId('replace-cast-notice')).toBeNull()

    // 3. The commit settles: C15 clears and the still-pending cast surfaces C16.
    await act(async () => {
      release()
    })
    await waitFor(() => {
      expect(screen.queryByTestId('replace-settling-notice')).toBeNull()
    })
    expect(screen.getByTestId('replace-cast-notice')).not.toBeNull()

    // 4. The cast settles (non-committing): C16 clears with its own observable.
    await act(async () => {
      h.castHeld.find((held) => held.column === 'label')?.resolve({ hasNonConvertibleValues: true })
    })
    await waitFor(() => {
      expect(screen.queryByTestId('replace-cast-notice')).toBeNull()
    })
  })
})
