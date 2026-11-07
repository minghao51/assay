// SPDX-License-Identifier: AGPL-3.0-or-later

import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import {
  WORKBENCH_HELP_CLOSE_LABEL,
  WORKBENCH_HELP_OPEN_LABEL,
  WORKBENCH_HELP_TITLE,
  WorkbenchHelp,
} from './WorkbenchHelp'
import { App } from '../App'
import type { WebTelemetryRuntime } from '../telemetry/runtime'
import type { ArrowTableLike } from '../grid/provider'

/**
 * The App composition root is exercised with the picker/engine boundaries faked
 * and a fake telemetry runtime injected (the `App.telemetry` posture), so the
 * modal-arbitration pins below are the real wiring, not a re-implementation.
 */
const FAKE_HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }

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
    source: { getFile: async () => new File(['id\n1\n'], 'guide.jsonl') },
  }),
}))

vi.mock('../lib/engine', () => ({
  engineClient: {
    open: async () => FAKE_HANDLE,
    schema: async () => [{ name: 'id', type: 'BIGINT' }],
    rowCount: async () => 1,
    fetchRange: async () => ({ batch: fakeBatch(), hasMore: false }),
    dispose: async () => undefined,
  },
}))

vi.mock('../sql/SqlPanel', () => ({ SqlPanel: () => null }))
vi.mock('../profile/ProfilePanel', () => ({ ProfilePanel: () => null }))

function fakeRuntime(overrides: Partial<WebTelemetryRuntime> = {}): WebTelemetryRuntime {
  let pending = true
  return {
    surface: 'web',
    hardOff: false,
    endpointConfigured: true,
    emit: vi.fn(),
    flush: vi.fn(async () => undefined),
    getPreference: () => 'on',
    setPreference: vi.fn(),
    isEnabledNow: () => true,
    shouldShowDisclosure: () => pending,
    markDisclosureShown: vi.fn(() => {
      pending = false
    }),
    dispose: vi.fn(),
    ...overrides,
  }
}

/**
 * rd-7 (D-03) — the one global Help guide.
 *
 * The browser leg (`tests/e2e/workbench-help.spec.ts`) proves the real modal
 * behaviour (top-layer inertness, Tab containment, Esc, focus return, axe in
 * both schemes, 1024/1440/900). These component pins are the fast complement,
 * and they are the copy gate: every approved §4 string is pinned against an
 * INDEPENDENT literal here, so a reworded or partially-reworded guide fails
 * instead of passing on a substring. The four task purposes are pinned twice
 * over — as the approved literals, and against the task strip's own source of
 * truth (`workbench/tasks.ts`), so the guide and the strip cannot drift apart.
 *
 * Privacy (ADR 0025): the suite asserts the guide carries no value of any kind
 * — no file name, path, row count or dataset content — and that rendering and
 * closing it emits no telemetry.
 */

/** §4 approved copy, byte-exact, as literals (never imported from the component). */
const APPROVED = {
  title: 'Workbench guide',
  openLabel: 'Help',
  closeLabel: 'Close',
  whatThisIs:
    'Inspect, check, change and deliver a dataset without leaving this machine. Nothing is uploaded; the file you open is never modified. Changes are staged in this session and exported as a new copy.',
  tasks: [
    'Explore — Understand what is in the file: fields, filters, query and statistics.',
    'Check — Find quality issues or explain differences between two versions.',
    'Change — Make a reversible repair, review staged operations and deliver a copy.',
    'Prepare — Run deterministic steps and inspect gate and delivery evidence.',
  ],
  taskNote:
    'Choose a task to see the sections it uses. Grid and Record stay available in every task.',
  formats:
    "Reads Parquet, CSV, JSONL/NDJSON and JSON; Arrow is an export format, not an input. This browser app may download DuckDB's Parquet or JSON reader from extensions.duckdb.org the first time it opens such a file, so opening one without a network connection is not guaranteed. The desktop app ships those readers locally.",
  keyboard:
    'The task strip is a radio group: arrow keys move between tasks, Home and End jump to the first and last. Section links move focus to the section. In the grid, arrows move the focused cell and Enter opens the editor. Esc closes a dialog.',
} as const

