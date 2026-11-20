// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { appendOp, emptyHistory } from '@assay/domain'
import type { OverlayBase, TransformationHistory } from '@assay/domain'
import type { EngineOverlay, EngineTableHandle } from '@assay/engine-duckdb'
import type { PickedDataFile } from '@assay/data-sources/browser'
import type { GridViewportModel } from '@assay/grid'
import type { DuckDbGridProvider } from '../grid/provider'
import type { BottomPanelModules } from '../lib/bottom-panels'
import type { Phase } from '../sessions/types'
import type {
  CandidateGrid,
  ReplacementCandidate,
  ReplacementController,
  ReplacementControllerParams,
} from './useReplacementController'
import { useReplacementController } from './useReplacementController'

/**
 * D02b — the app-local replacement controller, pinned WITHOUT the App shell.
 *
 * Only the ports are faked (picker, engine, candidate grid, panel preload,
 * adoption); the controller, the intent machine (`./machine`) and the gesture
 * gate (`./gate`) are the real modules. Each test therefore pins one moved
 * lifecycle property directly, and `App.replace.test.tsx` stays the
 * integration pin through the real composition root.
 *
 * Copy used in assertions is an INDEPENDENT literal (the App.replace
 * precedent), never imported from the modules under test.
 */

/** C10's unsupported-format sentence (independent literal, never imported). */
const UNSUPPORTED_CAUSE =
  'The file could not be opened. This file type is not supported — open a .parquet, .csv, .jsonl or .json file.'

const LIVE_BASE: OverlayBase = {
  baseAnchor: 'fv-10-100',
  overlayAnchor: 'ov-live',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'label', type: 'VARCHAR' },
  ],
  baseRowCount: 2,
}

const CANDIDATE_COLUMNS = [
  { name: 'order_id', type: 'BIGINT' },
  { name: 'region', type: 'VARCHAR' },
]

const CANDIDATE_FILE = new File(['order_id,region\n1,SG\n'], 'orders.csv')

interface HarnessState {
  phase: Phase
  history: TransformationHistory
  /** Picks the picker fake resolves, in order (`null` = cancel, Error = throw). */
  picks: Array<File | null | Error>
  pickCalls: number
  /** Every engine call, in order — the no-extra-call pin. */
  engineCalls: string[]
  openCalls: number
  /** Rejects the next `engine.open` (T9). */
  openFailure: Error | null
  loadCalls: number
  preloadCalls: number
  adoptCalls: ReplacementCandidate[]
  adoptOutcome: 'adopted' | 'faulted'
  /** Parks `engine.open` until released (the `opening-candidate` window). */
  openGate: Promise<void> | null
  /** Parks `preloadPanels` (the last await before adoption). */
  panelsGate: Promise<void> | null
  /** The overlay source handed to `createCandidateGrid`. */
  candidateOverlaySource: (() => EngineOverlay) | null
  editorOpen: boolean
  castPending: ReadonlySet<string>
}

interface Harness {
  readonly state: HarnessState
  readonly params: ReplacementControllerParams
  readonly mount: () => void
  readonly api: () => ReplacementController
}

function livePhase(): Phase {
  const handle: EngineTableHandle = { kind: 'table', id: 't1' }
  return {
    kind: 'ready',
    model: {} as GridViewportModel,
    tableId: handle.id,
    handle,
    base: LIVE_BASE,
    provider: {} as DuckDbGridProvider,
  }
}

function dirtyHistory(): TransformationHistory {
  return appendOp(LIVE_BASE, emptyHistory(), {
    kind: 'column-rename',
    from: 'label',
    to: 'tag',
  }).history
}

/**
 * The harness: real controller, fake ports over a mutable `state`. The refs are
 * getter objects, so moving `state.phase` in a test is exactly the production
 * "the live phase object changed" currency signal.
 */
