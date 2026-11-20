// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { App } from './App'
import { DuckDbGridProvider } from './grid/provider'
import type { ArrowTableLike } from './grid/provider'

/**
 * C03b — fail-closed session-reset faults at the REAL composition root.
 *
 * The reset registry, the App guards and the three `beginSession()` call sites
 * (`openDataFile`, `cancelOpen`, `adoptReplacementCandidate`) are real code; the
 * mock below only wraps the real registry to register one thrower, exactly as a
 * future faulty registrant would. Everything else is the same boundary faking
 * as `App.open-status.test.tsx` (picker + engine only).
 *
 * Pinned contract (C03a §5.1/§7, S5–S7):
 *
 * 1. no `ready` state is ever published after a partial reset — the flow is
 *    abandoned BEFORE its first await for an open;
 * 2. exactly one value-free session-fault frame renders, with the reload
 *    affordance and no error text/file/column/value (a VIOLENT sentinel is
 *    asserted absent from the DOM);
 * 3. the callbacks registered after the thrower still ran (per-callback policy);
 * 4. the faulted path emits no `dataset_opened`/`dataset_open_failed`;
 * 5. adoption skips steps 2–9: no candidate rebind, no candidate `ready` phase,
 *    and never the per-file `replace-error` copy;
 * 6. a later clean open starts a fresh session and clears the frame.
 */

const VIOLENT = 'VIOLENT-C03B-PAYLOAD: SELECT secret FROM leak'

/** The reviewed recovery copy, pinned as an independent literal. */
const SESSION_FAULT_COPY =
  'This session could not be closed cleanly, so it was ended instead of shown. ' +
  'Reload the page to start a clean session.'
const SESSION_FAULT_RELOAD_LABEL = 'Reload the page'

const FAKE_HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }
const FAKE_SCHEMA: readonly { name: string; type: string }[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'country', type: 'VARCHAR' },
]

const h = vi.hoisted(() => ({
  /** Arm the injected thrower: the next `beginSession()` records a fault. */
  faultArmed: false,
  /** Resets registered AFTER the thrower — proof the policy kept going. */
  afterFaultRuns: 0,
  /** The session object the thrower was registered on (once per mount). */
  wrapped: null as unknown,
  deferOpen: false,
  openResolvers: [] as Array<(value: unknown) => void>,
  openCalls: 0,
  pickerCalls: 0,
  events: [] as string[],
  picks: 0,
}))

function fakeBatch(): ArrowTableLike {
  const columns = [{ get: () => 1 }, { get: () => 'SG' }]
  return {
    numRows: 1,
    numCols: columns.length,
    getChildAt: (index: number) => columns[index] ?? null,
  }
}

/**
 * The real registry, plus one thrower and one trailing counter registered
 * exactly as a registrant would. Registering at `useDatasetSession()` time puts
 * the thrower FIRST in the epoch (App's own resets register from effects), so
 * this is the S1 case: fault in the first reset, every later reset still runs.
 */
vi.mock('./sessions/session-reset', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sessions/session-reset')>()
  return {
    ...actual,
    useDatasetSession: () => {
      const session = actual.useDatasetSession()
      if (h.wrapped !== session) {
        h.wrapped = session
        session.registerReset(() => {
          if (h.faultArmed) throw new Error(VIOLENT)
        })
        session.registerReset(() => {
          h.afterFaultRuns += 1
        })
      }
      return session
    },
  }
})

vi.mock('@assay/data-sources/browser', () => ({
  pickDataFile: async (): Promise<{ source: { getFile: () => Promise<File> } }> => {
    h.pickerCalls += 1
    return { source: { getFile: async () => new File(['id\n1\n'], 'session-fault.csv') } }
  },
}))

vi.mock('./lib/engine', () => ({
  engineClient: {
    open: async () => {
      h.openCalls += 1
      if (h.deferOpen) {
        await new Promise<unknown>((resolve) => h.openResolvers.push(resolve))
      }
      return FAKE_HANDLE
    },
    schema: async () => FAKE_SCHEMA,
    rowCount: async () => 1,
    fetchRange: async () => ({ batch: fakeBatch(), hasMore: false }),
  },
}))

// The two engine-calling panels are orthogonal to this pin; SchemaPanel (the
// docs-visible panel) stays real so a `ready` state would be unmistakable.
vi.mock('./sql/SqlPanel', () => ({ SqlPanel: () => null }))
vi.mock('./profile/ProfilePanel', () => ({ ProfilePanel: () => null }))

/** Inert telemetry that records emitted event names. */
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

beforeEach(() => {
  h.faultArmed = false
  h.afterFaultRuns = 0
  h.wrapped = null
  h.deferOpen = false
  h.openResolvers = []
  h.openCalls = 0
  h.pickerCalls = 0
  h.events = []
  h.picks = 0
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderApp(): void {
  render(<App telemetry={fakeRuntime() as never} />)
}

function phase(): string | null {
  return screen.getByTestId('open-status').getAttribute('data-phase')
}

function openFrames(): HTMLElement[] {
  return screen.queryAllByTestId('session-fault')
}

async function clickOpen(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('open-button'))
  })
}