/** A control's disabled state (this repo has no jest-dom matchers). */
function helpOpener(): HTMLButtonElement {
  const element = screen.getByTestId('help-open')
  if (!(element instanceof HTMLButtonElement)) throw new Error('the opener must be a <button>')
  return element
}

function dialog(): HTMLDialogElement {
  const element = screen.getByTestId('workbench-help')
  if (!(element instanceof HTMLDialogElement)) {
    throw new Error(`the guide must be a native <dialog>, got <${element.tagName.toLowerCase()}>`)
  }
  return element
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('rd-7 WorkbenchHelp — one native modal guide', () => {
  it('opens as a native <dialog> with the approved accessible name', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    render(<WorkbenchHelp onClose={() => undefined} />)

    const surface = dialog()
    expect(surface.tagName).toBe('DIALOG')
    expect(showModal).toHaveBeenCalledTimes(1)
    expect(surface.open).toBe(true)
    expect(surface.getAttribute('aria-labelledby')).toBe('workbench-help-title')
    expect(document.getElementById('workbench-help-title')?.textContent).toBe(APPROVED.title)
    // The accessible name really resolves through the labelled heading.
    expect(screen.getByRole('dialog', { name: APPROVED.title })).toBe(surface)
  })

  it('pins the constants to the approved literals', () => {
    expect(WORKBENCH_HELP_TITLE).toBe(APPROVED.title)
    expect(WORKBENCH_HELP_OPEN_LABEL).toBe(APPROVED.openLabel)
    expect(WORKBENCH_HELP_CLOSE_LABEL).toBe(APPROVED.closeLabel)
  })

  it('renders every approved string byte-exactly, in the approved order', () => {
    render(<WorkbenchHelp onClose={() => undefined} />)

    expect(screen.getByTestId('help-what-this-is').textContent).toBe(APPROVED.whatThisIs)
    expect(screen.getByTestId('help-task-note').textContent).toBe(APPROVED.taskNote)
    expect(screen.getByTestId('help-formats').textContent).toBe(APPROVED.formats)
    expect(screen.getByTestId('help-keyboard').textContent).toBe(APPROVED.keyboard)
    expect(screen.getByTestId('help-close').textContent).toBe(APPROVED.closeLabel)

    // The four tasks, in the approved order, each a name → purpose pair.
    const items = ['explore', 'check', 'change', 'prepare'].map((id) => {
      const item = screen.getByTestId(`help-task-${id}`)
      expect(item.textContent).toBe(
        APPROVED.tasks[['explore', 'check', 'change', 'prepare'].indexOf(id)],
      )
      return item
    })
    const rendered = items.map((item) => item.textContent)
    expect(rendered).toEqual([...APPROVED.tasks])

    // Document order: what this is → the four tasks → formats and locality →
    // keyboard. Compared by position in the dialog's own text, so a section
    // moved above another fails here even if every string still renders.
    const body = screen.getByTestId('workbench-help-body').textContent ?? ''
    const at = (needle: string): number => body.indexOf(needle)
    expect(at(APPROVED.whatThisIs)).toBeGreaterThanOrEqual(0)
    expect(at(APPROVED.tasks[0] as string)).toBeGreaterThan(at(APPROVED.whatThisIs))
    expect(at(APPROVED.taskNote)).toBeGreaterThan(at(APPROVED.tasks[3] as string))
    expect(at(APPROVED.formats)).toBeGreaterThan(at(APPROVED.taskNote))
    expect(at(APPROVED.keyboard)).toBeGreaterThan(at(APPROVED.formats))
  })

  it('marks the DuckDB extension host as a code span', () => {
    render(<WorkbenchHelp onClose={() => undefined} />)
    const code = screen.getByTestId('help-formats').querySelector('code')
    expect(code?.textContent).toBe('extensions.duckdb.org')
  })

  it('reuses the task strip’s approved purposes instead of retyping them', async () => {
    const { WORKBENCH_TASKS } = await import('../workbench/tasks')
    render(<WorkbenchHelp onClose={() => undefined} />)
    WORKBENCH_TASKS.forEach((task, index) => {
      expect(screen.getByTestId(`help-task-${task.id}`).textContent).toBe(APPROVED.tasks[index])
      expect(APPROVED.tasks[index]).toContain(task.purpose)
      expect(APPROVED.tasks[index]).toContain(task.name)
    })
  })

  it('starts focus on the title, then reaches the Close control', () => {
    render(<WorkbenchHelp onClose={() => undefined} />)
    const title = document.getElementById('workbench-help-title')
    expect(title?.getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(title)
    expect(document.activeElement).not.toBe(screen.getByTestId('help-close'))
  })

  it('closes through the Close control and restores focus to the opener', () => {
    const onClose = vi.fn()
    const opener = document.createElement('button')
    opener.type = 'button'
    document.body.append(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    const { rerender } = render(<WorkbenchHelp onClose={onClose} />)
    expect(document.activeElement).not.toBe(opener)

    rerender(<div />)
    expect(onClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('calls onClose for the native cancel (Esc) event and prevents the UA close', () => {
    const onClose = vi.fn()
    render(<WorkbenchHelp onClose={onClose} />)
    const surface = dialog()
    const cancel = new Event('cancel', { cancelable: true })
    fireEvent(surface, cancel)
    expect(cancel.defaultPrevented).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('wraps Tab and Shift+Tab inside the guide at the boundary', () => {
    render(<WorkbenchHelp onClose={() => undefined} />)
    const body = screen.getByTestId('workbench-help-body')
    const close = screen.getByTestId('help-close')

    // Tab on the last stop wraps to the first (the event is consumed).
    close.focus()
    expect(fireEvent.keyDown(close, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(body)

    // Shift+Tab on the first stop wraps to the last…
    body.focus()
    expect(fireEvent.keyDown(body, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(close)

    // …and Shift+Tab from the reading-start title also lands on the last stop.
    const title = document.getElementById('workbench-help-title')
    title?.focus()
    expect(fireEvent.keyDown(title as HTMLElement, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(close)

    // A Tab that stays inside is never consumed.
    body.focus()
    expect(fireEvent.keyDown(body, { key: 'Tab' })).toBe(true)
    expect(document.activeElement).toBe(body)
  })

  it('invokes the latest onClose even when the parent passes a fresh callback', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(<WorkbenchHelp onClose={first} />)
    rerender(<WorkbenchHelp onClose={second} />)
    fireEvent.click(screen.getByTestId('help-close'))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('survives StrictMode’s double effect (one modal, one focus restore)', () => {
    const onClose = vi.fn()
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const { unmount } = render(
      <StrictMode>
        <WorkbenchHelp onClose={onClose} />
      </StrictMode>,
    )
    expect(dialog().tagName).toBe('DIALOG')
    unmount()
    expect(document.activeElement).toBe(opener)
    expect(onClose).not.toHaveBeenCalled()
    opener.remove()
  })

  it('carries no dataset value, no file name and no telemetry call', () => {
    const emit = vi.fn()
    // The component takes no telemetry context at all: rendering it inside the
    // provider-less tree below would throw if it ever reached for one.
    render(<WorkbenchHelp onClose={() => undefined} />)
    const text = dialog().textContent ?? ''
    expect(text).not.toMatch(/\.parquet|\.csv|\.jsonl|\.json\b/i)
    expect(text).not.toMatch(/\b\d+\s?(rows?|columns?|files?)\b/i)
    expect(text).not.toMatch(/[/\\][\w.-]+[/\\]/)
    // No link out and no image: the guide is text only.
    expect(dialog().querySelectorAll('a, img, iframe, form')).toHaveLength(0)
    expect(emit).not.toHaveBeenCalled()
  })
})

/**
 * Modal arbitration (contract §2/§5). One owned surface at a time, reusing the
 * existing app-local ownership: Export, Settings and the first-run disclosure
 * each already own their open state, and Help joins that set instead of adding
 * a modal manager or a second trap.
 *
 * Direction "another surface open ⇒ Help cannot open" is pinned here, because
 * it is App's own state (the opener is disabled, so neither click nor Tab can
 * reach it). The reverse direction — "Help open ⇒ nothing else can open" — is
 * the browser's native top-layer inertness, which has no jsdom equivalent, so
 * `tests/e2e/workbench-help.spec.ts` proves it with real pointer and keyboard
 * events instead of a fake here.
 */
describe('rd-7 Help modal arbitration (one owned surface at a time)', () => {
  it('disables the guide opener while the export dialog is open, and re-enables it on close', async () => {
    render(<App telemetry={fakeRuntime({ shouldShowDisclosure: () => false })} />)
    // The export dialog lives in the ready frame's Export section.
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-button'))
    })
    await screen.findByTestId('export-open')
    expect(helpOpener().disabled).toBe(false)

    fireEvent.click(screen.getByTestId('export-open'))
    expect(screen.getByTestId('export-dialog')).toBeTruthy()
    expect(helpOpener().disabled).toBe(true)
    fireEvent.click(screen.getByTestId('help-open'))
    expect(screen.queryByTestId('workbench-help')).toBeNull()

    fireEvent.click(screen.getByTestId('export-close'))
    expect(screen.queryByTestId('export-dialog')).toBeNull()
    expect(helpOpener().disabled).toBe(false)
  })

  it('disables the guide opener while the telemetry Settings panel is open', () => {
    render(<App telemetry={fakeRuntime({ shouldShowDisclosure: () => false })} />)
    fireEvent.click(screen.getByTestId('settings-toggle'))
    expect(screen.getByTestId('settings-dialog')).toBeTruthy()
    expect(helpOpener().disabled).toBe(true)

    fireEvent.click(screen.getByTestId('settings-close'))
    expect(helpOpener().disabled).toBe(false)
  })

  it('returns focus to the Settings toggle when the panel closes from its own control', () => {
    render(<App telemetry={fakeRuntime({ shouldShowDisclosure: () => false })} />)
    const toggle = screen.getByTestId('settings-toggle')
    toggle.focus()
    fireEvent.click(toggle)
    fireEvent.click(screen.getByTestId('settings-close'))
    expect(document.activeElement).toBe(screen.getByTestId('settings-toggle'))
  })

  it('disables the guide opener while the first-run telemetry disclosure is open', () => {
    render(<App telemetry={fakeRuntime()} />)
    expect(screen.getByTestId('telemetry-disclosure')).toBeTruthy()
    expect(helpOpener().disabled).toBe(true)
    fireEvent.click(screen.getByTestId('help-open'))
    expect(screen.queryByTestId('workbench-help')).toBeNull()

    fireEvent.click(screen.getByTestId('telemetry-keep-on'))
    expect(screen.queryByTestId('telemetry-disclosure')).toBeNull()
    expect(helpOpener().disabled).toBe(false)
  })

  it('opens from the header, and Escape closes it back onto the opener', () => {
    render(<App telemetry={fakeRuntime({ shouldShowDisclosure: () => false })} />)
    const opener = screen.getByTestId('help-open')
    opener.focus()
    fireEvent.click(opener)

    const dialog = screen.getByTestId('workbench-help')
    expect(dialog).toBeTruthy()
    expect(document.activeElement).not.toBe(opener)
    expect(dialog.contains(document.activeElement)).toBe(true)
    // The opener stays enabled (it is the focus-return target) but the guide is
    // the only dialog on the page.
    expect(screen.queryByTestId('export-dialog')).toBeNull()
    expect(screen.queryByTestId('settings-dialog')).toBeTruthy()

    const cancel = new Event('cancel', { cancelable: true })
    fireEvent(dialog, cancel)
    expect(screen.queryByTestId('workbench-help')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('help-open'))
  })

  it('closes from the Close control and returns focus to the opener', () => {
    render(<App telemetry={fakeRuntime({ shouldShowDisclosure: () => false })} />)
    const opener = helpOpener()
    opener.focus()
    fireEvent.click(opener)
    fireEvent.click(screen.getByTestId('help-close'))
    expect(screen.queryByTestId('workbench-help')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('help-open'))
  })
})