function harness(): Harness {
  const state: HarnessState = {
    phase: livePhase(),
    history: emptyHistory(),
    picks: [],
    pickCalls: 0,
    engineCalls: [],
    openCalls: 0,
    openFailure: null,
    loadCalls: 0,
    preloadCalls: 0,
    adoptCalls: [],
    adoptOutcome: 'adopted',
    openGate: null,
    panelsGate: null,
    candidateOverlaySource: null,
    editorOpen: false,
    castPending: new Set<string>(),
  }

  const params: ReplacementControllerParams = {
    phaseRef: {
      get current(): Phase {
        return state.phase
      },
    },
    editorStateRef: {
      get current() {
        return { open: state.editorOpen, invalid: false }
      },
    },
    mutationStateRef: { current: 0 },
    castPendingColumnsRef: {
      get current(): ReadonlySet<string> {
        return state.castPending
      },
    },
    historyRef: {
      get current(): TransformationHistory {
        return state.history
      },
    },
    pickFile: async () => {
      state.pickCalls += 1
      const next = state.picks.shift()
      if (next === undefined || next === null) return null
      if (next instanceof Error) throw next
      return {
        via: 'file-system-access',
        source: { getFile: async () => next },
      } as unknown as PickedDataFile
    },
    engine: {
      open: async () => {
        state.engineCalls.push('open')
        state.openCalls += 1
        const gate = state.openGate
        if (gate !== null) {
          state.openGate = null
          await gate
        }
        const failure = state.openFailure
        if (failure !== null) {
          state.openFailure = null
          throw failure
        }
        return { kind: 'table', id: `t${String(state.openCalls + 1)}` }
      },
      schema: async () => {
        state.engineCalls.push('schema')
        return CANDIDATE_COLUMNS
      },
      rowCount: async () => {
        state.engineCalls.push('rowCount')
        return 4
      },
      csvPreview: async () => {
        state.engineCalls.push('csvPreview')
        return {} as Awaited<ReturnType<ReplacementControllerParams['engine']['csvPreview']>>
      },
    },
    createCandidateGrid: (input) => {
      state.candidateOverlaySource = input.overlaySource
      const provider = {
        rebindOverlaySource: () => undefined,
      } as unknown as CandidateGrid['provider']
      const model = {
        load: async () => {
          state.loadCalls += 1
        },
      } as unknown as CandidateGrid['model']
      return { provider, model }
    },
    preloadPanels: async () => {
      state.preloadCalls += 1
      const gate = state.panelsGate
      if (gate !== null) {
        state.panelsGate = null
        await gate
      }
      return {} as BottomPanelModules
    },
    adopt: (candidate) => {
      state.adoptCalls.push(candidate)
      return state.adoptOutcome
    },
  }

  let mounted: { result: { current: ReplacementController } } | null = null
  return {
    state,
    params,
    mount: () => {
      mounted = renderHook(() => useReplacementController(params))
    },
    api: () => {
      if (mounted === null) throw new Error('mount() first')
      return mounted.result.current
    },
  }
}

/** Drain the controller's resolved-promise hops (no timers). */
async function flush(ticks = 32): Promise<void> {
  await act(async () => {
    for (let index = 0; index < ticks; index += 1) await Promise.resolve()
  })
}

const READY_READINGS = { gateModal: null, gridBusy: null } as const

afterEach(() => {
  cleanup()
})

describe('D02b — acquisition', () => {
  it('invokes the picker synchronously from the gesture and cancels without touching the session', async () => {
    const h = harness()
    h.mount()
    h.state.picks = [null]

    act(() => {
      h.api().beginGesture(READY_READINGS, { respectDirtyGuard: true, path: 'open' })
    })

    // Synchronous: the picker ran BEFORE the command returned — no `await`
    // precedes it, so the transient user activation is still live.
    expect(h.state.pickCalls).toBe(1)
    expect(h.api().intent.kind).toBe('choosing')

    await flush()

    // T6: chooser dismissed — the intent ends, C8 renders, and NOTHING else
    // happened: no engine call, no adoption, no reset, no history write.
    expect(h.api().intent.kind).toBe('none')
    expect(h.api().pickerWasCancelled).toBe(true)
    expect(h.api().replacementFailure).toBeNull()
    expect(h.state.engineCalls).toEqual([])
    expect(h.state.adoptCalls).toEqual([])
    expect(h.state.history).toEqual(emptyHistory())

    // Exactly one pick per gesture (a cancel never re-enters the picker).
    expect(h.state.pickCalls).toBe(1)
  })

  it('reports a rejected picked-file read and stays out of the engine (T9)', async () => {
    const h = harness()
    h.mount()
    h.state.picks = [new Error('read failed')]

    act(() => {
      h.api().beginGesture(READY_READINGS, { respectDirtyGuard: true, path: 'open' })
    })
    await flush()

    expect(h.api().intent.kind).toBe('none')
    expect(h.api().replacementFailure).toMatchObject({ detail: 'read failed' })
    expect(h.state.engineCalls).toEqual([])
    expect(h.state.adoptCalls).toEqual([])
  })
})