describe('C03b — openDataFile with a faulted reset (S7)', () => {
  it('abandons before the picker/engine open, publishes no ready and shows one recovery frame', async () => {
    h.faultArmed = true
    renderApp()

    await clickOpen()

    // Fail closed: idle (not `opening`, not `ready`), one frame only.
    expect(phase()).toBe('idle')
    expect(openFrames()).toHaveLength(1)
    expect(screen.getByTestId('session-fault-text').textContent).toBe(SESSION_FAULT_COPY)
    expect(screen.getByTestId('session-fault-reload').textContent).toBe(SESSION_FAULT_RELOAD_LABEL)
    // The chain stopped before its first await: no picker, no engine open, no
    // open telemetry on the faulted path.
    expect(h.pickerCalls).toBe(0)
    expect(h.openCalls).toBe(0)
    expect(h.events.filter((name) => name.startsWith('dataset_'))).toEqual([])
    // Per-callback policy: the reset registered after the thrower still ran.
    expect(h.afterFaultRuns).toBe(1)
    // Value-free: the fault never renders its error text.
    expect(document.body.textContent).not.toContain(VIOLENT)
    expect(screen.queryByTestId('schema-section')).toBeNull()
  })

  it('S4: a later clean open starts a fresh session and clears the recovery frame', async () => {
    h.faultArmed = true
    renderApp()
    await clickOpen()
    expect(openFrames()).toHaveLength(1)

    h.faultArmed = false
    await clickOpen()
    await screen.findByTestId('schema-section')

    expect(phase()).toBe('ready')
    expect(openFrames()).toHaveLength(0)
    expect(h.events.filter((name) => name === 'dataset_opened')).toHaveLength(1)
    // The registry re-ran every callback for the new epoch (the thrower ran
    // again, fault-free, and the trailing reset followed it).
    expect(h.afterFaultRuns).toBe(2)
  })
})

describe('C03b — cancelOpen with a faulted reset (S6)', () => {
  it('reaches idle plus the recovery frame instead of a stuck opening phase', async () => {
    h.deferOpen = true
    renderApp()
    await clickOpen()
    expect(phase()).toBe('opening')

    h.faultArmed = true
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-cancel'))
    })

    // No uncaught event-handler throw, no stuck `opening`.
    expect(phase()).toBe('idle')
    expect(openFrames()).toHaveLength(1)
    // Two epochs ran every reset: the clean open above, then this faulted
    // cancel — the thrower faulted but the trailing reset still ran.
    expect(h.afterFaultRuns).toBe(2)

    // The parked engine open resolving AFTER the cancel is stale (the token was
    // bumped): it must not resurrect `ready` nor duplicate the frame.
    const parked = h.openResolvers[0]
    if (parked === undefined) throw new Error('the engine open was never parked')
    await act(async () => {
      parked(FAKE_HANDLE)
    })
    expect(phase()).toBe('idle')
    expect(openFrames()).toHaveLength(1)
    expect(h.events.filter((name) => name === 'dataset_opened')).toHaveLength(0)
  })

  it('a clean cancel shows no recovery frame (baseline preserved)', async () => {
    h.deferOpen = true
    renderApp()
    await clickOpen()
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-cancel'))
    })
    expect(phase()).toBe('idle')
    expect(openFrames()).toHaveLength(0)
  })
})

describe('C03b — adoption with a faulted reset (S5)', () => {
  it('skips steps 2–9: no rebind, no candidate ready, no per-file failure copy', async () => {
    const rebind = vi.spyOn(DuckDbGridProvider.prototype, 'rebindOverlaySource')
    renderApp()
    await clickOpen()
    await screen.findByTestId('schema-section')
    expect(phase()).toBe('ready')
    expect(h.events.filter((name) => name === 'dataset_opened')).toHaveLength(1)

    // The live session has staged state: a faulted adoption must not publish
    // the new candidate and must not claim the old session was preserved.
    h.faultArmed = true
    await clickOpen()
    await waitFor(() => {
      expect(openFrames()).toHaveLength(1)
    })

    expect(phase()).toBe('idle')
    expect(screen.queryByTestId('schema-section')).toBeNull()
    // Exactly one frame, and it is NOT the ordinary per-file open-failure panel.
    expect(screen.queryByTestId('replace-error')).toBeNull()
    expect(screen.queryByTestId('replace-error-text')).toBeNull()
    // Adoption steps 2–9 never ran: the candidate provider was never rebound to
    // the live overlay, and no `dataset_opened` was emitted for it.
    expect(rebind).not.toHaveBeenCalled()
    expect(h.events.filter((name) => name === 'dataset_opened')).toHaveLength(1)
    expect(h.events).not.toContain('dataset_open_failed')
    expect(h.afterFaultRuns).toBe(2)
    expect(document.body.textContent).not.toContain(VIOLENT)
  })
})
