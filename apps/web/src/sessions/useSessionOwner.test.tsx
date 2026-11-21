// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OverlayBase } from '@assay/domain'
import type { EngineExportFormat, EngineOverlay, EngineTableHandle } from '@assay/engine-duckdb'
import type { GridViewportModel } from '@assay/grid'
import type { DuckDbGridProvider } from '../grid/provider'
import type { BottomPanelModules } from '../lib/bottom-panels'
import type { SourceIdentity } from '../export/save-destination'
import type { WebTelemetryRuntime } from '../telemetry/runtime'
import { useSessionOwner } from './useSessionOwner'
import type {
  AdoptedSession,
  SessionGridPorts,
  SessionOpenStart,
  SessionOwner,
} from './useSessionOwner'

/**
 * D02c — the session-owner boundary at the hook level.
 *
 * These pins cover what the App-level suites can only observe indirectly:
 *
 * 1. **adoption order** (v5 §4.3 steps 1–8): the reset runs BEFORE the base is
 *    published, the provider is rebound only after that publication, and the
 *    ready frame + `dataset_opened` come last;
 * 2. **exactly-once telemetry**: one emitter for both ready paths, none on a
 *    faulted reset, none on a superseded chain;
 * 3. **reset fault handling** (C03b fail closed): a thrower never publishes a
 *    ready frame, never rebinds the candidate, never retires requests and never
 *    emits — and every later reset still ran;
 * 4. **history/overlay publication**: the owner asks the editing session to
 *    publish, it never writes another module's refs, and a candidate's overlay
 *    is never borrowed for the live base;
 * 5. **the export-in-flight snapshot**: one frozen overlay + handle per export,
 *    handed to the engine op exactly once.
 */

const HANDLE: EngineTableHandle = { kind: 'table', id: 't1' }

function base(anchor: string): OverlayBase {
  return {
    baseAnchor: anchor,
    overlayAnchor: `overlay-${anchor}`,
    columns: [
      { name: 'id', type: 'BIGINT' },
      { name: 'country', type: 'VARCHAR' },
    ],
    baseRowCount: 12,
  }
}

interface Harness {
  readonly owner: { current: SessionOwner }
  readonly order: string[]
  readonly emits: Array<{ name: string; payload: unknown }>
  readonly grid: SessionGridPorts
  readonly retireRequests: ReturnType<typeof vi.fn>
  readonly exportView: ReturnType<typeof vi.fn>
  readonly rebinds: Array<() => EngineOverlay | null>
  readonly published: OverlayBase[]
  readonly candidate: (anchor: string) => AdoptedSession
}

function harness(): Harness {
  const order: string[] = []
  const emits: Array<{ name: string; payload: unknown }> = []
  const rebinds: Array<() => EngineOverlay | null> = []
  const telemetry = {
    emit: (name: string, payload: unknown) => {
      order.push(`emit:${name}`)
      emits.push({ name, payload })
    },
  } as unknown as WebTelemetryRuntime
  const retireRequests = vi.fn(() => {
    order.push('retire-requests')
  })
  const liveOverlay = (overlayBase: OverlayBase): EngineOverlay => ({ base: overlayBase, ops: [] })
  /** Every base this grid publication was asked to publish, in order. */
  const published: OverlayBase[] = []
  const grid: SessionGridPorts = {
    publishEmptyBase: (publishedBase) => {
      order.push('publish-empty-base')
      published.push(publishedBase)
    },
    snapshotOverlay: (snapshotBase) => {
      order.push('snapshot-overlay')
      return liveOverlay(snapshotBase)
    },
  }
  const exportView = vi.fn(
    async (
      _handle: EngineTableHandle,
      request: { format: EngineExportFormat; overlay: EngineOverlay },
    ) => {
      order.push('export-view')
      return { path: 'assay-exports/x', format: request.format, rowCount: 0, bytes: 0 }
    },
  )

  const candidate = (anchor: string): AdoptedSession => {
    const candidateBase = base(anchor)
    const provider = {
      rebindOverlaySource: (source: () => EngineOverlay | null) => {
        order.push('rebind')
        rebinds.push(source)
      },
    } as unknown as DuckDbGridProvider
    return {
      file: new File(['id,country\n1,SG\n'], `${anchor}.csv`),
      handle: { ...HANDLE, id: anchor },
      base: candidateBase,
      model: {} as GridViewportModel,
      provider,
      panels: {} as BottomPanelModules,
      identity: { isSameEntry: async () => false } as unknown as SourceIdentity,
      openSource: { getFile: async () => new File(['x'], 'x.csv') },
    }
  }

  const { result } = renderHook(() => useSessionOwner({ telemetry, retireRequests, exportView }))
  return {
    owner: result as unknown as { current: SessionOwner },
    order,
    emits,
    grid,
    retireRequests,
    exportView,
    rebinds,
    published,
    candidate,
  }
}