describe('D02b — preparation', () => {
  it('reports one preparation failure without adopting or rebuilding the grid', async () => {
    const h = harness()
    h.mount()
    h.state.openFailure = new Error('unsupported file type')
    h.state.picks = [CANDIDATE_FILE]

    act(() => {
      h.api().beginGesture(READY_READINGS, { respectDirtyGuard: true, path: 'open' })
    })
    await flush()

    expect(h.api().intent.kind).toBe('none')
    expect(h.api().replacementFailure).toMatchObject({
      cause: UNSUPPORTED_CAUSE,
      detail: 'unsupported file type',
    })
    // The candidate never got past `engine/open`: no schema/rowCount read, no
    // model.load, no panel preload, no adoption, no second open.
    expect(h.state.engineCalls).toEqual(['open'])
    expect(h.state.loadCalls).toBe(0)
    expect(h.state.preloadCalls).toBe(0)
    expect(h.state.adoptCalls).toEqual([])
  })

  it('prepares a candidate-local overlay and adopts it exactly once', async () => {
    const h = harness()
    h.mount()
    h.state.picks = [CANDIDATE_FILE]

    act(() => {
      h.api().beginGesture(READY_READINGS, { respectDirtyGuard: true, path: 'open' })
    })
    await flush(64)

    // One open, one schema read, one row count, one model.load, one preload —
    // no preview and no duplicated open anywhere in the chain.
    expect(h.state.engineCalls).toEqual(['open', 'schema', 'rowCount'])
    expect(h.state.loadCalls).toBe(1)
    expect(h.state.preloadCalls).toBe(1)

    // Exactly one adoption, carrying the candidate's OWN base (A1-1).
    expect(h.state.adoptCalls).toHaveLength(1)
    const candidate = h.state.adoptCalls[0]
    expect(candidate?.base.columns).toEqual(CANDIDATE_COLUMNS)
    expect(candidate?.base.baseRowCount).toBe(4)
    expect(candidate?.file).toBe(CANDIDATE_FILE)

    // The provider's overlay source is candidate-local: the CANDIDATE's base
    // with an EMPTY op list, not the live base.
    const snapshot = h.state.candidateOverlaySource?.()
    expect(snapshot?.ops).toEqual([])
    expect(snapshot?.base.columns).toEqual(CANDIDATE_COLUMNS)
    expect(snapshot?.base).not.toBe(LIVE_BASE)

    // The intent ends last; no failure notice is left behind.
    expect(h.api().intent.kind).toBe('none')
    expect(h.api().replacementFailure).toBeNull()
  })
})

describe('D02b — currency checks after every await', () => {
  it('drops a candidate acquired for a phase that is no longer live', async () => {
    const h = harness()
    h.mount()
    h.state.picks = [CANDIDATE_FILE]

    act(() => {
      h.api().beginGesture(READY_READINGS, { respectDirtyGuard: true, path: 'open' })
    })
    // Supersede the captured phase before the pick resolves: the phase identity
    // is the currency token every await is checked against (T10).
    h.state.phase = livePhase()
    await flush(64)

    expect(h.state.engineCalls).toEqual([])
    expect(h.state.loadCalls).toBe(0)
    expect(h.state.adoptCalls).toEqual([])
    // And no notice claims a failure for a silently dropped stale chain.
    expect(h.api().replacementFailure).toBeNull()
  })

  it('refuses adoption when the phase moves while the panels resolve', async () => {
    const h = harness()
    h.mount()
    let release: () => void = () => undefined
    h.state.panelsGate = new Promise<void>((resolve) => {
      release = () => {
        resolve()
      }
    })
    h.state.picks = [CANDIDATE_FILE]

    act(() => {
      h.api().beginGesture(READY_READINGS, { respectDirtyGuard: true, path: 'open' })
    })
    await flush(32)
    // Fully prepared against its own base, but the last await is still in
    // flight — nothing has been adopted yet.
    expect(h.state.engineCalls).toEqual(['open', 'schema', 'rowCount'])
    expect(h.state.adoptCalls).toEqual([])

    h.state.phase = livePhase()
    await act(async () => {
      release()
      await Promise.resolve()
    })
    await flush(32)

    // The step-0 check refuses: adoption writes nothing at all.
    expect(h.state.adoptCalls).toEqual([])
  })

  it('ends the intent on a faulted adoption instead of leaving it in flight (C03b)', async () => {
    const h = harness()
    h.mount()
    h.state.adoptOutcome = 'faulted'
    h.state.picks = [CANDIDATE_FILE]

    act(() => {
      h.api().beginGesture(READY_READINGS, { respectDirtyGuard: true, path: 'open' })
    })
    await flush(64)

    expect(h.state.adoptCalls).toHaveLength(1)
    expect(h.api().intent.kind).toBe('none')
    // A faulted generation is not a per-file failure: no C10 notice.
    expect(h.api().replacementFailure).toBeNull()
  })
})

describe('D02b — the gesture gate and the dirty guard', () => {
  it('refuses an open editor and an aggregate cast check without opening the picker', async () => {
    const h = harness()
    h.mount()

    h.state.editorOpen = true
    act(() => {
      h.api().beginGesture(READY_READINGS, { respectDirtyGuard: true, path: 'open' })
    })
    expect(h.state.pickCalls).toBe(0)
    expect(h.api().draftNotice).toBe(true)
    expect(h.api().intent.kind).toBe('none')

    // C13 clears on the editor mirror's close signal, not on a gesture.
    act(() => {
      h.api().noteEditorClosed()
    })
    expect(h.api().draftNotice).toBe(false)

    h.state.editorOpen = false
    h.state.castPending = new Set(['id'])
    act(() => {
      h.api().beginGesture(READY_READINGS, { respectDirtyGuard: true, path: 'open' })
    })
    // C16 is lifecycle-derived: the refusal owns no notice of its own.
    expect(h.state.pickCalls).toBe(0)
    expect(h.api().draftNotice).toBe(false)
    expect(h.api().busyNotice).toBe(false)
  })

  it('opens the dirty guard instead of the picker, and Stay writes nothing', async () => {
    const h = harness()
    h.mount()
    h.state.history = dirtyHistory()

    act(() => {
      h.api().beginGesture(READY_READINGS, { respectDirtyGuard: true, path: 'open' })
    })
    expect(h.api().intent.kind).toBe('guard')
    expect(h.state.pickCalls).toBe(0)

    act(() => {
      h.api().endIntent()
    })
    expect(h.api().intent.kind).toBe('none')
    expect(h.state.engineCalls).toEqual([])
    expect(h.state.adoptCalls).toEqual([])

    // T5: choosing from the guard re-runs the gate with the guard already gone
    // and acquires the candidate.
    h.state.picks = [CANDIDATE_FILE]
    act(() => {
      h.api().chooseFromGuard(READY_READINGS)
    })
    expect(h.state.pickCalls).toBe(1)
    await flush(64)
    expect(h.state.adoptCalls).toHaveLength(1)
  })
})