/** Run one `beginOpen()` inside `act` and return the narrowed `opening` ticket. */
function started(run: () => SessionOpenStart): { kind: 'opening'; token: number } {
  // A holder defeats TS's control-flow narrowing across the closure assignment.
  const holder: { value: SessionOpenStart } = { value: { kind: 'faulted' } }
  act(() => {
    holder.value = run()
  })
  const ticket = holder.value
  if (ticket.kind !== 'opening') throw new Error('the session start faulted')
  return ticket
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('D02c — adoption is one ordered, exactly-once step', () => {
  it('runs reset → publication → rebind → ready → telemetry, in that order, once', () => {
    const h = harness()
    const { owner } = h
    const resetOrder: string[] = []
    act(() => {
      owner.current.session.registerReset(() => {
        resetOrder.push('reset-A')
      })
      owner.current.session.registerReset(() => {
        resetOrder.push('reset-B')
      })
    })
    // The owner's own open-source reset is registered by its mount effect.
    const before = owner.current.session.tokenRef.current

    let outcome: string | null = null
    act(() => {
      outcome = owner.current.adopt(h.candidate('adopted'), h.grid)
    })

    expect(outcome).toBe('adopted')
    // Exactly one adoption: one token bump, one reset pass.
    expect(owner.current.session.tokenRef.current).toBe(before + 1)
    expect(resetOrder).toEqual(['reset-A', 'reset-B'])
    // The publication happens after the reset (the reset nulls history/overlay)
    // and before the provider is rebound to the live session.
    expect(h.order).toEqual([
      'publish-empty-base',
      'rebind',
      'retire-requests',
      'emit:dataset_opened',
    ])
    // The published base is the candidate's own (never a live borrow).
    expect(h.published.map((publishedBase) => publishedBase.baseAnchor)).toEqual(['adopted'])
    // Step 5/6: the source slots and the resolved panels are published.
    expect(owner.current.openSourceRef.current).not.toBeNull()
    expect(owner.current.sourceIdentityRef.current).not.toBeNull()
    expect(owner.current.panelModules).not.toBeNull()
    // Step 7: one ready frame carrying the candidate's own grid.
    expect(owner.current.phase.kind).toBe('ready')
    if (owner.current.phase.kind !== 'ready') throw new Error('phase was not ready')
    expect(owner.current.phase.tableId).toBe('adopted')
    expect(owner.current.phase.handle.id).toBe('adopted')
    // Step 8: exactly one `dataset_opened`, closed enums only.
    expect(h.emits.map((event) => event.name)).toEqual(['dataset_opened'])
    expect(h.emits[0]?.payload).toEqual({
      dataset_role: 'primary',
      format_kind: 'csv',
      size_bucket: expect.stringMatching(/.*/),
      row_count_bucket: expect.stringMatching(/.*/),
      column_count_bucket: expect.stringMatching(/.*/),
    })
    // No fault frame survives a clean adoption.
    expect(owner.current.sessionFault).toBeNull()
  })

  it('rebinds the candidate provider to the ADOPTED base only (never a live borrow)', () => {
    const h = harness()
    act(() => {
      const candidate = h.candidate('adopted')
      h.owner.current.adopt(candidate, h.grid)
      // The rebind closure must ask for the candidate's own base.
      const source = h.rebinds[0]
      if (source === undefined) throw new Error('the provider was never rebound')
      h.order.length = 0
      const overlay = source()
      expect(h.order).toEqual(['snapshot-overlay'])
      expect(overlay?.base.baseAnchor).toBe(candidate.base.baseAnchor)
    })
  })
})

describe('D02c — exactly-once telemetry on both ready paths', () => {
  it('publishes one dataset_opened for a completed legacy open chain', () => {
    const h = harness()
    const start = started(() => h.owner.current.beginOpen())
    expect(h.owner.current.phase.kind).toBe('opening')

    let published = false
    act(() => {
      published = h.owner.current.publishReady(h.candidate('opened'), start.token, h.grid)
    })

    expect(published).toBe(true)
    expect(h.emits.filter((event) => event.name === 'dataset_opened')).toHaveLength(1)
    // Publication then ready then telemetry; the requests were already retired
    // when the session started, and the ready frame retires them again for the
    // adopted session's boundary.
    expect(h.order).toEqual([
      'retire-requests',
      'publish-empty-base',
      'retire-requests',
      'emit:dataset_opened',
    ])
    // No rebind on the legacy path: the provider was built against this base.
    expect(h.rebinds).toHaveLength(0)
  })

  it('drops a superseded chain: no publication, no telemetry, phase unchanged', () => {
    const h = harness()
    const start = started(() => h.owner.current.beginOpen())
    // A newer session supersedes the in-flight chain (ug-21 cancel).
    act(() => {
      h.owner.current.cancelOpen()
    })
    expect(h.owner.current.phase.kind).toBe('idle')
    h.order.length = 0

    let published = true
    act(() => {
      published = h.owner.current.publishReady(h.candidate('stale'), start.token, h.grid)
    })

    expect(published).toBe(false)
    expect(h.owner.current.phase.kind).toBe('idle')
    expect(h.order).toEqual([])
    expect(h.emits).toEqual([])
    expect(h.owner.current.openSourceRef.current).toBeNull()
    expect(h.owner.current.panelModules).toBeNull()
  })

  it('emits dataset_open_failed once for a live failure and never for a stale one', () => {
    const h = harness()
    const stale = started(() => h.owner.current.beginOpen())
    act(() => {
      h.owner.current.cancelOpen()
    })
    h.order.length = 0
    act(() => {
      h.owner.current.failOpen(stale.token, new Error('late'))
    })
    expect(h.emits).toEqual([])
    expect(h.owner.current.phase.kind).toBe('idle')

    const live = started(() => h.owner.current.beginOpen())
    act(() => {
      h.owner.current.failOpen(live.token, new Error('boom'))
    })
    expect(h.emits.map((event) => event.name)).toEqual(['dataset_open_failed'])
    // A value-free reason enum only: no message, stack, name or file.
    expect(h.emits[0]?.payload).toEqual({
      dataset_role: 'primary',
      format_kind: 'unknown',
      reason_code: expect.stringMatching(/.*/),
    })
    expect(JSON.stringify(h.emits[0]?.payload)).not.toContain('boom')
    expect(h.owner.current.phase.kind).toBe('error')
  })
})

describe('D02c — a faulted reset fails closed (C03b)', () => {
  it('publishes the recovery frame, skips steps 2–8, and still runs every later reset', () => {
    const h = harness()
    const ran: string[] = []
    const disposeFaulty = h.owner.current.session.registerReset(() => {
      ran.push('faulty')
      throw new Error('VIOLENT-RESET-PAYLOAD')
    })
    act(() => {
      h.owner.current.session.registerReset(() => {
        ran.push('after')
      })
    })

    let outcome: string | null = null
    act(() => {
      outcome = h.owner.current.adopt(h.candidate('adopted'), h.grid)
    })

    expect(outcome).toBe('faulted')
    // Per-callback isolation: the reset registered after the thrower still ran.
    expect(ran).toEqual(['faulty', 'after'])
    // Fail closed: no ready frame, no publication, no rebind, no requests
    // retired, no telemetry — and one value-free fault frame.
    expect(h.owner.current.phase.kind).toBe('idle')
    expect(h.owner.current.sessionFault).toEqual([
      { index: expect.any(Number), kind: 'reset-callback' },
    ])
    expect(h.order).toEqual([])
    expect(h.rebinds).toHaveLength(0)
    expect(h.retireRequests).not.toHaveBeenCalled()
    expect(h.emits).toEqual([])
    expect(h.owner.current.openSourceRef.current).toBeNull()
    expect(JSON.stringify(h.owner.current.sessionFault)).not.toContain('VIOLENT')
    act(() => {
      disposeFaulty()
    })

    // S4: a later clean adoption runs from scratch and clears the frame.
    act(() => {
      h.owner.current.adopt(h.candidate('adopted'), h.grid)
    })
    expect(h.owner.current.sessionFault).toBeNull()
    expect(h.owner.current.phase.kind).toBe('ready')
    expect(h.emits.filter((event) => event.name === 'dataset_opened')).toHaveLength(1)
  })

  it('beginOpen fails closed before the first await and keeps returning `faulted`', () => {
    const h = harness()
    act(() => {
      h.owner.current.session.registerReset(() => {
        throw new Error('VIOLENT-OPEN-PAYLOAD')
      })
    })
    const holder: { value: SessionOpenStart } = { value: { kind: 'faulted' } }
    act(() => {
      holder.value = h.owner.current.beginOpen()
    })
    expect(holder.value.kind).toBe('faulted')
    expect(h.owner.current.phase.kind).toBe('idle')
    expect(h.owner.current.sessionFault).not.toBeNull()
    expect(h.order).toEqual([])
    // The fault is per-invocation, not sticky: a second attempt reports again.
    act(() => {
      holder.value = h.owner.current.beginOpen()
    })
    expect(holder.value.kind).toBe('faulted')
  })
})

describe('D02c — the export-in-flight snapshot', () => {
  it('freezes one overlay + the live handle per export and forwards it once', async () => {
    const h = harness()
    act(() => {
      h.owner.current.adopt(h.candidate('adopted'), h.grid)
    })
    h.order.length = 0

    await act(async () => {
      await h.owner.current.runExport('parquet', h.grid)
    })

    expect(h.order).toEqual(['snapshot-overlay', 'export-view'])
    expect(h.exportView).toHaveBeenCalledTimes(1)
    const [handle, request] = h.exportView.mock.calls[0] as [
      EngineTableHandle,
      { format: string; overlay: EngineOverlay },
    ]
    expect(handle.id).toBe('adopted')
    expect(request.format).toBe('parquet')
    // The snapshot is the adopted base's own overlay — a value, not a live read,
    // so a later adoption/edit cannot change what this export exported.
    expect(request.overlay.base.baseAnchor).toBe('adopted')
    expect(request.overlay.ops).toEqual([])
    act(() => {
      h.owner.current.adopt(h.candidate('second'), h.grid)
    })
    expect(request.overlay.base.baseAnchor).toBe('adopted')
  })

  it('refuses an export with no table open (unchanged copy, no engine call)', async () => {
    const h = harness()
    await expect(h.owner.current.runExport('parquet', h.grid)).rejects.toThrow('no table is open')
    expect(h.exportView).not.toHaveBeenCalled()
  })
})