describe('D02b — the CSV review path', () => {
  it('mounts the review for a CSV pick without opening or previewing anything', async () => {
    const h = harness()
    h.mount()
    h.state.picks = [new File(['a,b\n1,2\n'], 'review.csv')]

    act(() => {
      h.api().beginGesture(READY_READINGS, { respectDirtyGuard: true, path: 'review' })
    })
    await flush(32)

    const review = h.api().csvReview
    expect(review).not.toBeNull()
    expect(review?.mode).toBe('replace')
    expect(review?.file.name).toBe('review.csv')
    // Acquisition is not adoption: the preview is the dialog's own call.
    expect(h.state.engineCalls).toEqual([])
    expect(h.state.adoptCalls).toEqual([])
  })

  it('falls through to candidate preparation for a non-CSV pick from the review control', async () => {
    const h = harness()
    h.mount()
    h.state.picks = [new File(['x'], 'other.parquet')]

    act(() => {
      h.api().beginGesture(READY_READINGS, { respectDirtyGuard: true, path: 'review' })
    })
    await flush(64)

    expect(h.api().csvReview).toBeNull()
    expect(h.state.engineCalls).toEqual(['open', 'schema', 'rowCount'])
    expect(h.state.adoptCalls).toHaveLength(1)
  })

  it('previews through the engine port without adopting, and Stop says "stopped"', async () => {
    const h = harness()
    h.mount()
    act(() => {
      h.api().presentCsvReview({
        mode: 'replace',
        file: CANDIDATE_FILE,
        identity: null,
        startPhase: h.state.phase,
        intentSeq: 7,
      })
    })
    const handoff = h.api().csvReview
    expect(handoff).not.toBeNull()

    const source = { name: CANDIDATE_FILE.name, getFile: async () => CANDIDATE_FILE }
    await act(async () => {
      await h.api().previewCsv(source, { delim: ',' }, 25)
    })
    // Non-adopting: one preview call, no open, no adoption, no session write.
    expect(h.state.engineCalls).toEqual(['csvPreview'])
    expect(h.state.openCalls).toBe(0)
    expect(h.state.adoptCalls).toEqual([])

    act(() => {
      h.api().stopCsvReview(handoff as NonNullable<typeof handoff>)
    })
    expect(h.api().csvReview).toBeNull()
    expect(h.api().csvReviewStopped).toBe('replace')
    expect(h.state.adoptCalls).toEqual([])
  })

  it('hands an idle review adoption back to the caller instead of opening anything', () => {
    const h = harness()
    h.mount()
    const handoff = {
      mode: 'idle' as const,
      file: CANDIDATE_FILE,
      identity: null,
      startPhase: { kind: 'idle' as const },
      intentSeq: 0,
    }
    act(() => {
      h.api().presentCsvReview(handoff)
    })

    let returned: ReturnType<ReplacementController['adoptCsvReview']> = null
    act(() => {
      returned = h.api().adoptCsvReview(handoff, { delim: ',' })
    })

    expect(returned).toMatchObject({ file: CANDIDATE_FILE, options: { delim: ',' } })
    expect(h.api().csvReview).toBeNull()
    // The controller never opens: the composition root owns the idle chain.
    expect(h.state.engineCalls).toEqual([])
    expect(h.state.adoptCalls).toEqual([])
  })
})

describe('D02b — no extra engine work per gesture', () => {
  it('repeated refusals and cancels never accumulate engine calls', async () => {
    const h = harness()
    h.mount()

    for (let index = 0; index < 3; index += 1) {
      h.state.picks = [null]
      act(() => {
        h.api().beginGesture(READY_READINGS, { respectDirtyGuard: true, path: 'open' })
      })
      await flush()
    }
    h.state.editorOpen = true
    act(() => {
      h.api().beginGesture(READY_READINGS, { respectDirtyGuard: true, path: 'open' })
    })
    h.state.editorOpen = false
    h.state.castPending = new Set(['id', 'label'])
    act(() => {
      h.api().beginGesture(READY_READINGS, { respectDirtyGuard: true, path: 'open' })
    })
    await flush()

    expect(h.state.pickCalls).toBe(3)
    expect(h.state.engineCalls).toEqual([])
    expect(h.state.adoptCalls).toEqual([])

    // One real candidate afterwards: exactly one open/schema/rowCount + one
    // adoption, and no leftover intent.
    h.state.castPending = new Set<string>()
    h.state.picks = [CANDIDATE_FILE]
    act(() => {
      h.api().beginGesture(READY_READINGS, { respectDirtyGuard: true, path: 'open' })
    })
    await flush(64)
    expect(h.state.engineCalls).toEqual(['open', 'schema', 'rowCount'])
    expect(h.state.adoptCalls).toHaveLength(1)
    expect(h.api().intent.kind).toBe('none')
  })
})
